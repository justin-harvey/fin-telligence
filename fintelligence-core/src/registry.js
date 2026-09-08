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
