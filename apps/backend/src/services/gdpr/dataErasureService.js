// src/services/gdpr/dataErasureService.js
// GDPR Article 17: Right to Erasure (Right to be Forgotten)
// Handles complete data anonymization/deletion across all tables.

import crypto from 'node:crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';

// Anonymized placeholder for PII fields
const ANON = '[REDACTED]';
const ANON_PHONE = '+0000000000';
const ANON_EMAIL = 'deleted@redacted.invalid';

// Tables and their PII columns that must be anonymized or deleted, in
// child-first order to respect FKs. Each entry names the Prisma model
// (`model`), the where-shape (`whereByUid` / `whereByPhone`), the action
// (`delete` | `anonymize`), and for anonymize the `data` payload + a
// boolean `withTimestamp` to opt into `updated_at: NOW()`.
const ERASURE_TARGETS = [
  // Notification + device data — delete entirely
  { model: 'notifications',     whereByUid: 'uid',         action: 'delete' },
  { model: 'user_devices',      whereByUid: 'user_uid',    action: 'delete' },
  { model: 'devices',           whereByPhone: 'phone',     action: 'delete' },

  // Session + auth data — delete entirely
  { model: 'invalidated_tokens', whereByUid: 'user_id',    action: 'delete' },
  { model: 'otp_logs',           whereByPhone: 'phone',    action: 'delete' },
  { model: 'auth_logs',          whereByPhone: 'phone',    action: 'delete' },

  // Medical data — anonymize (retain row for aggregate analytics, strip PII)
  { model: 'pharmacy_orders', whereByPhone: 'phone', action: 'anonymize', withTimestamp: true,
    data: { phone: ANON_PHONE, order_note: ANON, delivery_address: ANON, delivery_landmark: ANON } },
  { model: 'investigations',  whereByPhone: 'phone', action: 'anonymize', withTimestamp: true,
    data: { phone: ANON_PHONE, notes: ANON, custom_test_names: ANON } },
  // health_records is the file-upload table (batch 45 documented this);
  // the only PII column is phone — there's no notes column here.
  { model: 'health_records',  whereByPhone: 'phone', action: 'anonymize', withTimestamp: true,
    data: { phone: ANON_PHONE } },
  { model: 'consultations',   whereByPhone: 'phone', action: 'anonymize', withTimestamp: true,
    data: { phone: ANON_PHONE, consultation_notes: ANON, diagnosis: ANON, treatment_plan: ANON } },
  { model: 'appointments',    whereByUid: 'uid',     action: 'anonymize', withTimestamp: true,
    data: { reason: ANON, notes: ANON } },
  { model: 'feedback',        whereByPhone: 'phone', action: 'anonymize', withTimestamp: true,
    data: { phone: ANON_PHONE, comment: ANON } },

  // Consent records — anonymize
  { model: 'patient_consents', whereByUid: 'patient_uid', action: 'anonymize', withTimestamp: true,
    data: { ip_address: null, notes: ANON } },

  // Audit logs — anonymize requester IP but retain event data for compliance.
  // Column is ip_address (the original code used `ip` which doesn't exist).
  // audit_logs has no updated_at column — withTimestamp omitted.
  { model: 'audit_logs', whereByUid: 'uid', action: 'anonymize',
    data: { ip_address: null } },

  // File metadata — anonymize uploader
  { model: 'file_metadata', whereByUid: 'uploaded_by', action: 'anonymize', withTimestamp: true,
    data: { uploaded_by: null } },
];

function buildWhere(target, uid, phone) {
  const orClauses = [];
  if (target.whereByUid && uid) orClauses.push({ [target.whereByUid]: uid });
  if (target.whereByPhone && phone) orClauses.push({ [target.whereByPhone]: phone });
  if (orClauses.length === 0) return null;
  return orClauses.length === 1 ? orClauses[0] : { OR: orClauses };
}

async function eraseTarget(target, where) {
  const model = prisma[target.model];
  if (target.action === 'delete') {
    const result = await model.deleteMany({ where });
    return { action: 'deleted', count: result.count };
  }

  const data = target.withTimestamp
    ? { ...target.data, updated_at: new Date() }
    : { ...target.data };
  const result = await model.updateMany({ where, data });
  return { action: 'anonymized', count: result.count };
}

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

  // Per-table failure tolerance is intentional — a row-level error on one
  // table (e.g. an FK that prevents an UPDATE) shouldn't block deletion
  // of devices, tokens, or other PII the user is entitled to have erased.
  // Each result row records the per-table outcome for the audit log.
  for (const target of ERASURE_TARGETS) {
    const where = buildWhere(target, uid, phone);
    if (!where) {
      results[target.model] = { action: 'skipped', reason: 'no matching identifier' };
      continue;
    }
    try {
      results[target.model] = await eraseTarget(target, where);
    } catch (err) {
      logger.error(`GDPR erasure failed for ${target.model}`, {
        error: err.message, uid, requestId,
      });
      results[target.model] = { action: 'error', error: 'Table operation failed' };
    }
  }

  // Finally, anonymize the user record itself.
  if (uid) {
    try {
      const userResult = await prisma.users.updateMany({
        where: { uid },
        data: {
          name: ANON,
          email: ANON_EMAIL,
          address: ANON,
          gender: null,
          birthday: null,
          anniversary: null,
          profile_picture: null,
          emergency_contact: null,
          blood_group: null,
          allergies: null,
          medical_history: null,
          is_active: false,
          updated_at: new Date(),
        },
      });
      results.users = { action: 'anonymized', count: userResult.count };
    } catch (err) {
      logger.error('GDPR erasure failed for users', {
        error: err.message, uid, requestId,
      });
      results.users = { action: 'error', error: 'User anonymization failed' };
    }
  }

  const completedAt = new Date();
  const durationMs = Date.now() - startTime;
  const phoneHash = phone
    ? crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16)
    : null;

  // gdpr_erasure_log is canonical (created in migration 094). Failure here
  // is a real compliance signal — do not swallow.
  await prisma.gdpr_erasure_log.create({
    data: {
      uid: uid || null,
      phone_hash: phoneHash,
      requested_by: requestedBy || null,
      reason,
      ip,
      tables_processed: Object.keys(results).length,
      completed_at: completedAt,
      duration_ms: durationMs,
      results,
    },
  });

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
    uid, duration_ms: durationMs,
    tablesProcessed: Object.keys(results).length,
  });

  return {
    success: true,
    uid,
    erasedAt: completedAt.toISOString(),
    duration_ms: durationMs,
    tables: results,
  };
}

/**
 * Check if a user has any legal hold that prevents erasure.
 * (e.g., ongoing legal proceedings, regulatory requirements)
 */
export async function checkLegalHold(uid) {
  if (!uid) return { hasHold: false, holds: [] };
  const holds = await prisma.legal_holds.findMany({
    where: { user_uid: uid, released_at: null },
    select: { id: true, reason: true, created_at: true },
  });
  return { hasHold: holds.length > 0, holds };
}
