# LSEG warehouse anchor — real identifiers, synthetic values

The `lseg` warehouse (`lseg-schema.sql` / `lseg.js`) is the engine's fourth
warehouse. It holds company **fundamentals** of the kind an analyst retrieves
from LSEG (London Stock Exchange Group, formerly Refinitiv) by `TR.*` field code
through the `lseg-data` Python library. Fin-Telligence runs its guarded,
grounded, hash-chained pipeline over that snapshot so a reported figure can be
reconciled against the line items that compose it — with provenance down to the
exact LSEG field code each number came from.

## What is real, and what is synthetic

- **Real:** the instrument **RICs** (Reuters Instrument Codes — LSEG's primary
  instrument identifier, e.g. `IBM.N`, `AAPL.O`, `VOD.L`) and the **`TR.*` field
  codes** (`TR.Revenue`, `TR.CostOfRevenueTotal`, `TR.GrossProfit`, ...). These
  are real LSEG identifiers and must stay accurate.
- **Synthetic:** every **value** in `fundamentals`. No LSEG entitlement is
  bundled with this repo, so the datapoints are fabricated — authored so the
  accounting identities hold exactly (e.g. Gross Profit = Revenue − Cost of
  Revenue), which is what lets the reconciliation control PASS on clean data and
  raise an EXCEPTION the moment a value is tampered with.

> Claim discipline: real identifiers, fabricated values, fabrication labelled.
> Nothing here is a claim about any real company's actual reported results, and
> nothing here is investment advice. The point of the warehouse is to show
> verify-or-refuse + attestation over vendor-shaped market data; that only works
> if the labelling is exact.

## Field codes validated through lseg-mcp (2026-09-24)

All nine `TR.*` codes below were validated live against the open-source
[`lseg-mcp`](https://github.com/GreenGrassBlueOcean/lseg_mcp) server's
`validate_lseg_formula` tool (run against its COA/FCC mapping matrix). **Every one
returned `status: OK`** — the COA code each maps to is recorded in the field table
below. lseg-mcp is the tool whose entire job is getting these right:

- `validate_lseg_formula` — confirm a field exists and is valid for the
  instrument's industry (returns `OK`, `NOT_FOUND`, or an industry mismatch, with
  the COA/FCC mapping). **This is the authoritative check** and all nine passed.
- `search_data_dictionary` / `search_financial_mapping` — fuzzy-resolve a concept
  (e.g. "gross profit") to a `TR.*` field. Note the bundled dictionary's search
  seed is partial: some multi-word concepts ("cost of revenue", "total assets")
  return no fuzzy match even though `validate_lseg_formula` confirms the code — so
  validate is the source of truth, not the fuzzy search.
- `draft_api_call` — emit the runnable `lseg-data` call to execute against a live
  LSEG Workspace session.

Industry scope caveat surfaced by validation: `TR.GrossProfit` (COA `SGRP`) is
available for Industrial issuers, **not** Bank/Insurance/Utility — so the
gross-profit identity control only applies to industrials (the seeded RICs are).

Re-validate whenever fields change: `node /tmp/lseg_probe.mjs validate` (see the
harness in `mcp/README.md`), or wire lseg-mcp into your client per
`mcp/clients.example.json`. `src/lseg-ingest.js` re-checks every code against the
warehouse dictionary at ingest time too, refusing unknowns with a pointer here.

## The identity the reconciliation control is built around

For each (instrument, period) the warehouse holds Revenue, Cost of Revenue, and
Gross Profit as separate LSEG fields. The control asserts the reporting identity

> **Gross Profit = Revenue − Cost of Revenue** (`TR.GrossProfit` =
> `TR.Revenue` − `TR.CostOfRevenueTotal`)

computing the left side from the component fields and comparing it to the
reported `TR.GrossProfit`. PASS when they tie; EXCEPTION with the exact variance
when a value was altered after the fact — and because every attestation is
hash-chained, that alteration cannot hide.

## Fields held (all real LSEG `TR.*` codes; validated OK via lseg-mcp 2026-09-24)

| Field code | Concept | Statement / Category | COA | Unit |
|---|---|---|---|---|
| `TR.Revenue` | Revenue | Income Statement | `SREV` | usd |
| `TR.CostOfRevenueTotal` | Cost of Revenue, Total | Income Statement | `SCOR` | usd |
| `TR.GrossProfit` | Gross Profit | Income Statement | `SGRP` | usd |
| `TR.OperatingIncome` | Operating Income | Income Statement | `SOPI` | usd |
| `TR.NetIncomeAfterTaxes` | Net Income After Taxes | Income Statement | `TIAT` | usd |
| `TR.TotalDebtOutstanding` | Total Debt | Balance Sheet | `STLD` | usd |
| `TR.TotalAssetsReported` | Total Assets, Reported | Balance Sheet | `ATOT` | usd |
| `TR.PriceClose` | Closing price (daily) | Pricing (extended dict) | — | usd_cents |
| `TR.CompanyMarketCap` | Market capitalisation | Reference (extended dict) | — | usd |

Instruments in the seed: `IBM.N` (International Business Machines, NYSE),
`AAPL.O` (Apple, Nasdaq), `VOD.L` (Vodafone Group, LSE). Reporting period
`FY2023` (with `FY2022` held for IBM.N to exercise multi-period ingest). All
values synthetic and internally consistent.
