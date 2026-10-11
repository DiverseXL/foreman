# Project

Foreman is a TypeScript CLI agent that takes an issue on a sample repository, constructs an evaluation rubric, gathers context using entire-graph, proposes candidate patches, enforces fail-closed policy checks and tests, obtains an independent validator verdict, and ships exclusively upon a full pass.

# Team

DiverseXL

# Stack

- TypeScript / Node.js (ESM)
- neatlogs for tracing and observability
- Entire CLI and entire-graph for context retrieval and agent checkpoints

# Build log

- 2026-10-10 10:46:26 +01:00 - Step 1: scaffold
- 2026-10-10 11:40:31 +01:00 - Step 2: synthetic target repo and seeded benchmark issues
- 2026-10-10 12:35:09 +01:00 - Step 3: run engine, append-only facts, derived status, workspace isolation, offline test runner, and neatlogs telemetry
- 2026-10-10 13:12:54 +01:00 - Step 4: deterministic mandate parsing, entire-graph structural context retrieval, and telemetry spans
- 2026-10-10 - Model router added. Sonnet for patch, Haiku for validate and cheap. LiteLLM base URL https://litellm.vision.aivar.app/v1. API key in .env only (LITELLM_API_KEY).
- 2026-10-10 16:40:44 +01:00 - Step 6: fail-closed policy gate (7 rules, one pure function each, throw=fail), target/regression test judging (tests_result now carries targetPassed/regressions), ledger switched to gateway-reported cost plus key spend/budget with a 3 USD reserve refusal, GUARDRAIL trace span, injected-patch mode (--patch-from), cleaned the seeded-bug comments from the fixture src, and documented demonstration injected patches under docs/evidence/injected-patches/.
- 2026-10-10 17:12:27 +01:00 - Step 7: independent validator (nova-pro, a different model from the sonnet patch model; code-enforced rubric-id match, confidence range and an 0.7 confidence floor, retry once then needs_human) and a supervisor retry loop (up to maxAttempts 3, per-attempt reset to the base commit, failure memory fed into the next patch prompt, stuck_duplicate detection on repeated diff hashes, transient 429/5xx/network retries that do not consume an attempt, per-run token and wall-clock budgets, NEEDS_HUMAN.md on every terminal failure, proposed.patch plus a shipped fact on success). Added AGENT supervisor / CHAIN attempt-N / EVALUATOR validator spans, per-run report.md and economics.json derived only from facts and the ledger, and --first-attempt-patch-from for injected-first-attempt fault injection. Unit tests drive the loop with fake patch providers and a fake validator (no model calls).
- 2026-10-10 21:18:23 +01:00 - Step 8: made the validator's job verifiable without lowering any bar. Code now decides the three deterministic facts (repro test, no regressions, gate) as verdicts with source code and confidence 1; rubric criteria with check "test" are reported as covered by code verdicts, and only "diff"/"behavior" criteria reach the validator, with allCriteriaPass requiring both groups. The rubric prompt must state verifiable evidence; the validator now receives the bounded post-patch source of changed functions, passed/failed test names, a test-to-symbol note, and direct call sites, and must supply missing_evidence for every "unclear" (enforced in code). ONE evidence escalation re-runs the validator with full changed files and direct-caller bodies when only unclear verdicts block (new policy key validatorEscalation true); issue 3 shipped through exactly that path (r3 unclear -> escalated -> pass). Reports now show a per-criterion table (attempt, criterion, check, source, verdict, confidence, reason, missing evidence) and mark injected attempts. Real runs: issue 3 (injected) shipped; issue 1 and issue 2 stopped at needs_human (issue 1: validator hard "fail" on a diff criterion the patch satisfied; issue 2: an unverifiable downstream "receipt formatting" behavior criterion stayed unclear after escalation). Confirmed the step-7 CRLF fix: attempts 2/3 patches apply and commit cleanly now. Evidence pack under docs/evidence/run-issue-3-injected-first-attempt-shipped (its first attempt was injected via --first-attempt-patch-from). Tests 97 passing, tsc clean.
- 2026-10-10 21:59:23 +01:00 - Step 9: closed the three gaps the real runs exposed, without lowering any bar. (1) The patch prompt now states in plain text that test files and every denied path are READ ONLY, reads the allowed/denied lists from foreman.policy.json at runtime (not hardcoded), and shows the failing repro test as READ ONLY EVIDENCE with the instruction that it must pass by changing source code only; no pre-apply path filter was added, the gate stays the only enforcer. (2) Each rubric criterion now carries an evidence_ref {kind: test|symbol|issue_text, value} validated in code against the run copy's test names (static scan), context.json symbols, or a whitespace-normalized substring of the issue text; invalid criteria trigger one regeneration, then DROP only the invalid ones with a criteria_dropped fact, and needs_human rubric_invalid if fewer than 2 remain without a diff/behavior criterion. (3) The validator now receives each changed function as labeled BEFORE and AFTER blocks (80 lines each) and takes its model from the new policy key validatorModel (default exactly nova-pro, unchanged); every existing validator rule is kept. Added scripts/replay-validator.ts, a dev-only replay (flagged in its header, not part of the agent) of the validator over the three known-correct patches plus two HANDMADE NEGATIVE test-passing patches across nova-pro, nova-2-lite and claude-haiku. Added a throwaway behavior check of the shipped issue-3 rounding under .foreman-work (gitignored). Real runs after the fixes: issue 1 shipped model-only in 1 attempt (validator unclear -> escalated -> pass), issue 2 shipped model-only in 1 attempt, issue 3 with the injected first attempt stopped at needs_human (validator emitted an id not in the rubric). None of the three runs edited a test file. Renamed the issue-3 evidence pack to run-issue-3-injected-first-attempt-shipped and removed the duplicate. Tests 105 passing, tsc clean. Step 9 ended at 197,143 of the 200,000 total-token budget.
- 2026-10-10 23:15:19 +01:00 - Step 9 verification update: the evidence-validation retry now resends each invalid criterion with its reason; the patch prompt requires runtime policy paths and read-only repro evidence; replay probes use the shared model ledger and never read .env. Added fixed-fixture prompt and token-cap preflight tests. `npm test`: 107 passing; `npx tsc --noEmit`: clean. The shipped issue-3 behavior check reproduces a one-cent overcharge for 1.1 (actual 1.11, expected 1.10). The saved ledger already exceeds its 200,000-token cap, so no further real model calls, full runs, or replay calls were made in this verification.
- 2026-10-11 00:19:42 +01:00 - Step 10 verification: the baseline remains 97 ledger lines, 207,001 cumulative tokens, key spend $0.5117495, and 31 pre-existing run folders. Baseline-relative run/token/spend preflights, console teeing, no-graph context/gate reporting, and post-shipment held-out facts are implemented. Each held-out test passes against its temporary reference and fails against the unpatched fixture; `npm test` passes (111 tests) and `npx tsc --noEmit` is clean. Measurement and default-validator replay tools are prepared, but were not executed because previous real runs exceeded the 30-second stop limit; the result tables contain zero measurements and use the actual sample denominator (0/0). No Step 10 model calls were made.
- 2026-10-11 08:44:16 +01:00 - Step 10b: added configurable child-process timeouts and output buffering, pure child-result classification with fixed-fixture tests, resumable/filtered/dry-run plan flags, and per-run progress summaries. `npm test` passes (115 tests), `npx tsc --noEmit` is clean, and dry-run prints the 15-item plan. No model calls or Foreman runs were made.
- 2026-10-11 15:20:01 +01:00 - Step 10c: measurement results merge by run ID, can rebuild from post-baseline run folders, print child/derived outcomes, and report per-issue/mode aggregates with run details. `npm test`: 124 passing; `npx tsc --noEmit`: clean. Rebuild found 10 post-baseline runs and added 5 rows; no model calls or real Foreman runs were made.
- 2026-10-11 09:19:56 +01:00 - Step 10b hardening: measurement children have configurable timeout/classification and resumable dry-run controls; ledger lines track model-call stage and emit sanitized usage summaries; reports show per-stage usage and fact-derived verdict/proof blocks; supervisor reset facts verify the base commit and clean tree. `npm test`: 120 passing; `npx tsc --noEmit`: clean; measurement dry-run printed the 15-item plan. No model calls or real Foreman runs were made.
- 2026-10-10 20:50:08 +01:00 - Step 7 verification and fix: real runs against the sample repo (issue 2 shipped in 1 attempt; issue 1 and the injected-first-attempt issue 3 stopped at needs_human after the adversarial validator returned an "unclear" verdict under the 0.7 confidence floor and the retry loop then hit apply_failed). Root cause of the failing retries: the isolated run copy inherited the host's core.autocrlf=true, so `git reset --hard` materialised CRLF working-tree files while the patch model emits LF newlines, breaking every multi-line "search" string on attempts 2+. Pinned the run copy to LF (core.autocrlf=false, core.eol=lf) and made applyEdits line-ending tolerant, with regression tests (npm test 81 passing, tsc clean). Added scripts/probe-nova.ts (tiny nova-pro json_schema pre-flight) and persisted the raw proposal on apply failure (attempt-<n>-proposal.json).
- 2026-10-10 16:11:42 +01:00 - Step 5: first real model calls. Gateway pre-flight (tiny calls to claude-haiku and claude-sonnet-4.6, raw HTTP cost headers, structured JSON support verified via response_format json_schema). Model-built rubric (claude-haiku) with schema validation, structured patch proposal (claude-sonnet-4.6) applied under an exact-once rule, git diff hashing, target tests, per-run artifacts (mandate.json, context.json, graph-raw/), and a fail-closed cost/token ledger (src/model/ledger.ts). Prices in prices.json are ESTIMATES; models with null prices are refused.

# Entire evidence

Checkpoint 01M4JT40HZGG35HK6VBBDTQS3B (engine commit)
Checkpoint 01M4K3QGW1D9S183TNZFEJ1KA4 (commit 54dd8af1a84a53a5b662a22f24b089bd852e7ad4): https://entire.io/gh/DiverseXL/foreman/commit/54dd8af1a84a53a5b662a22f24b089bd852e7ad4
Raw entire-graph JSON for issue 3: docs/evidence/entire-graph-issue-3/

# Demo

Pending demo steps.

# Known limitations

The sample target repository (fixtures/sample-repo) and its issues are synthetic and intentionally seeded to benchmark the policy gate and agent recovery capabilities. Earlier build steps exceeded their own run and token caps; Step 10 measures caps from a baseline file. See [Step 10 measurement results](docs/evidence/measurements/results.md).

<!-- run-inventory:start -->
## Every run (generated from the runs/ folders)

Counts: 31 run folders; 4 shipped; 3 model-only shipped of 31 total runs.

| Run | Issue | Mode | Outcome | Attempts | Patch source |
| --- | --- | --- | --- | ---: | --- |
| run-1791631662795 | 1 | graph | incomplete | 0 | none |
| run-1791632052856 | 1 | graph | incomplete | 0 | none |
| run-1791634231579 | 1 | graph | incomplete | 0 | none |
| run-1791634290174 | 1 | graph | incomplete | 0 | none |
| run-1791634889559 | 1 | graph | incomplete | 0 | none |
| run-1791634921686 | 1 | graph | incomplete | 0 | none |
| run-1791645006432 | 3 | graph | incomplete | 0 | none |
| run-1791645126690 | 1 | graph | incomplete | 0 | none |
| run-1791645233735 | 1 | graph | tests_failing | 1 | model |
| run-1791645337629 | 1 | graph | incomplete | 0 | none |
| run-1791645361149 | 2 | graph | incomplete | 0 | none |
| run-1791646617681 | 3 | graph | blocked_policy | 1 | injected |
| run-1791646667407 | 1 | graph | ready_to_ship | 1 | model |
| run-1791646724289 | 2 | graph | blocked_policy | 1 | injected |
| run-1791646759435 | 3 | graph | blocked_policy | 1 | injected |
| run-1791648871934 | 1 | graph | needs_human | 3 | model |
| run-1791649030113 | 3 | graph | needs_human | 3 | injected+model |
| run-1791649124270 | 2 | graph | needs_human | 3 | model |
| run-1791649281401 | 1 | graph | needs_human | 3 | model |
| run-1791661223044 | 1 | graph | needs_human | 3 | model |
| run-1791661369329 | 3 | graph | needs_human | 3 | injected+model |
| run-1791661516262 | 2 | graph | shipped | 1 | model |
| run-1791661589506 | 3 | graph | needs_human | 3 | injected+model |
| run-1791663075525 | 1 | graph | needs_human | 3 | model |
| run-1791663174555 | 3 | graph | shipped | 3 | injected+model |
| run-1791663262346 | 2 | graph | needs_human | 3 | model |
| run-1791666044437 | 1 | graph | shipped | 1 | model |
| run-1791666161585 | 2 | graph | shipped | 1 | model |
| run-1791666213988 | 3 | graph | needs_human | 2 | injected+model |
| run-1791667844123 | 1 | graph | incomplete | 0 | none |
| run-1791668279953 | 1 | graph | needs_human | 2 | model |
<!-- run-inventory:end -->

## Residual limitations

- The independent validator is a fallible model. In the step-9 replay (scripts/replay-validator.ts) on the SAME evidence, the two usable models disagreed on the known-correct issue-1 patch: nova-pro called the diff criterion "fail" while claude-haiku passed the diff but "failed" the behavior criterion on a wrong arithmetic claim. Code-decided verdicts and the fail-closed gate remain the only enforcers, so a validator disagreement cannot ship a wrong patch, but it can block a correct one.
- nova-2-lite returns empty content under json_schema on this gateway, so it cannot review; the policy validatorModel stays nova-pro.
- The validator can emit rubric ids that do not exist and, after its single retry, force needs_human (issue 3 run-1791666213988 returned id r3 that was not in the rubric).
- The shipped issue-3 fix Math.ceil(rawFee * 100) / 100 still overcharges by one cent when rawFee's binary value sits just above the cent (rawFee 1.1 yields 1.11, not 1.10), shown by the throwaway behavior check.
- "Reject criteria about unrelated code" remains a prompt-level rule, not a code-enforced one.
- The saved model ledger contains 207,001 tokens across 97 calls, 7,001 over the 200,000-token step limit. The token cap is restored to 200,000 and now checked before model calls; no further remote calls were made after detecting the overrun.

# Submission

## Submission checklist

- [x] Public repository with dated commits: [DiverseXL/foreman](https://github.com/DiverseXL/foreman).
- [ ] Demo video covering all three tools.
- [ ] Before-and-after neatlogs evidence.
- [x] Failure-recovery run: [issue 3 injected-first-attempt evidence](docs/evidence/run-issue-3-injected-first-attempt-shipped/README.md).
- [x] Entire checkpoint link and ID: [checkpoint 01M4K3QGW1D9S183TNZFEJ1KA4](https://entire.io/gh/DiverseXL/foreman/commit/54dd8af1a84a53a5b662a22f24b089bd852e7ad4).
- [ ] cfo.ai plan and human-provided share link/export.
- [ ] X post quoting the official post.

## Build log

- 2026-10-11 16:05:41 +01:00 - Step 11: added offline measured-economics and before/after generators, fact-and-ledger-only run receipt rendering, evidence index and tool provenance, and the submission checklist. No model calls or Foreman runs were made.
- 2026-10-11 17:12:49 +01:00 - Step 12a: vetted scule, pathe, ufo, and defu from full-history clones; ran direct Vitest suites, mined fix/bug history, and experimentally verified three scule regressions against their parent commits. No model calls or Foreman runs were made.
