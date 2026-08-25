import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

// Per-tenant terminology UI preferences (NL-5 P1).
//
// The cache is keyed PER TENANT - never a global refresh. tenant_terminology_settings
// carries RLS, so a global SELECT while an ambient tenant GUC is set could only
// see one tenant's row and poison every other cached tenant. A per-tenant WHERE
// lookup is correct under any ambient GUC and reading one tenant never mutates
// another tenant's entry.

const REFRESH_INTERVAL_MS = 60 * 1000;
const settingsCache = new Map();

export const TERMINOLOGY_SYSTEMS = Object.freeze(['ICD10', 'ICD11', 'SNOMED_CT', 'LOINC', 'ATC']);

// Downstream document surfaces governed by coding_enforcement (migration 720).
// Shape: { [surface]: 'off' | 'warn' | 'block' }; absent surface == 'off'.
// codingEnforcementService resolves the effective level (min of env + tenant).
export const CODING_ENFORCEMENT_SURFACES = Object.freeze([
  'death_certificate',
  'insurance_preauth',
  'insurance_claim',
  'discharge_summary',
]);

export const CODING_ENFORCEMENT_LEVELS = Object.freeze(['off', 'warn', 'block']);

export const DEFAULT_TERMINOLOGY_SETTINGS = Object.freeze({
  preferred_diagnosis_system: 'ICD11',
  enabled_systems: TERMINOLOGY_SYSTEMS,
  snomed_pickers_enabled: false,
  coding_enforcement: Object.freeze({}),
});

export function normalizeCodingEnforcementLevel(value) {
  if (value == null) return 'off';
  const text = String(value).trim().toLowerCase();
  return CODING_ENFORCEMENT_LEVELS.includes(text) ? text : 'off';
}

// Lenient read-side shaping: unknown surfaces and unknown levels are dropped
// so a bad row can never poison consumers; 'off' entries are elided (absent
// == off is the canonical spelling).
function shapeCodingEnforcement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const surface of CODING_ENFORCEMENT_SURFACES) {
    const level = normalizeCodingEnforcementLevel(value[surface]);
    if (level !== 'off') out[surface] = level;
  }
  return out;
}

// Strict write-side validation for PUT /terminology/settings payloads.
function normalizeCodingEnforcementInput(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(
      'coding_enforcement must be an object of surface -> off|warn|block',
      'TERMINOLOGY_SETTINGS_BAD_CODING_ENFORCEMENT',
    );
  }
  const out = {};
  for (const [surface, level] of Object.entries(value)) {
    if (!CODING_ENFORCEMENT_SURFACES.includes(surface)) {
      throw AppError.badRequest(
        `Unknown coding_enforcement surface '${surface}'`,
        'TERMINOLOGY_SETTINGS_BAD_CODING_SURFACE',
      );
    }
    const text = String(level ?? '').trim().toLowerCase();
    if (!CODING_ENFORCEMENT_LEVELS.includes(text)) {
      throw AppError.badRequest(
        `coding_enforcement.${surface} must be one of ${CODING_ENFORCEMENT_LEVELS.join(', ')}`,
        'TERMINOLOGY_SETTINGS_BAD_CODING_LEVEL',
      );
    }
    if (text !== 'off') out[surface] = text;
  }
  return out;
}

const SYSTEM_ALIASES = Object.freeze({
  icd10: 'ICD10',
  'icd-10': 'ICD10',
  icd_10: 'ICD10',
  icd11: 'ICD11',
  'icd-11': 'ICD11',
  icd_11: 'ICD11',
  snomed: 'SNOMED_CT',
  snomedct: 'SNOMED_CT',
  'snomed-ct': 'SNOMED_CT',
  snomed_ct: 'SNOMED_CT',
  sct: 'SNOMED_CT',
  loinc: 'LOINC',
  atc: 'ATC',
});

export function normalizeTerminologySystem(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (TERMINOLOGY_SYSTEMS.includes(text)) return text;
  return SYSTEM_ALIASES[text.toLowerCase()] || null;
}

function defaultSettings(tenantId = null) {
  return {
    tenant_id: tenantId ? String(tenantId) : null,
    preferred_diagnosis_system: DEFAULT_TERMINOLOGY_SETTINGS.preferred_diagnosis_system,
    enabled_systems: [...DEFAULT_TERMINOLOGY_SETTINGS.enabled_systems],
    snomed_pickers_enabled: DEFAULT_TERMINOLOGY_SETTINGS.snomed_pickers_enabled,
    coding_enforcement: {},
    is_default: true,
    created_at: null,
    updated_at: null,
  };
}

function normalizeEnabledSystems(value) {
  if (value == null) return [...DEFAULT_TERMINOLOGY_SETTINGS.enabled_systems];
  if (!Array.isArray(value)) {
    throw AppError.badRequest('enabled_systems must be an array', 'TERMINOLOGY_SETTINGS_BAD_ENABLED_SYSTEMS');
  }
  const normalized = [];
  for (const item of value) {
    const system = normalizeTerminologySystem(item);
    if (!system) {
      throw AppError.badRequest(
        `Unknown enabled terminology system '${item}'`,
        'TERMINOLOGY_SETTINGS_BAD_SYSTEM',
      );
    }
    if (!normalized.includes(system)) normalized.push(system);
  }
  if (normalized.length === 0) {
    throw AppError.badRequest('enabled_systems must contain at least one system', 'TERMINOLOGY_SETTINGS_EMPTY_SYSTEMS');
  }
  return normalized;
}

function shapeSettingsRow(row, tenantId) {
  if (!row) return defaultSettings(tenantId);
  const enabled = Array.isArray(row.enabled_systems) && row.enabled_systems.length > 0
    ? row.enabled_systems.map((s) => normalizeTerminologySystem(s)).filter(Boolean)
    : [...DEFAULT_TERMINOLOGY_SETTINGS.enabled_systems];
  return {
    tenant_id: row.tenant_id ? String(row.tenant_id) : String(tenantId),
    preferred_diagnosis_system: normalizeTerminologySystem(row.preferred_diagnosis_system)
      || DEFAULT_TERMINOLOGY_SETTINGS.preferred_diagnosis_system,
    enabled_systems: enabled.length > 0 ? enabled : [...DEFAULT_TERMINOLOGY_SETTINGS.enabled_systems],
    snomed_pickers_enabled: row.snomed_pickers_enabled === true,
    coding_enforcement: shapeCodingEnforcement(row.coding_enforcement),
    is_default: false,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export async function getTenantTerminologySettings(tenantId) {
  if (!tenantId) return defaultSettings(null);
  const key = String(tenantId);

  const cached = settingsCache.get(key);
  if (cached && Date.now() - cached.fetchedAt <= REFRESH_INTERVAL_MS) {
    return {
      ...cached.value,
      enabled_systems: [...cached.value.enabled_systems],
      coding_enforcement: { ...cached.value.coding_enforcement },
    };
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, preferred_diagnosis_system, enabled_systems,
              snomed_pickers_enabled, coding_enforcement, created_at, updated_at
         FROM tenant_terminology_settings
        WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    const value = shapeSettingsRow(rows[0], tenantId);
    settingsCache.set(key, { value, fetchedAt: Date.now() });
    return {
      ...value,
      enabled_systems: [...value.enabled_systems],
      coding_enforcement: { ...value.coding_enforcement },
    };
  } catch (err) {
    // Serve the last-known settings when the refresh fails: a tenant that
    // chose 'block' must not silently degrade to all-off because of one
    // read error (BC-L3). Only a tenant never successfully read in this
    // process falls back to defaults — loudly, because that fallback DOES
    // drop any configured enforcement for the request.
    if (cached) {
      logger.warn(
        `getTenantTerminologySettings refresh failed for tenant ${tenantId}; serving stale cache: ${err.message}`,
      );
      return {
        ...cached.value,
        enabled_systems: [...cached.value.enabled_systems],
        coding_enforcement: { ...cached.value.coding_enforcement },
      };
    }
    logger.error(
      `getTenantTerminologySettings failed for tenant ${tenantId} with no cached value; `
        + `falling back to defaults (coding enforcement OFF for this request): ${err.message}`,
    );
    return defaultSettings(tenantId);
  }
}

export async function setTenantTerminologySettings(
  tenantId,
  {
    preferredDiagnosisSystem = null,
    preferred_diagnosis_system = null,
    enabledSystems = null,
    enabled_systems = null,
    snomedPickersEnabled = null,
    snomed_pickers_enabled = null,
    codingEnforcement = null,
    coding_enforcement = null,
  } = {},
  { actorUid = null } = {},
) {
  if (!tenantId) {
    throw AppError.badRequest('tenantId is required', 'TERMINOLOGY_SETTINGS_TENANT_REQUIRED');
  }

  const current = await getTenantTerminologySettings(tenantId);
  const preferred = normalizeTerminologySystem(
    preferredDiagnosisSystem ?? preferred_diagnosis_system ?? current.preferred_diagnosis_system,
  );
  if (!preferred) {
    throw AppError.badRequest('preferred_diagnosis_system is invalid', 'TERMINOLOGY_SETTINGS_BAD_PREFERRED_SYSTEM');
  }
  const enabled = normalizeEnabledSystems(enabledSystems ?? enabled_systems ?? current.enabled_systems);
  if (!enabled.includes(preferred)) {
    throw AppError.badRequest(
      'preferred_diagnosis_system must be included in enabled_systems',
      'TERMINOLOGY_SETTINGS_PREFERRED_DISABLED',
    );
  }
  const snomedEnabled = snomedPickersEnabled ?? snomed_pickers_enabled ?? current.snomed_pickers_enabled;
  const snomedBool = snomedEnabled === true;
  const enforcementInput = codingEnforcement ?? coding_enforcement;
  const enforcement = enforcementInput != null
    ? normalizeCodingEnforcementInput(enforcementInput)
    : shapeCodingEnforcement(current.coding_enforcement);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tenant_terminology_settings
       (tenant_id, preferred_diagnosis_system, enabled_systems, snomed_pickers_enabled,
        coding_enforcement, updated_by, updated_at)
     VALUES ($1::uuid, $2, $3::text[], $4, $5::jsonb, $6::uuid, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       preferred_diagnosis_system = EXCLUDED.preferred_diagnosis_system,
       enabled_systems = EXCLUDED.enabled_systems,
       snomed_pickers_enabled = EXCLUDED.snomed_pickers_enabled,
       coding_enforcement = EXCLUDED.coding_enforcement,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING tenant_id::text AS tenant_id, preferred_diagnosis_system, enabled_systems,
               snomed_pickers_enabled, coding_enforcement, created_at, updated_at`,
    tenantId,
    preferred,
    enabled,
    snomedBool,
    JSON.stringify(enforcement),
    actorUid,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO terminology_audit_events (system_key, action, summary, actor_uid, payload)
     VALUES (NULL, 'TENANT_TERMINOLOGY_SETTINGS_UPDATED', $1, $2::uuid, $3::jsonb)`,
    `Tenant terminology settings updated for ${tenantId}`,
    actorUid,
    JSON.stringify({
      tenant_id: String(tenantId),
      preferred_diagnosis_system: preferred,
      enabled_systems: enabled,
      snomed_pickers_enabled: snomedBool,
      coding_enforcement: enforcement,
    }),
  );

  const value = shapeSettingsRow(rows[0], tenantId);
  settingsCache.set(String(tenantId), { value, fetchedAt: Date.now() });
  logger.info(`Terminology settings updated: tenant=${tenantId}`);
  return {
    ...value,
    enabled_systems: [...value.enabled_systems],
    coding_enforcement: { ...value.coding_enforcement },
  };
}

export async function isTerminologySystemEnabledForTenant(tenantId, system) {
  const systemKey = normalizeTerminologySystem(system);
  if (!systemKey) return false;
  const settings = await getTenantTerminologySettings(tenantId);
  return settings.enabled_systems.includes(systemKey);
}

export function clearTerminologySettingsCache() {
  settingsCache.clear();
}
