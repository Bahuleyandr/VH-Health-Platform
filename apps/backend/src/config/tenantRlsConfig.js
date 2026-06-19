// src/config/tenantRlsConfig.js
//
// Central switch for Phase-2 tenant RLS activation. Production should be
// tenant-isolated by default; dev/test keep the legacy permissive path unless
// a test explicitly flips AUTH_ENFORCE_TENANT_RLS=true.

export function isTenantRlsEnforcementEnabled(env = process.env) {
  const explicit = env.AUTH_ENFORCE_TENANT_RLS;
  if (explicit != null && String(explicit).trim() !== '') {
    return String(explicit).toLowerCase() === 'true';
  }
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

// Resolution policy (W1, multi-tenancy program): may a request that resolves no
// tenant fall back to the literal DEFAULT_TENANT_ID (single-tenant installs), or
// must it fail closed (403)? This is DELIBERATELY independent of
// AUTH_ENFORCE_TENANT_RLS (which governs DB-level RLS enforcement): a deployment
// can fail-closed on resolution while RLS is permissive, and vice-versa.
// Default = NOT allowed (fail closed). The current single-hospital prod opts in
// explicitly via ALLOW_DEFAULT_TENANT=true; it flips to false at the
// multi-tenant cutover.
export function isDefaultTenantAllowed(env = process.env) {
  return String(env.ALLOW_DEFAULT_TENANT ?? '').trim().toLowerCase() === 'true';
}

export default {
  isTenantRlsEnforcementEnabled,
  isDefaultTenantAllowed,
};
