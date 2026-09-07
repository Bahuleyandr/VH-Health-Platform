import { redactSensitiveQueryParams } from './urlRedaction.js';
import { isSensitiveKey } from './sensitiveKeys.js';

const REDACTED = '[Filtered]';

// Vocabulary and matcher shared with logMasking.js — see utils/sensitiveKeys.js.
// This file previously carried its own copy of the pattern, and the copies had
// DRIFTED: this one was missing `uhid`, so a key named `uhid` — a hospital
// patient identifier — was redacted in logs and sent VERBATIM to Sentry. The
// comment on the other copy asserted they mirrored each other; nothing enforced
// it. sensitiveKeyContracts.test.js now does.
const SENSITIVE_KEY_PATTERN = { test: (key) => isSensitiveKey(key) };

const TEXT_PATTERNS = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]'],
  [/(^|[^\d])(?:\+?91[-\s]?)?\d[\d\s-]{8,12}\d(?=$|[^\d])/g, '$1[REDACTED_PHONE]'],
  [/\bVH-\d{4,}\b/gi, '[REDACTED_HOSPITAL_ID]'],
  [/\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]'],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    '[REDACTED_UUID]'
  ]
];

function isPlainObject(value) {
  return (
    value != null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

export function scrubSentryText(value) {
  if (typeof value !== 'string') return value;
  return TEXT_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value
  );
}

export function normalizeSentryPath(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let path = redactSensitiveQueryParams(value);
  try {
    const url = new URL(path);
    path = url.pathname || path;
  } catch (_) {
    [path] = path.split('?');
  }
  const normalized = path
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
      '/:uuid'
    )
    .replace(/\/VH-\d{4,}(?=\/|$)/gi, '/:hospitalId')
    .replace(/\/\d{4,}(?=\/|$)/g, '/:id');
  return scrubSentryText(normalized);
}

export function scrubSentryValue(value, key = '', depth = 0) {
  if (depth > 6) return REDACTED;
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === 'string') return scrubSentryText(value);
  if (Array.isArray(value)) {
    return value.map(item => scrubSentryValue(item, '', depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        scrubSentryValue(childValue, childKey, depth + 1)
      ])
    );
  }
  return value;
}

export function scrubSentryEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const originalRequest = event.request;
  const originalTransaction = event.transaction;
  const scrubbed = scrubSentryValue(event);

  if (scrubbed.request) {
    scrubbed.request = {
      method: scrubbed.request.method,
      url: normalizeSentryPath(originalRequest?.url ?? scrubbed.request.url),
      headers: scrubSentryValue(scrubbed.request.headers),
      env: undefined,
      cookies: undefined,
      data: undefined,
      query_string: undefined
    };
  }

  if (scrubbed.transaction) {
    scrubbed.transaction = normalizeSentryPath(originalTransaction ?? scrubbed.transaction);
  }

  if (scrubbed.user) {
    scrubbed.user = {
      id: scrubSentryText(scrubbed.user.id),
      role: scrubbed.user.role
    };
  }

  return scrubbed;
}
