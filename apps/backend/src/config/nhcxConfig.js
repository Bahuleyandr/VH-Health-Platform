// src/config/nhcxConfig.js
//
// NHCX P1 is intentionally inert/mock-first. Gateway-facing endpoint/header
// names in this codebase are design targets until operators lock the live
// NHCX/NRCeS version, sandbox contract, participant codes, and certificates.

export const NHCX_CONFIG = {
  enabled: String(process.env.NHCX_ENABLED || 'false').toLowerCase() === 'true',
  defaultEnvironment: 'sandbox',
  credentialCacheTtlMs: Number.parseInt(process.env.NHCX_CREDENTIAL_CACHE_TTL_MS || '60000', 10),
};

export default NHCX_CONFIG;
