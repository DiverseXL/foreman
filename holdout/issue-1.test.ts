import { it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTieredBulkDiscount } from '../src/discount.js';

it('holds every discount boundary at quantities 9, 10, 11, 19, 20, and 21', () => {
  const cases: [number, number, number][] = [
    [9, 50, 0],
    [10, 37, 37],
    [11, 50, 55],
    [19, 50, 95],
    [20, 50, 200],
    [21, 50, 210],
  ];
  for (const [quantity, unitPrice, amount] of cases) {
    assert.equal(calculateTieredBulkDiscount(quantity, unitPrice), amount, `quantity=${quantity}`);
  }
});
