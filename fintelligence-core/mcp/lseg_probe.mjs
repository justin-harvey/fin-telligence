// Minimal MCP stdio client to drive lseg-mcp: newline-delimited JSON-RPC 2.0.
import { spawn } from 'node:child_process';

const HOME = process.env.HOME;
const uvx = process.env.UVX || 'uvx';
const args = ['--from', 'git+https://github.com/GreenGrassBlueOcean/lseg_mcp.git', '--with', 'mcp<2', 'lseg-mcp'];

const mode = process.argv[2] || 'list';

const proc = spawn(uvx, args, { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
let nextId = 1;

function send(method, params, isNotification = false) {
  const msg = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
  let id = null;
  if (!isNotification) { id = nextId++; msg.id = id; }
  proc.stdin.write(JSON.stringify(msg) + '\n');
  return id;
}
function request(method, params) {
  const id = send(method, params);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 120000);
  });
}

proc.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});
proc.stderr.on('data', (d) => process.stderr.write('[mcp] ' + d.toString()));
proc.on('exit', (c) => console.error('[mcp exited]', c));

function textOf(result) {
  if (result?.content) return result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
  return JSON.stringify(result);
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fintel-probe', version: '0.1.0' },
  });
  send('notifications/initialized', undefined, true);

  const tools = await request('tools/list', {});
  if (mode === 'list') {
    for (const t of tools.tools) {
      console.log('\n### TOOL:', t.name);
      console.log('desc:', (t.description || '').slice(0, 160));
      console.log('inputSchema:', JSON.stringify(t.inputSchema));
    }
    proc.kill();
    return;
  }

  // Retry a tool call while the server is still indexing packages.
  async function callReady(name, args, tries = 40) {
    for (let i = 0; i < tries; i++) {
      const r = await request('tools/call', { name, arguments: args });
      const t = textOf(r);
      if (/downloading and indexing|Please wait|try again|not.*ready/i.test(t)) {
        process.stderr.write('[indexing… retry ' + (i + 1) + ']\n');
        await new Promise((res) => setTimeout(res, 8000));
        continue;
      }
      return t;
    }
    return '[gave up waiting for index]';
  }

  if (mode === 'validate') {
    const codes = [
      'TR.Revenue', 'TR.CostOfRevenueTotal', 'TR.GrossProfit', 'TR.OperatingIncome',
      'TR.NetIncomeAfterTaxes', 'TR.TotalDebtOutstanding', 'TR.TotalAssetsReported',
      'TR.PriceClose', 'TR.CompanyMarketCap',
    ];
    console.log('\n######## validate_lseg_formula(all codes) ########');
    console.log(await callReady('validate_lseg_formula', { fields: codes }));

    const concepts = ['revenue', 'cost of revenue', 'gross profit', 'operating income',
      'net income', 'total debt', 'total assets', 'price close', 'market capitalization'];
    for (const c of concepts) {
      console.log('\n######## search_data_dictionary("' + c + '") ########');
      console.log((await callReady('search_data_dictionary', { query: c, limit: 6 })).slice(0, 900));
    }
    proc.kill();
    return;
  }
}
main().catch((e) => { console.error('FATAL', e); proc.kill(); process.exitCode = 1; });
