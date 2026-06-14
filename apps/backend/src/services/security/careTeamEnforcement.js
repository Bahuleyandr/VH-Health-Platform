// src/services/security/careTeamEnforcement.js
//
// CareTeam ABAC — per-tenant enforcement-mode resolver (Phase 0).
//
// The ABAC engine (accessDecisionService.js), the data model (migration 260),
// and shadow mode already exist. This module is the per-tenant *switch* that
// decides, for a given request's tenant, whether the enforcing
// patientAccessGuard should:
//
//   * 'off'     — skip ABAC entirely (the passive phiAccessLogger still runs).
//   * 'shadow'  — run the engine in shadowMode (logs would-be denials to
//                 patient_access_audit_log, NEVER blocks, returns allowed).
//   * 'enforce' — run the engine for real (403 on a genuine deny).
//
// Platform-owner decision (2026-06-14): the DEFAULT is 'shadow', overriding the
// design doc's default-off note. Shadow is non-breaking (it can neither block
// nor 500 a PHI route — the guard wraps it in fail-open try/catch) while giving
// us full would-be-denial telemetry per tenant before anyone flips 'enforce'.
//
// Where the flag is stored: the existing `tenants.settings` JSONB column
// (tenantService.getTenantById already selects it and caches the row for 60s).
// No migration / no new column → no schema drift. Resolution order:
//   1. tenants.settings.care_team_enforcement_mode (per-tenant authority).
//   2. CARE_TEAM_ENFORCEMENT_MODE env var (deployment-wide override / pin).
//   3. DEFAULT_ENFORCEMENT_MODE ('shadow').
//
// This resolver MUST be fail-safe: any lookup error resolves to the default
// mode (shadow) rather than throwing — a tenant-settings hiccup must never turn
// into a 500 on a PHI route. The guard additionally fails OPEN, so even a
// resolver that (impossibly) threw could not block a request.

import logger from '../../logging/logger.js';
import { getTenantById, DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

export const CARE_TEAM_ENFORCEMENT_MODES = Object.freeze({
  OFF: 'off',
  SHADOW: 'shadow',
  ENFORCE: 'enforce',
});

const VALID_MODES = new Set(Object.values(CARE_TEAM_ENFORCEMENT_MODES));

// Platform-owner default. Shadow = log-only, non-breaking.
export const DEFAULT_ENFORCEMENT_MODE = CARE_TEAM_ENFORCEMENT_MODES.SHADOW;

// The settings key on tenants.settings JSONB.
export const ENFORCEMENT_MODE_SETTINGS_KEY = 'care_team_enforcement_mode';

/**
 * Normalize an arbitrary value to a valid enforcement mode, or null if it is
 * not a recognised mode. Case-insensitive, trims surrounding whitespace.
 */
export function normalizeEnforcementMode(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  return VALID_MODES.has(text) ? text : null;
}

/**
 * The deployment-wide override from the environment, if set to a valid mode.
 * Used as the fallback when a tenant has not set its own mode. Returns null
 * when unset or invalid (so the caller falls through to the literal default).
 */
export function envEnforcementMode() {
  return normalizeEnforcementMode(process.env.CARE_TEAM_ENFORCEMENT_MODE);
}

/**
 * Resolve the effective enforcement mode for a tenant id.
 *
 * Fail-safe: returns DEFAULT_ENFORCEMENT_MODE on any error or missing tenant.
 *
 * @param {string|null|undefined} tenantId
 * @returns {Promise<'off'|'shadow'|'enforce'>}
 */
export async function resolveEnforcementModeForTenant(tenantId) {
  const fallback = envEnforcementMode() || DEFAULT_ENFORCEMENT_MODE;
  const id = tenantId || DEFAULT_TENANT_ID;
  try {
    const tenant = await getTenantById(id);
    const settings = tenant?.settings;
    // settings is a JSONB column — Prisma surfaces it as an object, but be
    // tolerant of a string (older rows / raw drivers) by parsing defensively.
    let parsed = settings;
    if (typeof settings === 'string') {
      try {
        parsed = JSON.parse(settings);
      } catch {
        parsed = null;
      }
    }
    const raw = parsed && typeof parsed === 'object'
      ? parsed[ENFORCEMENT_MODE_SETTINGS_KEY]
      : null;
    const tenantMode = normalizeEnforcementMode(raw);
    return tenantMode || fallback;
  } catch (err) {
    // Never let a tenant-settings lookup failure influence PHI availability —
    // resolve to the (non-breaking) default and log at debug.
    logger.debug('care-team enforcement mode resolve fell back to default', {
      tenantId: id,
      mode: fallback,
      error: err?.message,
    });
    return fallback;
  }
}

/**
 * Resolve the effective enforcement mode for an Express request, keying off the
 * authenticated tenant (req.tenantId) with the same fallbacks tenant-id
 * resolution uses elsewhere.
 *
 * @param {import('express').Request} req
 * @returns {Promise<'off'|'shadow'|'enforce'>}
 */
export function resolveEnforcementModeForRequest(req) {
  const tenantId = req?.tenantId
    || req?.user?.tenant_id
    || req?.user?.tenantId
    || req?.tenant?.id
    || DEFAULT_TENANT_ID;
  return resolveEnforcementModeForTenant(tenantId);
}

export default {
  CARE_TEAM_ENFORCEMENT_MODES,
  DEFAULT_ENFORCEMENT_MODE,
  ENFORCEMENT_MODE_SETTINGS_KEY,
  normalizeEnforcementMode,
  envEnforcementMode,
  resolveEnforcementModeForTenant,
  resolveEnforcementModeForRequest,
};
