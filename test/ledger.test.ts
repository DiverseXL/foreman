import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  recordModelCall,
  cumulativeCost,
  cumulativeTokens,
  estimateCost,
  getLedgerPath,
  type PriceConfig,
} from '../src/model/ledger.js';

const scratch = path.resolve('test-ledger-scratch');
const ledgerPath = getLedgerPath(scratch);

function readLines(): unknown[] {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

const previousBudget = process.env.FOREMAN_BUDGET_USD;

describe('ledger', () => {
  before(() => {
    if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  });

  after(() => {
    if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
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
    // 1000/1000 * 0.001 + 1000/1000 * 0.005 = 0.006 (estimate)
    assert.equal(entry.model, 'claude-haiku');
    assert.ok(typeof entry.estimatedCostUsd === 'number');
    assert.ok(Math.abs((entry.estimatedCostUsd ?? 0) - 0.006) < 1e-9);
    assert.equal(readLines().length, 1);
    assert.ok(Math.abs(cumulativeCost(scratch) - 0.006) < 1e-9);
    assert.equal(cumulativeTokens(scratch).total, 2000);
  });

  it('refuses a call once the running estimated total reaches the cap', () => {
    process.env.FOREMAN_BUDGET_USD = '0';
    const before = readLines().length;
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
    assert.equal(readLines().length, before);
  });

  it('refuses a call whose price is null, but still records its tokens', () => {
    delete process.env.FOREMAN_BUDGET_USD;
    const before = readLines().length;
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
    const after = readLines() as { model: string; estimatedCostUsd: number | null; promptTokens: number }[];
    assert.equal(after.length, before + 1);
    const last = after[after.length - 1];
    assert.equal(last.model, 'nova-pro');
    assert.equal(last.estimatedCostUsd, null);
    assert.equal(last.promptTokens, 7);
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
});
