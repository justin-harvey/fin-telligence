-- The demo warehouse, as PostgreSQL.
--
-- Mirrors db/schema.sql. Two deliberate differences:
--
--   * Money is BIGINT, not INTEGER. Cents accumulate: a SUM over a mid-sized
--     customer base overflows int4 sooner than people expect, and an overflow
--     in a revenue total is the kind of error that reaches a board deck.
--   * No AUTOINCREMENT/SERIAL. Ids are copied verbatim from the SQLite source
--     so that the same row carries the same id on both warehouses — without
--     that, the lineage hashes could not be compared at all.
--
-- Every table name here is on the guard's allow-list. Nothing else belongs in
-- this schema.

CREATE TABLE customers (
    id                  BIGINT PRIMARY KEY,
    name                TEXT   NOT NULL,
    cohort_month        TEXT   NOT NULL,
    acquisition_channel TEXT   NOT NULL,
    country             TEXT   NOT NULL,
    created_at          TEXT   NOT NULL
);

CREATE TABLE subscriptions (
    id           BIGINT PRIMARY KEY,
    customer_id  BIGINT NOT NULL REFERENCES customers(id),
    plan         TEXT   NOT NULL,
    mrr_cents    BIGINT NOT NULL,
    started_at   TEXT   NOT NULL,
    canceled_at  TEXT
);

CREATE TABLE mrr_movements (
    id           BIGINT PRIMARY KEY,
    customer_id  BIGINT NOT NULL REFERENCES customers(id),
    month        TEXT   NOT NULL,
    movement     TEXT   NOT NULL,
    amount_cents BIGINT NOT NULL
);

CREATE TABLE acquisition_spend (
    id                  BIGINT PRIMARY KEY,
    channel             TEXT   NOT NULL,
    month               TEXT   NOT NULL,
    spend_cents         BIGINT NOT NULL,
    customers_acquired  BIGINT NOT NULL
);

CREATE INDEX idx_customers_cohort   ON customers(cohort_month);
CREATE INDEX idx_customers_channel  ON customers(acquisition_channel);
CREATE INDEX idx_movements_month    ON mrr_movements(month);
CREATE INDEX idx_movements_customer ON mrr_movements(customer_id);
CREATE INDEX idx_spend_channel      ON acquisition_spend(channel, month);
