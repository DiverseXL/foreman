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

interface MeasurementRow {
  issue: string;
  mode: 'graph' | 'no-graph';
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

const root = process.cwd();
const baselinePath = path.resolve('.foreman-work', 'step10-start.json');
const resultsDir = path.resolve('docs', 'evidence', 'measurements');
const rows: MeasurementRow[] = [];
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

function writeResults(): void {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'results.json'), JSON.stringify(rows, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(resultsDir, 'results.md'), renderMarkdown(), 'utf-8');
}

function formatMean(values: number[], digits = 2): string {
  return values.length === 0
    ? 'n/a'
    : (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(digits);
}

function renderMarkdown(): string {
  const sections: string[] = [
    '# Step 10 measurements',
    '',
    'Sample sizes are small; differences are not statistically meaningful.',
    '',
    '| Issue | Mode | Shipped k/n | Shipped and held-out passed k/n | Mean attempts | Mean tokens | Mean gateway cost (USD) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const issue of ['1', '2', '3']) {
    for (const mode of ['graph', 'no-graph'] as const) {
      const group = rows.filter((row) => row.issue === issue && row.mode === mode);
      const sampleSize = group.length;
      const shipped = group.filter((row) => row.derivedStatus === 'shipped').length;
      const shippedHeldout = group.filter(
        (row) => row.derivedStatus === 'shipped' && row.holdoutResult === 'passed'
      ).length;
      const costs = group.flatMap((row) => (row.gatewayCostUsd === null ? [] : [row.gatewayCostUsd]));
      sections.push(
        `| ${issue} | ${mode} | ${shipped}/${sampleSize} | ${shippedHeldout}/${sampleSize} | ${formatMean(group.map((r) => r.attempts))} | ${formatMean(group.map((r) => r.tokens), 0)} | ${formatMean(costs, 6)} |`
      );
    }
  }
  if (rows.length === 0) sections.push('', 'No measurement runs have been recorded.');
  if (stoppedReason) sections.push('', `Stopped early: ${stoppedReason}`);
  return sections.join('\n') + '\n';
}

function collectRow(
  runId: string,
  issue: string,
  mode: 'graph' | 'no-graph'
): Omit<MeasurementRow, 'status' | 'exitCode'> {
  const runDir = path.join('runs', runId);
  const facts = fs
    .readFileSync(path.join(runDir, 'facts.jsonl'), 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Fact);
  const ledger = fs
    .readFileSync(path.join('runs', 'ledger.jsonl'), 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { runId: string; promptTokens: number; completionTokens: number; gatewayCostUsd: number | null })
    .filter((entry) => entry.runId === runId);
  const gates = fs.readdirSync(runDir).filter((name) => /^gate-\d+\.json$/.test(name));
  const testsProtectedFailed = gates.some((name) => {
    const gate = readJson<{ rules: { ruleId: string; passed: boolean; skipped?: boolean }[] }>(path.join(runDir, name));
    return gate.rules.some((rule) => rule.ruleId === 'tests_protected' && !rule.passed && !rule.skipped);
  });
  const holdout = facts.find((fact) => fact.type === 'holdout_result');
  const reportPath = path.join(runDir, 'report.md');
  const consolePath = path.join(runDir, 'console.log');
  const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf-8') : '';
  const consoleLog = fs.existsSync(consolePath) ? fs.readFileSync(consolePath, 'utf-8') : '';
  const economicsPath = path.join(runDir, 'economics.json');
  const economics = fs.existsSync(economicsPath) ? readJson<{ wallTimeMs?: number }>(economicsPath) : {};
  const traceId =
    report.match(/^Trace ID: (.+)$/m)?.[1] ?? consoleLog.match(/^Trace ID: (.+)$/m)?.[1] ?? null;
  const attempts = Math.max(0, ...facts.flatMap((fact) => ('attempt' in fact && typeof fact.attempt === 'number' ? [fact.attempt] : [])));
  const gatewayCosts = ledger.flatMap((entry) => (entry.gatewayCostUsd === null ? [] : [entry.gatewayCostUsd]));
  return {
    issue,
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dryRun = false;
  let startAt = 0;
  let onlyIssue: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
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
        ...collectRow(runId, item.issue, item.mode),
        status: childStatus,
        exitCode: child.status,
      };
      rows.push(row);
      writeResults();
    }
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(
      `Finished ${index + 1}/${selectedPlan.length} status=${childStatus} attempts=${row?.attempts ?? 0} tokens=${row?.tokens ?? 0} elapsed=${elapsedSeconds}s`
    );

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
