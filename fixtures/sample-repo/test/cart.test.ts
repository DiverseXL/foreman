import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCartTotals, calculateItemSubtotal, calculateRawItemsSubtotal } from '../src/cart.js';
import type { CartItem } from '../src/types.js';

test('returns zero totals for empty cart', () => {
  const summary = calculateCartTotals([]);
  assert.strictEqual(summary.subtotal, 0);
  assert.strictEqual(summary.grandTotal, 0);
});

test('calculates single item subtotal correctly', () => {
  assert.strictEqual(calculateItemSubtotal(19.99, 3), 59.97);
});

test('calculates cart totals with taxes and shipping included', () => {
  const items: CartItem[] = [
    { id: '1', name: 'Notebook', price: 12.0, quantity: 2 },
    { id: '2', name: 'Pen', price: 3.5, quantity: 4 },
  ];
  // Subtotal = 24 + 14 = 38.00
  // Shipping (standard under 100) = 5.99
  // Tax 8% = 3.04
  // Grand total = 38.00 + 3.04 + 5.99 = 47.03
  const summary = calculateCartTotals(items, { taxRate: 0.08 });
  assert.strictEqual(summary.subtotal, 38.0);
  assert.strictEqual(summary.tax, 3.04);
  assert.strictEqual(summary.shipping, 5.99);
  assert.strictEqual(summary.grandTotal, 47.03);
});

test('applies order level coupon discounts to cart totals', () => {
  const items: CartItem[] = [
    { id: '1', name: 'Desk Lamp', price: 50.0, quantity: 1 },
  ];
  const summary = calculateCartTotals(items, {
    coupon: { code: 'SAVE10', type: 'fixed', value: 10.0 },
  });
  assert.strictEqual(summary.discount, 10.0);
  assert.strictEqual(summary.grandTotal, 45.99); // 40.00 + 5.99 shipping
});

test('handles exempt items in cart totals', () => {
  const items: CartItem[] = [
    { id: '1', name: 'Taxed Item', price: 20.0, quantity: 1 },
    { id: '2', name: 'Exempt Food', price: 10.0, quantity: 1, taxExempt: true },
  ];
  const summary = calculateCartTotals(items, { taxRate: 0.1 });
  assert.strictEqual(summary.tax, 2.0); // Only taxed on $20.00
});

test('repro-issue-2', () => {
  // Floating-point precision trap:
  // Items with prices 0.10 and 0.20 accumulate to 0.30000000000000004 under IEEE-754 floats.
  // BUG: calculateRawItemsSubtotal uses naive floating point reduce instead of integer cents.
  const items: CartItem[] = [
    { id: 'item-1', name: 'Micro-washer', price: 0.10, quantity: 1 },
    { id: 'item-2', name: 'Micro-screw', price: 0.20, quantity: 1 },
  ];
  const subtotal = calculateRawItemsSubtotal(items);
  assert.strictEqual(subtotal, 0.30);
});
