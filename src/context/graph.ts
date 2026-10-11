import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Mandate } from '../mandate/load.js';

export interface ContextFinding {
  symbol: string;
  kind: string;
  file: string;
  evidence: string;
  startLine?: number;
  endLine?: number;
  callSiteFile?: string;
  callSiteLine?: number;
}

export interface IndexSummary {
  files: number;
  parsedFiles: number;
  symbols: number;
  relations: number;
  completeness: string;
}

/** Per-symbol caller/callee counts derived from `entire graph impact`. */
export interface SymbolFact {
  symbol: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  callerCount: number;
  calleeCount: number;
}

/** Raw JSON output of one `entire graph` invocation, persisted under graph-raw/. */
export interface RawGraphCommand {
  args: string[];
  stdout: string;
}

export interface ContextBundle {
  queriesRun: string[];
  findings: ContextFinding[];
  symbolFacts: SymbolFact[];
  hintedFiles?: { path: string; content: string }[];
  notes: string;
  indexSummary?: IndexSummary;
}

export interface ContextResult {
  bundle: ContextBundle;
  rawCommands: RawGraphCommand[];
}

interface GraphCommandResult {
  success: boolean;
  data?: any;
  raw: string;
  error?: string;
}

function runEntireGraphCommand(args: string[]): GraphCommandResult {
  const result = spawnSync('entire', ['graph', ...args], {
    encoding: 'utf-8',
    timeout: 30000,
  });

  const raw = result.stdout ? result.stdout.trim() : '';

  if (result.error) {
    return { success: false, raw, error: result.error.message };
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    return { success: false, raw, error: stderr || `Exit code ${result.status}` };
  }

  try {
    return { success: true, data: JSON.parse(raw), raw };
  } catch {
    return { success: true, data: raw, raw };
  }
}

/**
 * Gathers structural code context from the target workspace using Entire graph
 * commands (index, def, impact, search). Re-indexes the copy to warm committed-tree
 * relations, parses machine-readable JSON, and retains the raw output of every
 * command so it can be persisted under graph-raw/.
 */
export function buildContext(repoPath: string, mandate: Mandate): ContextResult {
  const queriesRun: string[] = [];
  const findings: ContextFinding[] = [];
  const symbolFacts: SymbolFact[] = [];
  const rawCommands: RawGraphCommand[] = [];
  const notesList: string[] = [];
  let indexSummary: IndexSummary | undefined;

  const run = (args: string[]): GraphCommandResult => {
    const res = runEntireGraphCommand(args);
    rawCommands.push({ args, stdout: res.raw });
    return res;
  };

  // 1. Re-index run copy to build/warm graph relations
  const indexRes = run(['index', '--repo', repoPath, '--format', 'json']);
  if (indexRes.success && indexRes.data && typeof indexRes.data === 'object') {
    const counts = indexRes.data.counts;
    if (counts) {
      indexSummary = {
        files: counts.files ?? 0,
        parsedFiles: counts.parsed_files ?? 0,
        symbols: counts.symbols ?? 0,
        relations: counts.relations ?? 0,
        completeness: counts.completeness_level ?? 'unknown',
      };
      notesList.push(
        `Indexed run workspace: ${indexSummary.files} files, ${indexSummary.symbols} symbols, ${indexSummary.relations} relations (completeness: ${indexSummary.completeness}).`
      );
    }

  } else {
    notesList.push(`Index status: ${indexRes.error || 'non-json output'}`);
  }

  // 2. Query definitions, impact, and search for hinted symbols
  for (const symbol of mandate.hintedSymbols) {
    const defRes = run(['def', symbol, '--repo', repoPath, '--format', 'json']);
    queriesRun.push(`def ${symbol}`);
    const declarations: any[] = defRes.success && Array.isArray(defRes.data?.declarations) ? defRes.data.declarations : [];
    for (const decl of declarations) {
      findings.push({
        symbol: decl.name,
        kind: decl.kind || 'declaration',
        file: decl.file_path,
        evidence: decl.signature || `${decl.file_path}:${decl.start_line}-${decl.end_line}`,
        startLine: decl.start_line,
        endLine: decl.end_line,
      });
    }

    const impactRes = run(['impact', '--symbol', symbol, '--repo', repoPath, '--format', 'json']);
    queriesRun.push(`impact ${symbol}`);
    if (impactRes.success && impactRes.data) {
      const data = impactRes.data;
      const callers: any[] = data.callers?.entries ?? [];
      const callees: any[] = data.callees?.entries ?? [];

      for (const decl of declarations) {
        symbolFacts.push({
          symbol: decl.name,
          file: decl.file_path,
          startLine: decl.start_line,
          endLine: decl.end_line,
          callerCount: data.callers?.total ?? callers.length,
          calleeCount: data.callees?.total ?? callees.length,
        });
      }

      for (const caller of callers) {
        if (!caller.endpoint) continue;
        findings.push({
          symbol: caller.endpoint.name,
          kind: caller.endpoint.kind || 'caller',
          file: caller.endpoint.file_path,
          evidence: `Caller (${caller.relation}) at ${caller.call_site?.file_path || caller.endpoint.file_path}:${caller.call_site?.line || caller.endpoint.start_line || ''}`,
          callSiteFile: caller.call_site?.file_path,
          callSiteLine: caller.call_site?.line,
        });
      }
      for (const callee of callees) {
        if (!callee.endpoint) continue;
        findings.push({
          symbol: callee.endpoint.name,
          kind: callee.endpoint.kind || 'callee',
          file: callee.endpoint.file_path,
          evidence: `Callee (${callee.relation})`,
          startLine: callee.endpoint.start_line,
          endLine: callee.endpoint.end_line,
        });
      }
    }

    const searchRes = run(['search', '--repo', repoPath, '--query', symbol, '--format', 'json']);
    queriesRun.push(`search ${symbol}`);
    const results: any[] = searchRes.success && Array.isArray(searchRes.data?.results) ? searchRes.data.results : [];
    for (const cand of results.slice(0, 5)) {
      findings.push({
        symbol: cand.symbol_name || cand.qualified_name || symbol,
        kind: cand.kind || 'code_search',
        file: cand.file_path,
        evidence: (cand.snippet || `${cand.file_path}:${cand.start_line}`).slice(0, 150).trim(),
        startLine: cand.symbol_start_line ?? cand.start_line,
        endLine: cand.symbol_end_line ?? cand.end_line,
      });
    }
  }

  // 3. Fallback query if no symbols were hinted
  if (mandate.hintedSymbols.length === 0) {
    const derivedQuery = mandate.title || 'cart';
    const searchRes = run(['search', '--repo', repoPath, '--query', derivedQuery, '--format', 'json']);
    queriesRun.push(`search ${derivedQuery}`);
    const results: any[] = searchRes.success && Array.isArray(searchRes.data?.results) ? searchRes.data.results : [];
    for (const cand of results.slice(0, 5)) {
      findings.push({
        symbol: cand.symbol_name || cand.qualified_name || 'candidate',
        kind: cand.kind || 'code_search',
        file: cand.file_path,
        evidence: (cand.snippet || `${cand.file_path}:${cand.start_line}`).slice(0, 150).trim(),
        startLine: cand.symbol_start_line ?? cand.start_line,
        endLine: cand.symbol_end_line ?? cand.end_line,
      });
    }
  }

  // 4. Query hinted paths if present
  for (const p of mandate.hintedPaths) {
    const pathRes = run(['search', '--repo', repoPath, '--query', p, '--format', 'json']);
    queriesRun.push(`search ${p}`);
    const results: any[] = pathRes.success && Array.isArray(pathRes.data?.results) ? pathRes.data.results : [];
    for (const cand of results.slice(0, 3)) {
      findings.push({
        symbol: cand.symbol_name || cand.qualified_name || p,
        kind: cand.kind || 'path_search',
        file: cand.file_path,
        evidence: (cand.snippet || `${cand.file_path}:${cand.start_line}`).slice(0, 150).trim(),
        startLine: cand.symbol_start_line ?? cand.start_line,
        endLine: cand.symbol_end_line ?? cand.end_line,
      });
    }
  }

  // Deduplicate findings by symbol + file + kind + evidence prefix
  const seen = new Set<string>();
  const uniqueFindings: ContextFinding[] = [];
  for (const f of findings) {
    const key = `${f.symbol}|${f.file}|${f.kind}|${f.evidence.slice(0, 40)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueFindings.push(f);
    }
  }

  // Deduplicate symbol facts by symbol
  const seenSymbols = new Set<string>();
  const uniqueSymbolFacts: SymbolFact[] = [];
  for (const fact of symbolFacts) {
    if (seenSymbols.has(fact.symbol)) continue;
    seenSymbols.add(fact.symbol);
    uniqueSymbolFacts.push(fact);
  }

  notesList.push(
    `Context gathered via Entire graph: executed ${queriesRun.length} queries, extracted ${uniqueFindings.length} findings for ${uniqueSymbolFacts.length} symbols.`
  );

  return {
    bundle: {
      queriesRun,
      findings: uniqueFindings,
      symbolFacts: uniqueSymbolFacts,
      notes: notesList.join(' '),
      indexSummary,
    },
    rawCommands,
  };
}

/** Loads only the complete hinted files; this path deliberately never invokes Entire graph. */
export function buildNoGraphContext(repoPath: string, mandate: Mandate): ContextResult {
  const root = path.resolve(repoPath);
  const hintedFiles = mandate.hintedPaths.map((file) => {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      throw new Error(`No-graph context rejected unsafe hinted path: ${file}`);
    }
    const fullPath = path.resolve(root, file);
    if (!fullPath.startsWith(`${root}${path.sep}`) && fullPath !== root) {
      throw new Error(`No-graph context rejected path outside run copy: ${file}`);
    }
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error(`No-graph context hinted file not found: ${file}`);
    }
    return { path: file, content: fs.readFileSync(fullPath, 'utf-8') };
  });
  return {
    bundle: {
      queriesRun: [],
      findings: [],
      symbolFacts: [],
      hintedFiles,
      notes: `NO GRAPH MODE: full text loaded for ${hintedFiles.length} hinted file(s); no graph findings, callers, or symbol facts.`,
    },
    rawCommands: [],
  };
}
