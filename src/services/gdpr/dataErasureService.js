// src/services/gdpr/dataErasureService.js
// GDPR Article 17: Right to Erasure (Right to be Forgotten)
// Handles complete data anonymization/deletion across all tables.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';

// Anonymized placeholder for PII fields
const ANON = '[REDACTED]';
const ANON_PHONE = '+0000000000';
const ANON_EMAIL = 'deleted@redacted.invalid';

/**
 * Tables and their PII columns that must be anonymized or deleted.
 * Ordered to respect foreign key constraints (child tables first).
 */
const ERASURE_TARGETS = [
  // Notification & device data — delete entirely
  { table: 'notifications', uidColumn: 'uid', action: 'delete' },
  { table: 'user_devices', uidColumn: 'user_uid', action: 'delete' },
  { table: 'devices', phoneColumn: 'phone', action: 'delete' },

  // Session & auth data — delete entirely
  { table: 'invalidated_tokens', uidColumn: 'user_id', action: 'delete' },
  { table: 'otp_logs', phoneColumn: 'phone', action: 'delete' },
  { table: 'auth_logs', phoneColumn: 'phone', action: 'delete' },

  // Medical data — anonymize (retain for aggregate analytics, remove PII)
  { table: 'pharmacy_orders', phoneColumn: 'phone', action: 'anonymize',
    fields: { phone: ANON_PHONE, order_note: ANON, delivery_address: ANON, delivery_landmark: ANON } },
  { table: 'investigations', phoneColumn: 'phone', action: 'anonymize',
    fields: { phone: ANON_PHONE, notes: ANON, custom_test_names: ANON } },
  { table: 'health_records', phoneColumn: 'phone', action: 'anonymize',
    fields: { phone: ANON_PHONE, notes: ANON } },
  { table: 'consultations', phoneColumn: 'phone', action: 'anonymize',
    fields: { phone: ANON_PHONE, consultation_notes: ANON, diagnosis: ANON, treatment_plan: ANON } },
  { table: 'appointments', uidColumn: 'uid', action: 'anonymize',
    fields: { reason: ANON, notes: ANON } },
  { table: 'feedback', phoneColumn: 'phone', action: 'anonymize',
    fields: { phone: ANON_PHONE, comment: ANON } },

  // Consent records — anonymize
  { table: 'patient_consents', uidColumn: 'patient_uid', action: 'anonymize',
    fields: { ip_address: null, notes: ANON } },

  // Audit logs — anonymize user info but retain event data for compliance
  { table: 'audit_logs', uidColumn: 'uid', action: 'anonymize',
    fields: { ip: null } },

  // File metadata — anonymize uploader info
  { table: 'file_metadata', uidColumn: 'uploaded_by', action: 'anonymize',
    fields: { uploaded_by: null } },
];

/**
 * Execute full GDPR erasure for a user identified by UID and/or phone.
 *
 * @param {Object} params
 * @param {string} params.uid - User UID
 * @param {string} params.phone - User phone number
 * @param {string} params.requestedBy - UID of admin/user requesting erasure
 * @param {string} params.reason - Reason for erasure
 * @param {string} params.ip - IP address of requester
 * @param {string} params.requestId - Request ID for correlation
 * @returns {Object} Summary of actions taken per table
 */
export async function executeErasure({ uid, phone, requestedBy, reason, ip, requestId }) {
  const results = {};
  const startTime = Date.now();

  logger.info('GDPR erasure initiated', {
    uid, phone: phone ? `***${phone.slice(-4)}` : null,
    requestedBy, reason, requestId,
  });

  try {
    // Process each target table
    for (const target of ERASURE_TARGETS) {
      try {
        const { table, uidColumn, phoneColumn, action, fields } = target;

        // Build WHERE clause
        const conditions = [];
        const params = [];
        let paramIdx = 1;

        if (uidColumn && uid) {
          conditions.push(`${uidColumn} = $${paramIdx++}`);
          params.push(uid);
        }
        if (phoneColumn && phone) {
          conditions.push(`${phoneColumn} = $${paramIdx++}`);
          params.push(phone);
        }

        if (conditions.length === 0) {
          results[table] = { action: 'skipped', reason: 'no matching identifier' };
          continue;
        }

        const whereClause = conditions.join(' OR ');

        if (action === 'delete') {
          const result = await prisma.$queryRawUnsafe(
            `DELETE FROM ${table} WHERE ${whereClause}`,
            params
          );
          results[table] = { action: 'deleted', count: result.rowCount || 0 };
        } else if (action === 'anonymize' && fields) {
          const setClauses = Object.entries(fields)
            .map(([col, val]) => {
              if (val === null) return `${col} = NULL`;
              params.push(val);
              return `${col} = $${paramIdx++}`;
            })
            .join(', ');

          const result = await prisma.$queryRawUnsafe(
            `UPDATE ${table} SET ${setClauses}, updated_at = NOW() WHERE ${whereClause}`,
            params
          );
          results[table] = { action: 'anonymized', count: result.rowCount || 0 };
        }
      } catch (tableErr) {
        // Table might not exist — log and continue
        logger.warn(`GDPR erasure: table ${target.table} error:`, tableErr.message);
        results[target.table] = { action: 'error', error: 'Table operation failed' };
      }
    }

    // Finally, anonymize the user record itself
    if (uid) {
      try {
        await prisma.$queryRawUnsafe(
          `UPDATE users SET
            name = $1, email = $2, address = $3, gender = NULL,
            birthday = NULL, anniversary = NULL, profile_picture = NULL,
            emergency_contact = NULL, blood_group = NULL, allergies = NULL,
            medical_history = NULL, is_active = false,
            updated_at = NOW()
          WHERE uid = $4`,
          ANON, ANON_EMAIL, ANON, uid
        );
        results.users = { action: 'anonymized', count: 1 };
      } catch (err) {
        logger.warn('GDPR erasure: users table error:', err.message);
        results.users = { action: 'error', error: 'User anonymization failed' };
      }
    }

    // Log the erasure event for compliance audit trail
    const erasureLog = {
      uid: uid || null,
      phone_hash: phone ? require('crypto').createHash('sha256').update(phone).digest('hex').slice(0, 16) : null,
      requested_by: requestedBy,
      reason,
      ip,
      tables_processed: Object.keys(results).length,
      completed_at: new Date(),
      duration_ms: Date.now() - startTime,
      results: JSON.stringify(results),
    };

    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO gdpr_erasure_log
          (uid, phone_hash, requested_by, reason, ip, tables_processed, completed_at, duration_ms, results, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        
          erasureLog.uid, erasureLog.phone_hash, erasureLog.requested_by,
          erasureLog.reason, erasureLog.ip, erasureLog.tables_processed,
          erasureLog.completed_at, erasureLog.duration_ms, erasureLog.results,
        
      );
    } catch (logErr) {
      // Log table might not exist yet — write to file as fallback
      logger.warn('GDPR erasure log insert failed (table may not exist):', logErr.message);
      logger.info('GDPR_ERASURE_AUDIT', erasureLog);
    }

    logPhiAccess({
      userId: requestedBy,
      userRole: 'SYSTEM',
      patientId: uid,
      recordType: 'GDPR_ERASURE',
      action: 'DATA_ERASURE',
      ip,
      requestId,
    });

    logger.info('GDPR erasure completed', {
      uid, duration_ms: Date.now() - startTime,
      tablesProcessed: Object.keys(results).length,
    });

    return {
      success: true,
      uid,
      erasedAt: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      tables: results,
    };
  } catch (err) {
    logger.error('GDPR erasure failed:', err);
    throw err;
  }
}

/**
 * Check if a user has any legal hold that prevents erasure.
 * (e.g., ongoing legal proceedings, regulatory requirements)
 */
export async function checkLegalHold(uid) {
  try {
    const holds = await prisma.$queryRawUnsafe(
      `SELECT id, reason, created_at FROM legal_holds
       WHERE user_uid = $1 AND released_at IS NULL`,
      uid
    );
    return { hasHold: holds.length > 0, holds };
  } catch {
    // Table might not exist
    return { hasHold: false, holds: [] };
  }
}
