# Tool and sponsor evidence

| Tool | How Foreman uses it | Where to verify |
| --- | --- | --- |
| neatlogs | Records one `WORKFLOW` trace named `foreman-run-<runId>` and spans named `workspace_setup`, `baseline_tests`, `mandate_load`, `graph_context`, `rubric`, `patch_propose`, `validator`, `supervisor`, and `attempt-<n>`. Run trace IDs are listed in the measurement results when available. | [Telemetry implementation](../../src/telemetry/index.ts), [span call sites](../../src/cli/index.ts), and [measured trace IDs](measurements/results.json) |
| Entire / entire-graph | Entire checkpoints record build milestones; entire-graph indexed and searched the issue 3 repository and traced the shipping-rounding symbols. | Checkpoints: `01M4KYJYNFCN2TS77RCY4EGAX2` — “feat(step9): harden evidence-guided patch validation”; `01M4K6DJM7BPVGBMT609WXF28G` — “feat(patch): add model-built rubric, patch proposal, and cost ledger”; `01M4K3QGW1D9S183TNZFEJ1KA4` — “feat: add model router and deterministic mandate and context stages”; `01M4JT40HZGG35HK6VBBDTQS3B` — “feat(engine): append-only facts, derived status, setup-only run”. See [issue 3 graph artifacts](entire-graph-issue-3/README.md). |
| cfo.ai | | TO FILL BY HUMAN: share link and export |

Entire-graph commands evidenced in the saved issue 3 graph README:

```text
entire graph index --repo <run copy> --format json
entire graph def calculateVolumetricShipping
entire graph impact --symbol calculateVolumetricShipping
entire graph search --query calculateVolumetricShipping
entire graph def roundCurrency
entire graph impact --symbol roundCurrency
entire graph search --query roundCurrency
entire graph search --query src/rounding.ts
```

Entire public commit links use this pattern:

```text
https://entire.io/gh/DiverseXL/foreman/commit/<full sha>
```
