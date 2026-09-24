# Fin-Telligence + lseg-mcp

Wiring the open-source [`lseg-mcp`](https://github.com/GreenGrassBlueOcean/lseg_mcp)
server together with Fin-Telligence's own MCP server so a single agent can go from
*"what's the right LSEG field for gross profit?"* all the way to *"here is that
figure, verified against its components and cryptographically attested."*

## The division of labour

The two servers do different jobs, and that is the whole point of pairing them:

| | `lseg-mcp` | Fin-Telligence (`fintel mcp`) |
|---|---|---|
| **Role** | Resolve LSEG `TR.*` field codes and **draft** the retrieval code | **Verify** and **attest** figures over a read-only warehouse |
| **Returns** | Field mappings, validations, runnable `lseg-data` / R boilerplate | Grounded results, PASS/EXCEPTION controls, hash-chained evidence |
| **Touches market data?** | No — *"never connects to LSEG, only resolves fields and drafts code"* | No — reads the warehouse the data was landed into |
| **Needs an LSEG entitlement?** | No | No (a paid entitlement is only needed to *execute* the drafted call) |

`lseg-mcp` gets the field mapping right; Fin-Telligence makes the resulting number
auditable. The join point is **ingestion** (see `src/lseg-ingest.js`), not runtime.

## Prerequisites

- **Node ≥ 22** (Fin-Telligence core; `node:sqlite`).
- **`uv` / `uvx`** for lseg-mcp: `curl -LsSf https://astral.sh/uv/install.sh | sh`
  (Python 3.11+; lseg-mcp's first launch takes 1–3 min to build its indexes).
- **Only to execute drafted calls against real data:** an LSEG Workspace/Eikon
  session, the `lseg-data` Python package, and a valid LSEG entitlement. None of
  this is required to run the demo, which uses synthetic data.

## Install into an MCP client

Copy the `mcpServers` block from [`clients.example.json`](./clients.example.json)
into your client config (Claude Desktop, Claude Code, Cursor, VS Code). Set the
`fin-telligence` server's `cwd` to your `fintelligence-core` checkout.

## The end-to-end workflow

1. **Resolve** the field. Ask the agent for the concept; it calls lseg-mcp's
   `search_data_dictionary` / `search_financial_mapping` to get the correct
   modern `TR.*` code (e.g. gross profit → `TR.GrossProfit`).
2. **Validate** it. lseg-mcp's `validate_lseg_formula` confirms the field exists
   and fits the instrument's industry (`NOT_FOUND` vs `INDUSTRY_MISMATCH`).
3. **Draft** the call. lseg-mcp's `draft_api_call` emits runnable `lseg-data`
   Python for the universe + fields.
4. **Execute + land** (the entitlement step). Run the drafted call against a live
   LSEG Workspace session and land the result through the ingest seam:
   - **With an entitlement:** implement `RealLsegSession.getData` in
     `src/lseg-ingest.js` (it currently throws with instructions), then
     `ingestFundamentals({ session: new RealLsegSession(...), universe, fields })`.
   - **Without one (demo):** `node bin/fintel.js lseg ingest IBM.N --period FY2024`
     uses the deterministic `FakeLsegSession`. Same code path, synthetic data.
5. **Verify + attest.** Fin-Telligence runs over the landed snapshot:
   - `node bin/fintel.js lseg reconcile IBM.N FY2024` — asserts Gross Profit =
     Revenue − Cost of Revenue and hash-chains the result.
   - or via MCP: `run_control PI1.1-lseg-gross-profit-reconciliation`.

Field codes are validated against the warehouse dictionary (`lseg_fields`) at
ingest time too — an unknown code is refused with a pointer back to lseg-mcp, so
the "real identifiers" half of the claim discipline holds at the boundary.

## Claim discipline

The RICs and `TR.*` field codes are real LSEG identifiers; the seeded values are
synthetic and labelled synthetic (see `db/lseg-anchor.md`). Swapping in a real
`RealLsegSession` is the only change needed to attest genuine LSEG data — the
guard, grounding, and audit chain do not change.
