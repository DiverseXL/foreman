/**
 * Independent validator.
 *
 * Design rule: the writer never judges its own patch. This module runs on a
 * DIFFERENT model from the patch model (default nova-pro, see router.validatorModel).
 *
 * The validator only judges the criteria that need judgment (check "diff" or
 * "behavior"). Anything provable by code (the repro test, regressions, the policy
 * gate) is decided by code in ./verdicts.ts and never sent here.
 *
 * It receives verifiable evidence: the post-patch source of every changed
 * function (bounded), the diff, the names of tests that passed and failed after
 * the patch, whether the graph supplies a test-to-symbol mapping, and the direct
 * call sites from context. It never sees the patch model's reasoning.
 *
 * Enforcement is in plain code, not on the wire:
 *  - ids must equal the judgment rubric ids exactly (none missing/extra/duplicate),
 *  - confidence must be within [0, 1],
 *  - "reason" and "missing_evidence" are truncated to 200 characters,
 *  - a verdict of "unclear" REQUIRES a non-empty "missing_evidence".
 * Invalid output is retried ONCE; if still invalid the caller must stop with
 * needs_human (this module throws ValidatorError and the supervisor records it).
 *
 * allCriteriaPass (judgment group only) is computed here in code. The supervisor
 * combines it with the code-decided verdicts (both groups must pass).
 */

import { completeWith, jsonSchemaResponseFormat, validatorModel } from '../model/index.js';
import type { ChatMessage, ModelCallResult } from '../model/types.js';
import { extractJson, pruneSchemaForWire, validateAgainstSchema, type SchemaNode } from '../schema/validate.js';
import type { RubricCriterion } from '../mandate/rubric.js';

export * from './verdicts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidatorVerdict = 'pass' | 'fail' | 'unclear';

export interface ValidatorCriterion {
  id: string;
  verdict: ValidatorVerdict;
  confidence: number;
  reason: string;
  /** Required to be non-empty whenever verdict is "unclear" (max 200 chars). */
  missing_evidence: string;
}

export interface ChangedSource {
  symbol: string;
  file: string;
  content: string;
}

export interface CallSite {
  symbol: string;
  file: string;
  line?: number;
  evidence: string;
}

export interface ValidatorEscalation {
  changedFileContents: { file: string; content: string }[];
  callerBodies: { symbol: string; file: string; content: string }[];
}

export interface ValidatorInput {
  /** Judgment criteria only (check diff/behavior). */
  criteria: RubricCriterion[];
  diff: string;
  targetPassed: boolean;
  regressions: string[];
  gate: { passed: boolean; failedRules: string[]; rules: { ruleId: string; passed: boolean; detail: string }[] };
  evidenceText: string;
  /** Post-patch source of every changed function (bounded to 80 lines each). */
  changedSources: ChangedSource[];
  passedTests: string[];
  failedTests: string[];
  /** Names of passing tests that exercise the changed symbols, if known. */
  testsExercisingSymbols: string[];
  /** Why the test-to-symbol mapping is unavailable (used when the list is empty). */
  testsExercisingNote: string;
  /** Direct call sites of the changed symbols, from context.json. */
  callSites: CallSite[];
  /** Present only on the single evidence-escalation re-run. */
  escalation?: ValidatorEscalation;
}

export interface ValidatorRunResult {
  model: string;
  criteria: ValidatorCriterion[];
  /** All JUDGMENT criteria pass. The supervisor ANDs this with the code verdicts. */
  allCriteriaPass: boolean;
  escalated: boolean;
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
          missing_evidence: { type: 'string' },
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
const MAX_MISSING_EVIDENCE_CHARS = 200;

/**
 * Pure, code-enforced validation of a validator payload. No model call.
 * ids must match the judgment rubric ids exactly; confidences in [0, 1]; an
 * "unclear" verdict must carry non-empty missing_evidence.
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
    const missingEvidence = typeof criterion.missing_evidence === 'string' ? criterion.missing_evidence.trim() : '';
    if (criterion.verdict === 'unclear' && missingEvidence.length === 0) {
      errors.push(`$.criteria["${criterion.id}"].missing_evidence: must be non-empty when verdict is "unclear"`);
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
    missing_evidence:
      typeof c.missing_evidence === 'string' ? c.missing_evidence.slice(0, MAX_MISSING_EVIDENCE_CHARS) : '',
  }));
  return { ok: true, criteria: normalized };
}

/** allCriteriaPass (judgment group): every criterion is "pass" at/above the floor. */
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
// Prompt construction (evidence only; never the patch model's reasoning)
// ---------------------------------------------------------------------------

const MAX_DIFF_CHARS = 8000;
const MAX_EVIDENCE_CHARS = 3000;
const MAX_SOURCE_CHARS = 6000;
const MAX_ESCALATION_FILE_CHARS = 12000;
const MAX_CALLER_BODY_CHARS = 6000;

function sectionSources(sources: readonly ChangedSource[]): string {
  if (sources.length === 0) return '(no changed-function source was resolved)';
  return sources
    .map((s) => `--- ${s.file} :: ${s.symbol} ---\n${s.content}`)
    .join('\n\n')
    .slice(0, MAX_SOURCE_CHARS);
}

function sectionCallSites(callSites: readonly CallSite[]): string {
  if (callSites.length === 0) return '(none supplied by the graph context)';
  return callSites.map((c) => `- ${c.symbol} called from ${c.file}${c.line ? `:${c.line}` : ''}`).join('\n');
}

function formatInput(input: ValidatorInput): string {
  const criteria = input.criteria.map((c) => `- id=${c.id} check=${c.check}: ${c.text}`).join('\n');
  const lines: string[] = [
    'Acceptance rubric (judge each criterion independently):',
    criteria || '(no rubric criteria were produced)',
    '',
    `Test outcome: targetPassed=${input.targetPassed}; regressions=${input.regressions.length === 0 ? 'none' : input.regressions.join(', ')}`,
    `Tests that passed after the patch: ${input.passedTests.join(', ') || '(none)'}`,
    `Tests that failed after the patch: ${input.failedTests.join(', ') || '(none)'}`,
    `Tests that exercise the changed symbols: ${
      input.testsExercisingSymbols.length > 0 ? input.testsExercisingSymbols.join(', ') : input.testsExercisingNote
    }`,
    '',
    `Policy gate: passed=${input.gate.passed}; failedRules=${input.gate.failedRules.length === 0 ? 'none' : input.gate.failedRules.join(', ')}`,
    'Gate rule details:',
    input.gate.rules.map((r) => `- ${r.ruleId}: ${r.passed ? 'pass' : 'FAIL'} (${r.detail})`).join('\n'),
    '',
    'Post-patch source of the changed functions:',
    sectionSources(input.changedSources),
    '',
    'Direct call sites of the changed symbols:',
    sectionCallSites(input.callSites),
    '',
    'Change diff (base..attempt):',
    input.diff.slice(0, MAX_DIFF_CHARS),
    '',
    'Structural context evidence:',
    input.evidenceText.slice(0, MAX_EVIDENCE_CHARS) || '(none)',
  ];

  if (input.escalation) {
    const files = input.escalation.changedFileContents
      .map((f) => `--- full file: ${f.file} ---\n${f.content}`)
      .join('\n\n')
      .slice(0, MAX_ESCALATION_FILE_CHARS);
    const callers = input.escalation.callerBodies
      .map((c) => `--- direct caller: ${c.file} :: ${c.symbol} ---\n${c.content}`)
      .join('\n\n')
      .slice(0, MAX_CALLER_BODY_CHARS);
    lines.push(
      '',
      'ESCALATION EVIDENCE (added after a first, unclear-only review):',
      'Full text of each changed file:',
      files || '(none)',
      '',
      'Bodies of the direct callers of the changed symbols:',
      callers || '(none)'
    );
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT =
  'You are an adversarial, independent code reviewer. Another model wrote the change shown below; ' +
  'your job is to find ways it is WRONG, incomplete, or breaks the requested behavior. ' +
  'Judge ONLY the criteria listed. Do not trust the tests alone, and base every verdict strictly on the ' +
  'evidence provided (the post-patch source, the diff, the test names, and the call sites). ' +
  'Return ONLY JSON matching the provided schema: a "criteria" array with one entry per rubric criterion, in the rubric order. ' +
  'For each criterion set "verdict" to "pass" (clearly satisfied by the evidence), "fail" (clearly not satisfied), ' +
  'or "unclear" (the evidence shown does not let you decide). ' +
  'Set "confidence" to a number between 0 and 1 and "reason" to at most 200 characters. ' +
  'If the verdict is "unclear", you MUST set "missing_evidence" to a concrete statement (max 200 characters) of exactly ' +
  'what evidence is missing; otherwise set "missing_evidence" to an empty string. ' +
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
                '\nReturn corrected JSON only, with exactly the rubric ids. Every "unclear" verdict must include a non-empty "missing_evidence".',
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
        escalated: Boolean(input.escalation),
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
