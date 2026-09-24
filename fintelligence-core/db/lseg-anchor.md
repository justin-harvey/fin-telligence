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

## Field codes must be validated through lseg-mcp

The `TR.*` codes in `lseg_fields` follow LSEG's published field-naming
conventions and are used here illustratively. **Before any real ingest, resolve
and validate each code** with the open-source
[`lseg-mcp`](https://github.com/GreenGrassBlueOcean/lseg_mcp) server, whose entire
job is getting these right:

- `search_data_dictionary` / `search_financial_mapping` — resolve a concept
  (e.g. "gross profit") to the correct modern `TR.*` field.
- `validate_lseg_formula` — confirm a drafted field exists and is valid for the
  instrument's industry (`NOT_FOUND` vs `INDUSTRY_MISMATCH`).
- `draft_api_call` — emit the runnable `lseg-data` call to execute against a live
  LSEG Workspace session.

See `mcp/README.md` for wiring lseg-mcp into an MCP client, and
`src/lseg-ingest.js` for the seam that lands the drafted call's results here.

## The identity the reconciliation control is built around

For each (instrument, period) the warehouse holds Revenue, Cost of Revenue, and
Gross Profit as separate LSEG fields. The control asserts the reporting identity

> **Gross Profit = Revenue − Cost of Revenue** (`TR.GrossProfit` =
> `TR.Revenue` − `TR.CostOfRevenueTotal`)

computing the left side from the component fields and comparing it to the
reported `TR.GrossProfit`. PASS when they tie; EXCEPTION with the exact variance
when a value was altered after the fact — and because every attestation is
hash-chained, that alteration cannot hide.

## Fields held (all real LSEG `TR.*` codes; validate before ingest)

| Field code | Concept | Category | Unit |
|---|---|---|---|
| `TR.Revenue` | Revenue | Fundamentals | usd |
| `TR.CostOfRevenueTotal` | Cost of Revenue, Total | Fundamentals | usd |
| `TR.GrossProfit` | Gross Profit | Fundamentals | usd |
| `TR.OperatingIncome` | Operating Income | Fundamentals | usd |
| `TR.NetIncomeAfterTaxes` | Net Income After Taxes | Fundamentals | usd |
| `TR.TotalDebtOutstanding` | Total Debt Outstanding | Fundamentals | usd |
| `TR.TotalAssetsReported` | Total Assets, Reported | Fundamentals | usd |
| `TR.PriceClose` | Price Close | Pricing | usd_cents |
| `TR.CompanyMarketCap` | Company Market Capitalisation | Valuation | usd |

Instruments in the seed: `IBM.N` (International Business Machines, NYSE),
`AAPL.O` (Apple, Nasdaq), `VOD.L` (Vodafone Group, LSE). Reporting period
`FY2023` (with `FY2022` held for IBM.N to exercise multi-period ingest). All
values synthetic and internally consistent.
