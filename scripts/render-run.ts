import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveStatus, type ForemanStatus } from '../src/state/derive.js';
import type { Fact } from '../src/state/facts.js';

interface RunLedgerEntry {
  runId: string;
  stage?: string;
  promptTokens: number;
  completionTokens: number;
  gatewayCostUsd: number | null;
}

interface StageTotal {
  promptTokens: number;
  completionTokens: number;
  gatewayCostUsd: number;
  calls: number;
  gatewayCostCalls: number;
}

const relevantTimelineTypes = new Set([
  'run_started',
  'workspace_reset',
  'patch_proposed',
  'gate_result',
  'tests_result',
  'validator_result',
  'attempt_failed',
  'holdout_result',
  'budget_checked',
  'needs_human',
  'shipped',
]);

function readJsonLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '<REPO>')
    .replace(/(?:\/[^/\s]+){2,}/g, '<REPO>');
}

function verdictLabel(status: ForemanStatus): string {
  switch (status) {
    case 'shipped':
      return 'SHIPPED';
    case 'needs_human':
      return 'NEEDS HUMAN';
    case 'blocked_policy':
      return 'BLOCKED BY POLICY';
    case 'budget_exhausted':
      return 'BUDGET EXHAUSTED';
    case 'patch_failed':
    case 'tests_failing':
    case 'rejected_validator':
      return 'PATCH FAILED';
    default:
      return `NOT SHIPPED (${status})`;
  }
}

function gatewayCost(total: StageTotal): string {
  return total.gatewayCostCalls > 0 ? total.gatewayCostUsd.toFixed(6) : 'n/a';
}

function buildStageTotals(ledger: readonly RunLedgerEntry[], runId: string): Map<string, StageTotal> {
  const stages = new Map<string, StageTotal>();
  for (const entry of ledger.filter((item) => item.runId === runId)) {
    const stage = entry.stage ?? 'other';
    const total = stages.get(stage) ?? {
      promptTokens: 0,
      completionTokens: 0,
      gatewayCostUsd: 0,
      calls: 0,
      gatewayCostCalls: 0,
    };
    total.promptTokens += entry.promptTokens;
    total.completionTokens += entry.completionTokens;
    total.calls++;
    if (typeof entry.gatewayCostUsd === 'number' && Number.isFinite(entry.gatewayCostUsd)) {
      total.gatewayCostUsd += entry.gatewayCostUsd;
      total.gatewayCostCalls++;
    }
    stages.set(stage, total);
  }
  return stages;
}

function formatGate(fact: Extract<Fact, { type: 'gate_result' }>): string {
  const failed = fact.failedRules.length ? fact.failedRules.join(', ') : 'none';
  return `Attempt ${fact.attempt}: ${fact.passed ? 'PASS' : 'FAIL'}; failed rules: ${safeText(failed)}`;
}

function renderReceipt(runId: string, facts: readonly Fact[], ledger: readonly RunLedgerEntry[]): {
  markdown: string;
  html: string;
} {
  const status = deriveStatus(facts);
  const verdict = verdictLabel(status);
  const runStarted = facts.find((fact) => fact.type === 'run_started');
  const issue = runStarted?.type === 'run_started' ? safeText(runStarted.issueId) : 'unknown';
  const attempts = Array.from(
    new Set(
      facts.flatMap((fact) =>
        'attempt' in fact && typeof fact.attempt === 'number'
          ? [fact.attempt]
          : []
      )
    )
  ).sort((a, b) => a - b);
  const gates = facts.filter((fact): fact is Extract<Fact, { type: 'gate_result' }> => fact.type === 'gate_result');
  const tests = facts.filter((fact): fact is Extract<Fact, { type: 'tests_result' }> => fact.type === 'tests_result');
  const codeVerdicts = facts.filter((fact): fact is Extract<Fact, { type: 'code_verdicts' }> => fact.type === 'code_verdicts');
  const validators = facts.filter((fact): fact is Extract<Fact, { type: 'validator_result' }> => fact.type === 'validator_result');
  const holdout = facts.find((fact): fact is Extract<Fact, { type: 'holdout_result' }> => fact.type === 'holdout_result');
  const traceFact = facts.find((fact) => {
    const fields = fact as Fact & { traceId?: unknown; trace_id?: unknown };
    return typeof fields.traceId === 'string' || typeof fields.trace_id === 'string';
  }) as (Fact & { traceId?: unknown; trace_id?: unknown }) | undefined;
  const traceValue = traceFact?.traceId ?? traceFact?.trace_id;
  const traceId = typeof traceValue === 'string' ? safeText(traceValue) : 'n/a';
  const stages = buildStageTotals(ledger, runId);
  const totalPrompt = Array.from(stages.values()).reduce((sum, stage) => sum + stage.promptTokens, 0);
  const totalCompletion = Array.from(stages.values()).reduce((sum, stage) => sum + stage.completionTokens, 0);
  const totalGatewayCost = Array.from(stages.values()).reduce((sum, stage) => sum + stage.gatewayCostUsd, 0);
  const totalCostCalls = Array.from(stages.values()).reduce((sum, stage) => sum + stage.gatewayCostCalls, 0);
  const holdoutResult = holdout ? (holdout.passed ? 'passed' : 'failed') : 'n/a';
  const timeline = facts.filter((fact) => relevantTimelineTypes.has(fact.type));

  const markdown = [
    `# Run receipt: ${safeText(runId)}`,
    '',
    `**Verdict: ${verdict}** (derived status: ${status})`,
    '',
    `Issue: ${issue}`,
    '',
    '## Gate results',
    '',
    '| Attempt | Result | Failed rule IDs |',
    '| ---: | --- | --- |',
    ...gates.map((fact) => `| ${fact.attempt} | ${fact.passed ? 'PASS' : 'FAIL'} | ${safeText(fact.failedRules.join(', ') || 'none')} |`),
    ...(gates.length === 0 ? ['| n/a | n/a | n/a |'] : []),
    '',
    '## Tests',
    '',
    '| Attempt | Passed | Target passed | Regressions |',
    '| ---: | --- | --- | --- |',
    ...tests.map(
      (fact) =>
        `| ${fact.attempt} | ${fact.passed} | ${fact.targetPassed ?? 'n/a'} | ${safeText(fact.regressions?.join(', ') || 'none')} |`
    ),
    ...(tests.length === 0 ? ['| n/a | n/a | n/a |'] : []),
    '',
    '## Validator criteria',
    '',
    '| Attempt | Source | Criterion | Verdict |',
    '| ---: | --- | --- | --- |',
    ...codeVerdicts.flatMap((fact) =>
      fact.verdicts.map((item) => `| ${fact.attempt} | code | ${safeText(item.id)} | ${safeText(item.verdict)} |`)
    ),
    ...validators.flatMap((fact) =>
      (fact.criteria ?? []).map((item) => `| ${fact.attempt} | validator | ${safeText(item.id)} | ${safeText(item.verdict)} |`)
    ),
    ...(codeVerdicts.length === 0 && validators.every((fact) => (fact.criteria ?? []).length === 0)
      ? ['| n/a | n/a | n/a | n/a |']
      : []),
    '',
    '## Holdout',
    '',
    holdoutResult,
    '',
    '## Usage by stage',
    '',
    '| Stage | Prompt tokens | Completion tokens | Gateway cost (USD) | Calls |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Array.from(stages.entries()).map(
      ([stage, total]) =>
        `| ${safeText(stage)} | ${total.promptTokens} | ${total.completionTokens} | ${gatewayCost(total)} | ${total.calls} |`
    ),
    ...(stages.size === 0 ? ['| n/a | 0 | 0 | n/a | 0 |'] : []),
    '',
    `Total tokens: ${totalPrompt + totalCompletion} (prompt ${totalPrompt}, completion ${totalCompletion})`,
    `Total gateway cost: ${totalCostCalls > 0 ? `$${totalGatewayCost.toFixed(6)}` : 'n/a'}`,
    `Trace ID: ${traceId}`,
    `Attempts: ${attempts.length ? attempts.join(', ') : 'none recorded'}`,
    '',
    'This is a generated receipt. No pull request was opened.',
    '',
  ].join('\n');

  const gateHtml =
    gates.length === 0
      ? '<li class="neutral">No gate facts recorded</li>'
      : gates
          .map((gate) => {
            const gateClass = gate.passed ? 'green' : 'red';
            const label = gate.passed ? 'Gate passed' : 'Gate failed';
            const failedRules =
              gate.failedRules.length > 0
                ? gate.failedRules.map((rule) => `<li class="red">${escapeHtml(safeText(rule))}</li>`).join('')
                : '<li class="green">No failed rule IDs recorded</li>';
            return `<li class="${gateClass}">Attempt ${gate.attempt}: ${label}<ul>${failedRules}</ul></li>`;
          })
          .join('');
  const timelineHtml = timeline
    .map((fact) => {
      const attempt = 'attempt' in fact && typeof fact.attempt === 'number' ? ` attempt=${fact.attempt}` : '';
      return `<li><time>${escapeHtml(safeText(fact.ts))}</time> ${escapeHtml(fact.type + attempt)}</li>`;
    })
    .join('');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Foreman run ${escapeHtml(safeText(runId))}</title>
<style>
body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#17202a}
.verdict{padding:1rem;border:1px solid #879;display:inline-block;font-weight:700}
.green{color:#176b35}.red{color:#a21d1d}.neutral{color:#555}
li{margin:.35rem 0}time{font-family:monospace;color:#555}
</style>
</head>
<body>
<h1>Run ${escapeHtml(safeText(runId))}</h1>
<p>Issue ${escapeHtml(issue)}; derived status ${escapeHtml(status)}</p>
<p class="verdict">${escapeHtml(verdict)}</p>
<h2>Attempt timeline</h2>
<ol>${timelineHtml || '<li>No attempt facts recorded</li>'}</ol>
<h2>Gate rules</h2>
<ul>${gateHtml}</ul>
<h2>Holdout</h2>
<p class="${holdoutResult === 'passed' ? 'green' : holdoutResult === 'failed' ? 'red' : 'neutral'}">${holdoutResult}</p>
<p>Tokens: ${totalPrompt + totalCompletion}; gateway cost: ${totalCostCalls > 0 ? `$${totalGatewayCost.toFixed(6)}` : 'n/a'}; trace ID: ${escapeHtml(traceId)}</p>
<p>No pull request was opened.</p>
</body>
</html>
`;
  return { markdown, html };
}

export function renderRun(
  runId: string,
  runsDir = 'runs',
  outputDir = runsDir
): { prBodyPath: string; htmlPath: string } {
  if (!/^run-\d+$/.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
  const runDir = path.join(runsDir, runId);
  const facts = readJsonLines<Fact>(path.join(runDir, 'facts.jsonl'));
  if (facts.length === 0) throw new Error(`No facts found for ${runId}.`);
  const ledger = readJsonLines<RunLedgerEntry>(path.join(runsDir, 'ledger.jsonl'));
  const outputs = renderReceipt(runId, facts, ledger);
  const outputRunDir = path.join(outputDir, runId);
  fs.mkdirSync(outputRunDir, { recursive: true });
  const prBodyPath = path.join(outputRunDir, 'PR_BODY.md');
  const htmlPath = path.join(outputRunDir, 'report.html');
  fs.writeFileSync(prBodyPath, outputs.markdown, 'utf8');
  fs.writeFileSync(htmlPath, outputs.html, 'utf8');
  return { prBodyPath, htmlPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const runId = args[0];
    let outputDir = 'runs';
    if (args.length === 3 && args[1] === '--output-dir') {
      outputDir = args[2];
    } else if (args.length !== 1) {
      throw new Error('Usage: npm run render -- <runId> [--output-dir <directory>]');
    }
    if (!runId) throw new Error('Usage: npm run render -- <runId> [--output-dir <directory>]');
    const outputs = renderRun(runId, 'runs', outputDir);
    console.log(`Wrote ${path.relative(process.cwd(), outputs.prBodyPath)}`);
    console.log(`Wrote ${path.relative(process.cwd(), outputs.htmlPath)}`);
  } catch (error) {
    console.error(`Run receipt generation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
