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

export default {
  isTenantRlsEnforcementEnabled,
};
