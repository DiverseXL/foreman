import { spawnSync } from 'node:child_process';
import type { Mandate } from '../mandate/load.js';

export interface ContextFinding {
  symbol: string;
  kind: string;
  file: string;
  evidence: string;
}

export interface IndexSummary {
  files: number;
  parsedFiles: number;
  symbols: number;
  relations: number;
  completeness: string;
}

export interface ContextBundle {
  queriesRun: string[];
  findings: ContextFinding[];
  notes: string;
  indexSummary?: IndexSummary;
}

function runEntireGraphCommand(args: string[]): { success: boolean; data?: any; error?: string } {
  const result = spawnSync('entire', ['graph', ...args], {
    encoding: 'utf-8',
    timeout: 30000,
  });

  if (result.error) {
    return { success: false, error: result.error.message };
  }

  const stdout = result.stdout ? result.stdout.trim() : '';
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    return { success: false, error: stderr || `Exit code ${result.status}` };
  }

  try {
    const data = JSON.parse(stdout);
    return { success: true, data };
  } catch {
    return { success: true, data: stdout };
  }
}

/**
 * Gathers structural code context from the target workspace using Entire graph
 * commands (index, def, impact, search).
 *
 * Re-indexes the copy to warm committed-tree relations and parses machine-readable
 * NDJSON/JSON outputs without model calls.
 */
export function buildContext(repoPath: string, mandate: Mandate): ContextBundle {
  const queriesRun: string[] = [];
  const findings: ContextFinding[] = [];
  const notesList: string[] = [];
  let indexSummary: IndexSummary | undefined;

  // 1. Re-index run copy to build/warm graph relations
  const indexRes = runEntireGraphCommand(['index', '--repo', repoPath, '--format', 'json']);
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
    // Structural declaration lookup
    const defQuery = `def ${symbol}`;
    queriesRun.push(defQuery);
    const defRes = runEntireGraphCommand(['def', symbol, '--repo', repoPath, '--format', 'json']);
    if (defRes.success && defRes.data?.declarations) {
      for (const decl of defRes.data.declarations) {
        findings.push({
          symbol: decl.name,
          kind: decl.kind || 'declaration',
          file: decl.file_path,
          evidence: decl.signature || `${decl.file_path}:${decl.start_line}-${decl.end_line}`,
        });
      }
    }

    // Blast radius and caller/callee traversal
    const impactQuery = `impact ${symbol}`;
    queriesRun.push(impactQuery);
    const impactRes = runEntireGraphCommand([
      'impact',
      '--symbol',
      symbol,
      '--repo',
      repoPath,
      '--format',
      'json',
    ]);
    if (impactRes.success && impactRes.data) {
      const data = impactRes.data;
      if (data.callers?.entries) {
        for (const caller of data.callers.entries) {
          if (caller.endpoint) {
            findings.push({
              symbol: caller.endpoint.name,
              kind: caller.endpoint.kind || 'caller',
              file: caller.endpoint.file_path,
              evidence: `Caller (${caller.relation}) at ${caller.call_site?.file_path || caller.endpoint.file_path}:${caller.call_site?.line || caller.endpoint.start_line || ''}`,
            });
          }
        }
      }
      if (data.callees?.entries) {
        for (const callee of data.callees.entries) {
          if (callee.endpoint) {
            findings.push({
              symbol: callee.endpoint.name,
              kind: callee.endpoint.kind || 'callee',
              file: callee.endpoint.file_path,
              evidence: `Callee (${callee.relation})`,
            });
          }
        }
      }
    }

    // Graph search query
    const searchQuery = `search ${symbol}`;
    queriesRun.push(searchQuery);
    const searchRes = runEntireGraphCommand([
      'search',
      '--repo',
      repoPath,
      '--query',
      symbol,
      '--format',
      'json',
    ]);
    if (searchRes.success && searchRes.data?.candidates) {
      for (const cand of searchRes.data.candidates.slice(0, 5)) {
        findings.push({
          symbol: cand.symbol_name || cand.qualified_name || symbol,
          kind: cand.kind || 'code_search',
          file: cand.file_path,
          evidence: (cand.snippet || `${cand.file_path}:${cand.start_line}`).slice(0, 150).trim(),
        });
      }
    }
  }

  // 3. Fallback query if no symbols were hinted
  if (mandate.hintedSymbols.length === 0) {
    const derivedQuery = mandate.title || 'cart';
    const searchQuery = `search ${derivedQuery}`;
    queriesRun.push(searchQuery);
    const searchRes = runEntireGraphCommand([
      'search',
      '--repo',
      repoPath,
      '--query',
      derivedQuery,
      '--format',
      'json',
    ]);
    if (searchRes.success && searchRes.data?.candidates) {
      for (const cand of searchRes.data.candidates.slice(0, 5)) {
        findings.push({
          symbol: cand.symbol_name || cand.qualified_name || 'candidate',
          kind: cand.kind || 'code_search',
          file: cand.file_path,
          evidence: (cand.snippet || `${cand.file_path}:${cand.start_line}`).slice(0, 150).trim(),
        });
      }
    }
  }

  // 4. Query hinted paths if present
  for (const p of mandate.hintedPaths) {
    const pathQuery = `search ${p}`;
    queriesRun.push(pathQuery);
    const pathRes = runEntireGraphCommand(['search', '--repo', repoPath, '--query', p, '--format', 'json']);
    if (pathRes.success && pathRes.data?.candidates) {
      for (const cand of pathRes.data.candidates.slice(0, 3)) {
        findings.push({
          symbol: cand.symbol_name || cand.qualified_name || p,
          kind: cand.kind || 'path_search',
          file: cand.file_path,
          evidence: (cand.snippet || `${cand.file_path}:${cand.start_line}`).slice(0, 150).trim(),
        });
      }
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

  notesList.push(
    `Context gathered via Entire graph: executed ${queriesRun.length} queries, extracted ${uniqueFindings.length} findings.`
  );

  return {
    queriesRun,
    findings: uniqueFindings,
    notes: notesList.join(' '),
    indexSummary,
  };
}
