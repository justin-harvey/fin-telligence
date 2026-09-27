-- Fin-Telligence: an LSEG company-fundamentals warehouse.
--
-- The fourth warehouse the engine runs against, alongside the SaaS-finance,
-- capital-markets, and Enron demos. Where Enron shows the engine against a
-- historical reporting gap, this one shows it against *vendor market data*: the
-- kind of company fundamentals an analyst pulls from LSEG (London Stock Exchange
-- Group, formerly Refinitiv) by `TR.*` field code through the `lseg-data`
-- library. The thesis lands the same way — a figure the vendor reports set
-- against what the underlying line items support, reconciled in one guarded
-- query and hash-chained — but now the source is a live financial-data feed.
--
-- Where the data comes from. LSEG fundamentals are addressed by field code
-- (`TR.Revenue`, `TR.GrossProfit`, ...) and returned by `lseg.data.get_data`.
-- The companion open-source `lseg-mcp` server resolves the correct field code
-- for a concept and drafts the retrieval call; this warehouse is the read-only
-- snapshot those calls land in (see src/lseg-ingest.js for the ingest seam).
--
-- Grain and units: one row per (instrument, field, reporting period) in
-- `fundamentals`. Money is stored as an INTEGER in the field's native minor-free
-- unit recorded on the field itself (monetary line items in whole USD; a price
-- in USD cents; a ratio in basis points) — the same float-free discipline the
-- other warehouses keep, generalised because LSEG fields are heterogeneous.
--
-- Claim discipline (see db/lseg-anchor.md): the instrument RICs and the `TR.*`
-- field codes are REAL LSEG identifiers and must stay accurate — validate them
-- through lseg-mcp before any real ingest. The *values* in `fundamentals` are
-- SYNTHETIC and labelled synthetic (no LSEG entitlement is bundled), authored so
-- the accounting identities hold exactly (Gross Profit = Revenue − Cost of
-- Revenue). Real identifiers, fabricated values, fabrication labelled. Nothing
-- here is investment advice or a claim about any real company's actual results.

-- The ENTITY (issuer/organization), keyed by its LSEG **Org PermID** — a
-- permanent, opaque identifier (permid.org) that survives ticker changes,
-- exchange moves and M&A. This is the correct key for entity-level data like
-- company fundamentals: a RIC is not (see below). Org PermIDs are real LSEG
-- identifiers and must stay accurate — validate before real ingest, like the
-- RICs and TR.* codes (see db/lseg-anchor.md).
CREATE TABLE organizations (
    org_permid TEXT PRIMARY KEY,     -- LSEG Org PermID (e.g. '4295904307' = IBM)
    name       TEXT NOT NULL,        -- issuer common name
    sector     TEXT
);

-- The QUOTE / listing, keyed by RIC (Reuters Instrument Code). A RIC identifies
-- an instrument *at a venue* (e.g. 'IBM.N' is IBM on the NYSE) and is **mutable**:
-- a ticker rename, an exchange move, or an M&A event can reassign it. So here a
-- RIC is an **alias** onto the stable organization, never the identity of the
-- entity's fundamentals. (The stable quote-level key for pricing is the quote/
-- instrument PermID; modelling pricing at its own grain is the pricing-grain
-- follow-up — see finding #6 in LSEG-ARCHITECTURE-REVIEW.md — so it is not a
-- column here yet.)
CREATE TABLE instruments (
    ric        TEXT PRIMARY KEY,     -- Reuters Instrument Code — MUTABLE alias (instrument × venue)
    org_permid TEXT NOT NULL REFERENCES organizations(org_permid),
    isin       TEXT,                 -- ISIN, where applicable
    exchange   TEXT NOT NULL,        -- listing venue
    currency   TEXT NOT NULL         -- reporting/listing currency
);

CREATE INDEX idx_instr_org ON instruments(org_permid);

-- The LSEG field dictionary anchor: for every `TR.*` field the warehouse holds,
-- its human name, category, and the native unit its values are stored in. This
-- is the provenance dictionary a fact row cites, and it mirrors what lseg-mcp's
-- `search_data_dictionary` / `validate_lseg_formula` resolve. Field codes are
-- real LSEG conventions; confirm each with lseg-mcp before real ingest.
CREATE TABLE lseg_fields (
    field_code  TEXT PRIMARY KEY,    -- e.g. 'TR.Revenue' (real LSEG field code)
    name        TEXT NOT NULL,       -- e.g. 'Revenue'
    category    TEXT NOT NULL,       -- 'Fundamentals' | 'Pricing' | 'Valuation' | 'Reference'
    unit        TEXT NOT NULL,       -- 'usd' | 'usd_cents' | 'ratio_bps' | 'shares'
    description TEXT
);

-- The fact table: one datapoint per (organization, field, reporting period,
-- basis). Fundamentals are ENTITY-level, so they key on the stable **Org
-- PermID**, not on a RIC (a mutable quote alias) — the identifier fix in
-- finding #1. To read by the familiar RIC, join through `instruments`
-- (ric → org_permid). Each row carries the provenance an audit needs: which
-- field code it came from, on which reporting basis, when it was retrieved, and
-- the source string identifying the feed. `value` is an INTEGER in the unit
-- declared on `lseg_fields.unit`.
--
-- `basis` distinguishes the two alignments LSEG offers for the same figure:
--   'standardized' — LSEG's Chart-of-Accounts (COA) model, every issuer mapped
--                    to a common template so figures compare across companies.
--                    In this model Gross Profit (SGRP) is *defined* as
--                    Revenue (SREV) − Cost of Revenue (SCOR).
--   'as_reported'  — the figure as the company itself presented it in the
--                    filing, before LSEG's normalisation reclassifies line items.
-- The two can diverge when LSEG's standardisation moves an item across the
-- gross-profit line, which is exactly what makes a standardized-vs-as-reported
-- reconciliation a check on *data* rather than on an identity that holds by
-- construction. Legacy/ingested rows default to 'standardized' (the TR.* codes
-- address the COA model).
--
-- Field PARAMETERS on the grain (finding #2). A TR.* value is only meaningful
-- alongside the parameters the request carried; a bare number silently produces
-- wrong answers when they differ. So each row records them explicitly:
--   currency        — the `Curn` a monetary value is in. Revenue − Cost is only
--                     valid within one currency at one FX basis. Reconciliations
--                     REFUSE to combine mixed currencies (see lseg.js).
--   scale           — LSEG's `Scale`: a power of ten, so actual = value * 10^scale
--                     (0 = raw/full units). Storing a scaled value without its
--                     scale is a 10^n magnitude error waiting to happen.
--   periodicity     — the `Period` shape: 'FY' (annual) | 'FQ' (quarter) | 'LTM'
--                     (trailing twelve months). You cannot reconcile across these.
--   reporting_state — 'original' | 'reported' | 'restated'. Which vintage of the
--                     figure this row is (see the bitemporal model below).
--
-- Bitemporal model (finding #5). A fundamental has two time axes, and conflating
-- them is what makes a legitimate restatement look like tampering:
--   period          — the fiscal period the figure is ABOUT (valid time).
--   knowledge_date  — the date the figure became KNOWN / as-reported (transaction
--                     time): when the vendor first published it, or republished a
--                     restatement. Distinct from `retrieved_at`, which is merely
--                     when WE pulled the row into this warehouse.
-- A restatement is a NEW row with a later `knowledge_date` and
-- `reporting_state='restated'`, never an overwrite of the prior vintage. Reads
-- default to the latest vintage known as of now; an as-of read reproduces a
-- figure as it stood at a past knowledge date (see lseg.js). Because the prior
-- vintage is retained rather than mutated, the hash-chained audit stays intact
-- across a restatement — a new knowledge-time fact, not an alteration of an old
-- one — so CC7.3 reproducibility survives the first time LSEG restates a number.
CREATE TABLE fundamentals (
    id           INTEGER PRIMARY KEY,
    org_permid   TEXT    NOT NULL REFERENCES organizations(org_permid),
    field_code   TEXT    NOT NULL REFERENCES lseg_fields(field_code),
    period       TEXT    NOT NULL,   -- 'FY2023', 'FY2022', ... (Financial Period Absolute) — VALID time
    value        INTEGER NOT NULL,   -- in lseg_fields.unit, before `scale`
    currency     TEXT    NOT NULL,   -- `Curn` — currency of a monetary value, else the org's reporting currency
    basis        TEXT    NOT NULL DEFAULT 'standardized',  -- 'standardized' (COA) | 'as_reported' (filing)
    scale        INTEGER NOT NULL DEFAULT 0,               -- `Scale`: actual = value * 10^scale
    periodicity  TEXT    NOT NULL DEFAULT 'FY',            -- 'FY' | 'FQ' | 'LTM'
    reporting_state TEXT NOT NULL DEFAULT 'reported',      -- 'original' | 'reported' | 'restated'
    knowledge_date  TEXT NOT NULL,   -- ISO-8601 date this vintage became known (TRANSACTION time)
    retrieved_at TEXT    NOT NULL,   -- ISO-8601 date the datapoint was landed in this warehouse
    source       TEXT    NOT NULL    -- the feed/entitlement it was pulled from
);

CREATE INDEX idx_fund_org_period ON fundamentals(org_permid, period, basis);
CREATE INDEX idx_fund_field      ON fundamentals(field_code);
-- Supports the latest-vintage-as-of lookup: MAX(knowledge_date) per (org, field,
-- period, basis) at or before an as-of cutoff.
CREATE INDEX idx_fund_bitemporal ON fundamentals(org_permid, field_code, period, basis, knowledge_date);
