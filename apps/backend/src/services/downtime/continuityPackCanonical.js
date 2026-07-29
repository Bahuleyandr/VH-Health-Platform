import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';

export const SIGNATURE_ALGORITHM = 'Ed25519';
export const PACK_ENVELOPE_VERSION = 1;

export const CANONICAL_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxUtf8Bytes: 2 * 1024 * 1024,
});

export const MAX_RENDER_UTF8_BYTES = 4 * 1024 * 1024;
export const ED25519_SIGNATURE_BASE64_LENGTH = 88;

export const KEY_STATES = Object.freeze({
  CURRENT: 'current',
  NEXT: 'next',
  REVOKED: 'revoked',
  COMPROMISED: 'compromised',
});

export const FRESHNESS_STATES = Object.freeze({
  CURRENT: 'CURRENT',
  AGED: 'AGED',
  EXPIRED: 'EXPIRED',
  CLOCK_UNCERTAIN: 'CLOCK_UNCERTAIN',
});

export const FRESHNESS_LIMITS_MS = Object.freeze({
  current: 15 * 60 * 1000,
  expires: 24 * 60 * 60 * 1000,
});

export const VERIFICATION_REASONS = Object.freeze({
  INVALID_ENVELOPE: 'INVALID_ENVELOPE',
  UNSUPPORTED_ALGORITHM: 'UNSUPPORTED_ALGORITHM',
  KEY_ID_MISMATCH: 'KEY_ID_MISMATCH',
  KEY_NOT_TRUSTED: 'KEY_NOT_TRUSTED',
  KEY_REVOKED: 'KEY_REVOKED',
  KEY_COMPROMISED: 'KEY_COMPROMISED',
  KEY_STATE_UNSUPPORTED: 'KEY_STATE_UNSUPPORTED',
  KEY_INVALID: 'KEY_INVALID',
  AUDIENCE_REQUIRED: 'AUDIENCE_REQUIRED',
  AUDIENCE_MISMATCH: 'AUDIENCE_MISMATCH',
  CONTENT_HASH_MISMATCH: 'CONTENT_HASH_MISMATCH',
  RENDER_HASH_MISMATCH: 'RENDER_HASH_MISMATCH',
  RENDER_REQUIRED: 'RENDER_REQUIRED',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  POLICY_ROLLBACK: 'POLICY_ROLLBACK',
  MANIFEST_ROLLBACK: 'MANIFEST_ROLLBACK',
  REVOCATION_EPOCH_ROLLBACK: 'REVOCATION_EPOCH_ROLLBACK',
  ROLLBACK_STATE_REQUIRED: 'ROLLBACK_STATE_REQUIRED',
  PACK_EXPIRED: 'PACK_EXPIRED',
  CLOCK_UNCERTAIN: 'CLOCK_UNCERTAIN',
  CANONICALIZATION_FAILED: 'CANONICALIZATION_FAILED',
});

const ENVELOPE_FIELDS = Object.freeze([
  'algorithm',
  'audience',
  'content',
  'contentHash',
  'envelopeVersion',
  'expiresAt',
  'issuedAt',
  'keyId',
  'manifestVersion',
  'policyVersion',
  'revocationEpoch',
  'renderHash',
  'signature',
]);

const HASH_HEX_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_SIGNED_BIGINT_DECIMAL = '9223372036854775807';
const VERSION_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const OBJECT_PROTOTYPE_NAMES = Object.freeze(
  Object.getOwnPropertyNames(Object.prototype).sort(),
);
const PREPARED_SIGNING_REQUEST = Symbol('continuityPackPreparedSigningRequest');

export class CanonicalizationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'CanonicalizationError';
    this.code = code;
  }
}

function canonicalError(code, message) {
  throw new CanonicalizationError(code, message);
}

function assertWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        canonicalError(
          'CANONICAL_LONE_SURROGATE',
          'Canonical JSON does not permit lone UTF-16 surrogates',
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      canonicalError(
        'CANONICAL_LONE_SURROGATE',
        'Canonical JSON does not permit lone UTF-16 surrogates',
      );
    }
  }
}

function jsonStringUtf8Bytes(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (
      codeUnit === 0x08
      || codeUnit === 0x09
      || codeUnit === 0x0a
      || codeUnit === 0x0c
      || codeUnit === 0x0d
    ) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes += 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function normalizeCanonicalLimits(limits = {}) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('Canonical limits must be an object');
  }

  const normalized = {
    maxDepth: limits.maxDepth ?? CANONICAL_LIMITS.maxDepth,
    maxNodes: limits.maxNodes ?? CANONICAL_LIMITS.maxNodes,
    maxUtf8Bytes: limits.maxUtf8Bytes ?? CANONICAL_LIMITS.maxUtf8Bytes,
  };

  if (!Number.isSafeInteger(normalized.maxDepth) || normalized.maxDepth < 0) {
    throw new RangeError('maxDepth must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(normalized.maxNodes) || normalized.maxNodes < 1) {
    throw new RangeError('maxNodes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(normalized.maxUtf8Bytes) || normalized.maxUtf8Bytes < 1) {
    throw new RangeError('maxUtf8Bytes must be a positive safe integer');
  }

  return normalized;
}

function appendCanonical(state, text) {
  const nextBytes = state.bytes + Buffer.byteLength(text, 'utf8');
  if (nextBytes > state.limits.maxUtf8Bytes) {
    canonicalError(
      'CANONICAL_BYTE_LIMIT',
      'Canonical JSON exceeds the configured UTF-8 byte limit',
    );
  }
  state.bytes = nextBytes;
  state.chunks.push(text);
}

function appendCanonicalString(state, value) {
  assertWellFormedUnicode(value);
  const nextBytes = state.bytes + jsonStringUtf8Bytes(value);
  if (nextBytes > state.limits.maxUtf8Bytes) {
    canonicalError(
      'CANONICAL_BYTE_LIMIT',
      'Canonical JSON exceeds the configured UTF-8 byte limit',
    );
  }
  state.bytes = nextBytes;
  state.chunks.push(JSON.stringify(value));
}

function countCanonicalNode(state) {
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    canonicalError(
      'CANONICAL_NODE_LIMIT',
      'Canonical JSON exceeds the configured node limit',
    );
  }
}

function assertContainerDepth(state, depth) {
  if (depth > state.limits.maxDepth) {
    canonicalError(
      'CANONICAL_DEPTH_LIMIT',
      'Canonical JSON exceeds the configured depth limit',
    );
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const prototypeNames = Object.getOwnPropertyNames(prototype).sort();
  return (
    prototypeNames.length === OBJECT_PROTOTYPE_NAMES.length
    && prototypeNames.every((name, index) => name === OBJECT_PROTOTYPE_NAMES[index])
  );
}

function writeCanonicalArray(value, state, depth) {
  assertContainerDepth(state, depth);
  if (value.length > state.limits.maxNodes - state.nodes) {
    canonicalError(
      'CANONICAL_NODE_LIMIT',
      'Canonical JSON exceeds the configured node limit',
    );
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      canonicalError('CANONICAL_SYMBOL_KEY', 'Canonical JSON does not permit symbol keys');
    }
    if (key === 'length') continue;
    const arrayIndex = Number(key);
    if (
      !Number.isSafeInteger(arrayIndex)
      || arrayIndex < 0
      || arrayIndex >= value.length
      || String(arrayIndex) !== key
    ) {
      canonicalError(
        'CANONICAL_ARRAY_PROPERTY',
        'Canonical JSON arrays cannot contain named properties',
      );
    }
  }

  state.ancestors.add(value);
  appendCanonical(state, '[');
  try {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        canonicalError(
          'CANONICAL_SPARSE_ARRAY',
          'Canonical JSON does not permit sparse arrays',
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        canonicalError(
          'CANONICAL_ACCESSOR',
          'Canonical JSON does not permit array accessors',
        );
      }
      if (index > 0) appendCanonical(state, ',');
      writeCanonicalValue(descriptor.value, state, depth + 1);
    }
  } finally {
    state.ancestors.delete(value);
  }
  appendCanonical(state, ']');
}

function writeCanonicalObject(value, state, depth) {
  assertContainerDepth(state, depth);
  if (!isPlainRecord(value)) {
    canonicalError(
      'CANONICAL_UNSUPPORTED_OBJECT',
      'Canonical JSON accepts only plain objects and arrays',
    );
  }

  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      canonicalError('CANONICAL_SYMBOL_KEY', 'Canonical JSON does not permit symbol keys');
    }
  }

  const keys = ownKeys;
  if (keys.length > state.limits.maxNodes - state.nodes) {
    canonicalError(
      'CANONICAL_NODE_LIMIT',
      'Canonical JSON exceeds the configured node limit',
    );
  }
  keys.sort();

  state.ancestors.add(value);
  appendCanonical(state, '{');
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      assertWellFormedUnicode(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        canonicalError(
          'CANONICAL_ACCESSOR',
          'Canonical JSON accepts only enumerable data properties',
        );
      }
      if (index > 0) appendCanonical(state, ',');
      appendCanonicalString(state, key);
      appendCanonical(state, ':');
      writeCanonicalValue(descriptor.value, state, depth + 1);
    }
  } finally {
    state.ancestors.delete(value);
  }
  appendCanonical(state, '}');
}

function writeCanonicalValue(value, state, depth) {
  countCanonicalNode(state);

  if (value === null) {
    appendCanonical(state, 'null');
    return;
  }

  switch (typeof value) {
    case 'boolean':
      appendCanonical(state, value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        canonicalError(
          'CANONICAL_NON_FINITE_NUMBER',
          'Canonical JSON does not permit non-finite numbers',
        );
      }
      appendCanonical(state, JSON.stringify(value));
      return;
    case 'string':
      appendCanonicalString(state, value);
      return;
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      canonicalError(
        'CANONICAL_UNSUPPORTED_TYPE',
        `Canonical JSON does not permit values of type ${typeof value}`,
      );
      return;
    case 'object':
      if (state.ancestors.has(value)) {
        canonicalError('CANONICAL_CYCLE', 'Canonical JSON does not permit cycles');
      }
      if (Array.isArray(value)) {
        writeCanonicalArray(value, state, depth);
      } else {
        writeCanonicalObject(value, state, depth);
      }
      return;
    default:
      canonicalError('CANONICAL_UNSUPPORTED_TYPE', 'Unsupported canonical JSON value');
  }
}

/**
 * Serialize a JSON-domain value according to RFC 8785 / JCS ordering and
 * ECMAScript scalar serialization rules. Inputs outside the JSON data model
 * are rejected instead of being silently omitted or coerced.
 */
export function canonicalizeJson(value, limits = {}) {
  const state = {
    ancestors: new WeakSet(),
    bytes: 0,
    chunks: [],
    limits: normalizeCanonicalLimits(limits),
    nodes: 0,
  };
  writeCanonicalValue(value, state, 0);
  return state.chunks.join('');
}

function freezeJsonSnapshot(value) {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeJsonSnapshot(nested);
    if (!Array.isArray(value)) Object.setPrototypeOf(value, null);
    Object.freeze(value);
  }
  return value;
}

function canonicalSnapshot(value, limits = {}) {
  const canonical = canonicalizeJson(value, limits);
  return {
    canonical,
    value: freezeJsonSnapshot(JSON.parse(canonical)),
  };
}

function bytesForHash(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('SHA-256 input must be a string, Buffer, or Uint8Array');
}

export function sha256Hex(input) {
  if (typeof input === 'string') {
    assertWellFormedUnicode(input);
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }
  return createHash('sha256').update(bytesForHash(input)).digest('hex');
}

export function hashCanonicalValue(value, limits = {}) {
  return sha256Hex(canonicalizeJson(value, limits));
}

export function hashRenderedOutput(rendered, { maxUtf8Bytes = MAX_RENDER_UTF8_BYTES } = {}) {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 1) {
    throw new RangeError('maxUtf8Bytes must be a positive safe integer');
  }
  if (typeof rendered === 'string') {
    assertWellFormedUnicode(rendered);
    if (Buffer.byteLength(rendered, 'utf8') > maxUtf8Bytes) {
      throw new RangeError('Rendered output exceeds the configured UTF-8 byte limit');
    }
    return sha256Hex(rendered);
  }
  const bytes = bytesForHash(rendered);
  if (bytes.byteLength > maxUtf8Bytes) {
    throw new RangeError('Rendered output exceeds the configured UTF-8 byte limit');
  }
  return sha256Hex(bytes);
}

function ed25519PrivateKey(privateKey) {
  let keyObject;
  try {
    keyObject = privateKey?.type === 'private' && typeof privateKey.export === 'function'
      ? privateKey
      : createPrivateKey(privateKey);
  } catch {
    throw new TypeError('A valid Ed25519 private KeyObject or PEM is required');
  }
  if (keyObject.type !== 'private' || keyObject.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('A valid Ed25519 private KeyObject or PEM is required');
  }
  return keyObject;
}

function ed25519PublicKey(publicKey) {
  let keyObject;
  try {
    if (
      (publicKey?.type === 'public' || publicKey?.type === 'private')
      && typeof publicKey.export === 'function'
    ) {
      keyObject = publicKey.type === 'public' ? publicKey : createPublicKey(publicKey);
    } else {
      keyObject = createPublicKey(publicKey);
    }
  } catch {
    throw new TypeError('A valid Ed25519 public KeyObject or PEM is required');
  }
  if (keyObject.type !== 'public' || keyObject.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('A valid Ed25519 public KeyObject or PEM is required');
  }
  return keyObject;
}

function decodeEd25519Signature(signature) {
  if (
    typeof signature !== 'string'
    || signature.length !== ED25519_SIGNATURE_BASE64_LENGTH
    || !BASE64_PATTERN.test(signature)
  ) {
    throw new TypeError('Ed25519 signature must be canonical base64');
  }
  const decoded = Buffer.from(signature, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== signature) {
    throw new TypeError('Ed25519 signature must be a 64-byte canonical base64 value');
  }
  return decoded;
}

export function signCanonicalValue(value, privateKey, { limits = {} } = {}) {
  const bytes = Buffer.from(canonicalizeJson(value, limits), 'utf8');
  return cryptoSign(null, bytes, ed25519PrivateKey(privateKey)).toString('base64');
}

export function verifyCanonicalValue(
  value,
  signature,
  publicKey,
  { limits = {} } = {},
) {
  try {
    const bytes = Buffer.from(canonicalizeJson(value, limits), 'utf8');
    return cryptoVerify(
      null,
      bytes,
      ed25519PublicKey(publicKey),
      decodeEd25519Signature(signature),
    );
  } catch {
    return false;
  }
}

function versionDecimal(value, { allowZero = false } = {}) {
  let decimal;
  if (typeof value === 'bigint') {
    decimal = value.toString();
  } else if (Number.isSafeInteger(value)) {
    decimal = String(value);
  } else if (typeof value === 'string') {
    decimal = value;
  } else {
    return null;
  }

  if (
    !VERSION_PATTERN.test(decimal)
    || (!allowZero && decimal === '0')
    || (
      decimal.length === MAX_SIGNED_BIGINT_DECIMAL.length
      && decimal > MAX_SIGNED_BIGINT_DECIMAL
    )
  ) {
    return null;
  }
  return decimal;
}

export function normalizeGovernanceVersion(value, { allowZero = false } = {}) {
  const normalized = versionDecimal(value, { allowZero });
  if (normalized === null) {
    throw new RangeError('Governance version must be a canonical signed-BIGINT value');
  }
  return normalized;
}

function validVersion(value) {
  return versionDecimal(value) !== null;
}

function validEnvelopeVersion(value) {
  return typeof value === 'string' && validVersion(value);
}

function validEnvelopeEpoch(value) {
  return (
    typeof value === 'string'
    && versionDecimal(value, { allowZero: true }) === value
  );
}

function normalizeVersionFloor(value, label) {
  const normalized = value ?? 0;
  const decimal = versionDecimal(normalized, { allowZero: true });
  if (decimal === null) {
    throw new RangeError(`${label} must be a canonical non-negative BIGINT value`);
  }
  return decimal;
}

function compareVersionDecimals(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function assessMonotonicVersions(
  { policyVersion, manifestVersion, revocationEpoch = 0 },
  {
    minimumPolicyVersion = 0,
    minimumManifestVersion = 0,
    minimumRevocationEpoch = 0,
  } = {},
) {
  const policyFloor = normalizeVersionFloor(minimumPolicyVersion, 'minimumPolicyVersion');
  const manifestFloor = normalizeVersionFloor(
    minimumManifestVersion,
    'minimumManifestVersion',
  );
  const revocationFloor = normalizeVersionFloor(
    minimumRevocationEpoch,
    'minimumRevocationEpoch',
  );

  const policyDecimal = versionDecimal(policyVersion);
  const manifestDecimal = versionDecimal(manifestVersion);
  const revocationDecimal = versionDecimal(revocationEpoch, { allowZero: true });
  if (
    policyDecimal === null
    || manifestDecimal === null
    || revocationDecimal === null
  ) {
    return { ok: false, reason: VERIFICATION_REASONS.INVALID_ENVELOPE };
  }
  if (compareVersionDecimals(policyDecimal, policyFloor) < 0) {
    return {
      ok: false,
      reason: VERIFICATION_REASONS.POLICY_ROLLBACK,
      minimumPolicyVersion: policyFloor,
    };
  }
  if (compareVersionDecimals(manifestDecimal, manifestFloor) < 0) {
    return {
      ok: false,
      reason: VERIFICATION_REASONS.MANIFEST_ROLLBACK,
      minimumManifestVersion: manifestFloor,
    };
  }
  if (compareVersionDecimals(revocationDecimal, revocationFloor) < 0) {
    return {
      ok: false,
      reason: VERIFICATION_REASONS.REVOCATION_EPOCH_ROLLBACK,
      minimumRevocationEpoch: revocationFloor,
    };
  }
  return {
    ok: true,
    policyVersion,
    manifestVersion,
    revocationEpoch,
    normalizedPolicyVersion: policyDecimal,
    normalizedManifestVersion: manifestDecimal,
    normalizedRevocationEpoch: revocationDecimal,
  };
}

export function assertMonotonicVersions(versions, floors = {}) {
  const decision = assessMonotonicVersions(versions, floors);
  if (!decision.ok) {
    const error = new Error(`Continuity pack rejected: ${decision.reason}`);
    error.code = decision.reason;
    throw error;
  }
  return decision;
}

function normalizeAudience(audience, { requireCanonical = false } = {}) {
  if (!audience || typeof audience !== 'object' || !isPlainRecord(audience)) {
    return null;
  }
  const keys = Reflect.ownKeys(audience);
  if (
    keys.length !== 2
    || keys.some((key) => key !== 'tenantId' && key !== 'facilityId')
  ) {
    return null;
  }

  const tenantDescriptor = Object.getOwnPropertyDescriptor(audience, 'tenantId');
  const facilityDescriptor = Object.getOwnPropertyDescriptor(audience, 'facilityId');
  if (
    !tenantDescriptor?.enumerable
    || !facilityDescriptor?.enumerable
    || !Object.hasOwn(tenantDescriptor, 'value')
    || !Object.hasOwn(facilityDescriptor, 'value')
  ) {
    return null;
  }

  const tenantId = tenantDescriptor.value;
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.toLowerCase() : '';
  const facilityId = versionDecimal(facilityDescriptor.value);
  if (!TENANT_ID_PATTERN.test(normalizedTenantId) || facilityId === null) {
    return null;
  }
  if (
    requireCanonical
    && (
      tenantId !== normalizedTenantId
      || typeof facilityDescriptor.value !== 'string'
      || facilityDescriptor.value !== facilityId
    )
  ) {
    return null;
  }
  return { tenantId: normalizedTenantId, facilityId };
}

function audiencesEqual(left, right) {
  return left.tenantId === right.tenantId && left.facilityId === right.facilityId;
}

function trustedKeyEntry(trustedKeys, keyId) {
  if (trustedKeys instanceof Map) return trustedKeys.get(keyId);
  if (Array.isArray(trustedKeys)) {
    return trustedKeys.find((entry) => entry?.keyId === keyId);
  }
  if (
    trustedKeys
    && typeof trustedKeys === 'object'
    && Object.hasOwn(trustedKeys, keyId)
  ) {
    return trustedKeys[keyId];
  }
  return undefined;
}

function directKeyMaterial(value) {
  return (
    typeof value === 'string'
    || Buffer.isBuffer(value)
    || (
      value
      && typeof value === 'object'
      && (value.type === 'public' || value.type === 'private')
      && typeof value.export === 'function'
    )
  );
}

export function assessSigningKey({
  keyId,
  algorithm,
  trustedKeys,
  expectedKeyId,
}) {
  if (algorithm !== SIGNATURE_ALGORITHM) {
    return { ok: false, reason: VERIFICATION_REASONS.UNSUPPORTED_ALGORITHM };
  }
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    return { ok: false, reason: VERIFICATION_REASONS.INVALID_ENVELOPE };
  }
  if (expectedKeyId !== undefined && expectedKeyId !== keyId) {
    return { ok: false, reason: VERIFICATION_REASONS.KEY_ID_MISMATCH };
  }

  const entry = trustedKeyEntry(trustedKeys, keyId);
  if (entry === undefined) {
    return { ok: false, reason: VERIFICATION_REASONS.KEY_NOT_TRUSTED };
  }

  const record = directKeyMaterial(entry)
    ? { publicKey: entry, state: undefined }
    : entry;
  if (!record || typeof record !== 'object') {
    return { ok: false, reason: VERIFICATION_REASONS.KEY_INVALID };
  }
  if (record.keyId !== undefined && record.keyId !== keyId) {
    return { ok: false, reason: VERIFICATION_REASONS.KEY_ID_MISMATCH };
  }
  if (record.algorithm !== undefined && record.algorithm !== SIGNATURE_ALGORITHM) {
    return { ok: false, reason: VERIFICATION_REASONS.UNSUPPORTED_ALGORITHM };
  }

  const state = record.state ?? record.status;
  if (state === KEY_STATES.REVOKED) {
    return {
      ok: false,
      keyId,
      state,
      reason: VERIFICATION_REASONS.KEY_REVOKED,
    };
  }
  if (state === KEY_STATES.COMPROMISED) {
    return {
      ok: false,
      keyId,
      state,
      reason: VERIFICATION_REASONS.KEY_COMPROMISED,
    };
  }
  if (state !== KEY_STATES.CURRENT && state !== KEY_STATES.NEXT) {
    return {
      ok: false,
      keyId,
      state,
      reason: VERIFICATION_REASONS.KEY_STATE_UNSUPPORTED,
    };
  }

  try {
    return {
      ok: true,
      keyId,
      state,
      publicKey: ed25519PublicKey(record.publicKey ?? record.key),
    };
  } catch {
    return {
      ok: false,
      keyId,
      state,
      reason: VERIFICATION_REASONS.KEY_INVALID,
    };
  }
}

function timestampMs(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = ISO_UTC_PATTERN.exec(value);
  if (!match) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;

  const parsed = new Date(time);
  const milliseconds = Number((match[7] || '').padEnd(3, '0') || 0);
  if (
    parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
    || parsed.getUTCHours() !== Number(match[4])
    || parsed.getUTCMinutes() !== Number(match[5])
    || parsed.getUTCSeconds() !== Number(match[6])
    || parsed.getUTCMilliseconds() !== milliseconds
  ) {
    return null;
  }
  return time;
}

function canonicalEnvelopeTimestamp(value) {
  return typeof value === 'string' && timestampMs(value) !== null;
}

function freshnessDecision(state, ageMs, reason = null) {
  const packAllowed = (
    state === FRESHNESS_STATES.CURRENT
    || state === FRESHNESS_STATES.AGED
  );
  return {
    state,
    ageMs,
    reason,
    packAccess: {
      display: packAllowed,
      print: packAllowed,
    },
    fallback: {
      paper: !packAllowed,
      phone: !packAllowed,
    },
  };
}

export function assessPackFreshness({
  issuedAt,
  expiresAt,
  trustedNow,
  minimumTrustedNow,
  clockTrusted = false,
}) {
  if (clockTrusted !== true) {
    return freshnessDecision(
      FRESHNESS_STATES.CLOCK_UNCERTAIN,
      null,
      'TRUSTED_CLOCK_REQUIRED',
    );
  }

  const issuedAtMs = timestampMs(issuedAt);
  const expiresAtMs = timestampMs(expiresAt);
  const nowMs = timestampMs(trustedNow);
  const minimumTrustedNowMs = minimumTrustedNow === undefined
    ? null
    : timestampMs(minimumTrustedNow);
  if (
    issuedAtMs === null
    || expiresAtMs === null
    || nowMs === null
    || (minimumTrustedNow !== undefined && minimumTrustedNowMs === null)
    || expiresAtMs <= issuedAtMs
    || nowMs < issuedAtMs
    || (minimumTrustedNowMs !== null && nowMs < minimumTrustedNowMs)
  ) {
    return freshnessDecision(
      FRESHNESS_STATES.CLOCK_UNCERTAIN,
      null,
      'INVALID_OR_INCONSISTENT_TIME',
    );
  }

  const ageMs = nowMs - issuedAtMs;
  const effectiveExpiryMs = Math.min(
    expiresAtMs,
    issuedAtMs + FRESHNESS_LIMITS_MS.expires,
  );
  if (nowMs >= effectiveExpiryMs || ageMs >= FRESHNESS_LIMITS_MS.expires) {
    return freshnessDecision(FRESHNESS_STATES.EXPIRED, ageMs);
  }
  if (ageMs <= FRESHNESS_LIMITS_MS.current) {
    return freshnessDecision(FRESHNESS_STATES.CURRENT, ageMs);
  }
  return freshnessDecision(FRESHNESS_STATES.AGED, ageMs);
}

function normalizedTimestamp(value, label) {
  const time = timestampMs(value);
  if (time === null) {
    throw new TypeError(`${label} must be an ISO-8601 UTC timestamp, Date, or epoch milliseconds`);
  }
  return new Date(time).toISOString();
}

function unsignedEnvelope(fields) {
  return {
    algorithm: fields.algorithm,
    audience: fields.audience,
    content: fields.content,
    contentHash: fields.contentHash,
    envelopeVersion: fields.envelopeVersion,
    expiresAt: fields.expiresAt,
    issuedAt: fields.issuedAt,
    keyId: fields.keyId,
    manifestVersion: fields.manifestVersion,
    policyVersion: fields.policyVersion,
    revocationEpoch: fields.revocationEpoch,
    renderHash: fields.renderHash,
  };
}

export function prepareSignedPackEnvelope({
  content,
  rendered,
  audience,
  keyId,
  manifestVersion,
  policyVersion,
  revocationEpoch = 0,
  issuedAt,
  expiresAt,
  limits = {},
  maxRenderUtf8Bytes = MAX_RENDER_UTF8_BYTES,
}) {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw new TypeError('keyId must be a bounded continuity signing-key identifier');
  }
  if (!validVersion(manifestVersion) || !validVersion(policyVersion)) {
    throw new TypeError(
      'manifestVersion and policyVersion must be positive canonical BIGINT values',
    );
  }
  const normalizedRevocationEpoch = versionDecimal(revocationEpoch, { allowZero: true });
  if (normalizedRevocationEpoch === null) {
    throw new TypeError('revocationEpoch must be a canonical non-negative BIGINT value');
  }
  let normalizedAudience;
  try {
    normalizedAudience = normalizeAudience(audience);
  } catch {
    normalizedAudience = null;
  }
  if (!normalizedAudience) {
    throw new TypeError('audience must contain a tenant UUID and positive facilityId');
  }

  const normalizedIssuedAt = normalizedTimestamp(issuedAt, 'issuedAt');
  const normalizedExpiresAt = normalizedTimestamp(expiresAt, 'expiresAt');
  if (Date.parse(normalizedExpiresAt) <= Date.parse(normalizedIssuedAt)) {
    throw new RangeError('expiresAt must be later than issuedAt');
  }

  const contentSnapshot = canonicalSnapshot(content, limits);
  const fields = {
    algorithm: SIGNATURE_ALGORITHM,
    audience: normalizedAudience,
    content: contentSnapshot.value,
    contentHash: sha256Hex(contentSnapshot.canonical),
    envelopeVersion: PACK_ENVELOPE_VERSION,
    expiresAt: normalizedExpiresAt,
    issuedAt: normalizedIssuedAt,
    keyId,
    manifestVersion: versionDecimal(manifestVersion),
    policyVersion: versionDecimal(policyVersion),
    revocationEpoch: normalizedRevocationEpoch,
    renderHash: hashRenderedOutput(rendered, { maxUtf8Bytes: maxRenderUtf8Bytes }),
  };
  const signingSnapshot = canonicalSnapshot(unsignedEnvelope(fields), limits);
  const signingState = Object.freeze({
    canonical: signingSnapshot.canonical,
    unsignedEnvelope: signingSnapshot.value,
  });
  const prepared = {};
  Object.defineProperties(prepared, {
    unsignedEnvelope: {
      enumerable: true,
      value: signingState.unsignedEnvelope,
    },
    signingBytes: {
      enumerable: true,
      get() {
        return Buffer.from(signingState.canonical, 'utf8');
      },
    },
    [PREPARED_SIGNING_REQUEST]: {
      value: signingState,
    },
  });
  return Object.freeze(prepared);
}

export function completeSignedPackEnvelope(prepared, signature) {
  const signingState = prepared?.[PREPARED_SIGNING_REQUEST];
  if (
    !signingState
    || prepared.unsignedEnvelope !== signingState.unsignedEnvelope
  ) {
    throw new TypeError(
      'prepared must be an envelope signing request returned by prepareSignedPackEnvelope',
    );
  }
  decodeEd25519Signature(signature);

  return {
    ...signingState.unsignedEnvelope,
    audience: { ...signingState.unsignedEnvelope.audience },
    signature,
  };
}

export function createSignedPackEnvelope({
  privateKey,
  ...fields
}) {
  const prepared = prepareSignedPackEnvelope(fields);
  const signature = cryptoSign(
    null,
    prepared.signingBytes,
    ed25519PrivateKey(privateKey),
  ).toString('base64');
  return completeSignedPackEnvelope(prepared, signature);
}

function envelopeFields(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !isPlainRecord(value)
  ) {
    return null;
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== ENVELOPE_FIELDS.length
    || ownKeys.some((key) => typeof key !== 'string' || !ENVELOPE_FIELDS.includes(key))
  ) {
    return null;
  }

  const fields = {};
  for (const key of ENVELOPE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function equalHash(left, right) {
  if (!HASH_HEX_PATTERN.test(left || '') || !HASH_HEX_PATTERN.test(right || '')) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function rejected(reason, extras = {}) {
  return {
    ok: false,
    reason,
    fallback: { paper: true, phone: true },
    ...extras,
  };
}

/**
 * Verify a signed continuity-pack envelope without exposing its clinical
 * content until every trust, anti-rollback, hash, and freshness decision has
 * passed. `rendered` is an external byte-for-byte render bound by renderHash.
 */
function verifySignedPackEnvelopeUnchecked(
  envelope,
  {
    rendered,
    requireRendered = true,
    trustedKeys,
    expectedKeyId,
    expectedAudience,
    minimumManifestVersion,
    minimumPolicyVersion,
    minimumRevocationEpoch,
    trustedNow,
    minimumTrustedNow,
    clockTrusted = false,
    limits = {},
    maxRenderUtf8Bytes = MAX_RENDER_UTF8_BYTES,
  } = {},
) {
  let fields;
  try {
    fields = envelopeFields(envelope);
  } catch {
    return rejected(VERIFICATION_REASONS.INVALID_ENVELOPE);
  }
  let signedAudience;
  try {
    signedAudience = fields
      ? normalizeAudience(fields.audience, { requireCanonical: true })
      : null;
  } catch {
    signedAudience = null;
  }
  if (
    !fields
    || !signedAudience
    || fields.envelopeVersion !== PACK_ENVELOPE_VERSION
    || !validEnvelopeVersion(fields.manifestVersion)
    || !validEnvelopeVersion(fields.policyVersion)
    || !validEnvelopeEpoch(fields.revocationEpoch)
    || !HASH_HEX_PATTERN.test(fields.contentHash || '')
    || !HASH_HEX_PATTERN.test(fields.renderHash || '')
    || !canonicalEnvelopeTimestamp(fields.issuedAt)
    || !canonicalEnvelopeTimestamp(fields.expiresAt)
    || timestampMs(fields.expiresAt) <= timestampMs(fields.issuedAt)
  ) {
    return rejected(VERIFICATION_REASONS.INVALID_ENVELOPE);
  }
  if (
    minimumManifestVersion === undefined
    || minimumPolicyVersion === undefined
    || minimumRevocationEpoch === undefined
  ) {
    return rejected(VERIFICATION_REASONS.ROLLBACK_STATE_REQUIRED);
  }
  if (expectedAudience === undefined) {
    return rejected(VERIFICATION_REASONS.AUDIENCE_REQUIRED);
  }

  const keyDecision = assessSigningKey({
    keyId: fields.keyId,
    algorithm: fields.algorithm,
    trustedKeys,
    expectedKeyId,
  });
  if (!keyDecision.ok) return rejected(keyDecision.reason);

  let contentSnapshot;
  try {
    contentSnapshot = canonicalSnapshot(fields.content, limits);
  } catch {
    return rejected(VERIFICATION_REASONS.CANONICALIZATION_FAILED);
  }
  if (!equalHash(fields.contentHash, sha256Hex(contentSnapshot.canonical))) {
    return rejected(VERIFICATION_REASONS.CONTENT_HASH_MISMATCH);
  }

  let renderVerified = false;
  if (rendered !== undefined) {
    let computedRenderHash;
    try {
      computedRenderHash = hashRenderedOutput(rendered, {
        maxUtf8Bytes: maxRenderUtf8Bytes,
      });
    } catch {
      return rejected(VERIFICATION_REASONS.RENDER_HASH_MISMATCH);
    }
    if (!equalHash(fields.renderHash, computedRenderHash)) {
      return rejected(VERIFICATION_REASONS.RENDER_HASH_MISMATCH);
    }
    renderVerified = true;
  } else if (requireRendered) {
    return rejected(VERIFICATION_REASONS.RENDER_REQUIRED);
  }

  if (!verifyCanonicalValue(
    unsignedEnvelope({ ...fields, content: contentSnapshot.value }),
    fields.signature,
    keyDecision.publicKey,
    { limits },
  )) {
    return rejected(VERIFICATION_REASONS.SIGNATURE_INVALID);
  }

  let normalizedExpectedAudience;
  try {
    normalizedExpectedAudience = normalizeAudience(expectedAudience);
  } catch {
    normalizedExpectedAudience = null;
  }
  if (
    !normalizedExpectedAudience
    || !audiencesEqual(signedAudience, normalizedExpectedAudience)
  ) {
    return rejected(VERIFICATION_REASONS.AUDIENCE_MISMATCH);
  }

  let versionDecision;
  try {
    versionDecision = assessMonotonicVersions(
      {
        policyVersion: fields.policyVersion,
        manifestVersion: fields.manifestVersion,
        revocationEpoch: fields.revocationEpoch,
      },
      {
        minimumPolicyVersion,
        minimumManifestVersion,
        minimumRevocationEpoch,
      },
    );
  } catch {
    return rejected(VERIFICATION_REASONS.INVALID_ENVELOPE);
  }
  if (!versionDecision.ok) return rejected(versionDecision.reason);

  const freshness = assessPackFreshness({
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
    trustedNow,
    minimumTrustedNow,
    clockTrusted,
  });
  if (freshness.state === FRESHNESS_STATES.EXPIRED) {
    return rejected(VERIFICATION_REASONS.PACK_EXPIRED, { freshness });
  }
  if (freshness.state === FRESHNESS_STATES.CLOCK_UNCERTAIN) {
    return rejected(VERIFICATION_REASONS.CLOCK_UNCERTAIN, { freshness });
  }

  return {
    ok: true,
    reason: null,
    content: contentSnapshot.value,
    contentHash: fields.contentHash,
    renderHash: fields.renderHash,
    renderVerified,
    keyId: fields.keyId,
    keyState: keyDecision.state,
    audience: signedAudience,
    manifestVersion: fields.manifestVersion,
    policyVersion: fields.policyVersion,
    revocationEpoch: fields.revocationEpoch,
    freshness,
    fallback: { paper: false, phone: false },
  };
}

export function verifySignedPackEnvelope(envelope, options = {}) {
  try {
    return verifySignedPackEnvelopeUnchecked(envelope, options);
  } catch {
    return rejected(VERIFICATION_REASONS.INVALID_ENVELOPE);
  }
}

export const __testing__ = Object.freeze({
  BASE64_PATTERN,
  ENVELOPE_FIELDS,
  HASH_HEX_PATTERN,
  ISO_UTC_PATTERN,
  KEY_ID_PATTERN,
  MAX_SIGNED_BIGINT_DECIMAL,
  TENANT_ID_PATTERN,
  VERSION_PATTERN,
});
