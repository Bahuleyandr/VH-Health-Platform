import { AppError } from '../../utils/AppError.js';

export const RESERVED_CARE_PATHWAYS_SETTINGS_KEY = 'care_pathways';
export const RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY = 'care_team_enforcement_mode';
export const DEFAULT_CARE_TEAM_ENFORCEMENT_MODE = 'shadow';

export const RESERVED_TENANT_SETTINGS_KEYS = Object.freeze([
  RESERVED_CARE_PATHWAYS_SETTINGS_KEY,
  RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY,
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidSettings() {
  return AppError.badRequest(
    'Tenant settings must be a plain JSON object',
    'TENANT_SETTINGS_INVALID',
  );
}

function reservedSettings() {
  return AppError.forbidden(
    'Governed tenant settings can only be changed through their dedicated tooling',
    'TENANT_SETTINGS_RESERVED',
  );
}

function assertGenericSettingsObject(settings) {
  if (!isPlainObject(settings)) throw invalidSettings();
  for (const key of RESERVED_TENANT_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) throw reservedSettings();
  }
}

export function serializeGenericTenantSettings(settings) {
  assertGenericSettingsObject(settings);
  const serialized = JSON.stringify(settings);
  const normalized = JSON.parse(serialized);
  if (!isPlainObject(normalized)) throw invalidSettings();
  for (const key of RESERVED_TENANT_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) throw reservedSettings();
  }
  return serialized;
}

export function mergeGenericTenantSettings(currentSettings, patchSettings) {
  assertGenericSettingsObject(patchSettings);
  const current = isPlainObject(currentSettings) ? currentSettings : {};
  const merged = {
    ...current,
    ...patchSettings,
  };
  for (const key of RESERVED_TENANT_SETTINGS_KEYS) delete merged[key];
  return merged;
}

export default {
  RESERVED_CARE_PATHWAYS_SETTINGS_KEY,
  RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY,
  DEFAULT_CARE_TEAM_ENFORCEMENT_MODE,
  RESERVED_TENANT_SETTINGS_KEYS,
  mergeGenericTenantSettings,
  serializeGenericTenantSettings,
};
