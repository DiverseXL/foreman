/**
 * Shared currency rounding helper.
 * Rounds an amount to two decimal places using standard financial half-up rounding.
 */
export function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}
