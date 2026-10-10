import type { GateContext, Policy, Rule, RuleResult } from './types.js';

/**
 * Small glob matcher for repo-relative paths.
 * Supports '*' (within a segment), '**' (across segments) and '?'.
 * Verified against the policy patterns in foreman.policy.json.
 */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + out + '$');
}

export function matchGlob(pattern: string, filePath: string): boolean {
  return globToRegExp(pattern).test(filePath);
}

/** A dotfile is any path segment starting with '.'. */
export function isDotfile(filePath: string): boolean {
  return filePath.split(/[\\/]/).some((segment) => segment.startsWith('.'));
}

/** Symbol kinds that are containers or file-level noise, not real changed symbols. */
const NON_SYMBOL_KINDS = new Set(['module', 'section', 'file', 'import']);

function relevantSymbols(ctx: GateContext) {
  return ctx.changedSymbols.filter((s) => !NON_SYMBOL_KINDS.has(s.kind));
}

// ---------------------------------------------------------------------------
// (a) path_scope
// ---------------------------------------------------------------------------
function pathScopeRule(ctx: GateContext, policy: Policy): RuleResult {
  const violations: string[] = [];
  for (const file of ctx.changedFiles) {
    const deniedByPattern = policy.deniedPaths.some((p) => matchGlob(p, file.path));
    if (deniedByPattern || (policy.denyDotfiles && isDotfile(file.path))) {
      violations.push(`${file.path} is denied`);
      continue;
    }
    const allowed = policy.allowedPaths.some((p) => matchGlob(p, file.path));
    if (!allowed) violations.push(`${file.path} is outside allowedPaths`);
  }
  return {
    ruleId: 'path_scope',
    passed: violations.length === 0,
    detail:
      violations.length > 0
        ? violations.join('; ')
        : `all ${ctx.changedFiles.length} changed file(s) within ${policy.allowedPaths.join(', ')}`,
  };
}
pathScopeRule.ruleId = 'path_scope';

// ---------------------------------------------------------------------------
// (b) tests_protected
// ---------------------------------------------------------------------------
function testsProtectedRule(ctx: GateContext): RuleResult {
  const touched = ctx.changedFiles.filter((f) => matchGlob('test/**', f.path));
  return {
    ruleId: 'tests_protected',
    passed: touched.length === 0,
    detail:
      touched.length > 0
        ? `test file(s) added, deleted, renamed or modified: ${touched.map((f) => `${f.path}(${f.status})`).join(', ')}`
        : 'no file under test/ was added, deleted, renamed or modified',
  };
}
testsProtectedRule.ruleId = 'tests_protected';

// ---------------------------------------------------------------------------
// (c) diff_size
// ---------------------------------------------------------------------------
function diffSizeRule(ctx: GateContext, policy: Policy): RuleResult {
  const files = ctx.changedFiles.length;
  const lines = ctx.changedFiles.reduce((sum, f) => sum + f.added + f.removed, 0);
  const passed = files <= policy.maxFiles && lines <= policy.maxChangedLines;
  return {
    ruleId: 'diff_size',
    passed,
    detail: `files=${files}/${policy.maxFiles} changedLines=${lines}/${policy.maxChangedLines}`,
  };
}
diffSizeRule.ruleId = 'diff_size';

// ---------------------------------------------------------------------------
// (d) dependencies
// ---------------------------------------------------------------------------
const MODULE_SPECIFIER_RE = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/;

function isExternalSpecifier(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:');
}

function dependenciesRule(ctx: GateContext, policy: Policy): RuleResult {
  const lockTouched = ctx.changedFiles.filter(
    (f) => policy.lockfiles.includes(f.path) || matchGlob('*.lock', f.path)
  );

  const badImports: string[] = [];
  for (const line of ctx.addedLines) {
    const match = line.match(MODULE_SPECIFIER_RE);
    const spec = match ? match[1] : undefined;
    if (spec && isExternalSpecifier(spec)) badImports.push(spec);
  }

  const passed = lockTouched.length === 0 && badImports.length === 0;
  const parts: string[] = [];
  if (lockTouched.length > 0) parts.push(`lockfiles changed: ${lockTouched.map((f) => f.path).join(', ')}`);
  if (badImports.length > 0) parts.push(`added external import(s): ${Array.from(new Set(badImports)).join(', ')}`);

  return {
    ruleId: 'dependencies',
    passed,
    detail: passed ? 'no lockfile changes and no added external imports' : parts.join('; '),
  };
}
dependenciesRule.ruleId = 'dependencies';

// ---------------------------------------------------------------------------
// (e) secrets
// ---------------------------------------------------------------------------
function secretsRule(ctx: GateContext, policy: Policy): RuleResult {
  const hits: string[] = [];
  for (const line of ctx.addedLines) {
    for (const pattern of policy.secretPatterns) {
      if (new RegExp(pattern).test(line)) {
        hits.push(pattern);
        break;
      }
    }
  }
  return {
    ruleId: 'secrets',
    passed: hits.length === 0,
    detail:
      hits.length === 0
        ? 'no key-like patterns in added lines'
        : `key-like patterns in added lines: ${Array.from(new Set(hits)).join(', ')}`,
  };
}
secretsRule.ruleId = 'secrets';

// ---------------------------------------------------------------------------
// (f) evidence_scope
// ---------------------------------------------------------------------------
function evidenceScopeRule(ctx: GateContext): RuleResult {
  const known = new Set(ctx.contextSymbols);
  const missing = relevantSymbols(ctx)
    .filter((s) => !known.has(s.name))
    .map((s) => s.name);
  return {
    ruleId: 'evidence_scope',
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? 'every changed symbol appears in context.json'
        : `changed symbol(s) absent from context.json: ${missing.join(', ')}`,
  };
}
evidenceScopeRule.ruleId = 'evidence_scope';

// ---------------------------------------------------------------------------
// (g) blast_radius
// ---------------------------------------------------------------------------
function blastRadiusRule(ctx: GateContext, policy: Policy): RuleResult {
  const over: string[] = [];
  for (const symbol of relevantSymbols(ctx)) {
    const count = ctx.symbolCallerCounts[symbol.name];
    if (count !== undefined && count > policy.maxTransitiveCallers) {
      over.push(`${symbol.name}=${count}`);
    }
  }
  return {
    ruleId: 'blast_radius',
    passed: over.length === 0,
    detail:
      over.length === 0
        ? `no changed symbol exceeds ${policy.maxTransitiveCallers} callers`
        : `changed symbol(s) over ${policy.maxTransitiveCallers} callers: ${over.join(', ')}`,
  };
}
blastRadiusRule.ruleId = 'blast_radius';

// ---------------------------------------------------------------------------
// Registry (order = evaluation order)
// ---------------------------------------------------------------------------
export const RULES: Rule[] = [
  pathScopeRule as Rule,
  testsProtectedRule as Rule,
  diffSizeRule as Rule,
  dependenciesRule as Rule,
  secretsRule as Rule,
  evidenceScopeRule as Rule,
  blastRadiusRule as Rule,
];

export {
  pathScopeRule,
  testsProtectedRule,
  diffSizeRule,
  dependenciesRule,
  secretsRule,
  evidenceScopeRule,
  blastRadiusRule,
};
