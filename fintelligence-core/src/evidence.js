/**
 * Evidence packets and the control-result shape (M8).
 *
 * The audit chain stores, for each attestation, the *hash* of a result — not the
 * result itself. That is what makes it small and tamper-evident, but an auditor
 * asking "show me the evidence for this figure" needs the rows the hash was taken
 * over, the exact SQL that produced them, and a way to check all of it without
 * trusting whoever handed them the file. That artefact is the evidence packet.
 *
 * A packet bundles, side by side, the chain the feedback asked for:
 *
 *   [natural-language intent] → [validated SQL] → [returned rows as CSV]
 *                             → [cryptographic provenance: hash + signature + anchor]
 *
 * It is built to be verified *offline, by a stranger*: it embeds the verbatim
 * audit entry (so its hash recomputes exactly as the chain computed it) and the
 * actual rows (so the reader can re-hash them and confirm they are the ones the
 * chain attested). `verifyPacket()` performs every check; nothing here has to be
 * taken on trust.
 *
 * Claim discipline: a packet is *evidence*, not a certificate. A green control
 * status means "this figure was computed one blessed way and its provenance
 * verifies," never "this control is certified." SOC 2 is an attestation a CPA
 * firm issues about an organisation; this is the evidence such an attestation
 * rests on.
 */

import { createPublicKey } from 'node:crypto';
import { fingerprint } from './lineage.js';
import { hashEntry } from './audit.js';
import { verifyHash } from './signing.js';

/** The three states a control result can carry. */
export const CONTROL_STATUS = Object.freeze({ PASS: 'PASS', EXCEPTION: 'EXCEPTION', NA: 'N/A' });

const STATUSES = new Set(Object.values(CONTROL_STATUS));

/**
 * Normalise a control result — the richer shape a button returns, one level up
 * from the raw answer/refusal. A control asserts something about a figure and
 * reports whether it holds; the packet then makes that assertion evidentiary.
 *
 * @param {object} params
 * @param {string|null} [params.controlId]   e.g. 'PI1.2' or a button id
 * @param {string|null} [params.criterion]   human label of the criterion evidenced
 * @param {string|null} [params.description]  one line, what the control checks
 * @param {'PASS'|'EXCEPTION'|'N/A'} params.status
 * @param {{ label: string, value: number|string, unit?: string }[]} [params.figures]
 * @param {string|null} [params.exception]   why, when status is EXCEPTION
 * @returns {object}
 */
export function controlResult({
    controlId = null,
    criterion = null,
    description = null,
    status,
    figures = [],
    exception = null,
}) {
    if (!STATUSES.has(status)) {
        throw new Error(`control status must be one of ${[...STATUSES].join(', ')}; got ${String(status)}`);
    }
    if (status === CONTROL_STATUS.EXCEPTION && !exception) {
        throw new Error('an EXCEPTION control result must carry an exception reason');
    }
    return {
        controlId,
        criterion,
        description,
        status,
        figures: figures.map((f) => ({ label: f.label, value: f.value, unit: f.unit ?? null })),
        exception: status === CONTROL_STATUS.EXCEPTION ? exception : null,
    };
}

/**
 * Deterministic CSV for a result set. Columns are the sorted keys of the first
 * row (matching the lineage's column list), so the same rows always serialise
 * the same bytes. RFC-4180 quoting for values containing a comma, quote or
 * newline.
 *
 * @param {object[]} rows
 * @returns {string}
 */
export function rowsToCsv(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const cols = Object.keys(rows[0]).sort();
    const cell = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

const VERIFY_INSTRUCTIONS =
    'To verify without trusting the issuer: (1) recompute SHA-256 over the canonical ' +
    'rows and confirm it equals provenance.resultHash; (2) recompute the audit entry ' +
    'hash (all fields except hash/signature/signingKeyId) and confirm it equals ' +
    'provenance.audit.hash; (3) if signed, verify the Ed25519 signature over that hash ' +
    'with the embedded public key — whose keyId must be cross-checked against the ' +
    "attesting party's published key. `verifyPacket()` does all of this.";

/**
 * Build a self-contained, independently verifiable evidence packet for one
 * attested control result.
 *
 * The verbatim audit `entry` is embedded (it already carries the full lineage —
 * question, SQL, tables, result hash — plus its chain position and any
 * signature), so a reader recomputes its hash exactly as the chain did. The
 * `rows` are embedded too, because the chain never stored them; they are the new
 * evidence the packet adds over the log.
 *
 * @param {object} params
 * @param {object} params.control        a controlResult()
 * @param {object} params.entry          the audit entry returned by append()
 * @param {object[]} params.rows         the result rows the entry attests
 * @param {import('node:crypto').KeyObject|null} [params.publicKey] embedded for third-party verification
 * @param {object|null} [params.anchorReceipt] external-anchor receipt for the chain head
 * @param {string} [params.generatedAt]  ISO timestamp (injectable for deterministic tests)
 * @returns {object}
 */
export function generateCompliancePacket({
    control,
    entry,
    rows,
    publicKey = null,
    anchorReceipt = null,
    generatedAt = new Date().toISOString(),
}) {
    if (!entry || typeof entry.hash !== 'string') {
        throw new Error('generateCompliancePacket requires the audit entry (with its hash)');
    }
    return {
        kind: 'fintelligence.evidence-packet',
        version: 1,
        generatedAt,
        control,
        // The human-facing, side-by-side view. Authoritative copies live in
        // provenance.audit; these mirror them for readability and are checked
        // against the record by verifyPacket.
        evidence: {
            intent: entry.question,
            sql: entry.sql,
            tables: entry.tables ?? [],
            columns: entry.columns ?? [],
            rowCount: rows.length,
            rows,
            resultCsv: rowsToCsv(rows),
        },
        provenance: {
            resultHash: entry.resultHash,
            asOf: entry.asOf ?? null,
            llmScope: entry.llmScope ?? 'sql_generation_only',
            dataModified: entry.dataModified ?? false,
            complianceTags: entry.complianceTags ?? [],
            // Verbatim, so hashEntry(entry) recomputes to entry.hash.
            audit: entry,
            signingPublicKey: publicKey ? publicKey.export({ type: 'spki', format: 'pem' }).toString() : null,
            anchor: anchorReceipt,
        },
        verification: { instructions: VERIFY_INSTRUCTIONS },
    };
}

/**
 * Verify a packet with no external trust. Returns each check plus an overall
 * `ok`. A `null` check is "not applicable" (e.g. an unsigned packet's signature)
 * and does not fail the packet. A public key may be supplied; otherwise the
 * embedded one is used — but note that a self-embedded key only proves internal
 * consistency until its keyId is matched to a known published key.
 *
 * @param {object} packet
 * @param {object} [options]
 * @param {import('node:crypto').KeyObject|null} [options.publicKey]
 * @returns {{ ok: boolean, checks: Record<string, boolean|null> }}
 */
export function verifyPacket(packet, { publicKey = null } = {}) {
    const entry = packet?.provenance?.audit;
    const rows = packet?.evidence?.rows ?? [];
    const checks = {};

    checks.entryHashValid = Boolean(entry) && hashEntry(entry) === entry.hash;
    checks.resultHashMatchesRows = Boolean(entry) && fingerprint(rows) === entry.resultHash;
    checks.csvMatchesRows = rowsToCsv(rows) === (packet?.evidence?.resultCsv ?? '');
    checks.intentMatchesRecord =
        Boolean(entry) && packet?.evidence?.intent === entry.question && packet?.evidence?.sql === entry.sql;

    let key = publicKey;
    if (!key && packet?.provenance?.signingPublicKey) {
        try {
            key = createPublicKey(packet.provenance.signingPublicKey);
        } catch {
            key = null;
        }
    }
    if (entry?.signature) {
        checks.signatureValid = key ? verifyHash(entry.hash, entry.signature, key) : false;
    } else {
        checks.signatureValid = null; // unsigned is not a failure
    }

    const ok = Object.values(checks).every((v) => v === true || v === null);
    return { ok, checks };
}

/**
 * Render a packet as human-readable Markdown — the printable side-by-side an
 * auditor reads (and the UI can render to PDF via the browser, keeping a heavy
 * PDF dependency out of the core). Deterministic given the packet.
 *
 * @param {object} packet
 * @returns {string}
 */
export function renderPacketMarkdown(packet) {
    const c = packet.control ?? {};
    const p = packet.provenance ?? {};
    const e = packet.evidence ?? {};
    const audit = p.audit ?? {};
    const check = verifyPacket(packet);

    const figures = (c.figures ?? [])
        .map((f) => `| ${f.label} | ${f.value} | ${f.unit ?? ''} |`)
        .join('\n');

    const sig = audit.signature
        ? `signed (key ${audit.signingKeyId})`
        : 'unsigned';
    const anchor = p.anchor ? `${p.anchor.anchor} · ${String(p.anchor.ref).slice(0, 16)}…` : 'none';

    return `# Evidence packet — ${c.controlId ?? 'control'}${c.criterion ? ` · ${c.criterion}` : ''}

**Status:** ${c.status}${c.exception ? `  (${c.exception})` : ''}
**Generated:** ${packet.generatedAt}
${c.description ? `\n${c.description}\n` : ''}
## Control result

| Figure | Value | Unit |
|--------|-------|------|
${figures || '| (none) | | |'}

## 1 · Intent

> ${e.intent ?? ''}

## 2 · Validated SQL

\`\`\`sql
${e.sql ?? ''}
\`\`\`

## 3 · Result (${e.rowCount ?? 0} row(s), CSV)

\`\`\`
${e.resultCsv ?? ''}
\`\`\`

## 4 · Provenance

- Result hash: \`${p.resultHash}\`
- Audit entry: #${audit.seq} \`${String(audit.hash).slice(0, 24)}…\` (prev \`${String(audit.prevHash).slice(0, 12)}…\`)
- Signature: ${sig}
- External anchor: ${anchor}
- Compliance tags: ${(p.complianceTags ?? []).join(' · ') || '(none)'}
- LLM scope: ${p.llmScope} · data modified: ${p.dataModified}

## Verify this packet

${packet.verification?.instructions ?? ''}

**Self-check at render:** ${check.ok ? 'VERIFIED' : 'FAILED'} — ${Object.entries(check.checks)
        .map(([k, v]) => `${k}=${v === null ? 'n/a' : v}`)
        .join(', ')}
`;
}
