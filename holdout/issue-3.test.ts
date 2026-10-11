import { it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateVolumetricShipping } from '../src/shipping.js';

function ceilCentsFromDecimal(decimal: string): number {
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole, fraction = ''] = unsigned.split('.');
  const firstTwo = (fraction + '00').slice(0, 2);
  const cents = Number(whole) * 100 + Number(firstTwo);
  const remainder = fraction.slice(2);
  const roundsUp = remainder.length > 0 && /[1-9]/.test(remainder);
  const magnitude = cents + (roundsUp ? 1 : 0);
  return negative ? -magnitude : magnitude;
}

it('ceils volumetric fees to exact decimal cents across held-out values', () => {
  // Expected fees are exact decimal strings, converted to integer cents; this
  // avoids reusing binary floating-point math for the expected ceiling.
  const cases: { rawFee: string; dimensions: [number, number, number]; rate: number }[] = [
    { rawFee: '1.1', dimensions: [10, 11, 50], rate: 1 },
    { rawFee: '2.3', dimensions: [10, 23, 50], rate: 1 },
    { rawFee: '8.2', dimensions: [10, 20, 205], rate: 1 },
    { rawFee: '0.57', dimensions: [10, 19, 15], rate: 1 },
    { rawFee: '10.4', dimensions: [10, 20, 260], rate: 1 },
    { rawFee: '3.141', dimensions: [10, 31, 50], rate: 1.013225806451613 },
    { rawFee: '0.009', dimensions: [1, 3, 15], rate: 1 },
  ];
  for (const { rawFee, dimensions, rate } of cases) {
    const expected = ceilCentsFromDecimal(rawFee) / 100;
    assert.equal(calculateVolumetricShipping(...dimensions, rate), expected, `rawFee=${rawFee}`);
  }
});
