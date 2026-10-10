# Injected patches (demonstration only)

These are demonstration-only edit payloads used with `foreman run --issue <n> --patch-from <file>`.
They skip the model and are applied directly, so the fail-closed policy gate can be
exercised deterministically. Each file is a valid `{ "edits": [{ file, search, replace }] }`
payload (the same schema the model must produce).

| File | Intent | Expected gate outcome |
| --- | --- | --- |
| `naive-issue-3.json` | Naive issue-3 "fix" that changes the shared `roundCurrency` helper in `src/rounding.ts` to round up | `blast_radius` (roundCurrency has 19 callers) |
| `bad-deps-issue-2.json` | Adds a `decimal.js` import to `src/cart.ts` and a dependency to `package.json` | `path_scope` (package.json denied) and `dependencies` |
| `delete-test.json` | Removes the failing assertion in `test/shipping.test.ts` | `tests_protected` (and `path_scope`, since `test/**` is denied) |

In every case the gate fails, the run records `attempt_failed` with `blocked_policy`, and the
target tests are NOT run (fail closed).
