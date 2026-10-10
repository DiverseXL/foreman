import fs from 'node:fs';
import { complete, jsonSchemaResponseFormat } from '../model/index.js';
import type { ChatMessage, ModelCallResult } from '../model/types.js';
import { extractJson, pruneSchemaForWire, validateAgainstSchema, type SchemaNode } from '../schema/validate.js';
import { appendFact } from '../state/facts.js';
import type { Mandate } from './load.js';

export type RubricCheck = 'test' | 'diff' | 'behavior';

export interface RubricCriterion {
  id: string;
  text: string;
  check: RubricCheck;
}

export interface RubricResult {
  criteria: RubricCriterion[];
  model: string;
  usage?: ModelCallResult['usage'];
  attempts: number;
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
        },
        required: ['id', 'text', 'check'],
      },
    },
  },
  required: ['criteria'],
};

/**
 * Schema sent to the gateway. minItems/maxItems are stripped because the
 * Bedrock-backed structured output rejects them; the 3..6 rule is enforced
 * locally by validateRubricPayload.
 */
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
  'Keep each "text" under 200 characters. Use short stable ids like "r1", "r2".';

export async function buildRubric(
  issue: Mandate,
  runId: string,
  callModel: CallModel = defaultCallModel
): Promise<RubricResult> {
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'Issue specification:\n\n' +
        issueText(issue) +
        '\n\nReturn the rubric as JSON with a top-level "criteria" array.',
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
                'Your previous output was invalid JSON for the schema. Errors:\n- ' +
                lastErrors.join('\n- ') +
                '\nReturn corrected JSON only.',
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
    if (validation.ok) {
      return { criteria: validation.criteria, model: result.model, usage: result.usage, attempts: attempt };
    }
    lastErrors = validation.errors;
  }

  const reason = `Rubric generation failed schema validation after 2 attempts: ${lastErrors.join('; ')}`;
  appendFact(runId, { type: 'needs_human', reason });
  throw new RubricError(reason + (lastModel ? ` (model: ${lastModel})` : ''));
}
