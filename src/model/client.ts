import OpenAI from "openai";
import { modelFor } from "./router.js";
import { assertCallAllowed, recordModelCall, STEP_MAX_COMPLETION_TOKENS_PER_CALL, type ModelCallStage } from "./ledger.js";
import type { ChatMessage, ModelCallResult, ModelTask } from "./types.js";

const DEFAULT_BASE_URL = "https://litellm.vision.aivar.app/v1";

export type CompleteOptions = {
  temperature?: number;
  maxTokens?: number;
  /**
   * OpenAI-compatible response_format. Verified against the gateway: json_schema
   * with strict:true returns bare JSON, json_object returns fenced markdown.
   */
  responseFormat?: Record<string, unknown>;
};

export function litellmBaseUrl(): string {
  const value = process.env.LITELLM_BASE_URL?.trim();
  return value ? value : DEFAULT_BASE_URL;
}

/**
 * Builds a strict JSON-schema response_format for the gateway. verified support
 * was checked in scripts/probe-gateway.ts (bare JSON returned for both models).
 */
export function jsonSchemaResponseFormat(
  name: string,
  schema: unknown
): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name,
      strict: true,
      schema,
    },
  };
}

/**
 * Builds a client only when called. Missing LITELLM_API_KEY does not throw at import.
 */
export function getClient(): OpenAI {
  const apiKey = process.env.LITELLM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "LITELLM_API_KEY is not set. Add it to the environment or .env before calling the model router.",
    );
  }
  return new OpenAI({
    apiKey,
    baseURL: litellmBaseUrl(),
  });
}

export async function complete(
  task: ModelTask,
  messages: ChatMessage[],
  options?: CompleteOptions,
  runId?: string,
  stage: ModelCallStage = 'other',
): Promise<ModelCallResult> {
  return completeWith(modelFor(task), messages, options, runId, task, stage);
}

/**
 * Same as complete() but with an explicit model name (used by the validator,
 * which must run on a different model from the patch model).
 */
export async function completeWith(
  model: string,
  messages: ChatMessage[],
  options?: CompleteOptions,
  runId?: string,
  task: ModelTask = 'validate',
  stage: ModelCallStage = 'other',
): Promise<ModelCallResult> {
  const client = getClient();

  // Enforce per-call completion token cap
  const maxTokens = Math.min(
    options?.maxTokens ?? STEP_MAX_COMPLETION_TOKENS_PER_CALL,
    STEP_MAX_COMPLETION_TOKENS_PER_CALL,
  );

  // Fail closed BEFORE spending: null price or exhausted budget refuses the call.
  if (runId) {
    assertCallAllowed(model);
  }

  const { data: response, response: rawResponse } = await client.chat.completions
    .create({
      model,
      messages,
      temperature: options?.temperature,
      max_tokens: maxTokens,
      response_format: options?.responseFormat as never,
    })
    .withResponse();

  // Gateway-reported cost/spend headers (only these; never credentials).
  const headerValue = (name: string): number | null => {
    const raw = rawResponse?.headers?.get(name);
    if (raw === null || raw === undefined || raw === '') return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const text = response.choices[0]?.message?.content ?? "";
  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const completionTokens = response.usage?.completion_tokens ?? 0;
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens: response.usage?.total_tokens ?? (promptTokens + completionTokens),
  };

  const gatewayCostUsd = headerValue('x-litellm-response-cost');
  console.log(
    `[model] stage=${stage} model=${response.model || model} prompt=${promptTokens} completion=${completionTokens} cost_usd=${gatewayCostUsd ?? 'n/a'} source=gateway`
  );
  // Record in the ledger using gateway-reported cost when available.
  if (runId) {
    recordModelCall({
      runId,
      stage,
      model,
      promptTokens,
      completionTokens,
      gatewayCostUsd,
      keySpendUsd: headerValue('x-litellm-key-spend'),
      keyMaxBudgetUsd: headerValue('x-litellm-key-max-budget'),
    });
  }

  return {
    text,
    model: response.model || model,
    task,
    usage,
  };
}
