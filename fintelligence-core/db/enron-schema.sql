-- Fin-Telligence: a synthetic Enron POC warehouse.
--
-- The third warehouse the engine runs against, alongside the SaaS-finance and
-- capital-markets demos. It tells the sharpest version of the whole thesis: a
-- reported figure set against what the underlying rows actually support, with a
-- tamper-evident provenance chain over the gap. Enron is the case study because
-- its collapse *was* that gap — revenue booked gross to look 2.5x larger, and
-- billions of debt parked in off-balance-sheet SPEs.
--
-- Grain and units: this warehouse operates at the financial-reporting aggregate
-- grain, denominated in INTEGER USD MILLIONS, exactly as a 10-K prints them.
-- That is a deliberate departure from the integer-cents convention of the other
-- two warehouses — the cents rule exists to keep money float-free, and integer
-- millions is equally float-free while matching the grain and letting a figure
-- ground against the filing verbatim (a cell of 100789 matches "100,789").
--
-- Claim discipline (see db/enron-anchor.md): the aggregates reconcile to Enron's
-- REAL reported 2000 / 1999 figures, cited to the 10-K. The transaction-level
-- rows are SYNTHETIC and labelled synthetic — there is no public Enron general
-- ledger — and the off-balance-sheet SPE amounts are illustrative of the
-- mechanism, not a claimed exact historical number. Real anchor figures are
-- real; fabricated rows are fabricated. Nothing here is a compliance claim.

-- The reporting entities: Enron itself, consolidated onto the balance sheet, and
-- the special-purpose entities that were kept off it.
CREATE TABLE entities (
    id            INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL,
    kind          TEXT    NOT NULL,   -- 'parent' | 'spe'
    consolidated  INTEGER NOT NULL,   -- 1 if on the reported balance sheet, else 0
    sponsor       TEXT,               -- related party behind an SPE, where applicable
    formed_year   INTEGER
);

-- Enron's real reported line items, transcribed verbatim from the filing, in USD
-- millions. This is the citation anchor a query can compare a computed figure
-- against. `source` carries the filing reference for every row.
CREATE TABLE reported_financials (
    fiscal_year         INTEGER NOT NULL,
    statement           TEXT    NOT NULL,   -- 'income' | 'balance'
    line_item           TEXT    NOT NULL,
    amount_usd_millions INTEGER NOT NULL,
    source              TEXT    NOT NULL
);

-- Synthetic merchant / trading activity carrying BOTH representations of each
-- deal: the gross notional that was booked as revenue, and the net merchant
-- margin actually earned. The gap between the two sums is the revenue-inflation
-- story. `basis` records that these were booked gross into revenue.
CREATE TABLE revenue_transactions (
    id                          INTEGER PRIMARY KEY,
    entity_id                   INTEGER NOT NULL REFERENCES entities(id),
    fiscal_year                 INTEGER NOT NULL,
    segment                     TEXT    NOT NULL,   -- 'natural gas' | 'electricity' | 'metals' | 'other'
    counterparty                TEXT    NOT NULL,
    basis                       TEXT    NOT NULL,   -- 'gross' (booked into revenue)
    gross_notional_usd_millions INTEGER NOT NULL,
    net_margin_usd_millions     INTEGER NOT NULL
);

-- Synthetic debt obligations, each tagged to an entity and flagged for whether
-- it appeared on the reported balance sheet. Reported debt sums the on-sheet
-- rows; true leverage sums all of them. The difference is the hidden-debt story.
CREATE TABLE debt_instruments (
    id                     INTEGER PRIMARY KEY,
    entity_id              INTEGER NOT NULL REFERENCES entities(id),
    fiscal_year            INTEGER NOT NULL,
    instrument             TEXT    NOT NULL,
    on_balance_sheet       INTEGER NOT NULL,   -- 1 if reported, 0 if kept off (SPE)
    principal_usd_millions INTEGER NOT NULL
);

CREATE INDEX idx_revtx_year_segment ON revenue_transactions(fiscal_year, segment);
CREATE INDEX idx_debt_year_sheet    ON debt_instruments(fiscal_year, on_balance_sheet);
CREATE INDEX idx_reported_year      ON reported_financials(fiscal_year, statement);
