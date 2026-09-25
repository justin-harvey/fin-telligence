# Fin-Telligence — Handoff & Next Steps

_Last updated: 2026-09-23 · `main` @ `abeda13`_

**Thesis:** the model writes SQL, the database produces the numbers, every figure
is verified against the data before you see it, and every answer carries a
tamper-evident provenance chain. Financial answers you can audit.

---

## Status snapshot

- **Repo:** `justin-harvey/fin-telligence` (public). Clone: `/home/nah/Claudia/fin-telligence`.
- **Engine:** `fintelligence-core/` — **136 tests, all offline** (Node 22). Green.
- **Live site:** [fin-telligence.netlify.app](https://fin-telligence.netlify.app/)
  (landing SPA), plus `/enron` (reporting-gap case study) and `/controls` (SOC 2
  evidence panel). Phineas the dolphin mascot on the landing page.
- **Backend (M7):** code is written and tested end-to-end locally, **but not
  deployed** — that's the top next step and needs your infra accounts.

## What's done (milestones)

| | Milestone | State |
|---|---|---|
| M0–M5 | engine: guard, grounding, lineage, signed hash-chained audit, warehouse connector, auth/RLS hook, metric registry, SaaS + capital-markets warehouses | ✅ |
| — | synthetic **Enron** reporting-gap warehouse (real 10-K anchors, synthetic rows) | ✅ |
| — | **LSEG** fundamentals warehouse + `lseg-mcp` integration (real RICs/`TR.*` codes — all 9 validated OK live via lseg-mcp 2026-09-24; synthetic values; `RealLsegSession` + `LSEG_APP_KEY` Python bridge = credential-swap to real data) | ✅ |
| M6 | **MCP server** — tools + live schema resources over stdio (`fintel mcp`) | ✅ |
| M8 | **evidence packet** — control-result shape + offline-verifiable packet (intent→SQL→CSV→hash+sig) | ✅ core (UI "verify" tab pending) |
| M9 | **SOC 2 control catalog** (6 controls) + **evidence panel UX** at `/controls` | ✅ controls + UI; server-side role gating pending on M7 |
| M7 | **frontend↔deployed backend** — engine HTTP API + Supabase Edge Function proxy + panel wiring | 🟡 code done, **deploy pending** |

Full detail lives in **`BUILD-PLAN.md`** (untracked, repo root) — the durable spec.

## Environment quirks (read before running)

- **Node 22 required** (`node:sqlite`): `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` (22.23.2 installed). System node is v18 and will fail.
- **Model id** is `claude-opus-4-8` everywhere (`claude-opus-5` was a bug).
- **Pushing:** paste a GitHub PAT inline per session; use it inline in the push URL, don't persist. `git push https://<PAT>@github.com/justin-harvey/fin-telligence.git main`. **`main` takes out-of-band edits via the GitHub web UI** (e.g. `README.md`), so `git fetch` + rebase before pushing — a straight push can be rejected as non-fast-forward.
- **Netlify deploy config gotcha (already fixed, don't regress):** the repo is a *pre-built* static site (no `package.json`). `netlify.toml` must use a **no-op build command** (`echo …`) — a UI-set `npm run build` will otherwise override an empty command and fail — and `publish = "fintelligence"`. Asset paths are case-sensitive on Netlify.
- **The landing page is a compiled Vite/React bundle with NO source in the repo.** `/enron`, `/controls`, and Phineas are standalone HTML / runtime-injected. Rebuilding the frontend from source is its own task (see below).
- **⚠️ The bundle now carries hand-applied edits that exist in NO source** (`fintelligence/assets/index-diyp9xdl.js`, done via surgical string replacement): the **header nav links** to `/enron` and `/controls`; a **neutralized FT badge** (its `onClick` was removed, so the old "Market Impact" modal is now dead/unreachable code); and **all WisdomAI / "PM application" references stripped** from the "About this prototype" modal. A rebuild from source will silently revert every one of these — replicate them in source or diff against this bundle before shipping. `node --check` the bundle after any hand-edit.
- **Phineas's spoken content lives in HTML, not the bundle, in three separate copies.** The mascot's `LINES` array (Market-Impact pitch + CPA/audit-market talking points) is in `fintelligence/index.html`; **independent copies of the Phin script** are in `fintelligence/enron.html` and `fintelligence/lseg.html`. Change "what Phin says" in each, as applicable.
- **Standalone demo pages** (each its own HTML, clean-URL via `_redirects`, cross-linked in the header): `/enron`, `/lseg`, `/controls`. `/lseg` is the LSEG fundamentals page (built from the enron template). Header nav links to all three now live in the compiled bundle + Phineas-adjacent links on the landing page.
- **Root-level `enron.html` and `index-diyp9xdl.js` are duplicates of the `fintelligence/` publish-dir copies and are synced by hand.** Only `fintelligence/` deploys (root `netlify.toml` `publish = "fintelligence"`). Edit the `fintelligence/` copy, then `cp` to root so they don't drift. Root `index.html` is a stub, not the deployed page.

## Verify / resume quickly

```bash
cd /home/nah/Claudia/fin-telligence/fintelligence-core
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
npm test                                            # 125, offline
node bin/fintel.js enron seed && node bin/fintel.js controls list
node bin/fintel.js controls run PI1.2-enron-debt-reconciliation --export /tmp/packet.json
node bin/fintel.js serve                             # HTTP API (set ENGINE_SERVICE_TOKEN)
node bin/fintel.js mcp                               # stdio MCP server
```

---

## NEXT STEPS (in priority order)

### 1. Deploy M7 — make the SOC 2 panel live  ← the big one
Everything is written; this is provisioning. Full guide in **`supabase/README.md`**.
- **Host the engine** (Node 22 + persistent disk — Render / Fly.io / Railway):
  `npm ci`, seed warehouses, `ENGINE_SERVICE_TOKEN=<rand> fintel serve`.
  _Decision needed:_ pick a host. Recommendation: **Fly.io** (cheap persistent
  volume) or **Render** (simplest). The audit chain is an append-only JSONL file,
  so it needs a persistent volume (single instance for now).
- **Deploy the proxy:** `supabase functions deploy query`, then
  `supabase secrets set MCP_ENGINE_URL=… ENGINE_SERVICE_TOKEN=… ALLOWED_ORIGIN=https://fin-telligence.netlify.app`.
- **Point the site at it:** set `window.FINTEL_PROXY_URL` to the function URL. The
  panel's "Re-run live" then calls the proxy; payload shape is identical to the
  embedded data, so no UI change.
- **`/lseg` "Connect live data" panel:** the LSEG page has a browser-side panel
  (engine URL + LSEG app key, stored in `localStorage`, exposed as
  `window.FINTEL_LSEG = { engineUrl, appKey }`) that currently only probes the
  engine URL for reachability and shows status. When the engine is deployed, wire
  its "Connect" to actually drive a live `lseg reconcile` via the engine/proxy —
  the credential stays server-side (env `LSEG_APP_KEY`); the panel key is a
  convenience for a self-hosted engine, not a substitute for the server env var.

### 2. Warehouse → Supabase Postgres + RLS (security fast-follow)
Turns the M5 principal-scope hook into DB-enforced row-level security. Requires:
a `PostgresWarehouse` adapter (the `warehouse.js` seam already defines the shape);
**parameterizing the guard's hardcoded `database: 'sqlite'`** (`guard.js:185,327`);
and relocating the audit chain to an append-only Postgres table (or keep JSONL on
the volume until scaling past one engine instance).

### 3. Finish M9 role gating end-to-end
Proxy already reads `app_metadata.role` from the Supabase JWT (anon→standard,
`auditor` unlocks `execute_financial_query`). Remaining: actually issue the
auditor role via Supabase Auth, and note `execute_financial_query` is **SaaS-only
today** (the planner is SaaS-specific) — multi-warehouse free-text needs the
planner parameterized (ties into #6).

### 4. M8 UI "verify" tab
Surface `verifyPacket` in the panel: paste a hash / drop a packet → INTACT or the
first broken entry. The engine side (`evidence.js` `verifyPacket`, the
`CC7.2-audit-chain-integrity` control) already exists.

### 5. More controls (optional)
Catalog has 6 (reconciliation ×4, reproducibility, audit-integrity). The
reconciliation helper makes new ones cheap. Note: **UNION trips the guard's column
allow-list — use scalar subqueries** for reconciliations.

### 6. Warehouse router (backlog)
Deterministic front-of-pipeline warehouse inference for free-text (score the
question against each registry's vocabulary; `warehouses.js` descriptors already
seed this). Untrusted convenience — the guard stays the boundary. Natural consumer
of M6's exposed schema resources.

### 7. Rebuild the landing frontend from source (bigger)
The SPA is a compiled bundle. With source we could: fold the panel in as a real
route, and make Phineas a component instead of a runtime injection.
**Before starting, inventory the hand-edits already baked into the current bundle
+ injected HTML** (see "Environment quirks") so the rebuild doesn't regress them:
the header nav to `/enron` and `/controls` (these are now live in the bundle, not
URL-only anymore), the removed Market-Impact modal / neutralized FT badge, the
de-WisdomAI'd About modal, and Phineas's `LINES` (Market-Impact pitch + CPA /
audit-market talking points, currently in `index.html` and duplicated in
`enron.html`). Diff the rebuilt output against `abeda13` before shipping.

### Also parked
PDF evidence packets server-side (currently Markdown/HTML → browser print, to keep
a heavy dep out of the core); TLaaS external anchoring adapter (interface + local
stub exist); the mascot text-match selector depends on the "About this prototype"
wording (update if the SPA copy changes).

---

## Open decisions to make
1. **Engine host** — Fly.io vs. Render vs. Railway.
2. **Warehouse timing** — ship M7 on SQLite-on-a-volume first (fastest), or do the
   Postgres+RLS upgrade up front? Recommendation: SQLite first, Postgres as #2.

## Pointers
- `BUILD-PLAN.md` — full milestone spec + the SOC 2 button catalog + uncovered-features backlog.
- `supabase/README.md` — the M7 deploy runbook.
- `fintelligence-core/README.md` — engine architecture, the four guarantees, layout.
- `db/enron-anchor.md` — the real Enron 10-K figures + citation (claim discipline).
- `db/lseg-anchor.md` — LSEG warehouse: real RICs/`TR.*` codes, synthetic values, validate-via-lseg-mcp discipline.
- `mcp/README.md` — wiring `lseg-mcp` + Fin-Telligence; the resolve→validate→draft→ingest→attest workflow. `src/lseg-ingest.js` is the license-gated seam (`FakeLsegSession` now, `RealLsegSession` = credential swap).
