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
// design doc's default-off note. Shadow is non-blocking for valid
// configuration while giving us full would-be-denial telemetry per tenant
// before anyone flips 'enforce'. Resolution failures return a real error.
//
// Where the flag is stored: the existing `tenants.settings` JSONB column
// (tenantService.getTenantById already selects it and caches the row for 60s).
// No migration / no new column → no schema drift. Resolution order:
//   1. tenants.settings.care_team_enforcement_mode (per-tenant authority).
//   2. CARE_TEAM_ENFORCEMENT_MODE env var (deployment-wide fallback).
//   3. DEFAULT_ENFORCEMENT_MODE ('shadow').
//
// A tenant with no explicit setting uses shadow. A failed lookup is different:
// the effective posture is unknown and may be enforce, so the resolver throws
// and the guard returns a real 500 instead of silently weakening access control.

import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { getTenantById, requireTenantId } from '../tenant/tenantService.js';
import {
  DEFAULT_CARE_TEAM_ENFORCEMENT_MODE,
  RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY,
} from '../tenant/tenantSettingsMutationPolicy.js';

export const CARE_TEAM_ENFORCEMENT_MODES = Object.freeze({
  OFF: 'off',
  SHADOW: 'shadow',
  ENFORCE: 'enforce',
});

const VALID_MODES = new Set(Object.values(CARE_TEAM_ENFORCEMENT_MODES));

// Platform-owner default. Shadow = log-only, non-breaking.
export const DEFAULT_ENFORCEMENT_MODE = DEFAULT_CARE_TEAM_ENFORCEMENT_MODE;

// The settings key on tenants.settings JSONB.
export const ENFORCEMENT_MODE_SETTINGS_KEY = RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY;

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
 * Normalize the deployment-wide fallback. The resolver separately
 * distinguishes an absent variable from an explicitly invalid value.
 */
export function envEnforcementMode() {
  return normalizeEnforcementMode(process.env.CARE_TEAM_ENFORCEMENT_MODE);
}

/**
 * Resolve the effective enforcement mode for a tenant id.
 *
 * A missing setting uses the documented shadow default. A lookup failure or
 * missing tenant fails closed because the resolver cannot know whether that
 * tenant explicitly selected enforce mode.
 *
 * @param {string|null|undefined} tenantId
 * @returns {Promise<'off'|'shadow'|'enforce'>}
 */
export async function resolveEnforcementModeForTenant(tenantId) {
  const id = requireTenantId(tenantId);
  try {
    const envValue = process.env.CARE_TEAM_ENFORCEMENT_MODE;
    const fallback = envValue === undefined
      ? DEFAULT_ENFORCEMENT_MODE
      : normalizeEnforcementMode(envValue);
    if (!fallback) {
      throw AppError.internal('Care-team enforcement mode is unavailable', 'CARE_TEAM_MODE_UNAVAILABLE');
    }

    const tenant = await getTenantById(id);
    if (!tenant) {
      throw AppError.internal('Care-team enforcement mode is unavailable', 'CARE_TEAM_MODE_UNAVAILABLE');
    }
    const settings = tenant?.settings;
    // settings is a JSONB column — Prisma surfaces it as an object, but be
    // tolerant of a string (older rows / raw drivers) by parsing defensively.
    let parsed = settings;
    if (typeof settings === 'string') {
      try {
        parsed = JSON.parse(settings);
      } catch {
        throw AppError.internal('Care-team enforcement mode is unavailable', 'CARE_TEAM_MODE_UNAVAILABLE');
      }
    }
    const hasTenantSetting = parsed
      && typeof parsed === 'object'
      && Object.prototype.hasOwnProperty.call(parsed, ENFORCEMENT_MODE_SETTINGS_KEY);
    if (!hasTenantSetting) return fallback;

    const tenantMode = normalizeEnforcementMode(parsed[ENFORCEMENT_MODE_SETTINGS_KEY]);
    if (!tenantMode) {
      throw AppError.internal('Care-team enforcement mode is unavailable', 'CARE_TEAM_MODE_UNAVAILABLE');
    }
    return tenantMode;
  } catch (err) {
    logger.error('care-team enforcement mode resolution failed closed', {
      tenantId: id,
      error: err?.message,
    });
    if (err instanceof AppError && err.code === 'CARE_TEAM_MODE_UNAVAILABLE') throw err;
    throw AppError.internal('Care-team enforcement mode is unavailable', 'CARE_TEAM_MODE_UNAVAILABLE');
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
  const tenantId = requireTenantId(
    req?.tenantId
    || req?.user?.tenant_id
    || req?.user?.tenantId
    || req?.tenant?.id,
  );
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
