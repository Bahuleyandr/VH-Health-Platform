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
 * @param {object} options - Optional resource context for the audit row
 */
export async function logAudit(req, action, metadata = {}, options = {}) {
  try {
    const actorUid = req?.acting?.actorUid ?? req?.user?.uid ?? null;
    const subjectUid = req?.user?.uid ?? null;
    const actingAsDependent = req?.acting != null;
    const role = req?.acting?.actorRole ?? req?.user?.role ?? null;
    const ip = req?.headers?.['x-forwarded-for'] || req?.connection?.remoteAddress || null;
    const deviceType = req?.user?.deviceType ?? req?.user?.claims?.deviceType ?? null;
    const tenantId = req?.tenantId
      || req?.user?.tenant_id
      || req?.user?.tenantId
      || req?.tenant?.id
      || null;
    const userAgent = req?.headers?.['user-agent'] || null;
    const enrichedMetadata = {
      request_id: req?.id || null,
      device_type: deviceType,
      tenant_id: tenantId,
      actor_role: role,
      ...(metadata ?? {}),
    };

    await prisma.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (uid, role, action, resource, resource_id, ip_address, user_agent, metadata,
          actor_uid, subject_uid, acting_as_dependent)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb,
               $9::uuid, $10::uuid, $11)`,
      actorUid,
      role,
      action,
      options.resource || null,
      options.resourceId == null ? null : String(options.resourceId),
      ip,
      userAgent ? String(userAgent).slice(0, 500) : null,
      JSON.stringify(enrichedMetadata),
      actorUid,
      subjectUid,
      actingAsDependent,
    );

    logger.info(
      `[AUDIT] ${action} | actor=${actorUid} subject=${subjectUid} acting_as=${actingAsDependent} | Role: ${role} | IP: ${ip} | Meta: ${JSON.stringify(enrichedMetadata)}`
    );
  } catch (err) {
    logger.error(`[AUDIT-FAIL] ${action} failed to log: ${err.stack || err.message}`);
  }
}
