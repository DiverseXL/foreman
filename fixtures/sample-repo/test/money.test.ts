import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fromCents, addMoney, subtractMoney, multiplyMoney } from '../src/money.js';

test('converts dollars to integer cents', () => {
  assert.strictEqual(toCents(19.99), 1999);
  assert.strictEqual(toCents(0.05), 5);
});

test('converts cents to dollar float', () => {
  assert.strictEqual(fromCents(1999), 19.99);
  assert.strictEqual(fromCents(5), 0.05);
});

test('adds two money amounts cleanly', () => {
  assert.strictEqual(addMoney(10.25, 4.75), 15.0);
  assert.strictEqual(addMoney(0.1, 0.2), 0.3);
});

test('subtracts money amounts without negative result', () => {
  assert.strictEqual(subtractMoney(20.0, 5.5), 14.5);
  assert.strictEqual(subtractMoney(5.0, 10.0), 0.0);
});

test('multiplies money amount by factor with exact cents rounding', () => {
  assert.strictEqual(multiplyMoney(10.0, 1.0825), 10.83);
});

test('handles zero and negative amounts safely', () => {
  assert.strictEqual(toCents(0), 0);
  assert.strictEqual(fromCents(0), 0);
  assert.strictEqual(subtractMoney(0, 5), 0);
});
