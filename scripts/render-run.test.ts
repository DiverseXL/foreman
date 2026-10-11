import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderRun } from './render-run.js';

test('run receipt renders fixed facts and stage ledger without leaking host paths', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-render-test-'));
  const runId = 'run-1791663174555';
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'facts.jsonl'),
    [
      { seq: 1, ts: '2026-10-10T20:12:54.616Z', type: 'run_started', runId, issueId: '3' },
      {
        seq: 2,
        ts: '2026-10-10T20:12:55.955Z',
        type: 'workspace_created',
        baseCommit: 'abc',
        branch: 'foreman/issue-3',
        path: ['C:', 'Users', 'private', 'repo'].join('\\'),
      },
      { seq: 3, ts: '2026-10-10T20:13:32.881Z', type: 'gate_result', attempt: 1, passed: false, failedRules: ['tests_protected'] },
      { seq: 4, ts: '2026-10-10T20:13:38.436Z', type: 'tests_result', attempt: 1, passed: true, targetPassed: true, regressions: [] },
      {
        seq: 5,
        ts: '2026-10-10T20:13:43.233Z',
        type: 'validator_result',
        attempt: 1,
        allCriteriaPass: true,
        criteria: [{ id: 'r2', verdict: 'pass', confidence: 1, reason: 'verified' }],
      },
      { seq: 6, ts: '2026-10-10T20:13:43.234Z', type: 'gate_result', attempt: 2, passed: true, failedRules: [] },
      { seq: 7, ts: '2026-10-10T20:13:43.235Z', type: 'holdout_result', issueId: '3', passed: false, failingTests: ['held-out'] },
      { seq: 8, ts: '2026-10-10T20:13:43.238Z', type: 'shipped', commitSha: 'def' },
    ]
      .map((fact) => JSON.stringify(fact))
      .join('\n') + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(runsDir, 'ledger.jsonl'),
    [
      { ts: '2026-10-10T20:13:25.000Z', runId, stage: 'rubric', promptTokens: 100, completionTokens: 25, gatewayCostUsd: 0.001 },
      { ts: '2026-10-10T20:13:31.000Z', runId, stage: 'patch', promptTokens: 200, completionTokens: 50, gatewayCostUsd: 0.002 },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
    'utf8'
  );

  try {
    const outputs = renderRun(runId, runsDir);
    const markdown = fs.readFileSync(outputs.prBodyPath, 'utf8');
    const html = fs.readFileSync(outputs.htmlPath, 'utf8');
    assert.match(markdown, /Verdict: SHIPPED/);
    assert.match(markdown, /tests_protected/);
    assert.match(markdown, /Source \| Criterion/);
    assert.match(markdown, /\| patch \| 200 \| 50 \| 0\.002000 \| 1 \|/);
    assert.match(markdown, /Holdout[\s\S]*failed/);
    assert.match(markdown, /No pull request was opened/);
    assert.doesNotMatch(markdown, /C:\\Users\\private/);
    assert.match(html, /Attempt timeline/);
    assert.match(html, /class="red"/);
    assert.match(html, /class="green"/);
    assert.match(html, /Holdout[\s\S]*failed/);
    assert.doesNotMatch(html, /C:\\Users\\private/);
    assert.doesNotMatch(html, /<script|https?:\/\//);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
