# Session handoff — 2026-09-26 (LSEG hardening backlog complete)

_Self-contained summary of this session's work. `main` @ `db726ff`, repo
`justin-harvey/fin-telligence`, clone `/home/nah/Claudia/fin-telligence`. 165 core
tests, all offline, green. Node 22 required._

This session took the LSEG hardening backlog from **P5-done** to **fully complete
(P1–P8)**, plus two site/docs changes. For the deep per-finding detail read
`LSEG-ARCHITECTURE-REVIEW.md` (master findings, all checked off) and
`LSEG-HANDOFF.md` (LSEG-specific "what's true now"). This doc is the session-level
"what got done + what I noticed" for whoever picks up next.

## How to resume / verify

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use --delete-prefix v22.23.2
cd fintelligence-core
node --test                    # 165 tests, all offline, green
node bin/fintel.js lseg        # prints the full lseg subcommand list
```

- **Node 22 only** (`node:sqlite`); system node 18 / nvm default fail.
- **Pushing:** paste a GitHub PAT inline per push, use it in the URL, don't persist.
  `main` is the deploy branch; `git ls-remote … main` before pushing to catch
  out-of-band web edits. (Every push this session was a clean fast-forward.)
- **`BUILD-PLAN.md` and `Phineas/` are intentionally untracked — do not `git add -A`
  them** (use explicit paths, or `git restore --staged` if they sneak in).

## Completed this session

| Item | Commit | Summary |
|---|---|---|
| **P6 — Bitemporal keys** | `faaf60e` | `knowledge_date` (transaction time) distinct from `period` (valid time); restatements version (new row, not overwrite); reads take `asOf` (default sentinel `9999-12-31`) with a correlated `MAX(knowledge_date)<=asOf` subquery → exactly one vintage per (org,field,period,basis); pre-vintage → N/A; `verify()` intact across a restatement. CLI `--as-of`. |
| **Favicon** | `2d43b9b` | Phineas dolphin favicon across all pages (deployed `fintelligence/` tree + root duplicate); phineas assets copied into the root tree. |
| **P7 — `lseg-data` ops** | `eb653e6` | (a) Bridge classifies failures → `{error, kind}` (permission/not_found/transport/bad_request/dependency), surfaced on `RealLsegSession`. (b) Pricing at its own grain: `quote_permid` + `prices` table via `get_history`; `TR.PriceClose` out of `fundamentals`; ingest guards both ways; `priceCloseSeries` / `fintel lseg prices`. (c) One session + universe chunking + transport backoff. |
| **README** | `3df18d3` | Root README rewritten to teach LSEG from zero: acronym glossary, how the pipeline works, what each reconciliation proves, where the value is, annotated CLI transcript. Test badge → 165. |
| **P8 — Licensing / retention** | `db726ff` | `data_sources` table tags each source once (usage class / TTL / redistribution); `lseg-retention.js` report + purge; `C1.1-lseg-data-retention` control; ingest registers policy; CLI `retention` / `license`; sign-off checklist `db/lseg-licensing.md`. |

**Release tags (rollback anchors):** `v0.7.0-lseg-p7` (P1–P7) and `v0.8.0-lseg-p8`
(backlog complete). Roll back with `git reset --hard <tag>` (coordinate — deploy branch).

**The full P1–P8 backlog is done. No open LSEG findings.**

## Observations & gaps (what I noticed but did NOT do)

These are honest loose ends, roughly high-to-low impact. None block the demo; several would bite a real deployment.

1. **The retention control flags the synthetic seed as stale at today's date.**
   The seed stamps `retrieved_at = 2024-03-31` with a 90-day TTL, so
   `fintel lseg retention` / the `C1.1` control run *now* report all 59 rows past
   TTL → **EXCEPTION**. Correct behaviour, but it means the control looks like it's
   failing on the demo. Fix options: stamp the seed's `retrieved_at` to a dynamic
   recent date (e.g. today), give the synthetic source a very long/`NULL` TTL, or
   document that the demo should pass `--as-of 2024-04-15`. Tests pin `asOf`, so the
   suite is unaffected — this is a demo-ergonomics gap, not a test gap.

2. **The static controls panel (`fintelligence/controls.html`) does not list the
   new `C1.1-lseg-data-retention` control** (grep: 0 hits). The engine has it; the
   deployed SOC 2 panel doesn't surface it. Same likely true for anything added
   since the panel was authored. Wire the panel to the live control catalog, or add
   the button.

3. **The `/lseg` marketing page lags the engine.** It predates P6–P8, so it does
   not explain bitemporal as-of reads, pricing-at-its-own-grain, or the
   retention/licensing governance. The rewritten *root* README covers all of it;
   the site page should catch up (and the M7 "Connect live data" panel is still
   just a reachability probe — see `LSEG-HANDOFF.md` gotchas).

4. **`fintelligence-core/README.md` is stale on LSEG CLI surface** — it does not
   document `lseg basis` / `lseg prices` / `lseg retention` / `lseg license` / the
   `--as-of` flag (grep: 0 hits). The root README is current; the core README's
   LSEG section needs the same update.

5. **The Python bridge has never run against a live LSEG session.** All tests use
   `FakeLsegSession`; `lseg-data` isn't installed here. The `get_data`/`get_history`
   call shapes, the DataFrame→rows mapping (especially the history-mode index
   reset), and the error-`kind` heuristics are correct-by-construction and
   spot-checked with `python3`, but **must be confirmed via lseg-mcp
   (`draft_api_call`) before a live pull.**

6. **Quote PermIDs are synthetic placeholders** (`QUOTE-PENDING:<RIC>`). Org
   PermIDs, RICs, and `TR.*` codes are real/validated; the quote-level IDs are not.
   Replace with real, validated quote/instrument PermIDs before landing live pricing.

7. **`TR.CompanyMarketCap` is still a per-period fundamental** but is really a daily
   series (like `TR.PriceClose`). Left in `fundamentals` deliberately to bound P7;
   it's the obvious next candidate for the pricing-grain treatment.

8. **`period_end_date` / fiscal-year-end calendarization was deferred in P6.** The
   `period` label carries valid time, but there's no concrete period-end date per
   issuer (IBM Dec, Apple Sep, Vodafone Mar). Add it only when a control needs true
   period-end alignment — faking precise dates would overstate what's modelled.

9. **Opportunistic cleanup** (from the review, still open): two sources of unit
   truth (`lseg_fields.unit` vs the registry `unit` can drift); several seeded-but-
   lightly-exercised fields (`OperatingIncome`, `NetIncomeAfterTaxes`,
   `TotalDebtOutstanding`, `TotalAssetsReported`) that could earn their keep with a
   balance-sheet / leverage / margin control, or be trimmed.

10. **Whole-project M7 deploy is still the big pending item** (see `HANDOFF.md`) —
    separate scope from this LSEG review.

11. **Security hygiene:** the GitHub PAT used for these pushes was pasted into the
    chat several times. Rotate it (github.com/settings/tokens); GitHub does not
    auto-revoke a token merely typed into a chat.

## Pointers

- `LSEG-ARCHITECTURE-REVIEW.md` — master findings + backlog (P1–P8 all checked off).
- `LSEG-HANDOFF.md` — LSEG-specific "what's true now", invariants, gotchas.
- `fintelligence-core/db/lseg-anchor.md` — claim discipline + the model in prose.
- `fintelligence-core/db/lseg-licensing.md` — the pre-live-key sign-off checklist.
- `HANDOFF.md` — whole-project state (M7 deploy).
