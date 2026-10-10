import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendFact, readFacts, getFactsFilePath } from '../src/state/facts.js';

describe('appendFact and facts.jsonl', () => {
  const testRunsDir = path.resolve('test-runs-scratch');
  const testRunId = `test-run-${Date.now()}`;

  before(() => {
    if (fs.existsSync(testRunsDir)) {
      fs.rmSync(testRunsDir, { recursive: true, force: true });
    }
  });

  after(() => {
    if (fs.existsSync(testRunsDir)) {
      fs.rmSync(testRunsDir, { recursive: true, force: true });
    }
  });

  it('creates facts.jsonl and writes first fact with seq 1 and valid ISO timestamp', () => {
    const fact1 = appendFact(
      testRunId,
      {
        type: 'run_started',
        runId: testRunId,
        issueId: '1',
      },
      { runsDir: testRunsDir }
    );

    assert.equal(fact1.seq, 1);
    assert.ok(typeof fact1.ts === 'string');
    assert.ok(!Number.isNaN(Date.parse(fact1.ts)));

    const filePath = getFactsFilePath(testRunId, testRunsDir);
    assert.ok(fs.existsSync(filePath));

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed, fact1);
  });

  it('appends sequentially with ordered seq and never rewrites existing facts', () => {
    const fact2 = appendFact(
      testRunId,
      {
        type: 'workspace_created',
        baseCommit: 'commit-sha-123',
        branch: 'foreman/issue-1',
        path: '/some/path',
      },
      { runsDir: testRunsDir }
    );

    assert.equal(fact2.seq, 2);

    const fact3 = appendFact(
      testRunId,
      {
        type: 'baseline_recorded',
        exitCode: 1,
        passed: 28,
        failed: 3,
        failingTests: ['repro-issue-1', 'repro-issue-2', 'repro-issue-3'],
      },
      { runsDir: testRunsDir }
    );

    assert.equal(fact3.seq, 3);

    // Verify file content line by line
    const filePath = getFactsFilePath(testRunId, testRunsDir);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split(/\r?\n/);

    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).seq, 1);
    assert.equal(JSON.parse(lines[1]).seq, 2);
    assert.equal(JSON.parse(lines[2]).seq, 3);

    // Verify readFacts
    const allFacts = readFacts(testRunId, testRunsDir);
    assert.equal(allFacts.length, 3);
    assert.equal(allFacts[0].type, 'run_started');
    assert.equal(allFacts[1].type, 'workspace_created');
    assert.equal(allFacts[2].type, 'baseline_recorded');
  });
});
