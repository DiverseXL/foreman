import { execSync, spawnSync } from 'node:child_process';
import type { ChangedFile, ChangedSymbol } from './types.js';

export interface ChangeSummary {
  changedFiles: ChangedFile[];
  changedSymbols: ChangedSymbol[];
  addedLines: string[];
  /** Which method supplied changedSymbols. */
  method: 'entire_graph_diff' | 'line_span_fallback';
  /** Extra context (e.g. why the fallback was used). */
  note: string;
}

interface UnifiedParse {
  addedLines: string[];
  changedLinesByFile: Map<string, number[]>;
}

/** Parses a unified diff for added lines and the new-side line numbers of changes. */
export function parseUnifiedDiff(unified: string): UnifiedParse {
  const addedLines: string[] = [];
  const changedLinesByFile = new Map<string, number[]>();
  let currentFile: string | null = null;
  let newLine = 0;

  for (const line of unified.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      currentFile = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    if (currentFile === null) continue;
    if (line.startsWith('+')) {
      addedLines.push(line.slice(1));
      const list = changedLinesByFile.get(currentFile) ?? [];
      list.push(newLine);
      changedLinesByFile.set(currentFile, list);
      newLine++;
    } else if (line.startsWith('-')) {
      // removed line: absent from the new file
    } else if (line.startsWith(' ') || line === '') {
      newLine++;
    }
  }

  return { addedLines, changedLinesByFile };
}

function parseChangedFiles(repoPath: string, base: string, attempt: string): ChangedFile[] {
  const nameStatus = execSync(`git diff --name-status ${base} ${attempt}`, { cwd: repoPath, encoding: 'utf-8' });
  const numstat = execSync(`git diff --numstat ${base} ${attempt}`, { cwd: repoPath, encoding: 'utf-8' });

  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [addedRaw, removedRaw, ...pathParts] = line.split('\t');
    const file = pathParts.join('\t');
    const added = addedRaw === '-' ? 0 : parseInt(addedRaw, 10) || 0;
    const removed = removedRaw === '-' ? 0 : parseInt(removedRaw, 10) || 0;
    counts.set(file, { added, removed });
  }

  const files: ChangedFile[] = [];
  for (const line of nameStatus.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [statusRaw, ...pathParts] = line.split('\t');
    const file = pathParts[pathParts.length - 1];
    const status = statusRaw.charAt(0);
    const c = counts.get(file) ?? { added: 0, removed: 0 };
    files.push({ path: file, status, added: c.added, removed: c.removed });
  }
  return files;
}

function symbolsFromGraphDiff(repoPath: string, base: string, attempt: string): ChangedSymbol[] | null {
  const res = spawnSync(
    'entire',
    ['graph', 'diff', '--repo', repoPath, '--base', base, '--head', attempt, '--json'],
    { encoding: 'utf-8', timeout: 60000 }
  );
  if (res.status !== 0 || !res.stdout) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.files)) return null;

  const symbols: ChangedSymbol[] = [];
  const seen = new Set<string>();
  for (const file of parsed.files) {
    for (const change of file.changes ?? []) {
      if (!change?.name) continue;
      const key = `${change.name}|${change.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name: change.name, kind: change.kind ?? 'unknown', file: file.path });
    }
  }
  return symbols;
}

function symbolsFromLineSpans(
  repoPath: string,
  changedFiles: ChangedFile[],
  changedLinesByFile: Map<string, number[]>
): ChangedSymbol[] {
  const res = spawnSync('entire', ['graph', 'symbols', '--repo', repoPath, '--format', 'ndjson'], {
    encoding: 'utf-8',
    timeout: 60000,
  });
  if (res.status !== 0 || !res.stdout) return [];

  const changedPaths = new Set(changedFiles.map((f) => f.path));
  const symbols: ChangedSymbol[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.record_type !== 'symbol') continue;
    if (!changedPaths.has(record.file_path)) continue;
    const lines = changedLinesByFile.get(record.file_path) ?? [];
    const hit = lines.some((n) => n >= record.start_line && n <= record.end_line);
    if (hit) symbols.push({ name: record.name, kind: record.kind ?? 'unknown', file: record.file_path });
  }
  return symbols;
}

/**
 * Collects the change set between two commits in the run copy.
 * Primary: `entire graph diff --base <base> --head <attempt> --json`.
 * Fallback: map changed line numbers onto symbol spans from `entire graph symbols`.
 * The method actually used is reported in `method` and `note`.
 */
export function collectChanges(repoPath: string, baseCommit: string, attemptCommit: string): ChangeSummary {
  const unified = execSync(`git diff ${baseCommit} ${attemptCommit}`, { cwd: repoPath, encoding: 'utf-8' });
  const { addedLines, changedLinesByFile } = parseUnifiedDiff(unified);
  const changedFiles = parseChangedFiles(repoPath, baseCommit, attemptCommit);

  const viaDiff = symbolsFromGraphDiff(repoPath, baseCommit, attemptCommit);
  if (viaDiff) {
    return {
      changedFiles,
      changedSymbols: viaDiff,
      addedLines,
      method: 'entire_graph_diff',
      note: 'changed symbols from entire graph diff --json',
    };
  }

  const viaSpans = symbolsFromLineSpans(repoPath, changedFiles, changedLinesByFile);
  return {
    changedFiles,
    changedSymbols: viaSpans,
    addedLines,
    method: 'line_span_fallback',
    note: 'entire graph diff did not supply symbols; mapped changed line numbers onto symbol spans from entire graph symbols',
  };
}

/** Caller count (direct + transitive) for one symbol, or null if unresolvable. */
export function callerCountFor(repoPath: string, symbol: string): number | null {
  const res = spawnSync(
    'entire',
    ['graph', 'impact', '--symbol', symbol, '--repo', repoPath, '--format', 'json'],
    { encoding: 'utf-8', timeout: 60000 }
  );
  if (res.status !== 0 || !res.stdout) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    const total = parsed?.callers?.total;
    return typeof total === 'number' ? total : null;
  } catch {
    return null;
  }
}
