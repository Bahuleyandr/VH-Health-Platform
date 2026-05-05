// src/services/compliance/breachService.js
// HIPAA Data Breach Notification Service
// Manages breach lifecycle: report → investigate → contain → resolve → notify

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { normalizeAuditLogUserId } from '../../utils/auditLogIdentity.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];

// Valid status transitions — each key lists the statuses it can move to
const VALID_TRANSITIONS = {
  open: ['investigating', 'contained', 'resolved'],
  investigating: ['contained', 'resolved'],
  contained: ['resolved'],
  resolved: ['notified'],
  notified: [],
};

/**
 * Report a new data breach.
 * For high/critical severity, immediately queues admin notifications.
 */
export async function reportBreach({ severity, description, affectedRecords, affectedPatientUids, reportedBy }) {
  if (!severity || !description) {
    throw AppError.badRequest('severity and description are required');
  }

  if (!VALID_SEVERITIES.includes(severity)) {
    throw AppError.badRequest(`Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}`);
  }

  const result = await prisma.$queryRawUnsafe(
    `INSERT INTO data_breaches
      (severity, description, affected_records, affected_patient_uids, discovered_at, reported_by, status, created_at)
     VALUES ($1, $2, $3, $4, NOW(), $5, 'open', NOW())
     RETURNING id, breach_id, severity, description, affected_records, affected_patient_uids,
               discovered_at, reported_by, status, created_at`,
    
      severity,
      description,
      affectedRecords || 0,
      affectedPatientUids || [],
      reportedBy || null,
    
  );

  const breach = result[0];

  // Log to audit
  logBreachAudit(reportedBy, 'breach_reported', breach.breach_id, {
    severity,
    affected_records: affectedRecords || 0,
  });

  logger.warn('Data breach reported', {
    breach_id: breach.breach_id,
    severity,
    affected_records: affectedRecords || 0,
  });

  // High/critical severity — notify all admin users immediately
  if (severity === 'high' || severity === 'critical') {
    await notifyAdminsOfBreach(breach);
  }

  return breach;
}

/**
 * Update breach status to 'contained' with containment actions.
 */
export async function containBreach(breachId, containmentActions, adminId) {
  if (!breachId || !containmentActions) {
    throw AppError.badRequest('breachId and containmentActions are required');
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, breach_id, status FROM data_breaches WHERE breach_id = $1`,
    breachId
  );

  if (existing.length === 0) {
    throw AppError.notFound('Breach not found');
  }

  const currentStatus = existing[0].status;
  if (!VALID_TRANSITIONS[currentStatus]?.includes('contained')) {
    throw AppError.invalidTransition(currentStatus, 'contained', VALID_TRANSITIONS[currentStatus]);
  }

  const result = await prisma.$queryRawUnsafe(
    `UPDATE data_breaches
     SET status = 'contained', containment_actions = $1
     WHERE breach_id = $2
     RETURNING id, breach_id, severity, description, affected_records, status,
               containment_actions, discovered_at, created_at`,
    containmentActions, breachId
  );

  logBreachAudit(adminId, 'breach_contained', breachId, { containment_actions: containmentActions });

  logger.info('Breach contained', { breach_id: breachId, admin_id: adminId });

  return result[0];
}

/**
 * Resolve a breach with resolution notes.
 */
export async function resolveBreach(breachId, resolutionNotes, adminId) {
  if (!breachId || !resolutionNotes) {
    throw AppError.badRequest('breachId and resolutionNotes are required');
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, breach_id, status FROM data_breaches WHERE breach_id = $1`,
    breachId
  );

  if (existing.length === 0) {
    throw AppError.notFound('Breach not found');
  }

  const currentStatus = existing[0].status;
  if (!VALID_TRANSITIONS[currentStatus]?.includes('resolved')) {
    throw AppError.invalidTransition(currentStatus, 'resolved', VALID_TRANSITIONS[currentStatus]);
  }

  const result = await prisma.$queryRawUnsafe(
    `UPDATE data_breaches
     SET status = 'resolved', resolution_notes = $1, resolved_at = NOW()
     WHERE breach_id = $2
     RETURNING id, breach_id, severity, description, affected_records, status,
               containment_actions, resolution_notes, resolved_at, discovered_at, created_at`,
    resolutionNotes, breachId
  );

  logBreachAudit(adminId, 'breach_resolved', breachId, { resolution_notes: resolutionNotes });

  logger.info('Breach resolved', { breach_id: breachId, admin_id: adminId });

  return result[0];
}

/**
 * List breaches with optional status/severity filters, paginated.
 */
export async function getBreaches(filters = {}) {
  const { status, severity } = filters;
  const listQuery = parseListQuery(filters, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'created_at'
  });
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(status);
  }
  if (severity) {
    conditions.push(`severity = $${paramIndex++}`);
    params.push(severity);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS total FROM data_breaches ${whereClause}`,
    ...params
  );
  const total = parseInt(countResult[0].total, 10);

  params.push(listQuery.limit, listQuery.offset);

  const result = await prisma.$queryRawUnsafe(
    `SELECT id, breach_id, severity, description, affected_records,
            affected_patient_uids, discovered_at, reported_by, status,
            containment_actions, resolution_notes, resolved_at, created_at,
            regulator_notified_at, regulator_reference, regulator_jurisdiction,
            data_subjects_notified_at, data_subject_notification_count
     FROM data_breaches
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
    ...params
  );

  return {
    breaches: result,
    pagination: buildPagination(total, listQuery.page, listQuery.limit),
  };
}

/**
 * Get a single breach with its timeline of audit actions.
 */
export async function getBreachTimeline(breachId) {
  const breachResult = await prisma.$queryRawUnsafe(
    `SELECT id, breach_id, severity, description, affected_records,
            affected_patient_uids, discovered_at, reported_by, status,
            containment_actions, resolution_notes, resolved_at, created_at,
            regulator_notified_at, regulator_reference, regulator_jurisdiction,
            data_subjects_notified_at, data_subject_notification_count
     FROM data_breaches
     WHERE breach_id = $1`,
    breachId
  );

  if (breachResult.length === 0) {
    throw AppError.notFound('Breach not found');
  }

  // Fetch timeline from audit_log for this breach
  const timelineResult = await prisma.$queryRawUnsafe(
    `SELECT user_id, user_name, user_role, action, request_summary, created_at
     FROM audit_log
     WHERE module = 'compliance'
       AND request_summary LIKE $1
     ORDER BY created_at ASC`,
    `%${breachId}%`
  );

  return {
    breach: breachResult[0],
    timeline: timelineResult,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Fire-and-forget audit log entry for breach actions.
 */
function logBreachAudit(userId, action, breachId, details) {
  setImmediate(async () => {
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO audit_log
          (user_id, user_name, user_role, ip_address, method, path, module, action,
           request_summary, status_code, success)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        
          normalizeAuditLogUserId(userId),
          null,
          null,
          null,
          'SYSTEM',
          '/compliance/breach',
          'compliance',
          action,
          JSON.stringify({ breach_id: breachId, ...details }),
          200,
          true,
        
      );
    } catch (err) {
      logger.warn('Breach audit log write failed:', { error: err.message, breach_id: breachId });
    }
  });
}

/**
 * Notify all admin users about a high/critical breach.
 * Uses the notification_outbox table for reliable delivery.
 */
async function notifyAdminsOfBreach(breach) {
  try {
    const adminsResult = await prisma.$queryRawUnsafe(
      `SELECT uid, name, email FROM users WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND is_active = true`
    );

    if (adminsResult.length === 0) {
      logger.warn('No active admin users found for breach notification', { breach_id: breach.breach_id });
      return;
    }

    const title = `URGENT: Data Breach Reported — ${breach.severity.toUpperCase()}`;
    const body = `A ${breach.severity} severity data breach has been reported affecting ${breach.affected_records} records. Breach ID: ${breach.breach_id}`;

    for (const admin of adminsResult) {
      try {
        await prisma.$queryRawUnsafe(
          `INSERT INTO notification_outbox
            (type, recipient_id, recipient_phone, title, body, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW())`,
          
            'push',
            admin.uid,
            null,
            title,
            body,
            JSON.stringify({
              breach_id: breach.breach_id,
              severity: breach.severity,
              affected_records: breach.affected_records,
              action: 'breach_notification',
            }),
          
        );
      } catch (notifErr) {
        logger.warn('Failed to queue breach notification for admin:', {
          admin_uid: admin.uid,
          error: notifErr.message,
        });
      }
    }

    logBreachAudit(null, 'breach_admin_notifications_queued', breach.breach_id, {
      admin_count: adminsResult.length,
    });

    logger.info('Breach notifications queued for admins', {
      breach_id: breach.breach_id,
      admin_count: adminsResult.length,
    });
  } catch (err) {
    logger.error('Failed to notify admins of breach:', {
      breach_id: breach.breach_id,
      error: err.message,
    });
  }
}

/**
 * GDPR Art. 33 — supervisory authority notification (within 72 hours of
 * becoming aware). Records the notification timestamp + reference + the
 * jurisdiction the regulator covers.
 */
export async function notifyRegulator({ breachId, regulatorReference, jurisdiction, riskAssessment = null, dpaId = null, crossBorderImpact = false, notifiedBy = null }) {
  if (!breachId || !regulatorReference || !jurisdiction) {
    throw AppError.badRequest('breachId, regulatorReference and jurisdiction are required');
  }
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, breach_id, status, regulator_notified_at FROM data_breaches WHERE breach_id = $1`,
    breachId,
  );
  if (existing.length === 0) throw AppError.notFound('Breach not found');
  if (existing[0].regulator_notified_at) {
    throw AppError.conflict('Regulator already notified for this breach');
  }

  const result = await prisma.$queryRawUnsafe(
    `UPDATE data_breaches
     SET regulator_notified_at = NOW(),
         regulator_reference = $1,
         regulator_jurisdiction = $2,
         risk_assessment = COALESCE($3::jsonb, risk_assessment),
         dpa_id = COALESCE($4::int, dpa_id),
         cross_border_impact = $5
     WHERE breach_id = $6
     RETURNING id, breach_id, severity, status,
               regulator_notified_at, regulator_reference, regulator_jurisdiction,
               data_subjects_notified_at, data_subject_notification_count,
               risk_assessment, dpa_id, cross_border_impact, discovered_at, created_at`,
    regulatorReference,
    jurisdiction,
    riskAssessment ? JSON.stringify(riskAssessment) : null,
    dpaId ? Number(dpaId) : null,
    Boolean(crossBorderImpact),
    breachId,
  );

  logBreachAudit(notifiedBy, 'breach_regulator_notified', breachId, {
    regulator_reference: regulatorReference,
    jurisdiction,
    cross_border_impact: Boolean(crossBorderImpact),
  });
  logger.info('Breach regulator-notified', { breach_id: breachId, jurisdiction });
  return result[0];
}

/**
 * GDPR Art. 34 — high-risk data subjects must be notified directly.
 * Records timestamp + count of notified subjects.
 */
export async function notifyDataSubjects({ breachId, notificationCount, notifiedBy = null }) {
  if (!breachId) throw AppError.badRequest('breachId is required');
  const count = Number.parseInt(notificationCount, 10);
  if (!Number.isFinite(count) || count < 0) {
    throw AppError.badRequest('notificationCount must be a non-negative integer');
  }
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, breach_id, status FROM data_breaches WHERE breach_id = $1`,
    breachId,
  );
  if (existing.length === 0) throw AppError.notFound('Breach not found');

  const result = await prisma.$queryRawUnsafe(
    `UPDATE data_breaches
     SET data_subjects_notified_at = NOW(),
         data_subject_notification_count = $1
     WHERE breach_id = $2
     RETURNING id, breach_id, severity, status,
               data_subjects_notified_at, data_subject_notification_count,
               regulator_notified_at, regulator_reference, regulator_jurisdiction,
               risk_assessment, dpa_id, cross_border_impact, discovered_at, created_at`,
    count, breachId,
  );

  logBreachAudit(notifiedBy, 'breach_data_subjects_notified', breachId, {
    notification_count: count,
  });
  logger.info('Breach data-subjects notified', { breach_id: breachId, count });
  return result[0];
}

export default {
  reportBreach,
  containBreach,
  resolveBreach,
  getBreaches,
  getBreachTimeline,
  notifyRegulator,
  notifyDataSubjects,
};
