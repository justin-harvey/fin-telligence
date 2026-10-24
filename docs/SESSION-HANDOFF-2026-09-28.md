# Session handoff, 2026-09-28 (LSEG public demo synced + gated, deployed live)

_Self-contained summary of this session's work. `main` @ `a1e05df`, repo
`justin-harvey/fin-telligence`, clone `/home/nah/Claudia/fin-telligence`. 165 core
tests, all offline, green. Node 22 required. Deployed live to
fin-telligence.netlify.app (`main` → Netlify)._

Picks up from `SESSION-HANDOFF-2026-09-26.md` (P1–P8 complete). That session's
observations/gaps list flagged several loose ends; this session closed the top four
(retention demo-ergonomics, the controls panel, the /lseg page, the core README) and
split the LSEG surface into a **synthetic public track** and a **credential-gated live
track**. Driver: an upcoming interview where a real LSEG key will not be available
beforehand, so the public demo must be useful and honest out of the box, with a live
path that flips on the moment a key exists. Then deployed to production.

## How to resume / verify

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
cd fintelligence-core
node --test                         # 165 tests, offline, green
node bin/fintel.js lseg seed
node bin/fintel.js lseg retention   # PASS now (retrieved_at defaults to the seed date)
node bin/fintel.js lseg reconcile IBM.N FY2021 --as-of 2022-06-01   # bitemporal, $27.35b
```

- **Node 22 only** (`node:sqlite`).
- **Pushing:** paste a GitHub PAT inline per push, used in the URL only, never
  persisted; `main` is the deploy branch (→ Netlify). `BUILD-PLAN.md` and `Phineas/`
  stay untracked (do not `git add -A`).
- **Site copies are hand-synced:** edit `fintelligence/<page>.html`, then
  `cp fintelligence/<page>.html <page>.html` (repo-root duplicate). Both stay
  byte-identical; a `diff` guard is worth running before commit.

## Completed this session

| Item | Where | Summary |
|---|---|---|
| **Gap #1 fix (retention demo)** | `src/lseg.js`, `test/lseg-retention.test.js` | `seedLseg(path, { retrievedAt = <today> })` stamps `retrieved_at` with the seed date, split from the fixed `knowledge_date` (`SNAPSHOT_KNOWLEDGE_DATE = '2024-03-31'`, which still drives bitemporal as-of reads). C1.1 retention now PASSES at today's date, and a live re-run would be green too. The retention test pins `retrievedAt:'2024-03-31'` so its `WITHIN_TTL`/`PAST_TTL` constants stay deterministic. |
| **Controls panel (gap #2)** | `controls.html` (+ `fintelligence/` copy) | The panel was missing all three LSEG controls, not just C1.1. Added `PI1.1-lseg-gross-profit-reconciliation`, `PI1.1-lseg-standardized-vs-as-reported`, and `C1.1-lseg-data-retention` as real captured attestations (figures, exact SQL, result hashes). `fmt()` now renders `usd` and `rows` units (this also fixes the "Re-run live" path). Generalized the no-export note so it fits the policy check. 9 controls total; DATA array validated to parse. |
| **/lseg page (gap #3)** | `fintelligence/lseg.html` (+ root copy) | Hero kicker reframed to "Synthetic demo · real TR.* codes · verified & attested". Three new sections with real captured numbers: bitemporal as-of (FY2021 $27.35b original vs $27.70b restated), prices at their own grain (IBM.N 160.50 / 162.10 / 163.55), and licensing & retention governance. The "Connect live data" panel became **"Live mode: gated behind a credential"**: synthetic by default, "Go live" activates only with a key + engine URL (chosen over remove / keep-as-is). |
| **Core README (gap #4)** | `fintelligence-core/README.md` | LSEG CLI section now documents the full surface: `basis`, `prices`, `retention`, `license`, `--as-of`, and `--live` / `--app-key`. |
| **Go-live runbook** | `LSEG-GO-LIVE.md` (new, repo root) | Exact steps to run the real credentialed session under NDA: install `lseg-data`, confirm `get_data`/`get_history` shapes via lseg-mcp, validate quote PermIDs (pricing only), licensing sign-off, `--live` ingest. Roughly an hour with a valid entitled key. |
| **Deployed** | `main` → Netlify | Committed `a1e05df`, fast-forwarded and pushed to `main`, verified live: `/lseg` and `/controls` serve the new content. |

## Two-track model (why the demo looks the way it does)

- **Public / synthetic track:** real RICs and `TR.*` codes, authored values, wired
  only to the project's own MCP + engine, never a live vendor. Works out of the box
  with zero setup; safe to circulate. This is the interview deliverable.
- **Private / live track:** `RealLsegSession` → `scripts/lseg_fetch.py` → `lseg-data`,
  credential-gated. Code-complete, never run live. `LSEG-GO-LIVE.md` is the path. For a
  peer to pull LIVE data they need **both** an entitled key **and** the engine backend
  deployed (M7, still pending), so a circulated link shows the synthetic demo only.

## Observations & gaps (still open)

Gaps #1–#4 from 2026-09-26 are done. Remaining, roughly high-to-low impact:

1. **The Python bridge has never run against a live LSEG session** (was #5). All tests
   use `FakeLsegSession`; `lseg-data` is not installed here. Confirm the
   `get_data`/`get_history` call shapes via lseg-mcp `draft_api_call` before a live
   pull. `LSEG-GO-LIVE.md` walks this.
2. **Quote PermIDs are synthetic placeholders** (`QUOTE-PENDING:<RIC>`, was #6). Needed
   only for live *pricing*; fundamentals use the validated Org PermIDs. Replace before a
   live price pull.
3. **`TR.CompanyMarketCap` is still a per-period fundamental** (was #7); it is really a
   daily series like `TR.PriceClose`, so it is the next pricing-grain candidate.
4. **`period_end_date` / fiscal-year-end calendarization deferred** (was #8). Add only
   when a control needs true period-end alignment.
5. **Opportunistic cleanup** (was #9): two sources of unit truth (`lseg_fields.unit` vs
   the registry `unit`); a few seeded-but-lightly-exercised fields.
6. **M7 whole-project deploy** (was #10). The engine HTTP API (`src/http-server.js`) and
   the Supabase proxy (`supabase/functions/query/`) are code-done but not deployed.
   Required for the gated "Go live" panel (and the controls "Re-run live" button) to
   actually reach a backend. See `HANDOFF.md`.
7. **Rotate the GitHub PAT** (was #11): a token was pasted inline for pushes again this
   session.

## Pointers

- `LSEG-GO-LIVE.md` — real credentialed-session runbook (new this session).
- `LSEG-ARCHITECTURE-REVIEW.md` — master findings + P1–P8 backlog (all done).
- `LSEG-HANDOFF.md` — LSEG "what's true now" (note: predates this session's gap #1 fix
  and the gated panel, so read it alongside this doc).
- `HANDOFF.md` — whole-project state (M7 deploy).
- Local memory `fin-telligence-lseg-demo-tracks.md` — the two-track direction + interview
  context.
