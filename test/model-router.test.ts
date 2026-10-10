import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { modelFor, patchFallbackModel } from "../src/model/router.js";

const KEYS = [
  "FOREMAN_MODEL_PATCH",
  "FOREMAN_MODEL_VALIDATE",
  "FOREMAN_MODEL_CHEAP",
  "FOREMAN_MODEL_PATCH_FALLBACK",
] as const;

const previous = new Map<string, string | undefined>();

function restoreEnv(): void {
  for (const key of KEYS) {
    const value = previous.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("modelFor", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("uses Sonnet for patch and Haiku for validate and cheap by default", () => {
    for (const key of KEYS) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
    assert.equal(modelFor("patch"), "claude-sonnet-4.6");
    assert.equal(modelFor("validate"), "claude-haiku");
    assert.equal(modelFor("cheap"), "claude-haiku");
    assert.equal(patchFallbackModel(), "nova-pro");
  });

  it("overrides models from environment", () => {
    for (const key of KEYS) {
      previous.set(key, process.env[key]);
    }
    process.env.FOREMAN_MODEL_PATCH = "nova-pro";
    process.env.FOREMAN_MODEL_VALIDATE = "nova-lite";
    process.env.FOREMAN_MODEL_CHEAP = "nova-micro";
    process.env.FOREMAN_MODEL_PATCH_FALLBACK = "nova-2-lite";
    assert.equal(modelFor("patch"), "nova-pro");
    assert.equal(modelFor("validate"), "nova-lite");
    assert.equal(modelFor("cheap"), "nova-micro");
    assert.equal(patchFallbackModel(), "nova-2-lite");
  });
});
