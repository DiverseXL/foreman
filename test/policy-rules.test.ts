import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runGate, loadPolicy } from '../src/policy/gate.js';
import {
  pathScopeRule,
  testsProtectedRule,
  diffSizeRule,
  dependenciesRule,
  secretsRule,
  evidenceScopeRule,
  blastRadiusRule,
} from '../src/policy/rules.js';
import type { GateContext, Policy, Rule } from '../src/policy/types.js';

const policy: Policy = loadPolicy('foreman.policy.json');

function makeContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    changedFiles: [],
    changedSymbols: [],
    addedLines: [],
    contextSymbols: [],
    symbolCallerCounts: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) path_scope
// ---------------------------------------------------------------------------
describe('path_scope rule', () => {
  it('passes for a change limited to src/**', () => {
    const result = pathScopeRule(
      makeContext({ changedFiles: [{ path: 'src/discount.ts', status: 'M', added: 1, removed: 1 }] }),
      policy
    );
    assert.equal(result.ruleId, 'path_scope');
    assert.equal(result.passed, true);
  });

  it('fails for a denied path (package.json) and an outside-allowed path', () => {
    assert.equal(
      pathScopeRule(makeContext({ changedFiles: [{ path: 'package.json', status: 'M', added: 1, removed: 0 }] }), policy)
        .passed,
      false
    );
    assert.equal(
      pathScopeRule(makeContext({ changedFiles: [{ path: 'docs/readme.md', status: 'A', added: 1, removed: 0 }] }), policy)
        .passed,
      false
    );
    assert.equal(
      pathScopeRule(makeContext({ changedFiles: [{ path: '.hidden', status: 'A', added: 1, removed: 0 }] }), policy)
        .passed,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// (b) tests_protected
// ---------------------------------------------------------------------------
describe('tests_protected rule', () => {
  it('passes when no test file is touched', () => {
    const result = testsProtectedRule(
      makeContext({ changedFiles: [{ path: 'src/shipping.ts', status: 'M', added: 1, removed: 1 }] })
    );
    assert.equal(result.passed, true);
  });

  it('fails when a test file is modified or deleted', () => {
    assert.equal(
      testsProtectedRule(
        makeContext({ changedFiles: [{ path: 'test/shipping.test.ts', status: 'M', added: 0, removed: 1 }] })
      ).passed,
      false
    );
    assert.equal(
      testsProtectedRule(
        makeContext({ changedFiles: [{ path: 'test/shipping.test.ts', status: 'D', added: 0, removed: 5 }] })
      ).passed,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// (c) diff_size
// ---------------------------------------------------------------------------
describe('diff_size rule', () => {
  it('passes for a small diff', () => {
    const result = diffSizeRule(
      makeContext({ changedFiles: [{ path: 'src/discount.ts', status: 'M', added: 1, removed: 2 }] }),
      policy
    );
    assert.equal(result.passed, true);
  });

  it('fails when over maxFiles or over maxChangedLines', () => {
    const fourFiles = makeContext({
      changedFiles: [
        { path: 'src/a.ts', status: 'M', added: 1, removed: 0 },
        { path: 'src/b.ts', status: 'M', added: 1, removed: 0 },
        { path: 'src/c.ts', status: 'M', added: 1, removed: 0 },
        { path: 'src/d.ts', status: 'M', added: 1, removed: 0 },
      ],
    });
    assert.equal(diffSizeRule(fourFiles, policy).passed, false);

    const big = makeContext({
      changedFiles: [{ path: 'src/a.ts', status: 'M', added: 30, removed: 30 }],
    });
    assert.equal(diffSizeRule(big, policy).passed, false);
  });
});

// ---------------------------------------------------------------------------
// (d) dependencies
// ---------------------------------------------------------------------------
describe('dependencies rule', () => {
  it('passes for relative imports and no lockfile change', () => {
    const result = dependenciesRule(
      makeContext({
        changedFiles: [{ path: 'src/discount.ts', status: 'M', added: 1, removed: 1 }],
        addedLines: ["import { roundCurrency } from './rounding.js';"],
      }),
      policy
    );
    assert.equal(result.passed, true);
  });

  it('fails on an added external import or a lockfile change', () => {
    const external = dependenciesRule(
      makeContext({ addedLines: ["import Decimal from 'decimal.js';"] }),
      policy
    );
    assert.equal(external.passed, false);

    const lockfile = dependenciesRule(
      makeContext({ changedFiles: [{ path: 'package.json', status: 'M', added: 2, removed: 0 }] }),
      policy
    );
    assert.equal(lockfile.passed, false);
  });
});

// ---------------------------------------------------------------------------
// (e) secrets
// ---------------------------------------------------------------------------
describe('secrets rule', () => {
  it('passes for adding ordinary code lines', () => {
    const result = secretsRule(makeContext({ addedLines: ['  if (quantity >= 10) {'] }), policy);
    assert.equal(result.passed, true);
  });

  it('fails when an added line contains a key-like pattern', () => {
    // Fixtures are assembled at runtime so no key-shaped literal is stored in the repo.
    const awsLike = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    assert.equal(secretsRule(makeContext({ addedLines: [`const k = "${awsLike}";`] }), policy).passed, false);

    const assignment = ['api', '_key'].join('') + " = '" + ['abcdef', '123456789'].join('') + "'";
    assert.equal(secretsRule(makeContext({ addedLines: [`const ${assignment};`] }), policy).passed, false);
  });
});

// ---------------------------------------------------------------------------
// (f) evidence_scope
// ---------------------------------------------------------------------------
describe('evidence_scope rule', () => {
  it('passes when every changed symbol is in context.json', () => {
    const result = evidenceScopeRule(
      makeContext({
        changedSymbols: [{ name: 'calculateTieredBulkDiscount', kind: 'function', file: 'src/discount.ts' }],
        contextSymbols: ['calculateTieredBulkDiscount'],
      })
    );
    assert.equal(result.passed, true);
  });

  it('fails when a changed symbol is absent from context.json', () => {
    const result = evidenceScopeRule(
      makeContext({
        changedSymbols: [{ name: 'mysteryHelper', kind: 'function', file: 'src/discount.ts' }],
        contextSymbols: ['calculateTieredBulkDiscount'],
      })
    );
    assert.equal(result.passed, false);
    if (!result.passed) assert.match(result.detail, /mysteryHelper/);
  });
});

// ---------------------------------------------------------------------------
// (g) blast_radius
// ---------------------------------------------------------------------------
describe('blast_radius rule', () => {
  it('passes below the caller threshold and fails above it', () => {
    const ok = blastRadiusRule(
      makeContext({
        changedSymbols: [{ name: 'calculateTieredBulkDiscount', kind: 'function', file: 'src/discount.ts' }],
        symbolCallerCounts: { calculateTieredBulkDiscount: 3 },
      }),
      policy
    );
    assert.equal(ok.passed, true);

    const over = blastRadiusRule(
      makeContext({
        changedSymbols: [{ name: 'roundCurrency', kind: 'function', file: 'src/rounding.ts' }],
        symbolCallerCounts: { roundCurrency: 19 },
      }),
      policy
    );
    assert.equal(over.passed, false);
    if (!over.passed) assert.match(over.detail, /roundCurrency=19/);
  });
});

// ---------------------------------------------------------------------------
// clean diff + throwing rule
// ---------------------------------------------------------------------------
describe('runGate', () => {
  it('passes a clean diff through every rule', () => {
    const clean = makeContext({
      changedFiles: [{ path: 'src/discount.ts', status: 'M', added: 1, removed: 1 }],
      changedSymbols: [{ name: 'calculateTieredBulkDiscount', kind: 'function', file: 'src/discount.ts' }],
      addedLines: ['  if (quantity >= 10) {'],
      contextSymbols: ['calculateTieredBulkDiscount'],
      symbolCallerCounts: { calculateTieredBulkDiscount: 3 },
    });
    const result = runGate(clean, policy);
    assert.equal(result.passed, true);
    assert.deepEqual(result.failedRules, []);
    assert.equal(result.rules.length, 7);
  });

  it('treats a rule that throws as a failure', () => {
    const throwingRule = (() => {
      throw new Error('boom');
    }) as unknown as Rule;
    throwingRule.ruleId = 'boom_rule';

    const result = runGate(makeContext(), policy, [throwingRule]);
    assert.equal(result.passed, false);
    assert.deepEqual(result.failedRules, ['boom_rule']);
    assert.match(result.rules[0].detail, /rule threw: boom/);
  });
});
