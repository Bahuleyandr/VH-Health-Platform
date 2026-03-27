/**
 * PII masking utilities for log sanitization.
 * Use these when logging any user-identifiable data.
 */

/** Mask phone: +919876543210 → +91****3210 */
export function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '***';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return digits.slice(0, 2) + '****' + digits.slice(-4);
}

/** Mask email: user@example.com → u***@example.com */
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return '***';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return local[0] + '***@' + domain;
}

/** Mask name: John Doe → J*** D** */
export function maskName(name) {
  if (!name || typeof name !== 'string') return '***';
  return name.split(' ').map(part => part[0] + '***').join(' ');
}

/** Mask any string, keeping first and last 2 chars */
export function maskGeneric(str, visibleStart = 2, visibleEnd = 2) {
  if (!str || typeof str !== 'string') return '***';
  if (str.length <= visibleStart + visibleEnd) return '***';
  return str.slice(0, visibleStart) + '****' + str.slice(-visibleEnd);
}
