/**
 * The SQLite warehouse adapter.
 *
 * This is the default and the one the demo runs on. It is also the simplest
 * possible instance of the interface, which makes it the reference for what
 * the other adapters have to reproduce.
 *
 * The read-only property here is not a policy this code enforces — it is a
 * flag passed to SQLite, which refuses writes below anything this process can
 * reach. That distinction matters: the guard is code and can have bugs; a
 * connection opened read-only is a property of the database engine.
 */

import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DB_PATH } from '../db.js';

/**
 * @param {object} [options]
 * @param {string} [options.path]
 * @returns {import('./index.js').Warehouse}
 */
export function openSqlite({ path = DEFAULT_DB_PATH } = {}) {
    const db = new DatabaseSync(path, { readOnly: true });

    return {
        dialect: 'sqlite',
        describe: `sqlite:${path}`,

        async query(sql) {
            // node:sqlite returns null-prototype objects; spreading gives
            // ordinary ones so downstream key enumeration and JSON
            // serialisation behave the way every other adapter's rows do.
            return db.prepare(sql).all().map((row) => ({ ...row }));
        },

        async assertReadOnly() {
            // Ask the engine rather than trusting the flag we passed it. If
            // this handle were writable the statement would succeed, and a
            // check that can only ever pass is not a check.
            const checks = [];
            let writable = false;
            try {
                db.prepare('CREATE TABLE __fintel_write_probe (x INTEGER)').run();
                writable = true;
                // Should be unreachable. If we get here the handle is not
                // read-only and we have just modified the warehouse.
                try {
                    db.prepare('DROP TABLE __fintel_write_probe').run();
                } catch { /* nothing useful to do; the finding is reported below */ }
                checks.push({ check: 'write_probe', passed: false, detail: 'CREATE TABLE succeeded' });
            } catch (error) {
                checks.push({ check: 'write_probe', passed: true, detail: error.message });
            }

            return {
                readOnly: !writable,
                connection: `sqlite:${path}`,
                checks,
            };
        },

        async close() {
            db.close();
        },
    };
}
