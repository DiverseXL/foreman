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
- 2026-10-10 21:18:23 +01:00 - Step 8: made the validator's job verifiable without lowering any bar. Code now decides the three deterministic facts (repro test, no regressions, gate) as verdicts with source code and confidence 1; rubric criteria with check "test" are reported as covered by code verdicts, and only "diff"/"behavior" criteria reach the validator, with allCriteriaPass requiring both groups. The rubric prompt must state verifiable evidence; the validator now receives the bounded post-patch source of changed functions, passed/failed test names, a test-to-symbol note, and direct call sites, and must supply missing_evidence for every "unclear" (enforced in code). ONE evidence escalation re-runs the validator with full changed files and direct-caller bodies when only unclear verdicts block (new policy key validatorEscalation true); issue 3 shipped through exactly that path (r3 unclear -> escalated -> pass). Reports now show a per-criterion table (attempt, criterion, check, source, verdict, confidence, reason, missing evidence) and mark injected attempts. Real runs: issue 3 (injected) shipped; issue 1 and issue 2 stopped at needs_human (issue 1: validator hard "fail" on a diff criterion the patch satisfied; issue 2: an unverifiable downstream "receipt formatting" behavior criterion stayed unclear after escalation). Confirmed the step-7 CRLF fix: attempts 2/3 patches apply and commit cleanly now. Evidence packs under docs/evidence/run-issue-3-injected and run-issue-3-shipped. Tests 97 passing, tsc clean.
- 2026-10-10 20:50:08 +01:00 - Step 7 verification and fix: real runs against the sample repo (issue 2 shipped in 1 attempt; issue 1 and the injected-first-attempt issue 3 stopped at needs_human after the adversarial validator returned an "unclear" verdict under the 0.7 confidence floor and the retry loop then hit apply_failed). Root cause of the failing retries: the isolated run copy inherited the host's core.autocrlf=true, so `git reset --hard` materialised CRLF working-tree files while the patch model emits LF newlines, breaking every multi-line "search" string on attempts 2+. Pinned the run copy to LF (core.autocrlf=false, core.eol=lf) and made applyEdits line-ending tolerant, with regression tests (npm test 81 passing, tsc clean). Added scripts/probe-nova.ts (tiny nova-pro json_schema pre-flight) and persisted the raw proposal on apply failure (attempt-<n>-proposal.json).
- 2026-10-10 16:11:42 +01:00 - Step 5: first real model calls. Gateway pre-flight (tiny calls to claude-haiku and claude-sonnet-4.6, raw HTTP cost headers, structured JSON support verified via response_format json_schema). Model-built rubric (claude-haiku) with schema validation, structured patch proposal (claude-sonnet-4.6) applied under an exact-once rule, git diff hashing, target tests, per-run artifacts (mandate.json, context.json, graph-raw/), and a fail-closed cost/token ledger (src/model/ledger.ts). Prices in prices.json are ESTIMATES; models with null prices are refused.

# Entire evidence

Checkpoint 01M4JT40HZGG35HK6VBBDTQS3B (engine commit)
Checkpoint 01M4K3QGW1D9S183TNZFEJ1KA4 (commit 54dd8af1a84a53a5b662a22f24b089bd852e7ad4): https://entire.io/gh/DiverseXL/foreman/commit/54dd8af1a84a53a5b662a22f24b089bd852e7ad4
Raw entire-graph JSON for issue 3: docs/evidence/entire-graph-issue-3/

# Demo

Pending demo steps.

# Known limitations

The sample target repository (fixtures/sample-repo) and its issues are synthetic and intentionally seeded to benchmark the policy gate and agent recovery capabilities.
Initial scaffolding phase; agent loop and policy gates are not yet implemented.

# Submission

Pending submission details.
