# Fin-Telligence — M7 deployment (proxy + engine)

The browser never touches the engine or the warehouse. It calls a Supabase Edge
Function (`functions/query`), which verifies the caller's role, gates which tool
that role may call, sanitises the arguments, and forwards to the engine's HTTP
API over a shared service token.

```
Browser (Netlify static site: /controls)
   │  POST { tool, args }   + Supabase JWT (optional; anon = "standard")
   ▼
Supabase Edge Function  functions/query          ← role gate + sanitise + CORS
   │  POST /tools/<name>   Authorization: Bearer <ENGINE_SERVICE_TOKEN>
   ▼
Engine HTTP API  (Node 22: `fintel serve`, on Render / Fly / Railway)
   │  callTool → guard → read-only warehouse → grounding → lineage → audit
   ▼
warehouses (SQLite on a persistent volume, or Supabase Postgres later)
```

## 1. Deploy the engine (Node 22 host)

Any host with Node 22 and a persistent disk works (Render, Fly.io, Railway, a
container). Build/run:

```bash
cd fintelligence-core
npm ci
node bin/fintel.js seed        # + markets seed, enron seed — build the warehouses
ENGINE_SERVICE_TOKEN=<long-random> PORT=8787 node bin/fintel.js serve
```

- `ENGINE_SERVICE_TOKEN` — required in production; every non-`/health` route
  demands `Authorization: Bearer <token>`.
- `ANTHROPIC_API_KEY` — only needed if you expose `execute_financial_query`
  (free-text). The control/canonical tools need no credential.
- `FINTEL_SIGNING_KEY` / `FINTEL_SIGNING_KEY_FILE` — optional Ed25519 key to sign
  attestations. Keep it off the client and out of the repo.
- The audit chain is an append-only JSONL file, so give the host a persistent
  volume (single instance for now; move the chain to Postgres before scaling out).

## 2. Deploy the proxy (Supabase Edge Function)

```bash
supabase functions deploy query
supabase secrets set \
  MCP_ENGINE_URL=https://<engine-host> \
  ENGINE_SERVICE_TOKEN=<same-long-random> \
  ALLOWED_ORIGIN=https://<your-netlify-site>
```

Leave the gateway's JWT verification on (`verify_jwt = true`, the default) so the
role claim the proxy reads is trustworthy. Anonymous callers are served the
`standard` tier (control templates + canonical reads); a JWT whose
`app_metadata.role` is `auditor` also unlocks `execute_financial_query`.

## 3. Point the site at the proxy

The `/controls` panel runs on embedded, real captured attestations until you give
it the proxy URL. Set it (e.g. in the page or an injected script):

```html
<script>window.FINTEL_PROXY_URL = "https://<project>.supabase.co/functions/v1/query";</script>
```

With that set, the panel's **Re-run live** buttons call the proxy and render the
live result — the payload shape is identical to the embedded data, so nothing
else in the UI changes.

## Trust boundary

- Secrets (`ENGINE_SERVICE_TOKEN`, `ANTHROPIC_API_KEY`, the signing key, warehouse
  credentials) live on the engine host and the proxy's secret store — never in
  the browser.
- The proxy sanitises arguments, so a caller cannot point a control at an
  arbitrary path; it only forwards the fields each tool legitimately takes.
- The engine's guard remains the trust boundary regardless of caller: read-only,
  allow-listed, bounded. The proxy adds authz and CORS; it does not widen what
  the engine will run.
