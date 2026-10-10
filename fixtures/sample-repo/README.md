# Shopping Cart Pricing Library (Fixture)

A lightweight shopping cart pricing engine written in plain TypeScript ESM with zero runtime dependencies.

## Notice: Synthetic Benchmark Repository
This repository is a synthetic target designed for benchmarking and validating the Foreman autonomous agent. The code contains three intentionally seeded issues:
- `repro-issue-1`: Boundary handling bug in bulk discount calculation.
- `repro-issue-2`: Floating-point accumulation drift in cart subtotal calculation.
- `repro-issue-3`: Freight carrier ceiling rounding requirement in volumetric shipping calculation.

## Running Tests
Tests are executed using the native Node.js test runner via `tsx`:

```bash
npm test
```

All standard unit tests pass out-of-the-box, while the three seeded issue tests (`repro-issue-1`, `repro-issue-2`, `repro-issue-3`) fail as expected baseline reproductions.
