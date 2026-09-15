# Fin-Telligence — Handoff & Next Steps

_Last updated: 2026-09-15 · `main` @ `21a499c`_

**Thesis:** the model writes SQL, the database produces the numbers, every figure
is verified against the data before you see it, and every answer carries a
tamper-evident provenance chain. Financial answers you can audit.

---

## Status snapshot

- **Repo:** `justin-harvey/fin-telligence` (public). Clone: `/home/nah/Claudia/fin-telligence`.
- **Engine:** `fintelligence-core/` — **125 tests, all offline** (Node 22). Green.
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
| M6 | **MCP server** — tools + live schema resources over stdio (`fintel mcp`) | ✅ |
| M8 | **evidence packet** — control-result shape + offline-verifiable packet (intent→SQL→CSV→hash+sig) | ✅ core (UI "verify" tab pending) |
| M9 | **SOC 2 control catalog** (6 controls) + **evidence panel UX** at `/controls` | ✅ controls + UI; server-side role gating pending on M7 |
| M7 | **frontend↔deployed backend** — engine HTTP API + Supabase Edge Function proxy + panel wiring | 🟡 code done, **deploy pending** |

Full detail lives in **`BUILD-PLAN.md`** (untracked, repo root) — the durable spec.

## Environment quirks (read before running)

- **Node 22 required** (`node:sqlite`): `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` (22.23.2 installed). System node is v18 and will fail.
- **Model id** is `claude-opus-4-8` everywhere (`claude-opus-5` was a bug).
- **Pushing:** paste a GitHub PAT inline per session; use it inline in the push URL, don't persist. `git push https://<PAT>@github.com/justin-harvey/fin-telligence.git main`.
- **Netlify deploy config gotcha (already fixed, don't regress):** the repo is a *pre-built* static site (no `package.json`). `netlify.toml` must use a **no-op build command** (`echo …`) — a UI-set `npm run build` will otherwise override an empty command and fail — and `publish = "fintelligence"`. Asset paths are case-sensitive on Netlify.
- **The landing page is a compiled Vite/React bundle with NO source in the repo.** `/enron`, `/controls`, and Phineas are standalone HTML / runtime-injected. Rebuilding the frontend from source is its own task (see below).

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
The SPA is a compiled bundle. With source we could: link `/enron` and `/controls`
from the landing nav (they're reachable by URL only today), fold the panel in as a
real route, and make Phineas a component instead of a runtime injection.

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
