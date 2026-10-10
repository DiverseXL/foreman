import fs from 'node:fs';
import path from 'node:path';

export interface Mandate {
  issueId: string;
  title: string;
  summary: string;
  acceptanceCriteria: string[];
  hintedPaths: string[];
  hintedSymbols: string[];
  sourcePath: string;
}

/**
 * Reads issues/issue-<n>.md from the Foreman repository root and parses it
 * into a structured Mandate object using deterministic markdown parsing.
 *
 * Rules:
 * - title: parsed from primary level 1 heading (# Issue <n>: <Title>)
 * - summary: parsed from ## Summary section
 * - acceptanceCriteria: parsed from ## Expected Behavior bullets or lines
 * - hintedPaths: parsed from file path patterns (e.g. src/*.ts)
 * - hintedSymbols: parsed from code-quoted identifiers / function invocations
 * - missing fields: assigned empty array or empty string, never left undefined
 */
export function loadMandate(issueId: string | number, issuesDir = 'issues'): Mandate {
  const normalizedId = String(issueId).replace(/^issue-/, '');
  const fileName = `issue-${normalizedId}.md`;
  const filePath = path.resolve(issuesDir, fileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Issue specification file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  // 1. Title extraction
  const titleMatch = content.match(/^#\s+(?:Issue\s+\d+:\s*)?(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // 2. Summary extraction
  const summaryMatch = content.match(/##\s+Summary\s*([\s\S]*?)(?=\n##\s+|$)/);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  // 3. Acceptance criteria from ## Expected Behavior
  const expectedMatch = content.match(/##\s+Expected Behavior\s*([\s\S]*?)(?=\n##\s+|$)/);
  const acceptanceCriteria: string[] = [];
  if (expectedMatch) {
    const rawLines = expectedMatch[1]
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const bullets = rawLines
      .filter((l) => l.startsWith('- ') || l.startsWith('* '))
      .map((l) => l.slice(2).trim());
    if (bullets.length > 0) {
      acceptanceCriteria.push(...bullets);
    } else {
      acceptanceCriteria.push(...rawLines);
    }
  }

  // 4. Hinted paths: explicit file paths ending in .ts
  const backticks = [...content.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const directPathMatches = content.match(/(?:src|test)\/[\w.-]+\.ts/g) || [];
  const hintedPaths = Array.from(
    new Set([
      ...directPathMatches,
      ...backticks.filter((b) => b.endsWith('.ts') || b.includes('/')),
    ])
  );

  // 5. Hinted symbols: backticked function identifiers or camelCase tokens
  const symbolCandidates = backticks
    .map((b) => {
      const fnMatch = b.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\(.*\))?$/);
      return fnMatch ? fnMatch[1] : null;
    })
    .filter((s): s is string => {
      if (!s) return false;
      // Filter out language built-ins and numeric/type tokens
      if (['Math', 'number', 'string', 'boolean', 'decimal', 'bignumber'].includes(s)) return false;
      return /^[a-z]+[A-Z]/.test(s) || /^[A-Z][a-zA-Z0-9_]+$/.test(s);
    });

  const hintedSymbols = Array.from(new Set(symbolCandidates));

  return {
    issueId: normalizedId,
    title,
    summary,
    acceptanceCriteria,
    hintedPaths,
    hintedSymbols,
    sourcePath: filePath,
  };
}
