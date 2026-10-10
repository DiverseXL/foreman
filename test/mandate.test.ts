import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMandate } from '../src/mandate/load.js';
import { appendFact, readFacts } from '../src/state/facts.js';
import path from 'node:path';
import fs from 'node:fs';

describe('loadMandate deterministic parser', () => {
  it('parses issue-1.md correctly with title, summary, criteria, hinted paths and symbols', () => {
    const mandate = loadMandate(1);
    assert.equal(mandate.issueId, '1');
    assert.equal(mandate.title, 'Tier 1 bulk discount not applied when quantity is exactly 10');
    assert.ok(mandate.summary.includes('Tier 1 bulk discount'));
    assert.equal(mandate.acceptanceCriteria.length, 3);
    assert.ok(mandate.acceptanceCriteria[0].includes('$500.00'));
    assert.deepEqual(mandate.hintedPaths, ['src/discount.ts']);
    assert.ok(mandate.hintedSymbols.includes('calculateTieredBulkDiscount'));
  });

  it('parses issue-2.md correctly with empty hintedPaths and single criterion', () => {
    const mandate = loadMandate(2);
    assert.equal(mandate.issueId, '2');
    assert.equal(mandate.title, 'Subtotal accumulation exhibits floating-point drift');
    assert.ok(mandate.summary.includes('IEEE-754'));
    assert.equal(mandate.acceptanceCriteria.length, 1);
    assert.ok(mandate.acceptanceCriteria[0].includes('0.30'));
    assert.deepEqual(mandate.hintedPaths, []);
    assert.ok(mandate.hintedSymbols.includes('calculateRawItemsSubtotal'));
  });

  it('parses issue-3.md correctly with multiple hinted symbols and rounding path', () => {
    const mandate = loadMandate(3);
    assert.equal(mandate.issueId, '3');
    assert.equal(
      mandate.title,
      'Volumetric freight fee undercharges by one cent due to half-up rounding'
    );
    assert.ok(mandate.summary.includes('dimensional weight'));
    assert.equal(mandate.acceptanceCriteria.length, 2);
    assert.deepEqual(mandate.hintedPaths, ['src/rounding.ts']);
    assert.ok(mandate.hintedSymbols.includes('calculateVolumetricShipping'));
    assert.ok(mandate.hintedSymbols.includes('roundCurrency'));
  });

  it('appends mandate_created and context_built fact shapes cleanly', () => {
    const testDir = path.resolve('test-mandate-scratch');
    const runId = `mandate-test-${Date.now()}`;

    try {
      const mandateFact = appendFact(
        runId,
        {
          type: 'mandate_created',
          issueId: '1',
          title: 'Test Issue',
          criteriaCount: 3,
          hintedSymbols: ['calculateTieredBulkDiscount'],
          hintedPaths: ['src/discount.ts'],
        },
        { runsDir: testDir }
      );
      assert.equal(mandateFact.seq, 1);
      assert.equal(mandateFact.type, 'mandate_created');

      const contextFact = appendFact(
        runId,
        {
          type: 'context_built',
          queryCount: 4,
          findingCount: 6,
          indexedSymbols: 73,
        },
        { runsDir: testDir }
      );
      assert.equal(contextFact.seq, 2);
      assert.equal(contextFact.type, 'context_built');

      const loaded = readFacts(runId, testDir);
      assert.equal(loaded.length, 2);
      assert.equal(loaded[0].type, 'mandate_created');
      assert.equal(loaded[1].type, 'context_built');
    } finally {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});
