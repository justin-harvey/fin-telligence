# Enron anchor figures — real, as reported

These are Enron Corp.'s **actual reported** consolidated figures, transcribed
verbatim from the primary filing. They are the historical anchor for the
synthetic Enron POC warehouse (`enron-schema.sql` / `enron.js`): the warehouse's
transactional rows are fabricated and labelled synthetic, but its headline
aggregates roll up to these real numbers so the demo is historically faithful.

**Source:** ENRON CORP/OR/ (CIK 0001024401), Form 10-K for fiscal year ended
December 31, 2000, filed 2001-04-02, accession `0001024401-01-500010`, document
`ene10-k.txt`. Consolidated Income Statement and Consolidated Balance Sheet.
Retrieved from SEC EDGAR (public domain).

> Claim discipline: these aggregates are real and must be cited to this filing.
> The transaction-level rows in the warehouse are synthetic and must be labelled
> synthetic — there is no public Enron general ledger. The point of the POC is to
> show reported figures against what underlying rows support, with a
> tamper-evident provenance chain; that only works if the labelling is exact.

## Consolidated Income Statement (in $ millions)

| Line item | 2000 | 1999 | 1998 |
|---|---:|---:|---:|
| Revenues — natural gas and other products | 50,500 | 19,536 | 13,276 |
| Revenues — electricity | 33,823 | 15,238 | 13,939 |
| Revenues — metals | 9,234 | — | — |
| Revenues — other | 7,232 | 5,338 | 4,045 |
| **Total revenues** | **100,789** | **40,112** | **31,260** |
| Cost of gas, electricity, metals and other products | 94,517 | 34,761 | 26,381 |
| Operating expenses | 3,184 | 3,045 | 2,473 |
| Depreciation, depletion and amortization | 855 | 870 | 827 |
| Taxes, other than income taxes | 280 | 193 | 201 |
| Impairment of long-lived assets | — | 441 | — |
| **Total costs and expenses** | **98,836** | **39,310** | **29,882** |
| **Operating income** | **1,953** | **802** | **1,378** |
| **Net income** | **979** | **893** | **703** |
| Diluted earnings per share | $1.12 | $1.10 | $1.01 |

## Consolidated Balance Sheet (in $ millions)

| Line item | 2000 | 1999 |
|---|---:|---:|
| Cash and cash equivalents | 1,374 | 288 |
| Trade receivables (net) | 10,396 | 3,030 |
| Assets from price risk management activities (current) | 12,018 | 2,205 |
| **Total current assets** | **30,381** | **7,255** |
| Total investments and other assets | 23,379 | 15,445 |
| Property, plant and equipment, net | 11,743 | 10,681 |
| **Total assets** | **65,503** | **33,381** |
| Accounts payable | 9,777 | 2,154 |
| Liabilities from price risk management activities (current) | 10,495 | 1,836 |
| Short-term debt | 1,679 | 1,001 |
| **Total current liabilities** | **28,406** | **6,759** |
| Long-term debt | 8,550 | 7,151 |
| Total deferred credits and other liabilities | 13,759 | 6,471 |
| Minority interests | 2,414 | 2,430 |
| Company-obligated preferred securities of subsidiaries | 904 | 1,000 |
| **Total shareholders' equity** | **11,470** | **9,570** |
| **Total liabilities and shareholders' equity** | **65,503** | **33,381** |

## The two figures the POC is built around

- **Total debt reported = 1,679 + 8,550 = $10,229M** for 2000 (cross-checks the
  10-K Selected Financial Data line "Short- and long-term debt: 10,229"). The
  real leverage was larger; billions sat in unconsolidated SPEs (LJM, Raptor,
  Chewco, JEDI) that did not appear on this balance sheet. POC scenario:
  *reported debt* (consolidated entities only) vs *total debt including SPEs*.
- **Total revenues = $100,789M** for 2000, up from $40,112M in 1999. The jump was
  largely EnronOnline energy trades booked on a **gross** (full-notional) basis
  rather than net merchant margin. POC scenario: *revenue as reported (gross)* vs
  *merchant revenue (net margin)*.

Both scenarios compute both figures in SQL, ground each against the returned
rows, and hash-chain the result, so the gap between "as reported" and "what the
rows support" is itself an attested, tamper-evident record.
