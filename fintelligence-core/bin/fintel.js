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
import { verify, readLog, exportPackage } from '../src/audit.js';

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
            break;
        }

        case 'audit': {
            const exportIndex = rest.indexOf('--export');
            if (exportIndex !== -1) {
                const target = rest[exportIndex + 1];
                if (!target) {
                    console.error('Usage: fintel audit --export <file.json>');
                    process.exitCode = 2;
                    return;
                }
                const pkg = exportPackage();
                writeFileSync(target, JSON.stringify(pkg, null, 2));
                console.log(`Wrote audit package: ${target} (${pkg.entryCount} entries, integrity ${pkg.integrity.ok ? 'OK' : 'BROKEN'})`);
                return;
            }

            const integrity = verify();
            console.log(`Audit chain: ${integrity.entries} entries — ${integrity.ok ? 'INTACT' : 'BROKEN'}`);
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

        default:
            console.log('Usage:');
            console.log('  fintel seed                      build the demo warehouse');
            console.log('  fintel ask "question"            answer a question, record lineage');
            console.log('  fintel explain "SELECT ..."      run the guard alone, no model call');
            console.log('  fintel audit                     verify the hash chain, list entries');
            console.log('  fintel audit --export out.json   write the audit package');
            process.exitCode = command ? 2 : 0;
    }
}

main().catch((error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
});
