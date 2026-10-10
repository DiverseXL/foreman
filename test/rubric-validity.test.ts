import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRubric,
  scanTestNames,
  validateRubricEvidence,
  type RubricCriterion,
  type CallModel,
} from '../src/mandate/rubric.js';
import { readFacts } from '../src/state/facts.js';
import type { Mandate } from '../src/mandate/load.js';
import { RubricError } from '../src/mandate/rubric.js';

const ISSUE: Mandate = {
  issueId: '9',
  title: 'Rounding bug',
  summary: 'the discounted total must round half up',
  acceptanceCriteria: ['return 4.2'],
  hintedPaths: ['src/x.ts'],
  hintedSymbols: ['roundX'],
  sourcePath: 'no-such-issue-9.md',
};

const VALIDITY = { knownTestNames: ['repro-issue-9', 'other test'], knownSymbols: ['roundX', 'roundY'] };

const CRITERIA = (r2Value: string, r2Kind: 'symbol' | 'test' = 'symbol'): RubricCriterion[] => [
  { id: 'r1', text: 'repro test passes', check: 'test', evidence_ref: { kind: 'test', value: 'repro-issue-9' } },
  { id: 'r2', text: 'uses the helper', check: 'diff', evidence_ref: { kind: r2Kind, value: r2Value } },
  { id: 'r3', text: 'rounds half up', check: 'behavior', evidence_ref: { kind: 'issue_text', value: 'round half up' } },
];

function fakeModel(responses: RubricCriterion[][]): { call: CallModel; calls: () => number } {
  let n = 0;
  const call: CallModel = async () => {
    const criteria = responses[Math.min(n, responses.length - 1)];
    n++;
    return { text: JSON.stringify({ criteria }), model: 'fake', task: 'validate' };
  };
  return { call, calls: () => n };
}

describe('validateRubricEvidence (pure)', () => {
  it('accepts valid test, symbol and issue_text refs', () => {
    const result = validateRubricEvidence(CRITERIA('roundY'), 'the discounted total must round half up', VALIDITY);
    assert.equal(result.invalid.length, 0);
    assert.equal(result.valid.length, 3);
  });

  it('flags a test name that is not in the test files', () => {
    const result = validateRubricEvidence(CRITERIA('nope', 'test'), 'the discounted total must round half up', VALIDITY);
    assert.equal(result.invalid.length, 1);
    assert.equal(result.invalid[0].id, 'r2');
  });

  it('flags a symbol that is not in context', () => {
    const result = validateRubricEvidence(CRITERIA('MISSING'), 'the discounted total must round half up', VALIDITY);
    assert.equal(result.invalid.length, 1);
    assert.match(result.invalid[0].reason, /not in context.json/);
  });

  it('flags an issue_text value that is not a normalized substring', () => {
    const bad: RubricCriterion[] = [
      { id: 'r1', text: 'a', check: 'diff', evidence_ref: { kind: 'issue_text', value: 'not in the issue' } },
    ];
    const result = validateRubricEvidence(bad, 'the discounted total must round half up', VALIDITY);
    assert.equal(result.invalid.length, 1);
  });
});

describe('scanTestNames (static)', () => {
  it('finds test and it declarations in test files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-tests-'));
    try {
      fs.mkdirSync(path.join(dir, 'test'));
      fs.writeFileSync(
        path.join(dir, 'test', 'a.test.ts'),
        "import { test, it } from 'node:test';\ntest('repro-issue-1', () => {});\nit(\"another one\", () => {});\n"
      );
      const names = scanTestNames(dir);
      assert.ok(names.includes('repro-issue-1'));
      assert.ok(names.includes('another one'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildRubric evidence handling', () => {
  it('regenerates once when evidence is invalid, then accepts', async () => {
    const messagesSeen: string[] = [];
    const responses = [CRITERIA('BAD'), CRITERIA('roundY')];
    let callCount = 0;
    const call: CallModel = async (messages) => {
      messagesSeen.push(String(messages[messages.length - 1]?.content ?? ''));
      const criteria = responses[Math.min(callCount, responses.length - 1)];
      callCount++;
      return { text: JSON.stringify({ criteria }), model: 'fake', task: 'validate' };
    };
    const runId = `rubric-ok-${Date.now()}`;
    try {
      const result = await buildRubric(ISSUE, runId, { validity: VALIDITY, callModel: call });
      assert.equal(callCount, 2);
      assert.equal(result.dropped.length, 0);
      assert.equal(result.criteria.length, 3);
      assert.match(messagesSeen[1], /criterion=.*"id":"r2".*"value":"BAD"/);
      assert.match(messagesSeen[1], /evidence_ref symbol "BAD" is not in context\.json/);
    } finally {
      fs.rmSync(path.join('runs', runId), { recursive: true, force: true });
    }
  });

  it('drops only the invalid criteria after the second failure', async () => {
    const model = fakeModel([CRITERIA('BAD'), CRITERIA('BAD')]);
    const runId = `rubric-drop-${Date.now()}`;
    try {
      const result = await buildRubric(ISSUE, runId, { validity: VALIDITY, callModel: model.call });
      assert.equal(result.dropped.length, 1);
      assert.equal(result.dropped[0].id, 'r2');
      assert.deepEqual(
        result.criteria.map((c) => c.id),
        ['r1', 'r3']
      );
      const facts = readFacts(runId);
      assert.ok(facts.some((f) => f.type === 'criteria_dropped'));
    } finally {
      fs.rmSync(path.join('runs', runId), { recursive: true, force: true });
    }
  });

  it('needs_human when fewer than 2 valid criteria remain', async () => {
    const twoBad: RubricCriterion[] = [
      { id: 'r1', text: 'a', check: 'test', evidence_ref: { kind: 'test', value: 'missing-test' } },
      { id: 'r2', text: 'b', check: 'diff', evidence_ref: { kind: 'symbol', value: 'MISSING' } },
      { id: 'r3', text: 'c', check: 'behavior', evidence_ref: { kind: 'issue_text', value: 'round half up' } },
    ];
    const model = fakeModel([twoBad, twoBad]);
    const runId = `rubric-bad-${Date.now()}`;
    try {
      await assert.rejects(
        () => buildRubric(ISSUE, runId, { validity: VALIDITY, callModel: model.call }),
        (err: unknown) => err instanceof RubricError && /rubric_invalid/.test((err as Error).message)
      );
      const facts = readFacts(runId);
      assert.ok(facts.some((f) => f.type === 'needs_human' && /rubric_invalid/.test(f.reason)));
    } finally {
      fs.rmSync(path.join('runs', runId), { recursive: true, force: true });
    }
  });
});
