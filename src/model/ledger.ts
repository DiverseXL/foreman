/**
 * Cost and token ledger for Foreman model calls.
 *
 * One JSON line per model call in runs/ledger.jsonl. Costs come from the
 * gateway-reported headers when present (x-litellm-response-cost); the
 * price-based estimate is only a fallback when a header is absent.
 *
 * Refusal semantics (fail closed):
 *  - Pre-call (assertCallAllowed): refuse when the running cost has reached
 *    FOREMAN_BUDGET_USD, or when the last reported key spend plus RESERVE_USD
 *    would exceed the reported key max budget.
 *  - Post-call (recordModelCall): append the entry (so tokens and spend are
 *    always tracked), then refuse when no cost could be determined at all, or
 *    when this call's reported spend + reserve exceeds the reported max budget.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CostSource = 'gateway' | 'estimate' | 'none';

export interface LedgerEntry {
  ts: string;
  runId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** price-based estimate (fallback only); null when the price is not configured */
  estimatedCostUsd: number | null;
  /** gateway-reported cost from x-litellm-response-cost; null when absent */
  gatewayCostUsd: number | null;
  /** effective cost used for the budget: gateway cost, else the estimate */
  costUsd: number | null;
  costSource: CostSource;
  /** gateway-reported key spend (x-litellm-key-spend) */
  keySpendUsd: number | null;
  /** gateway-reported key max budget (x-litellm-key-max-budget) */
  keyMaxBudgetUsd: number | null;
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

export interface ModelCallCosts {
  gatewayCostUsd?: number | null;
  keySpendUsd?: number | null;
  keyMaxBudgetUsd?: number | null;
}

interface StepBaseline {
  ledgerLineCount: number;
  cumulativeTokens: number;
  keySpendUsd: number;
  runFolders: string[];
}

// ---------------------------------------------------------------------------
// Step-level caps
// ---------------------------------------------------------------------------

export const STEP_MAX_COMPLETION_TOKENS_PER_CALL = 6000;
export const STEP_MAX_TOTAL_TOKENS = 200000;
export const STEP_10_TOKEN_CAP = 260000;

export const STEP_MAX_PATCH_ATTEMPTS = 1;

/** Safety reserve, in USD, kept below the gateway key's max budget. */
export const RESERVE_USD = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function budgetCapUsd(): number {
  const raw = process.env.FOREMAN_BUDGET_USD?.trim();
  if (!raw) return 8;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 8;
}

/** True when reported spend plus the reserve would exceed the max budget. */
export function keyBudgetExceeded(spend: number | null, max: number | null): boolean {
  if (spend === null || max === null) return false;
  return spend + RESERVE_USD > max;
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

/** Most recently reported key spend/max budget from the ledger. */
export function latestKeyBudget(runsDir = 'runs'): { spend: number | null; max: number | null } {
  const entries = readLedger(getLedgerPath(runsDir));
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.keySpendUsd !== null || entry.keyMaxBudgetUsd !== null) {
      return { spend: entry.keySpendUsd ?? null, max: entry.keyMaxBudgetUsd ?? null };
    }
  }
  return { spend: null, max: null };
}

function stepBaseline(): StepBaseline | undefined {
  const location = process.env.FOREMAN_STEP_BASELINE?.trim();
  if (!location) return undefined;
  if (!fs.existsSync(location)) throw new Error(`Ledger: step baseline not found: ${location}`);
  const value = JSON.parse(fs.readFileSync(location, 'utf-8')) as Partial<StepBaseline>;
  if (
    typeof value.cumulativeTokens !== 'number' ||
    !Number.isFinite(value.cumulativeTokens) ||
    typeof value.ledgerLineCount !== 'number' ||
    !Number.isFinite(value.ledgerLineCount) ||
    typeof value.keySpendUsd !== 'number' ||
    !Number.isFinite(value.keySpendUsd) ||
    !Array.isArray(value.runFolders) ||
    value.runFolders.some((folder) => typeof folder !== 'string')
  ) {
    throw new Error('Ledger: step baseline must contain cumulativeTokens, keySpendUsd and runFolders.');
  }
  return value as StepBaseline;
}

export function stepTokenGrowth(runsDir = 'runs'): number {
  const baseline = stepBaseline();
  if (!baseline) return 0;
  const total = cumulativeTokens(runsDir).total;
  if (total < baseline.cumulativeTokens) throw new Error('Ledger: cumulative tokens are below the Step 10 baseline.');
  return total - baseline.cumulativeTokens;
}

export function stepKeySpendGrowth(runsDir = 'runs'): number | null {
  const baseline = stepBaseline();
  if (!baseline) return null;
  const entries = readLedger(getLedgerPath(runsDir));
  const newEntries = entries.slice(baseline.ledgerLineCount);
  if (newEntries.some((entry) => typeof entry.keySpendUsd !== 'number' || !Number.isFinite(entry.keySpendUsd))) {
    throw new Error('Ledger: Step 10 key spend growth cannot be verified because a new call omitted key spend.');
  }
  const current = latestKeyBudget(runsDir).spend;
  if (current === null) throw new Error('Ledger: key spend is unavailable after the Step 10 baseline.');
  if (current < baseline.keySpendUsd) throw new Error('Ledger: reported key spend is below the Step 10 baseline.');
  return current - baseline.keySpendUsd;
}

export function stepRunCount(runsDir = 'runs'): number {
  const baseline = stepBaseline();
  if (!baseline) return 0;
  if (!fs.existsSync(runsDir)) return 0;
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-') && !baseline.runFolders.includes(entry.name))
    .length;
}

export function assertStepRunAllowed(runsDir = 'runs'): void {
  if (!stepBaseline()) return;
  const maxRuns = 15;
  const started = stepRunCount(runsDir);
  if (started >= maxRuns) {
    throw new Error(`Ledger: Step 10 full-run cap reached. Runs ${started} >= cap ${maxRuns}.`);
  }
}

export function assertStepBudgetAllowed(runsDir = 'runs'): void {
  const baseline = stepBaseline();
  if (!baseline) return;
  const tokenCapRaw = process.env.FOREMAN_STEP_TOKEN_CAP?.trim();
  const tokenCap = tokenCapRaw ? Number(tokenCapRaw) : STEP_10_TOKEN_CAP;
  if (!Number.isFinite(tokenCap) || tokenCap <= 0) {
    throw new Error('Ledger: FOREMAN_STEP_TOKEN_CAP must be a positive number.');
  }

  const growth = stepTokenGrowth(runsDir);
  if (growth >= tokenCap) {
    throw new Error(`Ledger: step token cap reached. Growth ${growth} >= cap ${tokenCap}.`);
  }
  const spendGrowth = stepKeySpendGrowth(runsDir);
  if (spendGrowth !== null && spendGrowth >= 6) {
    throw new Error(`Ledger: step key spend cap reached. Growth $${spendGrowth.toFixed(6)} >= cap $6.00.`);
  }
}

function tokenCapForCurrentStep(runsDir: string): number {
  if (!stepBaseline()) return STEP_MAX_TOTAL_TOKENS;
  const raw = process.env.FOREMAN_STEP_TOKEN_CAP?.trim();
  const cap = raw ? Number(raw) : STEP_10_TOKEN_CAP;
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('Ledger: FOREMAN_STEP_TOKEN_CAP must be a positive number.');
  return cap;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Throws if the model's price entry is missing or null in prices.json. */
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
 * Pre-call guard. Refuses before the request when the running cost has reached
 * FOREMAN_BUDGET_USD, or when the last reported key spend + RESERVE_USD would
 * exceed the reported key max budget.
 */
export function assertCallAllowed(model: string, runsDir = 'runs'): void {
  assertStepBudgetAllowed(runsDir);
  const tokens = stepBaseline() ? stepTokenGrowth(runsDir) : cumulativeTokens(runsDir).total;
  const tokenCap = tokenCapForCurrentStep(runsDir);
  if (tokens >= tokenCap) {
    throw new Error(
      `Ledger: step token cap reached. Tokens ${tokens} >= cap ${tokenCap}.`
    );
  }

  const spent = cumulativeCost(runsDir);
  const cap = budgetCapUsd();
  if (spent >= cap) {
    throw new Error(
      `Ledger: budget cap reached. Running cost $${spent.toFixed(6)} >= cap $${cap.toFixed(2)}. ` +
        `Set FOREMAN_BUDGET_USD to increase.`
    );
  }

  const { spend, max } = latestKeyBudget(runsDir);
  if (keyBudgetExceeded(spend, max)) {
    throw new Error(
      `Ledger: key budget reserve reached. Reported key spend $${(spend ?? 0).toFixed(6)} + reserve ` +
        `$${RESERVE_USD.toFixed(2)} > max budget $${(max ?? 0).toFixed(2)} (model ${model}).`
    );
  }
}

/** Cumulative cost from the ledger (entries with no cost count as zero). */
export function cumulativeCost(runsDir = 'runs'): number {
  const entries = readLedger(getLedgerPath(runsDir));
  return entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
}

/** Cumulative tokens from the ledger. */
export function cumulativeTokens(runsDir = 'runs'): { prompt: number; completion: number; total: number } {
  const entries = readLedger(getLedgerPath(runsDir));
  const prompt = entries.reduce((sum, entry) => sum + entry.promptTokens, 0);
  const completion = entries.reduce((sum, entry) => sum + entry.completionTokens, 0);
  return { prompt, completion, total: prompt + completion };
}

export interface RunTotals {
  prompt: number;
  completion: number;
  total: number;
  cost: number;
  keySpendUsd: number | null;
  keyMaxBudgetUsd: number | null;
}

/** Totals for a single run, computed only from the ledger. */
export function runTotals(runId: string, runsDir = 'runs'): RunTotals {
  const entries = readLedger(getLedgerPath(runsDir)).filter((e) => e.runId === runId);
  const prompt = entries.reduce((sum, entry) => sum + entry.promptTokens, 0);
  const completion = entries.reduce((sum, entry) => sum + entry.completionTokens, 0);
  const cost = entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  let keySpendUsd: number | null = null;
  let keyMaxBudgetUsd: number | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].keySpendUsd !== null || entries[i].keyMaxBudgetUsd !== null) {
      keySpendUsd = entries[i].keySpendUsd ?? null;
      keyMaxBudgetUsd = entries[i].keyMaxBudgetUsd ?? null;
      break;
    }
  }
  return { prompt, completion, total: prompt + completion, cost, keySpendUsd, keyMaxBudgetUsd };
}

/**
 * Records a model call. Always appends an entry so tokens and spend are tracked.
 * Refuses (throws) when:
 *  - the running cost has reached FOREMAN_BUDGET_USD (before appending),
 *  - the cumulative token total would exceed STEP_MAX_TOTAL_TOKENS (before appending),
 *  - no cost could be determined (no gateway header and no configured price) — appended, then throws,
 *  - this call's reported key spend + RESERVE_USD exceeds the reported max budget — appended, then throws.
 */
export function recordModelCall(opts: {
  runId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  runsDir?: string;
  pricesPath?: string;
} & ModelCallCosts): LedgerEntry {
  const {
    runId,
    model,
    promptTokens,
    completionTokens,
    runsDir = 'runs',
    pricesPath,
    gatewayCostUsd = null,
    keySpendUsd = null,
    keyMaxBudgetUsd = null,
  } = opts;

  const prices = loadPrices(pricesPath);
  const estimatedCostUsd = estimateCost(model, promptTokens, completionTokens, prices);
  const costUsd = gatewayCostUsd !== null ? gatewayCostUsd : estimatedCostUsd;
  const costSource: CostSource =
    gatewayCostUsd !== null ? 'gateway' : estimatedCostUsd !== null ? 'estimate' : 'none';

  const ledgerPath = getLedgerPath(runsDir);

  // Token cap is checked before appending, relative to this step's baseline when configured.
  const totals = stepBaseline() ? stepTokenGrowth(runsDir) : cumulativeTokens(runsDir).total;
  const cap = tokenCapForCurrentStep(runsDir);
  if (totals + promptTokens + completionTokens > cap) {
    throw new Error(
      `Ledger: step token cap reached. Tokens ${totals} + this call would exceed ${cap}.`
    );
  }
  assertStepBudgetAllowed(runsDir);

  // Budget cap is checked before appending (only meaningful when this call is costed).
  if (costUsd !== null) {
    const spent = cumulativeCost(runsDir);
    const cap = budgetCapUsd();
    if (spent >= cap) {
      throw new Error(
        `Ledger: budget cap reached. Running cost $${spent.toFixed(6)} >= cap $${cap.toFixed(2)}. ` +
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
    gatewayCostUsd,
    costUsd,
    costSource,
    keySpendUsd,
    keyMaxBudgetUsd,
  };

  const dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf-8');
  assertStepBudgetAllowed(runsDir);

  // No cost could be determined: the entry is recorded, then the call is refused.
  if (costSource === 'none') {
    throw new Error(
      `Ledger: no gateway cost header and price for model "${model}" is null in prices.json; the call was ` +
        `refused because the budget cap cannot be enforced. Tokens (${promptTokens}/${completionTokens}) were recorded.`
    );
  }

  // Reported spend crossed the reserve threshold: recorded, then refused.
  if (keyBudgetExceeded(keySpendUsd, keyMaxBudgetUsd)) {
    throw new Error(
      `Ledger: key budget reserve reached. Reported key spend $${(keySpendUsd ?? 0).toFixed(6)} + reserve ` +
        `$${RESERVE_USD.toFixed(2)} > max budget $${(keyMaxBudgetUsd ?? 0).toFixed(2)}.`
    );
  }

  return entry;
}
