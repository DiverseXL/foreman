/**
 * Independent validator.
 *
 * Design rule: the writer never judges its own patch. This module runs on a
 * DIFFERENT model from the patch model (default nova-pro, see router.validatorModel)
 * and is given only the rubric, the diff, the test outcome and the gate result.
 * It never sees the patch model's reasoning.
 *
 * Enforcement is in plain code, not on the wire:
 *  - the returned criterion ids must equal the rubric ids exactly (none missing,
 *    none extra, no duplicates),
 *  - each confidence must be a number within [0, 1],
 *  - each reason is truncated to 200 characters.
 * Invalid output is retried ONCE; if still invalid the caller must stop with
 * needs_human (this module throws ValidatorError and the supervisor records it).
 *
 * allCriteriaPass is computed here, in code: every criterion must be "pass" with
 * confidence >= policy.validatorMinConfidence.
 */

import { completeWith, jsonSchemaResponseFormat, validatorModel } from '../model/index.js';
import type { ChatMessage, ModelCallResult } from '../model/types.js';
import { extractJson, pruneSchemaForWire, validateAgainstSchema, type SchemaNode } from '../schema/validate.js';
import type { RubricCriterion } from '../mandate/rubric.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidatorVerdict = 'pass' | 'fail' | 'unclear';

export interface ValidatorCriterion {
  id: string;
  verdict: ValidatorVerdict;
  confidence: number;
  reason: string;
}

export interface ValidatorInput {
  criteria: RubricCriterion[];
  diff: string;
  targetPassed: boolean;
  regressions: string[];
  gate: { passed: boolean; failedRules: string[]; rules: { ruleId: string; passed: boolean; detail: string }[] };
  evidenceText: string;
}

export interface ValidatorRunResult {
  model: string;
  criteria: ValidatorCriterion[];
  allCriteriaPass: boolean;
  attempts: number;
  usage?: ModelCallResult['usage'];
}

export class ValidatorError extends Error {
  readonly reason: string;
  readonly attempts: number;
  constructor(reason: string, attempts: number) {
    super(reason);
    this.name = 'ValidatorError';
    this.reason = reason;
    this.attempts = attempts;
  }
}

export const VALIDATOR_SCHEMA_NAME = 'validator_verdicts';

export const VALIDATOR_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    criteria: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          verdict: { type: 'string', enum: ['pass', 'fail', 'unclear'] },
          confidence: { type: 'number' },
          reason: { type: 'string', minLength: 1 },
        },
        required: ['id', 'verdict', 'confidence', 'reason'],
      },
    },
  },
  required: ['criteria'],
};

/** Schema sent to the gateway (minItems is stripped; enforced locally). */
export const VALIDATOR_WIRE_SCHEMA: SchemaNode = pruneSchemaForWire(VALIDATOR_SCHEMA);

export type ValidatorValidation =
  | { ok: true; criteria: ValidatorCriterion[] }
  | { ok: false; errors: string[] };

const MAX_REASON_CHARS = 200;

/**
 * Pure, code-enforced validation of a validator payload. No model call.
 * ids must match the rubric ids exactly; confidences must be in [0, 1].
 */
export function validateValidatorPayload(raw: unknown, rubricIds: string[]): ValidatorValidation {
  const result = validateAgainstSchema(raw, VALIDATOR_SCHEMA);
  if (!result.ok) return { ok: false, errors: result.errors };

  const criteria = (raw as { criteria: ValidatorCriterion[] }).criteria;
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const criterion of criteria) {
    if (!rubricIds.includes(criterion.id)) {
      errors.push(`$.criteria: id "${criterion.id}" is not in the rubric`);
      continue;
    }
    if (seen.has(criterion.id)) {
      errors.push(`$.criteria: duplicate id "${criterion.id}"`);
      continue;
    }
    seen.add(criterion.id);
    if (
      typeof criterion.confidence !== 'number' ||
      !Number.isFinite(criterion.confidence) ||
      criterion.confidence < 0 ||
      criterion.confidence > 1
    ) {
      errors.push(`$.criteria["${criterion.id}"].confidence: must be between 0 and 1`);
    }
  }

  for (const id of rubricIds) {
    if (!seen.has(id)) errors.push(`$.criteria: missing verdict for rubric id "${id}"`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const normalized = criteria.map((c) => ({
    id: c.id,
    verdict: c.verdict,
    confidence: c.confidence,
    reason: String(c.reason).slice(0, MAX_REASON_CHARS),
  }));
  return { ok: true, criteria: normalized };
}

/** allCriteriaPass: computed in code from the verdicts and the confidence floor. */
export function computeAllCriteriaPass(
  criteria: readonly ValidatorCriterion[],
  rubricIds: readonly string[],
  minConfidence: number
): boolean {
  if (rubricIds.length === 0) return criteria.every((c) => c.verdict === 'pass' && c.confidence >= minConfidence);
  return rubricIds.every((id) => {
    const criterion = criteria.find((c) => c.id === id);
    return Boolean(criterion && criterion.verdict === 'pass' && criterion.confidence >= minConfidence);
  });
}

// ---------------------------------------------------------------------------
// Prompt construction (rubric + diff + test outcome + gate + evidence only)
// ---------------------------------------------------------------------------

const MAX_DIFF_CHARS = 8000;
const MAX_EVIDENCE_CHARS = 3000;

function formatInput(input: ValidatorInput): string {
  const criteria = input.criteria.map((c) => `- id=${c.id} check=${c.check}: ${c.text}`).join('\n');
  return [
    'Acceptance rubric (judge each criterion independently):',
    criteria || '(no rubric criteria were produced)',
    '',
    `Test outcome: targetPassed=${input.targetPassed}; regressions=${input.regressions.length === 0 ? 'none' : input.regressions.join(', ')}`,
    '',
    `Policy gate: passed=${input.gate.passed}; failedRules=${input.gate.failedRules.length === 0 ? 'none' : input.gate.failedRules.join(', ')}`,
    'Gate rule details:',
    input.gate.rules.map((r) => `- ${r.ruleId}: ${r.passed ? 'pass' : 'FAIL'} (${r.detail})`).join('\n'),
    '',
    'Change diff (base..attempt):',
    input.diff.slice(0, MAX_DIFF_CHARS),
    '',
    'Structural context evidence:',
    input.evidenceText.slice(0, MAX_EVIDENCE_CHARS) || '(none)',
  ].join('\n');
}

const SYSTEM_PROMPT =
  'You are an adversarial, independent code reviewer. Another model wrote the change shown below; ' +
  'your job is to find ways it is WRONG, incomplete, or breaks the requested behavior. ' +
  'Do not trust the tests alone. Return ONLY JSON matching the provided schema: a "criteria" array ' +
  'with one entry per rubric criterion, in the rubric order. ' +
  'For each criterion set "verdict" to "pass" (clearly satisfied), "fail" (clearly not satisfied), ' +
  'or "unclear" (cannot be determined from the provided evidence). ' +
  'Set "confidence" to a number between 0 and 1 for your verdict, and "reason" to at most 200 characters. ' +
  'Use the rubric ids exactly as given; do not add, drop, rename, or duplicate any id.';

export type ValidatorCallModel = (
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
  return completeWith(
    validatorModel(),
    messages,
    { maxTokens: 1500, responseFormat: jsonSchemaResponseFormat(schemaName, pruneSchemaForWire(schema)) },
    runId,
    'validate'
  );
}

// ---------------------------------------------------------------------------
// Validator run (retry once on invalid output, then throw)
// ---------------------------------------------------------------------------

export async function validatePatch(
  input: ValidatorInput,
  runId: string,
  minConfidence: number,
  callModel: ValidatorCallModel = defaultCallModel
): Promise<ValidatorRunResult> {
  const rubricIds = input.criteria.map((c) => c.id);
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: formatInput(input) + '\n\nReturn the JSON verdict list.' },
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
                'Your previous output was invalid. Errors:\n- ' +
                lastErrors.join('\n- ') +
                '\nReturn corrected JSON only, with exactly the rubric ids.',
            },
          ];

    const result = await callModel(messages, runId, VALIDATOR_SCHEMA_NAME, VALIDATOR_SCHEMA);
    lastModel = result.model;

    const parsed = extractJson(result.text);
    if (parsed === null) {
      lastErrors = ['$.root: response was not parseable JSON'];
      continue;
    }

    const validation = validateValidatorPayload(parsed, rubricIds);
    if (validation.ok) {
      return {
        model: result.model,
        criteria: validation.criteria,
        allCriteriaPass: computeAllCriteriaPass(validation.criteria, rubricIds, minConfidence),
        attempts: attempt,
        usage: result.usage,
      };
    }
    lastErrors = validation.errors;
  }

  throw new ValidatorError(
    `Validator output was invalid after 2 attempts: ${lastErrors.join('; ')}` +
      (lastModel ? ` (model: ${lastModel})` : ''),
    2
  );
}
