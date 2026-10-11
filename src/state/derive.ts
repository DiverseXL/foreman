import type { Fact } from './facts.js';

export type ForemanStatus =
  | 'working'
  | 'blocked_policy'
  | 'tests_failing'
  | 'rejected_validator'
  | 'patch_failed'
  | 'budget_exhausted'
  | 'needs_human'
  | 'ready_to_ship'
  | 'shipped';

/**
 * Pure function deriving the system status from append-only facts.
 * Precedence:
 * 1. shipped
 * 2. needs_human
 * 3. budget_exhausted
 * 4. ready_to_ship (latest attempt has a passing gate, passing tests, and allCriteriaPass)
 * 5. failure of the latest attempt (blocked_policy, tests_failing, rejected_validator)
 * 6. working
 */
export function deriveStatus(facts: readonly Fact[]): ForemanStatus {
  if (facts.some((f) => f.type === 'shipped')) {
    return 'shipped';
  }

  if (facts.some((f) => f.type === 'needs_human')) {
    return 'needs_human';
  }

  const latestBudget = [...facts].reverse().find((f) => f.type === 'budget_checked');
  if (latestBudget && latestBudget.type === 'budget_checked' && latestBudget.exhausted) {
    return 'budget_exhausted';
  }

  // Find latest attempt index
  let maxAttempt = -1;
  for (const fact of facts) {
    if (fact.type !== 'workspace_reset' && 'attempt' in fact && typeof fact.attempt === 'number') {
      if (fact.attempt > maxAttempt) {
        maxAttempt = fact.attempt;
      }
    }
  }

  if (maxAttempt >= 0) {
    const gate = [...facts].reverse().find((f) => f.type === 'gate_result' && f.attempt === maxAttempt);
    const tests = [...facts].reverse().find((f) => f.type === 'tests_result' && f.attempt === maxAttempt);
    const validator = [...facts].reverse().find((f) => f.type === 'validator_result' && f.attempt === maxAttempt);

    // The independent validator is optional at this stage: when a validator_result
    // is absent, a passing gate plus a passing tests_result (target passed with no
    // regressions) is enough to be ready_to_ship. When present it must pass.
    const validatorOk =
      !validator || (validator.type === 'validator_result' && validator.allCriteriaPass);

    if (
      gate &&
      gate.type === 'gate_result' &&
      gate.passed &&
      tests &&
      tests.type === 'tests_result' &&
      tests.passed &&
      validatorOk
    ) {
      return 'ready_to_ship';
    }

    // Check failure of latest attempt
    const attemptFailed = [...facts].reverse().find((f) => f.type === 'attempt_failed' && f.attempt === maxAttempt);
    if (attemptFailed && attemptFailed.type === 'attempt_failed') {
      if (attemptFailed.failureClass === 'blocked_policy') {
        return 'blocked_policy';
      }
      if (attemptFailed.failureClass === 'tests_failed') {
        return 'tests_failing';
      }
      if (attemptFailed.failureClass === 'rejected_validator') {
        return 'rejected_validator';
      }
      if (attemptFailed.failureClass === 'apply_failed') {
        return 'patch_failed';
      }
    }

    // Direct stage failures on latest attempt if attempt_failed has not been explicitly logged
    if (validator && validator.type === 'validator_result' && !validator.allCriteriaPass) {
      return 'rejected_validator';
    }
    if (tests && tests.type === 'tests_result' && !tests.passed) {
      return 'tests_failing';
    }
    if (gate && gate.type === 'gate_result' && !gate.passed) {
      return 'blocked_policy';
    }
  }

  return 'working';
}
