import logger from '../../logging/logger.js';
import { getTenantById, requireTenantId } from '../tenant/tenantService.js';

export const CARE_PATHWAY_KEYS = Object.freeze({
  DIAGNOSTICS: 'diagnostics_order_to_action',
  REFERRAL: 'referral_request_to_closure',
  OP: 'op_contact_to_recovery',
  INPATIENT: 'inpatient_admission_to_recovery',
  EMERGENCY: 'emergency_arrival_to_aftercare',
  SURGERY: 'surgery_decision_to_recovery',
});

export const CANONICAL_PATHWAY_KEYS = Object.freeze(Object.values(CARE_PATHWAY_KEYS));

export const PATHWAY_MODES = Object.freeze({
  OFF: 'off',
  SHADOW: 'shadow',
  ACTIVE: 'active',
});

export const DEFAULT_PATHWAY_MODE = PATHWAY_MODES.OFF;
export const CARE_PATHWAYS_SETTINGS_KEY = 'care_pathways';

const CANONICAL_PATHWAY_KEY_SET = new Set(CANONICAL_PATHWAY_KEYS);
const VALID_MODE_SET = new Set(Object.values(PATHWAY_MODES));

export function normalizePathwayMode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return VALID_MODE_SET.has(normalized) ? normalized : null;
}

function parseSettings(settings) {
  if (typeof settings !== 'string') return settings;
  try {
    return JSON.parse(settings);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwnDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || descriptor.get || descriptor.set) return undefined;
  return descriptor.value;
}

/**
 * Resolve the tenant-owned rollout mode for one canonical pathway.
 * Missing or malformed configuration always resolves to off.
 */
export async function resolvePathwayMode(tenantId, pathwayKey) {
  const id = requireTenantId(tenantId);
  if (!CANONICAL_PATHWAY_KEY_SET.has(pathwayKey)) return DEFAULT_PATHWAY_MODE;

  try {
    const tenant = await getTenantById(id);
    const settings = parseSettings(tenant?.settings);
    if (!isPlainObject(settings)) {
      return DEFAULT_PATHWAY_MODE;
    }
    const pathwaySettings = readOwnDataProperty(settings, CARE_PATHWAYS_SETTINGS_KEY);
    if (!isPlainObject(pathwaySettings)) {
      return DEFAULT_PATHWAY_MODE;
    }
    return normalizePathwayMode(readOwnDataProperty(pathwaySettings, pathwayKey))
      || DEFAULT_PATHWAY_MODE;
  } catch (err) {
    logger.debug('care pathway mode resolve fell back to off', {
      tenantId: id,
      pathwayKey,
      error: err?.message,
    });
    return DEFAULT_PATHWAY_MODE;
  }
}

export default {
  CARE_PATHWAY_KEYS,
  CANONICAL_PATHWAY_KEYS,
  PATHWAY_MODES,
  DEFAULT_PATHWAY_MODE,
  CARE_PATHWAYS_SETTINGS_KEY,
  normalizePathwayMode,
  resolvePathwayMode,
};
