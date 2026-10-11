/**
 * DEV MEASUREMENT TOOL — not part of the Foreman agent or its decisions.
 * Runs the prescribed sequential model-only Step 10 sample and computes every
 * aggregate from run facts, ledger entries, and generated artifacts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertStepBudgetAllowed, assertStepRunAllowed, cumulativeTokens } from '../src/model/index.js';
import { deriveStatus } from '../src/state/derive.js';
import type { Fact } from '../src/state/facts.js';

export type ChildStatus = 'completed' | 'transient' | 'crashed' | 'timed_out';

export interface ChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: Error | undefined;
  stdout: string | null;
  stderr: string | null;
  timedOut: boolean;
}

export interface MeasurementRow {
  issue: string;
  mode: string;
  runId: string;
  status: 'completed' | 'timed_out';
  exitCode: number | null;
  derivedStatus: string;
  attempts: number;
  testsProtectedFailed: boolean;
  tokens: number;
  gatewayCostUsd: number | null;
  wallSeconds: number | null;
  traceId: string | null;
  holdoutResult: 'passed' | 'failed' | 'n/a';
}

export interface ResultAggregate {
  issue: string;
  mode: 'graph' | 'no-graph' | 'unknown';
  n: number;
  shipped: number;
  shippedAndHeldoutPassed: number;
  testsProtectedFailed: number;
  meanAttempts: string;
  meanTokens: string;
  meanGatewayCostUsd: string;
  rows: MeasurementRow[];
}

const transientFailurePattern =
  /429|rate limit|timed out|timeout|socket hang up|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|temporarily unavailable|bad gateway|service unavailable/i;

export function classifyChild(child: ChildResult): ChildStatus {
  if (child.timedOut) return 'timed_out';

  const combined = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
  if (/Run ID: (run-\d+)/.test(combined)) return 'completed';
  if (transientFailurePattern.test(`${combined}\n${child.error?.message ?? ''}`)) {
    return 'transient';
  }
  return 'crashed';
}

const root = process.cwd();
const baselinePath = path.resolve('.foreman-work', 'step10-start.json');
const resultsDir = path.resolve('docs', 'evidence', 'measurements');
let rows: MeasurementRow[] = [];
const plan = [
  ...['1', '2', '3'].flatMap((issue) => Array.from({ length: 3 }, () => ({ issue, mode: 'graph' as const }))),
  ...['1', '2', '3'].flatMap((issue) => Array.from({ length: 2 }, () => ({ issue, mode: 'no-graph' as const }))),
];
let consecutiveTransientFailures = 0;
let stoppedReason: string | undefined;

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function runFolders(): string[] {
  return fs.existsSync('runs')
    ? fs.readdirSync('runs', { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('run-')).map((d) => d.name)
    : [];
}

export function mergeRows(existing: readonly MeasurementRow[], additions: readonly MeasurementRow[]): MeasurementRow[] {
  const merged = new Map<string, MeasurementRow>();
  for (const row of existing) merged.set(row.runId, row);
  for (const row of additions) {
    if (!merged.has(row.runId)) merged.set(row.runId, row);
  }
  return Array.from(merged.values());
}

function loadExistingRows(): MeasurementRow[] {
  const file = path.join(resultsDir, 'results.json');
  if (!fs.existsSync(file)) return [];
  const value = readJson<unknown>(file);
  if (!Array.isArray(value)) throw new Error(`Measurement results must be an array: ${file}`);
  return value as MeasurementRow[];
}

function writeResults(additions: readonly MeasurementRow[] = []): void {
  fs.mkdirSync(resultsDir, { recursive: true });
  rows = mergeRows(loadExistingRows(), mergeRows(rows, additions));
  fs.writeFileSync(path.join(resultsDir, 'results.json'), JSON.stringify(rows, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(resultsDir, 'results.md'), renderMarkdown(), 'utf-8');
}

export function formatFinishedLine(
  index: number,
  total: number,
  child: ChildStatus,
  row: Pick<MeasurementRow, 'derivedStatus' | 'attempts' | 'holdoutResult' | 'tokens'> | undefined,
  elapsedSeconds: string
): string {
  return `Finished ${index}/${total} child=${child} derived=${row?.derivedStatus ?? 'n/a'} attempts=${row?.attempts ?? 0} holdout=${row?.holdoutResult ?? 'n/a'} tokens=${row?.tokens ?? 0} elapsed=${elapsedSeconds}s`;
}

function mean(values: number[], digits: number): string {
  return values.length === 0
    ? 'n/a'
    : (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(digits);
}

export function aggregateResults(rows: readonly MeasurementRow[]): ResultAggregate[] {
  const issues = Array.from(new Set(['1', '2', '3', ...rows.map((row) => row.issue)])).sort(
    (left, right) => left.localeCompare(right, undefined, { numeric: true })
  );
  const modes = ['graph', 'no-graph', 'unknown'] as const;
  return issues.flatMap((issue) =>
    modes.map((mode) => {
      const group = rows.filter((row) => row.issue === issue && row.mode === mode);
      const costs = group.flatMap((row) => (row.gatewayCostUsd === null ? [] : [row.gatewayCostUsd]));
      return {
        issue,
        mode,
        n: group.length,
        shipped: group.filter((row) => row.derivedStatus === 'shipped').length,
        shippedAndHeldoutPassed: group.filter(
          (row) => row.derivedStatus === 'shipped' && row.holdoutResult === 'passed'
        ).length,
        testsProtectedFailed: group.filter((row) => row.testsProtectedFailed).length,
        meanAttempts: mean(group.map((row) => row.attempts), 2),
        meanTokens: mean(group.map((row) => row.tokens), 0),
        meanGatewayCostUsd: mean(costs, 6),
        rows: group,
      };
    })
  );
}

export function runsAfterBaseline(currentRunIds: readonly string[], baselineRunIds: readonly string[]): string[] {
  const baseline = new Set(baselineRunIds);
  return currentRunIds.filter((runId) => !baseline.has(runId)).sort((a, b) => a.localeCompare(b));
}

function renderMarkdown(): string {
  const aggregates = aggregateResults(rows);
  const sections: string[] = [
    '# Step 10 measurements',
    '',
    'Sample sizes are small; differences are not statistically meaningful.',
    '',
    '| Issue | Mode | n | Shipped k/n | Shipped and held-out passed k/n | tests_protected failed k/n | Mean attempts | Mean tokens | Mean gateway cost (USD) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const aggregate of aggregates) {
    sections.push(
      `| ${aggregate.issue} | ${aggregate.mode} | ${aggregate.n} | ${aggregate.shipped}/${aggregate.n} | ${aggregate.shippedAndHeldoutPassed}/${aggregate.n} | ${aggregate.testsProtectedFailed}/${aggregate.n} | ${aggregate.meanAttempts} | ${aggregate.meanTokens} | ${aggregate.meanGatewayCostUsd} |`
    );
  }
  if (rows.length === 0) sections.push('', 'No measurement runs have been recorded.');
  sections.push(
    '',
    '## Runs',
    '',
    '| Run ID | Issue | Mode | Outcome | Attempts | Holdout | Tests protected failed | Tokens | Gateway cost (USD) | Wall seconds | Trace ID |',
    '| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | --- |'
  );
  for (const row of rows) {
    sections.push(
      `| ${row.runId} | ${row.issue} | ${row.mode} | ${row.derivedStatus} | ${row.attempts} | ${row.holdoutResult} | ${row.testsProtectedFailed} | ${row.tokens} | ${row.gatewayCostUsd?.toFixed(6) ?? 'n/a'} | ${row.wallSeconds?.toFixed(2) ?? 'n/a'} | ${row.traceId ?? 'n/a'} |`
    );
  }
  if (stoppedReason) sections.push('', `Stopped early: ${stoppedReason}`);
  return sections.join('\n') + '\n';
}

export function collectRow(runId: string, runsDir = 'runs'): Omit<MeasurementRow, 'status' | 'exitCode'> {
  const runDir = path.join(runsDir, runId);
  const factsPath = path.join(runDir, 'facts.jsonl');
  const facts: Fact[] = fs.existsSync(factsPath)
    ? fs.readFileSync(factsPath, 'utf-8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Fact)
    : [];
  const ledgerPath = path.join(runsDir, 'ledger.jsonl');
  const ledger = fs.existsSync(ledgerPath)
    ? fs
        .readFileSync(ledgerPath, 'utf-8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { runId: string; promptTokens: number; completionTokens: number; gatewayCostUsd: number | null })
        .filter((entry) => entry.runId === runId)
    : [];
  const gates = fs.readdirSync(runDir).filter((name) => /^gate-\d+\.json$/.test(name));
  const testsProtectedFailed = facts.some(
    (fact) => fact.type === 'gate_result' && fact.failedRules.includes('tests_protected')
  ) || gates.some((name) => {
    const gate = readJson<{ rules: { ruleId: string; passed: boolean; skipped?: boolean }[] }>(path.join(runDir, name));
    return gate.rules.some((rule) => rule.ruleId === 'tests_protected' && !rule.passed && !rule.skipped);
  });
  const holdout = facts.find((fact) => fact.type === 'holdout_result');
  const reportPath = path.join(runDir, 'report.md');
  const consolePath = path.join(runDir, 'console.log');
  const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf-8') : '';
  const consoleLog = fs.existsSync(consolePath) ? fs.readFileSync(consolePath, 'utf-8') : '';
  const runStarted = facts.find((fact) => fact.type === 'run_started');
  const modeFact = facts.find((fact) => {
    const fields = fact as Fact & { mode?: unknown; noGraph?: unknown; graphMode?: unknown };
    return fields.mode !== undefined || fields.noGraph !== undefined || fields.graphMode !== undefined;
  }) as (Fact & { mode?: unknown; noGraph?: unknown; graphMode?: unknown }) | undefined;
  const modeFromFacts =
    modeFact?.mode === 'graph' || modeFact?.mode === 'no-graph' || modeFact?.mode === 'unknown'
      ? modeFact.mode
      : modeFact?.noGraph === true || modeFact?.graphMode === 'no-graph'
        ? 'no-graph'
        : modeFact?.noGraph === false || modeFact?.graphMode === 'graph'
          ? 'graph'
          : 'unknown';
  const mode = /NO GRAPH MODE/.test(consoleLog)
    ? 'no-graph'
    : modeFromFacts;
  const economicsPath = path.join(runDir, 'economics.json');
  const economics = fs.existsSync(economicsPath) ? readJson<{ wallTimeMs?: number }>(economicsPath) : {};
  const traceId =
    report.match(/^Trace ID: (.+)$/m)?.[1] ?? consoleLog.match(/^Trace ID: (.+)$/m)?.[1] ?? null;
  const attempts = Math.max(0, ...facts.flatMap((fact) => ('attempt' in fact && typeof fact.attempt === 'number' ? [fact.attempt] : [])));
  const gatewayCosts = ledger.flatMap((entry) => (entry.gatewayCostUsd === null ? [] : [entry.gatewayCostUsd]));
  return {
    issue: runStarted?.type === 'run_started' ? runStarted.issueId : 'unknown',
    mode,
    runId,
    derivedStatus: deriveStatus(facts),
    attempts,
    testsProtectedFailed,
    tokens: ledger.reduce((sum, entry) => sum + entry.promptTokens + entry.completionTokens, 0),
    gatewayCostUsd: gatewayCosts.length === 0 ? null : gatewayCosts.reduce((sum, value) => sum + value, 0),
    wallSeconds: economics.wallTimeMs === undefined ? null : economics.wallTimeMs / 1000,
    traceId,
    holdoutResult: holdout?.type === 'holdout_result' ? (holdout.passed ? 'passed' : 'failed') : 'n/a',
  };
}

export function rebuildRows(runsDir: string, baselineRunIds: readonly string[]): MeasurementRow[] {
  return runsAfterBaseline(
    fs.existsSync(runsDir)
      ? fs.readdirSync(runsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
          .map((entry) => entry.name)
      : [],
    baselineRunIds
  ).map((runId) => ({
    ...collectRow(runId, runsDir),
    status: 'completed',
    exitCode: null,
  }));
}

async function main(): Promise<void> {
  rows = loadExistingRows();
  const args = process.argv.slice(2);
  let dryRun = false;
  let rebuildFromRuns = false;
  let startAt = 0;
  let onlyIssue: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--rebuild-from-runs') {
      rebuildFromRuns = true;
    } else if (arg === '--start-at' || arg === '--only-issue') {
      const value = args[++index];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error(`${arg} requires a non-negative integer.`);
      }
      if (arg === '--start-at') {
        startAt = Number(value);
      } else {
        onlyIssue = value;
        if (!['1', '2', '3'].includes(onlyIssue)) {
          throw new Error('--only-issue must be 1, 2, or 3.');
        }
      }
    } else if (arg !== '--initialize-only') {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const selectedPlan = plan
    .filter((item) => onlyIssue === undefined || item.issue === onlyIssue)
    .slice(startAt);
  if (dryRun) {
    console.log(`Measurement plan (${selectedPlan.length} runs):`);
    selectedPlan.forEach((item, index) => {
      console.log(`${index + 1}/${selectedPlan.length} issue=${item.issue} mode=${item.mode}`);
    });
    return;
  }

  if (!fs.existsSync(baselinePath)) throw new Error(`Step 10 baseline missing: ${baselinePath}`);
  process.env.FOREMAN_STEP_BASELINE = baselinePath;
  process.env.FOREMAN_STEP_TOKEN_CAP ??= '260000';
  if (rebuildFromRuns) {
    const baseline = readJson<{ runFolders: string[] }>(baselinePath);
    if (!Array.isArray(baseline.runFolders) || baseline.runFolders.some((folder) => typeof folder !== 'string')) {
      throw new Error('Step 10 baseline must contain a runFolders list.');
    }
    const foundRows = rebuildRows('runs', baseline.runFolders);
    const existingIds = new Set(rows.map((row) => row.runId));
    const addedRows = foundRows.filter((row) => !existingIds.has(row.runId));
    console.log(`Rebuild found ${foundRows.length} post-baseline run(s); added ${addedRows.length} new row(s).`);
    for (const row of foundRows) {
      console.log(`Found ${row.runId}${existingIds.has(row.runId) ? ' (already recorded)' : ' (added)'}`);
    }
    writeResults(addedRows);
    console.log(fs.readFileSync(path.join(resultsDir, 'results.md'), 'utf-8'));
    return;
  }
  if (args.includes('--initialize-only')) {
    writeResults();
    console.log('Initialized empty measurement results; no runs or model calls were made.');
    return;
  }

  const timeoutMs = Number(process.env.FOREMAN_RUN_TIMEOUT_MS ?? 600000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('FOREMAN_RUN_TIMEOUT_MS must be a positive safe integer.');
  }

  const tsx = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
  const cli = path.resolve('src', 'cli', 'index.ts');

  for (const [index, item] of selectedPlan.entries()) {
    try {
      assertStepRunAllowed();
      assertStepBudgetAllowed();
    } catch (error) {
      stoppedReason = error instanceof Error ? error.message : String(error);
      break;
    }
    console.log(`Starting ${index + 1}/${selectedPlan.length} issue=${item.issue} mode=${item.mode}`);
    const cliArgs = [tsx, cli, 'run', '--issue', item.issue];
    if (item.mode === 'no-graph') cliArgs.push('--no-graph');
    const startedAt = Date.now();
    const child = spawnSync(process.execPath, cliArgs, {
      cwd: root,
      encoding: 'utf-8',
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const combined = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
    const runId = combined.match(/Run ID: (run-\d+)/)?.[1];
    const childStatus = classifyChild({
      status: child.status,
      signal: child.signal,
      error: child.error,
      stdout: child.stdout,
      stderr: child.stderr,
      timedOut:
        child.error !== undefined && /ETIMEDOUT|timed out/i.test(child.error.message),
    });
    let row: MeasurementRow | undefined;
    if (runId && (childStatus === 'completed' || childStatus === 'timed_out')) {
      row = {
        ...collectRow(runId),
        issue: item.issue,
        mode: item.mode,
        status: childStatus,
        exitCode: child.status,
      };
      writeResults([row]);
    }
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(formatFinishedLine(index + 1, selectedPlan.length, childStatus, row, elapsedSeconds));

    if (childStatus === 'transient') {
      consecutiveTransientFailures++;
      if (consecutiveTransientFailures >= 3) {
        stoppedReason = 'three consecutive transient failures';
        break;
      }
      continue;
    }
    consecutiveTransientFailures = 0;
    if (childStatus === 'crashed') {
      stoppedReason =
        combined.match(/Ledger: [^\r\n]+/)?.[0] ?? `run process crashed (exit=${child.status}, signal=${child.signal})`;
      break;
    }
    if (childStatus === 'timed_out') {
      stoppedReason = `run process timed out after ${timeoutMs}ms`;
      break;
    }
  }
  writeResults();
  const tokens = cumulativeTokens().total;
  const baseline = readJson<{ cumulativeTokens: number }>(baselinePath);
  console.log(`Step token growth: ${Math.max(0, tokens - baseline.cumulativeTokens)}`);
  if (stoppedReason) console.log(`Measurement stopped: ${stoppedReason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`Measurement failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
