import { roundCurrency } from './rounding.js';

/**
 * Formats a monetary amount into standard USD display string ($XX.YY).
 */
export function formatPrice(amount: number): string {
  const rounded = roundCurrency(amount);
  return `$${rounded.toFixed(2)}`;
}

/**
 * Formats a rate into a percentage string (e.g. 0.0825 -> "8.25%").
 */
export function formatPercentage(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/**
 * Formats a cart line item display string.
 */
export function formatLineItem(name: string, quantity: number, unitPrice: number): string {
  const lineTotal = roundCurrency(quantity * unitPrice);
  return `${name} x${quantity} @ $${unitPrice.toFixed(2)} = $${lineTotal.toFixed(2)}`;
}
