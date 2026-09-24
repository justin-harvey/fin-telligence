/**
 * The metric / semantic registry.
 *
 * A metric like "net position" or "VWAP" has exactly one correct definition,
 * and the danger in a model-writes-SQL system is that it gets a slightly
 * different one each time — a sign flipped, a cancel included, a denominator
 * off. The registry makes each definition a first-class, named object the rest
 * of the system resolves against, rather than a fragment copied into a query.
 *
 * This is the formalisation of the canonical metric layer the markets demo
 * introduced. Two consumers use it: the scenario runners resolve a metric to
 * its blessed SQL fragment, and the planner is handed the registry's definitions
 * so a generated query is expected to compute a named metric the one agreed way.
 */

export class UnknownMetric extends Error {
    /** @param {string} name */
    constructor(name) {
        super(`No metric named "${name}" is registered.`);
        this.name = 'UnknownMetric';
        this.metric = name;
    }
}

/**
 * @typedef {object} MetricDefinition
 * @property {string} name
 * @property {string} description  one line, plain enough for a prompt
 * @property {string} sql          a SQL expression (not a full statement)
 * @property {string} [unit]       the unit the expression yields (e.g. 'cents', 'shares')
 */

export class MetricRegistry {
    constructor() {
        /** @type {Map<string, MetricDefinition>} */
        this.metrics = new Map();
    }

    /**
     * Register a metric. Chainable.
     *
     * @param {string} name
     * @param {{ description: string, sql: string, unit?: string }} definition
     * @returns {this}
     */
    define(name, definition) {
        if (!name || typeof name !== 'string') throw new Error('A metric needs a name.');
        if (!definition?.sql) throw new Error(`Metric "${name}" needs an sql expression.`);
        this.metrics.set(name, { name, unit: null, ...definition });
        return this;
    }

    /** @param {string} name @returns {boolean} */
    has(name) {
        return this.metrics.has(name);
    }

    /**
     * Resolve a metric to its definition, or throw if it is not registered —
     * an unknown metric is a bug to surface, not a fragment to invent.
     *
     * @param {string} name
     * @returns {MetricDefinition}
     */
    resolve(name) {
        const metric = this.metrics.get(name);
        if (!metric) throw new UnknownMetric(name);
        return metric;
    }

    /** @returns {MetricDefinition[]} */
    list() {
        return [...this.metrics.values()];
    }

    /**
     * A human- and prompt-readable listing of the blessed definitions, so the
     * planner can be told to compute named metrics the one agreed way.
     *
     * @returns {string}
     */
    promptFragment() {
        return this.list()
            .map((metric) => `- ${metric.name} — ${metric.description}\n    ${metric.sql}`)
            .join('\n');
    }
}

/**
 * The registry for the capital-markets warehouse: the canonical definitions the
 * surveillance and position scenarios resolve against.
 *
 * @returns {MetricRegistry}
 */
export function marketsRegistry() {
    return new MetricRegistry()
        .define('net_position', {
            description: 'Signed share position: buys add, sells subtract, over executions.',
            sql: "SUM(CASE WHEN side = 'buy' THEN qty ELSE -qty END)",
            unit: 'shares',
        })
        .define('notional_cents', {
            description: 'Executed notional in cents: shares times execution price, summed.',
            sql: 'SUM(qty * price_cents)',
            unit: 'cents',
        })
        .define('vwap_cents', {
            description: 'Volume-weighted average execution price, in cents.',
            sql: 'CAST(SUM(qty * price_cents) AS REAL) / SUM(qty)',
            unit: 'cents',
        });
}

/**
 * The registry for the synthetic Enron POC warehouse. The definitions encode the
 * two mechanics of the reporting gap — revenue booked gross versus net margin
 * earned, and reported debt versus true debt including off-balance-sheet SPEs —
 * so each is computed one blessed way. All amounts are USD millions.
 *
 * @returns {MetricRegistry}
 */
export function enronRegistry() {
    return new MetricRegistry()
        .define('revenue_gross_usd_millions', {
            description: 'Revenue as booked: full trade notional summed, in USD millions.',
            sql: 'SUM(gross_notional_usd_millions)',
            unit: 'usd_millions',
        })
        .define('revenue_net_usd_millions', {
            description: 'Merchant revenue actually earned: net margin summed, in USD millions.',
            sql: 'SUM(net_margin_usd_millions)',
            unit: 'usd_millions',
        })
        .define('debt_reported_usd_millions', {
            description: 'Debt on the reported balance sheet only, in USD millions.',
            sql: 'SUM(CASE WHEN on_balance_sheet = 1 THEN principal_usd_millions ELSE 0 END)',
            unit: 'usd_millions',
        })
        .define('debt_total_usd_millions', {
            description: 'All debt including off-balance-sheet SPEs, in USD millions.',
            sql: 'SUM(principal_usd_millions)',
            unit: 'usd_millions',
        });
}

/**
 * The registry for the LSEG company-fundamentals warehouse. Each metric is a
 * field-keyed sum over the long-format `fundamentals` table, so resolving a
 * concept ("revenue", "gross profit") always sums the one correct LSEG `TR.*`
 * field the one agreed way. Filtering to a single instrument+period upstream
 * makes each sum a single datapoint. All monetary metrics are whole USD.
 *
 * @returns {MetricRegistry}
 */
export function lsegRegistry() {
    /** @param {string} code @returns {string} */
    const fieldSum = (code) => `SUM(CASE WHEN field_code = '${code}' THEN value ELSE 0 END)`;
    return new MetricRegistry()
        .define('revenue_usd', {
            description: 'Revenue for the instrument/period, from LSEG field TR.Revenue, in USD.',
            sql: fieldSum('TR.Revenue'),
            unit: 'usd',
        })
        .define('cost_of_revenue_usd', {
            description: 'Cost of revenue, total, from LSEG field TR.CostOfRevenueTotal, in USD.',
            sql: fieldSum('TR.CostOfRevenueTotal'),
            unit: 'usd',
        })
        .define('gross_profit_usd', {
            description: 'Gross profit as reported, from LSEG field TR.GrossProfit, in USD.',
            sql: fieldSum('TR.GrossProfit'),
            unit: 'usd',
        })
        .define('operating_income_usd', {
            description: 'Operating income, from LSEG field TR.OperatingIncome, in USD.',
            sql: fieldSum('TR.OperatingIncome'),
            unit: 'usd',
        })
        .define('net_income_usd', {
            description: 'Net income after taxes, from LSEG field TR.NetIncomeAfterTaxes, in USD.',
            sql: fieldSum('TR.NetIncomeAfterTaxes'),
            unit: 'usd',
        })
        .define('total_debt_usd', {
            description: 'Total debt outstanding, from LSEG field TR.TotalDebtOutstanding, in USD.',
            sql: fieldSum('TR.TotalDebtOutstanding'),
            unit: 'usd',
        });
}
