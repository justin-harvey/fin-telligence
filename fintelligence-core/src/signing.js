/**
 * Result signing — turning "internally consistent" into "non-repudiable".
 *
 * The audit chain proves a record has not changed since it was written. It does
 * not prove *who* wrote it, and a party who controls the log could rebuild the
 * whole chain from scratch. A signature closes that gap: each entry's hash is
 * signed with a private key held by the attesting party, so anyone with the
 * matching public key can confirm the record was issued by that party and not
 * forged after the fact.
 *
 * Ed25519 is used rather than an HMAC because the property wanted here is
 * non-repudiation, not just integrity: verification must be possible for a
 * third party who was never trusted with the signing secret. The private key is
 * never in the repository — it is read from the environment (a PEM in
 * FINTEL_SIGNING_KEY, or a path in FINTEL_SIGNING_KEY_FILE). With no key
 * configured, signing is simply skipped and entries are unsigned; the chain
 * still verifies. Signing is an added guarantee, not a required one.
 */

import {
    createHash,
    generateKeyPairSync,
    sign as cryptoSign,
    verify as cryptoVerify,
    createPublicKey,
    createPrivateKey,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * A short, stable identifier for a public key: the first 16 hex of the SHA-256
 * of its DER encoding. Recorded on each signed entry so a verifier knows which
 * key to check against.
 *
 * @param {import('node:crypto').KeyObject} publicKey
 * @returns {string}
 */
export function keyIdOf(publicKey) {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/**
 * Generate an ephemeral signer. Handy for tests and for `fintel keygen`; a real
 * deployment supplies a persisted key through the environment instead.
 *
 * @returns {{ privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject, keyId: string }}
 */
export function generateSigner() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}

/**
 * Sign a hex hash string, returning a base64 signature.
 *
 * @param {string} hashHex
 * @param {import('node:crypto').KeyObject} privateKey
 * @returns {string}
 */
export function signHash(hashHex, privateKey) {
    // Ed25519 takes no digest algorithm — the first argument must be null.
    return cryptoSign(null, Buffer.from(hashHex, 'utf8'), privateKey).toString('base64');
}

/**
 * Verify a base64 signature over a hex hash string.
 *
 * @param {string} hashHex
 * @param {string} signatureB64
 * @param {import('node:crypto').KeyObject} publicKey
 * @returns {boolean}
 */
export function verifyHash(hashHex, signatureB64, publicKey) {
    try {
        return cryptoVerify(null, Buffer.from(hashHex, 'utf8'), publicKey, Buffer.from(signatureB64, 'base64'));
    } catch {
        return false;
    }
}

/**
 * Load a signer from the environment, or null if none is configured. Never
 * reads a key from the repository.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject, keyId: string } | null}
 */
export function loadSigner(env = process.env) {
    let pem = env.FINTEL_SIGNING_KEY;
    if (!pem && env.FINTEL_SIGNING_KEY_FILE) {
        pem = readFileSync(env.FINTEL_SIGNING_KEY_FILE, 'utf8');
    }
    if (!pem) return null;

    const privateKey = createPrivateKey(pem);
    const publicKey = createPublicKey(privateKey);
    return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}
