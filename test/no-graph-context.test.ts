import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNoGraphContext } from '../src/context/graph.js';
import type { Mandate } from '../src/mandate/load.js';
import { buildSourceBundle } from '../src/patch/propose.js';

describe('no-graph context', () => {
  it('loads complete hinted files without graph findings or symbol facts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-no-graph-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'feature.ts'), 'export const answer = 42;\n', 'utf-8');
      const mandate: Mandate = {
        issueId: '1',
        title: 'test',
        summary: '',
        acceptanceCriteria: [],
        hintedPaths: ['src/feature.ts'],
        hintedSymbols: ['answer'],
        sourcePath: 'issue.md',
      };
      const result = buildNoGraphContext(root, mandate);
      assert.deepEqual(result.rawCommands, []);
      assert.deepEqual(result.bundle.findings, []);
      assert.deepEqual(result.bundle.symbolFacts, []);
      assert.equal(result.bundle.hintedFiles?.[0].content, 'export const answer = 42;\n');
      assert.deepEqual(buildSourceBundle(result.bundle, root), [
        { file: 'src/feature.ts', startLine: 1, endLine: 2, content: 'export const answer = 42;\n' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
