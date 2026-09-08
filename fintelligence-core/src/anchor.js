/**
 * External anchoring — the honest fix for the one limitation the audit chain
 * cannot fix by itself.
 *
 * A local hash chain detects any edit to a past entry, but it cannot detect the
 * newest entries being *dropped*: a shorter chain is still internally valid
 * (see the audit tests). The remedy is to publish the chain head somewhere the
 * operator does not control, so a later "the log only ever had N entries" claim
 * can be checked against an independent record of a longer head.
 *
 * This is where the audit chain composes with an external timestamping or
 * on-chain anchoring service (TLaaS is the intended production adapter). The
 * interface is deliberately one method — `submit(headHash) -> receipt` — so a
 * real adapter and the local stub below are interchangeable. Only the stub
 * ships here; a network adapter is out of scope for the core.
 *
 * @typedef {object} Anchorer
 * @property {string} name
 * @property {(headHash: string) => Promise<object> | object} submit
 */

import { createHash } from 'node:crypto';

/**
 * A local stub anchorer. It does not provide the independence a real anchor
 * does — it runs in the same process — but it exercises the interface and
 * produces a deterministic receipt reference for a given head, which is what
 * the export path and its tests need.
 *
 * @returns {Anchorer}
 */
export function localStubAnchor() {
    return {
        name: 'local-stub',
        submit(headHash) {
            return {
                anchor: 'local-stub',
                headHash,
                ref: createHash('sha256').update(`local-stub-anchor:${headHash}`).digest('hex'),
                at: new Date().toISOString(),
                note: 'Stub anchor — no external independence. Swap for a TLaaS adapter in production.',
            };
        },
    };
}

/**
 * Submit a chain head to an anchorer and return the receipt.
 *
 * @param {string|null} headHash
 * @param {Anchorer} anchorer
 * @returns {Promise<object|null>} the receipt, or null if there is no head to anchor
 */
export async function anchorHead(headHash, anchorer) {
    if (!headHash) return null;
    return anchorer.submit(headHash);
}
