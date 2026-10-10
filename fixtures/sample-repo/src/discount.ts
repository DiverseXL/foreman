import { roundCurrency } from './rounding.js';

/**
 * Calculates a fixed dollar discount clamped to the subtotal.
 */
export function calculateFixedDiscount(subtotal: number, discountAmount: number): number {
  if (discountAmount <= 0) return 0;
  return Math.min(subtotal, roundCurrency(discountAmount));
}

/**
 * Calculates a percentage discount on a subtotal.
 */
export function calculatePercentageDiscount(subtotal: number, percentage: number): number {
  if (percentage <= 0) return 0;
  const rawDiscount = subtotal * (percentage / 100);
  return roundCurrency(rawDiscount);
}

/**
 * Distributes a coupon value across items by proportional ratio.
 */
export function calculateCouponSplit(itemsTotal: number, couponValue: number, ratio: number): number {
  if (itemsTotal <= 0 || couponValue <= 0) return 0;
  return roundCurrency(couponValue * ratio);
}

/**
 * Calculates tiered bulk purchase discount based on item volume:
 * - 20 or more items: 20% discount
 * - 10 to 19 items: 10% discount
 * - under 10 items: 0% discount
 */
export function calculateTieredBulkDiscount(quantity: number, unitPrice: number): number {
  if (quantity >= 20) {
    return roundCurrency(quantity * unitPrice * 0.20);
  }
  if (quantity > 10) {
    return roundCurrency(quantity * unitPrice * 0.10);
  }
  return 0;
}
