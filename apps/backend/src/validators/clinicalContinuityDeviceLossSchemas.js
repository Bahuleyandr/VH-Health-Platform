import { createHash } from 'node:crypto';

import { canonicalizeJson } from '../services/downtime/continuityPackCanonical.js';
import { AppError } from '../utils/AppError.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Incident evidence must reject every C0 control plus DEL, not just line breaks.
// eslint-disable-next-line no-control-regex
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;

export const DEVICE_LOSS_SCHEMA = Object.freeze({
  id: 'clinical-continuity-device-loss',
  version: 1,
  checksum: createHash('sha256').update(canonicalizeJson({
    additionalProperties: false,
    fields: ['stable_device_id', 'affected_staff_uids', 'incident_reference', 'reason'],
    version: 1,
  })).digest('hex'),
});

function invalid(message, code = 'CONTINUITY_DEVICE_LOSS_COMMAND_INVALID') {
  throw AppError.badRequest(message, code, { safe: true });
}

function exactObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Device-loss command must be an object');
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Device-loss command contains unknown fields');
}

function uuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) invalid(`${label} must be a UUID`);
  return normalized;
}

function printable(value, label, min, max) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < min || normalized.length > max || !PRINTABLE_PATTERN.test(normalized)) {
    invalid(`${label} must contain ${min}-${max} printable characters`);
  }
  return normalized;
}

export function parseClinicalContinuityDeviceLoss(value) {
  exactObject(value, ['stable_device_id', 'affected_staff_uids', 'incident_reference', 'reason']);
  if (!Array.isArray(value.affected_staff_uids) || value.affected_staff_uids.length > 100) {
    invalid('affected_staff_uids must be an array containing at most 100 UUIDs');
  }
  const affectedStaffUids = [...new Set(value.affected_staff_uids.map((entry) => uuid(entry, 'affected_staff_uids')))].sort();
  return Object.freeze({
    stableDeviceId: uuid(value.stable_device_id, 'stable_device_id'),
    affectedStaffUids: Object.freeze(affectedStaffUids),
    incidentReference: printable(value.incident_reference, 'incident_reference', 3, 200),
    reason: printable(value.reason, 'reason', 3, 500),
  });
}

export const __testing__ = Object.freeze({ PRINTABLE_PATTERN, UUID_PATTERN });
