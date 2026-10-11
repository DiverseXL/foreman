import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface EconomicsRun {
  issue: string;
  runId: string;
  derivedStatus: string;
  attempts: number;
  tokens: number;
  gatewayCostUsd: number | null;
  wallSeconds: number | null;
  holdoutResult: 'passed' | 'failed' | 'n/a';
}

export interface EconomicsLedgerEntry {
  runId: string;
  promptTokens: number;
  completionTokens: number;
  gatewayCostUsd: number | null;
}

interface MetricRow {
  population: string;
  metric: string;
  value: string;
  n: number | '';
  unit: string;
  numerator: number | '';
  denominator: number | '';
  classification: 'MEASURED' | 'ASSUMPTION, NOT MEASURED';
}

const businessInputs = [
  'price per fix',
  'fixes per customer per month',
  'customers',
  'fixed infrastructure cost',
  'engineering hours saved per fix',
  'hourly engineering cost',
  'starting cash',
];

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function fixed(value: number, digits = 6): string {
  return value.toFixed(digits);
}

function quoteCsv(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildEconomicsRows(
  runs: readonly EconomicsRun[],
  ledger: readonly EconomicsLedgerEntry[]
): MetricRow[] {
  const issues = Array.from(new Set(runs.map((run) => run.issue))).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const populations = [
    ...issues.map((issue) => ({ name: `issue ${issue}`, runs: runs.filter((run) => run.issue === issue) })),
    { name: 'overall', runs: [...runs] },
  ];
  const ledgerByRun = new Map<string, EconomicsLedgerEntry[]>();
  for (const entry of ledger) {
    const values = ledgerByRun.get(entry.runId) ?? [];
    values.push(entry);
    ledgerByRun.set(entry.runId, values);
  }

  const output: MetricRow[] = [];
  for (const population of populations) {
    const sample = population.runs;
    const shipped = sample.filter((run) => run.derivedStatus === 'shipped');
    const shippedHeldout = shipped.filter((run) => run.holdoutResult === 'passed');
    const validAttempts = sample.filter((run) => finite(run.attempts));
    const tokenTotal = sum(sample.filter((run) => finite(run.tokens)).map((run) => run.tokens));
    const attemptTotal = sum(validAttempts.map((run) => run.attempts));
    const perRunLedger = sample.map((run) => {
      const entries = ledgerByRun.get(run.runId) ?? [];
      const costs = entries.map((entry) => entry.gatewayCostUsd).filter(finite);
      return {
        runId: run.runId,
        cost: costs.length > 0 ? sum(costs) : null,
        tokenCount: sum(
          entries.flatMap((entry) =>
            finite(entry.promptTokens) && finite(entry.completionTokens)
              ? [entry.promptTokens + entry.completionTokens]
              : []
          )
        ),
      };
    });
    const measuredCosts = perRunLedger.filter((entry) => entry.cost !== null);
    const totalGatewayCost = sum(measuredCosts.map((entry) => entry.cost as number));
    const measuredTokenCount = sum(perRunLedger.map((entry) => entry.tokenCount));
    const shippedWithCost = perRunLedger.filter(
      (entry) => entry.cost !== null && shipped.some((run) => run.runId === entry.runId)
    );
    const wallTimes = sample.map((run) => run.wallSeconds).filter(finite);

    const add = (
      metric: string,
      value: string,
      n: number,
      unit: string,
      numerator: number | '' = '',
      denominator: number | '' = ''
    ): void => {
      output.push({
        population: population.name,
        metric,
        value,
        n,
        unit,
        numerator,
        denominator,
        classification: 'MEASURED',
      });
    };

    add('success rate', `${shipped.length}/${sample.length}`, sample.length, 'shipped runs / runs', shipped.length, sample.length);
    add(
      'shipped-and-held-out-passed rate',
      `${shippedHeldout.length}/${sample.length}`,
      sample.length,
      'runs',
      shippedHeldout.length,
      sample.length
    );
    add(
      'mean attempts per run',
      validAttempts.length ? fixed(attemptTotal / validAttempts.length, 3) : 'n/a',
      validAttempts.length,
      'attempts/run'
    );
    add(
      'mean tokens per attempt',
      attemptTotal > 0 ? fixed(measuredTokenCount / attemptTotal, 3) : 'n/a',
      attemptTotal,
      'tokens/attempt',
      measuredTokenCount,
      attemptTotal
    );
    add(
      'blended gateway cost per 1M tokens',
      measuredTokenCount > 0 ? fixed((totalGatewayCost / measuredTokenCount) * 1_000_000, 6) : 'n/a',
      measuredTokenCount,
      'USD/1M tokens',
      totalGatewayCost,
      measuredTokenCount
    );
    add(
      'mean gateway cost per run',
      measuredCosts.length ? fixed(totalGatewayCost / measuredCosts.length, 6) : 'n/a',
      measuredCosts.length,
      'USD/run'
    );
    add(
      'gateway cost per shipped fix',
      shippedWithCost.length
        ? fixed(sum(shippedWithCost.map((entry) => entry.cost as number)) / shippedWithCost.length, 6)
        : 'n/a',
      shippedWithCost.length,
      'USD/shipped fix'
    );
    add(
      'mean wall seconds',
      wallTimes.length ? fixed(sum(wallTimes) / wallTimes.length, 3) : 'n/a',
      wallTimes.length,
      'seconds/run'
    );
  }

  for (const metric of businessInputs) {
    output.push({
      population: 'business inputs',
      metric,
      value: '',
      n: '',
      unit: '',
      numerator: '',
      denominator: '',
      classification: 'ASSUMPTION, NOT MEASURED',
    });
  }
  return output;
}

export function renderEconomicsCsv(rows: readonly MetricRow[]): string {
  const columns: (keyof MetricRow)[] = [
    'population',
    'metric',
    'value',
    'n',
    'unit',
    'numerator',
    'denominator',
    'classification',
  ];
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => quoteCsv(row[column])).join(',')),
  ].join('\n') + '\n';
}

export function renderEconomicsMarkdown(rows: readonly MetricRow[]): string {
  const measured = rows.filter((row) => row.classification === 'MEASURED');
  const assumptions = rows.filter((row) => row.classification !== 'MEASURED');
  const lines = [
    '# CFO inputs',
    '',
    '## Measured values',
    '',
    '| Population | Measure | Value | n | Unit |',
    '| --- | --- | ---: | ---: | --- |',
    ...measured.map((row) => `| ${row.population} | ${row.metric} | ${row.value} | ${row.n} | ${row.unit} |`),
    '',
    'Gateway costs below are reported by the gateway on a shared participant key; they are not isolated per-user infrastructure costs.',
    'The benchmark fixture is synthetic.',
    '',
    '## Business inputs',
    '',
    'These are assumptions to be supplied by a human. No values are measured here.',
    '',
    '| Input | Classification | Value |',
    '| --- | --- | --- |',
    ...assumptions.map((row) => `| ${row.metric} | ${row.classification} | |`),
    '',
  ];
  return lines.join('\n');
}

function readLedger(file: string): EconomicsLedgerEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EconomicsLedgerEntry);
}

export function exportEconomics(root = process.cwd()): { csvPath: string; markdownPath: string } {
  const resultsPath = path.join(root, 'docs', 'evidence', 'measurements', 'results.json');
  const runs = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as EconomicsRun[];
  const ledger = readLedger(path.join(root, 'runs', 'ledger.jsonl'));
  const rows = buildEconomicsRows(runs, ledger);
  const outputDir = path.join(root, 'docs', 'evidence', 'cfo');
  fs.mkdirSync(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, 'inputs.csv');
  const markdownPath = path.join(outputDir, 'inputs.md');
  fs.writeFileSync(csvPath, renderEconomicsCsv(rows), 'utf8');
  fs.writeFileSync(markdownPath, renderEconomicsMarkdown(rows), 'utf8');
  return { csvPath, markdownPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const outputs = exportEconomics();
    console.log(`Wrote ${path.relative(process.cwd(), outputs.csvPath)}`);
    console.log(`Wrote ${path.relative(process.cwd(), outputs.markdownPath)}`);
    console.log(fs.readFileSync(outputs.markdownPath, 'utf8'));
  } catch (error) {
    console.error(`Economics export failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
