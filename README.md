# Fin-Telligence
Live: https://fin-telligence.netlify.app/enron

**Financial answers you can audit. The model writes SQL, the database produces the numbers, and every figure in the answer is verified against the data before you see it.**

[![Prototype](https://img.shields.io/badge/prototype-live-brightgreen.svg)](https://fin-telligence.netlify.app/)
[![Core tests](https://img.shields.io/badge/core-160%20tests%2C%20offline-blue.svg)](fintelligence-core/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The premise is simple: a language model is excellent at turning a question into SQL, and terrible at being trusted with the arithmetic. So it is never trusted with the arithmetic. The model writes a query, a read-only database returns the rows, and a verifier checks that every number in the prose actually came from those rows. What you get back is either a grounded answer with a full provenance trail, or an explicit refusal. Never an unverified paragraph presented as fact.

```
question
   ├─ plan      model writes SQL, having never seen a row of data
   ├─ guard     parsed, SELECT-only, allow-listed, LIMIT enforced   ← refuses here
   ├─ execute   read-only connection                                ← refuses here
   ├─ narrate   prose written, then every number checked against the rows
   ├─ lineage   SQL + tables + columns + row count + result hash
   └─ audit     appended to a hash-chained log
```

## What's in this repo

| Path | What it is |
|------|-----------|
| [`fintelligence-core/`](fintelligence-core/) | **The working engine.** A Node.js CLI and library that implements the full pipeline above: guard, read-only warehouse, grounding verifier, lineage capture, and a tamper-evident audit chain. 160 tests, no API credential required to run them. |
| [`fintelligence/`](fintelligence/) | **The prototype site** deployed at [fin-telligence.netlify.app](https://fin-telligence.netlify.app/). It argues for the thesis; the core repository does it. |
| [`fintelligence/enron.html`](fintelligence/enron.html) | **The Enron reporting-gap case study**, live at [/enron](https://fin-telligence.netlify.app/enron) — reported FY2000 figures set against what the underlying rows support, each grounded and hash-chained. |
| [`fintelligence/lseg.html`](fintelligence/lseg.html) | **The LSEG fundamentals demo**, live at [/lseg](https://fin-telligence.netlify.app/lseg) — company financials by real `TR.*` field codes (validated via lseg-mcp), reconciled to their components and attested; synthetic values, credential-swap to real data. |
| [`fintelligence/controls.html`](fintelligence/controls.html) | **The SOC 2 evidence panel**, live at [/controls](https://fin-telligence.netlify.app/controls) — one-click controls that return PASS/EXCEPTION with a verifiable evidence trail. |

The prototype makes the case. The core makes it executable. Start with the [`fintelligence-core/` README](fintelligence-core/README.md) for the full technical account.

## The four guarantees, and what enforces each

A claim is only worth what enforces it. Each guarantee is backed by a mechanism and a test that would fail if it broke, not by a promise.

| Guarantee | Enforced by |
|-----------|-------------|
| The model cannot write to the database | A connection opened `readOnly: true`; SQLite refuses writes below anything the code can reach |
| Only SELECT, only allow-listed tables/columns, always bounded | `guard.js` parses SQL to an AST and inspects the full table list, including subqueries and CTE bodies |
| Every figure in the prose came from the data | `grounding.js` extracts each number and matches it to a returned value, allowing only legitimate transforms (cents to currency, ratio to percent) |
| A past answer cannot be altered unnoticed | `audit.js` hash-chains each entry to the one before it; `verify()` reports the first index where the chain breaks |

## Four warehouses

The same pipeline runs against four warehouses — the guard, grounding, lineage and audit chain are identical; only the schema and allow-list change.

- **SaaS finance** — MRR, retention, LTV:CAC and cohort questions. The demo that shows the engine works.
- **Capital markets** — trade-surveillance attestation: net position at market close (computed in SQL, pinned to an as-of timestamp, reproducible hash) and market-abuse surveillance (accounts that place and cancel within milliseconds — the shape spoofing and layering leave), framed against MAR / MiFID II. See the [core README](fintelligence-core/README.md#trade-surveillance-attestation).
- **Enron reporting-gap POC** — Enron's FY2000 10-K numbers set against what the underlying rows support: revenue booked *gross* ($100,789m reported) vs the *net* merchant margin actually earned ($1,953m), and reported debt ($10,229m) vs the true total once the off-balance-sheet SPEs are included. The aggregates reconcile to Enron's **real** reported figures (cited to SEC accession `0001024401-01-500010`); the transaction rows are synthetic and labelled so. See the [core README](fintelligence-core/README.md#the-enron-reporting-gap-demo).
- **LSEG fundamentals** — live vendor data, explained in full below.

---

## LSEG, explained from zero

If you have never touched market data, this section is for you. It assumes nothing, spells out every acronym, and shows where the engine earns its keep. (If you *have* used Refinitiv/LSEG, skip to [the two reconciliations](#the-two-reconciliations-and-what-each-actually-proves).)

### The vocabulary, in plain English

| Term | What it means |
|------|---------------|
| **LSEG** | **London Stock Exchange Group** — the company that sells the financial data here. You may know its data business by its former name, **Refinitiv** (and before that, Thomson Reuters). It sells company fundamentals, prices, reference data, and more. |
| **`lseg-data`** | LSEG's official **Python library** for pulling that data programmatically. |
| **Workspace / Eikon** | LSEG's desktop **terminal** and the session it runs. `lseg-data` attaches to a running Workspace session, or to a **Data Platform app key**. |
| **Entitlement** | Your subscription's **permission** to see specific datasets/fields. Data is gated *per field*. A "403" from the API means *you are not entitled to this field*, not *this field does not exist* — a distinction this engine is careful to preserve. |
| **RIC** (Reuters Instrument Code) | Identifies an instrument **at a venue**: `IBM.N` is IBM on the NYSE (`.N`), `VOD.L` is Vodafone on the London Stock Exchange (`.L`), `AAPL.O` is Apple on Nasdaq (`.O`). A RIC is **mutable** — a ticker rename, an exchange move, or an M&A event can reassign it. So it is a *lookup alias*, never the identity of the numbers. |
| **PermID** (Permanent Identifier) | LSEG's **stable, opaque** IDs ([permid.org](https://permid.org)) that survive the changes a RIC does not. Two kinds matter here: the **Org PermID** identifies the *issuer/company* (IBM = `4295904307`) and keys entity-level data like fundamentals; the **quote PermID** identifies a specific *listing* and keys quote-level data like prices. |
| **`TR.*` field codes** | The addressing scheme for fundamentals. You ask for a code — `TR.Revenue`, `TR.CostOfRevenueTotal`, `TR.GrossProfit`, `TR.OperatingIncome`, … — and get back a value. |
| **COA** (Chart of Accounts) | LSEG's **standardized** model: every company's filing mapped onto one common template so figures compare across companies. Line items carry COA codes — **SREV** (Revenue), **SCOR** (Cost of Revenue), **SGRP** (Gross Profit). |
| **Standardized vs as-reported** | Two **bases** for the same figure. *Standardized* is LSEG's normalized COA number (comparable across firms). *As-reported* is the number as the company itself put it in its filing. They can legitimately differ when normalization reclassifies a line item across a boundary. |
| **Field parameters** | A `TR.*` value is only meaningful with the parameters the request carried: **Curn** (currency), **Scale** (a power-of-ten multiplier — "Scale=6" means the value is in millions), **Period** (`FY2023`, a quarter `FQ`, or trailing-twelve-months `LTM`), **ReportingState** (original / reported / restated). |
| **`get_data` vs `get_history`** | `get_data` returns **one value per reporting period** — the right call for fundamentals. `get_history` returns a **time series** (start date / end date / interval) — the right call for prices, which are daily, not per-period. |
| **Bitemporal** | Two independent time axes. *Valid time* = the fiscal **period** a number is about (FY2023). *Knowledge/transaction time* = **when the number became known**, including when a restatement republished it. Keeping them separate is what lets a restatement be a *new fact* instead of looking like someone tampered with the old one. |

### How the LSEG warehouse works

```
TR.Revenue, TR.CostOfRevenueTotal, ...          ← you name real LSEG field codes
        │
        ▼   lseg-mcp validates the codes; lseg-data pulls the values
   read-only snapshot warehouse                 ← each row carries its provenance:
   (organizations · instruments · fundamentals ·   field code, basis, currency, scale,
    prices · lseg_fields dictionary)               period, knowledge_date, source
        │
        ▼   the same guarded / grounded / hash-chained pipeline as every warehouse
   reconcile + attest                           ← PASS / EXCEPTION / N-A, with a
                                                    reproducible result hash and a
                                                    tamper-evident audit entry
```

Fundamentals are **entity-level**, so they key on the stable **Org PermID**, not on the mutable RIC. You still *ask* by RIC (`IBM.N`); the engine resolves it to the Org PermID before touching the data. If a RIC is ever reassigned to a different company, it correctly resolves to *that* company's fundamentals — the RIC follows nothing, the entity is the identity.

Companion tool: [`lseg-mcp`](https://github.com/GreenGrassBlueOcean/lseg_mcp), an open-source MCP server whose whole job is resolving a concept ("gross profit") to the correct `TR.*` code, validating it, and drafting the retrieval call. Fin-Telligence's job is the other half: **verify and attest** the result. The nine `TR.*` codes seeded here were each validated `OK` via lseg-mcp's `validate_lseg_formula`.

### The two reconciliations, and what each *actually* proves

Being honest about what a check proves is the whole point of the project, so:

**1. Standardized-model integrity** — asserts `Gross Profit = Revenue − Cost of Revenue` (i.e. `SGRP = SREV − SCOR`) on the standardized basis. But in LSEG's standardized model `SGRP` is *defined as* `SREV − SCOR`, so on clean vendor data this identity **holds by construction**. So this is not "catching an error in LSEG's numbers" — it is a **pipeline-integrity / tamper-evidence** check. It fires on ingest corruption or a value altered after it landed, and the hash chain makes that alteration undeniable.

**2. Standardized vs as-reported** — this is the reconciliation that tests LSEG's **data**. Because standardization can reclassify a line item across the gross-profit boundary, the standardized figure and the company's as-reported figure can legitimately differ. A **tie** means LSEG agrees with the filing; a **variance** is a real *classification difference* an analyst must understand before citing a number — not an error, not tampering. (The seed carries one deliberate, labelled $500m reclassification on IBM.N FY2022 to exercise this path.)

On top of both:

- **FX guard.** You cannot subtract a revenue in USD from a cost in GBP and call the difference gross profit. If the components don't share currency, scale, and periodicity, the control raises an **EXCEPTION** rather than silently returning a wrong number.
- **Coverage → N/A, never a false zero.** If a required field is missing (an LSEG `<NA>`, an unentitled field, a coverage gap), a field-keyed sum returns `NULL`, not `0`. The control reports **N/A** — never a `0 − 0 = 0` "PASS" on data you don't actually have. This is the dangerous failure mode for regulated use, so it is closed explicitly.
- **Bitemporal as-of reads.** Ask for a figure "as of" a past knowledge date and you get the vintage that was known *then*; the default is the latest vintage. A restatement is stored as a **new row**, never an overwrite, so re-running an as-of query reproduces its exact hash and the audit chain stays intact **across a restatement** — a new knowledge-time fact, not a mutation.
- **Pricing at its own grain.** A price is a *time series*, not a per-period fundamental, so `TR.PriceClose` lives in its own `prices` table (one row per quote × trading day, keyed by the quote PermID) and is fetched with `get_history`. The ingest seam enforces the split both ways: it refuses to land a pricing field as a fundamental, and vice versa.

### Where the value is

- **Verify-or-refuse over *vendor* market data.** You get a grounded number with provenance down to the exact `TR.*` field code it came from — or an explicit refusal. Never an unverified figure dressed up as fact.
- **Tamper-evident and reproducible.** The same question produces the same result hash; altering a past attestation breaks `verify()` at the exact entry. An auditor can recompute and compare.
- **Restatement-safe.** The bitemporal model means "the number reproduces on re-run" survives the first time a vendor restates a figure — the case that quietly breaks naive provenance systems.
- **Honest about its own claims.** The engine tells you when a check proves *integrity* (an identity true by construction) versus when it tests *data* (standardized vs as-reported), rather than overselling either.
- **Credential-swap to production.** Everything here runs on synthetic values with no LSEG subscription. Swapping the synthetic session for `RealLsegSession` + a valid app key is the only change needed to attest genuine LSEG Workspace data; the entitlement-aware bridge classifies failures (permission vs not-found vs transport), chunks large universes, and backs off on transport errors.

### A worked example (annotated CLI transcript)

```bash
cd fintelligence-core
node bin/fintel.js lseg seed          # build the LSEG warehouse (synthetic values)

# Fundamentals snapshot — each concept resolved to its blessed TR.* field
node bin/fintel.js lseg fundamentals IBM.N FY2023
#   Revenue            : $61,860,000,000   (TR.Revenue)
#   Cost of revenue    : $27,946,000,000   (TR.CostOfRevenueTotal)
#   Gross profit       : $33,914,000,000   (TR.GrossProfit)

# Standardized-model integrity (tamper check): Revenue − Cost ties to reported gross
node bin/fintel.js lseg reconcile IBM.N FY2023
#   Revenue − Cost of Revenue : $33,914,000,000   (USD)
#   Variance                  : $0   ✓ PASS

# Standardized vs as-reported (data check): a real $500m classification difference
node bin/fintel.js lseg basis IBM.N FY2022
#   Standardized (COA)        : $33,295,000,000   (USD)
#   As reported (filing)      : $33,795,000,000
#   Variance                  : $-500,000,000   ✗ EXCEPTION (classification difference to investigate)

# Bitemporal: the same period read as it was known before vs after a restatement
node bin/fintel.js lseg reconcile IBM.N FY2021 --as-of 2022-06-01   # original vintage
node bin/fintel.js lseg reconcile IBM.N FY2021                      # latest (restated) vintage

# Pricing at its own grain — a daily close series, not a fundamental
node bin/fintel.js lseg prices IBM.N --from 2024-03-27 --to 2024-03-28
#   2024-03-27  162.10 USD
#   2024-03-28  163.55 USD

node bin/fintel.js lseg audit         # verify the LSEG attestation chain end-to-end
```

Full technical detail: the [core README's LSEG section](fintelligence-core/README.md#the-lseg-fundamentals-demo-live-vendor-data), the claim-discipline anchor [`db/lseg-anchor.md`](fintelligence-core/db/lseg-anchor.md), and the lseg-mcp workflow in [`mcp/README.md`](fintelligence-core/mcp/README.md).

---

## Quick start

```bash
cd fintelligence-core
npm install
npm run seed                      # build the demo warehouse
npm test                          # 160 tests, no credential required

export ANTHROPIC_API_KEY=...      # only planning and narration call a model
node bin/fintel.js ask "How has MRR trended over the period?"
node bin/fintel.js audit

# capital-markets demo (no credential needed — canonical queries, not model-generated)
node bin/fintel.js markets seed
node bin/fintel.js markets net-position ACME    # net position at close, pinned as-of and hashed
node bin/fintel.js markets surveillance         # flag rapid place-and-cancel accounts

# Enron reporting-gap demo (no credential needed — real 10-K anchors, synthetic rows)
node bin/fintel.js enron seed
node bin/fintel.js enron revenue                # revenue as reported (gross) vs merchant margin (net)
node bin/fintel.js enron debt                   # reported debt vs true debt incl. off-balance-sheet SPEs

# LSEG fundamentals demo (no credential needed — real TR.* codes, synthetic values)
node bin/fintel.js lseg seed
node bin/fintel.js lseg reconcile IBM.N FY2023  # Gross Profit = Revenue − Cost of Revenue, attested
node bin/fintel.js lseg basis IBM.N FY2022      # standardized (COA) vs as-reported
node bin/fintel.js lseg prices IBM.N            # closing-price time series (own grain)
```

The guard, the warehouse, the lineage record, and the audit chain all run with no credential. Only the plan and narrate steps call the model. **Node 22+ is required** (`node:sqlite` is used).

## What is real, and what is not

In keeping with the project's own discipline about claims:

- **Real:** the guard (table and column allow-lists, a query budget, a row-level scope hook driven by an authenticated principal), read-only enforcement behind a warehouse-connector interface, four SQLite warehouses, unit-aware grounding, lineage capture and hashing, the hash-chained audit chain with Ed25519 signing and a pluggable external-anchoring hook, a first-class metric registry, the CLI, and the offline test suite. In the LSEG warehouse, the **identifiers** are real — the RICs, the Org PermIDs, and the `TR.*` field codes (each validated `OK` via lseg-mcp).
- **Synthetic:** the transaction-level and fundamentals **values** in all four warehouses, generated deterministically so the same question always produces the same result hash. The SaaS and markets numbers are invented and describe no real company; the Enron warehouse's *aggregates* reconcile to real reported 10-K figures (cited), but its transaction rows and off-balance-sheet SPE amounts are synthetic; the LSEG **values** are fabricated (no entitlement ships here) and the quote PermIDs are labelled placeholders (`QUOTE-PENDING:<RIC>`) pending validation. Real identifiers, fabricated values, fabrication labelled — for a tool about traceable figures, fabricated data clearly labelled as fabricated is fine; fabricated data presented as real is the exact failure this project exists to prevent.
- **Not a compliance claim:** the audit entries carry tags like `SOX` and `processing-integrity` because the query path is read-only over a schema with no personal data. That is a true statement about this configuration, not a certification. SOC 2, SOX, and GDPR are properties of organizations and processes, not of software. What this produces is *evidence*: a query, its provenance, a reproducible hash of its result, and a chain showing the record has not been edited since.

## Requirements

Node 22+ (`node:sqlite` is built in, so there is no native database dependency to compile). Planning and narration call a large language model; the API key is read from the environment (see the quick start). Real LSEG data additionally needs `pip install lseg-data`, an LSEG entitlement (app key), and a running Workspace/Data Platform session — none of which is required for the synthetic demos.

## License

MIT. See [LICENSE](LICENSE).
