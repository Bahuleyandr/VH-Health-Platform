import { AppError } from '../../utils/AppError.js';

export const RESERVED_CARE_PATHWAYS_SETTINGS_KEY = 'care_pathways';

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
    'Care pathway settings can only be changed through governed mode tooling',
    'TENANT_SETTINGS_RESERVED',
  );
}

function assertGenericSettingsObject(settings) {
  if (!isPlainObject(settings)) throw invalidSettings();
  if (Object.prototype.hasOwnProperty.call(settings, RESERVED_CARE_PATHWAYS_SETTINGS_KEY)) {
    throw reservedSettings();
  }
}

export function serializeGenericTenantSettings(settings) {
  assertGenericSettingsObject(settings);
  const serialized = JSON.stringify(settings);
  const normalized = JSON.parse(serialized);
  if (!isPlainObject(normalized)) throw invalidSettings();
  if (Object.prototype.hasOwnProperty.call(normalized, RESERVED_CARE_PATHWAYS_SETTINGS_KEY)) {
    throw reservedSettings();
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
  delete merged[RESERVED_CARE_PATHWAYS_SETTINGS_KEY];
  return merged;
}

export default {
  RESERVED_CARE_PATHWAYS_SETTINGS_KEY,
  mergeGenericTenantSettings,
  serializeGenericTenantSettings,
};
