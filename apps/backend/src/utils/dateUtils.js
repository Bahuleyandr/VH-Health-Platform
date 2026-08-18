// src/utils/dateUtils.js

/**
 * Formats a Date object or ISO string to 'DD-MM-YYYY' format.
 * @param {Date|string} date - Date object or ISO date string.
 * @returns {string} - Formatted date string.
 */
export function formatDateDDMMYYYY(date) {
  if (!date) {return '';}
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Current calendar date in IST as 'YYYY-MM-DD'.
 *
 * This is the canonical user-facing "day" key for Asia/Kolkata, the
 * platform's single-region local zone (IST is fixed UTC+05:30, no DST).
 * P7 fix note (2026-08-18): the gamification/check-in/step day keys
 * (health_point_ledger.activity_ref_id and friends) switched from UTC days
 * to this IST day. Historical rows keep their UTC-day keys, so an entry
 * recorded 00:00-05:29 IST pre-switch sits on the previous calendar day —
 * a one-time accepted boundary skew (a possible extra same-day award or a
 * one-day streak gap around the switch), never an ongoing error.
 */
export function istDateString(at = new Date()) {
  const istMs = at.getTime() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 10);
}

/**
 * Checks if the provided date is in the future.
 * @param {Date|string} date - Date object or ISO date string.
 * @returns {boolean} - True if date is in the future.
 */
export function isFutureDate(date) {
  const d = new Date(date);
  const now = new Date();
  return d > now;
}

/**
 * Checks if the provided date is in the past.
 * @param {Date|string} date - Date object or ISO date string.
 * @returns {boolean} - True if date is in the past.
 */
export function isPastDate(date) {
  const d = new Date(date);
  const now = new Date();
  return d < now;
}
