// src/utils/logAudit.js

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

/**
 * Writes an audit trail log to the audit_logs table.
 *
 * Captures the acting-as delegation hop when present on the request:
 *   * `uid` (legacy)             — the actor (human pressing the button).
 *     When jwtMiddleware honoured X-Acting-As-Uid, req.acting.actorUid
 *     holds the guardian; otherwise it's just req.user.uid.
 *   * `actor_uid`                — same as `uid`, but explicit.
 *   * `subject_uid`              — req.user.uid AFTER any rewrite (the
 *     dependent on a delegated request, the actor on a normal one).
 *   * `acting_as_dependent`      — TRUE iff the request was delegated.
 *
 * @param {object} req - Express request (used to extract UID, IP, role)
 * @param {string} action - Short action string, e.g. 'role-change', 'delete-doctor'
 * @param {object} metadata - Optional structured metadata (JSON-safe)
 */
export async function logAudit(req, action, metadata = {}) {
  const actorUid = req.acting?.actorUid ?? req.user?.uid ?? null;
  const subjectUid = req.user?.uid ?? null;
  const actingAsDependent = req.acting != null;
  const role = req.acting?.actorRole ?? req.user?.role ?? null;
  const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || null;

  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (uid, role, action, ip_address, metadata,
          actor_uid, subject_uid, acting_as_dependent)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb,
               $6::uuid, $7::uuid, $8)`,
      actorUid, role, action, ip, JSON.stringify(metadata ?? {}),
      actorUid, subjectUid, actingAsDependent,
    );

    logger.info(
      `[AUDIT] ${action} | actor=${actorUid} subject=${subjectUid} acting_as=${actingAsDependent} | Role: ${role} | IP: ${ip} | Meta: ${JSON.stringify(metadata)}`
    );
  } catch (err) {
    logger.error(`[AUDIT-FAIL] ${action} failed to log: ${err.stack || err.message}`);
  }
}
