import fs from 'node:fs';
import path from 'node:path';
import { complete, jsonSchemaResponseFormat } from '../model/index.js';
import type { ChatMessage, ModelCallResult } from '../model/types.js';
import { extractJson, pruneSchemaForWire, validateAgainstSchema, type SchemaNode } from '../schema/validate.js';
import type { ContextBundle } from '../context/graph.js';
import type { Mandate } from '../mandate/load.js';
import type { RubricResult } from '../mandate/rubric.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatchEdit {
  file: string;
  search: string;
  replace: string;
}

export interface SourceSnippet {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ProposeResult {
  edits: PatchEdit[];
  model: string;
  usage?: ModelCallResult['usage'];
  attempts: number;
}

export class ProposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposeError';
  }
}

export const EDITS_SCHEMA_NAME = 'patch_edits';

export const EDITS_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    edits: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', minLength: 1 },
          search: { type: 'string', minLength: 1 },
          replace: { type: 'string' },
        },
        required: ['file', 'search', 'replace'],
      },
    },
  },
  required: ['edits'],
};

// ---------------------------------------------------------------------------
// Validation (pure, no model call)
// ---------------------------------------------------------------------------

export type EditsValidation =
  | { ok: true; edits: PatchEdit[] }
  | { ok: false; errors: string[] };

function looksLikeUnifiedDiff(text: string): boolean {
  return /(^|\n)@@ /.test(text) || /(^|\n)--- [^\n]*\n\+\+\+ /.test(text);
}

export function validateEditsPayload(raw: unknown): EditsValidation {
  const result = validateAgainstSchema(raw, EDITS_SCHEMA);
  if (!result.ok) return { ok: false, errors: result.errors };

  const edits = (raw as { edits: PatchEdit[] }).edits;
  const errors: string[] = [];

  edits.forEach((edit, index) => {
    const at = `$.edits[${index}]`;
    if (path.isAbsolute(edit.file) || edit.file.split(/[\\/]/).includes('..')) {
      errors.push(`${at}.file: must be a repo-relative path without ".."`);
    }
    if (looksLikeUnifiedDiff(edit.search) || looksLikeUnifiedDiff(edit.replace)) {
      errors.push(`${at}: unified diffs are not accepted; provide file/search/replace only`);
    }
    if (edit.search === edit.replace) {
      errors.push(`${at}: search and replace are identical (no-op edit)`);
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, edits };
}

// ---------------------------------------------------------------------------
// Source bundle: symbol bodies and caller call sites, read from the run copy
// ---------------------------------------------------------------------------

function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Builds the ONLY source the patch model sees: symbol bodies and the call sites
 * of their callers, resolved from context.json and read from the run copy.
 */
export function buildSourceBundle(
  context: ContextBundle,
  repoPath: string,
  maxChars = 12000
): SourceSnippet[] {
  if (context.hintedFiles) {
    return context.hintedFiles.map(({ path: file, content }) => ({
      file,
      startLine: 1,
      endLine: content.split(/\r?\n/).length,
      content,
    }));
  }
  const byFile = new Map<string, { start: number; end: number }[]>();

  const add = (file: string | undefined, start: number | undefined, end: number | undefined): void => {
    if (!file || start === undefined || end === undefined) return;
    if (path.isAbsolute(file)) return;
    const ranges = byFile.get(file) ?? [];
    ranges.push({ start: Math.max(1, start), end: Math.max(start, end) });
    byFile.set(file, ranges);
  };

  for (const finding of context.findings) {
    add(finding.file, finding.startLine, finding.endLine);
    if (finding.callSiteFile !== undefined && finding.callSiteLine !== undefined) {
      add(finding.callSiteFile, Math.max(1, finding.callSiteLine - 2), finding.callSiteLine + 2);
    }
  }

  const snippets: SourceSnippet[] = [];
  let used = 0;

  for (const [file, ranges] of byFile) {
    const fullPath = path.resolve(repoPath, file);
    if (!fullPath.startsWith(path.resolve(repoPath))) continue;
    if (!fs.existsSync(fullPath)) continue;

    const lines = fs.readFileSync(fullPath, 'utf-8').split(/\r?\n/);
    for (const range of mergeRanges(ranges)) {
      const start = range.start;
      const end = Math.min(range.end, lines.length);
      if (start > lines.length) continue;
      const content = lines.slice(start - 1, end).join('\n');
      if (!content.trim()) continue;
      if (used + content.length > maxChars) return snippets;
      used += content.length;
      snippets.push({ file, startLine: start, endLine: end, content });
    }
  }

  return snippets;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts a symbol's body from file content by brace matching, bounded to
 * maxLines. Used to give the validator the post-patch source of changed functions.
 * A heuristic (strings/comments with braces could miscount) that is deliberately
 * bounded and fail-soft: it returns '' when the symbol cannot be located.
 */
export function extractSymbolBody(content: string, name: string, maxLines = 80): string {
  const lines = content.split(/\r?\n/);
  const decl = new RegExp(`(function|const|let|var|class|interface|type)\\s+${escapeRegExp(name)}\\b|\\b${escapeRegExp(name)}\\s*[(=:]`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (decl.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';

  const out: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length && out.length < maxLines; i++) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (opened && depth <= 0) break;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export type ProposeCallModel = (
  messages: ChatMessage[],
  runId: string,
  schemaName: string,
  schema: SchemaNode
) => Promise<ModelCallResult>;

async function defaultCallModel(
  messages: ChatMessage[],
  runId: string,
  schemaName: string,
  schema: SchemaNode
): Promise<ModelCallResult> {
  return complete(
    'patch',
    messages,
    { maxTokens: 4000, responseFormat: jsonSchemaResponseFormat(schemaName, pruneSchemaForWire(schema)) },
    runId,
    'patch'
  );
}

const SYSTEM_PROMPT =
  'You are a precise code patch generator. Return ONLY JSON matching the schema: ' +
  'a top-level "edits" array of {file, search, replace}. ' +
  'Rules: ' +
  '(1) "file" is repo-relative (for example src/discount.ts). ' +
  '(2) "search" must be copied VERBATIM from the provided source and must occur EXACTLY ONCE in that file; ' +
  'include enough surrounding lines to be unique. ' +
  '(3) "replace" is the full replacement text for the matched region. ' +
  '(4) NEVER return a unified diff; only file/search/replace. ' +
  '(5) Make the smallest change that satisfies the issue. Prefer changes local to one function. ' +
  '(6) Do NOT add dependencies or new files. ' +
  '(7) Do not modify shared helpers unless the issue explicitly requires it. ' +
  '(8) You may ONLY edit files under the ALLOWED paths listed below. Every path under the DENIED paths is ' +
  'READ ONLY: never edit, add, move or delete a test file or any other denied path. The policy gate rejects ' +
  'any such change. The repro test must pass by changing SOURCE CODE ONLY; do not edit a test to make it pass.';

/**
 * Read-only path section, built from the policy file's allowed/denied lists (loaded
 * from foreman.policy.json at runtime by the caller) and the failing repro test as
 * READ ONLY EVIDENCE.
 */
function readOnlySection(
  policy: { allowedPaths: string[]; deniedPaths: string[] },
  reproTest: { name: string; file: string; text: string } | undefined
): string {
  const lines = [
    'READ-ONLY PATHS (the policy gate rejects any edit, addition, move or deletion):',
    `- ALLOWED paths (the ONLY paths you may edit): ${policy.allowedPaths.join(', ') || '(none)'}`,
    `- DENIED paths (READ ONLY; this includes every test file): ${policy.deniedPaths.join(', ') || '(none)'}`,
    'The repro test must pass by changing SOURCE CODE ONLY. Never edit a test to make it pass.',
    '',
  ];
  if (reproTest) {
    lines.push(
      `READ ONLY EVIDENCE: the failing repro test "${reproTest.name}" (${reproTest.file}); do not modify it:`,
      '',
      reproTest.text.slice(0, 4000),
      ''
    );
  }
  return lines.join('\n') + '\n';
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** Locates the repro test named repro-issue-<n> in the run copy's test files. */
export function findReproTest(
  repoPath: string,
  issueId: string
): { name: string; file: string; text: string } | undefined {
  const root = path.resolve(repoPath);
  const marker = `repro-issue-${issueId}`;
  const candidates = [...walkFiles(path.join(root, 'test')), ...walkFiles(root).filter((f) => /test/i.test(path.basename(f)))];
  const seen = new Set<string>();
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (!content.includes(marker)) continue;
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((l) => /(?:^|\s)(?:test|it)\s*\(/.test(l) && l.includes(marker));
    if (start === -1) continue;
    const block: string[] = [];
    let depth = 0;
    for (let i = start; i < lines.length && block.length < 60; i++) {
      block.push(lines[i]);
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (i > start && depth <= 0) break;
    }
    return { name: marker, file: path.relative(root, file).replace(/\\/g, '/'), text: block.join('\n') };
  }
  return undefined;
}

function formatSources(sources: SourceSnippet[]): string {
  return sources
    .map((s) => `--- file: ${s.file} (lines ${s.startLine}-${s.endLine}) ---\n${s.content}`)
    .join('\n\n');
}

export interface ProposeInput {
  issue: Mandate;
  rubric: RubricResult;
  sources: SourceSnippet[];
  memoryText?: string;
  /** allowedPaths/deniedPaths read from foreman.policy.json at runtime by the caller. */
  policy: { allowedPaths: string[]; deniedPaths: string[] };
  /** The failing repro test, shown as READ ONLY EVIDENCE. */
  reproTest?: { name: string; file: string; text: string };
}

export async function proposePatch(
  input: ProposeInput,
  runId: string,
  callModel: ProposeCallModel = defaultCallModel
): Promise<ProposeResult> {
  const criteriaText = input.rubric.criteria.map((c) => `- [${c.check}] ${c.id}: ${c.text}`).join('\n');
  const memorySection = input.memoryText?.trim()
    ? `Failure memory from previous attempts. Do NOT repeat any approach that already failed; choose a materially different edit.\n${input.memoryText.trim()}\n\n`
    : '';

  const baseMessages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Issue:\n${input.issue.title}\n\n${input.issue.summary}\n\n` +
        `Rubric criteria:\n${criteriaText}\n\n` +
        memorySection +
        readOnlySection(input.policy, input.reproTest) +
        `Relevant source (authoritative; copy "search" verbatim from here):\n\n${formatSources(input.sources)}\n\n` +
        'Return the JSON edit list.',
    },
  ];

  let lastErrors: string[] = [];
  let lastModel = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages: ChatMessage[] =
      attempt === 1
        ? baseMessages
        : [
            ...baseMessages,
            {
              role: 'user',
              content:
                'Your previous output was invalid for the schema. Errors:\n- ' +
                lastErrors.join('\n- ') +
                '\nReturn corrected JSON only.',
            },
          ];

    const result = await callModel(messages, runId, EDITS_SCHEMA_NAME, EDITS_SCHEMA);
    lastModel = result.model;

    const parsed = extractJson(result.text);
    if (parsed === null) {
      lastErrors = ['$.root: response was not parseable JSON'];
      continue;
    }

    const validation = validateEditsPayload(parsed);
    if (validation.ok) {
      return { edits: validation.edits, model: result.model, usage: result.usage, attempts: attempt };
    }
    lastErrors = validation.errors;
  }

  throw new ProposeError(
    `Patch proposal failed schema validation after 2 attempts: ${lastErrors.join('; ')}` +
      (lastModel ? ` (model: ${lastModel})` : '')
  );
}

// ---------------------------------------------------------------------------
// Apply (exact-once rule, all-or-nothing)
// ---------------------------------------------------------------------------

export type ApplyResult =
  | { ok: true; applied: { file: string; replacedChars: number }[] }
  | { ok: false; reason: string; index: number; file?: string };

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Line-ending tolerance.
 *
 * The patch model emits LF newlines, but a checkout on a host with
 * core.autocrlf=true can materialise CRLF files (this happened: the run copy's
 * files were CRLF after `git reset --hard`, so multi-line LF search strings
 * failed to match). We match on an LF-normalised view and restore the file's
 * original ending style, so an LF search matches a CRLF file and vice versa.
 */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function restoreLineEndings(text: string, crlf: boolean): string {
  const lf = toLf(text);
  return crlf ? lf.replace(/\n/g, '\r\n') : lf;
}

/**
 * Applies edits to the run copy. Every search string must occur exactly once in
 * its file; otherwise the attempt fails and NOTHING is written. Validates all
 * edits against in-memory content first, then writes all files.
 */
export function applyEdits(repoPath: string, edits: PatchEdit[]): ApplyResult {
  const root = path.resolve(repoPath);
  const contents = new Map<string, string>();
  const applied: { file: string; replacedChars: number }[] = [];

  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    const fullPath = path.resolve(repoPath, edit.file);

    if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
      return { ok: false, reason: `path escapes repo: ${edit.file}`, index, file: edit.file };
    }

    let current = contents.get(fullPath);
    if (current === undefined) {
      if (!fs.existsSync(fullPath)) {
        return { ok: false, reason: `file not found: ${edit.file}`, index, file: edit.file };
      }
      current = fs.readFileSync(fullPath, 'utf-8');
    }

    // Match on an LF-normalised view so the model's LF output applies to a file
    // that the run copy materialised as CRLF (or vice versa).
    const usesCrlf = current.includes('\r\n');
    const haystack = toLf(current);
    const needle = toLf(edit.search);

    const occurrences = countOccurrences(haystack, needle);
    if (occurrences === 0) {
      return { ok: false, reason: `search string not found in ${edit.file}`, index, file: edit.file };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        reason: `search string occurs ${occurrences} times in ${edit.file} (must be exactly once)`,
        index,
        file: edit.file,
      };
    }

    const replaced = haystack.replace(needle, toLf(edit.replace));
    contents.set(fullPath, restoreLineEndings(replaced, usesCrlf));
    applied.push({ file: edit.file, replacedChars: edit.search.length });
  }

  for (const [fullPath, text] of contents) {
    fs.writeFileSync(fullPath, text, 'utf-8');
  }

  return { ok: true, applied };
}
