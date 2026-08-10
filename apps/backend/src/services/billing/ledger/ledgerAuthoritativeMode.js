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
// order (a failed tenant lookup blocks the money path rather than selecting a
// weaker mode):
//   1. tenants.settings.ledger_authoritative_mode  (per-tenant authority)
//   2. LEDGER_AUTHORITATIVE_MODE env var            (deployment-wide pin)
//   3. DEFAULT_LEDGER_MODE ('shadow')
import logger from '../../../logging/logger.js';
import { AppError } from '../../../utils/AppError.js';
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
 * A missing setting uses the documented shadow default. A lookup failure or
 * missing tenant fails closed because silently selecting post-commit mode can
 * weaken an enforce tenant's atomic money-write contract.
 * @param {string|null|undefined} tenantId
 * @returns {Promise<'off'|'shadow'|'enforce'>}
 */
export async function resolveLedgerModeForTenant(tenantId) {
  const fallback = envLedgerMode() || DEFAULT_LEDGER_MODE;
  const id = requireTenantId(tenantId);
  try {
    const tenant = await getTenantById(id);
    if (!tenant) {
      throw AppError.internal('Ledger authoritative mode is unavailable', 'LEDGER_MODE_UNAVAILABLE');
    }
    let parsed = tenant?.settings;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        throw AppError.internal('Ledger authoritative mode is unavailable', 'LEDGER_MODE_UNAVAILABLE');
      }
    }
    const raw = parsed && typeof parsed === 'object' ? parsed[LEDGER_MODE_SETTINGS_KEY] : null;
    return normalizeLedgerMode(raw) || fallback;
  } catch (err) {
    logger.error('ledger authoritative mode resolution failed closed', {
      tenantId: id, error: err?.message,
    });
    if (err instanceof AppError && err.code === 'LEDGER_MODE_UNAVAILABLE') throw err;
    throw AppError.internal('Ledger authoritative mode is unavailable', 'LEDGER_MODE_UNAVAILABLE');
  }
}

/**
 * Resolve, for a tenant, HOW a money-write caller should post its ledger entry:
 *   - sameTx     (enforce): post INSIDE the caller's setTenantTx — a ledger
 *                 failure rolls back the money write (authoritative).
 *   - postCommit (shadow):  post AFTER the tx commits, best-effort — a ledger
 *                 failure is logged but never breaks the money path (= today).
 *   - skip       (off):     do not post at all (emergency kill-switch).
 * Exactly one of the three booleans is true. Mode lookup failures reject before
 * any money mutation can choose weaker wiring.
 * @param {string|null|undefined} tenantId
 * @returns {Promise<{mode:'off'|'shadow'|'enforce', sameTx:boolean, postCommit:boolean, skip:boolean}>}
 */
export async function resolveLedgerWiring(tenantId) {
  const mode = await resolveLedgerModeForTenant(tenantId);
  return {
    mode,
    sameTx: mode === LEDGER_AUTHORITATIVE_MODES.ENFORCE,
    postCommit: mode === LEDGER_AUTHORITATIVE_MODES.SHADOW,
    skip: mode === LEDGER_AUTHORITATIVE_MODES.OFF,
  };
}

export default {
  LEDGER_AUTHORITATIVE_MODES,
  DEFAULT_LEDGER_MODE,
  LEDGER_MODE_SETTINGS_KEY,
  normalizeLedgerMode,
  envLedgerMode,
  resolveLedgerModeForTenant,
  resolveLedgerWiring,
};
