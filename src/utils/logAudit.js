// src/utils/logAudit.js

import db from '../db.js';
import logger from '../logging/logger.js';

/**
 * Writes an audit trail log to the audit_logs table.
 * @param {object} req - Express request (used to extract UID, IP, role)
 * @param {string} action - Short action string, e.g. 'role-change', 'delete-doctor'
 * @param {object} metadata - Optional structured metadata (JSON-safe)
 */
export async function logAudit(req, action, metadata = {}) {
  const uid = req.user?.uid || null;
  const role = req.user?.role || null;
  const ip =
    req.headers['x-forwarded-for'] || req.connection?.remoteAddress || null;

  try {
    await db.query(
      `INSERT INTO audit_logs (uid, role, ip, action, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [uid, role, ip, action, metadata],
    );

    logger.info(
      `[AUDIT] ${action} | UID: ${uid} | Role: ${role} | IP: ${ip} | Meta: ${JSON.stringify(metadata)}`,
    );
  } catch (err) {
    logger.error(
      `[AUDIT-FAIL] ${action} failed to log: ${err.stack || err.message}`,
    );
  }
}
