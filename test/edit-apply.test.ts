import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyEdits } from '../src/patch/propose.js';

const scratch = path.resolve('test-edit-scratch');

function writeFixture(name: string, content: string): void {
  fs.writeFileSync(path.join(scratch, name), content, 'utf-8');
}

describe('applyEdits exact-once rule', () => {
  before(() => {
    if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
  });

  after(() => {
    if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeFixture('single.ts', "export function f(): number {\n  return 1;\n}\n");
    writeFixture('dupe.ts', "const a = 1;\nconst a = 1;\n");
  });

  it('applies an edit whose search occurs exactly once', () => {
    const result = applyEdits(scratch, [
      { file: 'single.ts', search: 'return 1;', replace: 'return 2;' },
    ]);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(scratch, 'single.ts'), 'utf-8').includes('return 2;'), true);
  });

  it('fails when the search string is missing', () => {
    const result = applyEdits(scratch, [
      { file: 'single.ts', search: 'return 999;', replace: 'return 2;' },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /not found/);
      assert.equal(result.file, 'single.ts');
    }
    assert.equal(fs.readFileSync(path.join(scratch, 'single.ts'), 'utf-8').includes('return 1;'), true);
  });

  it('fails when the search string occurs more than once', () => {
    const result = applyEdits(scratch, [
      { file: 'dupe.ts', search: 'const a = 1;', replace: 'const a = 2;' },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /2 times/);
    }
    assert.equal(fs.readFileSync(path.join(scratch, 'dupe.ts'), 'utf-8').includes('const a = 1;'), true);
  });

  it('is all-or-nothing: a later failure leaves earlier files untouched', () => {
    const result = applyEdits(scratch, [
      { file: 'single.ts', search: 'return 1;', replace: 'return 2;' },
      { file: 'dupe.ts', search: 'const a = 1;', replace: 'const a = 2;' },
    ]);
    assert.equal(result.ok, false);
    const single = fs.readFileSync(path.join(scratch, 'single.ts'), 'utf-8');
    assert.equal(single.includes('return 1;'), true);
    assert.equal(single.includes('return 2;'), false);
  });

  it('fails when the file does not exist', () => {
    const result = applyEdits(scratch, [
      { file: 'missing.ts', search: 'x', replace: 'y' },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /file not found/);
  });

  it('fails when the path escapes the repo', () => {
    const result = applyEdits(scratch, [
      { file: '../escape.ts', search: 'x', replace: 'y' },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /escapes repo/);
  });
});
