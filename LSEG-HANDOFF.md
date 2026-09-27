# LSEG hardening — handoff (continue from P7)

_Self-contained. Written 2026-09-26. Base release `ddb9bb9` on `main`; **P6 is
implemented in the working tree, 155 tests green, NOT yet committed** (repo
`justin-harvey/fin-telligence`, clone `/home/nah/Claudia/fin-telligence`)._

This picks up where `LSEG-ARCHITECTURE-REVIEW.md` (the master findings + backlog)
left off. **P1–P6 are done and tested** (P1–P5 shipped in `ddb9bb9`; P6 sits
uncommitted in the working tree — commit/push when ready). Remaining: **P7, P8**
plus a few cleanup items. Read the review for the full findings; this doc is the
"what's true now + do next" for a fresh session.

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

## What P1–P6 changed (so you don't re-derive it)

| # | What | Key surface |
|---|------|-------------|
| P1 | Absent field → `NULL` not `0`; presence `COUNT`s; reconciliations report **N/A** not a false PASS | `registry.js` (`fieldSum` dropped `ELSE 0`), `lseg.js`, `controls.js` (coverage gate) |
| P2 | `reconcileGrossProfit` collapsed to **one aggregate pass** (no UNION, guard-safe) | `lseg.js` |
| P3 | New **`basis`** dimension (`standardized`/`as_reported`) + `reconcileStandardizedVsAsReported` control that tests DATA; old identity control relabelled as pipeline-integrity/tamper; `/lseg` copy realigned to reconciliation + hash-chained audit (grounding removed from LSEG path); CLI `lseg basis` | `lseg-schema.sql`, `lseg.js`, `controls.js`, `bin/fintel.js`, `fintelligence/lseg.html` (+ root copy), `lseg-anchor.md` |
| P4 | **PermID identifier model**: new `organizations` table keyed by real Org PermID; `instruments.ric` demoted to a mutable alias (`org_permid` FK); `fundamentals` re-keyed `ric` → `org_permid`; reads resolve RIC→org via `resolveOrgPermid` | `lseg-schema.sql`, `lseg.js`, `lseg-ingest.js`, `bin/fintel.js` |
| P5 | **Field parameters** `scale`/`periodicity`/`reporting_state` on the grain; **FX guard**: reconciliations refuse (EXCEPTION) on mixed currency/scale/periodicity via `COUNT(DISTINCT …)` variant checks | `lseg-schema.sql`, `lseg.js`, `controls.js`, `lseg-ingest.js`, `bin/fintel.js` |
| P6 | **Bitemporal** `knowledge_date` (transaction time) on the grain; restatements version (new row, not overwrite); reads take `asOf` (default `9999-12-31`=latest) injecting a correlated `MAX(knowledge_date)<=asOf` subquery → exactly one vintage per (org,field,period,basis), no double-count, pre-vintage→N/A; CLI `--as-of`; `verify()` intact across a restatement. Seed adds IBM.N FY2021 original+restated | `lseg-schema.sql`, `lseg.js`, `lseg-ingest.js`, `bin/fintel.js`, `db/lseg-anchor.md`, `test/lseg.test.js` |

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

### P7 — `lseg-data` operational realities (#6)  · M effort · Med risk · **do next**

Only meaningful against a live entitlement, but the seam should be honest.
- **Entitlement-aware errors** in `scripts/lseg_fetch.py`: distinguish
  permission-denied vs not-found vs transport, rather than the current generic
  `get_data` catch.
- **Pricing is the wrong grain.** `TR.PriceClose` is a time series
  (`SDate/EDate/Frq`) via `get_history`, not a per-period fundamental. Move it to
  its own grain. **This is where the deferred quote/instrument PermID from P4
  lands** — pricing keys on the quote, not the org (add `quote_permid` to
  `instruments` then).
- **Batching / rate limits / session lifecycle.** Today one `get_data` for the
  whole universe×fields and a fresh Python session per ingest call. Real Workspace
  sessions are heavy and concurrency-limited: chunk the universe, add backoff, and
  hold a longer-lived session.

### P8 — Licensing / redistribution sign-off (#7)  · S (mostly non-code)

The design persists LSEG data to a snapshot warehouse. Before a live key: confirm
display vs non-display usage, caching TTLs, redistribution terms. Add usage
tagging + retention/TTL controls on the warehouse. Largely a policy/sign-off task.

### Cleanup (opportunistic, from the review's "Redundant/over-engineered")

- **Two sources of unit truth**: `lseg_fields.unit` vs the registry `unit` can
  drift — keep the dictionary authoritative.
- **Seeded-but-unused fields**: `OperatingIncome`, `NetIncomeAfterTaxes`,
  `TotalDebtOutstanding`, `TotalAssetsReported`, `PriceClose`, `CompanyMarketCap`
  are only lightly exercised — either add controls that use them (balance-sheet
  identity, leverage, margins) or trim.
- **Per-row constant duplication**: `source`/`currency`/`scale`/`periodicity`/
  `reporting_state` are constant per batch in the seed — fine now; normalise if it
  grows.

---

## Pointers

- `LSEG-ARCHITECTURE-REVIEW.md` — master findings + backlog (P1–P6 checked off).
- `fintelligence-core/db/lseg-anchor.md` — claim discipline, validated field/COA
  table, identifier model, the two reconciliations + FX guard.
- `fintelligence-core/mcp/README.md` — lseg-mcp workflow + credential path
  (`validate_lseg_formula` is authoritative; launch with `--with 'mcp<2'`).
- `HANDOFF.md` — whole-project state (M7 deploy is the big pending item).
