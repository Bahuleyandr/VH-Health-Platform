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
