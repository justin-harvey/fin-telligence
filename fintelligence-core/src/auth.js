/**
 * Authentication and per-principal authorization (row-level security).
 *
 * The guard's scope hook (M1) can inject a mandatory predicate; what it lacked
 * was an authenticated identity to decide *which* predicate. This module is
 * that identity layer, kept deliberately small and swappable: a real deployment
 * resolves a token against an IdP, but the shape — token in, principal out,
 * principal to scope — is the same.
 *
 * The security-relevant rule: a scoped principal's predicate is derived here
 * and handed to the guard, which binds it as a parameter. A trader principal
 * sees only their own book; an unauthenticated caller sees nothing unless the
 * caller explicitly runs unscoped (the demo/admin path). Authorization is a
 * decision made from identity, never from anything the model produced.
 */

export class AuthError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'AuthError';
    }
}

/**
 * @typedef {object} Principal
 * @property {string} id
 * @property {string[]} roles
 * @property {{ column: string, value: string|number }|null} scope  the row-level
 *   predicate this principal is confined to, or null for an unrestricted role
 */

/**
 * Resolve an opaque token to a principal against a registry, or throw. The
 * registry is a plain map for the reference implementation; the contract is
 * what matters — an unknown or missing token is refused, never defaulted to a
 * privileged identity.
 *
 * @param {string} token
 * @param {Record<string, Principal>} registry
 * @returns {Principal}
 */
export function authenticate(token, registry) {
    if (!token) throw new AuthError('No credential presented.');
    const principal = registry[token];
    if (!principal) throw new AuthError('Unknown credential.');
    return principal;
}

/**
 * The guard scope for a principal: the predicate the guard must AND into every
 * query this principal runs. `null` means unrestricted (an admin / supervisor),
 * which the caller must opt into rather than receive by accident.
 *
 * @param {Principal} principal
 * @returns {{ column: string, value: string|number }|null}
 */
export function scopeForPrincipal(principal) {
    if (!principal) throw new AuthError('A principal is required to derive a scope.');
    if (principal.roles?.includes('supervisor') || principal.roles?.includes('admin')) return null;
    if (!principal.scope) {
        throw new AuthError(
            `Principal ${principal.id} has neither an unrestricted role nor a scope; refusing to run unscoped.`,
        );
    }
    return principal.scope;
}

/**
 * A demo principal registry for the markets warehouse: two traders confined to
 * their own account, and a supervisor who sees the whole book. A real system
 * populates this from its identity provider.
 *
 * @returns {Record<string, Principal>}
 */
export function demoPrincipals() {
    return {
        'trader-acct-1': { id: 'alice', roles: ['trader'], scope: { column: 'account_id', value: 1 } },
        'trader-acct-3': { id: 'mallory', roles: ['trader'], scope: { column: 'account_id', value: 3 } },
        'surveillance-lead': { id: 'sam', roles: ['supervisor'], scope: null },
    };
}
