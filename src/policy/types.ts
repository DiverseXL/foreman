/**
 * Policy gate types.
 *
 * Design rule: the model proposes and plain code decides. Every rule is a pure
 * function of (GateContext, Policy) returning {ruleId, passed, detail}. The
 * runner wraps each rule in try/catch and treats ANY throw as passed=false.
 */

export interface Policy {
  version: number;
  allowedPaths: string[];
  deniedPaths: string[];
  denyDotfiles: boolean;
  maxFiles: number;
  maxChangedLines: number;
  maxTransitiveCallers: number;
  /** Supervisor: maximum patch attempts per run (added in step 7). */
  maxAttempts: number;
  /** Validator: minimum confidence for a "pass" verdict to count (added in step 7). */
  validatorMinConfidence: number;
  /** Budget: per-run token cap (added in step 7). */
  maxTokensPerRun: number;
  /** Budget: per-run wall-clock cap in seconds (added in step 7). */
  maxWallSeconds: number;
  lockfiles: string[];
  secretPatterns: string[];
}

export interface ChangedFile {
  path: string;
  /** git name-status code: A, M, D, R, C, T */
  status: string;
  added: number;
  removed: number;
}

export interface ChangedSymbol {
  name: string;
  kind: string;
  file: string;
}

export interface GateContext {
  changedFiles: ChangedFile[];
  changedSymbols: ChangedSymbol[];
  /** Added lines (without the leading '+') from the attempt diff. */
  addedLines: string[];
  /** Symbols known to the graph context (symbolFacts + findings). */
  contextSymbols: string[];
  /** symbol name -> caller count (direct + transitive). */
  symbolCallerCounts: Record<string, number>;
}

export interface RuleResult {
  ruleId: string;
  passed: boolean;
  detail: string;
}

export type Rule = ((ctx: GateContext, policy: Policy) => RuleResult) & { ruleId?: string };

export interface GateResult {
  passed: boolean;
  rules: RuleResult[];
  failedRules: string[];
}
