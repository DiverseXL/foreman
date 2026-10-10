import { roundCurrency } from './rounding.js';
import type { ShippingDimensions } from './types.js';

/**
 * Calculates base shipping based on service level and order subtotal.
 */
export function calculateFlatShipping(subtotal: number, option: string = 'standard'): number {
  if (subtotal >= 100 && option === 'standard') {
    return 0; // Free shipping over $100
  }
  switch (option) {
    case 'express':
      return 15.0;
    case 'free':
      return 0;
    case 'standard':
    default:
      return 5.99;
  }
}

/**
 * Calculates additional shipping charges based on package physical weight.
 */
export function calculateWeightFee(weightKg: number, perKgRate: number = 2.5): number {
  if (weightKg <= 1) return 0; // First 1kg included
  const billableWeight = weightKg - 1;
  return roundCurrency(billableWeight * perKgRate);
}

/**
 * Calculates volumetric (dimensional) freight shipping fee using industry standard
 * divisor (5000 cm3/kg).
 *
 * Carrier freight rule requires volumetric billing to round UP (ceil) to the nearest cent.
 *
 * NOTE: Seeded synthetic bug for issue-3 is located here.
 * Naive fix would change the shared roundCurrency helper, breaking multiple callers.
 * The correct fix is local to this function.
 */
export function calculateVolumetricShipping(
  lengthCm: number,
  widthCm: number,
  heightCm: number,
  ratePerKg: number
): number {
  const dimensionalWeight = (lengthCm * widthCm * heightCm) / 5000;
  const rawFee = dimensionalWeight * ratePerKg;
  // SEEDED BUG (Issue 3): Calls shared roundCurrency instead of applying carrier ceiling rule
  return roundCurrency(rawFee);
}
