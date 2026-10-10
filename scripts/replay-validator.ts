/**
 * DEV EXPERIMENT — NOT PART OF THE FOREMAN AGENT.
 *
 * Replays the independent validator over three known-correct patches (the saved
 * attempt diffs from the real runs) plus two HANDMADE NEGATIVE patches that pass
 * the repro test but are wrong, using three candidate reviewer models, to compare
 * verdicts on identical evidence.
 *
 * It does NOT feed the agent's pipeline, is NOT run by `npm test`, and does NOT
 * change the default validator model (it passes an explicit model per call). Run:
 *
 *     npx tsx scripts/replay-validator.ts
 *
 * Never prints or reads the API key or .env; requires LITELLM_API_KEY in the
 * environment and records every real call through the existing model ledger.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { completeWith, jsonSchemaResponseFormat } from '../src/model/index.js';
import { createWorkspace, gitDiff, gitShowFile } from '../src/run/workspace.js';
import { runTests } from '../src/run/tests.js';
import { validatePatch, type CallSite, type ValidatorInput, type ValidatorRunResult } from '../src/validator/index.js';
import { extractSymbolBody } from '../src/patch/propose.js';
import type { RubricCriterion } from '../src/mandate/rubric.js';

/** Candidate reviewer models to compare. claude-opus-4.6 is intentionally absent. */
const MODELS = ['nova-pro', 'nova-2-lite', 'claude-haiku'];

interface Scenario {
  name: string;
  issueId: string;
  /** The changed function to extract before/after for. */
  symbol: string;
  file: string;
  /** Run folder whose saved rubric.json/context.json we reuse. */
  rubricRun: string;
  /** Saved attempt diff to apply (known-correct scenarios). */
  savedDiff?: string;
  /** Full post-patch file content for a HANDMADE NEGATIVE patch. */
  negative?: string;
}

function readText(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  if (!haystack.includes(needle)) {
    throw new Error(`HANDMADE NEGATIVE: anchor not found: ${needle}`);
  }
  return haystack.replace(needle, replacement);
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

const fixtureCart = readText('fixtures/sample-repo/src/cart.ts');
const fixtureDiscount = readText('fixtures/sample-repo/src/discount.ts');

const scenarios: Scenario[] = [
  {
    name: 'issue1-correct',
    issueId: '1',
    symbol: 'calculateTieredBulkDiscount',
    file: 'src/discount.ts',
    rubricRun: 'run-1791663075525',
    savedDiff: readText('runs/run-1791663075525/attempt-2.diff'),
  },
  {
    name: 'issue2-correct',
    issueId: '2',
    symbol: 'calculateRawItemsSubtotal',
    file: 'src/cart.ts',
    rubricRun: 'run-1791663262346',
    savedDiff: readText('runs/run-1791663262346/attempt-2.diff'),
  },
  {
    name: 'issue3-correct',
    issueId: '3',
    symbol: 'calculateVolumetricShipping',
    file: 'src/shipping.ts',
    rubricRun: 'run-1791663174555',
    savedDiff: readText('runs/run-1791663174555/attempt-3.diff'),
  },
  {
    // HANDMADE NEGATIVE: special-cases the repro input instead of fixing the boundary.
    name: 'issue1-NEGATIVE-special-case',
    issueId: '1',
    symbol: 'calculateTieredBulkDiscount',
    file: 'src/discount.ts',
    rubricRun: 'run-1791663075525',
    negative: replaceOnce(
      fixtureDiscount,
      '  if (quantity > 10) {\n    return roundCurrency(quantity * unitPrice * 0.10);\n  }',
      '  if (quantity === 10) {\n    return roundCurrency(quantity * unitPrice * 0.10);\n  }\n  if (quantity > 10) {\n    return roundCurrency(quantity * unitPrice * 0.10);\n  }'
    ),
  },
  {
    // HANDMADE NEGATIVE: rounds only the final subtotal instead of accumulating in integer cents.
    name: 'issue2-NEGATIVE-final-round-only',
    issueId: '2',
    symbol: 'calculateRawItemsSubtotal',
    file: 'src/cart.ts',
    rubricRun: 'run-1791663262346',
    negative: replaceOnce(
      fixtureCart,
      '  return items.reduce((acc, item) => acc + item.price * item.quantity, 0);',
      '  return roundCurrency(items.reduce((acc, item) => acc + item.price * item.quantity, 0));'
    ),
  },
];

// ---------------------------------------------------------------------------
// Model probe (one tiny real call each)
// ---------------------------------------------------------------------------

interface Probe {
  model: string;
  works: boolean;
  bare?: boolean;
  content?: string;
  reason?: string;
}

async function probeModel(model: string): Promise<Probe> {
  if (!process.env.LITELLM_API_KEY) {
    return { model, works: false, reason: 'LITELLM_API_KEY not set in environment' };
  }
  try {
    const result = await completeWith(
      model,
      [
        { role: 'system', content: 'You output only valid JSON.' },
        { role: 'user', content: 'Return an object with a boolean field ok set to true.' },
      ],
      {
        maxTokens: 20,
        responseFormat: jsonSchemaResponseFormat('ok_result', {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        }),
      },
      `replay-probe-${model}`,
      'validate'
    );
    const content = result.text;
    let bare = false;
    try {
      JSON.parse(content);
      bare = true;
    } catch {
      bare = false;
    }
    return { model, works: true, bare, content };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { model, works: false, reason: message.split('\n')[0] };
  }
}

// ---------------------------------------------------------------------------
// Build a real validator input for a scenario (real git apply + real tests)
// ---------------------------------------------------------------------------

interface Built {
  input: ValidatorInput;
  tests: ReturnType<typeof runTests>;
  targetPassed: boolean;
  regressions: string[];
  repoPath: string;
}

function buildInput(sc: Scenario): Built {
  const runId = `replay-${sc.name}`;
  const ws = createWorkspace(runId, sc.issueId);

  // Baseline tests BEFORE the patch: the sample repo has all three repro bugs, so
  // the other issues' repro tests already fail. Regressions are only failing tests
  // that were passing at baseline (mirrors the supervisor).
  const baseline = runTests(ws.path);
  const baselinePassingSet = new Set(baseline.passingTests);

  if (sc.savedDiff) {
    const patchFile = path.join(ws.path, '.replay.patch');
    fs.writeFileSync(patchFile, sc.savedDiff.endsWith('\n') ? sc.savedDiff : sc.savedDiff + '\n');
    execSync(`git apply --whitespace=nowarn "${patchFile}"`, { cwd: ws.path, stdio: 'pipe' });
    fs.rmSync(patchFile, { force: true });
  } else if (sc.negative) {
    fs.writeFileSync(path.join(ws.path, sc.file), sc.negative);
  } else {
    throw new Error(`scenario ${sc.name} has neither savedDiff nor negative`);
  }

  const diff = gitDiff(ws.path);
  const tests = runTests(ws.path);
  const target = `repro-issue-${sc.issueId}`;
  const targetPassed = tests.passingTests.includes(target) && !tests.failingTests.includes(target);
  const regressions = tests.failingTests.filter((t) => baselinePassingSet.has(t));

  const before = extractSymbolBody(gitShowFile(ws.path, ws.baseCommit, sc.file), sc.symbol, 80);
  const after = extractSymbolBody(readText(path.join(ws.path, sc.file)), sc.symbol, 80);

  const ctx = JSON.parse(readText(path.join('runs', sc.rubricRun, 'context.json'))) as {
    notes?: string;
    symbolFacts?: { symbol: string; file?: string; callerCount: number; calleeCount: number }[];
    findings?: { symbol: string; kind: string; file: string; evidence: string; callSiteFile?: string; callSiteLine?: number }[];
  };
  const rubric = JSON.parse(readText(path.join('runs', sc.rubricRun, 'rubric.json'))) as { criteria: { id: string; text: string; check: string }[] };

  // Judgment criteria only (check diff/behavior), as the supervisor does.
  const criteria: RubricCriterion[] = rubric.criteria
    .filter((c) => c.check === 'diff' || c.check === 'behavior')
    .map((c) => ({
      id: c.id,
      text: c.text,
      check: c.check as RubricCriterion['check'],
      evidence_ref: { kind: 'issue_text', value: c.text },
    }));

  const evidenceText = [
    ctx.notes ?? '',
    ...(ctx.symbolFacts ?? []).map((sf) => `symbol ${sf.symbol} (${sf.file ?? 'unknown'}): callers=${sf.callerCount} callees=${sf.calleeCount}`),
    ...(ctx.findings ?? []).slice(0, 40).map((f) => `${f.kind} ${f.symbol} @ ${f.file}: ${f.evidence}`),
  ].join('\n');

  const callSites: CallSite[] = (ctx.findings ?? [])
    .filter((f) => f.callSiteFile !== undefined && f.callSiteLine !== undefined)
    .slice(0, 40)
    .map((f) => ({ symbol: f.symbol, file: f.callSiteFile as string, line: f.callSiteLine, evidence: f.evidence }));

  const input: ValidatorInput = {
    criteria,
    diff,
    targetPassed,
    regressions,
    gate: { passed: true, failedRules: [], rules: [] },
    evidenceText,
    changedFunctions: [{ symbol: sc.symbol, file: sc.file, before, after }],
    passedTests: tests.passingTests,
    failedTests: tests.failingTests,
    testsExercisingSymbols: [],
    testsExercisingNote: 'the structural graph does not supply a test-to-symbol mapping',
    callSites,
  };

  return { input, tests, targetPassed, regressions, repoPath: ws.path };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('===== DEV EXPERIMENT: validator replay (NOT part of the agent) =====');
  console.log(`default validator model in policy: ${JSON.parse(readText('foreman.policy.json')).validatorModel}`);
  console.log('');

  console.log('--- model probe (one tiny json_schema call each) ---');
  const probes: Probe[] = [];
  for (const model of MODELS) {
    const probe = await probeModel(model);
    probes.push(probe);
    if (probe.works) {
      console.log(`  ${model}: WORKS yes; bare JSON: ${probe.bare ? 'yes' : 'no'}; content: ${JSON.stringify(probe.content)}`);
    } else {
      console.log(`  ${model}: WORKS no; reason: ${probe.reason}`);
    }
  }
  const working = probes.filter((p) => p.works && p.bare).map((p) => p.model);
  console.log(`  -> replayed models: ${working.length > 0 ? working.join(', ') : '(none)'}`);
  console.log('');

  const rows: string[] = [];
  const byScenario = new Map<string, Map<string, Map<string, string>>>();

  for (const sc of scenarios) {
    console.log(`--- scenario ${sc.name} (issue ${sc.issueId}) ---`);
    const built = buildInput(sc);
    console.log(
      `  targetPassed=${built.targetPassed} pass=${built.tests.passed} fail=${built.tests.failed} failing=[${built.tests.failingTests.join(', ')}] regressions=[${built.regressions.join(', ')}]`
    );
    if (sc.name.includes('NEGATIVE')) {
      console.log(`  HANDMADE NEGATIVE repro proof: ${built.targetPassed ? 'PASS' : 'FAIL'}; regressions: ${built.regressions.length}`);
      if (!built.targetPassed || built.regressions.length > 0) {
        throw new Error(
          `HANDMADE NEGATIVE ${sc.name} did not pass its repro test without regressions; revise the negative before replay`
        );
      }
    }
    console.log(`  judgment criteria: ${built.input.criteria.map((c) => `${c.id}(${c.check})`).join(', ')}`);

    const perScenario = new Map<string, Map<string, string>>();

    for (const model of working) {
      let result: ValidatorRunResult | undefined;
      let error: string | undefined;
      try {
        result = await validatePatch(built.input, `replay-${sc.name}`, 0.7, undefined, model);
      } catch (err: unknown) {
        error = err instanceof Error ? err.message : String(err);
      }

      if (!result) {
        const cell = new Map<string, string>();
        for (const c of built.input.criteria) cell.set(c.id, `ERROR: ${error?.slice(0, 80) ?? 'unknown'}`);
        perScenario.set(model, cell);
        rows.push(`| ${sc.name} | ${model} | (all) | - | ERROR | - | ${(error ?? '').replace(/\|/g, '/').slice(0, 120)} |`);
        continue;
      }

      const cell = new Map<string, string>();
      for (const c of result.criteria) {
        cell.set(c.id, `${c.verdict} / ${c.confidence}`);
        rows.push(
          `| ${sc.name} | ${model} | ${c.id} | ${c.verdict} | ${c.confidence} | ${c.reason.replace(/\|/g, '/').slice(0, 90)} |`
        );
      }
      perScenario.set(model, cell);
      console.log(`    ${model}: ${result.criteria.map((c) => `${c.id}=${c.verdict}@${c.confidence}`).join(' ')} (allCriteriaPass=${result.allCriteriaPass})`);
    }

    byScenario.set(sc.name, perScenario);
  }

  console.log('');
  console.log('===== TABLE: model x patch -> each criterion verdict / confidence =====');
  console.log('| Scenario | Criterion | ' + working.join(' | ') + ' |');
  console.log('| --- | --- | ' + working.map(() => '---').join(' | ') + ' |');
  for (const sc of scenarios) {
    const perScenario = byScenario.get(sc.name)!;
    for (const c of buildCriteriaList(sc)) {
      const cells = working.map((m) => perScenario.get(m)?.get(c.id) ?? '-');
      console.log(`| ${sc.name} | ${c.id} (${c.check}) | ${cells.join(' | ')} |`);
    }
  }

  console.log('');
  console.log('===== raw rows =====');
  console.log('| Scenario | Model | Criterion | Verdict | Confidence | Reason |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(row);
}

function buildCriteriaList(sc: Scenario): { id: string; check: string }[] {
  const rubric = JSON.parse(readText(path.join('runs', sc.rubricRun, 'rubric.json'))) as { criteria: { id: string; check: string }[] };
  return rubric.criteria.filter((c) => c.check === 'diff' || c.check === 'behavior');
}

main().catch((err: unknown) => {
  console.error('REPLAY FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
