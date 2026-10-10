import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface WorkspaceOptions {
  fixturesPath?: string;
  runsDir?: string;
}

/**
 * Returns the run copy's diff versus its baseline commit, as a string.
 * Stages tracked+untracked changes first so new files are included. Safe: this
 * only touches the isolated run copy, never the Foreman repository.
 */
export function gitDiff(repoPath: string): string {
  execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });
  return execSync('git diff --cached --no-color --no-ext-diff', {
    cwd: repoPath,
    stdio: 'pipe',
  })
    .toString('utf-8')
    .trim();
}

/** Commits the current run-copy changes as the attempt commit; returns its sha. */
export function commitAttempt(repoPath: string, message: string): string {
  execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: repoPath, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe' }).toString('utf-8').trim();
}

/**
 * Resets the run copy's branch back to the base commit, discarding any previous
 * attempt commit and cleaning the working tree. Used by the supervisor before
 * every attempt so each attempt starts from a known-clean state.
 */
export function resetToBase(repoPath: string, baseCommit: string): void {
  execSync(`git reset --hard ${baseCommit}`, { cwd: repoPath, stdio: 'pipe' });
  execSync('git clean -fd', { cwd: repoPath, stdio: 'pipe' });
}

/** Diff between two commits in the run copy (used for the gate and patch artifacts). */
export function gitDiffRange(repoPath: string, base: string, head: string): string {
  return execSync(`git diff ${base} ${head} --no-color --no-ext-diff`, {
    cwd: repoPath,
    stdio: 'pipe',
  })
    .toString('utf-8')
    .trim();
}

export interface WorkspaceResult {
  baseCommit: string;
  branch: string;
  path: string;
  throwawayIdentity: {
    name: string;
    email: string;
  };
}

/**
 * Creates an isolated run workspace by copying fixtures/sample-repo,
 * initializing a local git repository with a local-only throwaway identity,
 * creating a baseline commit and issue branch, and making tests runnable offline.
 */
export function createWorkspace(
  runId: string,
  issueNumber: number | string,
  options?: WorkspaceOptions
): WorkspaceResult {
  const rootDir = process.cwd();
  const fixturesPath = path.resolve(rootDir, options?.fixturesPath ?? 'fixtures/sample-repo');
  const runsDir = path.resolve(rootDir, options?.runsDir ?? 'runs');
  const repoPath = path.join(runsDir, runId, 'repo');

  if (!fs.existsSync(fixturesPath)) {
    throw new Error(`Fixtures directory not found at: ${fixturesPath}`);
  }

  // Ensure clean target directory
  if (fs.existsSync(repoPath)) {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
  fs.mkdirSync(repoPath, { recursive: true });

  // 1. Copy sample-repo excluding node_modules and existing git metadata
  fs.cpSync(fixturesPath, repoPath, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== 'node_modules' && base !== '.git';
    },
  });

  // 2. Git init and local-only throwaway identity
  // FLAG: This identity is strictly throwaway and local to this specific run repository.
  // It does NOT modify or interact with any global or system Git configurations.
  const throwawayIdentity = {
    name: 'Foreman Bot (Throwaway)',
    email: 'foreman-throwaway@local.test',
  };

  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync(`git config --local user.name "${throwawayIdentity.name}"`, { cwd: repoPath, stdio: 'pipe' });
  execSync(`git config --local user.email "${throwawayIdentity.email}"`, { cwd: repoPath, stdio: 'pipe' });
  // Pin the isolated run copy to LF. The host's global core.autocrlf=true would
  // otherwise materialise CRLF on every `git reset --hard`, so a model's
  // LF newlines in multi-line "search" strings would fail to match.
  execSync('git config --local core.autocrlf false', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config --local core.eol lf', { cwd: repoPath, stdio: 'pipe' });

  // 3. Baseline commit
  execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
  execSync('git commit -m "baseline: initial copy of sample-repo"', { cwd: repoPath, stdio: 'pipe' });

  // 4. Record base commit sha
  const baseCommit = execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe' })
    .toString('utf-8')
    .trim();

  // 5. Create issue branch foreman/issue-<n>
  const branch = `foreman/issue-${issueNumber}`;
  execSync(`git checkout -b ${branch}`, { cwd: repoPath, stdio: 'pipe' });

  // 6. Make tests runnable offline after setup
  // Simplest working method: Directory junction on Windows (or symlink) linking
  // fixtures/sample-repo/node_modules to runs/<runId>/repo/node_modules.
  // This requires zero network calls, zero additional disk copies, and is git-ignored.
  const srcNodeModules = path.join(fixturesPath, 'node_modules');
  const destNodeModules = path.join(repoPath, 'node_modules');

  if (fs.existsSync(srcNodeModules)) {
    try {
      fs.symlinkSync(srcNodeModules, destNodeModules, 'junction');
    } catch {
      // Fallback: direct recursive copy if linking is prohibited
      fs.cpSync(srcNodeModules, destNodeModules, { recursive: true });
    }
  }

  return {
    baseCommit,
    branch,
    path: repoPath,
    throwawayIdentity,
  };
}
