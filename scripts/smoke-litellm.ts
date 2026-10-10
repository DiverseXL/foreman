/**
 * SMOKE ONLY. Not part of the agent loop.
 * Calls the cheap model through the LiteLLM router when LITELLM_API_KEY is set.
 * Prints model name, reply text, and token usage. Never prints the API key.
 */

import fs from "node:fs";
import { loadEnvFile } from "node:process";
import { complete } from "../src/model/index.js";

if (!process.env.LITELLM_API_KEY && fs.existsSync(".env")) {
  try {
    loadEnvFile(".env");
  } catch {
    // Leave the key unset so the smoke test can skip.
  }
}

async function main(): Promise<void> {
  if (!process.env.LITELLM_API_KEY?.trim()) {
    console.log("SKIP: LITELLM_API_KEY not set");
    process.exit(0);
  }

  const result = await complete("cheap", [
    { role: "user", content: "Reply with exactly: ok" },
  ]);

  console.log(`model: ${result.model}`);
  console.log(`reply: ${result.text}`);
  if (result.usage) {
    console.log(
      `usage: prompt=${result.usage.promptTokens ?? ""} completion=${result.usage.completionTokens ?? ""} total=${result.usage.totalTokens ?? ""}`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "smoke failed";
  console.error(message);
  process.exit(1);
});
