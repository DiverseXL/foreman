import { roundCurrency } from './rounding.js';

/**
 * Calculates standard tax on an amount given a percentage rate.
 */
export function calculateTaxAmount(taxableAmount: number, rate: number): number {
  if (taxableAmount <= 0 || rate <= 0) return 0;
  return roundCurrency(taxableAmount * rate);
}

/**
 * Calculates combined state and local municipal tax.
 */
export function calculateCompoundTax(amount: number, stateRate: number, localRate: number): number {
  if (amount <= 0) return 0;
  const combinedRate = stateRate + localRate;
  return roundCurrency(amount * combinedRate);
}

/**
 * Calculates item tax honoring tax exemption flags.
 */
export function calculateItemTax(
  price: number,
  quantity: number,
  rate: number,
  isExempt: boolean = false
): number {
  if (isExempt || price <= 0 || quantity <= 0 || rate <= 0) {
    return 0;
  }
  return calculateTaxAmount(price * quantity, rate);
}
