/**
 * The engine's HTTP surface — a thin JSON API over the same pure handlers in
 * mcp.js that the stdio MCP server uses. This is what a deployed web proxy (the
 * Supabase Edge Function in M7) calls: server-to-server, behind a shared bearer
 * token, so the browser never reaches the engine or the warehouse directly.
 *
 * No new dependency: Node's built-in http. The tool logic is unchanged — every
 * route delegates to callTool/readResource, so the guard, grounding and audit
 * chain remain the only path to the data here too.
 *
 * Routes:
 *   GET  /health                 → { ok, name, version }
 *   GET  /tools                  → { tools }
 *   POST /tools/:name  { ...args }→ { result }
 *   GET  /resources              → { resources }
 *   GET  /resources?uri=<uri>    → the resource body
 */

import { createServer } from 'node:http';
import { SERVER_INFO, listTools, callTool, listResources, readResource } from './mcp.js';

function send(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...extraHeaders,
    });
    res.end(payload);
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Build the API server.
 *
 * @param {object} [options]
 * @param {string|null} [options.token]  required bearer token; when null, auth is off (dev only)
 * @param {string|null} [options.corsOrigin]  echo this Origin for browser access (dev/testing)
 * @returns {import('node:http').Server}
 */
export function createApiServer({ token = process.env.ENGINE_SERVICE_TOKEN ?? null, corsOrigin = process.env.ENGINE_CORS_ORIGIN ?? null } = {}) {
    const cors = corsOrigin
        ? {
              'access-control-allow-origin': corsOrigin,
              'access-control-allow-headers': 'authorization, content-type',
              'access-control-allow-methods': 'GET, POST, OPTIONS',
          }
        : {};

    return createServer(async (req, res) => {
        try {
            if (req.method === 'OPTIONS') return send(res, 204, {}, cors);

            const url = new URL(req.url, 'http://localhost');
            const path = url.pathname;

            if (path === '/health') return send(res, 200, { ok: true, ...SERVER_INFO }, cors);

            // Everything past here requires the service token, when one is set.
            if (token) {
                const auth = req.headers.authorization ?? '';
                const presented = auth.startsWith('Bearer ') ? auth.slice(7) : null;
                if (presented !== token) return send(res, 401, { error: 'unauthorized' }, cors);
            }

            if (req.method === 'GET' && path === '/tools') {
                return send(res, 200, { tools: listTools() }, cors);
            }

            if (req.method === 'GET' && path === '/resources') {
                const uri = url.searchParams.get('uri');
                if (uri) return send(res, 200, readResource(uri), cors);
                return send(res, 200, { resources: listResources() }, cors);
            }

            if (req.method === 'POST' && path.startsWith('/tools/')) {
                const name = decodeURIComponent(path.slice('/tools/'.length));
                const args = await readJsonBody(req);
                const result = await callTool(name, args);
                return send(res, 200, { result }, cors);
            }

            return send(res, 404, { error: 'not_found', path }, cors);
        } catch (error) {
            // A bad tool call or unparseable body is a client error, not a crash.
            const status = error instanceof SyntaxError ? 400 : 400;
            return send(res, status, { error: 'bad_request', message: String(error.message ?? error) }, cors);
        }
    });
}

/**
 * Start the API server and resolve once it is listening.
 *
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {string|null} [options.token]
 * @param {string|null} [options.corsOrigin]
 * @returns {Promise<import('node:http').Server>}
 */
export function startApiServer({ port = Number(process.env.PORT ?? 8787), token, corsOrigin } = {}) {
    const server = createApiServer({ token, corsOrigin });
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
