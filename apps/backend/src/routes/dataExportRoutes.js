// src/routes/dataExportRoutes.js
// GDPR Patient Data Export & Deletion

import { Router } from 'express';
import prisma, { setTenantTx } from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { deriveTenantIdFromRequest } from '../services/security/accessDecisionService.js';
import { checkLegalHold } from '../services/gdpr/dataErasureService.js';
import { success, error } from '../utils/responseHelper.js';
import * as tokenBlacklist from '../utils/tokenBlacklist.js';

import { maskPhoneForLog } from '../utils/logMasking.js';

if (
  process.env.NODE_ENV !== 'test'
  && typeof tokenBlacklist.withAuthIdentityLifecycleLocks !== 'function'
) {
  throw new Error('Auth identity lifecycle locking is unavailable');
}
const withAuthIdentityLifecycleLocks = tokenBlacklist.withAuthIdentityLifecycleLocks
  ?? ((_client, _uids, fn) => fn(_client));
const persistRevokeAllUserTokens = tokenBlacklist.persistRevokeAllUserTokens;
const publishRevokeAllUserTokens = tokenBlacklist.publishRevokeAllUserTokens;
const router = Router();

async function findCurrentPatient(req) {
  const userId = req.user?.uid || req.user?.phone;
  if (!userId) return null;

  const tenantId = deriveTenantIdFromRequest(req);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, name, phone, email, role, gender, birthday, address, allergies,
            emergency_contact, blood_group, registered_at, is_active, tenant_id
       FROM users
      WHERE tenant_id = $2::uuid
        AND (uid::text = $1 OR phone = $1)
      LIMIT 1`,
    String(userId),
    tenantId,
  );

  return rows[0] || null;
}

/**
 * GET /api/v1/data-export/my-data
 * Export all patient data as a JSON download.
 */
router.get('/my-data', async (req, res) => {
  const userId = req.user?.uid || req.user?.phone;
  const tenantId = deriveTenantIdFromRequest(req);

  if (!userId) {
    return error(res, 'Unauthorized', 401);
  }

  try {
    const user = await findCurrentPatient(req);
    if (!user) {
      return error(res, 'User not found', 404);
    }

    const phone = user.phone;
    const uid = user.uid;
    const userIntId = user.id;

    // Collect all patient data
    const [
      appointments,
      healthRecords,
      patientRecords,
      investigations,
      pharmacyOrders,
      feedback,
      notifications,
      consents,
      dataRightsRequests,
    ] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT id, patient_id, doctor_id, appointment_date, appointment_time, status,
                reason, notes, token_number, department, created_at, updated_at
           FROM appointments
          WHERE tenant_id = $3::uuid
            AND (uid = $1::uuid OR phone = $2 OR patient_id = $4::int)
          LIMIT 10000`,
        uid, phone, tenantId, userIntId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, phone, record_type, file_key, file_name, created_at
           FROM health_records hr
          WHERE hr.phone = $1
            AND EXISTS (
              SELECT 1 FROM users u
               WHERE u.uid = $2::uuid
                 AND u.tenant_id = $3::uuid
                 AND u.phone = hr.phone
            )
          LIMIT 10000`,
        phone, uid, tenantId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, patient_id, document_type AS record_type, title,
                file_key, file_name, notes, created_at
           FROM patient_records
          WHERE patient_id = $1::int
            AND tenant_id = $2::uuid
          LIMIT 10000`,
        userIntId, tenantId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, phone, investigation_type, status, results, notes, created_at
           FROM investigations
          WHERE tenant_id = $3::uuid
            AND (patient_uid = $1::uuid OR uid = $1::uuid OR phone = $2)
          LIMIT 10000`,
        uid, phone, tenantId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, phone, order_note, file_key, status, priority, created_at, updated_at
           FROM pharmacy_orders
          WHERE tenant_id = $3::uuid
            AND (uid = $1::uuid OR phone = $2)
          LIMIT 10000`,
        uid, phone, tenantId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, phone, rating, comment, appointment_id, created_at
           FROM feedback f
          WHERE f.phone = $1
            AND EXISTS (
              SELECT 1 FROM users u
               WHERE u.uid = $2::uuid
                 AND u.tenant_id = $3::uuid
                 AND u.phone = f.phone
            )
          LIMIT 10000`,
        phone, uid, tenantId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, phone, title, body, type, is_read, created_at
           FROM notifications
          WHERE tenant_id = $3::uuid
            AND (uid = $1::uuid OR phone = $2 OR user_id = $4::int)
          LIMIT 10000`,
        uid, phone, tenantId, userIntId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, patient_uid, consent_type, granted, status, granted_at,
                revoked_at, expires_at, purpose, data_categories, version, source, created_at
           FROM patient_consents
          WHERE tenant_id = $2::uuid
            AND patient_uid = $1::uuid
          ORDER BY created_at DESC
          LIMIT 10000`,
        uid, tenantId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, patient_uid, request_type, status, requested_by, request_source,
                due_at, notes, resolution, completed_at, created_at
           FROM patient_data_rights_requests
          WHERE tenant_id = $2::uuid
            AND patient_uid = $1::uuid
          ORDER BY created_at DESC
          LIMIT 10000`,
        uid, tenantId,
      ),
    ]);

    const exportData = {
      exportDate: new Date().toISOString(),
      profile: user,
      appointments: appointments,
      healthRecords: healthRecords,
      medicalRecords: patientRecords,
      investigations: investigations,
      pharmacyOrders: pharmacyOrders,
      feedback: feedback,
      notifications: notifications,
      consents,
      dataRightsRequests,
    };

    // Audit log
    logger.info(`📦 Data export requested by user ${uid} (${maskPhoneForLog(phone)})`);

    // Deliberately NOT the success() envelope: this response is the export
    // ARTIFACT itself (Content-Disposition download), not an API payload.
    res.setHeader('Content-Disposition', `attachment; filename="patient-data-${uid}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.json(exportData);
  } catch (err) {
    logger.error(`Data export failed for ${userId}: ${err.message}`);
    return error(res, 'Failed to export data', 500);
  }
});

/**
 * DELETE /api/v1/data-export/my-data
 * Soft-delete all patient data (GDPR right to erasure).
 * Marks records with deleted_at timestamp for legal retention.
 */
router.delete('/my-data', async (req, res) => {
  const userId = req.user?.uid || req.user?.phone;
  const tenantId = deriveTenantIdFromRequest(req);

  if (!userId) {
    return error(res, 'Unauthorized', 401);
  }

  try {
    const user = await findCurrentPatient(req);
    if (!user) {
      return error(res, 'User not found', 404);
    }

    const phone = user.phone;
    const uid = user.uid;
    const userIntId = user.id;
    const now = new Date().toISOString();
    const holdCheck = await checkLegalHold(uid, { tenantId });
    if (holdCheck.hasHold) {
      return error(res, 'Cannot erase: user has an active legal hold', 403, {
        topLevel: { code: 'LEGAL_HOLD_ACTIVE' },
      });
    }

    // Soft-delete across all tables that support deleted_at
    // Using best-effort: if a table doesn't have deleted_at column, skip it
    // Whitelist of allowed table names to prevent SQL injection via dynamic table names
    const allowedTables = ['users', 'appointments', 'health_records', 'investigations', 'pharmacy_orders', 'feedback', 'notifications'];

    const tables = [
      { table: 'users', where: 'uid = $2::uuid AND tenant_id = $3::uuid', params: [uid, tenantId] },
      { table: 'appointments', where: '(uid = $2::uuid OR phone = $3 OR patient_id = $4::int) AND tenant_id = $5::uuid', params: [uid, phone, userIntId, tenantId] },
      { table: 'health_records', where: 'phone = $2 AND EXISTS (SELECT 1 FROM users u WHERE u.uid = $3::uuid AND u.tenant_id = $4::uuid AND u.phone = health_records.phone)', params: [phone, uid, tenantId] },
      { table: 'investigations', where: '(patient_uid = $2::uuid OR uid = $2::uuid OR phone = $3) AND tenant_id = $4::uuid', params: [uid, phone, tenantId] },
      { table: 'pharmacy_orders', where: '(uid = $2::uuid OR phone = $3) AND tenant_id = $4::uuid', params: [uid, phone, tenantId] },
      { table: 'feedback', where: 'phone = $2 AND EXISTS (SELECT 1 FROM users u WHERE u.uid = $3::uuid AND u.tenant_id = $4::uuid AND u.phone = feedback.phone)', params: [phone, uid, tenantId] },
      { table: 'notifications', where: '(uid = $2::uuid OR phone = $3 OR user_id = $4::int) AND tenant_id = $5::uuid', params: [uid, phone, userIntId, tenantId] },
    ];

    const { results, revokedAt } = await setTenantTx(tenantId, async (tx) => {
      await withAuthIdentityLifecycleLocks(tx, [uid], async () => {});

      const deletionResults = [];
      for (const [index, { table, where, params }] of tables.entries()) {
        if (!allowedTables.includes(table)) throw new Error('Invalid table');
        const savepoint = `patient_data_erasure_${index}`;
        await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
        try {
          // Parameterize the timestamp as $1; table name is safe (whitelisted above).
          const deletedAtExpression = table === 'users' ? 'COALESCE(deleted_at, $1)' : '$1';
          const notAlreadyDeleted = table === 'users' ? '' : ' AND deleted_at IS NULL';
          const result = await tx.$queryRawUnsafe(
            `UPDATE ${table} SET deleted_at = ${deletedAtExpression} WHERE ${where}${notAlreadyDeleted} RETURNING id`,
            now, ...params
          );
          if (table === 'users' && result.length !== 1) {
            throw new Error('Patient identity was not eligible for deletion');
          }
          await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
          deletionResults.push({ table, affected: result.length });
        } catch (err) {
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
          if (table === 'users') throw err;
          // Table might not have deleted_at column — that's OK. Log the real
          // failure server-side; the response must never carry err.message
          // (repo rule: raw driver/Prisma errors leak schema + SQL detail).
          logger.error(`Soft-delete skipped for ${table}: ${err.message}`);
          deletionResults.push({ table, skipped: true, reason: 'Table not eligible for soft deletion' });
        }
      }

      const durableRevokedAt = await persistRevokeAllUserTokens(uid, {
        client: tx,
        requireEvidence: true,
        reason: 'patient_data_erasure',
        notificationTenantId: tenantId,
      });
      return { results: deletionResults, revokedAt: durableRevokedAt };
    });

    try {
      await publishRevokeAllUserTokens(uid, revokedAt, { reason: 'patient_data_erasure' });
    } catch (err) {
      logger.warn('Patient data-erasure revocation publication failed', {
        uid,
        error: err.message,
      });
    }

    logger.info(`🗑️ Data deletion requested by user ${uid} (${maskPhoneForLog(phone)}) — soft-deleted across ${results.length} tables`);

    return success(
      res,
      { details: results },
      'Your data has been marked for deletion. It will be retained for the legally required period before permanent removal.',
    );
  } catch (err) {
    logger.error(`Data deletion failed for ${userId}: ${err.message}`);
    return error(res, 'Failed to process deletion request', 500);
  }
});

export default router;
