#!/usr/bin/env node
import { createWorkspace } from '../run/workspace.js';
import { runTests } from '../run/tests.js';
import { appendFact, readFacts } from '../state/facts.js';
import { deriveStatus } from '../state/derive.js';
import { withWorkflow, withStage, flushTelemetry, shutdownTelemetry } from '../telemetry/index.js';

interface CliArgs {
  command?: string;
  issue?: string;
  setupOnly: boolean;
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
    }
  }

  return result;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.command !== 'run' || !parsed.issue) {
    console.error('Usage: foreman run --issue <n> [--setup-only]');
    process.exit(1);
  }

  const issueId = parsed.issue;
  const runId = `run-${Date.now()}`;

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

    // 4. Derive status from facts
    const facts = readFacts(runId);
    const derivedStatus = deriveStatus(facts);

    // 5. Print summary (strictly no emojis)
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
    console.log(`Facts Count: ${facts.length}`);

    return { workspace, baseline, derivedStatus };
  });

  // Flush and clean shutdown
  await flushTelemetry();
  await shutdownTelemetry();
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('Foreman CLI Error:', err);
    process.exit(1);
  });
}
