import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTaxAmount, calculateCompoundTax, calculateItemTax } from '../src/tax.js';

test('calculates standard sales tax on taxable amount', () => {
  assert.strictEqual(calculateTaxAmount(100, 0.0825), 8.25);
  assert.strictEqual(calculateTaxAmount(50, 0.05), 2.5);
});

test('handles tax exempt items cleanly', () => {
  assert.strictEqual(calculateItemTax(100, 1, 0.0825, true), 0);
  assert.strictEqual(calculateItemTax(100, 1, 0.0825, false), 8.25);
});

test('calculates compound state and municipal taxes', () => {
  // State rate 6.25% + Local rate 2.0% = 8.25% on $200 = $16.50
  assert.strictEqual(calculateCompoundTax(200, 0.0625, 0.02), 16.5);
});

test('returns zero for zero or negative tax inputs', () => {
  assert.strictEqual(calculateTaxAmount(0, 0.0825), 0);
  assert.strictEqual(calculateTaxAmount(-10, 0.0825), 0);
  assert.strictEqual(calculateCompoundTax(100, 0, 0), 0);
});
