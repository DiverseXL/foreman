/**
 * Code-decided criteria and the code/validator split.
 *
 * Design rule: anything provable by plain code is decided by code. The three
 * deterministic facts of a run are the repro test passing, no regressions, and
 * the fail-closed policy gate passing. They are recorded as verdicts with
 * source "code" and confidence 1 and are NEVER sent to the model validator.
 *
 * Rubric criteria are partitioned by `check`:
 *   - check "test"  -> covered by the code verdicts (report-only; source "code")
 *   - check "diff" | "behavior" -> judgment; sent to the independent validator
 *
 * allCriteriaPass requires the code group AND the validator group to pass.
 */

import type { RubricCriterion } from '../mandate/rubric.js';

export type Verdict = 'pass' | 'fail' | 'unclear';
export type VerdictSource = 'code' | 'validator';

export interface CodeVerdict {
  id: string;
  criterion: string;
  source: 'code';
  verdict: Verdict;
  confidence: number;
  reason: string;
}

/** Minimal structural view of a validator verdict used for combining. */
export interface ValidatorVerdictLike {
  id: string;
  verdict: Verdict;
  confidence: number;
}

export interface CodeDecidedInput {
  issueId: string;
  targetPassed: boolean;
  regressions: string[];
  gatePassed: boolean;
}

/** The three deterministic verdicts, decided by code with confidence 1. */
export function buildCodeVerdicts(input: CodeDecidedInput): CodeVerdict[] {
  const { issueId, targetPassed, regressions, gatePassed } = input;
  return [
    {
      id: 'code:repro-test',
      criterion: `the repro test repro-issue-${issueId} passes`,
      source: 'code',
      verdict: targetPassed ? 'pass' : 'fail',
      confidence: 1,
      reason: targetPassed
        ? `repro-issue-${issueId} passed after the patch`
        : `repro-issue-${issueId} did not pass after the patch`,
    },
    {
      id: 'code:no-regressions',
      criterion: 'no previously passing test regresses',
      source: 'code',
      verdict: regressions.length === 0 ? 'pass' : 'fail',
      confidence: 1,
      reason: regressions.length === 0 ? 'no regressions' : `regressions: ${regressions.join(', ')}`,
    },
    {
      id: 'code:gate',
      criterion: 'the fail-closed policy gate passes',
      source: 'code',
      verdict: gatePassed ? 'pass' : 'fail',
      confidence: 1,
      reason: gatePassed ? 'policy gate passed' : 'policy gate failed',
    },
  ];
}

export function allCodePass(verdicts: readonly CodeVerdict[]): boolean {
  return verdicts.every((v) => v.verdict === 'pass');
}

export function isJudgmentCriterion(criterion: RubricCriterion): boolean {
  return criterion.check === 'diff' || criterion.check === 'behavior';
}

export function partitionRubric(criteria: readonly RubricCriterion[]): {
  judgment: RubricCriterion[];
  test: RubricCriterion[];
} {
  const judgment: RubricCriterion[] = [];
  const test: RubricCriterion[] = [];
  for (const criterion of criteria) {
    (isJudgmentCriterion(criterion) ? judgment : test).push(criterion);
  }
  return { judgment, test };
}

export interface CoveredTestRow {
  id: string;
  criterion: string;
  check: string;
  source: 'code';
  verdict: Verdict;
  confidence: number;
  reason: string;
}

/**
 * Rubric criteria with check "test" are covered by the code verdicts. They are
 * listed in the report as source "code" so no rubric item is silently dropped,
 * but they do not add a separate scored criterion.
 */
export function coveredTestVerdicts(criteria: readonly RubricCriterion[], codePass: boolean): CoveredTestRow[] {
  return criteria.map((criterion) => ({
    id: criterion.id,
    criterion: criterion.text,
    check: criterion.check,
    source: 'code' as const,
    verdict: (codePass ? 'pass' : 'fail') as Verdict,
    confidence: 1,
    reason: 'covered by code verdicts (repro test, no regressions, policy gate)',
  }));
}

/** allCriteriaPass = code group passes AND every judgment criterion is a confident pass. */
export function combineAllCriteriaPass(
  code: readonly CodeVerdict[],
  validatorCriteria: readonly ValidatorVerdictLike[],
  judgmentIds: readonly string[],
  minConfidence: number
): boolean {
  if (!allCodePass(code)) return false;
  return judgmentIds.every((id) => {
    const criterion = validatorCriteria.find((v) => v.id === id);
    return Boolean(criterion && criterion.verdict === 'pass' && criterion.confidence >= minConfidence);
  });
}

export interface EscalationDecision {
  escalate: boolean;
  unclearIds: string[];
}

/**
 * One evidence escalation is warranted when the code group passes and the ONLY
 * non-pass judgment verdicts are "unclear" (no hard fail, no below-floor pass).
 */
export function escalationWarranted(
  code: readonly CodeVerdict[],
  validatorCriteria: readonly ValidatorVerdictLike[],
  judgmentIds: readonly string[],
  minConfidence: number
): EscalationDecision {
  if (!allCodePass(code)) return { escalate: false, unclearIds: [] };
  const unclearIds: string[] = [];
  for (const id of judgmentIds) {
    const criterion = validatorCriteria.find((v) => v.id === id);
    if (!criterion) return { escalate: false, unclearIds: [] };
    const nonPass = criterion.verdict !== 'pass' || criterion.confidence < minConfidence;
    if (!nonPass) continue;
    if (criterion.verdict === 'unclear') {
      unclearIds.push(id);
      continue;
    }
    // A fail, or a "pass" below the confidence floor, is not a pure-unclear case.
    return { escalate: false, unclearIds: [] };
  }
  return { escalate: unclearIds.length > 0, unclearIds };
}
