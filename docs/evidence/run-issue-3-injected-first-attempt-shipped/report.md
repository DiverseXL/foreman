# Foreman Run Report: run-1791663174555

Issue: 3 - Volumetric freight fee undercharges by one cent due to half-up rounding
Outcome: shipped
Derived status: shipped
Attempts: 3
Injected first attempt: YES
Trace ID: db9bf121ee4f1e60d47b47c3de9cebc9

## Per-attempt results

| Attempt | Injected | Patch source | Diff hash | Gate | Failed rules | targetPassed | Regressions | Escalated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | YES | injected | 8abf38da63dc | FAIL | blast_radius | not run | - | no |
| 2 | no | model | 99fcbd985c97 | FAIL | path_scope, tests_protected | not run | - | no |
| 3 | no | model | 57da287929f3 | pass | none | true | none | YES |

## Per-criterion verdicts (source: code or validator)

| Attempt | Criterion | Check | Source | Verdict | Confidence | Reason | Missing evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | r1 | test | code | fail | 1 | covered by code verdicts (repro test, no regressions, policy gate) |  |
| 1 | r5 | test | code | fail | 1 | covered by code verdicts (repro test, no regressions, policy gate) |  |
| 2 | r1 | test | code | fail | 1 | covered by code verdicts (repro test, no regressions, policy gate) |  |
| 2 | r5 | test | code | fail | 1 | covered by code verdicts (repro test, no regressions, policy gate) |  |
| 3 | code:repro-test | code | code | pass | 1 | repro-issue-3 passed after the patch |  |
| 3 | code:no-regressions | code | code | pass | 1 | no regressions |  |
| 3 | code:gate | code | code | pass | 1 | policy gate passed |  |
| 3 | r1 | test | code | pass | 1 | covered by code verdicts (repro test, no regressions, policy gate) |  |
| 3 | r5 | test | code | pass | 1 | covered by code verdicts (repro test, no regressions, policy gate) |  |
| 3 | r2 | diff | validator | pass | 1 | The diff shows Math.ceil is used instead of roundCurrency. |  |
| 3 | r3 | diff | validator | pass | 1 | The escalation evidence shows roundCurrency remains unchanged. |  |
| 3 | r4 | behavior | validator | pass | 1 | The test outcome shows no regressions and the escalation evidence confirms the behavior change. |  |

## Escalation

Attempt 3: validator was unclear on r3; one evidence escalation re-ran the validator.

## Failure memory used

### Summary 1

Attempt 1 failed (class: blocked_policy).
Failed gate rules:
  - blast_radius: changed symbol(s) over 10 callers: roundCurrency=19

### Summary 2

Attempt 2 failed (class: blocked_policy).
Failed gate rules:
  - path_scope: test/shipping.test.ts is denied
  - tests_protected: test file(s) added, deleted, renamed or modified: test/shipping.test.ts(M)

## Totals (from the ledger)

prompt tokens: 13105
completion tokens: 1047
total tokens: 14152
gateway cost (USD): $0.035671
wall time: 48.7s

## Shipment

The run branch in the run copy holds the shipped commit, and proposed.patch holds the same change. NO pull request was opened.
