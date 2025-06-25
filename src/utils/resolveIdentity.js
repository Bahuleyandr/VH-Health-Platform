// src/utils/resolveIdentity.js

import db from '../config/database.js';
/**
 * Resolve phone number from UID using users table
 * @param {string} uid - The unique user ID
 * @returns {Promise<string|null>} - The resolved phone number or null if not found
 */
export async function resolvePhoneFromUID(uid) {
  const result = await db.query('SELECT phone FROM users WHERE uid = $1', [uid]);
  return result.rows.length ? result.rows[0].phone : null;
}

/**
 * Resolve UID from phone number using users table
 * @param {string} phone - The normalized phone number
 * @returns {Promise<string|null>} - The UID if found, or null
 */
export async function resolveUIDFromPhone(phone) {
  const result = await db.query('SELECT uid FROM users WHERE phone = $1', [phone]);
  return result.rows.length ? result.rows[0].uid : null;
}

/**
 * Resolve phone from any of req.body, req.query, or req.params
 * @param {object} req - Express request object
 * @returns {string|null} - The extracted phone number or null
 */
export function resolvePhoneFromRequest(req) {
  return (
    req.body?.phone ||
    req.query?.phone ||
    req.params?.phone ||
    req.body?.phoneNumber ||
    req.query?.phoneNumber ||
    req.params?.phoneNumber ||
    null
  );
}

/**
 * Resolve UID from any of req.body, req.query, or req.params
 * @param {object} req - Express request object
 * @returns {string|null} - The extracted UID or null
 */
export function resolveUIDFromRequest(req) {
  return req.body?.uid || req.query?.uid || req.params?.uid || null;
}
