#!/usr/bin/env node
/**
 * fintel — command line for the Fin-Telligence core.
 *
 *   fintel seed                        build the demo warehouse
 *   fintel ask "question"              answer a question, record the lineage
 *   fintel audit                       verify the chain and show the log
 *   fintel audit --export out.json     write the audit package
 *   fintel explain "SELECT ..."        run the guard against SQL, no model call
 */

import { writeFileSync } from 'node:fs';
import { seed } from '../src/db.js';
import { guard, SqlRejected } from '../src/guard.js';
import { ask } from '../src/ask.js';
import { verify, readLog, exportPackage, headHash } from '../src/audit.js';
import { loadSigner } from '../src/signing.js';
import { anchorHead, localStubAnchor } from '../src/anchor.js';
import {
    seedMarkets,
    netPositionAtClose,
    surveillanceRapidCancels,
    MARKETS_LOG_PATH,
    TRADING_DATE,
} from '../src/markets.js';
import {
    seedEnron,
    revenueByBasis,
    debtWithHiddenLeverage,
    ENRON_LOG_PATH,
    FISCAL_YEAR,
} from '../src/enron.js';
import {
    controlResult,
    CONTROL_STATUS,
    generateCompliancePacket,
    verifyPacket,
    renderPacketMarkdown,
} from '../src/evidence.js';

const [, , command, ...rest] = process.argv;

/** @param {number} cents */
const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

function printRows(rows, limit = 12) {
    if (rows.length === 0) {
        console.log('  (no rows)');
        return;
    }
    const columns = Object.keys(rows[0]);
    const widths = columns.map((column) =>
        Math.max(column.length, ...rows.slice(0, limit).map((row) => String(row[column]).length)),
    );
    console.log('  ' + columns.map((c, i) => c.padEnd(widths[i])).join('  '));
    console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
    for (const row of rows.slice(0, limit)) {
        console.log('  ' + columns.map((c, i) => String(row[c]).padEnd(widths[i])).join('  '));
    }
    if (rows.length > limit) console.log(`  … ${rows.length - limit} more row(s)`);
}

/** `--export <path>` value, or null. Accepts `.json` (packet) or `.md` (rendered). */
function exportPath(args) {
    const i = args.indexOf('--export');
    return i >= 0 ? args[i + 1] ?? null : null;
}

/**
 * Write an evidence packet for one attested control result to `path`. A `.md`
 * path renders the human-readable packet; anything else writes the JSON packet.
 * Always self-verifies and prints the result, so the export is never trusted blind.
 */
function writePacket(path, { control, rows, entry, publicKey }) {
    const packet = generateCompliancePacket({ control, entry, rows, publicKey });
    const body = path.endsWith('.md') ? renderPacketMarkdown(packet) : `${JSON.stringify(packet, null, 2)}\n`;
    writeFileSync(path, body, 'utf8');
    const check = verifyPacket(packet);
    console.log(`\nEvidence packet → ${path}`);
    console.log(`  self-verifies : ${check.ok ? 'VERIFIED' : 'FAILED'}  (${Object.entries(check.checks)
        .map(([k, v]) => `${k}=${v === null ? 'n/a' : v}`)
        .join(', ')})`);
}

async function main() {
    switch (command) {
        case 'seed': {
            const result = seed();
            console.log(
                `Seeded warehouse: ${result.customers} customers, ` +
                    `${result.movements} MRR movements, ${result.spendRows} spend rows.`,
            );
            console.log('Data is synthetic and deterministic — the same seed always produces the same rows.');
            break;
        }

        case 'explain': {
            // Runs the guard alone. Useful for probing the boundary without
            // spending a model call, and for demonstrating what it refuses.
            const sql = rest.join(' ');
            try {
                const result = guard(sql);
                console.log('ALLOWED');
                console.log('  tables       :', result.tables.join(', '));
                console.log('  limitInjected:', result.limitInjected);
                console.log('  sql          :', result.sql.replace(/\n/g, '\n                 '));
            } catch (error) {
                if (!(error instanceof SqlRejected)) throw error;
                console.log('REJECTED');
                console.log('  reason :', error.reason);
                console.log('  message:', error.message);
                process.exitCode = 1;
            }
            break;
        }

        case 'ask': {
            const question = rest.join(' ');
            if (!question) {
                console.error('Usage: fintel ask "how has MRR trended?"');
                process.exitCode = 2;
                return;
            }

            const result = await ask(question);

            if (!result.ok) {
                console.log(`REFUSED at ${result.stage}: ${result.reason}`);
                console.log(result.message);
                if (result.proposedSql) console.log('\nProposed SQL:\n' + result.proposedSql);
                process.exitCode = 1;
                return;
            }

            console.log('\n' + result.answer + '\n');
            console.log('SQL');
            console.log('  ' + result.sql.replace(/\n/g, '\n  '));
            console.log('\nRows');
            printRows(result.rows);
            console.log('\nProvenance');
            console.log('  tables          :', result.lineage.tables.join(', '));
            console.log('  rows returned   :', result.lineage.rowCount);
            console.log('  result hash     :', result.lineage.resultHash.slice(0, 32) + '…');
            console.log('  LLM scope       :', result.lineage.llmScope);
            console.log('  data modified   :', result.lineage.dataModified);
            console.log('  figures verified:', result.verifiedFigures);
            if (result.fellBack) {
                console.log('  NOTE            : narration failed verification; mechanical summary used');
            }
            console.log('  audit entry     : #' + result.auditSeq + '  ' + result.auditHash.slice(0, 16) + '…');
            console.log(
                '  signature       : ' +
                    (result.signed ? `signed (key ${result.signingKeyId})` : 'unsigned (no signing key configured)'),
            );
            break;
        }

        case 'audit': {
            // A signing key in the environment also yields the public key, so
            // the audit view verifies signatures as well as the hash chain.
            const signer = loadSigner();
            const verifier = signer ? { publicKey: signer.publicKey } : null;

            const exportIndex = rest.indexOf('--export');
            if (exportIndex !== -1) {
                const target = rest[exportIndex + 1];
                if (!target) {
                    console.error('Usage: fintel audit --export <file.json>');
                    process.exitCode = 2;
                    return;
                }
                // Anchor the current head to an external record. Only a local
                // stub ships here; a TLaaS adapter satisfies the same interface.
                const receipt = await anchorHead(headHash(), localStubAnchor());
                const pkg = exportPackage(undefined, { verifier, anchorReceipt: receipt });
                writeFileSync(target, JSON.stringify(pkg, null, 2));
                console.log(
                    `Wrote audit package: ${target} (${pkg.entryCount} entries, ` +
                        `integrity ${pkg.integrity.ok ? 'OK' : 'BROKEN'}, ` +
                        `${pkg.signing.signedEntries}/${pkg.entryCount} signed` +
                        `${receipt ? `, anchored ${receipt.ref.slice(0, 16)}…` : ''})`,
                );
                return;
            }

            const integrity = verify(undefined, { verifier });
            console.log(
                `Audit chain: ${integrity.entries} entries — ${integrity.ok ? 'INTACT' : 'BROKEN'}` +
                    `${verifier ? ' (signatures checked)' : ''}`,
            );
            if (!integrity.ok) {
                console.log(`  broken at entry ${integrity.brokenAt}: ${integrity.reason}`);
                process.exitCode = 1;
            }
            for (const entry of readLog()) {
                console.log(
                    `  #${String(entry.seq).padStart(3)}  ${entry.at}  ` +
                        `${entry.rowCount} rows  [${entry.tables.join(', ')}]  ` +
                        `${entry.complianceTags.join(' · ')}`,
                );
                console.log(`        ${entry.question}`);
            }
            break;
        }

        case 'markets': {
            const sub = rest[0];
            const signer = loadSigner();
            switch (sub) {
                case 'seed': {
                    const result = seedMarkets();
                    console.log(
                        `Seeded markets warehouse: ${result.accounts} accounts, ` +
                            `${result.orders} orders, ${result.executions} executions (session ${TRADING_DATE}).`,
                    );
                    console.log('Synthetic and deterministic; two accounts exhibit a rapid place-and-cancel pattern.');
                    break;
                }
                case 'net-position': {
                    const ticker = rest[1];
                    if (!ticker) {
                        console.error('Usage: fintel markets net-position <TICKER>');
                        process.exitCode = 2;
                        return;
                    }
                    const { rows, lineage, entry } = netPositionAtClose({ ticker: ticker.toUpperCase(), signer });
                    console.log(`\nNet position in ${ticker.toUpperCase()} as of market close (${TRADING_DATE})\n`);
                    printRows(rows);
                    console.log('\nProvenance');
                    console.log('  as-of           :', new Date(lineage.asOf.value).toISOString());
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  signature       :', entry.signature ? `signed (key ${entry.signingKeyId})` : 'unsigned');
                    break;
                }
                case 'surveillance': {
                    const { rows, entry } = surveillanceRapidCancels({ signer });
                    console.log('\nMarket-abuse surveillance — rapid place-and-cancel (spoofing/layering)\n');
                    if (rows.length === 0) {
                        console.log('  No accounts breached the threshold.');
                    } else {
                        printRows(rows);
                        console.log('\n  ALERT: ' + rows.length + ' account(s) flagged for review.');
                    }
                    console.log('\nProvenance');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  compliance tags :', entry.complianceTags.join(' · '));
                    break;
                }
                case 'audit': {
                    const verifier = signer ? { publicKey: signer.publicKey } : null;
                    const integrity = verify(MARKETS_LOG_PATH, { verifier });
                    console.log(
                        `Markets audit chain: ${integrity.entries} entries — ${integrity.ok ? 'INTACT' : 'BROKEN'}` +
                            `${verifier ? ' (signatures checked)' : ''}`,
                    );
                    if (!integrity.ok) {
                        console.log(`  broken at entry ${integrity.brokenAt}: ${integrity.reason}`);
                        process.exitCode = 1;
                    }
                    for (const item of readLog(MARKETS_LOG_PATH)) {
                        console.log(`  #${String(item.seq).padStart(3)}  ${item.scenario ?? 'query'}  ${item.question}`);
                    }
                    break;
                }
                default:
                    console.log('Usage:');
                    console.log('  fintel markets seed                    build the markets warehouse');
                    console.log('  fintel markets net-position <TICKER>   net position at close, attested');
                    console.log('  fintel markets surveillance            flag rapid place-and-cancel accounts');
                    console.log('  fintel markets audit                   verify the markets audit chain');
                    process.exitCode = sub ? 2 : 0;
            }
            break;
        }

        case 'enron': {
            const sub = rest[0];
            const signer = loadSigner();
            switch (sub) {
                case 'seed': {
                    const result = seedEnron();
                    console.log(
                        `Seeded Enron POC warehouse: ${result.entities} entities, ` +
                            `${result.revenueTransactions} revenue deals, ${result.debtInstruments} debt instruments, ` +
                            `${result.reportedLineItems} reported line items.`,
                    );
                    console.log('Aggregates reconcile to Enron\'s real FY2000 10-K; transaction rows are synthetic.');
                    break;
                }
                case 'revenue': {
                    const { rows, lineage, entry } = revenueByBasis({ signer });
                    const r = rows[0] ?? {};
                    console.log(`\nFY${FISCAL_YEAR} revenue — as reported (gross) versus merchant margin (net)\n`);
                    printRows(rows);
                    console.log(
                        `\n  Reported gross revenue : $${Number(r.revenue_gross_usd_millions).toLocaleString('en-US')}m` +
                            `   (10-K total revenues)`,
                    );
                    console.log(
                        `  Net merchant margin    : $${Number(r.revenue_net_usd_millions).toLocaleString('en-US')}m`,
                    );
                    console.log('\nProvenance');
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  signature       :', entry.signature ? `signed (key ${entry.signingKeyId})` : 'unsigned');
                    const revPacket = exportPath(rest);
                    if (revPacket) {
                        writePacket(revPacket, {
                            rows,
                            entry,
                            publicKey: signer?.publicKey ?? null,
                            control: controlResult({
                                controlId: 'PI1.1',
                                criterion: 'Processing Integrity — revenue recognised on the correct basis',
                                description: `FY${FISCAL_YEAR} revenue as reported (gross) versus merchant margin (net).`,
                                status: CONTROL_STATUS.PASS,
                                figures: [
                                    { label: 'Reported gross revenue', value: r.revenue_gross_usd_millions, unit: 'usd_millions' },
                                    { label: 'Net merchant margin', value: r.revenue_net_usd_millions, unit: 'usd_millions' },
                                ],
                            }),
                        });
                    }
                    break;
                }
                case 'debt': {
                    const { rows, lineage, entry } = debtWithHiddenLeverage({ signer });
                    const r = rows[0] ?? {};
                    console.log(`\nFY${FISCAL_YEAR} debt — reported versus true, including off-balance-sheet SPEs\n`);
                    printRows(rows);
                    console.log(
                        `\n  Reported debt          : $${Number(r.reported_debt_usd_millions).toLocaleString('en-US')}m` +
                            `   (10-K short + long-term)`,
                    );
                    console.log(
                        `  True debt incl. SPEs   : $${Number(r.total_debt_incl_spe_usd_millions).toLocaleString('en-US')}m` +
                            `   (synthetic SPE amounts)`,
                    );
                    console.log('\nProvenance');
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  compliance tags :', entry.complianceTags.join(' · '));
                    const debtPacket = exportPath(rest);
                    if (debtPacket) {
                        writePacket(debtPacket, {
                            rows,
                            entry,
                            publicKey: signer?.publicKey ?? null,
                            control: controlResult({
                                controlId: 'PI1.2',
                                criterion: 'Processing Integrity — reported figures reconcile to underlying records',
                                description: `FY${FISCAL_YEAR} reported debt versus true debt including off-balance-sheet SPEs.`,
                                status: CONTROL_STATUS.PASS,
                                figures: [
                                    { label: 'Reported debt', value: r.reported_debt_usd_millions, unit: 'usd_millions' },
                                    { label: 'True debt incl. SPEs', value: r.total_debt_incl_spe_usd_millions, unit: 'usd_millions' },
                                ],
                            }),
                        });
                    }
                    break;
                }
                case 'audit': {
                    const verifier = signer ? { publicKey: signer.publicKey } : null;
                    const integrity = verify(ENRON_LOG_PATH, { verifier });
                    console.log(
                        `Enron audit chain: ${integrity.entries} entries — ${integrity.ok ? 'INTACT' : 'BROKEN'}` +
                            `${verifier ? ' (signatures checked)' : ''}`,
                    );
                    if (!integrity.ok) {
                        console.log(`  broken at entry ${integrity.brokenAt}: ${integrity.reason}`);
                        process.exitCode = 1;
                    }
                    for (const item of readLog(ENRON_LOG_PATH)) {
                        console.log(`  #${String(item.seq).padStart(3)}  ${item.scenario ?? 'query'}  ${item.question}`);
                    }
                    break;
                }
                default:
                    console.log('Usage:');
                    console.log('  fintel enron seed          build the synthetic Enron POC warehouse');
                    console.log('  fintel enron revenue       reported (gross) vs merchant (net) revenue, attested');
                    console.log('  fintel enron debt          reported vs true debt incl. off-balance-sheet SPEs');
                    console.log('  fintel enron audit         verify the Enron audit chain');
                    console.log('    add --export <file.json|.md>   write a verifiable evidence packet');
                    process.exitCode = sub ? 2 : 0;
            }
            break;
        }

        default:
            console.log('Usage:');
            console.log('  fintel seed                      build the SaaS demo warehouse');
            console.log('  fintel ask "question"            answer a question, record lineage');
            console.log('  fintel explain "SELECT ..."      run the guard alone, no model call');
            console.log('  fintel audit                     verify the hash chain, list entries');
            console.log('  fintel audit --export out.json   write the audit package');
            console.log('  fintel markets <sub>             capital-markets surveillance demo');
            console.log('  fintel enron <sub>               synthetic Enron reporting-gap demo');
            process.exitCode = command ? 2 : 0;
    }
}

main().catch((error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
});
