// src/services/gdpr/dataErasureService.js
// GDPR Article 17: Right to Erasure (Right to be Forgotten)
// Handles complete data anonymization/deletion across all tables.

import crypto from 'node:crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
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
  { model: 'notifications',     whereByUid: 'uid',         action: 'delete', tenantScoped: true },
  { model: 'user_devices',      whereByUid: 'user_uid',    action: 'delete' },
  { model: 'devices',           whereByPhone: 'phone',     action: 'delete' },

  // Session + auth data — delete entirely
  { model: 'invalidated_tokens', whereByUid: 'user_id',    action: 'delete' },
  { model: 'otp_logs',           whereByPhone: 'phone',    action: 'delete' },
  { model: 'auth_logs',          whereByPhone: 'phone',    action: 'delete' },

  // Medical data — anonymize (retain row for aggregate analytics, strip PII)
  { model: 'pharmacy_orders', whereByPhone: 'phone', action: 'anonymize', withTimestamp: true, tenantScoped: true,
    data: { phone: ANON_PHONE, order_note: ANON, delivery_address: ANON, delivery_landmark: ANON } },
  { model: 'investigations',  whereByPhone: 'phone', action: 'anonymize', withTimestamp: true, tenantScoped: true,
    data: { phone: ANON_PHONE, notes: ANON } },
  // health_records is the file-upload table (batch 45 documented this);
  // the only PII column is phone — there's no notes column here.
  { model: 'health_records',  whereByPhone: 'phone', action: 'anonymize', withTimestamp: true,
    data: { phone: ANON_PHONE } },
  { model: 'consultations',   whereByPhone: 'phone', action: 'anonymize', withTimestamp: true,
    data: { phone: ANON_PHONE, consultation_notes: ANON, diagnosis: ANON, treatment_plan: ANON } },
  { model: 'appointments',    whereByUid: 'uid',     action: 'anonymize', withTimestamp: true, tenantScoped: true,
    data: { reason: ANON, notes: ANON } },
  { model: 'feedback',        whereByPhone: 'phone', action: 'anonymize', withTimestamp: true,
    data: { phone: ANON_PHONE, comment: ANON } },

  // Consent records — anonymize
  { model: 'patient_consents', whereByUid: 'patient_uid', action: 'anonymize', withTimestamp: true, tenantScoped: true,
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

function buildWhere(target, uid, phone, tenantId = null) {
  const orClauses = [];
  if (target.whereByUid && uid) orClauses.push({ [target.whereByUid]: uid });
  if (target.whereByPhone && phone) orClauses.push({ [target.whereByPhone]: phone });
  if (orClauses.length === 0) return null;
  const subjectWhere = orClauses.length === 1 ? orClauses[0] : { OR: orClauses };
  if (target.tenantScoped && tenantId) {
    return { AND: [subjectWhere, { tenant_id: tenantId }] };
  }
  return subjectWhere;
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

async function resolveErasureSubject({ uid = null, phone = null, tenantId = null }) {
  if (!uid && !phone) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, phone, tenant_id
       FROM users
      WHERE ($1::uuid IS NULL OR uid = $1::uuid)
        AND ($2::text IS NULL OR phone = $2)
        AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
      ORDER BY registered_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    uid || null,
    phone || null,
    tenantId || null,
  );
  return rows[0] || null;
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
 * @param {string|null} params.tenantId - Tenant boundary for the erasure
 * @returns {Object} Summary of actions taken per table
 */
export async function executeErasure({ uid, phone, requestedBy, reason, ip, requestId, tenantId = null }) {
  const results = {};
  const startTime = Date.now();

  const subject = await resolveErasureSubject({ uid, phone, tenantId });
  if (!subject?.uid) {
    throw AppError.notFound('User not found for erasure in this tenant', 'GDPR_USER_NOT_FOUND');
  }
  uid = subject.uid;
  phone = subject.phone || phone || null;

  const holdCheck = await checkLegalHold(uid, { tenantId });
  if (holdCheck.hasHold) {
    throw AppError.forbidden('Cannot erase: user has an active legal hold', 'LEGAL_HOLD_ACTIVE', {
      holds: holdCheck.holds,
    });
  }

  logger.info('GDPR erasure initiated', {
    uid, tenantId, phone: phone ? `***${phone.slice(-4)}` : null,
    requestedBy, reason, requestId,
  });

  // Per-table failure tolerance is intentional — a row-level error on one
  // table (e.g. an FK that prevents an UPDATE) shouldn't block deletion
  // of devices, tokens, or other PII the user is entitled to have erased.
  // Each result row records the per-table outcome for the audit log.
  for (const target of ERASURE_TARGETS) {
    const where = buildWhere(target, uid, phone, tenantId);
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
        where: {
          uid,
          ...(tenantId ? { tenant_id: tenantId } : {}),
        },
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
    tenantId,
  });

  logger.info('GDPR erasure completed', {
    uid, tenantId, duration_ms: durationMs,
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
export async function checkLegalHold(uid, { tenantId = null } = {}) {
  if (!uid) return { hasHold: false, holds: [] };
  if (tenantId) {
    const holds = await prisma.$queryRawUnsafe(
      `SELECT lh.id, lh.reason, lh.created_at
         FROM legal_holds lh
         JOIN users u
           ON u.uid = lh.user_uid
          AND u.tenant_id = $2::uuid
        WHERE lh.user_uid = $1::uuid
          AND lh.released_at IS NULL
        ORDER BY lh.created_at DESC`,
      uid,
      tenantId,
    );
    return { hasHold: holds.length > 0, holds };
  }
  const holds = await prisma.legal_holds.findMany({
    where: { user_uid: uid, released_at: null },
    select: { id: true, reason: true, created_at: true },
  });
  return { hasHold: holds.length > 0, holds };
}
