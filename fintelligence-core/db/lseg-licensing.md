# LSEG licensing, redistribution & retention — sign-off before a live key

This document is the **pre-live-key checklist** for finding #7. The warehouse
*persists* vendor data, which is only lawful within the terms of an LSEG
agreement. Everything in the code (the `data_sources` policy table, the retention
report/purge, the `C1.1-lseg-data-retention` control) **encodes and enforces a
policy — it does not grant a right.** The numbers seeded here (non-display,
90-day TTL, internal-only) are *illustrative defaults for synthetic data*. Before
a real LSEG credential is used, the terms below must be confirmed against the
signed contract and the tags updated to match.

> Claim discipline (see `lseg-anchor.md`): no persisted vendor data may be
> untagged, and no cached value may be held past its licensed window. The report
> flags both; the control fails on either. That is the guarantee — not a
> certification of compliance, which is an organisational and contractual matter.

## What must be signed off

### 1. Display vs non-display usage
LSEG bills — and permits — **display** usage (a value shown to a human, e.g. a
live quote on a screen) differently from **non-display** usage (a value consumed
by a machine or a derived calculation, e.g. a reconciliation). This engine's use
is **non-display / derived** (it reconciles and attests; it does not present live
quotes), which is how each source is tagged (`data_sources.usage_class`). Confirm
the entitlement covers non-display use for every field pulled. If any value is
surfaced to an end user as a quote, that is display use and must be re-tagged and
re-licensed.

### 2. Caching / retention window (TTL)
Persisting a vendor value is caching, and caching windows are contractual. Each
source carries a `retention_days` TTL; `fintel lseg retention` reports any row
held past it and `--purge` deletes them; the `C1.1` control fails if anything is
stale or if a source has no TTL set. Confirm the permitted cache duration per
dataset and set `retention_days` to match (a shorter contractual window wins).

### 3. Redistribution terms
May a pulled value leave this system — shown to a client, embedded in a report,
exposed via an API? Default here is **internal-only (no redistribution)**
(`data_sources.redistribution`). Confirm redistribution rights per dataset before
any value crosses a boundary (a client deliverable, a downstream feed, a public
page).

### 4. Entitlement scope per field
Entitlements are **per dataset / field**, not per account. The ingest bridge
distinguishes a `permission_denied` failure (not entitled) from `not_found` (bad
code) so an entitlement gap is visible, not silent. Confirm every `TR.*` field and
every instrument in the universe is within the entitlement before a bulk pull.

### 5. Identifier validation
The RICs, Org PermIDs, and `TR.*` codes are real and validated via lseg-mcp; the
**quote PermIDs are placeholders** (`QUOTE-PENDING:<RIC>`). Replace them with the
real, validated quote/instrument PermIDs before landing live pricing.

## Where each control lives

| Concern | Encoded in | Checked by |
|---|---|---|
| Usage class (display/non-display) | `data_sources.usage_class` | `fintel lseg license`; `C1.1` control (untagged → EXCEPTION) |
| Cache TTL / retention | `data_sources.retention_days` + rows' `retrieved_at` | `fintel lseg retention [--purge]`; `C1.1` control (stale / no-TTL → EXCEPTION) |
| Redistribution terms | `data_sources.redistribution` | `fintel lseg license` |
| Entitlement scope | `scripts/lseg_fetch.py` error `kind` | surfaced on `RealLsegSession` errors |
| Identifier validity | lseg-mcp `validate_lseg_formula` | `mcp/README.md` workflow |

## Sign-off record (fill in before a live key)

| Field / dataset | Usage permitted | Cache TTL | Redistribution | Confirmed by | Date |
|---|---|---|---|---|---|
| _(e.g. TR.Revenue, Fundamentals)_ | | | | | |

Nothing in this repository constitutes legal advice or an LSEG agreement. It is
the scaffolding that makes the contractual answers explicit, enforceable, and
auditable once they are known.
