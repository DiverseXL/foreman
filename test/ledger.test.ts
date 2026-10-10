import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  recordModelCall,
  cumulativeCost,
  cumulativeTokens,
  estimateCost,
  getLedgerPath,
  assertCallAllowed,
  keyBudgetExceeded,
  latestKeyBudget,
  RESERVE_USD,
  STEP_MAX_TOTAL_TOKENS,
  type LedgerEntry,
  type PriceConfig,
} from '../src/model/ledger.js';

const scratch = path.resolve('test-ledger-scratch');
const ledgerPath = getLedgerPath(scratch);

function readEntries(): LedgerEntry[] {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerEntry);
}

const previousBudget = process.env.FOREMAN_BUDGET_USD;

describe('ledger', () => {
  before(() => {
    if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  });

  after(() => {
    if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  });

  // Each test starts from an empty ledger so counts and caps are deterministic.
  beforeEach(() => {
    if (fs.existsSync(ledgerPath)) fs.rmSync(ledgerPath, { force: true });
  });

  afterEach(() => {
    if (previousBudget === undefined) delete process.env.FOREMAN_BUDGET_USD;
    else process.env.FOREMAN_BUDGET_USD = previousBudget;
  });

  it('appends a costed call and reports cumulative totals', () => {
    delete process.env.FOREMAN_BUDGET_USD;
    const entry = recordModelCall({
      runId: 'test-run',
      model: 'claude-haiku',
      promptTokens: 1000,
      completionTokens: 1000,
      runsDir: scratch,
    });
    // 1000/1000 * 0.001 + 1000/1000 * 0.005 = 0.006 (price-based estimate fallback)
    assert.equal(entry.model, 'claude-haiku');
    assert.equal(entry.costSource, 'estimate');
    assert.ok(typeof entry.estimatedCostUsd === 'number');
    assert.ok(Math.abs((entry.estimatedCostUsd ?? 0) - 0.006) < 1e-9);
    assert.ok(Math.abs((entry.costUsd ?? 0) - 0.006) < 1e-9);
    assert.equal(readEntries().length, 1);
    assert.ok(Math.abs(cumulativeCost(scratch) - 0.006) < 1e-9);
    assert.equal(cumulativeTokens(scratch).total, 2000);
  });

  it('refuses a call once the running cost reaches the cap', () => {
    process.env.FOREMAN_BUDGET_USD = '0';
    const before = readEntries().length;
    assert.throws(
      () =>
        recordModelCall({
          runId: 'test-run',
          model: 'claude-haiku',
          promptTokens: 10,
          completionTokens: 10,
          runsDir: scratch,
        }),
      /budget cap/
    );
    // Refused BEFORE appending.
    assert.equal(readEntries().length, before);
  });

  it('refuses a model call before it would exceed the total token cap', () => {
    const entry: LedgerEntry = {
      ts: new Date(0).toISOString(),
      runId: 'test-run',
      model: 'claude-haiku',
      promptTokens: STEP_MAX_TOTAL_TOKENS,
      completionTokens: 0,
      estimatedCostUsd: 0,
      gatewayCostUsd: 0,
      costUsd: 0,
      costSource: 'gateway',
      keySpendUsd: null,
      keyMaxBudgetUsd: null,
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf-8');
    assert.throws(() => assertCallAllowed('claude-haiku', scratch), /step token cap/);
  });

  it('refuses a call whose price is null and no gateway cost, but still records its tokens', () => {
    delete process.env.FOREMAN_BUDGET_USD;
    const before = readEntries().length;
    assert.throws(
      () =>
        recordModelCall({
          runId: 'test-run',
          model: 'nova-pro',
          promptTokens: 7,
          completionTokens: 3,
          runsDir: scratch,
        }),
      /price for model "nova-pro" is null/
    );
    const after = readEntries();
    assert.equal(after.length, before + 1);
    const last = after[after.length - 1];
    assert.equal(last.model, 'nova-pro');
    assert.equal(last.estimatedCostUsd, null);
    assert.equal(last.costSource, 'none');
    assert.equal(last.promptTokens, 7);
  });

  it('records the gateway-reported cost and key spend/budget from headers', () => {
    delete process.env.FOREMAN_BUDGET_USD;
    // Fixed header fixture, as returned by the gateway.
    const entry = recordModelCall({
      runId: 'test-run',
      model: 'claude-haiku',
      promptTokens: 336,
      completionTokens: 170,
      gatewayCostUsd: 0.000123,
      keySpendUsd: 0.5,
      keyMaxBudgetUsd: 20.0,
      runsDir: scratch,
    });
    assert.equal(entry.costSource, 'gateway');
    assert.equal(entry.gatewayCostUsd, 0.000123);
    assert.equal(entry.costUsd, 0.000123);
    assert.equal(entry.keySpendUsd, 0.5);
    assert.equal(entry.keyMaxBudgetUsd, 20.0);
    // Gateway cost takes precedence over the price estimate.
    assert.notEqual(entry.estimatedCostUsd, 0.000123);
  });

  it('uses the gateway cost even when the model has no configured price', () => {
    delete process.env.FOREMAN_BUDGET_USD;
    const entry = recordModelCall({
      runId: 'test-run',
      model: 'nova-pro',
      promptTokens: 10,
      completionTokens: 5,
      gatewayCostUsd: 0.0002,
      runsDir: scratch,
    });
    assert.equal(entry.costSource, 'gateway');
    assert.equal(entry.estimatedCostUsd, null);
    assert.equal(entry.costUsd, 0.0002);
  });

  it('refuses a call when reported key spend plus the reserve would exceed the max budget', () => {
    delete process.env.FOREMAN_BUDGET_USD;
    // 18.5 + 3 reserve = 21.5 > 20 max budget
    assert.throws(
      () =>
        recordModelCall({
          runId: 'test-run',
          model: 'claude-haiku',
          promptTokens: 10,
          completionTokens: 5,
          gatewayCostUsd: 0.0001,
          keySpendUsd: 18.5,
          keyMaxBudgetUsd: 20.0,
          runsDir: scratch,
        }),
      /reserve/
    );
    // The spend was still recorded for tracking.
    const entries = readEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].keySpendUsd, 18.5);
    assert.equal(latestKeyBudget(scratch).spend, 18.5);
  });

  it('estimateCost returns null for an unconfigured or null-priced model', () => {
    const prices: Record<string, PriceConfig> = {
      known: { input_per_1k: 0.002, output_per_1k: 0.004 },
      unknown: { input_per_1k: null, output_per_1k: 0.004 },
    };
    assert.equal(estimateCost('missing', 1000, 1000, prices), null);
    assert.equal(estimateCost('unknown', 1000, 1000, prices), null);
    assert.ok(Math.abs((estimateCost('known', 1000, 1000, prices) ?? 0) - 0.006) < 1e-9);
  });

  it('keyBudgetExceeded applies the reserve threshold', () => {
    assert.equal(RESERVE_USD, 3);
    assert.equal(keyBudgetExceeded(18, 20), true); // 21 > 20
    assert.equal(keyBudgetExceeded(16, 20), false); // 19 <= 20
    assert.equal(keyBudgetExceeded(null, 20), false);
    assert.equal(keyBudgetExceeded(18, null), false);
  });
});
