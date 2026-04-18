// src/utils/sanitize.js - Input sanitization to prevent stored XSS
// Strips HTML tags and dangerous patterns from user-provided text fields.

/**
 * Strip HTML/script tags and dangerous patterns from a string.
 * Preserves plain text content.
 * @param {string} input
 * @returns {string} Sanitized string
 */
export function stripHtml(input) {
  if (typeof input !== 'string') return input;

  return input
    // Remove script tags and their contents
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove style tags and their contents
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Remove all HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove event handlers that might survive (e.g., in attribute remnants)
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    // Remove javascript: protocol
    .replace(/javascript\s*:/gi, '')
    // Remove data: protocol (prevents data URI attacks)
    .replace(/data\s*:\s*text\/html/gi, '')
    // Normalize whitespace left behind
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
