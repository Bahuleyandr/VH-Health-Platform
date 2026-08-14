const FORMAT = 'vhhealth_patient_minimum_version/v1';
const AUDIENCE = 'vhhealth-patient-minimum-version';
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const ENVELOPE_KEYS = Object.freeze([
  'algorithm',
  'format',
  'key_id',
  'policy',
  'signature'
]);
const POLICY_KEYS = Object.freeze([
  'audience',
  'tenant_id',
  'revision',
  'min_patient_version_code',
  'issued_at',
  'grace_until'
]);
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

export function patientMinimumVersionPolicyFromEnv(
  value = process.env.PATIENT_MINIMUM_VERSION_POLICY_JSON,
  expectedTenantId = null
) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_CONFIG_BYTES) return null;

  let envelope;
  try {
    envelope = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !hasExactKeys(envelope, ENVELOPE_KEYS)
    || envelope.algorithm !== 'Ed25519'
    || envelope.format !== FORMAT
    || typeof envelope.key_id !== 'string'
    || !KEY_ID_PATTERN.test(envelope.key_id)
    || typeof envelope.signature !== 'string'
  ) {
    return null;
  }

  let signature;
  try {
    signature = Buffer.from(envelope.signature, 'base64');
  } catch {
    return null;
  }
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature) return null;

  const policy = envelope.policy;
  if (
    !hasExactKeys(policy, POLICY_KEYS)
    || policy.audience !== AUDIENCE
    || typeof policy.tenant_id !== 'string'
    || !TENANT_ID_PATTERN.test(policy.tenant_id)
    || (expectedTenantId !== null && policy.tenant_id !== expectedTenantId)
    || !Number.isSafeInteger(policy.revision)
    || policy.revision <= 0
    || !Number.isSafeInteger(policy.min_patient_version_code)
    || policy.min_patient_version_code < 0
    || typeof policy.issued_at !== 'string'
    || typeof policy.grace_until !== 'string'
    || !UTC_TIMESTAMP_PATTERN.test(policy.issued_at)
    || !UTC_TIMESTAMP_PATTERN.test(policy.grace_until)
  ) {
    return null;
  }

  const issuedAt = Date.parse(policy.issued_at);
  const graceUntil = Date.parse(policy.grace_until);
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(graceUntil)
    || graceUntil < issuedAt
    || graceUntil - issuedAt > MAX_GRACE_MS
  ) {
    return null;
  }

  return envelope;
}
