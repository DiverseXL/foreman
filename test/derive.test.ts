import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus } from '../src/state/derive.js';
import type { Fact } from '../src/state/facts.js';

describe('deriveStatus pure function', () => {
  it('returns "working" when facts list has baseline/initial state', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'workspace_created', baseCommit: 'abc', branch: 'b', path: '/p' },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'baseline_recorded', exitCode: 1, passed: 28, failed: 3, failingTests: ['t1'] },
    ];
    assert.equal(deriveStatus(facts), 'working');
  });

  it('returns "shipped" when a shipped fact exists', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'shipped' },
    ];
    assert.equal(deriveStatus(facts), 'shipped');
  });

  it('does not let a held-out result change derived status', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'shipped' },
    ];
    const before = deriveStatus(facts);
    facts.push({
      seq: 2,
      ts: '2026-10-10T10:00:01Z',
      type: 'holdout_result',
      issueId: '1',
      passed: false,
      failingTests: ['held-out-case'],
    });
    assert.equal(deriveStatus(facts), before);
  });

  it('returns "needs_human" when needs_human fact is present', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'needs_human', reason: 'Ambiguous prompt' },
    ];
    assert.equal(deriveStatus(facts), 'needs_human');
  });

  it('returns "budget_exhausted" when budget_checked exhausted is true', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'budget_checked', exhausted: true },
    ];
    assert.equal(deriveStatus(facts), 'budget_exhausted');
  });

  it('returns "ready_to_ship" when latest attempt has passing gate, passing tests, and allCriteriaPass', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'gate_result', attempt: 1, passed: true, failedRules: [] },
      { seq: 4, ts: '2026-10-10T10:00:03Z', type: 'tests_result', attempt: 1, passed: true, failingTests: [] },
      { seq: 5, ts: '2026-10-10T10:00:04Z', type: 'validator_result', attempt: 1, allCriteriaPass: true },
    ];
    assert.equal(deriveStatus(facts), 'ready_to_ship');
  });

  it('returns "blocked_policy" when latest attempt fails with blocked_policy', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'gate_result', attempt: 1, passed: false, failedRules: ['no-secrets'] },
      { seq: 4, ts: '2026-10-10T10:00:03Z', type: 'attempt_failed', attempt: 1, failureClass: 'blocked_policy' },
    ];
    assert.equal(deriveStatus(facts), 'blocked_policy');
  });

  it('returns "tests_failing" when latest attempt fails with tests_failed', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'tests_result', attempt: 1, passed: false, failingTests: ['t1'] },
      { seq: 4, ts: '2026-10-10T10:00:03Z', type: 'attempt_failed', attempt: 1, failureClass: 'tests_failed' },
    ];
    assert.equal(deriveStatus(facts), 'tests_failing');
  });

  it('returns "rejected_validator" when latest attempt fails with rejected_validator', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'validator_result', attempt: 1, allCriteriaPass: false },
      { seq: 4, ts: '2026-10-10T10:00:03Z', type: 'attempt_failed', attempt: 1, failureClass: 'rejected_validator' },
    ];
    assert.equal(deriveStatus(facts), 'rejected_validator');
  });

  it('evaluates status by the LATEST attempt failure', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'attempt_failed', attempt: 1, failureClass: 'blocked_policy' },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'patch_proposed', attempt: 2, diffHash: 'h2' },
      { seq: 4, ts: '2026-10-10T10:00:03Z', type: 'attempt_failed', attempt: 2, failureClass: 'tests_failed' },
    ];
    assert.equal(deriveStatus(facts), 'tests_failing');
  });

  it('precedence: shipped precedes needs_human, budget_exhausted, and ready_to_ship', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'needs_human', reason: 'Review required' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'budget_checked', exhausted: true },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'shipped' },
    ];
    assert.equal(deriveStatus(facts), 'shipped');
  });

  it('precedence: needs_human precedes budget_exhausted and ready_to_ship', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'gate_result', attempt: 1, passed: true, failedRules: [] },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'tests_result', attempt: 1, passed: true, failingTests: [] },
      { seq: 4, ts: '2026-10-10T10:00:03Z', type: 'validator_result', attempt: 1, allCriteriaPass: true },
      { seq: 5, ts: '2026-10-10T10:00:04Z', type: 'budget_checked', exhausted: true },
      { seq: 6, ts: '2026-10-10T10:00:05Z', type: 'needs_human', reason: 'Human checkpoint' },
    ];
    assert.equal(deriveStatus(facts), 'needs_human');
  });

  it('precedence: budget_exhausted precedes ready_to_ship', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'gate_result', attempt: 1, passed: true, failedRules: [] },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'tests_result', attempt: 1, passed: true, failingTests: [] },
      { seq: 4, ts: '2026-10-10T10:00:03Z', type: 'validator_result', attempt: 1, allCriteriaPass: true },
      { seq: 5, ts: '2026-10-10T10:00:04Z', type: 'budget_checked', exhausted: true },
    ];
    assert.equal(deriveStatus(facts), 'budget_exhausted');
  });

  it('returns "ready_to_ship" when the target passes with remaining unrelated failures', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'gate_result', attempt: 1, passed: true, failedRules: [] },
      {
        seq: 4,
        ts: '2026-10-10T10:00:03Z',
        type: 'tests_result',
        attempt: 1,
        passed: true,
        targetPassed: true,
        regressions: [],
        failingTests: ['repro-issue-2', 'repro-issue-3'],
      },
    ];
    assert.equal(deriveStatus(facts), 'ready_to_ship');
  });

  it('returns "tests_failing" when a regression blocks the attempt', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'gate_result', attempt: 1, passed: true, failedRules: [] },
      {
        seq: 4,
        ts: '2026-10-10T10:00:03Z',
        type: 'tests_result',
        attempt: 1,
        passed: false,
        targetPassed: true,
        regressions: ['calculates standard tax for small amount'],
        failingTests: ['calculates standard tax for small amount', 'repro-issue-2'],
      },
    ];
    assert.equal(deriveStatus(facts), 'tests_failing');
  });

  it('returns "patch_failed" when the latest attempt could not be applied', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'attempt_failed', attempt: 1, failureClass: 'apply_failed' },
    ];
    assert.equal(deriveStatus(facts), 'patch_failed');
  });

  it('transient errors never shift the derived status', () => {
    const facts: Fact[] = [
      { seq: 1, ts: '2026-10-10T10:00:00Z', type: 'run_started', runId: 'run-1', issueId: '1' },
      { seq: 2, ts: '2026-10-10T10:00:01Z', type: 'error_transient', duringAttempt: 1, error: 'rate limit', retries: 1 },
      { seq: 3, ts: '2026-10-10T10:00:02Z', type: 'patch_proposed', attempt: 1, diffHash: 'h1' },
      { seq: 4, ts: '2026-10-10T10:00:03Z', type: 'gate_result', attempt: 1, passed: true, failedRules: [] },
      { seq: 5, ts: '2026-10-10T10:00:04Z', type: 'tests_result', attempt: 1, passed: true, failingTests: [] },
      { seq: 6, ts: '2026-10-10T10:00:05Z', type: 'validator_result', attempt: 1, allCriteriaPass: true },
    ];
    assert.equal(deriveStatus(facts), 'ready_to_ship');
  });
});
