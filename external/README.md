# External regression targets

These records describe four experimentally verified upstream regressions. No
third-party source code is committed here. The setup tool clones each repository
with full history at the pinned parent SHA and overlays only the selected fix
commit's test files; the source fix itself is not copied into the parent clone.

The symptom text in `targets.json` deliberately omits each commit message and
uses only the failing test name and its assertion message. Models may have seen
older fixes during training; fix dates are recorded, and scule is included as
an older control.

Run `npm run setup-external -- <target-name>` to prepare a parent-source
regression workspace, or append `--dry-run` to display the plan without
downloading or changing files. Dependencies, when needed, are installed with
lifecycle scripts disabled.
