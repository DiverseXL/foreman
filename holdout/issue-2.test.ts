import { it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateRawItemsSubtotal } from '../src/cart.js';
import type { CartItem } from '../src/types.js';

function cents(decimal: string): number {
  const [whole, fraction = ''] = decimal.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

function exactSubtotal(items: CartItem[]): number {
  return items.reduce((total, item) => total + cents(String(item.price)) * item.quantity, 0) / 100;
}

it('accumulates drift-prone prices as integer cents', () => {
  const cases: CartItem[][] = [
    [
      { id: 'a', name: 'a', price: 0.1, quantity: 1 },
      { id: 'b', name: 'b', price: 0.2, quantity: 1 },
    ],
    [
      { id: 'a', name: 'a', price: 0.07, quantity: 3 },
      { id: 'b', name: 'b', price: 0.11, quantity: 7 },
      { id: 'c', name: 'c', price: 1.29, quantity: 11 },
    ],
    [
      { id: 'a', name: 'a', price: 19.99, quantity: 17 },
      { id: 'b', name: 'b', price: 0.03, quantity: 23 },
      { id: 'c', name: 'c', price: 2.15, quantity: 9 },
    ],
    [
      { id: 'a', name: 'a', price: 0.01, quantity: 101 },
      { id: 'b', name: 'b', price: 0.29, quantity: 13 },
      { id: 'c', name: 'c', price: 0.58, quantity: 5 },
    ],
  ];
  for (const items of cases) {
    assert.equal(calculateRawItemsSubtotal(items), exactSubtotal(items));
  }
});
