import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRubricPayload } from '../src/mandate/rubric.js';
import { validateEditsPayload } from '../src/patch/propose.js';
import { extractJson } from '../src/schema/validate.js';

describe('validateRubricPayload', () => {
  it('accepts a valid rubric with 3 to 6 criteria', () => {
    const raw = {
      criteria: [
        { id: 'r1', text: 'repro-issue-1 passes', check: 'test' },
        { id: 'r2', text: 'boundary uses >= 10', check: 'diff' },
        { id: 'r3', text: 'quantity 20 still gets 20 percent', check: 'behavior' },
      ],
    };
    const result = validateRubricPayload(raw);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.criteria.length, 3);
  });

  it('rejects a rubric with fewer than 3 criteria', () => {
    const raw = {
      criteria: [
        { id: 'r1', text: 'only one', check: 'test' },
        { id: 'r2', text: 'only two', check: 'diff' },
      ],
    };
    const result = validateRubricPayload(raw);
    assert.equal(result.ok, false);
  });

  it('rejects an unknown check value', () => {
    const raw = {
      criteria: [
        { id: 'r1', text: 'a', check: 'test' },
        { id: 'r2', text: 'b', check: 'diff' },
        { id: 'r3', text: 'c', check: 'vibes' },
      ],
    };
    const result = validateRubricPayload(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.includes('check')));
  });

  it('rejects unexpected properties and duplicate ids', () => {
    const extra = {
      criteria: [
        { id: 'r1', text: 'a', check: 'test', extra: 1 },
        { id: 'r2', text: 'b', check: 'diff' },
        { id: 'r3', text: 'c', check: 'behavior' },
      ],
    };
    assert.equal(validateRubricPayload(extra).ok, false);

    const dupes = {
      criteria: [
        { id: 'r1', text: 'a', check: 'test' },
        { id: 'r1', text: 'b', check: 'diff' },
        { id: 'r3', text: 'c', check: 'behavior' },
      ],
    };
    assert.equal(validateRubricPayload(dupes).ok, false);
  });
});

describe('validateEditsPayload', () => {
  it('accepts a valid edit list', () => {
    const raw = { edits: [{ file: 'src/discount.ts', search: 'quantity > 10', replace: 'quantity >= 10' }] };
    const result = validateEditsPayload(raw);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.edits.length, 1);
  });

  it('rejects a missing required field', () => {
    const raw = { edits: [{ file: 'src/discount.ts', search: 'x' }] };
    assert.equal(validateEditsPayload(raw).ok, false);
  });

  it('rejects a unified diff smuggled into search or replace', () => {
    const raw = {
      edits: [
        {
          file: 'src/discount.ts',
          search: 'quantity > 10',
          replace: '@@ -1,3 +1,3 @@\n-old\n+new',
        },
      ],
    };
    const result = validateEditsPayload(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.includes('unified diffs')));
  });

  it('rejects path traversal and no-op edits', () => {
    assert.equal(
      validateEditsPayload({ edits: [{ file: '../x.ts', search: 'a', replace: 'b' }] }).ok,
      false
    );
    assert.equal(
      validateEditsPayload({ edits: [{ file: 'src/a.ts', search: 'same', replace: 'same' }] }).ok,
      false
    );
  });
});

describe('extractJson', () => {
  it('parses bare JSON, fenced JSON, and JSON surrounded by prose', () => {
    assert.deepEqual(extractJson('{"ok":true}'), { ok: true });
    assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true });
    assert.deepEqual(extractJson('Sure, here it is: {"ok":true} done'), { ok: true });
    assert.equal(extractJson('not json at all'), null);
  });
});
