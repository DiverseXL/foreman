/**
 * DEV DOCUMENTATION TOOL — derives the Known limitations run inventory from runs/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { deriveStatus } from '../src/state/derive.js';
import type { Fact } from '../src/state/facts.js';

const markerStart = '<!-- run-inventory:start -->';
const markerEnd = '<!-- run-inventory:end -->';
const documentPath = path.resolve('hackathon.md');
const runsPath = path.resolve('runs');

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function runRows(): { runId: string; issue: string; mode: string; outcome: string; attempts: number; source: string }[] {
  return fs
    .readdirSync(runsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
    .map((entry) => {
      const runId = entry.name;
      const directory = path.join(runsPath, runId);
      const factsPath = path.join(directory, 'facts.jsonl');
      const facts: Fact[] = fs.existsSync(factsPath)
        ? fs.readFileSync(factsPath, 'utf-8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Fact)
        : [];
      const issue = facts.find((fact) => fact.type === 'run_started')?.issueId ?? 'unknown';
      const patchSources = Array.from(new Set(
        facts.flatMap((fact) => (fact.type === 'patch_proposed' ? [fact.patchSource ?? 'model'] : []))
      ));
      const contextPath = path.join(directory, 'context.json');
      const noGraph = fs.existsSync(contextPath) && /NO GRAPH MODE/.test(fs.readFileSync(contextPath, 'utf-8'));
      const attempts = Math.max(0, ...facts.flatMap((fact) => ('attempt' in fact && typeof fact.attempt === 'number' ? [fact.attempt] : [])));
      const derivedOutcome = facts.length > 0 ? deriveStatus(facts) : 'no_facts';
      return {
        runId,
        issue,
        mode: noGraph ? 'no-graph' : 'graph',
        outcome: derivedOutcome === 'working' ? 'incomplete' : derivedOutcome,
        attempts,
        source: patchSources.length === 0 ? 'none' : patchSources.join('+'),
      };
    })
    .sort((a, b) => a.runId.localeCompare(b.runId));
}

function renderBlock(rows: ReturnType<typeof runRows>): string {
  const shipped = rows.filter((row) => row.outcome === 'shipped');
  const modelOnly = shipped.filter((row) => row.source === 'model').length;
  const lines = [
    '## Every run (generated from the runs/ folders)',
    '',
    `Counts: ${rows.length} run folders; ${shipped.length} shipped; ${modelOnly} model-only shipped of ${rows.length} total runs.`,
    '',
    '| Run | Issue | Mode | Outcome | Attempts | Patch source |',
    '| --- | --- | --- | --- | ---: | --- |',
    ...rows.map((row) => `| ${row.runId} | ${row.issue} | ${row.mode} | ${row.outcome} | ${row.attempts} | ${row.source} |`),
  ];
  return lines.join('\n');
}

const doc = fs.readFileSync(documentPath, 'utf-8');
const start = doc.indexOf(markerStart);
const end = doc.indexOf(markerEnd);
if (start < 0 || end < 0 || end <= start) {
  throw new Error(`Expected run inventory markers ${markerStart} and ${markerEnd} in hackathon.md.`);
}
const rows = runRows();
const replacement = `${markerStart}\n${renderBlock(rows)}\n${markerEnd}`;
const updated = doc.slice(0, start) + replacement + doc.slice(end + markerEnd.length);
fs.writeFileSync(documentPath, updated, 'utf-8');
console.log(`Generated ${rows.length} run rows; model-only shipped=${rows.filter((row) => row.outcome === 'shipped' && row.source === 'model').length}.`);
