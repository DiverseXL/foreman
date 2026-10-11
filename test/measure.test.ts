import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateResults,
  classifyChild,
  formatFinishedLine,
  mergeRows,
  rebuildRows,
  type MeasurementRow,
} from '../scripts/measure.js';

function row(runId: string, overrides: Partial<MeasurementRow> = {}): MeasurementRow {
  return {
    issue: '1',
    mode: 'graph',
    runId,
    status: 'completed',
    exitCode: 0,
    derivedStatus: 'needs_human',
    attempts: 1,
    testsProtectedFailed: false,
    tokens: 100,
    gatewayCostUsd: 0.01,
    wallSeconds: 10,
    traceId: 'trace',
    holdoutResult: 'n/a',
    ...overrides,
  };
}

describe('classifyChild', () => {
  it('classifies a non-zero exit with a Run ID as completed', () => {
    assert.equal(
      classifyChild({
        status: 1,
        signal: null,
        error: undefined,
        stdout: 'Run ID: run-12345',
        stderr: '',
        timedOut: false,
      }),
      'completed'
    );
  });

  it('classifies a 429 response without a Run ID as transient', () => {
    assert.equal(
      classifyChild({
        status: 1,
        signal: null,
        error: undefined,
        stdout: '',
        stderr: 'HTTP 429 rate limit exceeded',
        timedOut: false,
      }),
      'transient'
    );
  });

  it('classifies an unrecognized failure without a Run ID as crashed', () => {
    assert.equal(
      classifyChild({
        status: 1,
        signal: null,
        error: undefined,
        stdout: '',
        stderr: 'unexpected process failure',
        timedOut: false,
      }),
      'crashed'
    );
  });

  it('classifies a timed-out child as timed_out', () => {
    assert.equal(
      classifyChild({
        status: null,
        signal: 'SIGTERM',
        error: new Error('spawnSync ETIMEDOUT'),
        stdout: '',
        stderr: '',
        timedOut: true,
      }),
      'timed_out'
    );
  });
});

describe('measurement results', () => {
  it('merges by runId, preserving existing rows when an id is repeated', () => {
    const existing = [row('run-old'), row('run-keep', { issue: '2' })];
    const merged = mergeRows(existing, [row('run-old', { issue: '3' }), row('run-new')]);

    assert.deepEqual(merged.map((item) => item.runId), ['run-old', 'run-keep', 'run-new']);
    assert.equal(merged[0].issue, '1');
    assert.equal(merged[1].issue, '2');
  });

  it('formats the live line with child class, derived outcome, attempts, holdout, tokens and elapsed time', () => {
    assert.equal(
      formatFinishedLine(2, 8, 'completed', row('run-x', { derivedStatus: 'shipped', holdoutResult: 'passed' }), '12.34'),
      'Finished 2/8 child=completed derived=shipped attempts=1 holdout=passed tokens=100 elapsed=12.34s'
    );
    assert.equal(
      formatFinishedLine(1, 2, 'crashed', undefined, '0.01'),
      'Finished 1/2 child=crashed derived=n/a attempts=0 holdout=n/a tokens=0 elapsed=0.01s'
    );
  });

  it('aggregates sample counts and means by issue and mode', () => {
    const aggregates = aggregateResults([
      row('run-1', { derivedStatus: 'shipped', holdoutResult: 'passed', testsProtectedFailed: true, tokens: 100, gatewayCostUsd: 0.02 }),
      row('run-2', { derivedStatus: 'shipped', holdoutResult: 'failed', tokens: 300, gatewayCostUsd: 0.04 }),
      row('run-3', { mode: 'no-graph', attempts: 3, tokens: 200, gatewayCostUsd: null }),
      row('run-4', { mode: 'unknown', testsProtectedFailed: true }),
    ]);
    const graph = aggregates.find((aggregate) => aggregate.issue === '1' && aggregate.mode === 'graph');
    const noGraph = aggregates.find((aggregate) => aggregate.issue === '1' && aggregate.mode === 'no-graph');
    const unknown = aggregates.find((aggregate) => aggregate.issue === '1' && aggregate.mode === 'unknown');

    assert.ok(graph);
    assert.equal(graph.n, 2);
    assert.equal(graph.shipped, 2);
    assert.equal(graph.shippedAndHeldoutPassed, 1);
    assert.equal(graph.testsProtectedFailed, 1);
    assert.equal(graph.meanAttempts, '1.00');
    assert.equal(graph.meanTokens, '200');
    assert.equal(graph.meanGatewayCostUsd, '0.030000');
    assert.equal(noGraph?.n, 1);
    assert.equal(noGraph?.meanGatewayCostUsd, 'n/a');
    assert.equal(unknown?.testsProtectedFailed, 1);
  });

  it('rebuilds rows only for run folders absent from the baseline list', () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-rebuild-'));
    try {
      const makeRun = (runId: string, issueId: string, consoleText: string, recordedMode?: string): void => {
        const runDir = path.join(runsDir, runId);
        fs.mkdirSync(runDir);
        fs.writeFileSync(
          path.join(runDir, 'facts.jsonl'),
          [
            { seq: 1, ts: 't', type: 'run_started', runId, issueId },
            ...(recordedMode ? [{ seq: 2, ts: 't', type: 'run_started', runId, issueId, mode: recordedMode }] : []),
            { seq: 3, ts: 't', type: 'patch_proposed', attempt: 1, diffHash: 'hash' },
            { seq: 4, ts: 't', type: 'gate_result', attempt: 1, passed: false, failedRules: ['tests_protected'] },
          ].map((fact) => JSON.stringify(fact)).join('\n') + '\n',
          'utf-8'
        );
        fs.writeFileSync(path.join(runDir, 'console.log'), consoleText, 'utf-8');
        fs.writeFileSync(path.join(runDir, 'economics.json'), JSON.stringify({ wallTimeMs: 2500 }), 'utf-8');
      };
      makeRun('run-baseline', '1', '');
      makeRun('run-new-no-graph', '2', 'NO GRAPH MODE');
      makeRun('run-new-fact-mode', '3', '', 'graph');
      makeRun('run-new-unknown', '3', '');
      fs.writeFileSync(
        path.join(runsDir, 'ledger.jsonl'),
        JSON.stringify({
          runId: 'run-new-no-graph',
          promptTokens: 25,
          completionTokens: 5,
          gatewayCostUsd: 0.003,
        }) + '\n',
        'utf-8'
      );

      const rebuilt = rebuildRows(runsDir, ['run-baseline']);
      assert.deepEqual(rebuilt.map((item) => item.runId), ['run-new-fact-mode', 'run-new-no-graph', 'run-new-unknown']);
      assert.equal(rebuilt[0].mode, 'graph');
      assert.equal(rebuilt[1].issue, '2');
      assert.equal(rebuilt[1].mode, 'no-graph');
      assert.equal(rebuilt[1].derivedStatus, 'blocked_policy');
      assert.equal(rebuilt[1].testsProtectedFailed, true);
      assert.equal(rebuilt[1].tokens, 30);
      assert.equal(rebuilt[1].gatewayCostUsd, 0.003);
      assert.equal(rebuilt[1].wallSeconds, 2.5);
      assert.equal(rebuilt[2].mode, 'unknown');
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
