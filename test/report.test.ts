import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRunReport } from '../src/run/supervisor.js';
import type { Fact } from '../src/state/facts.js';
import type { RunTotals } from '../src/model/index.js';

const facts: Fact[] = [
  { seq: 1, ts: 't', type: 'rubric_created', model: 'claude-haiku', criteria: [
    { id: 'r0', text: 'repro-issue-1 passes', check: 'test' },
    { id: 'r1', text: 'rounding is correct', check: 'diff' },
  ] },
  { seq: 2, ts: 't', type: 'patch_proposed', attempt: 1, diffHash: 'abcdef0123456789', patchSource: 'injected' },
  { seq: 3, ts: 't', type: 'gate_result', attempt: 1, passed: true, failedRules: [] },
  { seq: 4, ts: 't', type: 'tests_result', attempt: 1, passed: true, targetPassed: true, regressions: [], failingTests: [] },
  { seq: 5, ts: 't', type: 'code_verdicts', attempt: 1, verdicts: [
    { id: 'code:repro-test', criterion: 'the repro test passes', source: 'code', verdict: 'pass', confidence: 1, reason: 'ok' },
    { id: 'code:no-regressions', criterion: 'no regressions', source: 'code', verdict: 'pass', confidence: 1, reason: 'ok' },
    { id: 'code:gate', criterion: 'gate passes', source: 'code', verdict: 'pass', confidence: 1, reason: 'ok' },
  ] },
  { seq: 6, ts: 't', type: 'validator_result', attempt: 1, allCriteriaPass: true, judgmentAllPass: true, model: 'nova-pro', escalated: false,
    criteria: [{ id: 'r1', verdict: 'pass', confidence: 0.9, reason: 'looks correct', missing_evidence: '' }] },
];

const totals: RunTotals = { prompt: 1, completion: 2, total: 3, cost: 0.01, keySpendUsd: 0.02, keyMaxBudgetUsd: 20 };

describe('writeRunReport per-criterion table', () => {
  it('renders each criterion verdict, confidence and source as separate cells and marks injection', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-report-'));
    try {
      writeRunReport(
        {
          runId: 'run-x',
          runDir,
          issueId: '1',
          issueTitle: 'Test issue',
          traceId: 'trace-x',
          injected: true,
          memory: [],
          outcome: 'shipped',
          attempts: 1,
        },
        facts,
        totals,
        1000
      );
      const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf-8');
      assert.match(report, /## Per-criterion verdicts/);
      // Injected attempt is marked in the per-attempt table.
      assert.match(report, /\| 1 \| YES \| injected \|/);
      // A validator criterion shows check, source, verdict and confidence as separate cells.
      assert.match(report, /\| 1 \| r1 \| diff \| validator \| pass \| 0.9 \|/);
      // A rubric test criterion is listed as covered by code verdicts (source code).
      assert.match(report, /\| 1 \| r0 \| test \| code \| pass \| 1 \| covered by code verdicts/);
      // The deterministic trio is listed with source code.
      assert.match(report, /\| 1 \| code:repro-test \| code \| code \| pass \| 1 \|/);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});
