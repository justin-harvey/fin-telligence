# LSEG warehouse anchor — real identifiers, synthetic values

The `lseg` warehouse (`lseg-schema.sql` / `lseg.js`) is the engine's fourth
warehouse. It holds company **fundamentals** of the kind an analyst retrieves
from LSEG (London Stock Exchange Group, formerly Refinitiv) by `TR.*` field code
through the `lseg-data` Python library. Fin-Telligence runs its guarded,
grounded, hash-chained pipeline over that snapshot so a reported figure can be
reconciled against the line items that compose it — with provenance down to the
exact LSEG field code each number came from.

## What is real, and what is synthetic

- **Real:** the **Org PermIDs** (LSEG's permanent entity identifiers, permid.org
  — `4295904307` IBM, `4295905573` Apple, `4295896661` Vodafone Group), the
  instrument **RICs** (Reuters Instrument Codes — a *quote* identifier,
  instrument × venue, e.g. `IBM.N`, `AAPL.O`, `VOD.L`) and the **`TR.*` field
  codes** (`TR.Revenue`, `TR.CostOfRevenueTotal`, `TR.GrossProfit`, ...). These
  are real LSEG identifiers and must stay accurate — validate before real ingest.

### Identifier model (finding #1)

Fundamentals are **entity-level**, so they key on the stable **Org PermID**, not
on a RIC. A RIC is a *quote* id (instrument × venue) and is **mutable** — a
ticker rename, exchange move, or M&A event can reassign it — so in the schema it
is a **mutable alias** onto the organization (`instruments.ric → organizations.org_permid`),
never the identity of the numbers. Reads accept the familiar RIC and resolve it
to the Org PermID before touching `fundamentals`. (The stable quote-level key for
*pricing* is the quote/instrument PermID; modelling pricing at its own grain is a
separate follow-up — finding #6 — so it is not a column yet.)
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

## The two reconciliations (and what each actually proves)

For each (instrument, period) the warehouse holds Revenue, Cost of Revenue, and
Gross Profit on two **bases** (see `fundamentals.basis`): `standardized` (LSEG's
Chart-of-Accounts / COA model) and `as_reported` (the figure as the company
filed it).

**1. Standardized-model integrity (`PI1.1-lseg-gross-profit-reconciliation`).**
Asserts the reporting identity

> **Gross Profit = Revenue − Cost of Revenue** (`TR.GrossProfit` =
> `TR.Revenue` − `TR.CostOfRevenueTotal`)

on the standardized basis. Be honest about what this proves: in LSEG's
standardized model `SGRP` is **defined as** `SREV − SCOR`, so on clean vendor
data the identity holds *by construction*. This control is therefore a
**pipeline-integrity / tamper-evidence** check — it fires on ingest corruption or
a value altered after landing (and the hash chain makes that alteration
undeniable), **not** on a discrepancy in LSEG's own numbers.

**2. Standardized vs as-reported (`PI1.1-lseg-standardized-vs-as-reported`).**
This is the reconciliation that tests LSEG's **data**. LSEG normalises every
issuer into the common COA so figures compare across companies; that
normalisation can reclassify a line item across the gross-profit boundary, so the
standardized figure and the as-reported figure legitimately differ. A **tie**
means LSEG agrees with the filing; a **variance** is a real *classification*
difference an analyst must understand before citing a number — which is not a
data error and not tampering. (Synthetic seed: IBM.N FY2022 carries a modelled
$500m reclassification to exercise this EXCEPTION path; all other seeded
instrument-periods tie.)

Both reconciliations run as one canonical, guarded, single-pass SQL query each
(no model narrates the number, so there is no prose to ground — the guarantee is
the reconciliation control plus the hash-chained audit), a missing component
reads as **N/A**, never a false PASS on a zero (coverage assertion), and mixed
**currency / scale / periodicity** across the components is refused with an
**EXCEPTION** rather than silently subtracted (the FX guard — finding #2). Each
`fundamentals` row carries those field parameters (`currency`, `scale`,
`periodicity`, `reporting_state`) so the guard has something real to check.

## Bitemporal model — restatements without false tamper (finding #5)

A fundamental has two time axes, and conflating them makes a legitimate
restatement look like tampering:

- **`period`** — the fiscal period the figure is *about* (valid time).
- **`knowledge_date`** — when the vintage became *known* / as-reported
  (transaction time): first publication, or a later republication when the
  vendor restates. Distinct from `retrieved_at`, which is only when *we* pulled
  the row into the warehouse.

A restatement is a **new row** with a later `knowledge_date` and
`reporting_state='restated'`, never an overwrite of the prior vintage. Reads
default to the **latest vintage known as of now**; an **as-of** read
(`fundamentalsSnapshot`/`reconcile*({ asOf })`, or `--as-of YYYY-MM-DD` on the
CLI) reproduces a figure as it stood at a past knowledge date. Because the prior
vintage is retained rather than mutated, the hash-chained audit stays intact
across a restatement — a new knowledge-time fact, not an alteration of an old one
— so **CC7.3 reproducibility survives the first time LSEG restates a number**.

The reads pick **exactly one vintage per (org, field, period, basis)** — the
`MAX(knowledge_date)` at or before the as-of date, via a correlated scalar
subquery (no UNION, so the guard admits it). Without that, a restated field would
be summed across both vintages, the same double-count shape the `basis` scope
guards against but along the knowledge-time axis. An as-of *before* any known
vintage returns nothing for that field, so it reads as **N/A**, never a spurious
zero. (Synthetic seed: IBM.N **FY2021** carries an original vintage known
2022-04-01 and a restatement known 2023-05-15 to exercise this path.)

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
