/**
 * Cost and token ledger for Foreman model calls.
 *
 * Appends one JSON line per model call to runs/ledger.jsonl and fails closed
 * when a call cannot be costed or when the running estimated total exceeds the
 * configured cap. All dollar figures are ESTIMATES (see prices.json).
 *
 * Refusal semantics (order matters):
 *  - Price unknown (null in prices.json): the entry IS appended so token usage is
 *    still tracked, then the call is refused (fail closed, cannot enforce a cap).
 *  - Running estimated total already at/over FOREMAN_BUDGET_USD: the call is
 *    refused before appending.
 *  - Cumulative tokens would exceed STEP_MAX_TOTAL_TOKENS: refused before appending.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  ts: string;
  runId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** null when the price for this model is not configured */
  estimatedCostUsd: number | null;
}

export interface PriceConfig {
  input_per_1k: number | null;
  output_per_1k: number | null;
  input_per_1m?: number | null;
  output_per_1m?: number | null;
  source_url?: string;
  verified?: boolean;
  note?: string;
}

type PricesFile = Record<string, PriceConfig>;

// ---------------------------------------------------------------------------
// Step-level caps (enforced per run, not per call)
// ---------------------------------------------------------------------------

export const STEP_MAX_COMPLETION_TOKENS_PER_CALL = 4000;
export const STEP_MAX_TOTAL_TOKENS = 60000;
export const STEP_MAX_PATCH_ATTEMPTS = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function budgetCapUsd(): number {
  const raw = process.env.FOREMAN_BUDGET_USD?.trim();
  if (!raw) return 8;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 8;
}

function loadPrices(pricesPath = path.resolve(__dirname, 'prices.json')): PricesFile {
  return JSON.parse(fs.readFileSync(pricesPath, 'utf-8')) as PricesFile;
}

export function getLedgerPath(runsDir = 'runs'): string {
  return path.resolve(runsDir, 'ledger.jsonl');
}

function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!fs.existsSync(ledgerPath)) return [];
  const content = fs.readFileSync(ledgerPath, 'utf-8');
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  prices: PricesFile
): number | null {
  const entry = prices[model];
  if (!entry) return null;
  if (entry.input_per_1k === null || entry.output_per_1k === null) return null;
  return (promptTokens / 1000) * entry.input_per_1k + (completionTokens / 1000) * entry.output_per_1k;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Throws if the model's price entry is missing or null in prices.json.
 */
export function assertPriceConfigured(model: string, pricesPath?: string): void {
  const prices = loadPrices(pricesPath);
  const entry = prices[model];
  if (!entry) {
    throw new Error(
      `Ledger: no price entry for model "${model}". Add it to src/model/prices.json before making model calls.`
    );
  }
  if (entry.input_per_1k === null || entry.output_per_1k === null) {
    throw new Error(
      `Ledger: price for model "${model}" is null in prices.json. Fill in input_per_1k and output_per_1k ` +
        `(estimates) from the provider's published list prices before running.`
    );
  }
}

/**
 * Pre-call guard: refuses (throws) when the price is unknown or the running
 * estimated total has reached the cap. Call this BEFORE issuing the model request.
 */
export function assertCallAllowed(model: string, runsDir = 'runs', pricesPath?: string): void {
  assertPriceConfigured(model, pricesPath);
  const spent = cumulativeCost(runsDir);
  const cap = budgetCapUsd();
  if (spent >= cap) {
    throw new Error(
      `Ledger: budget cap reached. Running estimated total $${spent.toFixed(6)} >= cap $${cap.toFixed(2)}. ` +
        `Set FOREMAN_BUDGET_USD to increase.`
    );
  }
}

/** Cumulative estimated cost from the ledger (null costs count as zero). */
export function cumulativeCost(runsDir = 'runs'): number {
  const entries = readLedger(getLedgerPath(runsDir));
  return entries.reduce((sum, entry) => sum + (entry.estimatedCostUsd ?? 0), 0);
}

/** Cumulative tokens from the ledger. */
export function cumulativeTokens(runsDir = 'runs'): { prompt: number; completion: number; total: number } {
  const entries = readLedger(getLedgerPath(runsDir));
  const prompt = entries.reduce((sum, entry) => sum + entry.promptTokens, 0);
  const completion = entries.reduce((sum, entry) => sum + entry.completionTokens, 0);
  return { prompt, completion, total: prompt + completion };
}

/**
 * Records a model call in the ledger.
 *
 * Always appends an entry so token usage is tracked, even when the price is null
 * (in which case estimatedCostUsd is null). Refuses (throws) when:
 *  - the price for the model is null in prices.json (after appending, so tokens
 *    are still tracked), or
 *  - the running estimated total has reached FOREMAN_BUDGET_USD (before appending), or
 *  - the cumulative token total would exceed STEP_MAX_TOTAL_TOKENS (before appending).
 */
export function recordModelCall(opts: {
  runId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  runsDir?: string;
  pricesPath?: string;
}): LedgerEntry {
  const { runId, model, promptTokens, completionTokens, runsDir = 'runs', pricesPath } = opts;

  const prices = loadPrices(pricesPath);
  const estimatedCostUsd = estimateCost(model, promptTokens, completionTokens, prices);
  const ledgerPath = getLedgerPath(runsDir);

  // Token cap is checked before appending.
  const totals = cumulativeTokens(runsDir);
  if (totals.total + promptTokens + completionTokens > STEP_MAX_TOTAL_TOKENS) {
    throw new Error(
      `Ledger: step token cap reached. Cumulative tokens ${totals.total} + this call would exceed ${STEP_MAX_TOTAL_TOKENS}.`
    );
  }

  // Budget cap is checked before appending (only meaningful when this call is costed).
  if (estimatedCostUsd !== null) {
    const spent = cumulativeCost(runsDir);
    const cap = budgetCapUsd();
    if (spent >= cap) {
      throw new Error(
        `Ledger: budget cap reached. Running estimated total $${spent.toFixed(6)} >= cap $${cap.toFixed(2)}. ` +
          `Set FOREMAN_BUDGET_USD to increase.`
      );
    }
  }

  const entry: LedgerEntry = {
    ts: new Date().toISOString(),
    runId,
    model,
    promptTokens,
    completionTokens,
    estimatedCostUsd,
  };

  const dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf-8');

  // Unknown price: token entry is recorded, then the call is refused.
  if (estimatedCostUsd === null) {
    throw new Error(
      `Ledger: price for model "${model}" is null in prices.json; the call was refused because the budget cap ` +
        `cannot be enforced. Token usage (${promptTokens}/${completionTokens}) was recorded.`
    );
  }

  return entry;
}
