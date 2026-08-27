-- Fin-Telligence: a minimal SaaS finance warehouse.
--
-- Scope is deliberately small: enough tables to answer the questions the
-- prototype advertises (MRR trend, NRR by cohort, LTV:CAC by channel, cohort
-- churn) and nothing more. A narrow, well-understood schema is what makes
-- generated SQL checkable — the guard allow-lists these table names, so a
-- query touching anything else is rejected before it reaches the database.
--
-- Money is stored in integer CENTS, never floats. Binary floating point cannot
-- represent 0.10 exactly; summing thousands of float dollars drifts, and a
-- number that fails to reconcile is worse than useless in an audit. Callers
-- divide by 100.0 at the presentation edge.

CREATE TABLE customers (
    id                  INTEGER PRIMARY KEY,
    name                TEXT    NOT NULL,
    -- First month the customer paid, as 'YYYY-MM'. This is the cohort key.
    cohort_month        TEXT    NOT NULL,
    acquisition_channel TEXT    NOT NULL,
    country             TEXT    NOT NULL,
    created_at          TEXT    NOT NULL
);

CREATE TABLE subscriptions (
    id           INTEGER PRIMARY KEY,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    plan         TEXT    NOT NULL,          -- starter | growth | enterprise
    mrr_cents    INTEGER NOT NULL,          -- current recurring revenue, cents
    started_at   TEXT    NOT NULL,
    canceled_at  TEXT                       -- NULL while active
);

-- One row per customer per month per movement type. This is the ledger the
-- revenue metrics are derived from; it is append-only in spirit, and every
-- MRR figure should be reconstructible by summing it.
CREATE TABLE mrr_movements (
    id           INTEGER PRIMARY KEY,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    month        TEXT    NOT NULL,          -- 'YYYY-MM'
    -- new        : first revenue from a customer
    -- expansion  : upgrade / seat growth
    -- contraction: downgrade (negative amount)
    -- churn      : full cancellation (negative amount)
    movement     TEXT    NOT NULL,
    amount_cents INTEGER NOT NULL
);

CREATE TABLE acquisition_spend (
    id                  INTEGER PRIMARY KEY,
    channel             TEXT    NOT NULL,
    month               TEXT    NOT NULL,   -- 'YYYY-MM'
    spend_cents         INTEGER NOT NULL,
    customers_acquired  INTEGER NOT NULL
);

CREATE INDEX idx_customers_cohort   ON customers(cohort_month);
CREATE INDEX idx_customers_channel  ON customers(acquisition_channel);
CREATE INDEX idx_movements_month    ON mrr_movements(month);
CREATE INDEX idx_movements_customer ON mrr_movements(customer_id);
CREATE INDEX idx_spend_channel      ON acquisition_spend(channel, month);
