/**
 * DEV MEASUREMENT TOOL — not part of the Foreman agent or its decisions.
 * Runs the prescribed sequential model-only Step 10 sample and computes every
 * aggregate from run facts, ledger entries, and generated artifacts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertStepBudgetAllowed, assertStepRunAllowed, cumulativeTokens } from '../src/model/index.js';
import { deriveStatus } from '../src/state/derive.js';
import type { Fact } from '../src/state/facts.js';

interface MeasurementRow {
  issue: string;
  mode: 'graph' | 'no-graph';
  runId: string;
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

function collectRow(runId: string, issue: string, mode: 'graph' | 'no-graph'): MeasurementRow {
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
  if (!fs.existsSync(baselinePath)) throw new Error(`Step 10 baseline missing: ${baselinePath}`);
  process.env.FOREMAN_STEP_BASELINE = baselinePath;
  process.env.FOREMAN_STEP_TOKEN_CAP ??= '260000';
  if (process.argv.includes('--initialize-only')) {
    writeResults();
    console.log('Initialized empty measurement results; no runs or model calls were made.');
    return;
  }

  const tsx = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
  const cli = path.resolve('src', 'cli', 'index.ts');

  for (const item of plan) {
    try {
      assertStepRunAllowed();
      assertStepBudgetAllowed();
    } catch (error) {
      stoppedReason = error instanceof Error ? error.message : String(error);
      break;
    }
    const args = [tsx, cli, 'run', '--issue', item.issue];
    if (item.mode === 'no-graph') args.push('--no-graph');
    const child = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf-8',
      env: process.env,
    });
    const combined = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
    const runId = combined.match(/Run ID: (run-\d+)/)?.[1];
    if (!runId) {
      stoppedReason = combined.match(/Ledger: [^\r\n]+/)?.[0] ?? `run process exited ${child.status}`;
      const transient = /429|rate limit|timed out|timeout|socket hang up|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|temporarily unavailable|bad gateway|service unavailable/i.test(combined);
      if (transient) {
        consecutiveTransientFailures++;
      } else {
        consecutiveTransientFailures = 0;
      }
      if (consecutiveTransientFailures >= 3) break;
      if (child.status !== 0 && !transient) break;
      continue;
    }
    const row = collectRow(runId, item.issue, item.mode);
    rows.push(row);
    writeResults();
    console.log(`${row.runId}: issue=${row.issue} mode=${row.mode} status=${row.derivedStatus} attempts=${row.attempts} tokens=${row.tokens}`);
    const transient = /429|rate limit|timed out|timeout|socket hang up|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|temporarily unavailable|bad gateway|service unavailable/i.test(combined);
    consecutiveTransientFailures = transient
      ? consecutiveTransientFailures + 1
      : 0;
    if (consecutiveTransientFailures >= 3) {
      stoppedReason = 'three consecutive transient failures';
      break;
    }
    if (child.status !== 0 && !transient) {
      stoppedReason = `run ${runId} exited ${child.status}`;
      break;
    }
    if (/^Stopped\r?$/m.test(combined) && !transient) {
      stoppedReason = `run ${runId} stopped before completion`;
      break;
    }
  }
  writeResults();
  const tokens = cumulativeTokens().total;
  const baseline = readJson<{ cumulativeTokens: number }>(baselinePath);
  console.log(`Step token growth: ${Math.max(0, tokens - baseline.cumulativeTokens)}`);
  if (stoppedReason) console.log(`Measurement stopped: ${stoppedReason}`);
}

main().catch((error: unknown) => {
  console.error(`Measurement failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
