# Foreman

Foreman is an autonomous TypeScript CLI agent designed to reliably resolve repository issues through structured evaluation and verification. It builds an objective rubric, collects code context via entire-graph, drafts candidate patches, and executes them against strict policy gates and test suites. Patches are only approved and shipped when an independent validator verdict confirms a complete pass across all evaluation criteria.

Model router (`src/model`) calls neatHack's OpenAI-compatible LiteLLM gateway. Patch tasks default to `claude-sonnet-4.6`. Validate and cheap tasks default to `claude-haiku`. Base URL defaults to `https://litellm.vision.aivar.app/v1`. The API key lives only in `LITELLM_API_KEY` (see `.env.example`; keep the real value in `.env`).
