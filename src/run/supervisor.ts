/**
 * Supervisor: the retry loop that turns proposals into a shipped branch commit,
 * or into a needs_human stop.
 *
 * Design rules:
 *  - The model proposes and plain code decides; every step is gated in order.
 *  - The writer never judges its own patch (the validator is a separate model).
 *  - Status is derived from append-only facts; nothing is hand-entered into reports.
 *
 * The loop is deliberately dependency-injected (SupervisorEngine + instrument) so
 * the unit tests can drive gate/test/validator outcomes with fakes and zero calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendFact, readFacts, type Fact, type AttemptFailureClass, type PatchSource } from '../state/facts.js';
import { deriveStatus, type ForemanStatus } from '../state/derive.js';
import { runTotals, type RunTotals } from '../model/index.js';
import type { RubricResult, RubricCriterion } from '../mandate/rubric.js';
import type { PatchEdit, ApplyResult } from '../patch/propose.js';
import type { ChangeSummary } from '../policy/changed.js';
import type { GateContext, GateResult, Policy } from '../policy/types.js';
import type { TestRunResult } from '../run/tests.js';
import { ValidatorError, type ValidatorInput, type ValidatorRunResult } from '../validator/index.js';

// ---------------------------------------------------------------------------
// Injection seams
// ---------------------------------------------------------------------------

export interface PatchProposal {
  edits: PatchEdit[];
  model: string;
  patchSource: PatchSource;
}

export interface SupervisorEngine {
  /** Reset the run copy to the base commit (discards the previous attempt commit). */
  reset(): void;
  /** Get a patch: the injected one on attempt 1 when provided, otherwise the model. */
  propose(input: { attempt: number; memoryText: string; injected?: PatchEdit[] }): Promise<PatchProposal>;
  apply(edits: PatchEdit[]): ApplyResult;
  /** Commit the applied edits on the run branch; returns the commit sha. */
  commit(message: string): string;
  /** Unified diff between two commits of the run copy. */
  diff(base: string, head: string): string;
  /** Change summary (files, symbols, added lines, method) between two commits. */
  collect(base: string, head: string): ChangeSummary;
  gate(ctx: GateContext): GateResult;
  tests(): TestRunResult;
  validate(input: ValidatorInput): Promise<ValidatorRunResult>;
  /** Caller count for a symbol not already known to the context, or null. */
  callerCount(symbol: string): number | null;
}

export interface SupervisorContext {
  contextSymbols: string[];
  symbolFacts: { symbol: string; callerCount: number }[];
  evidenceText: string;
}

export type SpanLike = { setAttribute(key: string, value: string | number | boolean): void } | undefined;

export interface SupervisorInstrument {
  runAgent<T>(fn: (span: SpanLike) => Promise<T>): Promise<T>;
  /** Wraps one attempt; setOutcome records the attempt's outcome class on the span. */
  runAttempt<T>(attempt: number, fn: (setOutcome: (outcome: string) => void) => Promise<T>): Promise<T>;
  stage<T>(
    name: string,
    kind: string,
    fn: (span: SpanLike) => Promise<T> | T,
    attrs?: Record<string, string | number | boolean>
  ): Promise<T>;
}

export const NOOP_INSTRUMENT: SupervisorInstrument = {
  runAgent: (fn) => fn(undefined),
  runAttempt: (_attempt, fn) => fn(() => {}),
  stage: (_name, _kind, fn) => Promise.resolve(fn(undefined)),
};

export interface SupervisorOptions {
  runId: string;
  issueId: string;
  runDir: string;
  /** Directory that holds facts.jsonl and ledger.jsonl (default "runs"). */
  runsDir?: string;
  policy: Policy;
  rubric?: RubricResult;
  context: SupervisorContext;
  baseCommit: string;
  engine: SupervisorEngine;
  baselinePassing: string[];
  firstAttemptPatch?: PatchEdit[];
  instrument?: SupervisorInstrument;
  /** Tokens and gateway cost for this run so far (from the ledger). */
  totals?: () => RunTotals;
  /** Wall-clock milliseconds elapsed for this run. */
  wallClockMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface SupervisorOutcome {
  status: ForemanStatus;
  attempts: number;
  shipped: boolean;
  memory: string[];
}

// ---------------------------------------------------------------------------
// Transient errors
// ---------------------------------------------------------------------------

export const MAX_TRANSIENT_RETRIES = 3;

const TRANSIENT_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];

/** HTTP 429, 5xx and network errors are transient (they must not consume an attempt). */
export function isTransientError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
    const code = (err as { code?: string }).code;
    if (code && TRANSIENT_CODES.includes(code)) return true;
    const name = (err as { name?: string }).name;
    if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /429|rate limit|timed out|timeout|socket hang up|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|temporarily unavailable|bad gateway|service unavailable/i.test(
    message
  );
}

function backoffMs(retries: number): number {
  return Math.min(2000, 250 * 2 ** (retries - 1));
}

// ---------------------------------------------------------------------------
// Failure memory
// ---------------------------------------------------------------------------

function summarize(
  attempt: number,
  failureClass: Exclude<AttemptFailureClass, 'error_transient'>,
  detail: {
    failedRules?: { ruleId: string; detail: string }[];
    failingTests?: string[];
    regressions?: string[];
    validatorReasons?: { id: string; verdict: string; reason: string }[];
  }
): string {
  const lines = [`Attempt ${attempt} failed (class: ${failureClass}).`];
  if (detail.failedRules && detail.failedRules.length > 0) {
    lines.push('Failed gate rules:');
    for (const rule of detail.failedRules) lines.push(`  - ${rule.ruleId}: ${rule.detail}`);
  }
  if (detail.regressions && detail.regressions.length > 0) {
    lines.push(`Regressions: ${detail.regressions.join(', ')}`);
  }
  if (detail.failingTests && detail.failingTests.length > 0) {
    lines.push(`Failing tests: ${detail.failingTests.join(', ')}`);
  }
  if (detail.validatorReasons && detail.validatorReasons.length > 0) {
    lines.push('Validator verdicts that were not a confident pass:');
    for (const c of detail.validatorReasons) lines.push(`  - ${c.id}: ${c.verdict} (${c.reason})`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Artifact + report writers
// ---------------------------------------------------------------------------

function writeArtifact(runDir: string, name: string, content: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, name), content, 'utf-8');
}

function gateForAttempt(facts: readonly Fact[], attempt: number) {
  return [...facts].reverse().find((f) => f.type === 'gate_result' && f.attempt === attempt);
}
function testsForAttempt(facts: readonly Fact[], attempt: number) {
  return [...facts].reverse().find((f) => f.type === 'tests_result' && f.attempt === attempt);
}
function validatorForAttempt(facts: readonly Fact[], attempt: number) {
  return [...facts].reverse().find((f) => f.type === 'validator_result' && f.attempt === attempt);
}

export function writeNeedsHuman(
  runId: string,
  runDir: string,
  issueId: string,
  reason: string,
  facts: readonly Fact[],
  totals: RunTotals
): void {
  // Attempts used = the highest attempt number that produced ANY attempt fact
  // (a proposal, a gate/test/validator result, or an attempt_failed).
  const attemptNumbers = facts
    .filter((f) => 'attempt' in f && typeof (f as { attempt?: unknown }).attempt === 'number')
    .map((f) => (f as { attempt: number }).attempt);
  const maxAttempt = attemptNumbers.length > 0 ? Math.max(...attemptNumbers) : 0;
  // The most recent recorded results (the latest attempt may have failed before any stage ran).
  const lastGate = [...facts].reverse().find((f) => f.type === 'gate_result');
  const lastTests = [...facts].reverse().find((f) => f.type === 'tests_result');
  const lastValidator = [...facts].reverse().find((f) => f.type === 'validator_result');

  const lines: string[] = [
    `# NEEDS_HUMAN: ${runId}`,
    '',
    `Issue: ${issueId}`,
    `Reason: ${reason}`,
    `Attempts used: ${maxAttempt}`,
    '',
    '## Last gate result',
    lastGate && lastGate.type === 'gate_result'
      ? `passed=${lastGate.passed}; failedRules=${lastGate.failedRules.length === 0 ? 'none' : lastGate.failedRules.join(', ')}`
      : '(no gate result recorded)',
    '',
    '## Last test result',
    lastTests && lastTests.type === 'tests_result'
      ? `targetPassed=${lastTests.targetPassed ?? 'n/a'}; regressions=${(lastTests.regressions ?? []).length === 0 ? 'none' : (lastTests.regressions ?? []).join(', ')}; failing=${lastTests.failingTests.join(', ') || 'none'}`
      : '(no test result recorded)',
    '',
    '## Last validator result',
    lastValidator && lastValidator.type === 'validator_result'
      ? `allCriteriaPass=${lastValidator.allCriteriaPass}; model=${lastValidator.model ?? 'unknown'}`
      : '(no validator result recorded)',
    ...((lastValidator && lastValidator.type === 'validator_result' && lastValidator.criteria
      ? lastValidator.criteria.map((c) => `- ${c.id}: ${c.verdict} (${c.confidence}) ${c.reason}`)
      : []) as string[]),
    '',
    '## Spend so far',
    `tokens: prompt=${totals.prompt} completion=${totals.completion} total=${totals.total}`,
    `gateway cost (USD): $${totals.cost.toFixed(6)}`,
    '',
    'No secrets are recorded in this file.',
    '',
  ];
  writeArtifact(runDir, 'NEEDS_HUMAN.md', lines.join('\n'));
}

export function writeRunReport(
  opts: {
    runId: string;
    runDir: string;
    issueId: string;
    issueTitle: string;
    traceId: string;
    injected: boolean;
    memory: readonly string[];
    outcome: ForemanStatus;
    attempts: number;
  },
  facts: readonly Fact[],
  totals: RunTotals,
  wallMs: number
): void {
  const attemptNumbers = Array.from(new Set(facts.filter((f) => 'attempt' in f).map((f) => f.attempt as number))).sort(
    (a, b) => a - b
  );

  const rows: string[] = [
    '| Attempt | Patch source | Diff hash | Gate | Failed rules | targetPassed | Regressions | Validator |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const n of attemptNumbers) {
    const proposed = [...facts].reverse().find((f) => f.type === 'patch_proposed' && f.attempt === n);
    const gate = gateForAttempt(facts, n);
    const tests = testsForAttempt(facts, n);
    const validator = validatorForAttempt(facts, n);
    const failed = [...facts].reverse().find((f) => f.type === 'attempt_failed' && f.attempt === n);
    rows.push(
      [
        String(n),
        proposed && proposed.type === 'patch_proposed' ? proposed.patchSource ?? 'model' : 'n/a',
        proposed && proposed.type === 'patch_proposed' ? proposed.diffHash.slice(0, 12) : 'n/a',
        gate && gate.type === 'gate_result' ? (gate.passed ? 'pass' : 'FAIL') : 'not run',
        gate && gate.type === 'gate_result' ? (gate.failedRules.join(', ') || 'none') : '-',
        tests && tests.type === 'tests_result' ? String(tests.targetPassed ?? 'n/a') : 'not run',
        tests && tests.type === 'tests_result' ? ((tests.regressions ?? []).join(', ') || 'none') : '-',
        validator && validator.type === 'validator_result'
          ? validator.allCriteriaPass
            ? 'allCriteriaPass'
            : 'rejected'
          : 'not run',
      ].join(' | ')
    );
    void failed;
  }

  const lines = [
    `# Foreman Run Report: ${opts.runId}`,
    '',
    `Issue: ${opts.issueId} - ${opts.issueTitle}`,
    `Outcome: ${opts.outcome}`,
    `Derived status: ${opts.outcome}`,
    `Attempts: ${opts.attempts}`,
    `Injected first attempt: ${opts.injected ? 'YES' : 'no'}`,
    `Trace ID: ${opts.traceId}`,
    '',
    '## Per-attempt results',
    '',
    ...rows,
    '',
    '## Failure memory used',
    '',
    opts.memory.length === 0 ? '(none; no earlier attempt failed)' : opts.memory.map((m, i) => `### Summary ${i + 1}\n\n${m}`).join('\n\n'),
    '',
    '## Totals (from the ledger)',
    '',
    `prompt tokens: ${totals.prompt}`,
    `completion tokens: ${totals.completion}`,
    `total tokens: ${totals.total}`,
    `gateway cost (USD): $${totals.cost.toFixed(6)}`,
    `wall time: ${(wallMs / 1000).toFixed(1)}s`,
    '',
    '## Shipment',
    '',
    opts.outcome === 'shipped'
      ? 'The run branch in the run copy holds the shipped commit, and proposed.patch holds the same change. ' +
        'NO pull request was opened.'
      : 'Nothing was shipped.',
    '',
  ];
  writeArtifact(opts.runDir, 'report.md', lines.join('\n'));
}

export function writeEconomics(
  runDir: string,
  opts: { runId: string; outcome: ForemanStatus; attempts: number },
  totals: RunTotals,
  wallMs: number
): void {
  const economics = {
    runId: opts.runId,
    attempts: opts.attempts,
    promptTokens: totals.prompt,
    completionTokens: totals.completion,
    totalTokens: totals.total,
    gatewayCostUsd: Number(totals.cost.toFixed(6)),
    wallTimeMs: wallMs,
    outcome: opts.outcome,
  };
  writeArtifact(runDir, 'economics.json', JSON.stringify(economics, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Gate context
// ---------------------------------------------------------------------------

function buildGateContext(change: ChangeSummary, context: SupervisorContext, callerCount: (s: string) => number | null): GateContext {
  const symbolCallerCounts: Record<string, number> = {};
  for (const sf of context.symbolFacts) symbolCallerCounts[sf.symbol] = sf.callerCount;
  for (const symbol of change.changedSymbols) {
    if (!(symbol.name in symbolCallerCounts)) {
      const count = callerCount(symbol.name);
      if (count !== null) symbolCallerCounts[symbol.name] = count;
    }
  }
  return {
    changedFiles: change.changedFiles,
    changedSymbols: change.changedSymbols,
    addedLines: change.addedLines,
    contextSymbols: context.contextSymbols,
    symbolCallerCounts,
  };
}

function diffHashOf(diff: string): string {
  return crypto.createHash('sha256').update(diff).digest('hex');
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runSupervisor(options: SupervisorOptions): Promise<SupervisorOutcome> {
  const {
    runId,
    issueId,
    runDir,
    policy,
    rubric,
    context,
    baseCommit,
    engine,
    baselinePassing,
    firstAttemptPatch,
    instrument = NOOP_INSTRUMENT,
    runsDir = 'runs',
    totals = () => runTotals(runId, runsDir),
    wallClockMs = () => 0,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
  } = options;

  const emit = (payload: Parameters<typeof appendFact>[1]): void => {
    appendFact(runId, payload, { runsDir });
  };

  const memory: string[] = [];
  const seenHashes = new Set<string>();
  const baselinePassingSet = new Set(baselinePassing);
  const rubricIds = (rubric?.criteria ?? []).map((c: RubricCriterion) => c.id);
  const criteriaCount = rubricIds.length;

  let status: ForemanStatus = 'working';
  let shipped = false;
  let attemptsUsed = 0;
  let currentDuplicateHash = '';

  const onTransient = (attempt: number, err: unknown, retries: number): void => {
    emit({
      type: 'error_transient',
      duringAttempt: attempt,
      error: err instanceof Error ? err.message : String(err),
      retries,
    });
  };

  const retryTransient = async <T>(attempt: number, fn: () => Promise<T>): Promise<T> => {
    let retries = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!isTransientError(err) || retries >= MAX_TRANSIENT_RETRIES) throw err;
        retries++;
        onTransient(attempt, err, retries);
        log(`Transient error on attempt ${attempt} (retry ${retries}/${MAX_TRANSIENT_RETRIES}): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        await sleep(backoffMs(retries));
      }
    }
  };

  const finishNeedsHuman = (reason: string): void => {
    emit({ type: 'needs_human', reason });
    writeNeedsHuman(runId, runDir, issueId, reason, readFacts(runId, runsDir), totals());
    status = 'needs_human';
  };

  await instrument.runAgent(async () => {
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const before = totals();
      const elapsed = wallClockMs();
      if (before.total >= policy.maxTokensPerRun || elapsed >= policy.maxWallSeconds * 1000) {
        emit({ type: 'budget_checked', exhausted: true });
        writeNeedsHuman(
          runId,
          runDir,
          issueId,
          `budget exhausted before attempt ${attempt} (tokens ${before.total}/${policy.maxTokensPerRun}, wall ${Math.round(elapsed / 1000)}s/${policy.maxWallSeconds}s)`,
          readFacts(runId, runsDir),
          before
        );
        status = 'budget_exhausted';
        break;
      }

      attemptsUsed = attempt;
      const injected = attempt === 1 ? firstAttemptPatch : undefined;

      const outcome = await instrument.runAttempt(attempt, async (setOutcome) => {
        engine.reset();

        // ----- Get a patch -----
        let proposal: PatchProposal;
        try {
          proposal = await retryTransient(attempt, () =>
            engine.propose({ attempt, memoryText: memory.join('\n\n'), injected })
          );
        } catch (err) {
          emit({ type: 'attempt_failed', attempt, failureClass: 'no_evidence' });
          memory.push(
            summarize(attempt, 'no_evidence', {
              failingTests: [],
            }) + `\nPatch proposal error: ${err instanceof Error ? err.message : String(err)}`
          );
          setOutcome('no_evidence');
          return 'no_evidence' as const;
        }

        // ----- Apply (exact-once) -----
        const applyResult = engine.apply(proposal.edits);
        if (!applyResult.ok) {
          emit({ type: 'attempt_failed', attempt, failureClass: 'apply_failed' });
          // Evidence: persist the exact proposal that could not be applied so the
          // failure can be diagnosed from artifacts, not from the model's account.
          writeArtifact(
            runDir,
            `attempt-${attempt}-proposal.json`,
            JSON.stringify(
              {
                attempt,
                patchSource: proposal.patchSource,
                model: proposal.model,
                applyError: applyResult.reason,
                failedEditIndex: applyResult.index,
                edits: proposal.edits,
              },
              null,
              2
            ) + '\n'
          );
          memory.push(
            summarize(attempt, 'apply_failed', {}) + `\nApply error: ${applyResult.reason} (edit ${applyResult.index})`
          );
          setOutcome('apply_failed');
          return 'apply_failed' as const;
        }

        // ----- Commit, diff, hash -----
        const sha = engine.commit(`attempt-${attempt} (${proposal.patchSource})`);
        const diff = engine.diff(baseCommit, sha);
        const diffHash = diffHashOf(diff);
        emit({ type: 'patch_proposed', attempt, diffHash, patchSource: proposal.patchSource });
        writeArtifact(runDir, `attempt-${attempt}.diff`, diff + '\n');

        // ----- Duplicate detection: same diff as an earlier attempt = stuck -----
        if (seenHashes.has(diffHash)) {
          emit({ type: 'attempt_failed', attempt, failureClass: 'stuck_duplicate' });
          setOutcome('stuck_duplicate');
          currentDuplicateHash = diffHash;
          log(`Attempt ${attempt} produced the same diff as an earlier attempt (hash ${diffHash.slice(0, 12)}). Stopping.`);
          return 'stuck_duplicate' as const;
        }
        seenHashes.add(diffHash);

        // ----- Policy gate (fail closed) -----
        const change = engine.collect(baseCommit, sha);
        const gateContext = buildGateContext(change, context, engine.callerCount);
        const gate = await instrument.stage(
          'policy_gate',
          'GUARDRAIL',
          (span) => {
            const result = engine.gate(gateContext);
            span?.setAttribute('foreman.gate.failed_count', result.failedRules.length);
            span?.setAttribute('foreman.gate.failed_rules', result.failedRules.join(','));
            span?.setAttribute('foreman.gate.symbol_method', change.method);
            return result;
          },
          { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
        );

        emit({ type: 'gate_result', attempt, passed: gate.passed, failedRules: gate.failedRules });
        writeArtifact(
          runDir,
          `gate-${attempt}.json`,
          JSON.stringify(
            {
              attempt,
              passed: gate.passed,
              failedRules: gate.failedRules,
              changedSymbolMethod: change.method,
              changedSymbolNote: change.note,
              changedFiles: change.changedFiles,
              changedSymbols: change.changedSymbols,
              rules: gate.rules,
            },
            null,
            2
          ) + '\n'
        );

        if (!gate.passed) {
          emit({ type: 'attempt_failed', attempt, failureClass: 'blocked_policy' });
          memory.push(
            summarize(attempt, 'blocked_policy', {
              failedRules: gate.rules.filter((r) => !r.passed).map((r) => ({ ruleId: r.ruleId, detail: r.detail })),
            })
          );
          setOutcome('blocked_policy');
          return 'blocked_policy' as const;
        }

        // ----- Tests (only when the gate passed) -----
        const testRes = await instrument.stage(
          'tests',
          'EVALUATOR',
          (span) => {
            const result = engine.tests();
            span?.setAttribute('foreman.tests.passed', result.passed);
            span?.setAttribute('foreman.tests.failed', result.failed);
            span?.setAttribute('foreman.tests.exit_code', result.exitCode);
            return result;
          },
          { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
        );

        const targetName = `repro-issue-${issueId}`;
        const targetPassed = testRes.passingTests.includes(targetName) && !testRes.failingTests.includes(targetName);
        const regressions = testRes.failingTests.filter((t) => baselinePassingSet.has(t));
        const testsPassed = targetPassed && regressions.length === 0;

        emit({
          type: 'tests_result',
          attempt,
          passed: testsPassed,
          targetPassed,
          regressions,
          failingTests: testRes.failingTests,
        });
        writeArtifact(runDir, `tests-${attempt}.txt`, testRes.output);

        if (!testsPassed) {
          emit({ type: 'attempt_failed', attempt, failureClass: 'tests_failed' });
          memory.push(
            summarize(attempt, 'tests_failed', {
              failingTests: testRes.failingTests,
              regressions,
            }) + `\ntargetPassed=${targetPassed}`
          );
          setOutcome('tests_failed');
          return 'tests_failed' as const;
        }

        // ----- Independent validator (only when the tests passed) -----
        const validatorInput: ValidatorInput = {
          criteria: rubric?.criteria ?? [],
          diff,
          targetPassed,
          regressions,
          gate: { passed: gate.passed, failedRules: gate.failedRules, rules: gate.rules },
          evidenceText: context.evidenceText,
        };

        let validatorResult: ValidatorRunResult;
        try {
          validatorResult = await retryTransient(attempt, () => engine.validate(validatorInput));
        } catch (err) {
          if (err instanceof ValidatorError) {
            log(`Validator output invalid after retry: ${err.reason}`);
            emit({ type: 'attempt_failed', attempt, failureClass: 'rejected_validator' });
            setOutcome('needs_human');
            return 'needs_human_invalid' as const;
          }
          emit({ type: 'attempt_failed', attempt, failureClass: 'no_evidence' });
          memory.push(
            summarize(attempt, 'no_evidence', { failingTests: [] }) +
              `\nValidator call error: ${err instanceof Error ? err.message : String(err)}`
          );
          setOutcome('no_evidence');
          return 'no_evidence' as const;
        }

        emit({
          type: 'validator_result',
          attempt,
          allCriteriaPass: validatorResult.allCriteriaPass,
          model: validatorResult.model,
          criteria: validatorResult.criteria,
        });
        writeArtifact(
          runDir,
          `validator-${attempt}.json`,
          JSON.stringify(
            {
              attempt,
              model: validatorResult.model,
              minConfidence: policy.validatorMinConfidence,
              allCriteriaPass: validatorResult.allCriteriaPass,
              criteria: validatorResult.criteria,
            },
            null,
            2
          ) + '\n'
        );

        if (!validatorResult.allCriteriaPass) {
          emit({ type: 'attempt_failed', attempt, failureClass: 'rejected_validator' });
          memory.push(
            summarize(attempt, 'rejected_validator', {
              validatorReasons: validatorResult.criteria
                .filter((c) => c.verdict !== 'pass' || c.confidence < policy.validatorMinConfidence)
                .map((c) => ({ id: c.id, verdict: c.verdict, reason: c.reason })),
            })
          );
          setOutcome('rejected_validator');
          return 'rejected_validator' as const;
        }

        // ----- Success -----
        emit({ type: 'shipped' });
        writeArtifact(runDir, 'proposed.patch', diff + '\n');
        log(
          `Shipped: the run branch holds commit ${sha.slice(0, 12)} and proposed.patch holds the change. NO pull request was opened.`
        );
        setOutcome('shipped');
        status = 'shipped';
        shipped = true;
        return 'shipped' as const;
      });

      if (outcome === 'shipped') break;
      if (outcome === 'stuck_duplicate') {
        finishNeedsHuman(
          `Attempt ${attempt} reproduced an earlier attempt's diff exactly (diffHash ${currentDuplicateHash.slice(0, 12)}); stopping instead of repeating a known-dead approach.`
        );
        break;
      }
      if (outcome === 'needs_human_invalid') {
        finishNeedsHuman(`Validator output was invalid after one retry on attempt ${attempt}.`);
        break;
      }
    }

    if (!shipped && status === 'working') {
      finishNeedsHuman(`All ${policy.maxAttempts} attempt(s) failed; no patch satisfied the gate, tests and validator.`);
    }
  });

  return { status, attempts: attemptsUsed, shipped, memory };
}

