# Issue 1: Tier 1 bulk discount not applied when quantity is exactly 10

## Summary
When a customer purchases exactly 10 units of an item, the Tier 1 bulk discount (10% off) is not triggered. The customer receives 0% discount instead of the advertised 10% discount.

## Steps to Reproduce
1. Create a cart with 10 units of an item priced at $50.00.
2. Evaluate item discounts via `calculateTieredBulkDiscount(10, 50.0)`.
3. Check the calculated discount amount.

## Expected Behavior
The boundary quantity of 10 items should qualify for the Tier 1 bulk discount:
- Subtotal: 10 * $50.00 = $500.00
- 10% discount: $50.00
- Return value: `50.0`

## Actual Behavior
The function returns `0`. The boundary condition is excluded because of strict comparison (`quantity > 10`) instead of inclusive threshold (`quantity >= 10`).

## Context
The bug is localized to `calculateTieredBulkDiscount` in `src/discount.ts`.
