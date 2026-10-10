import type { CartItem, PricingOptions, PricingSummary } from './types.js';
import { roundCurrency } from './rounding.js';
import { calculateTieredBulkDiscount, calculateFixedDiscount, calculatePercentageDiscount } from './discount.js';
import { calculateItemTax } from './tax.js';
import { calculateFlatShipping, calculateVolumetricShipping } from './shipping.js';

/**
 * Calculates line subtotal for an item.
 */
export function calculateItemSubtotal(price: number, quantity: number): number {
  return roundCurrency(price * quantity);
}

/**
 * Evaluates item-level tiered volume discounts.
 */
export function applyItemDiscounts(item: CartItem): number {
  return calculateTieredBulkDiscount(item.quantity, item.price);
}

/**
 * Computes raw sum of items before order-level adjustments.
 */
export function calculateRawItemsSubtotal(items: CartItem[]): number {
  return items.reduce((acc, item) => acc + item.price * item.quantity, 0);
}

/**
 * Computes full order pricing summary including discounts, taxes, and shipping.
 */
export function calculateCartTotals(
  items: CartItem[],
  options: PricingOptions = {}
): PricingSummary {
  if (items.length === 0) {
    return {
      subtotal: 0,
      discount: 0,
      tax: 0,
      shipping: 0,
      grandTotal: 0,
    };
  }

  // 1. Calculate raw subtotal
  const subtotal = calculateRawItemsSubtotal(items);

  // 2. Evaluate discounts (item-level bulk discounts + optional coupon)
  let itemDiscountsTotal = 0;
  for (const item of items) {
    itemDiscountsTotal += applyItemDiscounts(item);
  }

  let orderDiscount = 0;
  if (options.coupon) {
    if (options.coupon.type === 'percentage') {
      orderDiscount = calculatePercentageDiscount(subtotal, options.coupon.value);
    } else {
      orderDiscount = calculateFixedDiscount(subtotal, options.coupon.value);
    }
  }

  const totalDiscount = Math.min(subtotal, roundCurrency(itemDiscountsTotal + orderDiscount));
  const discountedSubtotal = Math.max(0, subtotal - totalDiscount);

  // 3. Evaluate tax
  const taxRate = options.taxRate ?? 0;
  let totalTax = 0;
  if (taxRate > 0) {
    for (const item of items) {
      totalTax += calculateItemTax(item.price, item.quantity, taxRate, item.taxExempt);
    }
  }
  totalTax = roundCurrency(totalTax);

  // 4. Evaluate shipping
  let shippingFee = calculateFlatShipping(discountedSubtotal, options.shippingOption ?? 'standard');
  if (options.packageDimensions && options.volumetricRate) {
    const volFee = calculateVolumetricShipping(
      options.packageDimensions.lengthCm,
      options.packageDimensions.widthCm,
      options.packageDimensions.heightCm,
      options.volumetricRate
    );
    shippingFee = Math.max(shippingFee, volFee);
  }
  shippingFee = roundCurrency(shippingFee);

  // 5. Grand total
  const grandTotal = roundCurrency(discountedSubtotal + totalTax + shippingFee);

  return {
    subtotal: roundCurrency(subtotal),
    discount: totalDiscount,
    tax: totalTax,
    shipping: shippingFee,
    grandTotal,
  };
}
