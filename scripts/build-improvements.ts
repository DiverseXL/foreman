import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Fact } from '../src/state/facts.js';

interface ComparisonCommit {
  sha: string;
  date: string;
  timestamp: number;
}

interface RunEvidence {
  runId: string;
  issue: string;
  attempts: Set<number>;
  applyFailedAttempts: number[];
  testsProtectedFailedAttempts: number[];
  traceId: string | null;
}

interface ComparisonSide {
  runs: RunEvidence[];
  attempts: number;
  events: number;
  traceIds: string[];
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function findChangeCommit(file: string, matches: (source: string) => boolean): ComparisonCommit {
  const history = git(['log', '--format=%H%x09%cI', '--', file])
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of history) {
    const [sha, date] = line.split('\t');
    if (!sha || !date) continue;
    const change = git(['show', '--format=', '--unified=0', sha, '--', file]);
    if (matches(change)) {
      const timestamp = Date.parse(date);
      if (!Number.isFinite(timestamp)) throw new Error(`Invalid Git date for ${sha}: ${date}`);
      return { sha, date, timestamp };
    }
  }
  throw new Error(`Could not find the requested historical change in ${file}.`);
}

export function findComparisonCommits(): { lineEndings: ComparisonCommit; readOnlyPrompt: ComparisonCommit } {
  const lineEndings = findChangeCommit(
    'src/run/workspace.ts',
    (source) => source.includes("core.autocrlf false") && source.includes("core.eol lf")
  );
  const readOnlyPrompt = findChangeCommit(
    'src/patch/propose.ts',
    (source) => source.includes('READ-ONLY PATHS') && source.includes('READ ONLY EVIDENCE')
  );
  return { lineEndings, readOnlyPrompt };
}

function parseFacts(file: string): Fact[] {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Fact);
}

function extractTraceId(runDir: string): string | null {
  const economicsPath = path.join(runDir, 'economics.json');
  if (!fs.existsSync(economicsPath)) return null;
  const economics = JSON.parse(fs.readFileSync(economicsPath, 'utf8')) as Record<string, unknown>;
  const traceId = economics.traceId ?? economics.trace_id;
  return typeof traceId === 'string' && traceId.length > 0 ? traceId : null;
}

export function collectRunEvidence(runsDir = 'runs'): RunEvidence[] {
  if (!fs.existsSync(runsDir)) return [];
  const runDirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^run-\d+$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const result: RunEvidence[] = [];
  for (const entry of runDirs) {
    const runDir = path.join(runsDir, entry.name);
    const factsPath = path.join(runDir, 'facts.jsonl');
    if (!fs.existsSync(factsPath)) continue;
    const facts = parseFacts(factsPath);
    const started = facts.find((fact) => fact.type === 'run_started');
    const attempts = new Set<number>();
    for (const fact of facts) {
      if ('attempt' in fact && typeof fact.attempt === 'number') attempts.add(fact.attempt);
    }
    result.push({
      runId: entry.name,
      issue: started?.type === 'run_started' ? started.issueId : 'unknown',
      attempts,
      applyFailedAttempts: facts.flatMap((fact) =>
        fact.type === 'attempt_failed' && fact.failureClass === 'apply_failed' ? [fact.attempt] : []
      ),
      testsProtectedFailedAttempts: facts.flatMap((fact) =>
        fact.type === 'gate_result' && fact.failedRules.includes('tests_protected') ? [fact.attempt] : []
      ),
      traceId: extractTraceId(runDir),
    });
  }
  return result;
}

function comparisonSide(
  runs: readonly RunEvidence[],
  beforeTimestamp: number,
  before: boolean,
  eventType: 'apply_failed' | 'tests_protected'
): ComparisonSide {
  const selected = runs.filter((run) => {
    const timestampMatch = run.runId.match(/^run-(\d+)$/);
    const timestamp = timestampMatch ? Number(timestampMatch[1]) : Number.NaN;
    return Number.isFinite(timestamp) && (before ? timestamp < beforeTimestamp : timestamp >= beforeTimestamp);
  });
  const events = selected.flatMap((run) =>
    eventType === 'apply_failed' ? run.applyFailedAttempts : run.testsProtectedFailedAttempts
  ).length;
  return {
    runs: selected,
    attempts: selected.reduce((total, run) => total + run.attempts.size, 0),
    events,
    traceIds: selected
      .filter((run) =>
        (eventType === 'apply_failed' ? run.applyFailedAttempts : run.testsProtectedFailedAttempts).length > 0
      )
      .flatMap((run) => (run.traceId ? [run.traceId] : [])),
  };
}

export function buildImprovementMarkdown(
  runs: readonly RunEvidence[],
  commits: ReturnType<typeof findComparisonCommits>
): string {
  const comparisons = [
    {
      heading: 'apply_failed facts per attempt',
      eventName: 'apply_failed facts',
      commit: commits.lineEndings,
      before: comparisonSide(runs, commits.lineEndings.timestamp, true, 'apply_failed'),
      after: comparisonSide(runs, commits.lineEndings.timestamp, false, 'apply_failed'),
    },
    {
      heading: 'tests_protected gate failures per attempt',
      eventName: 'tests_protected gate failures',
      commit: commits.readOnlyPrompt,
      before: comparisonSide(runs, commits.readOnlyPrompt.timestamp, true, 'tests_protected'),
      after: comparisonSide(runs, commits.readOnlyPrompt.timestamp, false, 'tests_protected'),
    },
  ];
  const lines = [
    '# Before/after observations',
    '',
    'These comparisons use run-folder epoch timestamps, append-only run facts, and the corresponding Git change timestamps.',
    '',
  ];
  for (const comparison of comparisons) {
    lines.push(
      `## ${comparison.heading}`,
      '',
      `Change commit: \`${comparison.commit.sha}\` (${comparison.commit.date}).`,
      '',
      `| Period | Runs (n) | Attempts | ${comparison.eventName} (events) | Rate (events/attempt) | Trace IDs for event runs (when in economics.json) |`,
      '| --- | ---: | ---: | ---: | ---: | --- |'
    );
    for (const [label, side] of [
      ['Before', comparison.before],
      ['After', comparison.after],
    ] as const) {
      const rate = side.attempts > 0 ? (side.events / side.attempts).toFixed(4) : 'n/a';
      const traces = side.traceIds.length ? side.traceIds.join(', ') : 'n/a';
      lines.push(
        `| ${label} | ${side.runs.length} | ${side.attempts} | ${side.events} | ${rate} | ${traces} |`
      );
      if (side.runs.length === 0) {
        lines.push(`| Note | n=0 on this side; no comparison sample is available. | | | | |`);
      }
    }
    lines.push('');
  }
  lines.push(
    'The commits changed more than one thing, samples are small, and these before/after measurements are correlation, not proof.',
    ''
  );
  return lines.join('\n');
}

export function buildImprovements(root = process.cwd()): string {
  const commits = findComparisonCommits();
  const runs = collectRunEvidence(path.join(root, 'runs'));
  const markdown = buildImprovementMarkdown(runs, commits);
  const outputPath = path.join(root, 'docs', 'evidence', 'improvements.md');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, 'utf8');
  return markdown;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(buildImprovements());
  } catch (error) {
    console.error(`Improvements report failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
