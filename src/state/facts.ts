import fs from 'node:fs';
import path from 'node:path';

export type PatchSource = 'model' | 'injected';

export type AttemptFailureClass =
  | 'blocked_policy'
  | 'tests_failed'
  | 'rejected_validator'
  | 'apply_failed'
  | 'error_transient'
  | 'no_evidence'
  | 'stuck_duplicate';

export type FactPayload =
  | { type: 'run_started'; runId: string; issueId: string }
  | { type: 'workspace_created'; baseCommit: string; branch: string; path: string }
  | { type: 'baseline_recorded'; exitCode: number; passed: number; failed: number; failingTests: string[] }
  | {
      type: 'mandate_created';
      issueId?: string;
      title?: string;
      criteriaCount?: number;
      hintedSymbols?: string[];
      hintedPaths?: string[];
      /** Rubric criteria count (model-built) when a rubric was produced. */
      rubricCriteriaCount?: number;
      /** Model used to build the rubric. */
      rubricModel?: string;
    }
  | {
      type: 'context_built';
      queryCount?: number;
      findingCount?: number;
      indexedSymbols?: number;
    }
  | {
      type: 'rubric_created';
      model?: string;
      criteria: { id: string; text: string; check: string; evidence_ref?: { kind: string; value: string } }[];
    }
  | { type: 'criteria_dropped'; ids: string[]; reasons: string[] }
  | {
      type: 'code_verdicts';
      attempt: number;
      verdicts: { id: string; criterion: string; source: string; verdict: string; confidence: number; reason: string }[];
    }
  | { type: 'patch_proposed'; attempt: number; diffHash: string; patchSource?: PatchSource }
  | { type: 'gate_result'; attempt: number; passed: boolean; failedRules: string[] }
  | {
      type: 'tests_result';
      attempt: number;
      /** true only when the target test passes AND there are no regressions */
      passed: boolean;
      /** the test named repro-issue-<n> passed */
      targetPassed?: boolean;
      /** tests that passed at baseline and fail now */
      regressions?: string[];
      failingTests: string[];
    }
  | {
      type: 'validator_result';
      attempt: number;
      /** combined: code verdicts pass AND every judgment criterion is a confident pass */
      allCriteriaPass: boolean;
      /** the validator's own judgment-group result, before combining with code */
      judgmentAllPass?: boolean;
      /** validator model name */
      model?: string;
      /** true when this result came from the one evidence-escalation re-run */
      escalated?: boolean;
      /** per-criterion verdicts */
      criteria?: {
        id: string;
        verdict: string;
        confidence: number;
        reason: string;
        missing_evidence?: string;
      }[];
    }
  | {
      type: 'validator_escalated';
      attempt: number;
      /** rubric ids that were unclear and triggered the escalation */
      unclearIds: string[];
    }
  | { type: 'attempt_failed'; attempt: number; failureClass: AttemptFailureClass }
  | {
      type: 'error_transient';
      /** deliberately NOT named "attempt": transient errors must not shift derived status */
      duringAttempt: number;
      error: string;
      retries: number;
    }
  | { type: 'budget_checked'; exhausted: boolean }
  | { type: 'needs_human'; reason: string }
  | { type: 'shipped' };

export type Fact = FactPayload & {
  seq: number;
  ts: string;
};

export interface AppendFactOptions {
  runsDir?: string;
}

export function getFactsFilePath(runId: string, runsDir = 'runs'): string {
  return path.join(runsDir, runId, 'facts.jsonl');
}

export function readFacts(runId: string, runsDir = 'runs'): Fact[] {
  const filePath = getFactsFilePath(runId, runsDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as Fact);
}

export function appendFact(runId: string, payload: FactPayload, options?: AppendFactOptions): Fact {
  const runsDir = options?.runsDir ?? 'runs';
  const runDir = path.join(runsDir, runId);
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }

  const filePath = getFactsFilePath(runId, runsDir);
  const existingFacts = readFacts(runId, runsDir);
  const seq = existingFacts.length + 1;
  const ts = new Date().toISOString();

  const fact: Fact = {
    seq,
    ts,
    ...payload,
  };

  const line = JSON.stringify(fact) + '\n';
  fs.appendFileSync(filePath, line, { encoding: 'utf-8', flag: 'a' });
  return fact;
}
