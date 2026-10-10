import type { ModelTask } from "./types.js";

/**
 * Task-based model selection for the shared LiteLLM budget.
 * patch defaults to claude-sonnet-4.6 (stronger edits).
 * validate and cheap default to claude-haiku (smaller, cheaper calls).
 * FOREMAN_MODEL_PATCH_FALLBACK (default nova-pro) is available via patchFallbackModel().
 */

const DEFAULTS: Record<ModelTask, { env: string; model: string }> = {
  patch: { env: "FOREMAN_MODEL_PATCH", model: "claude-sonnet-4.6" },
  validate: { env: "FOREMAN_MODEL_VALIDATE", model: "claude-haiku" },
  cheap: { env: "FOREMAN_MODEL_CHEAP", model: "claude-haiku" },
};

function envModel(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export function modelFor(task: ModelTask): string {
  const entry = DEFAULTS[task];
  return envModel(entry.env, entry.model);
}

export function patchFallbackModel(): string {
  return envModel("FOREMAN_MODEL_PATCH_FALLBACK", "nova-pro");
}

/**
 * Independent validator model. MUST differ from the patch model so the writer
 * never judges its own patch. Default nova-pro (a tiny json_schema probe against
 * the gateway succeeded, see scripts/probe-nova.ts). Override with
 * FOREMAN_MODEL_VALIDATOR.
 */
export function validatorModel(): string {
  return envModel("FOREMAN_MODEL_VALIDATOR", "nova-pro");
}
