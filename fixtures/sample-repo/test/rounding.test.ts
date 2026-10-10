import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundCurrency } from '../src/rounding.js';
import { calculatePercentageDiscount } from '../src/discount.js';
import { calculateTaxAmount } from '../src/tax.js';

test('rounds currency values using standard financial half-up rule', () => {
  assert.strictEqual(roundCurrency(10.004), 10.0);
  assert.strictEqual(roundCurrency(10.005), 10.01);
  assert.strictEqual(roundCurrency(10.006), 10.01);
});

test('preserves integers and existing two decimal precision', () => {
  assert.strictEqual(roundCurrency(25), 25);
  assert.strictEqual(roundCurrency(49.99), 49.99);
});

test('calculates percentage discount on odd price', () => {
  // 15% discount on $10.01: 10.01 * 0.15 = 1.5015 -> standard round = 1.50
  // Note: if roundCurrency is mistakenly changed to Math.ceil, this produces 1.51 and fails!
  const discount = calculatePercentageDiscount(10.01, 15);
  assert.strictEqual(discount, 1.50);
});

test('calculates standard tax for small amount', () => {
  // 8.25% tax on $5.01: 5.01 * 0.0825 = 0.413325 -> standard round = 0.41
  // Note: if roundCurrency is mistakenly changed to Math.ceil, this produces 0.42 and fails!
  const tax = calculateTaxAmount(5.01, 0.0825);
  assert.strictEqual(tax, 0.41);
});
