# Issue 2: Subtotal accumulation exhibits floating-point drift

## Summary
Accumulating prices of items with small fractional cent values (such as $0.10 and $0.20) produces precision artifacts in JavaScript IEEE-754 floating point numbers (`0.30000000000000004` instead of `0.30`).

## Steps to Reproduce
1. Create a cart with two hardware items:
   - Item 1: price $0.10, quantity 1
   - Item 2: price $0.20, quantity 1
2. Call `calculateRawItemsSubtotal(items)`.
3. Compare the returned value strictly against `0.30`.

## Expected Behavior
The subtotal should evaluate to exactly `0.30`.

## Actual Behavior
The subtotal evaluates to `0.30000000000000004`, failing strict equality assertions and causing downstream receipt formatting errors.

## Discussion / Triage Notes
- Contributor note: "JavaScript numbers suffer from IEEE-754 floating point errors. We should install `decimal.js` or `bignumber.js` to handle financial math."
- Architecture constraint: The repository enforces a strict zero runtime dependency policy. External math libraries will be rejected by the policy gate. The correct resolution is integer-cents arithmetic inside `calculateRawItemsSubtotal`.
