/**
 * MCP handlers — pure and transport-free.
 *
 * These are the tools and resources the Fin-Telligence engine exposes to a host
 * AI. Every one routes through the same guard, grounding, lineage and audit
 * chain as the CLI: the MCP surface adds no new path to the data, and the guard
 * stays the trust boundary. The stdio transport lives in mcp-server.js and is
 * the only thing that needs the MCP SDK — keeping the logic here means the whole
 * surface is testable offline, with no SDK and no running server.
 *
 * Two families of tool, deliberately:
 *   - credential-free: list_controls, run_control, run_canonical, verify_audit —
 *     canonical queries and the control catalog, no model call;
 *   - credentialed: execute_financial_query — the planner writes SQL, so it needs
 *     an API key, and (today) only the SaaS warehouse supports free text.
 */

import { controlCatalog, getControl } from './controls.js';
import { verify, DEFAULT_LOG_PATH } from './audit.js';
import { loadSigner } from './signing.js';
import { warehouseDescriptors, warehouseSchema } from './warehouses.js';
import { revenueByBasis, debtWithHiddenLeverage } from './enron.js';
import { netPositionAtClose, surveillanceRapidCancels } from './markets.js';
import { reconcileMrr } from './saas.js';

export const SERVER_INFO = { name: 'fintelligence', version: '0.1.0' };

/** Canonical, credential-free query dispatch. Each entry takes an options bag. */
const CANONICAL = {
    'enron/revenue': (o) => revenueByBasis(o),
    'enron/debt': (o) => debtWithHiddenLeverage(o),
    'markets/net-position': (o) => netPositionAtClose({ ...o, ticker: String(o.ticker ?? 'ACME').toUpperCase() }),
    'markets/surveillance': (o) => surveillanceRapidCancels(o),
    'saas/mrr': (o) => reconcileMrr(o),
};

/** Reduce an audit entry to the provenance a caller should carry. */
function provenanceOf(entry) {
    return {
        resultHash: entry.resultHash,
        auditSeq: entry.seq,
        auditHash: entry.hash,
        signature: entry.signature ?? null,
        signingKeyId: entry.signingKeyId ?? null,
        complianceTags: entry.complianceTags ?? [],
    };
}

/** The tool definitions advertised to a host AI. */
export function listTools() {
    return [
        {
            name: 'list_controls',
            description: 'List the SOC 2 control catalog (id, criterion, warehouse, description).',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
            name: 'run_control',
            description:
                'Run a SOC 2 control by id. Returns a control result (PASS/EXCEPTION, figures) with its provenance; the result is exportable as an evidence packet.',
            inputSchema: {
                type: 'object',
                properties: { id: { type: 'string', description: 'a control id from list_controls' } },
                required: ['id'],
            },
        },
        {
            name: 'run_canonical',
            description: `Run a canonical, credential-free query. name is one of: ${Object.keys(CANONICAL).join(', ')}.`,
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    args: { type: 'object', description: 'query arguments, e.g. { "ticker": "ACME" }' },
                },
                required: ['name'],
            },
        },
        {
            name: 'verify_audit',
            description: 'Verify a hash-chained audit log; reports INTACT or the first entry where the chain breaks.',
            inputSchema: { type: 'object', properties: { logPath: { type: 'string' } } },
        },
        {
            name: 'execute_financial_query',
            description:
                'Answer a free-text financial question: the model writes SQL, the guard checks it, the database produces the numbers, every figure is verified, and the answer is attested. Requires an API credential. Only the "saas" warehouse supports free text today.',
            inputSchema: {
                type: 'object',
                properties: {
                    question: { type: 'string' },
                    warehouse: { type: 'string', description: 'defaults to "saas"' },
                },
                required: ['question'],
            },
        },
    ];
}

/**
 * Invoke a tool by name. `client` (an Anthropic instance) is only used by
 * execute_financial_query; the rest run with no credential.
 *
 * @param {string} name
 * @param {object} [args]
 * @param {object} [ctx]
 * @param {object} [ctx.client]
 */
export async function callTool(name, args = {}, { client } = {}) {
    switch (name) {
        case 'list_controls':
            return controlCatalog().map((c) => ({
                id: c.id,
                criterion: c.criterion,
                warehouse: c.warehouse,
                description: c.description,
            }));

        case 'run_control': {
            const { id, ...options } = args;
            const { control, entry } = getControl(id).run({ signer: loadSigner(), ...options });
            return { control, provenance: provenanceOf(entry), exportable: true };
        }

        case 'run_canonical': {
            const fn = CANONICAL[args.name];
            if (!fn) {
                throw new Error(
                    `Unknown canonical query "${args.name}". Known: ${Object.keys(CANONICAL).join(', ')}.`,
                );
            }
            const { rows, entry } = fn({ ...(args.args ?? {}), signer: loadSigner() });
            return { rows, provenance: provenanceOf(entry) };
        }

        case 'verify_audit':
            return verify(args.logPath ?? DEFAULT_LOG_PATH, { verifier: null });

        case 'execute_financial_query': {
            const warehouse = args.warehouse ?? 'saas';
            if (warehouse !== 'saas') {
                return {
                    ok: false,
                    stage: 'route',
                    reason: 'warehouse_not_supported',
                    message:
                        `Free-text questions are only supported over the "saas" warehouse today. ` +
                        `The "${warehouse}" warehouse exposes canonical queries via run_canonical and ` +
                        `controls via run_control.`,
                };
            }
            const { ask } = await import('./ask.js');
            return ask(args.question, client ? { client } : {});
        }

        default:
            throw new Error(`Unknown tool "${name}".`);
    }
}

/** The resource definitions advertised to a host AI. */
export function listResources() {
    const warehouses = Object.keys(warehouseDescriptors());
    return [
        {
            uri: 'fintelligence://warehouses',
            name: 'Warehouses',
            description: 'The warehouses this engine serves, and which support free-text questions.',
            mimeType: 'application/json',
        },
        {
            uri: 'fintelligence://controls',
            name: 'Control catalog',
            description: 'The SOC 2 control catalog.',
            mimeType: 'application/json',
        },
        ...warehouses.map((w) => ({
            uri: `fintelligence://schema/${w}`,
            name: `Schema: ${w}`,
            description: `Live, allow-listed table/column schema for the ${w} warehouse.`,
            mimeType: 'application/json',
        })),
    ];
}

/**
 * Read a resource by uri. Schema resources reflect the live database shape,
 * filtered to the guard's allow-list.
 *
 * @param {string} uri
 */
export function readResource(uri) {
    if (uri === 'fintelligence://warehouses') {
        return Object.values(warehouseDescriptors()).map((d) => ({
            name: d.name,
            description: d.description,
            freeText: d.freeText,
            tables: [...d.allowedTables],
        }));
    }
    if (uri === 'fintelligence://controls') {
        return controlCatalog().map((c) => ({
            id: c.id,
            criterion: c.criterion,
            warehouse: c.warehouse,
            description: c.description,
        }));
    }
    const match = /^fintelligence:\/\/schema\/([a-z]+)$/.exec(uri);
    if (match) return warehouseSchema(match[1]);
    throw new Error(`Unknown resource uri "${uri}".`);
}
