# LSEG integration — architecture review & action plan

_Self-contained handoff. Written 2026-09-25 · `main` @ `115a5db` · repo `justin-harvey/fin-telligence`, clone `/home/nah/Claudia/fin-telligence`._

Purpose: a forward-deployed-engineer review of the **LSEG business logic** (not the generic
engine), so a fresh session can pick up and harden it. Read `HANDOFF.md` first for whole-project
state; this doc is the LSEG-specific backlog.

---

## How to resume (environment)

- **Node 22 required** (`node:sqlite`): `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22`.
- Engine lives in `fintelligence-core/`. Tests: `npm test` (currently **136, all offline, green**).
- Seed + exercise the LSEG warehouse:
  ```bash
  cd fintelligence-core
  node bin/fintel.js lseg seed
  node bin/fintel.js lseg fundamentals IBM.N FY2023
  node bin/fintel.js lseg reconcile IBM.N FY2023
  node bin/fintel.js lseg ingest IBM.N --period FY2024      # FakeLsegSession (no key)
  ```
- **Pushing:** paste a GitHub PAT inline per push, use it inline, don't persist. `main` takes
  out-of-band GitHub-web edits, so `git fetch` + rebase before pushing.
- **Site copies are hand-synced:** editing `fintelligence/<x>.html` or `assets/index-*.js` means
  `cp` to the repo-root duplicate. `db/*.db` and `db/*-audit.jsonl` are gitignored.

## LSEG files (where the work is)

| File | Role |
|---|---|
| `fintelligence-core/db/lseg-schema.sql` | warehouse schema: `instruments`, `lseg_fields`, `fundamentals` |
| `fintelligence-core/src/lseg.js` | `seedLseg`, `fundamentalsSnapshot`, `reconcileGrossProfit`, allow-lists |
| `fintelligence-core/src/registry.js` | `lsegRegistry()` — field-keyed `SUM(CASE …)` metrics |
| `fintelligence-core/src/lseg-ingest.js` | ingest seam: `LsegSession`, `FakeLsegSession`, `RealLsegSession` |
| `fintelligence-core/scripts/lseg_fetch.py` | Python bridge to `lseg-data` (real fetch) |
| `fintelligence-core/src/controls.js` | `PI1.1-lseg-gross-profit-reconciliation` control |
| `fintelligence-core/db/lseg-anchor.md` | claim discipline + the 9 validated TR.* codes (COA) |
| `fintelligence-core/mcp/` | lseg-mcp client config + workflow (validation harness `lseg_probe.mjs`) |
| `fintelligence/lseg.html` (+ root copy) | the `/lseg` marketing/demo page |

Field codes were validated live via lseg-mcp `validate_lseg_formula` on 2026-09-24 — all 9 `OK`.

---

## Findings

### What's sound (keep)
Session-interface seam (`Fake`/`Real` `LsegSession`), field-code validation at ingest against
`lseg_fields`, provenance-to-field-code, read-only guard + hash-chained audit. Good bones.

### Missing (business logic)

1. **Identifier model is wrong — `RIC` as primary key.** `instruments.ric TEXT PRIMARY KEY` /
   `fundamentals.ric`. RIC is a *quote* id (instrument × venue) and **not stable** (ticker/exchange
   changes, M&A). Fundamentals are **entity-level**, keyed by **Org PermID** in LSEG's model. Fix:
   introduce PermID as the stable key (org PermID for fundamentals, quote/instrument PermID for
   pricing); keep RIC as a mutable alias.
   **[FIXED 2026-09-25 — P4]** New `organizations` table (`org_permid` PK — real LSEG Org PermIDs:
   IBM `4295904307`, Apple `4295905573`, Vodafone `4295896661`). `instruments` demoted to a
   quote/listing table whose `ric` is a **mutable alias** with an `org_permid` FK. `fundamentals`
   re-keyed from `ric` → `org_permid` (entity grain). Reads accept the familiar RIC and resolve it to
   the Org PermID (`resolveOrgPermid`) before touching `fundamentals`; allow-list, seed, ingest seam
   (mints a `PENDING:<ric>` placeholder org for an unseen RIC), and CLI all migrated. Quote PermID for
   pricing deferred with the pricing-grain fix (#6/P7). Test: re-aliasing a RIC to another org makes
   it resolve to that entity's fundamentals — the RIC follows nothing, the org is the identity.

2. **LSEG field *parameters* aren't modeled.** A `TR.*` fundamental is a function of parameters the
   schema doesn't carry:
   - **`Curn` / currency + FX** — all synthetic-USD; `fundamentals.currency` just copied from the
     instrument. `Revenue − CostOfRevenue` is only valid in one currency at one FX basis. No FX
     consistency check → silent wrong answers on real multi-currency data.
   - **`Scale`** — e.g. `TR.CompanyMarketCap` "Commonly Scale=6" (millions); values stored raw →
     10⁶ magnitude errors.
   - **`Period` / periodicity** — bare `'FY2023'` string; no FY/FQ/LTM, no fiscal-year-end
     alignment/calendarization.
   - **`ReportingState` / restatements** — no Original vs Reported vs Restated.
   - **Alignment: Standardized (COA) vs As-Reported** — we pull the standardized model (matters for #3).
   **[FIXED 2026-09-25 — P5]** `fundamentals` now carries `scale` (actual = value·10^scale),
   `periodicity` ('FY'/'FQ'/'LTM', read off the period label), and `reporting_state`
   ('original'/'reported'/'restated', the seam for #5); `currency` already existed. Both
   reconciliations compute `COUNT(DISTINCT …)` variant counts across their components and the control
   **refuses (EXCEPTION) on mixed currency/scale/periodicity** rather than subtracting incomparable
   figures — the FX guard. (Alignment/basis was handled in P3.) Test: Cost→GBP while Revenue is USD →
   `currency_variants=2` → EXCEPTION "cannot reconcile across mixed currency". Seed stays raw
   (scale 0), single-currency USD, `reporting_state='reported'`, so existing value assertions hold.

3. **The reconciliation is (nearly) tautological on real LSEG data.** `reconcileGrossProfit` asserts
   `TR.GrossProfit == TR.Revenue − TR.CostOfRevenueTotal`. In LSEG's *standardized* model `SGRP` **is
   defined as** `SREV − SCOR`, so on clean vendor data the identity holds by construction — the
   `EXCEPTION` branch only fires on ingest corruption or tamper. That's a real *pipeline-integrity*
   check, but **not** "catching a discrepancy in LSEG's numbers" as `/lseg` implies. Higher-value
   reconciliations: **Standardized COA vs As-Reported**, **vendor vs the filing**, or cross-vendor.
   Also: **the LSEG path never invokes `grounding.js`** (canonical SQL + direct column compare, no
   narration), so the page's "ground-or-refuse" emphasis isn't the guarantee actually exercised for
   LSEG — it's the reconciliation control + audit chain. Align the copy to the mechanism.
   **[FIXED 2026-09-25 — P3]** Added a `basis` dimension (`standardized` | `as_reported`) to
   `fundamentals`; existing standardized queries scoped to `basis='standardized'` (no double-count).
   New `reconcileStandardizedVsAsReported` + control `PI1.1-lseg-standardized-vs-as-reported` tests
   *data* (IBM.N FY2022 seeds a $500m reclassification → EXCEPTION; others tie). The old identity
   control is relabelled honestly as a standardized-model **integrity/tamper** check. CLI: `fintel
   lseg basis [RIC] [FY]`. `/lseg` copy realigned to reconciliation + hash-chained audit (grounding
   references removed from the LSEG-specific path); root `lseg.html` re-synced.

4. **Missing data silently becomes `0` (no NA handling).** `lsegRegistry` metrics are
   `SUM(CASE WHEN field_code='TR.Revenue' THEN value ELSE 0 END)` over `WHERE ric=? AND period=?`.
   If the Revenue row is **absent** (LSEG `<NA>`, unentitled, coverage gap) the sum is **`0`, not
   `NULL`** → `revenue_usd=0`, identity `0−0=0 == reported 0` → **false PASS**, or a plausible zero.
   `ingest` also `continue`s past `value == null`, so absence is indistinguishable from a real zero.
   No presence/coverage assertion. **This is the dangerous failure mode for regulated use.**
   **[FIXED 2026-09-25 — P1]** `lsegRegistry` `fieldSum` dropped its `ELSE 0`, so an absent
   field sums to `NULL`, not `0`. `reconcileGrossProfit` now also returns `revenue_present` /
   `cost_present` / `gross_present` `COUNT`s, and the reconciliation control (and the `fintel lseg
   reconcile` CLI) report **N/A** — never a false PASS — when any required component is absent.
   Tests: `test/lseg.test.js` (NULL + presence), `test/controls.test.js` (control → N/A).

5. **No point-in-time / bitemporal model.** Only `retrieved_at` (one timeline); no period-end vs
   knowledge/as-reported time; re-ingest appends/overwrites with no restatement versioning.
   Consequence: the "same result hash on re-run" guarantee **breaks the first time LSEG restates** a
   figure — a legitimate restatement then reads like tampering in `verify()`. Fix: bitemporal keys
   (period date + knowledge date).
   **[FIXED 2026-09-26 — P6]** Added `knowledge_date` (transaction time, distinct from `period` =
   valid time and `retrieved_at` = when we landed it) to `fundamentals` + a bitemporal index. A
   restatement is now a **new row** (later `knowledge_date`, `reporting_state='restated'`), never an
   overwrite. All three reads take an optional `asOf` (default sentinel `9999-12-31` = latest known,
   fixed so hashes don't drift with the clock) and inject a correlated `MAX(knowledge_date) <= asOf`
   subquery — guard-safe, no UNION — so **exactly one vintage per (org, field, period, basis)** is
   picked (no cross-vintage double-count; an as-of before any vintage → N/A, not a false 0). Seed adds
   IBM.N FY2021 original (known 2022-04-01) + restated (known 2023-05-15); ingest stamps
   `knowledge_date`. CLI: `--as-of YYYY-MM-DD` on fundamentals/reconcile/basis. Tests: an as-of read
   reproduces its hash, the restated vintage differs, and `verify()` stays intact across both — the
   restatement is a new knowledge-time fact, not tampering, so CC7.3 survives it.

6. **`lseg-data` operational realities unhandled.**
   - **Entitlements are per-dataset/field**; `scripts/lseg_fetch.py` catches `get_data` errors
     generically — distinguish permission-denied vs not-found vs transport.
   - **Pricing is the wrong grain** — `TR.PriceClose` is a time series (`SDate/EDate/Frq`) via
     `get_history`, not a per-period fundamental.
   - **Batching / rate limits / session lifecycle** — one `get_data` for the whole universe×fields,
     and a **fresh Python session opened per ingest call** (spawn-per-call). Real Workspace sessions
     are heavy and concurrency-limited; large universes need chunking + backoff + a long-lived session.
   **[FIXED 2026-09-26 — P7]** (a) The bridge now **classifies** every failure into
   `permission_denied` / `not_found` / `transport` / `bad_request` / `dependency` (status-code +
   message heuristics; permission before not-found) and returns `{error, kind}`; `RealLsegSession`
   surfaces `kind` on the thrown error. (b) **Pricing moved to its own grain**: new `quote_permid` on
   `instruments` (the deferred P4 quote key) + a `prices` table (one row per quote × trading day),
   retrieved via `get_history`; `TR.PriceClose` removed from `fundamentals`; `ingestFundamentals`
   refuses a Pricing field and `ingestPrices` refuses a non-Pricing one; read via `priceCloseSeries` /
   `fintel lseg prices`. (c) **Batching/session**: the bridge opens one session, chunks the universe,
   and retries only transport errors with exponential backoff (tunable via `RealLsegSession`
   `chunkSize`/`maxRetries`/`backoff`). Bridge is still exercised only against `FakeLsegSession`
   (no live entitlement); the JS-observable parts are tested (160 green). `TR.CompanyMarketCap` left
   in `fundamentals` as a noted candidate for the same pricing-grain treatment.

7. **Licensing / redistribution / caching compliance.** The design persists LSEG data to a snapshot
   warehouse. Inside the LSEG unit this is a real question: display vs non-display usage, caching
   TTLs, redistribution terms. No usage-tagging or retention control. Sign off before a live key.
   **[FIXED 2026-09-26 — P8]** New `data_sources` table tags each source once (not per row — also
   closes the "per-row constant duplication" cleanup) with `usage_class` (display/non-display),
   `retention_days` (cache TTL) and `redistribution` terms. `src/lseg-retention.js` reports, per
   source, rows held past TTL (on `retrieved_at`), untagged sources, and TTL-less policies, and
   `purgeExpired` deletes stale rows (dry-run option). The `C1.1-lseg-data-retention` control turns
   this into PASS/EXCEPTION evidence; ingest registers its source's policy so nothing lands untagged;
   CLI `fintel lseg retention [--as-of DATE] [--purge]` + `fintel lseg license`. The sign-off checklist
   (display vs non-display, TTL, redistribution, entitlement scope, identifier validity) is
   `db/lseg-licensing.md`. Tags encode policy, they don't grant a right — sign off real terms first.

### Redundant / over-engineered

- **`lsegRegistry` `SUM(CASE …)` indirection** — for a single (ric, period) it sums exactly one
  matching row; it exists only to reuse the "metric = SQL fragment" pattern, and it *hides* the
  NULL-vs-0 bug (#4). A direct `WHERE field_code IN (…)` pivot is clearer and safer.
- ~~**Double table scan in `reconcileGrossProfit`**~~ **[FIXED 2026-09-25 — P2]** — was two (then five,
  after P1) scalar subqueries over `fundamentals` with the same `WHERE`; now one aggregate SELECT
  scanning the table once (`(Σrev) − (Σcost) AS identity_gross_usd`, `Σgross`, three presence
  `COUNT`s), 2 bound params. Not a UNION (guard-safe).
- **Two sources of unit truth** — `lseg_fields.unit` and the registry `unit` can drift; keep the dictionary.
- **Seeded-but-unused fields** — only Revenue/Cost/Gross are exercised; `OperatingIncome`,
  `NetIncomeAfterTaxes`, `TotalDebtOutstanding`, `TotalAssetsReported`, `PriceClose`,
  `CompanyMarketCap` are dead weight vs the single control. Add controls that use them (balance-sheet
  identity, leverage, margins) or trim.
- **Per-row `source`/`currency` duplication** — constant per batch/instrument; normalize if it grows (minor).
  (Partly addressed: `source` policy now lives once in `data_sources` — P8.)

---

## Prioritized backlog (do in this order)

| # | Task | Why / acceptance | Effort | Risk |
|---|------|------------------|--------|------|
| ~~P1~~ ✅ | **NULL-vs-0 + coverage assertion (#4)** — DONE 2026-09-25 | Distinguish absent from zero. Change `lsegRegistry` metrics (or the query) so a missing field yields `NULL`, not `0`; add a presence/`COUNT` check; reconciliation returns **N/A** (not PASS) when a required component is absent. Add a test seeding a period with a missing Revenue row → expect N/A, not PASS. | S | Low |
| ~~P2~~ ✅ | **Collapse reconcile to one pass** — DONE 2026-09-25 | Single `SELECT` over `fundamentals WHERE ric=? AND period=?` returning revenue, cost, gross (and computed gross). Keep guard-compatible (no UNION). Tests stay green. | S | Low |
| ~~P3~~ ✅ | **Reframe the reconciliation (#3)** — DONE 2026-09-25 | Prototype **Standardized vs As-Reported** (add an `as_reported` value alongside the standardized COA value, reconcile them) so the control tests *data*, not a tautology. Update `/lseg` copy to match the guarantee actually exercised (reconciliation + audit, not grounding). | M | Med |
| ~~P4~~ ✅ | **PermID identifier model (#1)** — DONE 2026-09-25 | Add `org_permid` (fundamentals) / quote PermID (pricing) as stable keys; RIC becomes an alias column. Migrate schema + seed + queries. | M | Med |
| ~~P5~~ ✅ | **Field parameters on the grain (#2)** — DONE 2026-09-25 | Add `currency`, `scale`, `periodicity`, `reporting_state` to `fundamentals`; enforce single-currency in reconciliations (FX guard). | M | Med |
| ~~P6~~ ✅ | **Bitemporal keys (#5)** — DONE 2026-09-26 | Added `knowledge_date` (transaction time) distinct from `period`; restatements version (new row, not overwrite); reads take an `asOf` picking exactly one vintage per (org,field,period,basis); reproducibility is restatement-aware (`verify()` intact across a restatement). CLI `--as-of`. | M | Med |
| ~~P7~~ ✅ | **`lseg-data` ops (#6)** — DONE 2026-09-26 | Entitlement-aware error `kind` classification in `lseg_fetch.py`; pricing moved to `get_history` at its own grain (`quote_permid` + `prices` table, ingest guards both ways); one session + universe chunking + transport backoff. | M | Med |
| ~~P8~~ ✅ | **Licensing/redistribution sign-off (#7)** — DONE 2026-09-26 | `data_sources` usage/TTL/redistribution tags + `lseg-retention.js` report/purge + `C1.1` control + `db/lseg-licensing.md` sign-off checklist. | S (mostly non-code) | — |

**Quickest wins with no demo risk: P1 and P2.** Most interview-valuable: **P3**.

> **STATUS 2026-09-26: the entire P1–P8 backlog is complete** (P1–P6 shipped; P7 +
> P8 on `main`). 165 core tests, all offline, green. Release anchor
> `v0.7.0-lseg-p7` marks P1–P7; P8 lands on top. What remains is opportunistic
> cleanup (below) and the whole-project M7 deploy in `HANDOFF.md` — no open LSEG
> findings.

---

## Gotchas a fresh session must know

- **Node 22 only** (system node 18 / nvm default fail).
- **Guard column allow-list**: any new column added to `fundamentals` must be added to
  `LSEG_ALLOWED_COLUMNS` in `src/lseg.js` or queries reading it are refused. **UNION trips the
  allow-list — use scalar subqueries.**
- **`RealLsegSession` credential**: `LSEG_APP_KEY` env / `--app-key` / `{appKey}`; `LSEG_PYTHON`
  selects the interpreter. It refuses without a key. lseg-data isn't installed here; the bridge is
  untested against a live session (validated only via `FakeLsegSession`).
- **lseg-mcp** is written for MCP SDK v1 — launch with `uvx … --with 'mcp<2' lseg-mcp` or it crashes;
  first launch ~1–3 min to index; `validate_lseg_formula` is authoritative, the fuzzy
  `search_data_dictionary` seed is partial. Harness: `fintelligence-core/mcp/lseg_probe.mjs`.
- **Site**: `/lseg` page has a browser-side "Connect live data" panel (`window.FINTEL_LSEG`,
  localStorage) that only probes reachability today; wire it to the engine once M7 is deployed.
- **Model id** is `claude-opus-4-8`.

## Pointers
- `HANDOFF.md` — whole-project state + next steps (M7 deploy is the big pending item).
- `fintelligence-core/db/lseg-anchor.md` — claim discipline + validated field/COA table.
- `fintelligence-core/mcp/README.md` — lseg-mcp workflow + credential path.
- `BUILD-PLAN.md` (untracked, repo root) — full milestone spec.
