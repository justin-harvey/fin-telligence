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

-- The securities/companies, keyed by RIC (Reuters Instrument Code) — LSEG's real
-- primary instrument identifier (e.g. 'IBM.N', 'AAPL.O', 'VOD.L').
CREATE TABLE instruments (
    ric       TEXT PRIMARY KEY,      -- Reuters Instrument Code (real LSEG identifier)
    name      TEXT NOT NULL,         -- issuer common name
    isin      TEXT,                  -- ISIN, where applicable
    exchange  TEXT NOT NULL,         -- listing venue
    currency  TEXT NOT NULL,         -- reporting currency
    sector    TEXT
);

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

-- The fact table: one datapoint per (instrument, field, reporting period), with
-- the provenance an audit needs — which field code it came from, when it was
-- retrieved, and the source string identifying the feed. `value` is an INTEGER
-- in the unit declared on `lseg_fields.unit`.
CREATE TABLE fundamentals (
    id           INTEGER PRIMARY KEY,
    ric          TEXT    NOT NULL REFERENCES instruments(ric),
    field_code   TEXT    NOT NULL REFERENCES lseg_fields(field_code),
    period       TEXT    NOT NULL,   -- 'FY2023', 'FY2022', ... (Financial Period Absolute)
    value        INTEGER NOT NULL,   -- in lseg_fields.unit
    currency     TEXT    NOT NULL,   -- currency of a monetary value, else the instrument currency
    retrieved_at TEXT    NOT NULL,   -- ISO-8601 date the datapoint was landed
    source       TEXT    NOT NULL    -- the feed/entitlement it was pulled from
);

CREATE INDEX idx_fund_ric_period ON fundamentals(ric, period);
CREATE INDEX idx_fund_field      ON fundamentals(field_code);
