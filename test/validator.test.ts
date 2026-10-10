import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateValidatorPayload,
  computeAllCriteriaPass,
  type ValidatorCriterion,
} from '../src/validator/index.js';

describe('validator payload enforcement (pure)', () => {
  const ids = ['r1', 'r2'];

  it('accepts a payload whose ids match the rubric exactly', () => {
    const result = validateValidatorPayload(
      {
        criteria: [
          { id: 'r1', verdict: 'pass', confidence: 0.9, reason: 'ok' },
          { id: 'r2', verdict: 'fail', confidence: 0.8, reason: 'missing guard' },
        ],
      },
      ids
    );
    assert.equal(result.ok, true);
  });

  it('rejects a missing rubric id', () => {
    const result = validateValidatorPayload(
      { criteria: [{ id: 'r1', verdict: 'pass', confidence: 0.9, reason: 'ok' }] },
      ids
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(';'), /missing verdict for rubric id "r2"/);
  });

  it('rejects an extra id not in the rubric', () => {
    const result = validateValidatorPayload(
      {
        criteria: [
          { id: 'r1', verdict: 'pass', confidence: 0.9, reason: 'ok' },
          { id: 'r2', verdict: 'pass', confidence: 0.9, reason: 'ok' },
          { id: 'r3', verdict: 'pass', confidence: 0.9, reason: 'ok' },
        ],
      },
      ids
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(';'), /"r3" is not in the rubric/);
  });

  it('rejects confidence outside [0, 1]', () => {
    const result = validateValidatorPayload(
      {
        criteria: [
          { id: 'r1', verdict: 'pass', confidence: 1.5, reason: 'ok' },
          { id: 'r2', verdict: 'pass', confidence: 0.9, reason: 'ok' },
        ],
      },
      ids
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(';'), /confidence: must be between 0 and 1/);
  });

  it('rejects an "unclear" verdict with empty missing_evidence', () => {
    const result = validateValidatorPayload(
      { criteria: [{ id: 'r1', verdict: 'unclear', confidence: 0.5, reason: 'cannot tell', missing_evidence: '   ' }] },
      ['r1']
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(';'), /missing_evidence: must be non-empty/);
  });

  it('accepts an "unclear" verdict with non-empty missing_evidence', () => {
    const result = validateValidatorPayload(
      {
        criteria: [
          { id: 'r1', verdict: 'unclear', confidence: 0.5, reason: 'cannot tell', missing_evidence: 'need the caller source' },
        ],
      },
      ['r1']
    );
    assert.equal(result.ok, true);
  });

  it('truncates reasons to 200 characters', () => {
    const longReason = 'x'.repeat(260);
    const result = validateValidatorPayload(
      {
        criteria: [
          { id: 'r1', verdict: 'pass', confidence: 0.9, reason: longReason },
          { id: 'r2', verdict: 'pass', confidence: 0.9, reason: 'ok' },
        ],
      },
      ids
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.criteria[0].reason.length, 200);
  });
});

describe('allCriteriaPass is computed in code with a confidence floor', () => {
  const criteria = (confidence: number): ValidatorCriterion[] => [
    { id: 'r1', verdict: 'pass', confidence, reason: 'ok', missing_evidence: '' },
  ];

  it('does not pass when a criterion is "unclear" even at high confidence', () => {
    assert.equal(
      computeAllCriteriaPass(
        [{ id: 'r1', verdict: 'unclear', confidence: 0.99, reason: 'cannot tell', missing_evidence: 'x' }],
        ['r1'],
        0.7
      ),
      false
    );
  });

  it('passes when every criterion is pass at or above the floor', () => {
    assert.equal(computeAllCriteriaPass(criteria(0.7), ['r1'], 0.7), true);
  });

  it('does not pass when a pass verdict is below the confidence floor', () => {
    assert.equal(computeAllCriteriaPass(criteria(0.69), ['r1'], 0.7), false);
  });


});
