import net from 'node:net';
import crypto from 'node:crypto';

import { AppError } from '../../utils/AppError.js';

export const ACTIVE_CONNECTOR_PROTOCOLS = Object.freeze({
  http_inbound: Object.freeze(['hl7v2']),
  http_outbound: Object.freeze(['hl7v2', 'csv', 'json', 'fhir_json', 'other']),
});

export const DEFAULT_RETRY_POLICY = Object.freeze({
  backoff: 'exponential',
  initialDelaySeconds: 30,
  maxDelaySeconds: 3600,
  jitterRatio: 0.2,
});

const RETRY_BACKOFF_KINDS = new Set(['fixed', 'exponential']);
const RETRYABLE_HTTP_STATUSES = new Set([425, 429]);
const AMBIGUOUS_HTTP_STATUSES = new Set([408, 409]);

function boundedNumber(value, fallback, { min, max, label }) {
  const parsed = Number(value === null || value === undefined || value === '' ? fallback : value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw AppError.badRequest(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

export function normalizeRetryPolicy(value = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('retry_policy must be a JSON object');
  }
  const backoff = String(value.backoff || DEFAULT_RETRY_POLICY.backoff).trim().toLowerCase();
  if (!RETRY_BACKOFF_KINDS.has(backoff)) {
    throw AppError.badRequest('retry_policy.backoff must be fixed or exponential');
  }
  const legacyMaxDelaySeconds = value.maxDelayMinutes == null
    ? DEFAULT_RETRY_POLICY.maxDelaySeconds
    : boundedNumber(value.maxDelayMinutes, 60, {
      min: 1 / 60,
      max: 10080,
      label: 'retry_policy.maxDelayMinutes',
    }) * 60;
  const initialDelaySeconds = boundedNumber(
    value.initialDelaySeconds ?? value.baseDelaySeconds,
    DEFAULT_RETRY_POLICY.initialDelaySeconds,
    { min: 1, max: 86400, label: 'retry_policy.initialDelaySeconds' },
  );
  const maxDelaySeconds = boundedNumber(
    value.maxDelaySeconds,
    legacyMaxDelaySeconds,
    { min: initialDelaySeconds, max: 604800, label: 'retry_policy.maxDelaySeconds' },
  );
  const jitterRatio = boundedNumber(
    value.jitterRatio,
    DEFAULT_RETRY_POLICY.jitterRatio,
    { min: 0, max: 0.5, label: 'retry_policy.jitterRatio' },
  );
  return Object.freeze({ backoff, initialDelaySeconds, maxDelaySeconds, jitterRatio });
}

function deterministicUnitInterval(key) {
  const digest = crypto.createHash('sha256').update(String(key || '')).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

export function calculateRetryDelayMs({ retryPolicy = {}, attemptNumber, jitterKey } = {}) {
  const policy = normalizeRetryPolicy(retryPolicy);
  const attempt = Math.max(1, Number.parseInt(attemptNumber, 10) || 1);
  const multiplier = policy.backoff === 'exponential'
    ? 2 ** Math.min(attempt - 1, 20)
    : 1;
  const unjittered = Math.min(
    policy.initialDelaySeconds * multiplier,
    policy.maxDelaySeconds,
  );
  const unit = deterministicUnitInterval(`${jitterKey || ''}:${attempt}`);
  const jitterFactor = 1 - policy.jitterRatio + (2 * policy.jitterRatio * unit);
  return Math.max(1000, Math.round(unjittered * jitterFactor * 1000));
}

export function retryAtFor({ now = new Date(), retryPolicy, attemptNumber, jitterKey } = {}) {
  return new Date(new Date(now).getTime() + calculateRetryDelayMs({
    retryPolicy,
    attemptNumber,
    jitterKey,
  }));
}

export function assertConnectorCanActivate({ connectorKind, protocol } = {}) {
  const protocols = ACTIVE_CONNECTOR_PROTOCOLS[connectorKind];
  if (!protocols) {
    throw AppError.badRequest(
      `${String(connectorKind || 'Unknown')} connector runtime is not implemented`,
      'INTEROP_CONNECTOR_RUNTIME_UNSUPPORTED',
    );
  }
  if (!protocols.includes(protocol)) {
    throw AppError.badRequest(
      `${connectorKind} does not implement the ${String(protocol || 'unknown')} protocol`,
      'INTEROP_CONNECTOR_PROTOCOL_UNSUPPORTED',
    );
  }
}

function ipv4Bytes(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map(part => Number(part));
  if (bytes.some((byte, index) => (
    !Number.isInteger(byte)
    || byte < 0
    || byte > 255
    || !/^\d{1,3}$/.test(parts[index])
  ))) return null;
  return bytes;
}

function ipv6Bytes(ip) {
  let value = String(ip).toLowerCase();
  const zoneIndex = value.indexOf('%');
  if (zoneIndex !== -1) return null;
  const dotted = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const bytes = ipv4Bytes(dotted[1]);
    if (!bytes) return null;
    value = `${value.slice(0, dotted.index)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = halves.length === 2
    ? [...head, ...Array(missing).fill('0'), ...tail]
    : head;
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => {
    const parsed = Number.parseInt(group, 16);
    return [parsed >> 8, parsed & 0xff];
  });
}

export function normalizeSourceIp(value) {
  let ip = String(value || '').trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped && net.isIP(mapped[1]) === 4) ip = mapped[1];
  return net.isIP(ip) ? ip.toLowerCase() : null;
}

function parseRange(value) {
  const text = String(value || '').trim();
  const parts = text.split('/');
  if (parts.length > 2) return null;
  const ip = normalizeSourceIp(parts[0]);
  if (!ip) return null;
  const family = net.isIP(ip);
  const maxBits = family === 4 ? 32 : 128;
  const prefix = parts.length === 1 ? maxBits : Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) return null;
  const bytes = family === 4 ? ipv4Bytes(ip) : ipv6Bytes(ip);
  if (!bytes) return null;
  return { text, family, prefix, bytes };
}

export function normalizeAllowedSourceRanges(value) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 64) {
    throw AppError.badRequest('allowed_source_ips cannot contain more than 64 entries');
  }
  const normalized = [...new Set(list.map(entry => String(entry || '').trim()))];
  if (normalized.some(entry => !entry || !parseRange(entry))) {
    throw AppError.badRequest(
      'allowed_source_ips entries must be valid IPv4/IPv6 addresses or CIDR ranges',
      'INTEROP_SOURCE_IP_ALLOWLIST_INVALID',
    );
  }
  return normalized;
}

function prefixMatches(address, range) {
  const fullBytes = Math.floor(range.prefix / 8);
  const remainingBits = range.prefix % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== range.bytes[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[fullBytes] & mask) === (range.bytes[fullBytes] & mask);
}

export function isSourceIpAllowed(sourceIp, allowedRanges) {
  const normalizedIp = normalizeSourceIp(sourceIp);
  if (!normalizedIp) return false;
  const ranges = Array.isArray(allowedRanges) ? allowedRanges : [];
  if (ranges.length === 0) return false;
  const family = net.isIP(normalizedIp);
  const bytes = family === 4 ? ipv4Bytes(normalizedIp) : ipv6Bytes(normalizedIp);
  return ranges.some((entry) => {
    const range = parseRange(entry);
    return range?.family === family && prefixMatches(bytes, range);
  });
}

export function classifyHttpFailure(responseStatus) {
  const status = Number(responseStatus);
  if (!Number.isInteger(status)) return 'ambiguous';
  if (RETRYABLE_HTTP_STATUSES.has(status)) return 'definitive_retryable';
  if (AMBIGUOUS_HTTP_STATUSES.has(status) || status >= 500) return 'ambiguous';
  if (status >= 300 && status < 500) return 'definitive_permanent';
  return 'ambiguous';
}

export function classifyHl7Acknowledgement(state) {
  if (state === 'aa') return 'accepted';
  if (state === 'ae') return 'definitive_retryable';
  if (state === 'ar') return 'definitive_permanent';
  return 'ambiguous';
}

export function stableOutboundIdempotencyKey({ tenantId, messageId, payloadHash } = {}) {
  return `vh-interop:${tenantId}:${messageId}:${payloadHash}`;
}

export default Object.freeze({
  ACTIVE_CONNECTOR_PROTOCOLS,
  DEFAULT_RETRY_POLICY,
  assertConnectorCanActivate,
  calculateRetryDelayMs,
  classifyHl7Acknowledgement,
  classifyHttpFailure,
  isSourceIpAllowed,
  normalizeAllowedSourceRanges,
  normalizeRetryPolicy,
  normalizeSourceIp,
  retryAtFor,
  stableOutboundIdempotencyKey,
});
