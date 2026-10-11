# Foreman Run Report: run-1791666044437

Issue: 1 - Tier 1 bulk discount not applied when quantity is exactly 10
Outcome: shipped
Derived status: shipped
Attempts: 1
Injected first attempt: no
Trace ID: 85cd880318e17bbac0636abae2911274

## Per-attempt results

| Attempt | Injected | Patch source | Diff hash | Gate | Failed rules | targetPassed | Regressions | Escalated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | no | model | 5137eb6348c2 | pass | none | true | none | YES |

## Per-criterion verdicts (source: code or validator)

| Attempt | Criterion | Check | Source | Verdict | Confidence | Reason | Missing evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | code:repro-test | code | code | pass | 1 | repro-issue-1 passed after the patch |  |
| 1 | code:no-regressions | code | code | pass | 1 | no regressions |  |
| 1 | code:gate | code | code | pass | 1 | policy gate passed |  |
| 1 | r1 | test | code | pass | 1 | covered by code verdicts (repro test, no regressions, policy gate) |  |
| 1 | r2 | behavior | validator | pass | 1 | The patch correctly applies the Tier 1 bulk discount of 10% at the boundary quantity of 10 units. |  |
| 1 | r4 | behavior | validator | pass | 1 | The patch correctly calculates a subtotal of 500.00 with a 10% discount, yielding a 50.00 discount amount for 10 items at 50.0 each. |  |
| 1 | r5 | diff | validator | pass | 1 | The bug in the boundary condition logic of the calculateTieredBulkDiscount function has been fixed by changing the condition from > to >=. |  |

## Escalation

Attempt 1: validator was unclear on r2, r4; one evidence escalation re-ran the validator.

## Dropped criteria

- r3: evidence_ref issue_text "quantity > 10 instead of inclusive threshold" is not a substring of the issue text

## Failure memory used

(none; no earlier attempt failed)

## Totals (from the ledger)

prompt tokens: 11601
completion tokens: 1473
total tokens: 13074
gateway cost (USD): $0.022646
wall time: 75.4s

## Shipment

The run branch in the run copy holds the shipped commit, and proposed.patch holds the same change. NO pull request was opened.
