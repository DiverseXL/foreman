import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFixedDiscount,
  calculatePercentageDiscount,
  calculateCouponSplit,
  calculateTieredBulkDiscount,
} from '../src/discount.js';

test('calculates fixed dollar discount clamped to subtotal', () => {
  assert.strictEqual(calculateFixedDiscount(100, 15), 15);
  assert.strictEqual(calculateFixedDiscount(50, 0), 0);
});

test('clamps fixed discount when discount exceeds subtotal', () => {
  assert.strictEqual(calculateFixedDiscount(25, 40), 25);
});

test('calculates percentage discount on standard prices', () => {
  assert.strictEqual(calculatePercentageDiscount(200, 10), 20.0);
  assert.strictEqual(calculatePercentageDiscount(50, 25), 12.5);
});

test('distributes coupon split ratio across line items', () => {
  const split = calculateCouponSplit(100, 20, 0.5);
  assert.strictEqual(split, 10.0);
});

test('calculates bulk tiered discount for large quantities (tier 2: >= 20)', () => {
  // 25 items @ $10 = $250 -> 20% discount = $50.00
  const discount = calculateTieredBulkDiscount(25, 10);
  assert.strictEqual(discount, 50.0);
});

test('repro-issue-1', () => {
  // Boundary condition: exactly 10 items qualifies for Tier 1 (10% discount).
  // 10 items @ $50.00 each = $500 total; 10% discount should be $50.00.
  // BUG: strict comparison (quantity > 10) in calculateTieredBulkDiscount returns 0.
  const discount = calculateTieredBulkDiscount(10, 50);
  assert.strictEqual(discount, 50.0);
});
