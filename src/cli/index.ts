#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {
  createWorkspace,
  commitAttempt,
  gitDiffRange,
  gitShowFile,
  resetToBase,
  type WorkspaceResult,
} from '../run/workspace.js';
import { parseTestOutput, runTests, type TestRunResult } from '../run/tests.js';
import { appendFact, readFacts, type PatchSource } from '../state/facts.js';
import { deriveStatus } from '../state/derive.js';
import { loadMandate, type Mandate } from '../mandate/load.js';
import { buildContext, buildNoGraphContext, type ContextBundle } from '../context/graph.js';
import { buildRubric, scanTestNames, type RubricResult } from '../mandate/rubric.js';
import {
  proposePatch,
  applyEdits,
  buildSourceBundle,
  extractSymbolBody,
  findReproTest,
  validateEditsPayload,
  type PatchEdit,
} from '../patch/propose.js';
import { collectChanges, callerCountFor } from '../policy/changed.js';
import { loadPolicy, runGate } from '../policy/gate.js';
import {
  runSupervisor,
  writeRunReport,
  writeEconomics,
  type SupervisorEngine,
  type SupervisorInstrument,
  type SpanLike,
} from '../run/supervisor.js';
import { validatePatch } from '../validator/index.js';
import {
  withWorkflow,
  withStage,
  flushTelemetry,
  shutdownTelemetry,
  type SupportedSpanKind,
} from '../telemetry/index.js';
import {
  assertStepBudgetAllowed,
  assertStepRunAllowed,
  cumulativeCost,
  cumulativeTokens,
  runTotals,
} from '../model/index.js';
import { spawnSync } from 'node:child_process';
import { format } from 'node:util';

interface CliArgs {
  command?: string;
  issue?: string;
  setupOnly: boolean;
  through?: string;
  firstAttemptPatchFrom?: string;
  noGraph: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = { setupOnly: false, noGraph: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'run') result.command = 'run';
    else if (arg === '--issue') {
      result.issue = args[i + 1];
      i++;
    } else if (arg === '--setup-only') result.setupOnly = true;
    else if (arg === '--no-graph') result.noGraph = true;
    else if (arg === '--through') {
      result.through = args[i + 1];
      i++;
    } else if (arg === '--first-attempt-patch-from' || arg === '--patch-from') {
      result.firstAttemptPatchFrom = args[i + 1];
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

function persistContext(
  runId: string,
  workspace: WorkspaceResult,
  mandate: Mandate,
  noGraph = false
): ContextBundle {
  const dir = ensureRunDir(runId);
  fs.writeFileSync(path.join(dir, 'mandate.json'), JSON.stringify(mandate, null, 2) + '\n', 'utf-8');

  const { bundle, rawCommands } = noGraph
    ? buildNoGraphContext(workspace.path, mandate)
    : buildContext(workspace.path, mandate);
  fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(bundle, null, 2) + '\n', 'utf-8');

  const graphRawDir = path.join(dir, 'graph-raw');
  if (!fs.existsSync(graphRawDir)) fs.mkdirSync(graphRawDir, { recursive: true });
  rawCommands.forEach((cmd, index) => {
    const name = `${String(index + 1).padStart(2, '0')}-${sanitizeGraphArgs(cmd.args)}.json`;
    fs.writeFileSync(path.join(graphRawDir, name), cmd.stdout + '\n', 'utf-8');
  });

  return bundle;
}

function teeConsole(runDir: string): () => void {
  const logPath = path.join(runDir, 'console.log');
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = new Map<(typeof methods)[number], (...args: unknown[]) => void>();
  for (const method of methods) {
    const originalMethod = console[method] as (...args: unknown[]) => void;
    const original = originalMethod.bind(console);
    originals.set(method, originalMethod);
    console[method] = ((...args: unknown[]) => {
      const rendered = format(...args)
        .replace(
          /(^|\n)\s*(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-litellm-(?!response-cost\b|key-spend\b)[a-z0-9-]+)\s*:\s*[^\r\n]*/gim,
          '$1$2: [REDACTED]'
        )
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_-]{10,}/g, '[REDACTED]');
      fs.appendFileSync(logPath, rendered + '\n', 'utf-8');
      original(rendered);
    }) as typeof console[typeof method];
  }
  return () => {
    for (const [method, original] of originals) console[method] = original as typeof console[typeof method];
  };
}

function runHoldout(
  runId: string,
  issueId: string,
  sourceRepo: string
): { passed: boolean; failingTests: string[]; output: string } {
  const workDir = path.resolve('.foreman-work', `holdout-${runId}`);
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.cpSync(path.join(sourceRepo, 'src'), path.join(workDir, 'src'), { recursive: true });
    fs.cpSync(path.resolve('holdout'), path.join(workDir, 'holdout'), { recursive: true });
    const testPath = `holdout/issue-${issueId}.test.ts`;
    const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
    const child = spawnSync(process.execPath, [tsxCli, '--test', testPath], {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 30000,
    });
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}${child.error ? `\n${child.error.message}` : ''}`;
    const parsed = parseTestOutput(output, child.status ?? 1);
    const passed = child.status === 0 && !child.error;
    return {
      passed,
      failingTests: passed
        ? []
        : parsed.failingTests.length > 0
          ? parsed.failingTests
          : [`holdout command failed (exit=${child.status}): ${child.error?.message ?? 'unknown failure'}`],
      output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { passed: false, failingTests: [`holdout execution error: ${message}`], output: message };
  }
}

function loadInjectedEdits(file: string): PatchEdit[] {
  if (!fs.existsSync(file)) throw new Error(`Injected patch file not found: ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const validation = validateEditsPayload(raw);
  if (!validation.ok) throw new Error(`Injected patch invalid: ${validation.errors.join('; ')}`);
  return validation.edits;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.command !== 'run' || !parsed.issue) {
    console.error(
      'Usage: foreman run --issue <n> [--setup-only] [--no-graph] [--through context] [--first-attempt-patch-from <file>]'
    );
    process.exit(1);
  }

  const issueId = parsed.issue;
  const shouldRunContext = !parsed.setupOnly;
  const runPipeline = !parsed.setupOnly && parsed.through !== 'context' && parsed.through !== 'setup-only';
  if (runPipeline) {
    assertStepRunAllowed();
    assertStepBudgetAllowed();
  }
  const runId = `run-${Date.now()}`;
  const runDir = path.resolve(runDirPath(runId));
  const startedAtMs = Date.now();
  const firstAttemptPatchFrom = parsed.firstAttemptPatchFrom;
  ensureRunDir(runId);
  const restoreConsole = teeConsole(runDir);
  if (parsed.noGraph) console.log('NO GRAPH MODE');

  let stoppedReason: string | undefined;

  let traceId = '';
  try {
  ({ traceId } = await withWorkflow(runId, issueId, async (_span, currentTraceId) => {
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
    let rubricResult: RubricResult | undefined;

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
          const ctx = persistContext(runId, workspace, mandate!, parsed.noGraph);
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

    let supervisorOutcome: { status: string; attempts: number; shipped: boolean } | undefined;

    if (runPipeline && mandate && contextBundle) {
      // ----- Rubric (LLM) -----
      try {
        rubricResult = await withStage(
          'rubric',
          'LLM',
          async (stageSpan) => {
            const knownSymbols = [
              ...mandate!.hintedSymbols,
              ...contextBundle!.symbolFacts.map((s) => s.symbol),
              ...contextBundle!.findings.map((f) => f.symbol),
            ];
            const rubric = await buildRubric(mandate!, runId, {
              validity: {
                knownTestNames: scanTestNames(workspace.path),
                knownSymbols,
              },
            });
            stageSpan.setAttribute('foreman.llm.model', rubric.model);
            stageSpan.setAttribute('foreman.rubric.criteria_count', rubric.criteria.length);
            if (rubric.usage?.promptTokens !== undefined) stageSpan.setAttribute('foreman.llm.prompt_tokens', rubric.usage.promptTokens);
            if (rubric.usage?.completionTokens !== undefined) stageSpan.setAttribute('foreman.llm.completion_tokens', rubric.usage.completionTokens);
            return rubric;
          },
          { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
        );
      } catch (err) {
        stoppedReason = err instanceof Error ? err.message : String(err);
      }

      appendFact(runId, {
        type: 'mandate_created',
        issueId,
        title: mandate.title,
        criteriaCount: rubricResult ? rubricResult.criteria.length : mandate.acceptanceCriteria.length,
        rubricCriteriaCount: rubricResult?.criteria.length,
        rubricModel: rubricResult?.model,
        hintedSymbols: mandate.hintedSymbols,
        hintedPaths: mandate.hintedPaths,
      });

      if (rubricResult) {
        appendFact(runId, {
          type: 'rubric_created',
          model: rubricResult.model,
          criteria: rubricResult.criteria.map((c) => ({
            id: c.id,
            text: c.text,
            check: c.check,
            evidence_ref: c.evidence_ref,
          })),
        });
        fs.writeFileSync(path.join(runDir, 'rubric.json'), JSON.stringify(rubricResult, null, 2) + '\n', 'utf-8');
      }

      if (rubricResult) {
        const sources = buildSourceBundle(contextBundle, workspace.path);
        const policy = loadPolicy();

        const contextSymbols = new Set<string>();
        for (const sf of contextBundle.symbolFacts) contextSymbols.add(sf.symbol);
        for (const f of contextBundle.findings) contextSymbols.add(f.symbol);

        const evidenceText = [
          contextBundle.notes,
          ...contextBundle.symbolFacts.map(
            (sf) => `symbol ${sf.symbol} (${sf.file ?? 'unknown'}): callers=${sf.callerCount} callees=${sf.calleeCount}`
          ),
          ...contextBundle.findings.slice(0, 40).map((f) => `${f.kind} ${f.symbol} @ ${f.file}: ${f.evidence}`),
        ].join('\n');

        const reproTest = findReproTest(workspace.path, issueId);

        let firstAttemptPatch: PatchEdit[] | undefined;
        if (firstAttemptPatchFrom) {
          firstAttemptPatch = loadInjectedEdits(firstAttemptPatchFrom);
          console.log('=========================================');
          console.log('INJECTED FIRST ATTEMPT');
          console.log(`Source: ${firstAttemptPatchFrom}`);
          console.log('Attempt 1 uses this injected patch; attempts 2+ come from the model.');
          console.log('=========================================');
        }

        const engine: SupervisorEngine = {
          reset: () => resetToBase(workspace.path, workspace.baseCommit),
          propose: async ({ attempt, memoryText, injected }) => {
            if (injected) {
              return { edits: injected, model: 'injected', patchSource: 'injected' as PatchSource };
            }
            const proposal = await withStage(
              'patch_propose',
              'LLM',
              async (stageSpan) => {
                const p = await proposePatch(
                  {
                    issue: mandate!,
                    rubric: rubricResult!,
                    sources,
                    memoryText,
                    policy: { allowedPaths: policy.allowedPaths, deniedPaths: policy.deniedPaths },
                    reproTest,
                  },
                  runId
                );
                stageSpan.setAttribute('foreman.llm.model', p.model);
                stageSpan.setAttribute('foreman.patch.edit_count', p.edits.length);
                stageSpan.setAttribute('foreman.patch.attempts', p.attempts);
                stageSpan.setAttribute('foreman.patch.memory_chars', memoryText.length);
                if (p.usage?.promptTokens !== undefined) stageSpan.setAttribute('foreman.llm.prompt_tokens', p.usage.promptTokens);
                if (p.usage?.completionTokens !== undefined) stageSpan.setAttribute('foreman.llm.completion_tokens', p.usage.completionTokens);
                return p;
              },
              { 'foreman.run_id': runId, 'foreman.issue_id': issueId, 'foreman.attempt': attempt }
            );
            return { edits: proposal.edits, model: proposal.model, patchSource: 'model' as PatchSource };
          },
          apply: (edits) => applyEdits(workspace.path, edits),
          commit: (message) => commitAttempt(workspace.path, message),
          diff: (base, head) => gitDiffRange(workspace.path, base, head),
          collect: (base, head) => collectChanges(workspace.path, base, head, !parsed.noGraph),
          gate: (ctx) =>
            runGate(ctx, policy, undefined, parsed.noGraph ? ['evidence_scope', 'blast_radius'] : []),
          tests: () => runTests(workspace.path),
          validate: (input) =>
            withStage(
              'validator',
              'EVALUATOR',
              () => validatePatch(input, runId, policy.validatorMinConfidence, undefined, policy.validatorModel),
              { 'foreman.run_id': runId, 'foreman.issue_id': issueId, 'foreman.validator.model': policy.validatorModel }
            ),
          callerCount: (symbol) => (parsed.noGraph ? null : callerCountFor(workspace.path, symbol)),
          readChangedFunctions: (change) =>
            change.changedSymbols.map((s) => {
              const full = path.resolve(workspace.path, s.file);
              const root = path.resolve(workspace.path);
              const after = full.startsWith(root) && fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : '';
              const before = gitShowFile(workspace.path, workspace.baseCommit, s.file);
              return {
                symbol: s.name,
                file: s.file,
                before: extractSymbolBody(before, s.name, 80),
                after: extractSymbolBody(after, s.name, 80),
              };
            }),
          callSites: () =>
            contextBundle.findings
              .filter((f) => f.callSiteFile !== undefined && f.callSiteLine !== undefined)
              .slice(0, 40)
              .map((f) => ({
                symbol: f.symbol,
                file: f.callSiteFile as string,
                line: f.callSiteLine,
                evidence: f.evidence,
              })),
          escalationEvidence: (change) => {
            const root = path.resolve(workspace.path);
            const read = (rel: string): string => {
              const full = path.resolve(workspace.path, rel);
              return full.startsWith(root) && fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : '';
            };
            const changedFileContents = change.changedFiles.map((cf) => ({ file: cf.path, content: read(cf.path) }));
            const callerFindings = contextBundle.findings
              .filter((f) => f.callSiteFile !== undefined && f.callSiteLine !== undefined)
              .slice(0, 10);
            const callerBodies = callerFindings.map((f) => ({
              symbol: f.symbol,
              file: f.file,
              content: extractSymbolBody(read(f.file), f.symbol, 120),
            }));
            return { changedFileContents, callerBodies };
          },
        };

        const instrument: SupervisorInstrument = {
          runAgent: (fn) =>
            withStage('supervisor', 'AGENT', (span) => fn(span as SpanLike), {
              'foreman.run_id': runId,
              'foreman.issue_id': issueId,
            }),
          runAttempt: (attempt, fn) =>
            withStage(
              `attempt-${attempt}`,
              'CHAIN',
              async (span) => {
                span.setAttribute('foreman.attempt', attempt);
                return await fn((outcome) => span.setAttribute('foreman.attempt.outcome', outcome));
              },
              { 'foreman.run_id': runId, 'foreman.issue_id': issueId }
            ),
          stage: (name, kind, fn, attrs) =>
            withStage(name, kind as SupportedSpanKind, async (span) => await fn(span as SpanLike), attrs),
        };

        try {
          const outcome = await runSupervisor({
            runId,
            issueId,
            runDir,
            policy,
            rubric: rubricResult,
            context: {
              contextSymbols: Array.from(contextSymbols),
              symbolFacts: contextBundle.symbolFacts.map((sf) => ({ symbol: sf.symbol, callerCount: sf.callerCount })),
              evidenceText,
            },
            baseCommit: workspace.baseCommit,
            engine,
            baselinePassing: baseline.passingTests,
            firstAttemptPatch,
            noGraph: parsed.noGraph,
            instrument,
            totals: () => runTotals(runId),
            wallClockMs: () => Date.now() - startedAtMs,
            log: (line) => console.log(line),
          });
          supervisorOutcome = { status: outcome.status, attempts: outcome.attempts, shipped: outcome.shipped };

          // ----- Reports (derived only from facts and the ledger) -----
          if (outcome.shipped) {
            const holdout = runHoldout(runId, issueId, workspace.path);
            fs.writeFileSync(path.join(runDir, `holdout-issue-${issueId}.txt`), holdout.output, 'utf-8');
            appendFact(runId, { type: 'holdout_result', issueId, passed: holdout.passed, failingTests: holdout.failingTests });
            console.log(`Held-out tests: ${holdout.passed ? 'passed' : `failed (${holdout.failingTests.join(', ')})`}`);
          }

          const facts = readFacts(runId);
          const status = deriveStatus(facts);
          const totals = runTotals(runId);
          const wallMs = Date.now() - startedAtMs;
          writeRunReport(
            {
              runId,
              runDir,
              issueId,
              issueTitle: mandate.title,
              traceId: currentTraceId,
              injected: Boolean(firstAttemptPatchFrom),
              memory: outcome.memory,
              outcome: status,
              attempts: outcome.attempts,
              noGraph: parsed.noGraph,
            },
            facts,
            totals,
            wallMs
          );
          writeEconomics(runDir, { runId, outcome: status, attempts: outcome.attempts }, totals, wallMs);
        } catch (err) {
          stoppedReason = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // ----- Console summary (no emojis) -----
    const facts = readFacts(runId);
    const derivedStatus = deriveStatus(facts);

    console.log('\nForeman Run Summary');
    console.log('===================');
    console.log(`Run ID: ${runId}`);
    console.log(`Issue: ${issueId}`);
    console.log(`Stage: ${parsed.setupOnly ? 'setup' : parsed.through === 'context' ? 'context' : 'full run'}`);
    if (firstAttemptPatchFrom) console.log(`Injected first attempt: ${firstAttemptPatchFrom}`);
    console.log(`Derived Status: ${derivedStatus}`);
    console.log(`Trace ID: ${currentTraceId}`);
    console.log(`Workspace Path: ${workspace.path}`);
    console.log(`Base Commit: ${workspace.baseCommit}`);
    console.log(`Branch: ${workspace.branch}`);
    console.log(
      `Baseline Tests: ${baseline.passed} passed, ${baseline.failed} failed, exit code ${baseline.exitCode} (${baseline.durationMs}ms)`
    );
    if (baseline.failingTests.length > 0) console.log(`Baseline Failing Tests: ${baseline.failingTests.join(', ')}`);

    if (mandate) {
      console.log('\nMandate Summary');
      console.log('---------------');
      console.log(`Title: ${mandate.title}`);
      console.log(`Acceptance Criteria (${mandate.acceptanceCriteria.length}):`);
      for (const c of mandate.acceptanceCriteria) console.log(`  - ${c}`);
    }

    if (rubricResult) {
      console.log('\nRubric');
      console.log('------');
      console.log(`Model: ${rubricResult.model} (attempts: ${rubricResult.attempts})`);
      for (const c of rubricResult.criteria) console.log(`  [${c.check}] ${c.id}: ${c.text}`);
    }

    if (supervisorOutcome) {
      console.log('\nSupervisor');
      console.log('----------');
      console.log(`Attempts used: ${supervisorOutcome.attempts}`);
      console.log(`Shipped: ${supervisorOutcome.shipped}`);
      if (supervisorOutcome.shipped) {
        console.log('Ships as: a commit on the run branch inside the run copy, plus proposed.patch in the run directory.');
        console.log('NO pull request was opened.');
      } else if (derivedStatus === 'needs_human' || derivedStatus === 'budget_exhausted') {
        console.log(`Terminal stop: ${derivedStatus}. See ${path.relative(process.cwd(), path.join(runDir, 'NEEDS_HUMAN.md'))}.`);
      }
      console.log(`Report: ${path.relative(process.cwd(), path.join(runDir, 'report.md'))}`);
      console.log(`Economics: ${path.relative(process.cwd(), path.join(runDir, 'economics.json'))}`);
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
    console.log(`Cost (all runs, gateway-reported where available): $${cost.toFixed(6)}`);
    console.log(`\nFacts Count: ${facts.length}`);

    return { derivedStatus };
  }));
  } finally {
    restoreConsole();
  }

  await flushTelemetry();
  await shutdownTelemetry();
}

const isDirectRun =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('Foreman CLI Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
