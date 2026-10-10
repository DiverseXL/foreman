#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createWorkspace, gitDiff, type WorkspaceResult } from '../run/workspace.js';
import { runTests, type TestRunResult } from '../run/tests.js';
import { appendFact, readFacts } from '../state/facts.js';
import { deriveStatus } from '../state/derive.js';
import { loadMandate, type Mandate } from '../mandate/load.js';
import { buildContext, type ContextBundle } from '../context/graph.js';
import { buildRubric, type RubricResult } from '../mandate/rubric.js';
import { proposePatch, applyEdits, buildSourceBundle, type ProposeResult, type ApplyResult } from '../patch/propose.js';
import { withWorkflow, withStage, flushTelemetry, shutdownTelemetry } from '../telemetry/index.js';
import { cumulativeCost, cumulativeTokens } from '../model/index.js';

interface CliArgs {
  command?: string;
  issue?: string;
  setupOnly: boolean;
  through?: string;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = { setupOnly: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'run') {
      result.command = 'run';
    } else if (arg === '--issue') {
      result.issue = args[i + 1];
      i++;
    } else if (arg === '--setup-only') {
      result.setupOnly = true;
    } else if (arg === '--through') {
      result.through = args[i + 1];
      i++;
    }
  }
  return result;
}

function runDirPath(runId: string): string {
  return path.join('runs', runId);
}

function ensureRunDir(runId: string): string {
  const dir = runDirPath(runId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeGraphArgs(args: string[]): string {
  return args
    .filter((a) => a !== '--format' && a !== 'json' && a !== '--repo')
    .map((a) => a.replace(/[^a-zA-Z0-9._-]+/g, '_'))
    .join('-');
}

function persistContext(runId: string, workspace: WorkspaceResult, mandate: Mandate): ContextBundle {
  const dir = ensureRunDir(runId);

  fs.writeFileSync(path.join(dir, 'mandate.json'), JSON.stringify(mandate, null, 2) + '\n', 'utf-8');

  const { bundle, rawCommands } = buildContext(workspace.path, mandate);

  fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(bundle, null, 2) + '\n', 'utf-8');

  const graphRawDir = path.join(dir, 'graph-raw');
  if (!fs.existsSync(graphRawDir)) fs.mkdirSync(graphRawDir, { recursive: true });
  rawCommands.forEach((cmd, index) => {
    const name = `${String(index + 1).padStart(2, '0')}-${sanitizeGraphArgs(cmd.args)}.json`;
    fs.writeFileSync(path.join(graphRawDir, name), cmd.stdout + '\n', 'utf-8');
  });

  return bundle;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.command !== 'run' || !parsed.issue) {
    console.error('Usage: foreman run --issue <n> [--setup-only] [--through context|tests]');
    process.exit(1);
  }

  const issueId = parsed.issue;
  const runId = `run-${Date.now()}`;
  const throughTests = !parsed.setupOnly && parsed.through === 'tests';
  const shouldRunContext = !parsed.setupOnly && (parsed.through === undefined || parsed.through === 'context' || throughTests);

  let rubricResult: RubricResult | undefined;
  let proposeResult: ProposeResult | undefined;
  let applyResult: ApplyResult | undefined;
  let diffHash: string | undefined;
  let finalTests: TestRunResult | undefined;
  let stoppedReason: string | undefined;

  const { traceId } = await withWorkflow(runId, issueId, async (_span, currentTraceId) => {
    appendFact(runId, { type: 'run_started', runId, issueId });

    const workspace = await withStage('workspace_setup', 'TOOL', async (stageSpan) => {
      const ws = createWorkspace(runId, issueId);
      stageSpan.setAttribute('foreman.base_commit', ws.baseCommit);
      stageSpan.setAttribute('foreman.branch', ws.branch);
      stageSpan.setAttribute('foreman.path', ws.path);
      return ws;
    });

    appendFact(runId, {
      type: 'workspace_created',
      baseCommit: workspace.baseCommit,
      branch: workspace.branch,
      path: workspace.path,
    });

    const baseline = await withStage(
      'baseline_tests',
      'EVALUATOR',
      async (stageSpan) => {
        const testRes = runTests(workspace.path);
        stageSpan.setAttribute('foreman.baseline.passed', testRes.passed);
        stageSpan.setAttribute('foreman.baseline.failed', testRes.failed);
        stageSpan.setAttribute('foreman.baseline.exit_code', testRes.exitCode);
        stageSpan.setAttribute('foreman.baseline.duration_ms', testRes.durationMs);
        return testRes;
      },
      { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
    );

    appendFact(runId, {
      type: 'baseline_recorded',
      exitCode: baseline.exitCode,
      passed: baseline.passed,
      failed: baseline.failed,
      failingTests: baseline.failingTests,
    });

    let mandate: Mandate | undefined;
    let contextBundle: ContextBundle | undefined;

    if (shouldRunContext) {
      mandate = await withStage(
        'mandate_load',
        'TOOL',
        async (stageSpan) => {
          const loaded = loadMandate(issueId);
          stageSpan.setAttribute('foreman.mandate.title', loaded.title);
          stageSpan.setAttribute('foreman.mandate.criteria_count', loaded.acceptanceCriteria.length);
          return loaded;
        },
        { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
      );

      contextBundle = await withStage(
        'graph_context',
        'RETRIEVER',
        async (stageSpan) => {
          const ctx = persistContext(runId, workspace, mandate!);
          stageSpan.setAttribute('foreman.context.query_count', ctx.queriesRun.length);
          stageSpan.setAttribute('foreman.context.finding_count', ctx.findings.length);
          stageSpan.setAttribute('foreman.context.symbol_fact_count', ctx.symbolFacts.length);
          if (ctx.indexSummary) {
            stageSpan.setAttribute('foreman.context.indexed_symbols', ctx.indexSummary.symbols);
          }
          return ctx;
        },
        { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
      );

      appendFact(runId, {
        type: 'context_built',
        queryCount: contextBundle.queriesRun.length,
        findingCount: contextBundle.findings.length,
        indexedSymbols: contextBundle.indexSummary?.symbols ?? 0,
      });
    }

    if (throughTests && mandate && contextBundle) {
      // --- Rubric (LLM) ---
      try {
        rubricResult = await withStage(
          'rubric',
          'LLM',
          async (stageSpan) => {
            const rubric = await buildRubric(mandate!, runId);
            stageSpan.setAttribute('foreman.llm.model', rubric.model);
            stageSpan.setAttribute('foreman.rubric.criteria_count', rubric.criteria.length);
            stageSpan.setAttribute('foreman.rubric.attempts', rubric.attempts);
            if (rubric.usage?.promptTokens !== undefined) stageSpan.setAttribute('foreman.llm.prompt_tokens', rubric.usage.promptTokens);
            if (rubric.usage?.completionTokens !== undefined) stageSpan.setAttribute('foreman.llm.completion_tokens', rubric.usage.completionTokens);
            return rubric;
          },
          { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
        );
      } catch (err) {
        stoppedReason = err instanceof Error ? err.message : String(err);
      }

      if (rubricResult) {
        appendFact(runId, {
          type: 'mandate_created',
          issueId,
          title: mandate.title,
          criteriaCount: rubricResult.criteria.length,
          rubricCriteriaCount: rubricResult.criteria.length,
          rubricModel: rubricResult.model,
          hintedSymbols: mandate.hintedSymbols,
          hintedPaths: mandate.hintedPaths,
        });

        // --- Patch proposal (LLM) ---
        const sources = buildSourceBundle(contextBundle, workspace.path);
        try {
          proposeResult = await withStage(
            'patch_propose',
            'LLM',
            async (stageSpan) => {
              const proposal = await proposePatch({ issue: mandate!, rubric: rubricResult!, sources }, runId);
              stageSpan.setAttribute('foreman.llm.model', proposal.model);
              stageSpan.setAttribute('foreman.patch.edit_count', proposal.edits.length);
              stageSpan.setAttribute('foreman.patch.attempts', proposal.attempts);
              stageSpan.setAttribute('foreman.patch.source_snippets', sources.length);
              if (proposal.usage?.promptTokens !== undefined) stageSpan.setAttribute('foreman.llm.prompt_tokens', proposal.usage.promptTokens);
              if (proposal.usage?.completionTokens !== undefined) stageSpan.setAttribute('foreman.llm.completion_tokens', proposal.usage.completionTokens);
              return proposal;
            },
            { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
          );
        } catch (err) {
          stoppedReason = err instanceof Error ? err.message : String(err);
        }
      }

      // --- Apply (TOOL) ---
      if (proposeResult) {
        applyResult = await withStage(
          'apply',
          'TOOL',
          async (stageSpan) => {
            const res = applyEdits(workspace.path, proposeResult!.edits);
            stageSpan.setAttribute('foreman.apply.ok', res.ok);
            if (res.ok) {
              stageSpan.setAttribute('foreman.apply.files', res.applied.length);
            } else {
              stageSpan.setAttribute('foreman.apply.reason', res.reason);
            }
            return res;
          },
          { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
        );

        if (!applyResult.ok) {
          appendFact(runId, {
            type: 'attempt_failed',
            attempt: 1,
            failureClass: applyResult.reason.includes('times') ? 'stuck_duplicate' : 'no_evidence',
          });
          stoppedReason = `Patch application failed: ${applyResult.reason}`;
        }
      }

      // --- Diff, hash, patch_proposed (after apply) ---
      if (applyResult?.ok) {
        const diff = gitDiff(workspace.path);
        diffHash = crypto.createHash('sha256').update(diff).digest('hex');
        appendFact(runId, { type: 'patch_proposed', attempt: 1, diffHash });

        const dir = ensureRunDir(runId);
        fs.writeFileSync(path.join(dir, 'attempt-1.diff'), diff + '\n', 'utf-8');

        // --- Tests (EVALUATOR) ---
        finalTests = await withStage(
          'tests',
          'EVALUATOR',
          async (stageSpan) => {
            const testRes = runTests(workspace.path);
            stageSpan.setAttribute('foreman.tests.passed', testRes.passed);
            stageSpan.setAttribute('foreman.tests.failed', testRes.failed);
            stageSpan.setAttribute('foreman.tests.exit_code', testRes.exitCode);
            stageSpan.setAttribute('foreman.tests.duration_ms', testRes.durationMs);
            return testRes;
          },
          { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
        );

        const testsPassed = finalTests.exitCode === 0 && finalTests.failed === 0;
        appendFact(runId, {
          type: 'tests_result',
          attempt: 1,
          passed: testsPassed,
          failingTests: finalTests.failingTests,
        });

        fs.writeFileSync(path.join(runDirPath(runId), 'tests-1.txt'), finalTests.output, 'utf-8');
      }
    } else if (mandate) {
      appendFact(runId, {
        type: 'mandate_created',
        issueId,
        title: mandate.title,
        criteriaCount: mandate.acceptanceCriteria.length,
        hintedSymbols: mandate.hintedSymbols,
        hintedPaths: mandate.hintedPaths,
      });
    }

    // --- Console summary (no emojis) ---
    const facts = readFacts(runId);
    const derivedStatus = deriveStatus(facts);

    console.log('Foreman Run Summary');
    console.log('===================');
    console.log(`Run ID: ${runId}`);
    console.log(`Issue: ${issueId}`);
    console.log(`Through: ${throughTests ? 'tests' : shouldRunContext ? 'context' : 'setup'}`);
    console.log(`Derived Status: ${derivedStatus}`);
    console.log(`Trace ID: ${currentTraceId}`);
    console.log(`Workspace Path: ${workspace.path}`);
    console.log(`Base Commit: ${workspace.baseCommit}`);
    console.log(`Branch: ${workspace.branch}`);
    console.log(
      `Baseline Tests: ${baseline.passed} passed, ${baseline.failed} failed, exit code ${baseline.exitCode} (${baseline.durationMs}ms)`
    );
    if (baseline.failingTests.length > 0) {
      console.log(`Baseline Failing Tests: ${baseline.failingTests.join(', ')}`);
    }

    if (mandate) {
      console.log('\nMandate Summary');
      console.log('---------------');
      console.log(`Title: ${mandate.title}`);
      console.log(`Summary: ${mandate.summary}`);
      console.log(`Acceptance Criteria (${mandate.acceptanceCriteria.length}):`);
      for (const c of mandate.acceptanceCriteria) console.log(`  - ${c}`);
      if (mandate.hintedSymbols.length > 0) console.log(`Hinted Symbols: ${mandate.hintedSymbols.join(', ')}`);
      if (mandate.hintedPaths.length > 0) console.log(`Hinted Paths: ${mandate.hintedPaths.join(', ')}`);
    }

    if (contextBundle) {
      console.log('\nStructural Context Summary');
      console.log('--------------------------');
      if (contextBundle.indexSummary) {
        console.log(
          `Index: ${contextBundle.indexSummary.files} files, ${contextBundle.indexSummary.symbols} symbols, ${contextBundle.indexSummary.relations} relations (completeness: ${contextBundle.indexSummary.completeness})`
        );
      }
      console.log(`Queries Run (${contextBundle.queriesRun.length}):`);
      for (const q of contextBundle.queriesRun) console.log(`  > entire graph ${q}`);
      console.log(`Findings (${contextBundle.findings.length}):`);
      for (const f of contextBundle.findings.slice(0, 10)) {
        console.log(`  [${f.kind}] ${f.symbol} (${f.file}): ${f.evidence.slice(0, 80)}`);
      }
      if (contextBundle.findings.length > 10) {
        console.log(`  ... and ${contextBundle.findings.length - 10} more findings`);
      }
      if (contextBundle.symbolFacts.length > 0) {
        console.log(`Symbol Facts (${contextBundle.symbolFacts.length}):`);
        for (const sf of contextBundle.symbolFacts) {
          console.log(`  ${sf.symbol} (${sf.file}): callers=${sf.callerCount} callees=${sf.calleeCount}`);
        }
      }
    }

    if (rubricResult) {
      console.log('\nRubric');
      console.log('------');
      console.log(`Model: ${rubricResult.model} (attempts: ${rubricResult.attempts})`);
      for (const c of rubricResult.criteria) console.log(`  [${c.check}] ${c.id}: ${c.text}`);
    }

    if (proposeResult) {
      console.log('\nPatch Proposal');
      console.log('--------------');
      console.log(`Model: ${proposeResult.model} (attempts: ${proposeResult.attempts})`);
      for (const e of proposeResult.edits) {
        const firstLine = e.search.split('\n')[0].slice(0, 70);
        console.log(`  edit ${e.file}: search[${e.search.length} chars] starts "${firstLine}"`);
      }
      if (applyResult) {
        console.log(`Apply: ${applyResult.ok ? `ok (${applyResult.applied.length} file(s))` : `FAILED (${applyResult.reason})`}`);
      }
      if (diffHash) console.log(`Diff Hash (sha256): ${diffHash}`);
    }

    if (finalTests) {
      console.log('\nPost-Patch Tests');
      console.log('----------------');
      console.log(
        `Result: ${finalTests.passed} passed, ${finalTests.failed} failed, exit code ${finalTests.exitCode} (${finalTests.durationMs}ms)`
      );
      if (finalTests.failingTests.length > 0) {
        console.log(`Failing Tests: ${finalTests.failingTests.join(', ')}`);
      } else {
        console.log('Failing Tests: none');
      }
    }

    if (stoppedReason) {
      console.log('\nStopped');
      console.log('-------');
      console.log(stoppedReason);
    }

    const totals = cumulativeTokens();
    const cost = cumulativeCost();
    console.log('\nLedger');
    console.log('------');
    console.log(`Model calls tokens (all runs): prompt=${totals.prompt} completion=${totals.completion} total=${totals.total}`);
    console.log(`Estimated cost (all runs): $${cost.toFixed(6)} (ESTIMATES; gateway billing may differ)`);

    console.log(`\nFacts Count: ${facts.length}`);

    return { derivedStatus };
  });

  await flushTelemetry();
  await shutdownTelemetry();
}

const isDirectRun =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('Foreman CLI Error:', err);
    process.exit(1);
  });
}
