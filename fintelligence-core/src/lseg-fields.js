/**
 * The LSEG field dictionary — the one place a `TR.*` field's name, category and
 * native unit are declared.
 *
 * `seedLseg` lands it in the `lseg_fields` table (what ingest validates field
 * codes against, and what a fact row's unit is read from), and `lsegRegistry`
 * reads each metric's unit from it instead of restating it. Previously the
 * registry carried its own copy of every unit, and the two could drift apart.
 *
 * Field codes are real LSEG `TR.*` conventions and mirror what lseg-mcp's
 * `search_data_dictionary` resolves; confirm each with lseg-mcp before a real
 * ingest. Units are the native unit each value is stored in.
 */

export const LSEG_FIELDS = Object.freeze([
    { code: 'TR.Revenue', name: 'Revenue', category: 'Fundamentals', unit: 'usd', description: 'Total revenue for the reporting period.' },
    { code: 'TR.CostOfRevenueTotal', name: 'Cost of Revenue, Total', category: 'Fundamentals', unit: 'usd', description: 'Total cost of revenue for the reporting period.' },
    { code: 'TR.GrossProfit', name: 'Gross Profit', category: 'Fundamentals', unit: 'usd', description: 'Revenue less cost of revenue, as reported.' },
    { code: 'TR.OperatingIncome', name: 'Operating Income', category: 'Fundamentals', unit: 'usd', description: 'Income from operations.' },
    { code: 'TR.NetIncomeAfterTaxes', name: 'Net Income After Taxes', category: 'Fundamentals', unit: 'usd', description: 'Net income after taxes.' },
    { code: 'TR.TotalDebtOutstanding', name: 'Total Debt Outstanding', category: 'Fundamentals', unit: 'usd', description: 'Total interest-bearing debt outstanding.' },
    { code: 'TR.TotalAssetsReported', name: 'Total Assets, Reported', category: 'Fundamentals', unit: 'usd', description: 'Total assets as reported on the balance sheet.' },
    { code: 'TR.PriceClose', name: 'Price Close', category: 'Pricing', unit: 'usd_cents', description: 'Closing price, in currency minor units (cents).' },
    { code: 'TR.CompanyMarketCap', name: 'Company Market Capitalisation', category: 'Valuation', unit: 'usd', description: 'Market capitalisation.' },
]);

/**
 * The native unit a `TR.*` field's values are stored in.
 *
 * @param {string} code
 * @returns {string}
 */
export function lsegFieldUnit(code) {
    const field = LSEG_FIELDS.find((f) => f.code === code);
    if (!field) throw new Error(`"${code}" is not in the LSEG field dictionary (src/lseg-fields.js).`);
    return field.unit;
}
