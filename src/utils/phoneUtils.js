// src/utils/phoneUtils.js

/**
 * Normalize phone number to +91xxxxxxxxxx format (India-specific).
 * Accepts string or numeric input, trims, strips non-digits, and ensures 10-digit format.
 *
 * @param {string|number} phoneInput - Raw phone input from user or request.
 * @returns {string|null} - Normalized phone number like +919876543210 or null if invalid.
 */
export function normalizePhone(phoneInput) {
  const raw = String(phoneInput || '').trim();
  const digitsOnly = raw.replace(/[^\d]/g, '');

  if (digitsOnly.length < 10) return null;

  const last10 = digitsOnly.slice(-10);
  return `+91${last10}`;
}
