import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodeVerdicts,
  allCodePass,
  partitionRubric,
  combineAllCriteriaPass,
  escalationWarranted,
} from '../src/validator/verdicts.js';
import type { RubricCriterion } from '../src/mandate/rubric.js';

const PASS_CODE = buildCodeVerdicts({ issueId: '1', targetPassed: true, regressions: [], gatePassed: true });

describe('code-decided criteria', () => {
  it('records the deterministic trio with source code and confidence 1', () => {
    const verdicts = buildCodeVerdicts({ issueId: '3', targetPassed: true, regressions: [], gatePassed: true });
    assert.equal(verdicts.length, 3);
    assert.deepEqual(
      verdicts.map((v) => v.id),
      ['code:repro-test', 'code:no-regressions', 'code:gate']
    );
    for (const v of verdicts) {
      assert.equal(v.source, 'code');
      assert.equal(v.confidence, 1);
      assert.equal(v.verdict, 'pass');
    }
  });

  it('fails the code group when any deterministic fact fails', () => {
    assert.equal(allCodePass(buildCodeVerdicts({ issueId: '1', targetPassed: false, regressions: [], gatePassed: true })), false);
    assert.equal(allCodePass(buildCodeVerdicts({ issueId: '1', targetPassed: true, regressions: ['t'], gatePassed: true })), false);
    assert.equal(allCodePass(buildCodeVerdicts({ issueId: '1', targetPassed: true, regressions: [], gatePassed: false })), false);
  });

  it('partitions rubric criteria by check: test -> code, diff/behavior -> validator', () => {
    const criteria: RubricCriterion[] = [
      { id: 'r1', text: 'a', check: 'test', evidence_ref: { kind: 'test', value: 'repro-issue-1' } },
      { id: 'r2', text: 'b', check: 'diff', evidence_ref: { kind: 'symbol', value: 'f' } },
      { id: 'r3', text: 'c', check: 'behavior', evidence_ref: { kind: 'issue_text', value: 'a' } },
    ];
    const { judgment, test } = partitionRubric(criteria);
    assert.deepEqual(
      judgment.map((c) => c.id),
      ['r2', 'r3']
    );
    assert.deepEqual(
      test.map((c) => c.id),
      ['r1']
    );
  });
});

describe('combineAllCriteriaPass requires BOTH groups', () => {
  const validatorPass = [{ id: 'r1', verdict: 'pass' as const, confidence: 0.9 }];

  it('passes when code and validator both pass', () => {
    assert.equal(combineAllCriteriaPass(PASS_CODE, validatorPass, ['r1'], 0.7), true);
  });

  it('fails when the validator passes but a code verdict fails (code overrides)', () => {
    const failingCode = buildCodeVerdicts({ issueId: '1', targetPassed: false, regressions: [], gatePassed: true });
    assert.equal(combineAllCriteriaPass(failingCode, validatorPass, ['r1'], 0.7), false);
  });

  it('fails when code passes but a judgment criterion is below the floor', () => {
    assert.equal(combineAllCriteriaPass(PASS_CODE, [{ id: 'r1', verdict: 'pass', confidence: 0.5 }], ['r1'], 0.7), false);
  });

  it('fails when a judgment criterion is unclear', () => {
    assert.equal(combineAllCriteriaPass(PASS_CODE, [{ id: 'r1', verdict: 'unclear', confidence: 0.9 }], ['r1'], 0.7), false);
  });
});

describe('escalationWarranted', () => {
  it('escalates when the only non-pass verdicts are unclear and code passes', () => {
    const decision = escalationWarranted(PASS_CODE, [{ id: 'r1', verdict: 'unclear', confidence: 0.5 }], ['r1'], 0.7);
    assert.equal(decision.escalate, true);
    assert.deepEqual(decision.unclearIds, ['r1']);
  });

  it('does not escalate on a hard fail', () => {
    assert.equal(escalationWarranted(PASS_CODE, [{ id: 'r1', verdict: 'fail', confidence: 0.9 }], ['r1'], 0.7).escalate, false);
  });

  it('does not escalate on a below-floor pass (not an unclear case)', () => {
    assert.equal(escalationWarranted(PASS_CODE, [{ id: 'r1', verdict: 'pass', confidence: 0.4 }], ['r1'], 0.7).escalate, false);
  });

  it('does not escalate when the code group fails', () => {
    const failingCode = buildCodeVerdicts({ issueId: '1', targetPassed: false, regressions: [], gatePassed: true });
    assert.equal(escalationWarranted(failingCode, [{ id: 'r1', verdict: 'unclear', confidence: 0.5 }], ['r1'], 0.7).escalate, false);
  });
});
