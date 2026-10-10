import OpenAI from "openai";
import { modelFor } from "./router.js";
import type { ChatMessage, ModelCallResult, ModelTask } from "./types.js";

const DEFAULT_BASE_URL = "https://litellm.vision.aivar.app/v1";

export type CompleteOptions = {
  temperature?: number;
  maxTokens?: number;
};

export function litellmBaseUrl(): string {
  const value = process.env.LITELLM_BASE_URL?.trim();
  return value ? value : DEFAULT_BASE_URL;
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
): Promise<ModelCallResult> {
  const model = modelFor(task);
  const client = getClient();
  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: options?.temperature,
    max_tokens: options?.maxTokens,
  });

  const text = response.choices[0]?.message?.content ?? "";
  const usage = response.usage
    ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      }
    : undefined;

  return {
    text,
    model: response.model || model,
    task,
    usage,
  };
}
