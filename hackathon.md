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
