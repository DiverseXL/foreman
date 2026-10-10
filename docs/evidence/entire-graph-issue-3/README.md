# Entire graph evidence: issue 3

Raw JSON output of every `entire graph` command run while building structural
context for issue 3 (`Volumetric freight fee undercharges by one cent due to
half-up rounding`).

Provenance:

- Source run: `runs/run-1791645006432` (run artifacts under `runs/` are gitignored;
  this directory is the committed copy).
- Issue: 3
- Workspace base commit (run copy): `2c77ee9ac9d295808d9d40099ea9174b7c57f7fd`
- graph provider: `entire-graph v0.4.0`, profile `full`, completeness `ok`
  (18 files, 73 symbols, 231 relations)

Files (in execution order):

- `01-index.json` - `entire graph index --repo <run copy> --format json`
- `02-def-calculateVolumetricShipping.json` - `entire graph def calculateVolumetricShipping`
- `03-impact-calculateVolumetricShipping.json` - `entire graph impact --symbol calculateVolumetricShipping`
- `04-search-calculateVolumetricShipping.json` - `entire graph search --query calculateVolumetricShipping`
- `05-def-roundCurrency.json` - `entire graph def roundCurrency`
- `06-impact-roundCurrency.json` - `entire graph impact --symbol roundCurrency`
- `07-search-roundCurrency.json` - `entire graph search --query roundCurrency`
- `08-search-src-rounding.ts.json` - `entire graph search --query src/rounding.ts`

No secrets are present: these files contain only symbol, file, and relation data.
