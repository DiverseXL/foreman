/**
 * Money utilities using integer cents to ensure arithmetic correctness.
 */

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function addMoney(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b));
}

export function subtractMoney(a: number, b: number): number {
  const result = toCents(a) - toCents(b);
  return fromCents(Math.max(0, result));
}

export function multiplyMoney(amount: number, factor: number): number {
  return fromCents(Math.round(toCents(amount) * factor));
}
