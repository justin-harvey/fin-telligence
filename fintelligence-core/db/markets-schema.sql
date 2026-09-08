-- Fin-Telligence: a minimal capital-markets surveillance warehouse.
--
-- This is the second warehouse the engine runs against, alongside the SaaS
-- finance demo. It exists to tell the story the whole project is built for: a
-- number you can put in front of a regulator. The questions it answers —
-- net position at close, market-abuse surveillance — are ones where "roughly
-- right, trust me" is not an acceptable answer, and where the provenance chain
-- and grounded verification earn their place.
--
-- Conventions, matching the SaaS warehouse:
--   Money is INTEGER CENTS, never floats.
--   Share quantities are INTEGER.
--   Timestamps are INTEGER milliseconds since the Unix epoch — surveillance
--   patterns (a cancel arriving 400ms after an order) live or die on
--   millisecond resolution, so seconds would erase the very thing being tested.

CREATE TABLE accounts (
    id       INTEGER PRIMARY KEY,
    name     TEXT    NOT NULL,
    desk     TEXT    NOT NULL,
    country  TEXT    NOT NULL
);

CREATE TABLE orders (
    id                INTEGER PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES accounts(id),
    ticker            TEXT    NOT NULL,
    side              TEXT    NOT NULL,   -- 'buy' | 'sell'
    qty               INTEGER NOT NULL,
    limit_price_cents INTEGER NOT NULL,
    placed_at_ms      INTEGER NOT NULL,
    canceled_at_ms    INTEGER,           -- NULL unless the order was canceled
    status            TEXT    NOT NULL    -- 'filled' | 'canceled'
);

-- One row per fill. account_id, ticker and side are denormalised from the
-- parent order so a position or VWAP query reads a single table.
CREATE TABLE executions (
    id             INTEGER PRIMARY KEY,
    order_id       INTEGER NOT NULL REFERENCES orders(id),
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    ticker         TEXT    NOT NULL,
    side           TEXT    NOT NULL,
    qty            INTEGER NOT NULL,
    price_cents    INTEGER NOT NULL,
    executed_at_ms INTEGER NOT NULL
);

CREATE TABLE prices (
    ticker      TEXT    NOT NULL,
    date        TEXT    NOT NULL,   -- 'YYYY-MM-DD'
    close_cents INTEGER NOT NULL
);

-- End-of-day position snapshot, seeded to reconcile exactly with the signed
-- sum of executions. Having both lets a query cross-check a derived figure
-- against an independently stored one — the reconciliation an auditor wants.
CREATE TABLE positions (
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    ticker         TEXT    NOT NULL,
    date           TEXT    NOT NULL,
    net_qty        INTEGER NOT NULL,
    avg_cost_cents INTEGER NOT NULL
);

CREATE INDEX idx_orders_account    ON orders(account_id);
CREATE INDEX idx_orders_cancel     ON orders(canceled_at_ms);
CREATE INDEX idx_exec_account_tkr  ON executions(account_id, ticker);
CREATE INDEX idx_exec_time         ON executions(executed_at_ms);
CREATE INDEX idx_positions_key     ON positions(account_id, ticker, date);
