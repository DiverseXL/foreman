#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWorkspace } from '../run/workspace.js';
import { runTests } from '../run/tests.js';
import { appendFact, readFacts } from '../state/facts.js';
import { deriveStatus } from '../state/derive.js';
import { loadMandate, type Mandate } from '../mandate/load.js';
import { buildContext, type ContextBundle } from '../context/graph.js';
import { withWorkflow, withStage, flushTelemetry, shutdownTelemetry } from '../telemetry/index.js';

interface CliArgs {
  command?: string;
  issue?: string;
  setupOnly: boolean;
  through?: string;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    setupOnly: false,
  };

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

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.command !== 'run' || !parsed.issue) {
    console.error('Usage: foreman run --issue <n> [--setup-only] [--through context]');
    process.exit(1);
  }

  const issueId = parsed.issue;
  const runId = `run-${Date.now()}`;
  const shouldRunContext = !parsed.setupOnly && (parsed.through === undefined || parsed.through === 'context');

  const { traceId } = await withWorkflow(runId, issueId, async (_span, currentTraceId) => {
    // 1. Record run_started fact
    appendFact(runId, {
      type: 'run_started',
      runId,
      issueId,
    });

    // 2. Set up workspace
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

    // 3. Run baseline tests
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
      {
        'foreman.run_id': runId,
        'foreman.issue_id': issueId,
      }
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

    // 4. Load mandate & gather context unless --setup-only
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
        {
          'foreman.run_id': runId,
          'foreman.issue_id': issueId,
        }
      );

      appendFact(runId, {
        type: 'mandate_created',
        issueId,
        title: mandate.title,
        criteriaCount: mandate.acceptanceCriteria.length,
        hintedSymbols: mandate.hintedSymbols,
        hintedPaths: mandate.hintedPaths,
      });

      contextBundle = await withStage(
        'graph_context',
        'RETRIEVER',
        async (stageSpan) => {
          const ctx = buildContext(workspace.path, mandate!);
          stageSpan.setAttribute('foreman.context.query_count', ctx.queriesRun.length);
          stageSpan.setAttribute('foreman.context.finding_count', ctx.findings.length);
          if (ctx.indexSummary) {
            stageSpan.setAttribute('foreman.context.indexed_symbols', ctx.indexSummary.symbols);
          }
          return ctx;
        },
        {
          'foreman.run_id': runId,
          'foreman.issue_id': issueId,
        }
      );

      appendFact(runId, {
        type: 'context_built',
        queryCount: contextBundle.queriesRun.length,
        findingCount: contextBundle.findings.length,
        indexedSymbols: contextBundle.indexSummary?.symbols ?? 0,
      });
    }

    // 5. Derive status from facts
    const facts = readFacts(runId);
    const derivedStatus = deriveStatus(facts);

    // 6. Print console summary (strictly no emojis)
    console.log('Foreman Run Summary');
    console.log('===================');
    console.log(`Run ID: ${runId}`);
    console.log(`Issue: ${issueId}`);
    console.log(`Derived Status: ${derivedStatus}`);
    console.log(`Trace ID: ${currentTraceId}`);
    console.log(`Workspace Path: ${workspace.path}`);
    console.log(`Base Commit: ${workspace.baseCommit}`);
    console.log(`Branch: ${workspace.branch}`);
    console.log(
      `Baseline Tests: ${baseline.passed} passed, ${baseline.failed} failed, exit code ${baseline.exitCode} (${baseline.durationMs}ms)`
    );
    if (baseline.failingTests.length > 0) {
      console.log(`Failing Tests: ${baseline.failingTests.join(', ')}`);
    }

    if (mandate) {
      console.log('\nMandate Summary');
      console.log('---------------');
      console.log(`Title: ${mandate.title}`);
      console.log(`Summary: ${mandate.summary}`);
      console.log(`Acceptance Criteria (${mandate.acceptanceCriteria.length}):`);
      for (const c of mandate.acceptanceCriteria) {
        console.log(`  - ${c}`);
      }
      if (mandate.hintedSymbols.length > 0) {
        console.log(`Hinted Symbols: ${mandate.hintedSymbols.join(', ')}`);
      }
      if (mandate.hintedPaths.length > 0) {
        console.log(`Hinted Paths: ${mandate.hintedPaths.join(', ')}`);
      }
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
      for (const q of contextBundle.queriesRun) {
        console.log(`  > entire graph ${q}`);
      }
      console.log(`Findings (${contextBundle.findings.length}):`);
      for (const f of contextBundle.findings.slice(0, 10)) {
        console.log(`  [${f.kind}] ${f.symbol} (${f.file}): ${f.evidence.slice(0, 80)}`);
      }
      if (contextBundle.findings.length > 10) {
        console.log(`  ... and ${contextBundle.findings.length - 10} more findings`);
      }
      console.log(`Notes: ${contextBundle.notes}`);
    }

    console.log(`\nFacts Count: ${facts.length}`);

    return { workspace, baseline, mandate, contextBundle, derivedStatus };
  });

  // Flush and clean shutdown
  await flushTelemetry();
  await shutdownTelemetry();
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('Foreman CLI Error:', err);
    process.exit(1);
  });
}
