# Issue 3: Volumetric freight fee undercharges by one cent due to half-up rounding

## Summary
When shipping packages charged by dimensional weight, freight carrier contract rules mandate that fractional cents are rounded UP (ceil) to the nearest cent. Currently, `calculateVolumetricShipping` undercharges by one cent for dimensions with fractional cents below 0.005.

## Steps to Reproduce
1. Prepare a package with dimensions 21 cm x 15 cm x 11 cm (3,465 cm³ volume).
2. Compute dimensional weight using the standard 5,000 divisor: 3,465 / 5,000 = 0.693 kg.
3. Apply carrier freight rate of $15.01 per kg: raw freight fee is 0.693 * 15.01 = $10.40193.
4. Call `calculateVolumetricShipping(21, 15, 11, 15.01)`.

## Expected Behavior
Under carrier freight billing rules, any fractional cent must be rounded up to the next full cent:
- Raw fee: $10.40193
- Expected billed fee: $10.41

## Actual Behavior
The function returns `$10.40`, undercharging the carrier fee by 1 cent.

## Blast Radius Warning
`calculateVolumetricShipping` currently calls the shared rounding helper `roundCurrency` in `src/rounding.ts`. Notice that `roundCurrency` is a shared foundation helper called across discount, tax, shipping, cart subtotal, and formatting logic. Modifying `roundCurrency` to use `Math.ceil` will alter financial rounding across standard sales taxes and promotional discounts, causing multiple test regressions across the repository. The fix must be applied locally within `calculateVolumetricShipping` without modifying `roundCurrency`.
