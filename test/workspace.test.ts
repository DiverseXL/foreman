import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkspace, resetToBase } from '../src/run/workspace.js';

/**
 * Regression guard: the isolated run copy must be pinned to LF. On a host with
 * core.autocrlf=true, `git reset --hard` used to materialise CRLF, which made the
 * model's LF multi-line search strings fail to apply on attempts 2+.
 */
describe('run workspace line endings', () => {
  it('keeps src files LF across a reset to the base commit', () => {
    const runId = `test-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ws = createWorkspace(runId, 1);
    try {
      const file = path.join(ws.path, 'src', 'shipping.ts');
      assert.equal(fs.readFileSync(file).includes(Buffer.from('\r\n')), false, 'baseline copy should be LF');
      resetToBase(ws.path, ws.baseCommit);
      assert.equal(
        fs.readFileSync(file).includes(Buffer.from('\r\n')),
        false,
        'after reset to base the file should still be LF'
      );
    } finally {
      // Remove the node_modules junction first; deleting a directory that still
      // contains a junction can fail with EPERM on Windows.
      try {
        fs.rmSync(path.join('runs', runId, 'repo', 'node_modules'), { force: true });
      } catch {
        // ignore
      }
      try {
        fs.rmSync(path.join('runs', runId), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // best-effort cleanup; runs/ is gitignored
      }
    }
  });
});
