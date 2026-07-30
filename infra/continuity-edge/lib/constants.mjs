export const CONTINUITY_LAYOUT_VERSION = 'continuity-v1';
export const POINTER_FORMAT = 'continuity-current-v1';
export const EDGE_ACCESS_FORMAT = 'vhhealth_continuity_edge_access/v1';
export const MANIFEST_FORMAT = 'vhhealth_clinical_continuity_manifest/v1';
export const POLICY_RECEIPT_FORMAT = 'vhhealth_continuity_policy_receipt/v1';
export const FLOORS_FORMAT = 'vhhealth_continuity_edge_floors/v1';
export const FLOOR_BOOTSTRAP_FORMAT = 'vhhealth_continuity_edge_floor_bootstrap/v1';
export const LOG_BATCH_FORMAT = 'vhhealth_continuity_edge_log_batch/v1';
export const AUDIT_EVENT_FORMAT = 'vhhealth_continuity_edge_access_event/v1';
export const AUDIT_HEAD_FORMAT = 'vhhealth_continuity_edge_audit_head/v1';

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
export const LOCATION_TYPES = new Set(['ward', 'paeds', 'ed_board', 'opd_day']);
export const DIGEST_IMAGE_PATTERN =
  /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?@sha256:[0-9a-f]{64}$/;

export function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

export function normalizeTenantId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    !UUID_PATTERN.test(normalized) ||
    normalized === '00000000-0000-0000-0000-000000000000' ||
    normalized === '00000000-0000-4000-8000-000000000001'
  ) {
    throw new TypeError('tenantId must be a non-default UUID');
  }
  return normalized;
}

export function normalizeFacilityId(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError('facilityId must be a positive integer');
  }
  return normalized;
}

export function normalizeVersion(value, { allowZero = false } = {}) {
  const text = String(value ?? '');
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new TypeError('version must be a canonical non-negative integer');
  }
  if (!allowZero && text === '0') {
    throw new TypeError('version must be positive');
  }
  return text;
}

export function canonicalTimestamp(value, label = 'timestamp') {
  if (typeof value !== 'string') throw new TypeError(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

export function safeRelativePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/')
  ) {
    return false;
  }
  return value
    .split('/')
    .every(
      (segment) =>
        segment !== '.' &&
        segment !== '..' &&
        SAFE_SEGMENT_PATTERN.test(segment),
    );
}
