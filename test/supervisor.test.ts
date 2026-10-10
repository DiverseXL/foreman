import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSupervisor, type SupervisorEngine, type SupervisorOptions } from '../src/run/supervisor.js';
import { readFacts } from '../src/state/facts.js';
import { deriveStatus } from '../src/state/derive.js';
import type { Policy } from '../src/policy/types.js';
import type { RubricResult } from '../src/mandate/rubric.js';
import { ValidatorError, type ValidatorRunResult } from '../src/validator/index.js';
import type { ChangeSummary } from '../src/policy/changed.js';
import type { TestRunResult } from '../src/run/tests.js';

// ---------------------------------------------------------------------------
// Fakes: no model calls, no git, no telemetry
// ---------------------------------------------------------------------------

const POLICY: Policy = {
  version: 1,
  allowedPaths: ['src/**'],
  deniedPaths: ['test/**'],
  denyDotfiles: true,
  maxFiles: 3,
  maxChangedLines: 40,
  maxTransitiveCallers: 10,
  maxAttempts: 3,
  validatorMinConfidence: 0.7,
  maxTokensPerRun: 60000,
  maxWallSeconds: 300,
  lockfiles: ['package.json'],
  secretPatterns: [],
};

const RUBRIC: RubricResult = {
  model: 'claude-haiku',
  attempts: 1,
  criteria: [{ id: 'r1', text: 'the rounded total is correct', check: 'test' }],
};

const CHANGE: ChangeSummary = {
  changedFiles: [{ path: 'src/rounding.ts', status: 'M', added: 1, removed: 1 }],
  changedSymbols: [{ name: 'roundCurrency', kind: 'function', file: 'src/rounding.ts' }],
  addedLines: ['const x = 1'],
  method: 'entire_graph_diff',
  note: 'fake',
};

function passingTests(): TestRunResult {
  return {
    exitCode: 0,
    passed: 1,
    failed: 0,
    failingTests: [],
    passingTests: ['repro-issue-1'],
    durationMs: 1,
    output: '# pass 1',
  };
}

function okValidator(): ValidatorRunResult {
  return {
    model: 'nova-pro',
    attempts: 1,
    criteria: [{ id: 'r1', verdict: 'pass', confidence: 0.9, reason: 'looks correct' }],
    allCriteriaPass: true,
  };
}

interface Harness {
  runId: string;
  runsDir: string;
  runDir: string;
  options: (overrides?: Partial<SupervisorOptions>) => SupervisorOptions;
  facts: () => ReturnType<typeof readFacts>;
}

function makeHarness(engineOverrides: Partial<SupervisorEngine> = {}): Harness {
  const runId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sup-'));
  const runDir = path.join(runsDir, runId);

  const engine: SupervisorEngine = {
    reset: () => {},
    propose: async () => ({ edits: [{ file: 'src/rounding.ts', search: 'a', replace: 'b' }], model: 'fake', patchSource: 'model' }),
    apply: () => ({ ok: true, applied: [{ file: 'src/rounding.ts', replacedChars: 1 }] }),
    commit: () => 'sha-fixed',
    diff: () => 'diff',
    collect: () => CHANGE,
    gate: () => ({ passed: true, rules: [], failedRules: [] }),
    tests: () => passingTests(),
    validate: async () => okValidator(),
    callerCount: () => 1,
    ...engineOverrides,
  };

  const options = (overrides: Partial<SupervisorOptions> = {}): SupervisorOptions => ({
    runId,
    issueId: '1',
    runDir,
    runsDir,
    policy: POLICY,
    rubric: RUBRIC,
    context: { contextSymbols: ['roundCurrency'], symbolFacts: [{ symbol: 'roundCurrency', callerCount: 1 }], evidenceText: '' },
    baseCommit: 'base',
    engine,
    baselinePassing: [],
    sleep: async () => {},
    ...overrides,
  });

  return { runId, runsDir, runDir, options, facts: () => readFacts(runId, runsDir) };
}

// ---------------------------------------------------------------------------

describe('supervisor attempt loop', () => {
  it('gate failure on attempt 1 then success on attempt 2, with failure memory in the second prompt', async () => {
    let gateCalls = 0;
    const memorySeen: string[] = [];
    let proposeCalls = 0;

    const engine: Partial<SupervisorEngine> = {
      propose: async ({ attempt, memoryText }) => {
        proposeCalls++;
        memorySeen.push(memoryText);
        return {
          edits: [{ file: 'src/rounding.ts', search: `s${attempt}`, replace: `r${attempt}` }],
          model: 'fake',
          patchSource: 'model',
        };
      },
      commit: () => `sha-${++gateCalls}`,
      diff: (_b, h) => `diff-${h}`,
      gate: () =>
        gateCalls === 1
          ? { passed: false, rules: [{ ruleId: 'blast_radius', passed: false, detail: 'x=19' }], failedRules: ['blast_radius'] }
          : { passed: true, rules: [], failedRules: [] },
    };

    const h = makeHarness(engine);
    const outcome = await runSupervisor(h.options());

    assert.equal(outcome.shipped, true);
    assert.equal(outcome.attempts, 2);
    assert.equal(proposeCalls, 2);
    assert.equal(memorySeen[0], '');
    assert.match(memorySeen[1], /Attempt 1 failed \(class: blocked_policy\)/);
    assert.match(memorySeen[1], /blast_radius: x=19/);
    assert.equal(deriveStatus(h.facts()), 'shipped');
  });

  it('three failures end in needs_human with a NEEDS_HUMAN.md', async () => {
    let commitCount = 0;
    const h = makeHarness({
      commit: () => `sha-${++commitCount}`,
      diff: (_b, head) => `diff-${head}`,
      gate: () => ({ passed: false, rules: [{ ruleId: 'secrets', passed: false, detail: 'key-like' }], failedRules: ['secrets'] }),
    });
    const outcome = await runSupervisor(h.options());

    assert.equal(outcome.shipped, false);
    assert.equal(outcome.attempts, 3);
    const facts = h.facts();
    assert.equal(facts.filter((f) => f.type === 'attempt_failed' && f.failureClass === 'blocked_policy').length, 3);
    assert.ok(facts.some((f) => f.type === 'needs_human'));
    assert.equal(deriveStatus(facts), 'needs_human');
    assert.ok(fs.existsSync(path.join(h.runDir, 'NEEDS_HUMAN.md')));
  });

  it('an identical diff hash on a later attempt stops with stuck_duplicate and needs_human', async () => {
    let validateCalls = 0;
    const h = makeHarness({
      diff: () => 'same-diff-every-time',
      validate: async () => {
        validateCalls++;
        return {
          model: 'nova-pro',
          attempts: 1,
          criteria: [{ id: 'r1', verdict: 'fail', confidence: 0.95, reason: 'wrong rounding' }],
          allCriteriaPass: false,
        };
      },
    });

    const outcome = await runSupervisor(h.options());
    assert.equal(outcome.attempts, 2);
    assert.equal(validateCalls, 1);
    const facts = h.facts();
    assert.ok(facts.some((f) => f.type === 'attempt_failed' && f.failureClass === 'stuck_duplicate'));
    assert.ok(facts.some((f) => f.type === 'needs_human'));
    assert.equal(deriveStatus(facts), 'needs_human');
  });

  it('transient errors retry without consuming an attempt', async () => {
    let proposeCalls = 0;
    const h = makeHarness({
      propose: async () => {
        proposeCalls++;
        if (proposeCalls === 1) throw { status: 429, message: 'rate limit' };
        return { edits: [{ file: 'src/rounding.ts', search: 'a', replace: 'b' }], model: 'fake', patchSource: 'model' };
      },
    });

    const outcome = await runSupervisor(h.options());
    assert.equal(outcome.shipped, true);
    assert.equal(outcome.attempts, 1);
    assert.equal(proposeCalls, 2);
    const facts = h.facts();
    assert.ok(facts.some((f) => f.type === 'error_transient'));
    assert.equal(facts.filter((f) => f.type === 'attempt_failed').length, 0);
    assert.equal(deriveStatus(facts), 'shipped');
  });

  it('budget exhaustion stops before any attempt runs', async () => {
    let proposeCalls = 0;
    const h = makeHarness({
      propose: async () => {
        proposeCalls++;
        throw new Error('should not be called');
      },
    });

    const outcome = await runSupervisor(
      h.options({ totals: () => ({ prompt: 0, completion: 0, total: 99999, cost: 0, keySpendUsd: null, keyMaxBudgetUsd: null }) })
    );

    assert.equal(proposeCalls, 0);
    assert.equal(outcome.status, 'budget_exhausted');
    const facts = h.facts();
    assert.ok(facts.some((f) => f.type === 'budget_checked' && f.exhausted));
    assert.equal(deriveStatus(facts), 'budget_exhausted');
  });

  it('an apply failure is classified apply_failed and drives patch_failed', async () => {
    const h = makeHarness({
      apply: () => ({ ok: false, reason: 'search string not found in src/rounding.ts', index: 0, file: 'src/rounding.ts' }),
    });

    const outcome = await runSupervisor(h.options({ policy: { ...POLICY, maxAttempts: 1 } }));
    assert.equal(outcome.shipped, false);
    const facts = h.facts();
    const failed = facts.find((f) => f.type === 'attempt_failed');
    assert.ok(failed && failed.type === 'attempt_failed' && failed.failureClass === 'apply_failed');
    assert.ok(facts.some((f) => f.type === 'needs_human'));
  });

  it('a validator that throws (id mismatch after retry) is terminal needs_human', async () => {
    const h = makeHarness({
      validate: async () => {
        throw new ValidatorError('Validator output was invalid after 2 attempts: missing verdict for rubric id', 2);
      },
    });

    const outcome = await runSupervisor(h.options());
    assert.equal(outcome.shipped, false);
    assert.equal(outcome.attempts, 1);
    const facts = h.facts();
    assert.ok(facts.some((f) => f.type === 'attempt_failed' && f.failureClass === 'rejected_validator'));
    assert.ok(facts.some((f) => f.type === 'needs_human'));
    assert.equal(deriveStatus(facts), 'needs_human');
  });

  it('a validator rejection below the confidence floor retries, then ships on a later attempt', async () => {
    let validateCalls = 0;
    let commitCount = 0;
    const h = makeHarness({
      commit: () => `sha-${++commitCount}`,
      diff: (_b, head) => `diff-${head}`,
      validate: async () => {
        validateCalls++;
        if (validateCalls === 1) {
          return {
            model: 'nova-pro',
            attempts: 1,
            criteria: [{ id: 'r1', verdict: 'pass', confidence: 0.4, reason: 'unsure' }],
            allCriteriaPass: false,
          };
        }
        return okValidator();
      },
    });

    const outcome = await runSupervisor(h.options());
    assert.equal(outcome.shipped, true);
    assert.equal(outcome.attempts, 2);
    const facts = h.facts();
    assert.ok(facts.some((f) => f.type === 'attempt_failed' && f.failureClass === 'rejected_validator'));
    assert.ok(fs.existsSync(path.join(h.runDir, 'proposed.patch')));
  });
});
