import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFlatShipping,
  calculateWeightFee,
  calculateVolumetricShipping,
} from '../src/shipping.js';
import { formatPrice } from '../src/formatting.js';

test('calculates standard and express flat shipping', () => {
  assert.strictEqual(calculateFlatShipping(50, 'standard'), 5.99);
  assert.strictEqual(calculateFlatShipping(50, 'express'), 15.0);
});

test('provides free shipping for orders of $100 or more', () => {
  assert.strictEqual(calculateFlatShipping(100, 'standard'), 0);
  assert.strictEqual(calculateFlatShipping(150, 'standard'), 0);
});

test('calculates extra shipping fees for heavy packages', () => {
  // First 1kg included, 3kg package = 2kg billable * $2.50 = $5.00
  assert.strictEqual(calculateWeightFee(3, 2.5), 5.0);
  assert.strictEqual(calculateWeightFee(0.5, 2.5), 0);
});

test('formats price with rounding', () => {
  // $19.991 rounds down to $19.99.
  // Note: If roundCurrency is mistakenly changed to Math.ceil, this returns "$20.00" and fails!
  assert.strictEqual(formatPrice(19.991), '$19.99');
});

test('repro-issue-3', () => {
  // Package dimensions: 21 x 15 x 11 cm = 3465 cm3
  // Dimensional weight = 3465 / 5000 = 0.693 kg
  // Rate: $15.01 per kg -> raw freight fee = 0.693 * 15.01 = 10.40193
  // Carrier rule: Volumetric fees must round UP (ceil) to the nearest cent -> $10.41.
  // BUG: calculateVolumetricShipping calls shared roundCurrency (half-up) which produces 10.40.
  const fee = calculateVolumetricShipping(21, 15, 11, 15.01);
  assert.strictEqual(fee, 10.41);
});
