const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeCanonicalIdentity(value) {
  if (value === undefined || value === null) return null;
  const identity = String(value).trim();
  if (!identity) return null;
  return UUID_RE.test(identity) ? identity.toLowerCase() : identity;
}

export function resolveCanonicalTokenIdentity(decoded) {
  if (!decoded || typeof decoded !== 'object') {
    return { identity: null, conflict: false };
  }
  const claims = [
    { value: decoded.uid, kind: 'strong' },
    ...Object.entries(decoded)
      .filter(([key, value]) => (
        key.endsWith('/jwt/claims')
        && value
        && typeof value === 'object'
      ))
      .map(([, value]) => ({
        value: value['x-hasura-user-id'],
        kind: 'strong',
      })),
    { value: decoded.user_id, kind: 'app-or-projection' },
    { value: decoded.userId, kind: 'app-or-projection' },
    { value: decoded.sub, kind: 'fallback' },
    { value: decoded.id, kind: 'projection' },
  ]
    .map((claim) => ({
      ...claim,
      identity: normalizeCanonicalIdentity(claim.value),
    }))
    .filter((claim) => claim.identity !== null);

  const strongIdentities = claims
    .filter(({ identity, kind }) => (
      kind === 'strong'
      || (kind === 'app-or-projection' && !/^\d+$/.test(identity))
    ))
    .map(({ identity }) => identity);
  const hasNamedFallbackIdentity = claims.some(({ identity, kind }) => (
    kind === 'fallback' && !/^\d+$/.test(identity)
  ));
  const fallbackIdentities = claims
    .filter(({ identity, kind }) => (
      kind === 'fallback'
      || kind === 'projection'
      || (kind === 'app-or-projection' && /^\d+$/.test(identity))
    ))
    .filter(({ identity, kind }) => !(
      (kind === 'projection' || kind === 'app-or-projection')
      && hasNamedFallbackIdentity
      && /^\d+$/.test(identity)
    ))
    .map(({ identity }) => identity);
  const identities = strongIdentities.length > 0 ? strongIdentities : fallbackIdentities;
  const distinct = [...new Set(identities)];
  return {
    identity: distinct.length === 1 ? distinct[0] : null,
    conflict: distinct.length > 1,
  };
}
