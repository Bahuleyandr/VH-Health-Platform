// src/utils/sanitize.js - Input sanitization to prevent stored XSS
//
// Audit finding M7 (2026-06-10): the previous implementation was a hand-rolled
// REGEX BLOCKLIST (trivially bypassable — e.g. nested tags, malformed markup,
// uppercase protocols survive regex passes). It is now backed by
// `sanitize-html` (an HTML-parser-based sanitizer) configured to strip ALL
// markup, with `deepSanitizeStrings` available so whole clinical free-text
// payloads can be sanitized consistently (the old helper was wired into only
// ~9 of 237 route files).

import sanitizeHtml from 'sanitize-html';

const STRIP_ALL = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: 'discard',
  // Keep the text content of disallowed tags (e.g. "<b>BP</b>" → "BP"),
  // but drop script/style bodies entirely.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
};

/**
 * Strip ALL HTML/script markup from a string, preserving plain-text content.
 * Parser-based (sanitize-html) — not a regex blocklist.
 * @param {string} input
 * @returns {string} Sanitized string
 */
export function stripHtml(input) {
  if (typeof input !== 'string') return input;

  return sanitizeHtml(input, STRIP_ALL)
    // sanitize-html entity-encodes & < > — decode the harmless ampersand so
    // plain text like "ENT & Ortho" round-trips; lt/gt stay encoded (inert).
    .replace(/&amp;/g, '&')
    // Defence-in-depth for dangerous pseudo-protocols left in plain text.
    .replace(/javascript\s*:/gi, '')
    .replace(/data\s*:\s*text\/html/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Recursively sanitize specified fields in an object.
 * @param {Object} obj - Object to sanitize (mutates in place)
 * @param {string[]} fields - Field names to sanitize
 * @returns {Object} The same object, sanitized
 */
export function sanitizeFields(obj, fields) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const field of fields) {
    if (typeof obj[field] === 'string') {
      obj[field] = stripHtml(obj[field]);
    }
  }
  return obj;
}

// Keys that must never be rewritten by the deep sanitizer: credentials,
// signatures, file keys, base64 payloads, URLs (validated elsewhere).
const DEEP_SANITIZE_SKIP_KEY = /(password|pin|token|secret|signature|_key$|^key$|base64|file_data|payload_b64)/i;
const MAX_DEEP_DEPTH = 8;

/**
 * Recursively strip HTML from EVERY string value in a request body
 * (audit finding M7 — clinical free-text reached storage unsanitized on most
 * routes). Mutates in place; cycle-safe and depth-limited; skips
 * credential/signature-like keys so security material is never altered.
 * @param {*} value
 * @returns {*} The same structure, sanitized
 */
export function deepSanitizeStrings(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return stripHtml(value);
  if (!value || typeof value !== 'object' || depth >= MAX_DEEP_DEPTH) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = deepSanitizeStrings(value[i], depth + 1, seen);
    }
    return value;
  }

  for (const [key, v] of Object.entries(value)) {
    if (DEEP_SANITIZE_SKIP_KEY.test(key)) continue;
    value[key] = deepSanitizeStrings(v, depth + 1, seen);
  }
  return value;
}
