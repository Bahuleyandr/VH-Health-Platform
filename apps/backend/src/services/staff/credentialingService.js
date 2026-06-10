// src/services/staff/credentialingService.js
//
// Roadmap D3 — credentialing & privileging registry: registrations,
// qualifications, privileges (who may operate / administer chemo /
// prescribe schedule-X), trainings, immunizations — with expiry tracking
// and a privilege check other domains gate on (first consumer: D1 chemo
// administration).

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const TYPES = ['registration', 'qualification', 'privilege', 'training', 'immunization'];

export async function addCredential({
  staffUid, credentialType, name, issuingBody = null, registrationNumber = null,
  validFrom = null, validUntil = null, documentRef = null, notes = null,
} = {}, context = {}) {
  if (!staffUid) throw AppError.badRequest('staff_uid required', 'CRED_STAFF_REQUIRED');
  if (!TYPES.includes(credentialType)) {
    throw AppError.badRequest(`credential_type must be one of ${TYPES.join(', ')}`, 'CRED_BAD_TYPE');
  }
  const cleanName = (name || '').trim();
  if (!cleanName) throw AppError.badRequest('name required', 'CRED_NAME_REQUIRED');
  const staff = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users WHERE uid = $1::uuid LIMIT 1`, staffUid,
  );
  if (!staff.length) throw AppError.notFound('Staff member not found', 'CRED_STAFF_NOT_FOUND');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO staff_credentials
         (staff_uid, credential_type, name, issuing_body, registration_number,
          valid_from, valid_until, document_ref, notes, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10::uuid)
       RETURNING *`,
      staffUid, credentialType, cleanName, issuingBody, registrationNumber,
      validFrom, validUntil, documentRef, notes, context.actorUid || null,
    );
    return rows[0];
  } catch (err) {
    if (String(err?.message || '').includes('uq_staff_credentials_active_privilege')) {
      throw AppError.conflict(`Staff member already holds active privilege '${cleanName}'`, 'CRED_PRIVILEGE_EXISTS');
    }
    throw err;
  }
}

export async function listCredentials(staffUid, { type = null } = {}) {
  const params = [staffUid];
  let where = 'staff_uid = $1::uuid';
  if (type) {
    if (!TYPES.includes(type)) throw AppError.badRequest('bad credential_type filter', 'CRED_BAD_TYPE');
    params.push(type);
    where += ` AND credential_type = $2`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT *, (valid_until IS NOT NULL AND valid_until < CURRENT_DATE) AS expired
       FROM staff_credentials WHERE ${where}
      ORDER BY credential_type, valid_until NULLS LAST`,
    ...params,
  );
}

export async function updateCredentialStatus(id, { status, notes = null } = {}, context = {}) {
  if (!['active', 'suspended', 'revoked'].includes(status)) {
    throw AppError.badRequest('status must be active|suspended|revoked', 'CRED_BAD_STATUS');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE staff_credentials SET
       status = $2, notes = COALESCE($3, notes),
       verified_by = $4::uuid, verified_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    Number.parseInt(id, 10), status, notes, context.actorUid || null,
  );
  if (!rows.length) throw AppError.notFound('Credential not found');
  return rows[0];
}

/** Expiry radar: active credentials expiring within `days` (or expired). */
export async function listExpiring({ days = 60 } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT c.*, u.name AS staff_name, u.role AS staff_role,
            (c.valid_until < CURRENT_DATE) AS expired,
            (c.valid_until - CURRENT_DATE)::int AS days_remaining
       FROM staff_credentials c
       JOIN users u ON u.uid = c.staff_uid
      WHERE c.status = 'active' AND c.valid_until IS NOT NULL
        AND c.valid_until <= CURRENT_DATE + $1::int
      ORDER BY c.valid_until ASC`,
    Math.min(Number.parseInt(days, 10) || 60, 365),
  );
}

/**
 * The privilege gate other domains call: active, in-date privilege row of
 * this name. Returns { allowed, reason }.
 */
export async function hasActivePrivilege(staffUid, privilegeName) {
  if (!staffUid || !privilegeName) return { allowed: false, reason: 'missing_input' };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, valid_until FROM staff_credentials
      WHERE staff_uid = $1::uuid AND credential_type = 'privilege'
        AND status = 'active' AND UPPER(name) = UPPER($2)
      LIMIT 1`,
    staffUid, String(privilegeName).trim(),
  );
  if (!rows.length) return { allowed: false, reason: 'privilege_not_held' };
  if (rows[0].valid_until && new Date(rows[0].valid_until) < new Date(new Date().toDateString())) {
    return { allowed: false, reason: 'privilege_expired' };
  }
  return { allowed: true, reason: null };
}

/** Daily radar job: surfaces expiring credentials into the logs/outbox. */
export async function expiryRadarSweep() {
  const expiring = await listExpiring({ days: 30 });
  if (expiring.length === 0) return { expiring: 0 };
  logger.warn(`Credential expiry radar: ${expiring.length} active credential(s) expire within 30 days`, {
    sample: expiring.slice(0, 5).map((c) => ({ staff: c.staff_name, name: c.name, until: c.valid_until })),
  });
  try {
    const { default: notificationOutbox } = await import('../../utils/notifications/notificationOutbox.js');
    if (notificationOutbox?.queue) {
      await notificationOutbox.queue({
        channel: 'system',
        recipient_role: 'ADMIN',
        title: 'Credentials expiring',
        body: `${expiring.length} staff credential(s) expire within 30 days — review /api/v1/credentials/expiring`,
        metadata: { kind: 'credential_expiry_radar', count: expiring.length },
      });
    }
  } catch (err) {
    logger.warn('Credential radar outbox notification failed (log entry stands)', { error: err.message });
  }
  return { expiring: expiring.length };
}

export default {
  addCredential,
  listCredentials,
  updateCredentialStatus,
  listExpiring,
  hasActivePrivilege,
  expiryRadarSweep,
};
