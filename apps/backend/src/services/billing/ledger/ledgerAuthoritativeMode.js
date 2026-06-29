// apps/backend/src/services/billing/ledger/ledgerAuthoritativeMode.js
//
// Money-ledger Phase 4 — per-tenant authoritative-mode resolver.
// Mirrors src/services/security/careTeamEnforcement.js. Modes:
//   * 'off'     — no ledger posting at all (emergency kill-switch).
//   * 'shadow'  — ledger posts POST-COMMIT best-effort; legacy amount_* columns
//                 are the independent source of truth; reconcile drift is
//                 informational. This is TODAY's behavior and the safe DEFAULT.
//   * 'enforce' — ledger post is SAME-TX atomic with the legacy write; legacy
//                 columns are DERIVED from ledger_balances; reconcile drift is a
//                 hard alert.
//
// Stored in the existing tenants.settings JSONB column (no migration). Resolution
// order (fail-safe to the default on any error — never throws into a money path):
//   1. tenants.settings.ledger_authoritative_mode  (per-tenant authority)
//   2. LEDGER_AUTHORITATIVE_MODE env var            (deployment-wide pin)
//   3. DEFAULT_LEDGER_MODE ('shadow')
import logger from '../../../logging/logger.js';
import { getTenantById, requireTenantId } from '../../tenant/tenantService.js';

export const LEDGER_AUTHORITATIVE_MODES = Object.freeze({
  OFF: 'off',
  SHADOW: 'shadow',
  ENFORCE: 'enforce',
});

const VALID_MODES = new Set(Object.values(LEDGER_AUTHORITATIVE_MODES));

// Safe default. shadow == today's behavior (post-commit best-effort, log-only drift).
export const DEFAULT_LEDGER_MODE = LEDGER_AUTHORITATIVE_MODES.SHADOW;

// The settings key on tenants.settings JSONB.
export const LEDGER_MODE_SETTINGS_KEY = 'ledger_authoritative_mode';

/** Normalize an arbitrary value to a valid mode, or null. Case-insensitive, trims. */
export function normalizeLedgerMode(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  return VALID_MODES.has(text) ? text : null;
}

/** Deployment-wide override from the environment, if set to a valid mode; else null. */
export function envLedgerMode() {
  return normalizeLedgerMode(process.env.LEDGER_AUTHORITATIVE_MODE);
}

/**
 * Resolve the effective ledger-authoritative mode for a tenant id.
 * Fail-safe: returns the default on any error or missing tenant.
 * @param {string|null|undefined} tenantId
 * @returns {Promise<'off'|'shadow'|'enforce'>}
 */
export async function resolveLedgerModeForTenant(tenantId) {
  const fallback = envLedgerMode() || DEFAULT_LEDGER_MODE;
  const id = requireTenantId(tenantId);
  try {
    const tenant = await getTenantById(id);
    let parsed = tenant?.settings;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    const raw = parsed && typeof parsed === 'object' ? parsed[LEDGER_MODE_SETTINGS_KEY] : null;
    return normalizeLedgerMode(raw) || fallback;
  } catch (err) {
    // Never let a tenant-settings hiccup influence the money path — fall back.
    logger.debug('ledger authoritative mode resolve fell back to default', {
      tenantId: id, mode: fallback, error: err?.message,
    });
    return fallback;
  }
}

export default {
  LEDGER_AUTHORITATIVE_MODES,
  DEFAULT_LEDGER_MODE,
  LEDGER_MODE_SETTINGS_KEY,
  normalizeLedgerMode,
  envLedgerMode,
  resolveLedgerModeForTenant,
};
