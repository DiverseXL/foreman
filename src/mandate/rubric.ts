import fs from 'node:fs';
import path from 'node:path';
import { complete, jsonSchemaResponseFormat } from '../model/index.js';
import type { ChatMessage, ModelCallResult } from '../model/types.js';
import { extractJson, pruneSchemaForWire, validateAgainstSchema, type SchemaNode } from '../schema/validate.js';
import { appendFact } from '../state/facts.js';
import type { Mandate } from './load.js';

export type RubricCheck = 'test' | 'diff' | 'behavior';
export type EvidenceRefKind = 'test' | 'symbol' | 'issue_text';

export interface EvidenceRef {
  kind: EvidenceRefKind;
  value: string;
}

export interface RubricCriterion {
  id: string;
  text: string;
  check: RubricCheck;
  /** Evidence that verifies this criterion. Validated in code (see validateRubricEvidence). */
  evidence_ref: EvidenceRef;
}

export interface RubricResult {
  criteria: RubricCriterion[];
  model: string;
  usage?: ModelCallResult['usage'];
  attempts: number;
  /** Criteria dropped after the one regeneration because their evidence was invalid. */
  dropped: { id: string; reason: string }[];
}

export class RubricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RubricError';
  }
}

export const RUBRIC_SCHEMA_NAME = 'rubric';

export const RUBRIC_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    criteria: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          text: { type: 'string', minLength: 1 },
          check: { type: 'string', enum: ['test', 'diff', 'behavior'] },
          evidence_ref: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['test', 'symbol', 'issue_text'] },
              value: { type: 'string', minLength: 1 },
            },
            required: ['kind', 'value'],
          },
        },
        required: ['id', 'text', 'check', 'evidence_ref'],
      },
    },
  },
  required: ['criteria'],
};

/** Schema sent to the gateway. minItems/maxItems are stripped; the 3..6 rule is enforced locally. */
export const RUBRIC_WIRE_SCHEMA: SchemaNode = pruneSchemaForWire(RUBRIC_SCHEMA);

export type RubricValidation =
  | { ok: true; criteria: RubricCriterion[] }
  | { ok: false; errors: string[] };

/** Pure schema validation for a rubric payload (no model call). */
export function validateRubricPayload(raw: unknown): RubricValidation {
  const result = validateAgainstSchema(raw, RUBRIC_SCHEMA);
  if (!result.ok) return { ok: false, errors: result.errors };

  const criteria = (raw as { criteria: RubricCriterion[] }).criteria;
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) {
      return { ok: false, errors: [`$.criteria: duplicate id "${criterion.id}"`] };
    }
    ids.add(criterion.id);
  }
  // At least one criterion must need judgment, so the independent validator always
  // has something to review (criteria with check "test" are covered by code).
  if (!criteria.some((c) => c.check === 'diff' || c.check === 'behavior')) {
    return {
      ok: false,
      errors: ['$.criteria: at least one criterion must have check "diff" or "behavior"'],
    };
  }
  return { ok: true, criteria };
}

// ---------------------------------------------------------------------------
// Code validity of each criterion's evidence_ref
// ---------------------------------------------------------------------------

export interface RubricValidityContext {
  /** Test names found by a static scan of the run copy's test files. */
  knownTestNames: string[];
  /** Symbols known to context.json (symbolFacts + findings) plus hinted symbols. */
  knownSymbols: string[];
}

export interface EvidenceValidation {
  valid: RubricCriterion[];
  invalid: { id: string; reason: string }[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Code-checks every criterion's evidence_ref against the run:
 *  - test      -> the name must exist in the run copy's test files (static scan)
 *  - symbol    -> the name must appear in context.json or be a hinted symbol
 *  - issue_text-> the value must be a whitespace-normalized substring of the issue text
 */
export function validateRubricEvidence(
  criteria: readonly RubricCriterion[],
  issueText: string,
  context: RubricValidityContext
): EvidenceValidation {
  const valid: RubricCriterion[] = [];
  const invalid: { id: string; reason: string }[] = [];
  const testNames = new Set(context.knownTestNames);
  const symbols = new Set(context.knownSymbols);
  const issue = normalize(issueText);

  for (const criterion of criteria) {
    const ref = criterion.evidence_ref;
    if (!ref || !ref.value || !ref.value.trim()) {
      invalid.push({ id: criterion.id, reason: 'evidence_ref is missing a value' });
      continue;
    }
    const value = ref.value.trim();
    if (ref.kind === 'test') {
      if (testNames.has(value)) valid.push(criterion);
      else invalid.push({ id: criterion.id, reason: `evidence_ref test "${value}" was not found in the test files` });
    } else if (ref.kind === 'symbol') {
      if (symbols.has(value)) valid.push(criterion);
      else invalid.push({ id: criterion.id, reason: `evidence_ref symbol "${value}" is not in context.json` });
    } else if (ref.kind === 'issue_text') {
      if (issue.includes(normalize(value))) valid.push(criterion);
      else invalid.push({ id: criterion.id, reason: `evidence_ref issue_text "${value}" is not a substring of the issue text` });
    } else {
      invalid.push({ id: criterion.id, reason: `evidence_ref kind "${String(ref.kind)}" is not test|symbol|issue_text` });
    }
  }
  return { valid, invalid };
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

/** Static scan: names of tests declared in the run copy's test files. */
export function scanTestNames(repoPath: string): string[] {
  const root = path.resolve(repoPath);
  const names = new Set<string>();
  const pattern = /(?:^|\s)(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const file of walkFiles(path.join(root, 'test'))) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const match of content.matchAll(pattern)) names.add(match[1]);
  }
  return Array.from(names);
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

export type CallModel = (
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
    'validate',
    messages,
    { maxTokens: 800, responseFormat: jsonSchemaResponseFormat(schemaName, pruneSchemaForWire(schema)) },
    runId
  );
}

function issueText(issue: Mandate): string {
  try {
    return fs.readFileSync(issue.sourcePath, 'utf-8');
  } catch {
    return [
      `# ${issue.title}`,
      '',
      '## Summary',
      issue.summary,
      '',
      '## Expected Behavior',
      ...issue.acceptanceCriteria.map((c) => `- ${c}`),
    ].join('\n');
  }
}

const SYSTEM_PROMPT =
  'You convert a software issue into a short, checkable acceptance rubric. ' +
  'Return ONLY JSON matching the provided schema. Produce between 3 and 6 criteria. ' +
  'Each criterion must set "check" to one of: ' +
  '"test" (verified by running an existing test; name that test in the text), ' +
  '"diff" (verified by inspecting the change to the source; state the diff property), ' +
  '"behavior" (a specific runtime behavior; state the call site or function that shows it). ' +
  'Every "text" MUST state the concrete evidence that would verify it: the name of a test, a diff property, ' +
  'or a call site. Every criterion must be verifiable from the issue text, the change diff, and the test results. ' +
  'Reject criteria that assert behavior of code unrelated to this issue: only reference the functions, files and ' +
  'tests the issue is about. Include at least one criterion with check "diff" or "behavior". ' +
  'Every criterion MUST also carry an "evidence_ref" object: ' +
  '{"kind":"test","value":"<an exact test name that exists in the test files>"}, or ' +
  '{"kind":"symbol","value":"<a function/symbol name that appears in the provided context>"}, or ' +
  '{"kind":"issue_text","value":"<a short phrase copied verbatim from the issue text>"}. ' +
  'Pick the kind that truly proves the criterion. Keep each "text" under 200 characters. Use short stable ids like "r1", "r2".';

export interface BuildRubricOptions {
  validity: RubricValidityContext;
  callModel?: CallModel;
}

export async function buildRubric(
  issue: Mandate,
  runId: string,
  options?: BuildRubricOptions
): Promise<RubricResult> {
  const callModel = options?.callModel ?? defaultCallModel;
  const rawIssueText = issueText(issue);
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'Issue specification:\n\n' +
        rawIssueText +
        '\n\nReturn the rubric as JSON with a top-level "criteria" array.',
    },
  ];

  let lastErrors: string[] = [];
  let lastInvalidCriteria: { criterion: RubricCriterion; reason: string }[] = [];
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
                (lastInvalidCriteria.length > 0
                  ? 'Your previous output contained criteria with invalid evidence. Invalid criteria and reasons:\n' +
                    lastInvalidCriteria
                      .map(({ criterion, reason }) => `- criterion=${JSON.stringify(criterion)}\n  reason=${reason}`)
                      .join('\n') +
                    '\nRegenerate the rubric, correcting or removing these criteria. Each criterion must include a valid evidence_ref.'
                  : 'Your previous output was invalid. Errors:\n- ' +
                    lastErrors.join('\n- ') +
                    '\nReturn corrected JSON only. Each criterion must include a valid evidence_ref.'),
            },
          ];

    const result = await callModel(messages, runId, RUBRIC_SCHEMA_NAME, RUBRIC_SCHEMA);
    lastModel = result.model;

    const parsed = extractJson(result.text);
    if (parsed === null) {
      lastErrors = ['$.root: response was not parseable JSON'];
      continue;
    }

    const validation = validateRubricPayload(parsed);
    if (!validation.ok) {
      lastErrors = validation.errors;
      lastInvalidCriteria = [];
      continue;
    }

    if (!options) {
      return { criteria: validation.criteria, model: result.model, usage: result.usage, attempts: attempt, dropped: [] };
    }

    const evidence = validateRubricEvidence(validation.criteria, rawIssueText, options.validity);
    if (evidence.invalid.length === 0) {
      return { criteria: validation.criteria, model: result.model, usage: result.usage, attempts: attempt, dropped: [] };
    }

    if (attempt < 2) {
      lastErrors = evidence.invalid.map((i) => `${i.id}: ${i.reason}`);
      const invalidReasons = new Map(evidence.invalid.map((item) => [item.id, item.reason]));
      lastInvalidCriteria = validation.criteria
        .flatMap((criterion) => {
          const reason = invalidReasons.get(criterion.id);
          return reason === undefined ? [] : [{ criterion, reason }];
        });
      continue;
    }

    // Second attempt still invalid: DROP only the invalid criteria.
    const kept = evidence.valid;
    const dropped = evidence.invalid.map((i) => ({ id: i.id, reason: i.reason }));
    appendFact(runId, { type: 'criteria_dropped', ids: dropped.map((d) => d.id), reasons: dropped.map((d) => d.reason) });
    if (kept.length < 2 || !kept.some((c) => c.check === 'diff' || c.check === 'behavior')) {
      const droppedIds = dropped.map((d) => d.id).join(', ');
      const reason = `rubric_invalid: only ${kept.length} valid criteria remain after dropping ${droppedIds} (need at least 2 including a diff/behavior criterion)`;
      appendFact(runId, { type: 'needs_human', reason });
      throw new RubricError(reason);
    }
    return { criteria: kept, model: result.model, usage: result.usage, attempts: attempt, dropped };
  }

  const reason = `rubric_invalid: rubric generation failed schema validation after 2 attempts: ${lastErrors.join('; ')}`;
  appendFact(runId, { type: 'needs_human', reason });
  throw new RubricError(reason + (lastModel ? ` (model: ${lastModel})` : ''));
}
