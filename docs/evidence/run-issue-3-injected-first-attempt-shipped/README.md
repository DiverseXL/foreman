# Issue 3: injected-first-attempt shipped patch

The shipped patch passed the issue-3 visible reproduction test, the policy gate, and the independent validator (attempt 3 in `report.md`), with no regressions against tests that passed at baseline. The full visible suite was not entirely green: `tests-3.txt` records 29 passing and 2 failing tests, the still-unfixed issue-1 and issue-2 reproductions. The patch is also behaviorally incomplete: for an exact raw fee of 1.1, it charges 1.11, while exact-cent math gives 1.10. The visible issue-3 test did not cover that input.

Command: `npx tsx .foreman-work/behavior-check-issue3.ts`

The throwaway behavior check ran the patch's rounding expression, `Math.ceil(rawFee * 100) / 100`, and printed:

```text
| input | exact expected ($) | patched actual ($) | old roundCurrency ($) | patched == exact? | rawFee*100 in JS |
| --- | --- | --- | --- | --- | --- |
| 1.1 | 1.10 | 1.11 | 1.10 | NO | 110.00000000000001 |
| 2.3 | 2.30 | 2.30 | 2.30 | yes | 229.99999999999997 |
| 8.2 | 8.20 | 8.20 | 8.20 | yes | 819.9999999999999 |
| 0.57 | 0.57 | 0.57 | 0.57 | yes | 56.99999999999999 |
| 10.4 | 10.40 | 10.40 | 10.40 | yes | 1040 |
```

The expectation was derived from decimal-string integer cents; the actual column evaluates the shipped expression in JavaScript. No fixture files were modified by this check.
