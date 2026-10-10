import fs from 'node:fs';
import path from 'node:path';
import { RULES } from './rules.js';
import type { GateContext, GateResult, Policy, Rule, RuleResult } from './types.js';

export function loadPolicy(policyPath = 'foreman.policy.json'): Policy {
  const resolved = path.resolve(policyPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Policy file not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf-8')) as Policy;
}

function ruleIdOf(rule: Rule): string {
  return rule.ruleId ?? rule.name ?? 'unknown_rule';
}

/**
 * Runs every rule fail-closed. A rule that throws becomes passed=false with the
 * error message; a rule that returns a malformed result is also treated as a
 * failure. The gate passes only when every rule passes.
 */
export function runGate(ctx: GateContext, policy: Policy, rules: Rule[] = RULES): GateResult {
  const results: RuleResult[] = rules.map((rule) => {
    try {
      const result = rule(ctx, policy);
      if (!result || typeof result.passed !== 'boolean' || typeof result.ruleId !== 'string') {
        throw new Error('rule returned a malformed result');
      }
      return { ruleId: result.ruleId, passed: result.passed, detail: String(result.detail ?? '') };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ruleId: ruleIdOf(rule), passed: false, detail: `rule threw: ${message}` };
    }
  });

  const failedRules = results.filter((r) => !r.passed).map((r) => r.ruleId);
  return { passed: failedRules.length === 0, rules: results, failedRules };
}
