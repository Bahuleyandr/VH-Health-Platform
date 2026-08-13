import crypto from 'node:crypto';

import prisma, { prismaReadOnly, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MINIMUM_SAMPLE_SIZE = 5;
const VALID_CHANNELS = new Set(['app', 'web', 'sms', 'whatsapp', 'email', 'voice', 'kiosk', 'manual', 'other']);
const VALID_ENCOUNTER_TYPES = new Set(['appointment', 'teleconsult', 'admission', 'rpm_episode', 'manual', 'other']);
const VALID_REDACTION_STATUSES = new Set(['not_reviewed', 'safe', 'redacted', 'requires_review']);
const URGENT_COMMENT_RE = /\b(unsafe|abuse|harass|harassment|assault|neglect|negligence|infection|bleeding|emergency|danger|threat|death|died|suicide|violence|bribe|extort)\b/i;

function normalizeInt(value, label, { min = null, max = null, fallback = null } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeText(value, { max = 8000, fallback = null } = {}) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

function normalizeEnum(value, allowed, label, fallback) {
  const clean = normalizeText(value, { max: 80, fallback });
  if (!allowed.has(clean)) {
    throw AppError.badRequest(`${label} must be one of: ${Array.from(allowed).join(', ')}`);
  }
  return clean;
}

export function npsBucket(score) {
  const cleanScore = normalizeInt(score, 'score', { min: 0, max: 10 });
  if (cleanScore <= 6) return 'detractor';
  if (cleanScore <= 8) return 'passive';
  return 'promoter';
}

function maybeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shapeMetricRow(row = {}) {
  return {
    response_count: maybeNumber(row.response_count) ?? 0,
    request_count: maybeNumber(row.request_count) ?? 0,
    promoter_count: maybeNumber(row.promoter_count) ?? 0,
    passive_count: maybeNumber(row.passive_count) ?? 0,
    detractor_count: maybeNumber(row.detractor_count) ?? 0,
    nps_score: maybeNumber(row.nps_score),
    response_rate: maybeNumber(row.response_rate),
    minimum_sample_size: maybeNumber(row.minimum_sample_size) ?? DEFAULT_MINIMUM_SAMPLE_SIZE,
    sample_visible: Boolean(row.sample_visible),
  };
}

function shapeNpsResponse(row = {}) {
  return {
    id: row.id != null ? String(row.id) : null,
    tenant_id: row.tenant_id,
    patient_uid: row.patient_uid,
    feedback_id: maybeNumber(row.feedback_id),
    appointment_id: maybeNumber(row.appointment_id),
    encounter_type: row.encounter_type,
    encounter_ref: row.encounter_ref,
    score: maybeNumber(row.score),
    nps_bucket: row.nps_bucket,
    channel: row.channel,
    consent_id: maybeNumber(row.consent_id),
    comment: row.comment,
    comment_redaction_status: row.comment_redaction_status,
    comment_redaction_metadata: row.comment_redaction_metadata || {},
    department_id: maybeNumber(row.department_id),
    department_display_name: row.department_display_name,
    doctor_id: maybeNumber(row.doctor_id),
    doctor_display_name: row.doctor_display_name,
    service_line: row.service_line,
    submitted_at: row.submitted_at,
    created_at: row.created_at,
  };
}

function dedupeHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 48);
}

async function assertPatientInTenant(client, patientUid, tenantId) {
  const rows = await client.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid AND is_active = true
      LIMIT 1`,
    patientUid,
    tenantId,
  );
  if (!rows[0]) {
    throw AppError.notFound('Patient not found in tenant', 'NPS_PATIENT_NOT_FOUND');
  }
}

async function resolveAppointmentContext(client, appointmentId, tenantId) {
  if (!appointmentId) return {};
  const rows = await client.$queryRawUnsafe(
    `SELECT a.id, a.patient_id, a.doctor_id, a.doctor_name, a.department,
            u.uid AS patient_uid,
            du.name AS doctor_user_name
       FROM appointments a
       LEFT JOIN users u ON u.id = a.patient_id
       LEFT JOIN users du ON du.id = a.doctor_id
      WHERE a.id = $1 AND a.tenant_id = $2::uuid
      LIMIT 1`,
    appointmentId,
    tenantId,
  );
  if (!rows[0]) {
    throw AppError.notFound('Appointment not found in tenant', 'NPS_APPOINTMENT_NOT_FOUND');
  }
  const row = rows[0];
  return {
    patientUid: row.patient_uid || null,
    doctorId: maybeNumber(row.doctor_id),
    doctorDisplayName: row.doctor_user_name || row.doctor_name || null,
    departmentDisplayName: row.department || null,
    serviceLine: row.department || null,
  };
}

async function resolveFeedbackContext(client, feedbackId, tenantId) {
  if (!feedbackId) return {};
  const rows = await client.$queryRawUnsafe(
    `SELECT f.id, f.uid, f.appointment_id, f.doctor_id, f.department_id,
            d.name AS doctor_display_name,
            dept.name AS department_display_name
       FROM feedback f
       LEFT JOIN doctors d ON d.id = f.doctor_id
       LEFT JOIN departments dept ON dept.id = f.department_id
      WHERE f.id = $1 AND f.tenant_id = $2::uuid
      LIMIT 1`,
    feedbackId,
    tenantId,
  );
  if (!rows[0]) {
    throw AppError.notFound('Feedback not found in tenant', 'NPS_FEEDBACK_NOT_FOUND');
  }
  const row = rows[0];
  return {
    patientUid: row.uid || null,
    appointmentId: maybeNumber(row.appointment_id),
    doctorId: maybeNumber(row.doctor_id),
    doctorDisplayName: row.doctor_display_name || null,
    departmentId: maybeNumber(row.department_id),
    departmentDisplayName: row.department_display_name || null,
    serviceLine: row.department_display_name || null,
  };
}

function isServiceRecoveryCase({ score, comment }) {
  return score <= 6 || URGENT_COMMENT_RE.test(String(comment || ''));
}

async function createServiceRecoveryTask({ tx, tenantId, response, createdBy, urgentComment }) {
  const priority = response.score <= 3 || urgentComment ? 'critical' : 'high';
  const task = await createTask({
    tenantId,
    taskKind: 'review',
    title: `NPS service recovery: ${response.nps_bucket} score ${response.score}`,
    description: 'Review the NPS response, contact the patient if appropriate, and document the recovery action. Do not generate automated clinical advice.',
    patientUid: response.patient_uid,
    relatedResourceType: 'feedback_nps_response',
    relatedResourceId: String(response.id),
    priority,
    assignedToRole: 'QUALITY_OFFICER',
    createdBy,
    dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    metadata: {
      source: 'nl9_p2_nps',
      owner_default: 'quality/admin',
      nps_response_id: String(response.id),
      score: response.score,
      nps_bucket: response.nps_bucket,
      urgent_comment: urgentComment,
      comment_redaction_status: response.comment_redaction_status,
    },
    tx,
    onConflictResourceDoNothing: true,
  });
  return task || null;
}

async function queueRecoveryNotification({ tenantId, task, response }) {
  if (!task) return null;
  try {
    const recipients = await prismaReadOnly.$queryRawUnsafe(
      `SELECT id
         FROM users
        WHERE tenant_id = $1::uuid
          AND role IN ('QUALITY_OFFICER', 'ADMIN', 'SUPER_ADMIN')
          AND is_active = true
        ORDER BY
          CASE role WHEN 'QUALITY_OFFICER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END,
          id
        LIMIT 20`,
      tenantId,
    );
    if (!recipients.length) return null;

    const queued = [];
    for (const recipient of recipients) {
      const notification = await notificationOutbox.queue({
        type: 'in_app',
        recipientId: recipient.id,
        title: 'NPS service recovery required',
        body: 'A low-score or urgent NPS response needs quality review.',
        data: {
          tenant_id: tenantId,
          kind: 'service_recovery',
          task_id: task.id,
          nps_response_id: String(response.id),
        },
      });
      if (notification) queued.push(notification);
    }
    return queued;
  } catch (err) {
    logger.warn('NPS service recovery notification failed', {
      npsResponseId: response?.id ? String(response.id) : null,
      err: err?.message,
    });
    return null;
  }
}

export async function submitNpsResponse(input = {}) {
  const tenantId = requireTenantId(input.tenantId);
  const score = normalizeInt(input.score, 'score', { min: 0, max: 10 });
  const bucket = npsBucket(score);
  const channel = normalizeEnum(input.channel || 'app', VALID_CHANNELS, 'channel', 'app');
  const encounterType = normalizeEnum(input.encounterType || 'appointment', VALID_ENCOUNTER_TYPES, 'encounter_type', 'appointment');
  const feedbackId = normalizeInt(input.feedbackId ?? input.feedback_id, 'feedback_id', { min: 1 });
  let appointmentId = normalizeInt(input.appointmentId ?? input.appointment_id, 'appointment_id', { min: 1 });
  const consentId = normalizeInt(input.consentId ?? input.consent_id, 'consent_id', { min: 1 });
  const comment = normalizeText(input.comment, { max: 8000 });
  const commentRedactionStatus = normalizeEnum(
    input.commentRedactionStatus || input.comment_redaction_status || 'not_reviewed',
    VALID_REDACTION_STATUSES,
    'comment_redaction_status',
    'not_reviewed',
  );
  const submittedAt = input.submittedAt || input.submitted_at || null;
  const sourceCampaignRecipientId = normalizeInt(
    input.sourceCampaignRecipientId ?? input.source_campaign_recipient_id,
    'source_campaign_recipient_id',
    { min: 1 },
  );
  const createdBy = normalizeText(input.createdBy || input.created_by, { max: 80 });

  const result = await setTenantTx(tenantId, async (tx) => {
    const feedbackContext = await resolveFeedbackContext(tx, feedbackId, tenantId);
    if (!appointmentId && feedbackContext.appointmentId) appointmentId = feedbackContext.appointmentId;
    const appointmentContext = await resolveAppointmentContext(tx, appointmentId, tenantId);

    const patientUid = normalizeText(
      input.patientUid || input.patient_uid || feedbackContext.patientUid || appointmentContext.patientUid,
      { max: 80 },
    );
    if (!patientUid) throw AppError.badRequest('patient_uid is required for NPS response');
    await assertPatientInTenant(tx, patientUid, tenantId);

    if (feedbackContext.patientUid && feedbackContext.patientUid !== patientUid) {
      throw AppError.forbidden('Feedback belongs to a different patient', 'NPS_FEEDBACK_PATIENT_MISMATCH');
    }
    if (appointmentContext.patientUid && appointmentContext.patientUid !== patientUid) {
      throw AppError.forbidden('Appointment belongs to a different patient', 'NPS_APPOINTMENT_PATIENT_MISMATCH');
    }

    const encounterRef = normalizeText(input.encounterRef || input.encounter_ref, { max: 120 })
      || (appointmentId ? String(appointmentId) : null)
      || (feedbackId ? `feedback:${feedbackId}` : null)
      || 'manual';
    const dedupeKey = normalizeText(input.dedupeKey || input.dedupe_key, { max: 160 }) || dedupeHash({
      tenantId,
      patientUid,
      feedbackId,
      appointmentId,
      encounterType,
      encounterRef,
      sourceCampaignRecipientId,
    });
    const departmentId = normalizeInt(
      input.departmentId ?? input.department_id ?? feedbackContext.departmentId,
      'department_id',
      { min: 1 },
    );
    const departmentDisplayName = normalizeText(
      input.departmentDisplayName || input.department_display_name || feedbackContext.departmentDisplayName || appointmentContext.departmentDisplayName,
      { max: 255 },
    );
    const doctorId = normalizeInt(
      input.doctorId ?? input.doctor_id ?? feedbackContext.doctorId ?? appointmentContext.doctorId,
      'doctor_id',
      { min: 1 },
    );
    const doctorDisplayName = normalizeText(
      input.doctorDisplayName || input.doctor_display_name || feedbackContext.doctorDisplayName || appointmentContext.doctorDisplayName,
      { max: 255 },
    );
    const serviceLine = normalizeText(input.serviceLine || input.service_line || appointmentContext.serviceLine || feedbackContext.serviceLine, { max: 120 });

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO feedback_nps_responses
         (tenant_id, patient_uid, feedback_id, appointment_id,
          encounter_type, encounter_ref, score, nps_bucket, channel, consent_id,
          comment, comment_redaction_status, comment_redaction_metadata,
          source_campaign_recipient_id, dedupe_key,
          department_id, department_display_name, doctor_id, doctor_display_name,
          service_line, submitted_at, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4,
          $5, $6, $7, $8, $9, $10,
          $11, $12, $13::jsonb,
          $14, $15,
          $16, $17, $18, $19,
          $20, COALESCE($21::timestamptz, NOW()), $22::uuid)
       ON CONFLICT (tenant_id, dedupe_key) DO UPDATE
          SET updated_at = feedback_nps_responses.updated_at
       RETURNING id::text, tenant_id, patient_uid, feedback_id, appointment_id,
                 encounter_type, encounter_ref, score, nps_bucket, channel,
                 consent_id, comment, comment_redaction_status,
                 comment_redaction_metadata, department_id, department_display_name,
                 doctor_id, doctor_display_name, service_line,
                 submitted_at, created_at`,
      tenantId,
      patientUid,
      feedbackId,
      appointmentId,
      encounterType,
      encounterRef,
      score,
      bucket,
      channel,
      consentId,
      comment,
      commentRedactionStatus,
      JSON.stringify(input.commentRedactionMetadata || input.comment_redaction_metadata || {}),
      sourceCampaignRecipientId,
      dedupeKey,
      departmentId,
      departmentDisplayName,
      doctorId,
      doctorDisplayName,
      serviceLine,
      submittedAt,
      createdBy,
    );

    const response = shapeNpsResponse(rows[0]);
    const urgentComment = URGENT_COMMENT_RE.test(String(comment || ''));
    let recoveryTask = null;
    if (isServiceRecoveryCase({ score, comment })) {
      recoveryTask = await createServiceRecoveryTask({
        tx,
        tenantId,
        response,
        createdBy,
        urgentComment,
      });
    }
    return { response, recoveryTask };
  });

  const recoveryNotification = await queueRecoveryNotification({
    tenantId,
    task: result.recoveryTask,
    response: result.response,
  });
  return { ...result, recoveryNotification };
}

export async function getNpsDashboard({
  tenantId = null,
  days = DEFAULT_LOOKBACK_DAYS,
  minimumSampleSize = DEFAULT_MINIMUM_SAMPLE_SIZE,
} = {}) {
  const tid = requireTenantId(tenantId);
  const lookbackDays = normalizeInt(days, 'days', { min: 1, max: 365, fallback: DEFAULT_LOOKBACK_DAYS });
  const minSample = normalizeInt(minimumSampleSize, 'minimum_sample_size', { min: 1, max: 1000, fallback: DEFAULT_MINIMUM_SAMPLE_SIZE });

  const overallRows = await prismaReadOnly.$queryRawUnsafe(
    `WITH base AS (
       SELECT score, nps_bucket
         FROM feedback_nps_responses
        WHERE tenant_id = $1::uuid
          AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
     ), requests AS (
       SELECT COUNT(*)::int AS request_count
         FROM scheduled_notifications sn
         JOIN users u
           ON u.tenant_id = sn.tenant_id
          AND u.id = sn.user_id
        WHERE sn.tenant_id = $1::uuid
          AND u.tenant_id = $1::uuid
          AND sn.type IN ('feedback_request', 'nps_request')
          AND sn.created_at >= NOW() - $2::int * INTERVAL '1 day'
     )
     SELECT COUNT(*)::int AS response_count,
            (SELECT request_count FROM requests)::int AS request_count,
            COUNT(*) FILTER (WHERE nps_bucket = 'promoter')::int AS promoter_count,
            COUNT(*) FILTER (WHERE nps_bucket = 'passive')::int AS passive_count,
            COUNT(*) FILTER (WHERE nps_bucket = 'detractor')::int AS detractor_count,
            CASE WHEN COUNT(*) >= $3::int
              THEN ROUND(((COUNT(*) FILTER (WHERE nps_bucket = 'promoter') * 100.0 / NULLIF(COUNT(*), 0))
                   - (COUNT(*) FILTER (WHERE nps_bucket = 'detractor') * 100.0 / NULLIF(COUNT(*), 0))), 1)::float8
              ELSE NULL END AS nps_score,
            CASE WHEN (SELECT request_count FROM requests) > 0
              THEN ROUND((COUNT(*) * 100.0 / (SELECT request_count FROM requests)), 1)::float8
              ELSE NULL END AS response_rate,
            $3::int AS minimum_sample_size,
            (COUNT(*) >= $3::int) AS sample_visible
       FROM base`,
    tid,
    lookbackDays,
    minSample,
  );

  const trendRows = await prismaReadOnly.$queryRawUnsafe(
    `WITH responses AS (
       SELECT submitted_at::date AS day,
              COUNT(*)::int AS response_count,
              COUNT(*) FILTER (WHERE nps_bucket = 'promoter')::int AS promoter_count,
              COUNT(*) FILTER (WHERE nps_bucket = 'passive')::int AS passive_count,
              COUNT(*) FILTER (WHERE nps_bucket = 'detractor')::int AS detractor_count
         FROM feedback_nps_responses
        WHERE tenant_id = $1::uuid
          AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
        GROUP BY submitted_at::date
     ), requests AS (
       SELECT sn.created_at::date AS day, COUNT(*)::int AS request_count
         FROM scheduled_notifications sn
         JOIN users u
           ON u.tenant_id = sn.tenant_id
          AND u.id = sn.user_id
        WHERE sn.tenant_id = $1::uuid
          AND u.tenant_id = $1::uuid
          AND sn.type IN ('feedback_request', 'nps_request')
          AND sn.created_at >= NOW() - $2::int * INTERVAL '1 day'
        GROUP BY sn.created_at::date
     )
     SELECT COALESCE(r.day, q.day)::text AS day,
            COALESCE(r.response_count, 0)::int AS response_count,
            COALESCE(q.request_count, 0)::int AS request_count,
            COALESCE(r.promoter_count, 0)::int AS promoter_count,
            COALESCE(r.passive_count, 0)::int AS passive_count,
            COALESCE(r.detractor_count, 0)::int AS detractor_count,
            CASE WHEN COALESCE(r.response_count, 0) >= $3::int
              THEN ROUND(((COALESCE(r.promoter_count, 0) * 100.0 / NULLIF(r.response_count, 0))
                   - (COALESCE(r.detractor_count, 0) * 100.0 / NULLIF(r.response_count, 0))), 1)::float8
              ELSE NULL END AS nps_score,
            CASE WHEN COALESCE(q.request_count, 0) > 0
              THEN ROUND((COALESCE(r.response_count, 0) * 100.0 / q.request_count), 1)::float8
              ELSE NULL END AS response_rate,
            $3::int AS minimum_sample_size,
            (COALESCE(r.response_count, 0) >= $3::int) AS sample_visible
       FROM responses r
       FULL OUTER JOIN requests q ON q.day = r.day
      ORDER BY COALESCE(r.day, q.day) ASC`,
    tid,
    lookbackDays,
    minSample,
  );

  const breakdownRows = await prismaReadOnly.$queryRawUnsafe(
    `WITH base AS (
       SELECT 'department'::text AS dimension_type,
              COALESCE(department_id::text, 'unknown') AS dimension_key,
              COALESCE(department_display_name, 'Unknown department') AS dimension_label,
              nps_bucket
         FROM feedback_nps_responses
        WHERE tenant_id = $1::uuid
          AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
       UNION ALL
       SELECT 'doctor'::text,
              COALESCE(doctor_id::text, 'unknown'),
              COALESCE(doctor_display_name, 'Unknown doctor'),
              nps_bucket
         FROM feedback_nps_responses
        WHERE tenant_id = $1::uuid
          AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
       UNION ALL
       SELECT 'encounter_type'::text, encounter_type, encounter_type, nps_bucket
         FROM feedback_nps_responses
        WHERE tenant_id = $1::uuid
          AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
       UNION ALL
       SELECT 'channel'::text, channel, channel, nps_bucket
         FROM feedback_nps_responses
        WHERE tenant_id = $1::uuid
          AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
     )
     SELECT dimension_type, dimension_key, dimension_label,
            COUNT(*)::int AS response_count,
            0::int AS request_count,
            COUNT(*) FILTER (WHERE nps_bucket = 'promoter')::int AS promoter_count,
            COUNT(*) FILTER (WHERE nps_bucket = 'passive')::int AS passive_count,
            COUNT(*) FILTER (WHERE nps_bucket = 'detractor')::int AS detractor_count,
            CASE WHEN COUNT(*) >= $3::int
              THEN ROUND(((COUNT(*) FILTER (WHERE nps_bucket = 'promoter') * 100.0 / NULLIF(COUNT(*), 0))
                   - (COUNT(*) FILTER (WHERE nps_bucket = 'detractor') * 100.0 / NULLIF(COUNT(*), 0))), 1)::float8
              ELSE NULL END AS nps_score,
            NULL::float8 AS response_rate,
            $3::int AS minimum_sample_size,
            (COUNT(*) >= $3::int) AS sample_visible
       FROM base
      GROUP BY dimension_type, dimension_key, dimension_label
      ORDER BY dimension_type, response_count DESC, dimension_label
      LIMIT 80`,
    tid,
    lookbackDays,
    minSample,
  );

  const recoveryRows = await prismaReadOnly.$queryRawUnsafe(
    `SELECT t.id::int AS task_id, t.status, t.priority, t.assigned_to_role,
            t.due_at, t.created_at,
            r.id::text AS nps_response_id, r.patient_uid, r.score, r.nps_bucket,
            r.channel, r.encounter_type, r.department_display_name,
            r.doctor_display_name, r.comment_redaction_status, r.submitted_at
       FROM tasks t
       JOIN feedback_nps_responses r
         ON r.tenant_id = t.tenant_id
        AND r.id::text = t.related_resource_id
      WHERE t.tenant_id = $1::uuid
        AND t.related_resource_type = 'feedback_nps_response'
        AND t.status IN ('open', 'in_progress', 'blocked', 'overdue')
      ORDER BY
        CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        t.created_at DESC
      LIMIT 25`,
    tid,
  );

  return {
    window_days: lookbackDays,
    overall: shapeMetricRow(overallRows[0] || {}),
    trend: trendRows.map((row) => ({ day: row.day, ...shapeMetricRow(row) })),
    breakdowns: breakdownRows.map((row) => ({
      dimension_type: row.dimension_type,
      dimension_key: row.dimension_key,
      dimension_label: row.dimension_label,
      ...shapeMetricRow(row),
    })),
    urgent_queue: recoveryRows.map((row) => ({
      task_id: row.task_id,
      status: row.status,
      priority: row.priority,
      assigned_to_role: row.assigned_to_role,
      due_at: row.due_at,
      created_at: row.created_at,
      nps_response_id: row.nps_response_id,
      patient_uid: row.patient_uid,
      score: maybeNumber(row.score),
      nps_bucket: row.nps_bucket,
      channel: row.channel,
      encounter_type: row.encounter_type,
      department_display_name: row.department_display_name,
      doctor_display_name: row.doctor_display_name,
      comment_redaction_status: row.comment_redaction_status,
      submitted_at: row.submitted_at,
    })),
  };
}

export async function listServiceRecoveryTasks({
  tenantId = null,
  status = null,
  limit = 50,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = normalizeInt(limit, 'limit', { min: 1, max: 200, fallback: 50 });
  const params = [tid];
  let statusClause = '';
  if (status) {
    params.push(normalizeText(status, { max: 30 }));
    statusClause = `AND t.status = $${params.length}`;
  }
  params.push(safeLimit);
  const rows = await prismaReadOnly.$queryRawUnsafe(
    `SELECT t.id::int AS task_id, t.status, t.priority, t.title, t.assigned_to_role,
            t.due_at, t.metadata, t.created_at,
            r.id::text AS nps_response_id, r.patient_uid, r.score, r.nps_bucket,
            r.channel, r.encounter_type, r.comment_redaction_status, r.submitted_at
       FROM tasks t
       JOIN feedback_nps_responses r
         ON r.tenant_id = t.tenant_id
        AND r.id::text = t.related_resource_id
      WHERE t.tenant_id = $1::uuid
        AND t.related_resource_type = 'feedback_nps_response'
        ${statusClause}
      ORDER BY
        CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        t.created_at DESC
      LIMIT $${params.length}`,
    ...params,
  );
  return { tasks: rows.map((row) => ({
    ...row,
    score: maybeNumber(row.score),
  })), count: rows.length };
}

export async function refreshNpsRollups({
  tenantId = null,
  days = DEFAULT_LOOKBACK_DAYS,
  minimumSampleSize = DEFAULT_MINIMUM_SAMPLE_SIZE,
  grain = 'daily',
} = {}) {
  const tid = requireTenantId(tenantId);
  const lookbackDays = normalizeInt(days, 'days', { min: 1, max: 365, fallback: DEFAULT_LOOKBACK_DAYS });
  const minSample = normalizeInt(minimumSampleSize, 'minimum_sample_size', { min: 1, max: 1000, fallback: DEFAULT_MINIMUM_SAMPLE_SIZE });
  const safeGrain = grain === 'weekly' ? 'weekly' : 'daily';
  const truncGrain = safeGrain === 'weekly' ? 'week' : 'day';
  const periodEndExpr = safeGrain === 'weekly'
    ? `(date_trunc('${truncGrain}', submitted_at)::date + 6)`
    : `date_trunc('${truncGrain}', submitted_at)::date`;

  const rows = await prisma.$queryRawUnsafe(
    `WITH source AS (
       SELECT tenant_id,
              date_trunc('${truncGrain}', submitted_at)::date AS period_start,
              ${periodEndExpr} AS period_end,
              dimension_type,
              dimension_key,
              dimension_label,
              nps_bucket
         FROM (
           SELECT tenant_id, submitted_at, 'tenant'::text AS dimension_type,
                  'all'::text AS dimension_key, 'All responses'::text AS dimension_label, nps_bucket
             FROM feedback_nps_responses
            WHERE tenant_id = $1::uuid AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
           UNION ALL
           SELECT tenant_id, submitted_at, 'department'::text,
                  COALESCE(department_id::text, 'unknown'),
                  COALESCE(department_display_name, 'Unknown department'), nps_bucket
             FROM feedback_nps_responses
            WHERE tenant_id = $1::uuid AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
           UNION ALL
           SELECT tenant_id, submitted_at, 'doctor'::text,
                  COALESCE(doctor_id::text, 'unknown'),
                  COALESCE(doctor_display_name, 'Unknown doctor'), nps_bucket
             FROM feedback_nps_responses
            WHERE tenant_id = $1::uuid AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
           UNION ALL
           SELECT tenant_id, submitted_at, 'encounter_type'::text, encounter_type, encounter_type, nps_bucket
             FROM feedback_nps_responses
            WHERE tenant_id = $1::uuid AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
           UNION ALL
           SELECT tenant_id, submitted_at, 'channel'::text, channel, channel, nps_bucket
             FROM feedback_nps_responses
            WHERE tenant_id = $1::uuid AND submitted_at >= NOW() - $2::int * INTERVAL '1 day'
         ) dims
     ), agg AS (
       SELECT tenant_id, period_start, period_end, dimension_type, dimension_key, dimension_label,
              COUNT(*)::int AS response_count,
              COUNT(*) FILTER (WHERE nps_bucket = 'promoter')::int AS promoter_count,
              COUNT(*) FILTER (WHERE nps_bucket = 'passive')::int AS passive_count,
              COUNT(*) FILTER (WHERE nps_bucket = 'detractor')::int AS detractor_count
         FROM source
        GROUP BY tenant_id, period_start, period_end, dimension_type, dimension_key, dimension_label
     )
     INSERT INTO feedback_nps_rollups
       (tenant_id, grain, period_start, period_end, dimension_type, dimension_key,
        dimension_label, response_count, request_count, promoter_count, passive_count,
        detractor_count, nps_score, response_rate, minimum_sample_size, sample_visible,
        source_range, computed_at, updated_at)
     SELECT tenant_id, $3, period_start, period_end, dimension_type, dimension_key,
            dimension_label, response_count, 0, promoter_count, passive_count,
            detractor_count,
            CASE WHEN response_count >= $4::int
              THEN ROUND(((promoter_count * 100.0 / NULLIF(response_count, 0))
                   - (detractor_count * 100.0 / NULLIF(response_count, 0))), 2)
              ELSE NULL END,
            NULL::numeric,
            $4::int,
            response_count >= $4::int,
            jsonb_build_object('days', $2::int, 'refreshed_by', 'nl9_p2_nps'::text),
            NOW(),
            NOW()
       FROM agg
     ON CONFLICT (tenant_id, grain, period_start, dimension_type, dimension_key)
     DO UPDATE SET period_end = EXCLUDED.period_end,
                   dimension_label = EXCLUDED.dimension_label,
                   response_count = EXCLUDED.response_count,
                   request_count = EXCLUDED.request_count,
                   promoter_count = EXCLUDED.promoter_count,
                   passive_count = EXCLUDED.passive_count,
                   detractor_count = EXCLUDED.detractor_count,
                   nps_score = EXCLUDED.nps_score,
                   response_rate = EXCLUDED.response_rate,
                   minimum_sample_size = EXCLUDED.minimum_sample_size,
                   sample_visible = EXCLUDED.sample_visible,
                   source_range = EXCLUDED.source_range,
                   computed_at = NOW(),
                   updated_at = NOW()
     RETURNING id::text`,
    tid,
    lookbackDays,
    safeGrain,
    minSample,
  );
  return { refreshed: rows.length, grain: safeGrain, window_days: lookbackDays };
}

export const __testing__ = {
  npsBucket,
  shapeMetricRow,
  dedupeHash,
};

export default {
  submitNpsResponse,
  getNpsDashboard,
  listServiceRecoveryTasks,
  refreshNpsRollups,
};
