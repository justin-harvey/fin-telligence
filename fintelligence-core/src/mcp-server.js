/**
 * The stdio MCP transport — a thin adapter binding the pure handlers in mcp.js to
 * the Model Context Protocol SDK. This is the only file in the project that
 * imports the SDK, and it is dynamically imported by the CLI, so the rest of the
 * engine and the entire test suite never need the dependency installed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INFO, listTools, callTool, listResources, readResource } from './mcp.js';

/**
 * Start the MCP server over stdio. Resolves once connected; the transport keeps
 * the process alive to serve requests.
 */
export async function startMcpServer() {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {}, resources: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            const result = await callTool(request.params.name, request.params.arguments ?? {});
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            // Surface the error to the caller as tool output rather than crashing
            // the transport — a bad tool call is a normal outcome to report.
            return { isError: true, content: [{ type: 'text', text: String(error.message ?? error) }] };
        }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listResources() }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const data = readResource(request.params.uri);
        return {
            contents: [{ uri: request.params.uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
        };
    });

    await server.connect(new StdioServerTransport());
}
