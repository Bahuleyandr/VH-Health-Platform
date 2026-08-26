const LIS_LISTENER_KEYS = new Set([
  'name', 'port', 'host', 'protocol', 'analyzer_code', 'token_env',
  'tenant_slug', 'allowed_source_ips', 'max_message_bytes',
]);
const LIS_PROTOCOLS = new Set(['astm-e1394', 'mllp-hl7v2']);
const LIS_TOKEN_ENV_PATTERN = /^LIS_[A-Z][A-Z0-9_]*_TOKEN$/;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

// Structural twin of device-gateway validateLisListenerProfile. Token values
// deliberately remain gateway-only; this module validates the shared
// non-secret ConfigMap payload used by the read-only admin gate.
export function validateLisListenerProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LIS listener must be an object');
  }
  const unknown = Object.keys(value).filter(key => !LIS_LISTENER_KEYS.has(key));
  if (unknown.length) {
    throw new Error(`LIS listener contains unknown fields: ${unknown.join(', ')}`);
  }
  const name = String(value.name || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
    throw new Error('LIS listener name must be 1-64 alphanumeric/underscore/dash characters');
  }
  if (!LIS_PROTOCOLS.has(value.protocol)) {
    throw new Error("LIS listener protocol must be 'astm-e1394' or 'mllp-hl7v2'");
  }
  const analyzerCode = String(value.analyzer_code || '').trim();
  if (!analyzerCode) throw new Error('LIS listener analyzer_code is required');
  const tokenEnv = String(value.token_env || '').trim();
  if (!LIS_TOKEN_ENV_PATTERN.test(tokenEnv)) {
    throw new Error('LIS listener token_env must match LIS_[A-Z][A-Z0-9_]*_TOKEN');
  }
  const tenantSlug = String(value.tenant_slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantSlug)) {
    throw new Error('LIS listener tenant_slug must be a valid tenant slug');
  }
  const port = positiveInteger(value.port, 'LIS listener port');
  if (port > 65535) throw new Error('LIS listener port must be a TCP port number');
  const allowedSourceIps = Array.isArray(value.allowed_source_ips)
    ? value.allowed_source_ips.map(normalizeIp).filter(Boolean)
    : [];
  return Object.freeze({
    name,
    port,
    host: String(value.host || '0.0.0.0'),
    protocol: value.protocol,
    analyzer_code: analyzerCode,
    token_env: tokenEnv,
    tenant_slug: tenantSlug,
    allowed_source_ips: Object.freeze(allowedSourceIps),
    max_message_bytes: value.max_message_bytes === undefined
      ? DEFAULT_MAX_MESSAGE_BYTES
      : positiveInteger(value.max_message_bytes, 'LIS listener max_message_bytes'),
  });
}

export function lisListenerConfigSummaryFromEnv(env = process.env) {
  const raw = String(env.DEVICE_GATEWAY_LIS_LISTENERS || '').trim();
  if (!raw) return { count: 0, invalid: false, profiles: Object.freeze([]) };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('DEVICE_GATEWAY_LIS_LISTENERS must be an array');
    const profiles = parsed.map(validateLisListenerProfile);
    const names = new Set(profiles.map(profile => profile.name));
    if (names.size !== profiles.length) throw new Error('LIS listener names must be unique');
    return {
      count: profiles.length,
      invalid: false,
      profiles: Object.freeze(profiles),
    };
  } catch {
    return { count: 0, invalid: true, profiles: Object.freeze([]) };
  }
}

export default { lisListenerConfigSummaryFromEnv, validateLisListenerProfile };
