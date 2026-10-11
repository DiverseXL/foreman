# Foreman Run Report: run-1791666161585

Issue: 2 - Subtotal accumulation exhibits floating-point drift
Outcome: shipped
Derived status: shipped
Attempts: 1
Injected first attempt: no
Trace ID: f22c942201b50d7299ec5ad4a12fb272

## Per-attempt results

| Attempt | Injected | Patch source | Diff hash | Gate | Failed rules | targetPassed | Regressions | Escalated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | no | model | e8688cc721ca | pass | none | true | none | no |

## Per-criterion verdicts (source: code or validator)

| Attempt | Criterion | Check | Source | Verdict | Confidence | Reason | Missing evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | code:repro-test | code | code | pass | 1 | repro-issue-2 passed after the patch |  |
| 1 | code:no-regressions | code | code | pass | 1 | no regressions |  |
| 1 | code:gate | code | code | pass | 1 | policy gate passed |  |
| 1 | r1 | test | code | pass | 1 | covered by code verdicts (repro test, no regressions, policy gate) |  |
| 1 | r2 | diff | validator | pass | 1 | Function now uses integer-cents arithmetic to avoid floating point drift. |  |
| 1 | r4 | diff | validator | pass | 1 | No external libraries added as per the zero runtime dependency policy. |  |

## Escalation

(no evidence escalation was needed)

## Dropped criteria

- r3: evidence_ref issue_text "The subtotal should evaluate to exactly 0.30" is not a substring of the issue text

## Failure memory used

(none; no earlier attempt failed)

## Totals (from the ledger)

prompt tokens: 6312
completion tokens: 745
total tokens: 7057
gateway cost (USD): $0.016481
wall time: 23.8s

## Shipment

The run branch in the run copy holds the shipped commit, and proposed.patch holds the same change. NO pull request was opened.
