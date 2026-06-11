// src/utils/logMasking.js
//
// Shared PHI-masking helpers for log lines (audit finding H5, 2026-06-10:
// patient/staff phone numbers — HIPAA identifiers — were logged raw across
// many services even though per-file maskPhoneForLog helpers existed in a
// couple of places). Always log identifiers through these helpers; the
// Winston-level redaction format (src/logging/phiRedactionFormat.js) is a
// BACKSTOP, not the primary control.

/** Masks a phone number: keeps a 3-char prefix + last 2 digits. */
export function maskPhoneForLog(phone) {
  const value = String(phone ?? '').trim();
  if (!value) return '<no-phone>';
  if (value.length <= 6) return '<short-phone>';
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

/** Masks an email: first char of the local part + domain. */
export function maskEmailForLog(email) {
  const value = String(email ?? '').trim();
  const at = value.indexOf('@');
  if (!value) return '<no-email>';
  if (at <= 0) return '<invalid-email>';
  return `${value[0]}***@${value.slice(at + 1)}`;
}

/** Masks an MRN or similar identifier: keeps the last 3 characters. */
export function maskMrnForLog(mrn) {
  const value = String(mrn ?? '').trim();
  if (!value) return '<no-mrn>';
  if (value.length <= 3) return '<short-mrn>';
  return `***${value.slice(-3)}`;
}

// ── String scrubbing (used by the Winston backstop format) ─────────────────

// E.164-ish international numbers (+ followed by 10-14 digits, optional
// separators) and bare Indian mobile numbers (10 digits starting 6-9).
const INTL_PHONE_RE = /\+\d[\d\s\-()]{8,15}\d/g;
const IN_MOBILE_RE = /(?<![\dA-Za-z/.:-])[6-9]\d{9}(?![\dA-Za-z])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MRN_RE = /\b(MRN|UHID)[\s:#-]*([A-Za-z0-9-]{4,})\b/gi;

function maskPhoneMatch(match) {
  const digitsOnly = match.replace(/[^\d+]/g, '');
  return maskPhoneForLog(digitsOnly);
}

/**
 * Scrubs phone numbers, emails, and MRN/UHID identifiers from a string.
 * Conservative by design — targets formats that are unambiguous identifiers
 * so log lines stay useful.
 */
export function scrubPhiFromString(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(INTL_PHONE_RE, maskPhoneMatch)
    .replace(IN_MOBILE_RE, maskPhoneMatch)
    .replace(EMAIL_RE, (m) => maskEmailForLog(m))
    .replace(MRN_RE, (m, label, id) => `${label} ${maskMrnForLog(id)}`);
}

const MAX_SCRUB_DEPTH = 6;

/**
 * Recursively scrubs string values in a log-meta object. Mutates a COPY —
 * never the caller's object. Depth-limited and cycle-safe.
 */
export function scrubPhiDeep(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return scrubPhiFromString(value);
  if (value == null || typeof value !== 'object' || depth >= MAX_SCRUB_DEPTH) {
    return value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => scrubPhiDeep(v, depth + 1, seen));
  }
  if (value instanceof Error) {
    // Preserve Error identity; scrub its message/stack copies downstream.
    return value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = scrubPhiDeep(v, depth + 1, seen);
  }
  return out;
}

export default {
  maskPhoneForLog,
  maskEmailForLog,
  maskMrnForLog,
  scrubPhiFromString,
  scrubPhiDeep,
};
