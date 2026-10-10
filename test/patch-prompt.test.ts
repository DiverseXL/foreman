import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { proposePatch, type ProposeCallModel } from '../src/patch/propose.js';
import type { Mandate } from '../src/mandate/load.js';
import type { RubricResult } from '../src/mandate/rubric.js';

describe('patch proposal prompt', () => {
  it('includes runtime policy paths, read-only repro evidence, and failure memory', async () => {
    let capturedMessages: Parameters<ProposeCallModel>[0] = [];
    const callModel: ProposeCallModel = async (messages) => {
      capturedMessages = messages;
      return {
        text: JSON.stringify({
          edits: [{ file: 'src/example.ts', search: 'const value = 1;', replace: 'const value = 2;' }],
        }),
        model: 'fixed-fixture',
        task: 'patch',
      };
    };
    const issue: Mandate = {
      issueId: '1',
      title: 'Boundary bug',
      summary: 'Fix the boundary behavior.',
      acceptanceCriteria: ['value is 2'],
      hintedPaths: ['src/example.ts'],
      hintedSymbols: ['calculateValue'],
      sourcePath: 'issue-1.md',
    };
    const rubric: RubricResult = {
      criteria: [
        {
          id: 'r1',
          text: 'The changed source handles the boundary.',
          check: 'diff',
          evidence_ref: { kind: 'symbol', value: 'calculateValue' },
        },
      ],
      model: 'fixed-fixture',
      attempts: 1,
      dropped: [],
    };

    await proposePatch(
      {
        issue,
        rubric,
        sources: [{ file: 'src/example.ts', startLine: 1, endLine: 1, content: 'const value = 1;' }],
        memoryText: 'Attempt 1 failed: do not repeat the same boundary check.',
        policy: { allowedPaths: ['src/custom/**'], deniedPaths: ['test/**', 'src/blocked/**'] },
        reproTest: {
          name: 'repro-issue-1',
          file: 'test/repro.test.ts',
          text: "test('repro-issue-1', () => { assert.equal(calculateValue(10), 2); });",
        },
      },
      'fixed-fixture-run',
      callModel
    );

    const systemPrompt = String(capturedMessages[0]?.content ?? '');
    const userPrompt = String(capturedMessages[1]?.content ?? '');
    assert.match(systemPrompt, /never edit, add, move or delete a test file or any other denied path/i);
    assert.match(userPrompt, /ALLOWED paths .*src\/custom\/\*\*/);
    assert.ok(
      userPrompt.includes('- DENIED paths (READ ONLY; this includes every test file): test/**, src/blocked/**')
    );
    assert.match(userPrompt, /READ ONLY EVIDENCE:.*repro-issue-1/);
    assert.match(userPrompt, /assert\.equal\(calculateValue\(10\), 2\)/);
    assert.match(userPrompt, /SOURCE CODE ONLY/);
    assert.match(userPrompt, /Failure memory from previous attempts/);
  });
});
