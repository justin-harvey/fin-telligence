# LSEG hardening — handoff (backlog complete)

_Self-contained. Written 2026-09-26. P1–P7 shipped on `main` (release tag
`v0.7.0-lseg-p7`); **P8 is implemented in the working tree, 165 tests green, NOT
yet committed** (repo `justin-harvey/fin-telligence`, clone
`/home/nah/Claudia/fin-telligence`)._

This is the end of the `LSEG-ARCHITECTURE-REVIEW.md` backlog. **P1–P8 are all done
and tested** (P1–P7 shipped; P8 sits uncommitted in the working tree — commit/push
when ready). No open LSEG findings remain — only the opportunistic cleanup below
and the whole-project M7 deploy in `HANDOFF.md`. Read the review for the full
findings; this doc is the "what's true now" for a fresh session.

---

## Release / rollback

- **Shipped release:** `ddb9bb9` — "LSEG hardening P1–P5" (on `main`, deployed lineage).
- **Rollback point (pre-release):** `9867a0a` — "Add LSEG architecture review + prioritized hardening backlog".
  To roll the release back: `git revert ddb9bb9` (safe) or, if nothing built on
  top, reset `main` to `9867a0a` and force-push (coordinate first — `main` is the
  deploy branch).
- **Pushing:** paste a GitHub PAT inline per push, use it inline in the URL, do
  not persist it. `main` has taken out-of-band GitHub-web edits historically, so
  `git fetch <url> main` and confirm the tip before pushing. (At release time the
  live remote `main` tip was exactly our base `9867a0a`; a stale cached
  `refs/remotes/origin/main` pointed at an older `f154e98` lineage — ignore it,
  trust `FETCH_HEAD`.)

## Environment / how to resume

- **Node 22 required** (`node:sqlite`). nvm has a prefix clash on this machine, so:
  ```bash
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use --delete-prefix v22.23.2
  ```
- Engine lives in `fintelligence-core/`. Run tests with `node --test` from that
  dir (150 tests, all offline, **green**). `npm test` also works after the nvm line.
- Exercise the warehouse:
  ```bash
  cd fintelligence-core
  node bin/fintel.js lseg seed
  node bin/fintel.js lseg fundamentals IBM.N FY2023      # standardized snapshot
  node bin/fintel.js lseg reconcile IBM.N FY2023          # standardized-model integrity (tamper check)
  node bin/fintel.js lseg basis IBM.N FY2022              # standardized vs as-reported → EXCEPTION ($500m reclass)
  node bin/fintel.js lseg ingest IBM.N --period FY2024    # FakeLsegSession (no key)
  ```
- **Site copies are hand-synced:** after editing `fintelligence/lseg.html`,
  `cp fintelligence/lseg.html lseg.html` (repo-root duplicate). `db/*.db` and
  `db/*-audit.jsonl` are gitignored. `BUILD-PLAN.md` and `Phineas/` are
  intentionally untracked — do not add them.

---

## What P1–P8 changed (so you don't re-derive it)

| # | What | Key surface |
|---|------|-------------|
| P1 | Absent field → `NULL` not `0`; presence `COUNT`s; reconciliations report **N/A** not a false PASS | `registry.js` (`fieldSum` dropped `ELSE 0`), `lseg.js`, `controls.js` (coverage gate) |
| P2 | `reconcileGrossProfit` collapsed to **one aggregate pass** (no UNION, guard-safe) | `lseg.js` |
| P3 | New **`basis`** dimension (`standardized`/`as_reported`) + `reconcileStandardizedVsAsReported` control that tests DATA; old identity control relabelled as pipeline-integrity/tamper; `/lseg` copy realigned to reconciliation + hash-chained audit (grounding removed from LSEG path); CLI `lseg basis` | `lseg-schema.sql`, `lseg.js`, `controls.js`, `bin/fintel.js`, `fintelligence/lseg.html` (+ root copy), `lseg-anchor.md` |
| P4 | **PermID identifier model**: new `organizations` table keyed by real Org PermID; `instruments.ric` demoted to a mutable alias (`org_permid` FK); `fundamentals` re-keyed `ric` → `org_permid`; reads resolve RIC→org via `resolveOrgPermid` | `lseg-schema.sql`, `lseg.js`, `lseg-ingest.js`, `bin/fintel.js` |
| P5 | **Field parameters** `scale`/`periodicity`/`reporting_state` on the grain; **FX guard**: reconciliations refuse (EXCEPTION) on mixed currency/scale/periodicity via `COUNT(DISTINCT …)` variant checks | `lseg-schema.sql`, `lseg.js`, `controls.js`, `lseg-ingest.js`, `bin/fintel.js` |
| P6 | **Bitemporal** `knowledge_date` (transaction time) on the grain; restatements version (new row, not overwrite); reads take `asOf` (default `9999-12-31`=latest) injecting a correlated `MAX(knowledge_date)<=asOf` subquery → exactly one vintage per (org,field,period,basis), no double-count, pre-vintage→N/A; CLI `--as-of`; `verify()` intact across a restatement. Seed adds IBM.N FY2021 original+restated | `lseg-schema.sql`, `lseg.js`, `lseg-ingest.js`, `bin/fintel.js`, `db/lseg-anchor.md`, `test/lseg.test.js` |
| P7 | **`lseg-data` ops.** (a) Bridge classifies failures → `{error, kind}` (`permission_denied`/`not_found`/`transport`/`bad_request`/`dependency`), surfaced on `RealLsegSession` errors. (b) **Pricing at its own grain**: `quote_permid` on `instruments` + new `prices` table (quote × trading day) via `get_history`; `TR.PriceClose` out of `fundamentals`; `ingestFundamentals` refuses Pricing fields, `ingestPrices` refuses non-Pricing; read via `priceCloseSeries` / `fintel lseg prices`. (c) One session + universe chunking + transport backoff (`RealLsegSession` `chunkSize`/`maxRetries`/`backoff`) | `scripts/lseg_fetch.py`, `lseg-schema.sql`, `lseg.js`, `lseg-ingest.js`, `bin/fintel.js`, `db/lseg-anchor.md`, `test/lseg.test.js`, `test/lseg-ingest.test.js` |
| P8 | **Licensing / retention governance.** New `data_sources` table tags each source once (`usage_class` display/non-display, `retention_days` TTL, `redistribution`) — also closes the per-row-duplication cleanup. `lseg-retention.js`: `retentionReport` (rows past TTL on `retrieved_at`, untagged sources, no-TTL policies) + `purgeExpired` (dry-run option). `C1.1-lseg-data-retention` control → PASS/EXCEPTION. Ingest registers its source's policy so nothing lands untagged. CLI `fintel lseg retention [--as-of DATE] [--purge]` + `fintel lseg license`. Sign-off checklist `db/lseg-licensing.md` | `lseg-schema.sql`, `lseg.js`, `src/lseg-retention.js`, `controls.js`, `lseg-ingest.js`, `bin/fintel.js`, `db/lseg-anchor.md`, `db/lseg-licensing.md`, `test/lseg-retention.test.js` |

**Real Org PermIDs (validate before real ingest, like RICs/TR.* codes):**
IBM `4295904307`, Apple `4295905573`, Vodafone Group `4295896661`.

### Invariants to preserve (breaking these breaks the demo or the guard)

1. **Node 22 only.** `node:sqlite`; system node 18 / nvm default fail.
2. **Guard allow-list.** Any new column read by a query must be in
   `LSEG_ALLOWED_COLUMNS` / `LSEG_ALLOWED_TABLES` (`src/lseg.js`) or the query is
   refused. **No UNION** — the allow-list rejects a union's synthesised columns;
   use aggregate SELECTs / scalar subqueries. `COUNT(DISTINCT CASE …)` is fine.
3. **`fundamentals` keys on `org_permid`, never `ric`.** RIC is a lookup alias;
   resolve it with `resolveOrgPermid(ric, warehouse)` first. Tests that poke the
   DB directly must filter by `org_permid` (e.g. IBM = `4295904307`).
4. **`basis` scoping.** Standardized queries must filter `basis = 'standardized'`
   or as-reported rows double-count the field-keyed sums.
5. **Coverage + FX gates live in `controls.js reconciliation()`** via
   `requiredPresence` (→ N/A) and `consistencyKeys` (→ EXCEPTION). Any new
   reconciliation control should pass both.
6. **Seed stays raw/single-currency** (scale 0, USD, `reporting_state='reported'`)
   so existing value assertions hold; introduce divergence only deliberately and
   label it synthetic (see IBM.N FY2022 as-reported $500m reclass).
7. **Hand-sync `lseg.html`** root copy after editing `fintelligence/lseg.html`.
8. **Bitemporal reads pick one vintage.** Any query aggregating field-keyed sums
   over `fundamentals` must carry the `LATEST_VINTAGE_AS_OF` predicate (correlated
   `MAX(knowledge_date) <= ?` per org/field/period/basis) or a restated field is
   double-counted across vintages. Default `asOf` is the fixed sentinel
   `AS_OF_LATEST` (`9999-12-31`), never `today` — a result hash must not drift
   with the wall clock. New `fundamentals` rows must set `knowledge_date`.
9. **Pricing never goes in `fundamentals`.** A Pricing-category field is a time
   series in `prices` (keyed by `quote_permid`), landed via `ingestPrices` /
   `get_history` and read via `priceCloseSeries`. `ingestFundamentals` refuses a
   Pricing field and `ingestPrices` refuses a non-Pricing one — keep both guards.
   `quote_permid` is a synthetic `QUOTE-PENDING:<RIC>` placeholder; validate real
   ones before a live ingest. Any new query on `prices` needs its columns in
   `LSEG_ALLOWED_COLUMNS.prices` or the guard refuses it.
10. **No untagged persisted vendor data.** Every `source` that lands rows must have
    a `data_sources` policy row (usage class + TTL + redistribution); seed and
    ingest register it, and `retentionReport` / the `C1.1` control flag any gap.
    Retention staleness is measured on `retrieved_at` vs the source TTL; `retention`
    and the `C1.1` control default to *today*, so pin `--as-of` / `asOf` in tests.
    The tags encode policy, they don't grant a right — see `db/lseg-licensing.md`.

---

## Remaining backlog

### P6 — Bitemporal keys (#5)  · ✅ DONE 2026-09-26 (uncommitted)

Added `knowledge_date` (transaction time) to `fundamentals`, distinct from
`period` (valid time) and `retrieved_at` (when we landed it), plus a bitemporal
index. Restatements version (new row, `reporting_state='restated'`, later
`knowledge_date`) instead of overwriting. All three reads
(`fundamentalsSnapshot`, `reconcileGrossProfit`, `reconcileStandardizedVsAsReported`)
take an optional `asOf` (default sentinel `AS_OF_LATEST='9999-12-31'`) and inject
the `LATEST_VINTAGE_AS_OF` correlated subquery, so exactly one vintage per
(org,field,period,basis) is picked — no cross-vintage double-count, and an as-of
before any vintage → N/A. `guard.asOf` was **not** reused: it injects a bare
`knowledge_date <= v` cutoff at top level, which would return every vintage and
double-count; the correlated `MAX(…)` subquery does cutoff + dedup in one and is
guard-safe (no UNION). Seed adds IBM.N FY2021 original (known 2022-04-01) +
restated (known 2023-05-15); ingest stamps `knowledge_date`; CLI gains
`--as-of YYYY-MM-DD`. 5 new tests (155 total, green): as-of returns the right
vintage, no double-count, ties at each vintage, pre-vintage N/A, and
reproducibility + `verify()` intact across the restatement.

Deferred (didn't do, out of P6 scope): `period_end_date` / fiscal-year-end
calendarization — the `period` label already carries valid time, and faking
precise period-end dates per issuer (IBM Dec, Apple Sep, Vodafone Mar) would
overstate what's modelled. Note it if a future control needs true period-end dates.

### P7 — `lseg-data` operational realities (#6)  · ✅ DONE 2026-09-26 (uncommitted)

(a) **Entitlement-aware errors.** `scripts/lseg_fetch.py` classifies every failure
into `permission_denied` / `not_found` / `transport` / `bad_request` / `dependency`
(HTTP status + message heuristics; permission checked before not-found so a 403 on
an unentitled field isn't misread as "no such field") and returns `{error, kind}`;
`RealLsegSession` attaches `kind` to the thrown error.

(b) **Pricing at its own grain.** New `quote_permid` on `instruments` (the deferred
P4 quote key) + a `prices` table (one row per quote × trading day) retrieved via
`get_history`. `TR.PriceClose` removed from `fundamentals` (and from the seed /
ingest field lists). `ingestFundamentals` refuses a Pricing field; `ingestPrices`
(new) lands the series and refuses a non-Pricing field. `FakeLsegSession.getHistory`
+ `RealLsegSession.getHistory` mirror the data path. Read via `priceCloseSeries` /
`fintel lseg prices [RIC] [--from DATE] [--to DATE]`. Quote PermIDs are synthetic
`QUOTE-PENDING:<RIC>` placeholders — validate before a live run.

(c) **Batching / session lifecycle.** The bridge opens one session, chunks the
universe (`chunkSize`), and retries ONLY transport-classified errors with
exponential backoff (`maxRetries`/`backoff`); permission/not-found fail fast. All
three are tunable via the `RealLsegSession` constructor and passed in the request.

Tested (160 green): pricing lives outside `fundamentals` and reads by RIC→quote;
range + reproducibility; both ingest guards; the Python classifier/chunking were
spot-checked directly (`python3`), but the bridge is still only run against
`FakeLsegSession` — no live entitlement here, so confirm the `get_history` mapping
via lseg-mcp before a live pull. `TR.CompanyMarketCap` (also a daily series in
reality) left in `fundamentals` as a noted candidate for the same treatment.

### P8 — Licensing / redistribution sign-off (#7)  · ✅ DONE 2026-09-26 (uncommitted)

The warehouse persists vendor data, so each source's terms are now tagged once in
the **`data_sources`** table (`usage_class` display/non-display, `retention_days`
cache TTL, `redistribution`) — one policy row per source, not a constant repeated
per data row (that also closes the per-row-duplication cleanup). `src/lseg-retention.js`
reads it: **`retentionReport`** flags rows held past their TTL (on `retrieved_at`),
untagged sources, and TTL-less policies; **`purgeExpired`** deletes the stale rows
(dry-run option). The **`C1.1-lseg-data-retention`** control turns that into
PASS/EXCEPTION evidence, and ingest registers its source's policy so nothing lands
untagged. CLI: `fintel lseg retention [--as-of DATE] [--purge]` and `fintel lseg
license`. The pre-live-key **sign-off checklist** (display vs non-display, TTL,
redistribution, entitlement scope, identifier validity) is `db/lseg-licensing.md`.
6 new tests (165 total, green).

The one thing code cannot do: **sign the agreement.** The tags encode a policy and
enforce it (untagged/stale → EXCEPTION); they do not grant a right. The real usage
class, TTL and redistribution terms per dataset must be confirmed against the LSEG
contract and the tags updated to match before a live key — that is the actual
"sign-off," and `db/lseg-licensing.md` is where it gets recorded.

### Docs backlog — teach-from-zero root README (requested 2026-09-26)

Rewrite the GitHub root `README.md` to be *annoyingly informative* for a reader
who has never heard of LSEG. It currently sells the verify-or-refuse thesis but
mentions LSEG only in passing and teaches none of the vocabulary. It must:

- **Glossary, plain English.** LSEG (London Stock Exchange Group, formerly
  Refinitiv); **RIC** (Reuters Instrument Code — a *quote* id, instrument × venue,
  mutable); **Org PermID** vs **quote PermID** (permid.org — stable entity key vs
  stable quote key); **TR.\*** field codes (e.g. `TR.Revenue`); **COA** (Chart of
  Accounts, LSEG's standardized model); **SGRP/SREV/SCOR** (Gross Profit / Revenue
  / Cost of Revenue COA codes); **standardized vs as-reported** basis; the field
  parameters **Curn / Scale / Period / periodicity / ReportingState**; **get_data**
  (per-period fundamentals) vs **get_history** (time-series pricing); **bitemporal**
  (period = valid time vs `knowledge_date` = transaction time); **entitlement**.
- **How it works.** The vendor-data pipeline (field code → `lseg-data` → snapshot
  warehouse → guarded/grounded/hash-chained reads); the two reconciliations and
  what each *actually* proves (standardized integrity/tamper vs standardized-vs-
  as-reported data check); the FX guard, coverage→N/A, bitemporal as-of read, and
  pricing at its own grain.
- **Where the value is.** Verify-or-refuse over *vendor* market data for
  regulated/audit use; provenance down to the exact `TR.*` code; tamper-evident
  audit; reproducibility that survives a restatement.
- Keep the claim discipline explicit (real identifiers, synthetic values,
  labelled). Fix the stale test badge (now **160**). Consider an annotated CLI
  transcript as a worked example. (Tracked as task in the working session.)

### Cleanup (opportunistic, from the review's "Redundant/over-engineered")

- **Two sources of unit truth**: `lseg_fields.unit` vs the registry `unit` can
  drift — keep the dictionary authoritative.
- **Seeded-but-unused fields**: `OperatingIncome`, `NetIncomeAfterTaxes`,
  `TotalDebtOutstanding`, `TotalAssetsReported`, `CompanyMarketCap` are only
  lightly exercised — either add controls that use them (balance-sheet identity,
  leverage, margins) or trim. (`PriceClose` now lives in `prices` at its own grain,
  read by `priceCloseSeries`; `CompanyMarketCap` is a candidate to follow it.)
- **Per-row constant duplication**: `source`/`currency`/`scale`/`periodicity`/
  `reporting_state` are constant per batch in the seed — fine now; normalise if it
  grows.

---

## Pointers

- `LSEG-ARCHITECTURE-REVIEW.md` — master findings + backlog (P1–P8 all checked off).
- `fintelligence-core/db/lseg-anchor.md` — claim discipline, validated field/COA
  table, identifier model, the two reconciliations + FX guard.
- `fintelligence-core/mcp/README.md` — lseg-mcp workflow + credential path
  (`validate_lseg_formula` is authoritative; launch with `--with 'mcp<2'`).
- `HANDOFF.md` — whole-project state (M7 deploy is the big pending item).
