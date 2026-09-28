# LSEG go-live runbook (real credentialed session)

The public demo is synthetic. This is the **private** path: how to run a real,
credentialed LSEG session so the same guard, reconcile, and attest pipeline runs
against genuine vendor data. Everything except the credential-bound steps is already
coded and tested; with a valid entitled key this is roughly an hour.

**Do this under your NDA / entitlement, not on a shared machine. A production key
pasted into a shell or a chat should be rotated afterward.**

## Preconditions

- Node 22 (`nvm use 22`) - the engine needs `node:sqlite`.
- Python 3 on PATH (or set `LSEG_PYTHON` to the interpreter that has `lseg-data`).
- An **entitled** LSEG app key: a Data Platform machine key, or a running LSEG
  Workspace session on the same machine. The key must be entitled for every `TR.*`
  field and every instrument you pull.

## Steps

1. **Install the vendor library** (the one piece missing locally):
   ```bash
   pip install lseg-data
   python3 -c "import lseg.data; print('lseg-data OK')"
   ```
   If `python3` is not the interpreter with `lseg-data`, set `LSEG_PYTHON=/path/to/python`.

2. **Confirm the call shapes** against your installed `lseg-data` version, via lseg-mcp
   (gap #5). The bridge (`fintelligence-core/scripts/lseg_fetch.py`) assumes
   `get_data(universe=, fields=, parameters=, use_field_names_in_headers=True)` for
   fundamentals and `get_history(...)` for prices. Use lseg-mcp `draft_api_call` to
   confirm both, and adjust the bridge only if the signature differs.

3. **(Pricing only) validate quote PermIDs** (gap #6). Fundamentals key on the already
   validated Org PermIDs, so `reconcile` / `basis` need nothing extra. Prices key on a
   quote PermID, which is currently a labelled placeholder (`QUOTE-PENDING:<RIC>`) in
   `fintelligence-core/src/lseg.js` (`INSTRUMENTS`). Resolve the real quote PermID per
   RIC via lseg-mcp `validate_lseg_formula` / ID resolution and replace the placeholders
   before a live price pull.

4. **Fill the licensing sign-off** in `fintelligence-core/db/lseg-licensing.md` from the
   signed LSEG agreement: usage class (display vs non-display), cache TTL, redistribution,
   and per-field entitlement. The tags in code encode a policy, they do not grant a right.

5. **Set the credential and ingest** (never commit the key):
   ```bash
   cd fintelligence-core
   export LSEG_APP_KEY="<your-entitled-app-key>"
   node bin/fintel.js lseg ingest IBM.N AAPL.O VOD.L --period FY2023 --live
   # or pass it inline instead of exporting: --app-key <key>
   ```
   `--live` swaps `FakeLsegSession` for `RealLsegSession`, which shells out to the Python
   bridge. Without a key it refuses to run (loud, not silent); without `lseg-data` it
   reports `kind: dependency`.

6. **Verify the same way as the demo** - nothing downstream changed:
   ```bash
   node bin/fintel.js lseg reconcile IBM.N FY2023   # integrity: Revenue - Cost = Gross
   node bin/fintel.js lseg basis IBM.N FY2022       # standardized (COA) vs as-reported
   node bin/fintel.js lseg prices IBM.N             # daily close series (needs quote PermIDs)
   node bin/fintel.js lseg retention                # cache-TTL + licensing governance (C1.1)
   node bin/fintel.js lseg audit                    # verify the attestation chain
   ```

## Troubleshooting (bridge error kinds)

The bridge classifies failures so an entitlement gap is visible, not silent:

- `permission_denied` - not entitled for that field/instrument (a 401/403). Fix the
  entitlement, do not swap the field.
- `not_found` - bad RIC or field code (a 404). Re-resolve via lseg-mcp.
- `transport` - timeout / connection / session-not-open. Retried with backoff; check the
  Workspace session.
- `dependency` - `lseg-data` not importable in the interpreter the engine spawned. Fix
  `LSEG_PYTHON` / the install.

## What needs the credential (cannot be pre-staged)

Steps 1-2 can be done anytime. Steps 3-6 need the entitled key / a live Workspace
session, so they belong to the NDA context. If you will not have a key at interview time,
run the synthetic demo (real codes, real pipeline, labelled synthetic) and use the gated
`Go live` panel on `/lseg` to show that the same path flips to real the moment a key and a
deployed engine are supplied.
