/**
 * DEV EXPERIMENT — NOT PART OF THE FOREMAN AGENT.
 *
 * Replays the configured default validator against two previously shipped
 * patches and two handmade negatives. It cannot affect agent decisions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { completeWith, jsonSchemaResponseFormat, assertStepBudgetAllowed } from '../src/model/index.js';
import type { ChatMessage, ModelCallResult } from '../src/model/types.js';
import { createWorkspace, gitDiff, gitShowFile } from '../src/run/workspace.js';
import { runTests } from '../src/run/tests.js';
import {
  validatePatch,
  type CallSite,
  type ValidatorInput,
  type ValidatorRunResult,
  type ValidatorCallModel,
} from '../src/validator/index.js';
import { extractSymbolBody } from '../src/patch/propose.js';
import { pruneSchemaForWire, type SchemaNode } from '../src/schema/validate.js';
import type { RubricCriterion } from '../src/mandate/rubric.js';

interface Scenario {
  name: string;
  issueId: string;
  symbol: string;
  file: string;
  runId: string;
  diffPath?: string;
  negative?: (content: string) => string;
  handmadeNegative?: boolean;
}

interface ReplayRow {
  patch: string;
  issue: string;
  testsPassed: boolean;
  targetPassed: boolean;
  regressions: string[];
  results: ValidatorRunResult['criteria'] | null;
  overallPass: boolean | null;
  error?: string;
}

const root = process.cwd();
const baselinePath = path.resolve('.foreman-work', 'step10-start.json');
const policy = JSON.parse(fs.readFileSync('foreman.policy.json', 'utf-8')) as {
  validatorModel: string;
  validatorMinConfidence: number;
};
const scenarios: Scenario[] = [
  {
    name: 'issue1-correct',
    issueId: '1',
    symbol: 'calculateTieredBulkDiscount',
    file: 'src/discount.ts',
    runId: 'run-1791666044437',
    diffPath: 'runs/run-1791666044437/attempt-1.diff',
  },
  {
    name: 'issue2-correct',
    issueId: '2',
    symbol: 'calculateRawItemsSubtotal',
    file: 'src/cart.ts',
    runId: 'run-1791666161585',
    diffPath: 'runs/run-1791666161585/attempt-1.diff',
  },
  {
    name: 'issue1-HANDMADE-NEGATIVE-special-case',
    issueId: '1',
    symbol: 'calculateTieredBulkDiscount',
    file: 'src/discount.ts',
    runId: 'run-1791666044437',
    handmadeNegative: true,
    negative: (content) => {
      const anchor = '  if (quantity > 10) {';
      if (!content.includes(anchor)) throw new Error('HANDMADE NEGATIVE issue 1 anchor not found.');
      return content.replace(
        anchor,
        '  if (quantity === 10 && unitPrice === 50) return roundCurrency(quantity * unitPrice * 0.10);\n' + anchor
      );
    },
  },
  {
    name: 'issue2-HANDMADE-NEGATIVE-final-round-only',
    issueId: '2',
    symbol: 'calculateRawItemsSubtotal',
    file: 'src/cart.ts',
    runId: 'run-1791666161585',
    handmadeNegative: true,
    negative: (content) => {
      const anchor = '  return items.reduce((acc, item) => acc + item.price * item.quantity, 0);';
      if (!content.includes(anchor)) throw new Error('HANDMADE NEGATIVE issue 2 anchor not found.');
      return content.replace(anchor, '  return roundCurrency(items.reduce((acc, item) => acc + item.price * item.quantity, 0));');
    },
  },
];

function readText(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

function ledgerReplayCalls(): number {
  const ledgerPath = path.resolve('runs', 'ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) return 0;
  return readText(ledgerPath)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { runId: string })
    .filter((entry) => entry.runId.startsWith('step10-replay-')).length;
}

function boundedModel(model: string): ValidatorCallModel {
  return async (
    messages: ChatMessage[],
    runId: string,
    schemaName: string,
    schema: SchemaNode
  ): Promise<ModelCallResult> => {
    if (ledgerReplayCalls() >= 10) throw new Error('Step 10 validator replay cap reached (10 calls).');
    assertStepBudgetAllowed();
    return completeWith(
      model,
      messages,
      { maxTokens: 1500, responseFormat: jsonSchemaResponseFormat(schemaName, pruneSchemaForWire(schema)) },
      runId,
      'validate',
      'replay'
    );
  };
}

function buildInput(scenario: Scenario): {
  input: ValidatorInput;
  testsPassed: boolean;
  targetPassed: boolean;
  regressions: string[];
} {
  const ws = createWorkspace(`replay-${scenario.name}`, scenario.issueId);
  const baseline = runTests(ws.path);
  const baselinePassing = new Set(baseline.passingTests);

  if (scenario.diffPath) {
    const patchFile = path.join(ws.path, '.step10-replay.patch');
    fs.writeFileSync(patchFile, readText(scenario.diffPath), 'utf-8');
    execSync(`git apply --whitespace=nowarn "${patchFile}"`, { cwd: ws.path, stdio: 'pipe' });
    fs.rmSync(patchFile, { force: true });
  } else if (scenario.negative) {
    const target = path.join(ws.path, scenario.file);
    fs.writeFileSync(target, scenario.negative(readText(target)), 'utf-8');
  } else {
    throw new Error(`Replay scenario ${scenario.name} has no patch.`);
  }

  const diff = gitDiff(ws.path);
  const tests = runTests(ws.path);
  const targetName = `repro-issue-${scenario.issueId}`;
  const targetPassed = tests.passingTests.includes(targetName) && !tests.failingTests.includes(targetName);
  const regressions = tests.failingTests.filter((test) => baselinePassing.has(test));
  if (scenario.handmadeNegative && (!targetPassed || regressions.length > 0)) {
    throw new Error(
      `HANDMADE NEGATIVE did not pass visible repro without regressions: targetPassed=${targetPassed}; regressions=${regressions.join(', ')}`
    );
  }

  const saved = `runs/${scenario.runId}`;
  const ctx = JSON.parse(readText(path.join(saved, 'context.json'))) as {
    notes?: string;
    symbolFacts?: { symbol: string; file?: string; callerCount: number; calleeCount: number }[];
    findings?: { symbol: string; kind: string; file: string; evidence: string; callSiteFile?: string; callSiteLine?: number }[];
  };
  const rubric = JSON.parse(readText(path.join(saved, 'rubric.json'))) as {
    criteria: { id: string; text: string; check: string }[];
  };
  const criteria: RubricCriterion[] = rubric.criteria
    .filter((criterion) => criterion.check === 'diff' || criterion.check === 'behavior')
    .map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      check: criterion.check as RubricCriterion['check'],
      evidence_ref: { kind: 'issue_text', value: criterion.text },
    }));
  const evidenceText = [
    ctx.notes ?? '',
    ...(ctx.symbolFacts ?? []).map((fact) => `symbol ${fact.symbol} (${fact.file ?? 'unknown'}): callers=${fact.callerCount} callees=${fact.calleeCount}`),
    ...(ctx.findings ?? []).slice(0, 40).map((finding) => `${finding.kind} ${finding.symbol} @ ${finding.file}: ${finding.evidence}`),
  ].join('\n');
  const callSites: CallSite[] = (ctx.findings ?? [])
    .filter((finding) => finding.callSiteFile !== undefined && finding.callSiteLine !== undefined)
    .slice(0, 40)
    .map((finding) => ({
      symbol: finding.symbol,
      file: finding.callSiteFile as string,
      line: finding.callSiteLine,
      evidence: finding.evidence,
    }));
  const savedGate = JSON.parse(readText(path.join(saved, 'gate-1.json'))) as {
    passed: boolean;
    failedRules: string[];
    rules: { ruleId: string; passed: boolean; detail: string }[];
  };
  const input: ValidatorInput = {
    criteria,
    diff,
    targetPassed,
    regressions,
    gate: { passed: savedGate.passed, failedRules: savedGate.failedRules, rules: savedGate.rules },
    evidenceText,
    changedFunctions: [{
      symbol: scenario.symbol,
      file: scenario.file,
      before: extractSymbolBody(gitShowFile(ws.path, ws.baseCommit, scenario.file), scenario.symbol, 80),
      after: extractSymbolBody(readText(path.join(ws.path, scenario.file)), scenario.symbol, 80),
    }],
    passedTests: tests.passingTests,
    failedTests: tests.failingTests,
    testsExercisingSymbols: [],
    testsExercisingNote: 'the structural graph does not supply a test-to-symbol mapping',
    callSites,
  };
  return { input, testsPassed: tests.exitCode === 0, targetPassed, regressions };
}

function renderReport(rows: ReplayRow[]): string {
  const lines = [
    '# Step 10 validator replay',
    '',
    'DEV EXPERIMENT only; this replay does not feed agent decisions. The validator model is read from foreman.policy.json and is not overridden.',
    '',
    '| Patch | Criterion | Verdict | Confidence | Overall pass |',
    '| --- | --- | --- | ---: | --- |',
  ];
  for (const row of rows) {
    if (!row.results) {
      lines.push(`| ${row.patch} | all | ERROR | - | no |`);
      continue;
    }
    for (const result of row.results) {
      lines.push(
        `| ${row.patch} | ${result.id} | ${result.verdict} | ${result.confidence} | ${row.overallPass ? 'yes' : 'no'} |`
      );
    }
  }
  const negatives = rows.filter((row) => row.patch.includes('HANDMADE-NEGATIVE'));
  const caughtBoth = negatives.length === 2 && negatives.every((row) => row.overallPass === false);
  lines.push(
    '',
    `Validator caught both handmade negatives: ${caughtBoth ? 'yes' : negatives.length === 2 ? 'no' : 'not established (replay incomplete)'}.`,
    ''
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  if (!fs.existsSync(baselinePath)) throw new Error(`Step 10 baseline missing: ${baselinePath}`);
  process.env.FOREMAN_STEP_BASELINE = baselinePath;
  process.env.FOREMAN_STEP_TOKEN_CAP ??= '260000';
  if (process.argv.includes('--initialize-only')) {
    fs.mkdirSync(path.resolve('docs', 'evidence', 'measurements'), { recursive: true });
    fs.writeFileSync(
      path.resolve('docs', 'evidence', 'measurements', 'validator-replay.md'),
      renderReport([]),
      'utf-8'
    );
    console.log('Initialized an empty validator replay report; no model calls were made.');
    return;
  }
  console.log(`Validator model: ${policy.validatorModel}`);
  const callModel = boundedModel(policy.validatorModel);
  const rows: ReplayRow[] = [];

  for (const scenario of scenarios) {
    console.log(`Scenario: ${scenario.name}`);
    const built = buildInput(scenario);
    console.log(
      `Visible tests: ${built.testsPassed ? 'PASS' : 'FAIL'}; target: ${built.targetPassed ? 'PASS' : 'FAIL'}; regressions: ${built.regressions.length ? built.regressions.join(', ') : 'none'}`
    );
    if (scenario.handmadeNegative) {
      console.log(`HANDMADE NEGATIVE repro proof: ${built.targetPassed && built.regressions.length === 0 ? 'PASS' : 'FAIL'}`);
    }
    if (built.input.criteria.length === 0) {
      throw new Error(`No judgment criteria found in saved rubric for ${scenario.name}.`);
    }
    const replayId = `step10-replay-${scenario.name}`;
    try {
      const result = await validatePatch(built.input, replayId, policy.validatorMinConfidence, callModel, policy.validatorModel);
      rows.push({
        patch: scenario.name,
        issue: scenario.issueId,
        testsPassed: built.testsPassed,
        targetPassed: built.targetPassed,
        regressions: built.regressions,
        results: result.criteria,
        overallPass: result.allCriteriaPass,
      });
      console.log(
        `${result.criteria.map((criterion) => `${criterion.id}=${criterion.verdict}@${criterion.confidence}`).join('; ')}; overall=${result.allCriteriaPass}`
      );
    } catch (error) {
      rows.push({
        patch: scenario.name,
        issue: scenario.issueId,
        testsPassed: built.testsPassed,
        targetPassed: built.targetPassed,
        regressions: built.regressions,
        results: null,
        overallPass: null,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    } finally {
      fs.mkdirSync(path.resolve('docs', 'evidence', 'measurements'), { recursive: true });
      fs.writeFileSync(path.resolve('docs', 'evidence', 'measurements', 'validator-replay.md'), renderReport(rows), 'utf-8');
    }
  }
  console.log(renderReport(rows));
}

main().catch((error: unknown) => {
  console.error(`Validator replay failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
