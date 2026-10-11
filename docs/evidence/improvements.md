# Before/after observations

These comparisons use run-folder epoch timestamps, append-only run facts, and the corresponding Git change timestamps.

## apply_failed facts per attempt

Change commit: `6b8c882cfd9810995a441a7ccb205dc452435172` (2026-10-10T20:53:14+01:00).

| Period | Runs (n) | Attempts | apply_failed facts (events) | Rate (events/attempt) | Trace IDs for event runs (when in economics.json) |
| --- | ---: | ---: | ---: | ---: | --- |
| Before | 23 | 27 | 11 | 0.4074 | n/a |
| After | 23 | 47 | 8 | 0.1702 | n/a |

## tests_protected gate failures per attempt

Change commit: `b64dfec1c0b2b142d62accfd122a941afe3583cc` (2026-10-10T23:22:53+01:00).

| Period | Runs (n) | Attempts | tests_protected gate failures (events) | Rate (events/attempt) | Trace IDs for event runs (when in economics.json) |
| --- | ---: | ---: | ---: | ---: | --- |
| Before | 31 | 42 | 5 | 0.1190 | n/a |
| After | 15 | 32 | 0 | 0.0000 | n/a |

The commits changed more than one thing, samples are small, and these before/after measurements are correlation, not proof.
