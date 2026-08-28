import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { isDoctor } from '../../utils/roleHelpers.js';
import {
  recordCanonicalClinicalEvent,
  startWorkflowSla,
} from './canonicalClinicalPlatformService.js';

export const MAR_MEDICATION_EXCEPTION_DISPOSITIONS = Object.freeze([
  'reviewed_no_replacement',
  'replacement_ordered',
  'order_stopped',
]);

const PRESCRIBER_ROLES = Object.freeze([
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
]);
const MAR_EXCEPTION_ESCALATION_ROLES = Object.freeze([
  'MEDICAL_SUPERINTENDENT',
  'ADMIN',
  'SUPER_ADMIN',
]);
const ACTIVE_ORDER_STATUSES = new Set(['ordered', 'verified', 'in_progress']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_BIGINT_RE = /^[1-9][0-9]{0,18}$/;
const POSTGRES_BIGINT_MAX = 9223372036854775807n;

function requiredTx(tx) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'MAR medication exceptions require the caller transaction',
      'MAR_EXCEPTION_TRANSACTION_REQUIRED',
    );
  }
  return tx;
}

function requiredCommand(value, field, code) {
  const text = String(value || '').trim();
  if (!text) throw AppError.badRequest(`${field} is required`, code);
  return text;
}

function requiredFingerprint(value) {
  const fingerprint = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw AppError.badRequest(
      'MAR medication exception request fingerprint is required',
      'MAR_EXCEPTION_REQUEST_FINGERPRINT_REQUIRED',
    );
  }
  return fingerprint;
}

function canonicalPositiveSignedBigInt(value) {
  const identifier = String(value ?? '').trim();
  if (
    !POSITIVE_BIGINT_RE.test(identifier)
    || BigInt(identifier) > POSTGRES_BIGINT_MAX
  ) {
    return null;
  }
  return identifier;
}

export function requiredMarMedicationExceptionCaseId(value) {
  const caseId = canonicalPositiveSignedBigInt(value);
  if (!caseId) {
    throw AppError.badRequest(
      'MAR medication exception case id is invalid',
      'MAR_EXCEPTION_CASE_ID_INVALID',
    );
  }
  return caseId;
}

export function requiredMarMedicationExceptionEventId(value) {
  const eventId = canonicalPositiveSignedBigInt(value);
  if (!eventId) {
    throw AppError.internal(
      'MAR medication exception event identity is invalid',
      'MAR_EXCEPTION_EVENT_ID_INVALID',
    );
  }
  return eventId;
}

function occurrenceKey(tenantId, caseId) {
  const digest = createHash('sha256')
    .update(`${tenantId}:mar-medication-exception:${caseId}`, 'utf8')
    .digest('hex');
  return `mar-medication-exception:${digest}`;
}

function deepLink(caseId) {
  return `/mar/due?exception_id=${requiredMarMedicationExceptionCaseId(caseId)}`;
}

async function loadContext(tx, { tenantId, medicationAdministrationId, actorUid }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT administration.id,
            administration.patient_uid::text,
            administration.clinical_order_id,
            administration.status,
            administration.medication_name,
            administration.scheduled_time,
            clinical_order.encounter_id::text,
            clinical_order.ordered_by::text,
            clinical_order.status AS clinical_order_status,
            actor.role AS actor_role
       FROM medication_administrations administration
       JOIN users actor
         ON actor.tenant_id = administration.tenant_id
        AND actor.uid = $3::uuid
        AND actor.is_active = TRUE
        AND COALESCE(actor.is_deleted, FALSE) = FALSE
        AND actor.deleted_at IS NULL
        AND LOWER(COALESCE(actor.status, 'active')) = 'active'
       LEFT JOIN clinical_orders clinical_order
         ON clinical_order.tenant_id = administration.tenant_id
        AND clinical_order.id = administration.clinical_order_id
        AND clinical_order.order_type = 'medication'
      WHERE administration.tenant_id = $1::uuid
        AND administration.id = $2::integer
      LIMIT 1`,
    tenantId,
    Number(medicationAdministrationId),
    actorUid,
  );
  if (!rows[0]) {
    throw AppError.forbidden(
      'Active staff identity is required for a MAR medication exception',
      'MAR_EXCEPTION_ACTIVE_ACTOR_REQUIRED',
    );
  }
  return rows[0];
}

async function resolveAssignedPrescriber(tx, { tenantId, orderedBy }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT staff_member.id,
            staff_member.uid::text,
            staff_member.phone,
            staff_member.role
       FROM users staff_member
      WHERE staff_member.tenant_id = $1::uuid
        AND staff_member.role = ANY($2::text[])
        AND staff_member.is_active = TRUE
        AND COALESCE(staff_member.is_deleted, FALSE) = FALSE
        AND staff_member.deleted_at IS NULL
        AND LOWER(COALESCE(staff_member.status, 'active')) = 'active'
      ORDER BY
        CASE WHEN staff_member.uid = $3::uuid THEN 0 ELSE 1 END,
        staff_member.last_sign_in_at DESC NULLS LAST,
        staff_member.id ASC
      LIMIT 1`,
    tenantId,
    [...PRESCRIBER_ROLES],
    orderedBy || null,
  );
  return rows[0] || null;
}

async function queueAssignedNotification(tx, {
  tenantId,
  exceptionCase,
  raisedEvent,
  recipient,
}) {
  const notification = await notificationOutbox.queue({
    tenantId,
    type: 'mar_medication_exception',
    channel: 'inapp',
    recipientId: recipient.id,
    recipientPhone: recipient.phone || null,
    title: 'Medication dose requires prescriber review',
    body: 'A held or missed inpatient medication dose requires a governed clinical disposition.',
    sourceEventKey: `mar-exception:${exceptionCase.id}:raised:${raisedEvent.id}`,
    templateVersion: 'mar-medication-exception.v1',
    data: {
      kind: 'mar_medication_exception',
      task_id: Number(exceptionCase.task_id),
      exception_case_id: requiredMarMedicationExceptionCaseId(exceptionCase.id),
      medication_administration_id: Number(exceptionCase.medication_administration_id),
      deep_link: deepLink(exceptionCase.id),
      action_label_key: 'orders.mar_recovery.action',
    },
  }, { tx, strict: true });
  if (!notification?.id) {
    throw AppError.internal(
      'MAR medication exception notification intent was not persisted',
      'MAR_EXCEPTION_NOTIFICATION_INTENT_MISSING',
    );
  }
  return notification;
}

export async function openMarMedicationExceptionTx(tx, {
  tenantId,
  medicationAdministrationId,
  exceptionKind,
  reason,
  raisedBy,
  commandKey,
  requestFingerprint,
  raisedAt = null,
  createTaskTx,
}) {
  requiredTx(tx);
  if (typeof createTaskTx !== 'function') {
    throw AppError.internal(
      'MAR medication exception task factory is unavailable',
      'MAR_EXCEPTION_TASK_FACTORY_REQUIRED',
    );
  }
  const kind = String(exceptionKind || '').trim().toLowerCase();
  if (!['held', 'missed'].includes(kind)) {
    throw AppError.internal('Unsupported MAR medication exception kind', 'MAR_EXCEPTION_KIND_INVALID');
  }
  const cleanReason = requiredCommand(
    reason,
    'MAR medication exception reason',
    'MAR_EXCEPTION_REASON_REQUIRED',
  );
  const cleanCommandKey = requiredCommand(
    commandKey,
    'MAR medication exception command key',
    'MAR_EXCEPTION_IDEMPOTENCY_REQUIRED',
  );
  const fingerprint = requiredFingerprint(requestFingerprint);
  const raisedInstant = raisedAt == null ? new Date() : new Date(raisedAt);
  if (Number.isNaN(raisedInstant.getTime())) {
    throw AppError.internal(
      'MAR medication exception occurrence time is invalid',
      'MAR_EXCEPTION_OCCURRENCE_TIME_INVALID',
    );
  }
  const context = await loadContext(tx, {
    tenantId,
    medicationAdministrationId,
    actorUid: raisedBy,
  });
  if (String(context.status || '').toLowerCase() !== kind) {
    throw AppError.conflict(
      'MAR medication exception state does not match the committed dose state',
      'MAR_EXCEPTION_STATE_MISMATCH',
    );
  }
  if (context.clinical_order_id == null) {
    throw AppError.conflict(
      'MAR medication exception is missing its governed medication-order context',
      'MAR_EXCEPTION_ORDER_CONTEXT_REQUIRED',
      { medication_administration_id: Number(medicationAdministrationId) },
    );
  }

  const existing = await tx.$queryRawUnsafe(
    `SELECT *
       FROM mar_medication_exception_cases
      WHERE tenant_id = $1::uuid
        AND medication_administration_id = $2::integer
        AND status = 'open'
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    Number(medicationAdministrationId),
  );
  if (existing[0]) return existing[0];

  const idRows = await tx.$queryRawUnsafe(
    `SELECT nextval(
              pg_get_serial_sequence('mar_medication_exception_cases', 'id')
            )::bigint AS id`,
  );
  const caseId = String(idRows[0]?.id || '');
  if (!/^[1-9]\d*$/.test(caseId)) {
    throw AppError.internal('MAR medication exception identity was not allocated');
  }
  const assignedPrescriber = await resolveAssignedPrescriber(tx, {
    tenantId,
    orderedBy: context.ordered_by || null,
  });
  const sla = await startWorkflowSla({
    tenantId,
    ruleCode: 'mar_medication_exception_review',
    patientUid: context.patient_uid,
    encounterId: context.encounter_id || null,
    sourceTable: 'mar_medication_exception_cases',
    sourceId: caseId,
    priority: 'critical',
    assignedRoleCodes: [...PRESCRIBER_ROLES],
    assignedUserUid: assignedPrescriber?.uid || null,
    metadata: {
      med_03: true,
      exception_case_id: caseId,
      medication_administration_id: Number(medicationAdministrationId),
      exception_kind: kind,
    },
  }, { db: tx, strict: true });
  if (!sla?.id) {
    throw AppError.internal(
      'MAR medication exception SLA could not be materialized',
      'MAR_EXCEPTION_SLA_MISSING',
    );
  }
  const task = await createTaskTx({
    tenantId,
    title: kind === 'held'
      ? 'Review held medication dose'
      : 'Review missed medication dose',
    description: 'Record an explicit prescriber disposition. This task cannot change a medication order.',
    patientUid: context.patient_uid,
    encounterId: context.encounter_id || null,
    relatedResourceId: caseId,
    assignedToUid: assignedPrescriber?.uid || null,
    assignedToRole: assignedPrescriber ? null : 'DOCTOR',
    createdBy: raisedBy,
    workflowSlaInstanceId: sla.id,
    stageOccurrenceKey: occurrenceKey(tenantId, caseId),
    metadata: {
      med_03: true,
      exception_case_id: caseId,
      medication_administration_id: Number(medicationAdministrationId),
      clinical_order_id: context.clinical_order_id == null
        ? null
        : Number(context.clinical_order_id),
      exception_kind: kind,
      evidence_kind: 'mar_medication_exception_resolution',
      deep_link: deepLink(caseId),
    },
    tx,
  });
  if (!task?.id) {
    throw AppError.internal(
      'MAR medication exception task could not be materialized',
      'MAR_EXCEPTION_TASK_MISSING',
    );
  }

  const cases = await tx.$queryRawUnsafe(
    `INSERT INTO mar_medication_exception_cases
       (id, tenant_id, medication_administration_id, clinical_order_id,
        patient_uid, exception_kind, reason, raised_by, raised_at,
        assigned_prescriber_uid, task_id, workflow_sla_instance_id)
     VALUES ($1::bigint, $2::uuid, $3::integer, $4::integer,
             $5::uuid, $6::text, $7::text, $8::uuid, $9::timestamptz,
             $10::uuid, $11::integer, $12::uuid)
     RETURNING *`,
    caseId,
    tenantId,
    Number(medicationAdministrationId),
    context.clinical_order_id == null ? null : Number(context.clinical_order_id),
    context.patient_uid,
    kind,
    cleanReason,
    raisedBy,
    raisedInstant,
    assignedPrescriber?.uid || null,
    Number(task.id),
    sla.id,
  );
  const exceptionCase = cases[0];
  const events = await tx.$queryRawUnsafe(
    `INSERT INTO mar_medication_exception_events
       (tenant_id, exception_case_id, medication_administration_id,
        event_type, actor_uid, actor_role, reason,
        command_key, request_fingerprint, occurred_at, payload)
     VALUES ($1::uuid, $2::bigint, $3::integer,
             'raised', $4::uuid, $5::text, $6::text,
             $7::text, $8::char(64), $9::timestamptz, $10::jsonb)
     RETURNING id, occurred_at`,
    tenantId,
    caseId,
    Number(medicationAdministrationId),
    raisedBy,
    context.actor_role,
    cleanReason,
    cleanCommandKey,
    fingerprint,
    raisedInstant,
    JSON.stringify({
      clinical_order_id: context.clinical_order_id == null
        ? null
        : Number(context.clinical_order_id),
      clinical_order_status: context.clinical_order_status || null,
    }),
  );
  const raisedEvent = events[0];

  if (assignedPrescriber) {
    await queueAssignedNotification(tx, {
      tenantId,
      exceptionCase,
      raisedEvent,
      recipient: assignedPrescriber,
    });
    await tx.$executeRawUnsafe(
      `UPDATE mar_medication_exception_cases
          SET notification_coverage_status = 'notified',
              notified_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      caseId,
    );
  } else {
    await tx.$executeRawUnsafe(
      `UPDATE mar_medication_exception_cases
          SET notification_coverage_status = 'coverage_gap'
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      caseId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO mar_medication_exception_events
         (tenant_id, exception_case_id, medication_administration_id,
          event_type, actor_uid, actor_role, reason, payload)
       VALUES ($1::uuid, $2::bigint, $3::integer,
               'notification_coverage_gap', $4::uuid, $5::text,
               'No active prescriber recipient was available', $6::jsonb)`,
      tenantId,
      caseId,
      Number(medicationAdministrationId),
      raisedBy,
      context.actor_role,
      JSON.stringify({ intended_roles: PRESCRIBER_ROLES }),
    );
  }

  return {
    ...exceptionCase,
    notification_coverage_status: assignedPrescriber ? 'notified' : 'coverage_gap',
    notified_at: assignedPrescriber ? new Date() : null,
  };
}

function reconciliationIdentity(candidate) {
  const occurrenceAt = new Date(
    candidate.exception_kind === 'held'
      ? candidate.held_at
      : candidate.missed_at,
  ).toISOString();
  const commandKey = [
    'mar-exception-reconcile.v1',
    candidate.tenant_id,
    candidate.id,
    candidate.exception_kind,
    occurrenceAt,
  ].join(':');
  const requestFingerprint = createHash('sha256')
    .update(JSON.stringify({
      medication_administration_id: Number(candidate.id),
      exception_kind: candidate.exception_kind,
      actor_uid: candidate.actor_uid,
      occurrence_at: occurrenceAt,
      reason: candidate.exception_reason,
    }), 'utf8')
    .digest('hex');
  return { commandKey, requestFingerprint, occurrenceAt };
}

export async function escalateMarMedicationExceptionCases({
  tenantId,
  limit = 25,
  db = prisma,
  transaction = setTenantTx,
  outbox = notificationOutbox,
} = {}) {
  const tid = String(tenantId || '').trim();
  if (!tid) {
    throw AppError.internal(
      'MAR medication exception escalation requires tenant context',
      'MAR_EXCEPTION_TENANT_REQUIRED',
    );
  }
  const boundedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const candidates = await db.$queryRawUnsafe(
    `SELECT exception_case.id
       FROM mar_medication_exception_cases exception_case
       JOIN workflow_sla_instances sla
         ON sla.tenant_id = exception_case.tenant_id
        AND sla.id = exception_case.workflow_sla_instance_id
      WHERE exception_case.tenant_id = $1::uuid
        AND exception_case.status = 'open'
        AND sla.rule_code = 'mar_medication_exception_review'
        AND sla.completed_at IS NULL
        AND sla.due_at <= NOW()
        AND sla.escalated_at IS NULL
      ORDER BY sla.due_at ASC, exception_case.id ASC
      LIMIT $2::integer`,
    tid,
    boundedLimit,
  );
  const summary = {
    scanned: candidates.length,
    escalated: 0,
    awaiting_recipients: 0,
    skipped_changed: 0,
    failures: [],
  };

  for (const candidate of candidates) {
    try {
      const outcome = await transaction(tid, async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `SELECT exception_case.id,
                  exception_case.patient_uid::text,
                  exception_case.medication_administration_id,
                  exception_case.task_id,
                  exception_case.workflow_sla_instance_id
             FROM mar_medication_exception_cases exception_case
             JOIN tasks task
               ON task.tenant_id = exception_case.tenant_id
              AND task.id = exception_case.task_id
             JOIN workflow_sla_instances sla
               ON sla.tenant_id = exception_case.tenant_id
              AND sla.id = exception_case.workflow_sla_instance_id
            WHERE exception_case.tenant_id = $1::uuid
              AND exception_case.id = $2::bigint
              AND exception_case.status = 'open'
              AND task.metadata->>'task_contract' = 'mar_medication_exception_v1'
              AND task.status IN ('open', 'in_progress', 'overdue')
              AND sla.rule_code = 'mar_medication_exception_review'
              AND sla.completed_at IS NULL
              AND sla.due_at <= NOW()
              AND sla.escalated_at IS NULL
            FOR UPDATE OF exception_case, task, sla`,
          tid,
          requiredMarMedicationExceptionCaseId(candidate.id),
        );
        const exceptionCase = rows[0];
        if (!exceptionCase) return 'skipped';

        const recipients = await tx.$queryRawUnsafe(
          `SELECT id, phone, role
             FROM users
            WHERE tenant_id = $1::uuid
              AND role = ANY($2::text[])
              AND is_active = TRUE
              AND COALESCE(is_deleted, FALSE) = FALSE
              AND deleted_at IS NULL
              AND LOWER(COALESCE(status, 'active')) = 'active'
            ORDER BY last_sign_in_at DESC NULLS LAST, id ASC
            LIMIT 25`,
          tid,
          [...MAR_EXCEPTION_ESCALATION_ROLES],
        );
        if (recipients.length === 0) {
          const attemptedAt = new Date().toISOString();
          await tx.$executeRawUnsafe(
            `UPDATE workflow_sla_instances
                SET status = CASE WHEN status = 'active' THEN 'breached' ELSE status END,
                    breached_at = COALESCE(breached_at, due_at),
                    metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object(
                           'mar_exception_escalation_recipient_count', 0,
                           'mar_exception_escalation_error_code',
                             'no_active_escalation_recipients',
                           'mar_exception_escalation_attempted_at', $3::timestamptz
                         ),
                    updated_at = NOW()
              WHERE tenant_id = $1::uuid
                AND id = $2::uuid
                AND completed_at IS NULL`,
            tid,
            exceptionCase.workflow_sla_instance_id,
            attemptedAt,
          );
          await tx.$executeRawUnsafe(
            `UPDATE tasks
                SET status = CASE WHEN status = 'open' THEN 'overdue' ELSE status END,
                    sla_breached_at = COALESCE(sla_breached_at, due_at),
                    metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object(
                           'mar_exception_escalation_recipient_count', 0,
                           'mar_exception_escalation_error_code',
                             'no_active_escalation_recipients',
                           'mar_exception_escalation_attempted_at', $3::timestamptz
                         ),
                    updated_at = NOW()
              WHERE tenant_id = $1::uuid
                AND id = $2::integer
                AND status IN ('open', 'in_progress', 'overdue')`,
            tid,
            Number(exceptionCase.task_id),
            attemptedAt,
          );
          return 'awaiting_recipients';
        }

        const outboxIds = [];
        for (const recipient of recipients) {
          const queued = await outbox.queue({
            tenantId: tid,
            type: 'mar_medication_exception_escalation',
            channel: 'inapp',
            recipientId: recipient.id,
            recipientPhone: recipient.phone || null,
            title: 'Medication exception review is overdue',
            body: 'A held or missed medication dose still requires a governed prescriber disposition.',
            sourceEventKey:
              `mar-exception:${exceptionCase.id}:overdue:${recipient.id}`,
            templateVersion: 'mar-medication-exception-escalation.v1',
            data: {
              kind: 'mar_medication_exception_escalation',
              exception_case_id: requiredMarMedicationExceptionCaseId(exceptionCase.id),
              task_id: Number(exceptionCase.task_id),
              medication_administration_id:
                Number(exceptionCase.medication_administration_id),
              patient_uid: exceptionCase.patient_uid,
              deep_link: deepLink(exceptionCase.id),
              recipient_role: recipient.role,
              action_label_key: 'orders.mar_recovery.action',
            },
          }, { tx, strict: true });
          if (!queued?.id) {
            throw AppError.internal(
              'MAR medication exception escalation outbox evidence is missing',
              'MAR_EXCEPTION_ESCALATION_OUTBOX_MISSING',
            );
          }
          outboxIds.push(String(queued.id));
        }

        const escalatedAt = new Date().toISOString();
        const outboxIdsJson = JSON.stringify(outboxIds);
        await tx.$executeRawUnsafe(
          `UPDATE workflow_sla_instances
              SET status = 'escalated',
                  breached_at = COALESCE(breached_at, due_at),
                  escalated_at = $3::timestamptz,
                  metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'mar_exception_escalation_version',
                           'mar_medication_exception_escalation_v1',
                         'mar_exception_escalation_recipient_count', $4::integer,
                         'mar_exception_escalation_outbox_ids', $5::jsonb,
                         'mar_exception_escalated_at', $3::timestamptz
                       ),
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::uuid
              AND completed_at IS NULL
              AND escalated_at IS NULL`,
          tid,
          exceptionCase.workflow_sla_instance_id,
          escalatedAt,
          outboxIds.length,
          outboxIdsJson,
        );
        await tx.$executeRawUnsafe(
          `UPDATE tasks
              SET status = CASE WHEN status = 'open' THEN 'overdue' ELSE status END,
                  sla_breached_at = COALESCE(sla_breached_at, due_at),
                  metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'mar_exception_escalation_version',
                           'mar_medication_exception_escalation_v1',
                         'mar_exception_escalation_recipient_count', $4::integer,
                         'mar_exception_escalation_outbox_ids', $5::jsonb,
                         'mar_exception_escalated_at', $3::timestamptz
                       ),
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::integer
              AND status IN ('open', 'in_progress', 'overdue')`,
          tid,
          Number(exceptionCase.task_id),
          escalatedAt,
          outboxIds.length,
          outboxIdsJson,
        );
        return 'escalated';
      });
      if (outcome === 'escalated') summary.escalated += 1;
      if (outcome === 'awaiting_recipients') summary.awaiting_recipients += 1;
      if (outcome === 'skipped') summary.skipped_changed += 1;
    } catch (error) {
      summary.failures.push({
        exception_case_id: requiredMarMedicationExceptionCaseId(candidate.id),
        code: error?.code || 'MAR_EXCEPTION_ESCALATION_FAILED',
        message: error?.message || String(error),
      });
    }
  }
  return summary;
}

export async function reconcileMarMedicationExceptions({
  tenantId,
  limit = 25,
  createTaskTx,
  db = prisma,
} = {}) {
  if (typeof createTaskTx !== 'function') {
    throw AppError.internal(
      'MAR medication exception reconciliation requires the typed task factory',
      'MAR_EXCEPTION_TASK_FACTORY_REQUIRED',
    );
  }
  const tid = String(tenantId || '').trim();
  if (!tid) {
    throw AppError.internal(
      'MAR medication exception reconciliation requires tenant context',
      'MAR_EXCEPTION_TENANT_REQUIRED',
    );
  }
  const boundedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  let escalation;
  try {
    escalation = await escalateMarMedicationExceptionCases({
      tenantId: tid,
      limit: boundedLimit,
      db,
    });
  } catch (error) {
    escalation = {
      scanned: 0,
      escalated: 0,
      awaiting_recipients: 0,
      skipped_changed: 0,
      failures: [{
        code: error?.code || 'MAR_EXCEPTION_ESCALATION_FAILED',
        message: error?.message || String(error),
      }],
    };
  }
  const readinessRows = await db.$queryRawUnsafe(
    `WITH blocked AS (
       SELECT administration.id,
              LOWER(administration.status) AS exception_kind,
              administration.clinical_order_id,
              CASE
                WHEN LOWER(administration.status) = 'held'
                  THEN administration.held_by IS NULL OR administration.held_at IS NULL
                ELSE administration.missed_by IS NULL OR administration.missed_at IS NULL
              END AS missing_attribution
         FROM medication_administrations administration
        WHERE administration.tenant_id = $1::uuid
          AND LOWER(administration.status) IN ('held', 'missed')
          AND NOT EXISTS (
            SELECT 1
              FROM mar_medication_exception_cases exception_case
             WHERE exception_case.tenant_id = administration.tenant_id
               AND exception_case.medication_administration_id = administration.id
          )
          AND (
            administration.clinical_order_id IS NULL
            OR CASE
                 WHEN LOWER(administration.status) = 'held'
                   THEN administration.held_by IS NULL OR administration.held_at IS NULL
                 ELSE administration.missed_by IS NULL OR administration.missed_at IS NULL
               END
          )
     ), totals AS (
       SELECT COUNT(*)::integer AS blocked_count,
              COUNT(*) FILTER (WHERE missing_attribution)::integer
                AS missing_attribution_count,
              COUNT(*) FILTER (WHERE clinical_order_id IS NULL)::integer
                AS missing_order_count
         FROM blocked
     ), sample AS (
       SELECT *
         FROM blocked
        ORDER BY id
        LIMIT 25
     )
     SELECT totals.blocked_count,
            totals.missing_attribution_count,
            totals.missing_order_count,
            COALESCE(
              (
                SELECT jsonb_agg(
                         jsonb_build_object(
                           'medication_administration_id', id,
                           'exception_kind', exception_kind,
                           'missing_attribution', missing_attribution,
                           'missing_clinical_order', clinical_order_id IS NULL
                         ) ORDER BY id
                       )
                  FROM sample
              ),
              '[]'::jsonb
            ) AS blocked_rows,
            totals.blocked_count > 25 AS sample_truncated
       FROM totals`,
    tid,
  );
  const readiness = readinessRows[0] || {};
  if (Number(readiness.blocked_count) > 0) {
    throw AppError.serviceUnavailable(
      'MAR medication exception reconciliation is blocked by unattributed or unlinked legacy state',
      'MAR_EXCEPTION_RECONCILIATION_READINESS_FAILED',
      {
        blocked_count: Number(readiness.blocked_count),
        missing_attribution_count: Number(readiness.missing_attribution_count),
        missing_clinical_order_count: Number(readiness.missing_order_count),
        blocked_rows: readiness.blocked_rows || [],
        sample_truncated: readiness.sample_truncated === true,
        remediation:
          'Restore exact staff attribution and same-patient medication clinical-order linkage before retrying.',
      },
    );
  }
  const candidates = await db.$queryRawUnsafe(
    `SELECT administration.id,
            administration.tenant_id::text,
            LOWER(administration.status) AS exception_kind,
            administration.held_by::text,
            administration.held_at,
            administration.missed_by::text,
            administration.missed_at,
            administration.clinical_order_id,
            CASE
              WHEN LOWER(administration.status) = 'held'
                THEN NULLIF(BTRIM(administration.hold_reason), '')
              ELSE NULLIF(BTRIM(administration.notes), '')
            END AS recorded_reason
       FROM medication_administrations administration
      WHERE administration.tenant_id = $1::uuid
        AND LOWER(administration.status) IN ('held', 'missed')
        AND CASE
              WHEN LOWER(administration.status) = 'held'
                THEN administration.held_by IS NOT NULL AND administration.held_at IS NOT NULL
              ELSE administration.missed_by IS NOT NULL AND administration.missed_at IS NOT NULL
            END
        AND administration.clinical_order_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM mar_medication_exception_cases exception_case
           WHERE exception_case.tenant_id = administration.tenant_id
             AND exception_case.medication_administration_id = administration.id
        )
      ORDER BY COALESCE(administration.held_at, administration.missed_at) ASC,
               administration.tenant_id,
               administration.id
      LIMIT $2::integer`,
    tid,
    boundedLimit,
  );

  const summary = {
    scanned: candidates.length,
    materialized: 0,
    coverage_gaps: 0,
    skipped_changed: 0,
    failures: [],
    escalation,
  };
  for (const candidate of candidates) {
    try {
      const result = await setTenantTx(candidate.tenant_id, async (tx) => {
        const lockedRows = await tx.$queryRawUnsafe(
          `SELECT administration.id,
                  LOWER(administration.status) AS exception_kind,
                  administration.held_by::text,
                  administration.held_at,
                  administration.missed_by::text,
                  administration.missed_at,
                  administration.clinical_order_id,
                  CASE
                    WHEN LOWER(administration.status) = 'held'
                      THEN COALESCE(NULLIF(BTRIM(administration.hold_reason), ''),
                                    'Held dose requires prescriber review')
                    ELSE COALESCE(NULLIF(BTRIM(administration.notes), ''),
                                  'Missed dose requires prescriber review')
                  END AS exception_reason
             FROM medication_administrations administration
            WHERE administration.tenant_id = $1::uuid
              AND administration.id = $2::integer
              AND LOWER(administration.status) IN ('held', 'missed')
              AND NOT EXISTS (
                SELECT 1
                  FROM mar_medication_exception_cases exception_case
                 WHERE exception_case.tenant_id = administration.tenant_id
                   AND exception_case.medication_administration_id = administration.id
              )
            FOR UPDATE OF administration`,
          candidate.tenant_id,
          Number(candidate.id),
        );
        const locked = lockedRows[0];
        if (!locked) return null;
        const actorUid = locked.exception_kind === 'held'
          ? locked.held_by
          : locked.missed_by;
        const raisedAt = locked.exception_kind === 'held'
          ? locked.held_at
          : locked.missed_at;
        if (!actorUid || !raisedAt || locked.clinical_order_id == null) {
          throw AppError.serviceUnavailable(
            'Locked MAR exception state lost required attribution or medication-order context',
            'MAR_EXCEPTION_RECONCILIATION_READINESS_FAILED',
            { medication_administration_id: Number(candidate.id) },
          );
        }
        const identity = reconciliationIdentity({
          ...candidate,
          ...locked,
          tenant_id: candidate.tenant_id,
          actor_uid: actorUid,
        });
        const exceptionCase = await openMarMedicationExceptionTx(tx, {
          tenantId: candidate.tenant_id,
          medicationAdministrationId: Number(candidate.id),
          exceptionKind: locked.exception_kind,
          reason: locked.exception_reason,
          raisedBy: actorUid,
          commandKey: identity.commandKey,
          requestFingerprint: identity.requestFingerprint,
          raisedAt,
          createTaskTx,
        });
        await recordCanonicalClinicalEvent({
          tenantId: candidate.tenant_id,
          patientUid: exceptionCase.patient_uid,
          eventType: 'mar.exception_reconciled',
          eventStatus: locked.exception_kind,
          sourceTable: 'mar_medication_exception_cases',
          sourceId: String(exceptionCase.id),
          resourceType: 'mar',
          resourceId: String(candidate.id),
          actorUid,
          summary: 'Historical MAR medication exception entered governed review',
          payload: {
            medication_administration_id: Number(candidate.id),
            exception_case_id: requiredMarMedicationExceptionCaseId(exceptionCase.id),
            exception_kind: locked.exception_kind,
            treatment_mutated: false,
          },
          tags: ['mar', 'medication', 'exception_reconciliation'],
          timelineIdempotencyKey: `${identity.commandKey}:timeline`,
          auditIdempotencyKey: `${identity.commandKey}:audit`,
        }, { db: tx });
        return exceptionCase;
      });
      if (!result) {
        summary.skipped_changed += 1;
      } else {
        summary.materialized += 1;
        if (result.notification_coverage_status === 'coverage_gap') {
          summary.coverage_gaps += 1;
        }
      }
    } catch (error) {
      summary.failures.push({
        tenant_id: candidate.tenant_id,
        medication_administration_id: Number(candidate.id),
        code: error?.code || 'MAR_EXCEPTION_RECONCILIATION_FAILED',
        message: error?.message || String(error),
      });
    }
  }
  return summary;
}

export async function claimMarMedicationExceptionTx(tx, {
  tenantId,
  exceptionCaseId,
  actorUid,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  commandKey,
  claimTaskTx,
}) {
  requiredTx(tx);
  if (typeof claimTaskTx !== 'function') {
    throw AppError.internal(
      'MAR medication exception claim authority is unavailable',
      'MAR_EXCEPTION_CLAIM_AUTHORITY_REQUIRED',
    );
  }
  const cleanCommandKey = requiredCommand(
    commandKey,
    'MAR medication exception claim command key',
    'MAR_EXCEPTION_IDEMPOTENCY_REQUIRED',
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT exception_case.*,
            task.assigned_to_uid::text AS task_assigned_to_uid,
            task.assigned_to_role AS task_assigned_to_role,
            task.status AS task_status
       FROM mar_medication_exception_cases exception_case
       JOIN tasks task
         ON task.tenant_id = exception_case.tenant_id
        AND task.id = exception_case.task_id
      WHERE exception_case.tenant_id = $1::uuid
        AND exception_case.id = $2::bigint
      LIMIT 1
      FOR UPDATE OF exception_case`,
    tenantId,
    requiredMarMedicationExceptionCaseId(exceptionCaseId),
  );
  const exceptionCase = rows[0];
  if (!exceptionCase) throw AppError.notFound('MAR medication exception not found');
  if (exceptionCase.status !== 'open') {
    throw AppError.conflict(
      'MAR medication exception is already resolved',
      'MAR_EXCEPTION_ALREADY_RESOLVED',
    );
  }
  const existingAssignee = String(
    exceptionCase.assigned_prescriber_uid
      || exceptionCase.task_assigned_to_uid
      || '',
  ).trim().toLowerCase();
  if (existingAssignee && existingAssignee !== String(actorUid || '').trim().toLowerCase()) {
    throw AppError.forbidden(
      'This medication exception is assigned to another prescriber',
      'MAR_EXCEPTION_ASSIGNMENT_REQUIRED',
    );
  }

  const claimedTask = await claimTaskTx({
    tenantId,
    id: Number(exceptionCase.task_id),
    actorUid,
    actorRoles,
    actorPrimaryRole,
    actorRawRole,
    idempotencyKey: cleanCommandKey,
    tx,
  });
  const assignedUid = String(claimedTask?.assigned_to_uid || '').trim().toLowerCase();
  if (!assignedUid || assignedUid !== String(actorUid || '').trim().toLowerCase()) {
    throw AppError.conflict(
      'MAR medication exception task claim did not bind the current prescriber',
      'MAR_EXCEPTION_TASK_CLAIM_INVALID',
    );
  }
  const claimAwarenessAt = String(
    claimedTask?.metadata?.role_claimed_at || '',
  ).trim();
  if (
    !claimAwarenessAt
    || Number.isNaN(new Date(claimAwarenessAt).getTime())
  ) {
    throw AppError.internal(
      'MAR medication exception claim lacks its durable awareness timestamp',
      'MAR_EXCEPTION_CLAIM_AWARENESS_MISSING',
    );
  }
  const updatedRows = await tx.$queryRawUnsafe(
    `UPDATE mar_medication_exception_cases
        SET assigned_prescriber_uid = $3::uuid,
            notification_coverage_status = 'notified',
            notified_at = $4::timestamptz
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = 'open'
        AND (
          assigned_prescriber_uid IS NULL
          OR assigned_prescriber_uid = $3::uuid
        )
      RETURNING *`,
    tenantId,
    requiredMarMedicationExceptionCaseId(exceptionCaseId),
    assignedUid,
    claimAwarenessAt,
  );
  if (!updatedRows[0]) {
    throw AppError.conflict(
      'MAR medication exception assignment changed during claim',
      'MAR_EXCEPTION_CLAIM_CONFLICT',
    );
  }
  return Object.freeze({
    exceptionCase: updatedRows[0],
    task: claimedTask,
    replayed: claimedTask.replayed === true,
  });
}

export async function handoffMarMedicationExceptionTx(tx, {
  tenantId,
  exceptionCaseId,
  expectedPrescriberUid,
  targetPrescriberUid,
  reason,
  actorUid,
  commandKey,
  requestFingerprint,
  outbox = notificationOutbox,
}) {
  requiredTx(tx);
  const caseId = requiredMarMedicationExceptionCaseId(exceptionCaseId);
  const expectedUid = String(expectedPrescriberUid || '').trim().toLowerCase();
  const targetUid = String(targetPrescriberUid || '').trim().toLowerCase();
  if (!UUID_RE.test(expectedUid) || !UUID_RE.test(targetUid) || expectedUid === targetUid) {
    throw AppError.badRequest(
      'MAR medication exception handoff requires distinct current and target prescribers',
      'MAR_EXCEPTION_HANDOFF_PRESCRIBERS_INVALID',
    );
  }
  const cleanReason = requiredCommand(
    reason,
    'MAR medication exception handoff reason',
    'MAR_EXCEPTION_HANDOFF_REASON_REQUIRED',
  );
  if (cleanReason.length < 5 || cleanReason.length > 500) {
    throw AppError.badRequest(
      'MAR medication exception handoff reason must be between 5 and 500 characters',
      'MAR_EXCEPTION_HANDOFF_REASON_INVALID',
    );
  }
  const cleanCommandKey = requiredCommand(
    commandKey,
    'MAR medication exception handoff command key',
    'MAR_EXCEPTION_IDEMPOTENCY_REQUIRED',
  );
  const fingerprint = requiredFingerprint(requestFingerprint);

  const rows = await tx.$queryRawUnsafe(
    `SELECT exception_case.*,
            task.status AS task_status,
            task.assigned_to_uid::text AS task_assigned_to_uid,
            task.assigned_to_role AS task_assigned_to_role,
            sla.status AS sla_status,
            sla.completed_at AS sla_completed_at,
            sla.assigned_user_uid::text AS sla_assigned_user_uid,
            actor.role AS actor_role,
            target.id AS target_user_id,
            target.uid::text AS target_uid,
            target.role AS target_role,
            target.phone AS target_phone
       FROM mar_medication_exception_cases exception_case
       JOIN tasks task
         ON task.tenant_id = exception_case.tenant_id
        AND task.id = exception_case.task_id
       JOIN workflow_sla_instances sla
         ON sla.tenant_id = exception_case.tenant_id
        AND sla.id = exception_case.workflow_sla_instance_id
       JOIN users actor
         ON actor.tenant_id = exception_case.tenant_id
        AND actor.uid = $3::uuid
        AND actor.role IN ('ADMIN', 'SUPER_ADMIN')
        AND actor.is_active = TRUE
        AND COALESCE(actor.is_deleted, FALSE) = FALSE
        AND actor.deleted_at IS NULL
        AND LOWER(COALESCE(actor.status, 'active')) = 'active'
       JOIN users target
         ON target.tenant_id = exception_case.tenant_id
        AND target.uid = $4::uuid
        AND target.role = ANY($5::text[])
        AND target.is_active = TRUE
        AND COALESCE(target.is_deleted, FALSE) = FALSE
        AND target.deleted_at IS NULL
        AND LOWER(COALESCE(target.status, 'active')) = 'active'
      WHERE exception_case.tenant_id = $1::uuid
        AND exception_case.id = $2::bigint
      LIMIT 1
      FOR UPDATE OF exception_case, task, sla`,
    tenantId,
    caseId,
    actorUid,
    targetUid,
    [...PRESCRIBER_ROLES],
  );
  const current = rows[0];
  if (!current) {
    throw AppError.forbidden(
      'Active administrator and target prescriber identities are required for handoff',
      'MAR_EXCEPTION_HANDOFF_AUTHORITY_REQUIRED',
    );
  }

  const replayRows = await tx.$queryRawUnsafe(
    `SELECT event.id,
            event.request_fingerprint::text,
            event.occurred_at,
            event.payload
       FROM mar_medication_exception_events event
      WHERE event.tenant_id = $1::uuid
        AND event.exception_case_id = $2::bigint
        AND event.command_key = $3::text
      LIMIT 1`,
    tenantId,
    caseId,
    cleanCommandKey,
  );
  if (replayRows[0]) {
    if (replayRows[0].request_fingerprint !== fingerprint) {
      throw AppError.conflict(
        'MAR medication exception handoff idempotency key was already used for another command',
        'MAR_EXCEPTION_HANDOFF_IDEMPOTENCY_MISMATCH',
      );
    }
    const replayEventId = canonicalPositiveSignedBigInt(replayRows[0].id);
    if (!replayEventId) {
      throw AppError.internal(
        'MAR medication exception handoff replay evidence identity is invalid',
        'MAR_EXCEPTION_HANDOFF_EVENT_ID_INVALID',
      );
    }
    return Object.freeze({
      eventId: replayEventId,
      exceptionCaseId: caseId,
      taskId: Number(replayRows[0].payload?.task_id),
      fromPrescriberUid: replayRows[0].payload?.from_prescriber_uid,
      toPrescriberUid: replayRows[0].payload?.to_prescriber_uid,
      occurredAt: replayRows[0].occurred_at,
      replayed: true,
    });
  }

  const currentCaseAssignee = String(current.assigned_prescriber_uid || '').toLowerCase();
  if (
    current.status !== 'open'
    || currentCaseAssignee !== expectedUid
    || String(current.task_assigned_to_uid || '').toLowerCase() !== expectedUid
    || current.task_assigned_to_role != null
    || String(current.sla_assigned_user_uid || '').toLowerCase() !== expectedUid
    || !['open', 'in_progress', 'overdue'].includes(current.task_status)
    || current.sla_completed_at != null
    || !['active', 'breached', 'escalated'].includes(current.sla_status)
  ) {
    throw AppError.conflict(
      'MAR medication exception assignment changed before handoff',
      'MAR_EXCEPTION_HANDOFF_ASSIGNMENT_CONFLICT',
    );
  }

  const eventIdRows = await tx.$queryRawUnsafe(
    `SELECT nextval(
              pg_get_serial_sequence('mar_medication_exception_events', 'id')
            )::bigint AS id`,
  );
  const eventId = canonicalPositiveSignedBigInt(eventIdRows[0]?.id);
  if (!eventId) {
    throw AppError.internal(
      'MAR medication exception handoff evidence identity was not allocated',
      'MAR_EXCEPTION_HANDOFF_EVENT_ID_MISSING',
    );
  }
  const occurredAt = new Date().toISOString();
  const handoffReceipt = `mar-exception-handoff-v1:${createHash('sha256')
    .update(`${tenantId}:${caseId}:${cleanCommandKey}:${fingerprint}`, 'utf8')
    .digest('hex')}`;
  const queued = await outbox.queue({
    tenantId,
    type: 'mar_medication_exception_assignment_handoff',
    channel: 'inapp',
    recipientId: current.target_user_id,
    recipientPhone: current.target_phone || null,
    title: 'Medication exception reassigned for prescriber review',
    body: 'An administrator reassigned an open held or missed medication exception to you.',
    sourceEventKey: `mar-exception:${caseId}:handoff:${eventId}`,
    templateVersion: 'mar-medication-exception-assignment-handoff.v1',
    data: {
      kind: 'mar_medication_exception_assignment_handoff',
      exception_case_id: caseId,
      medication_administration_id: Number(current.medication_administration_id),
      task_id: Number(current.task_id),
      from_prescriber_uid: expectedUid,
      to_prescriber_uid: targetUid,
      recipient_role: current.target_role,
      deep_link: deepLink(caseId),
      action_label_key: 'orders.mar_recovery.action',
    },
  }, { tx, strict: true });
  if (!queued?.id) {
    throw AppError.internal(
      'MAR medication exception handoff notification was not persisted',
      'MAR_EXCEPTION_HANDOFF_NOTIFICATION_MISSING',
    );
  }
  const payload = {
    version: 'mar_medication_exception_assignment_handoff_v1',
    from_prescriber_uid: expectedUid,
    to_prescriber_uid: targetUid,
    task_id: String(current.task_id),
    workflow_sla_instance_id: String(current.workflow_sla_instance_id).toLowerCase(),
    notification_outbox_id: String(queued.id),
    handoff_receipt: handoffReceipt,
  };
  await tx.$executeRawUnsafe(
    `INSERT INTO mar_medication_exception_events
       (id, tenant_id, exception_case_id, medication_administration_id,
        event_type, actor_uid, actor_role, reason, command_key,
        request_fingerprint, occurred_at, payload)
     VALUES ($1::bigint, $2::uuid, $3::bigint, $4::integer,
             'assignment_handoff', $5::uuid, $6::text, $7::text, $8::text,
             $9::char(64), $10::timestamptz, $11::jsonb)`,
    eventId,
    tenantId,
    caseId,
    Number(current.medication_administration_id),
    actorUid,
    current.actor_role,
    cleanReason,
    cleanCommandKey,
    fingerprint,
    occurredAt,
    JSON.stringify(payload),
  );

  const taskRows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET assigned_to_uid = $4::uuid,
            assigned_to_role = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'assignment_handoff_event_id', $5::text,
              'assignment_handoff_receipt', $6::text,
              'assignment_handoff_command_fingerprint', $7::text,
              'assignment_handoff_from_uid', $3::text,
              'assignment_handoff_to_uid', $4::text,
              'assignment_handoff_task_id', id::text,
              'assignment_handoff_sla_id', workflow_sla_instance_id::text,
              'assignment_handoff_actor_uid', $8::text,
              'assignment_handoff_actor_role', $9::text,
              'assignment_handoff_reason', $10::text,
              'assignment_handoff_at', $11::text,
              'assignment_handoff_outbox_id', $12::text
            ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
        AND assigned_to_uid = $3::uuid
        AND assigned_to_role IS NULL
        AND status IN ('open', 'in_progress', 'overdue')
      RETURNING id`,
    tenantId,
    Number(current.task_id),
    expectedUid,
    targetUid,
    String(eventId),
    handoffReceipt,
    fingerprint,
    actorUid,
    current.actor_role,
    cleanReason,
    occurredAt,
    String(queued.id),
  );
  const slaRows = await tx.$queryRawUnsafe(
    `UPDATE workflow_sla_instances
        SET assigned_user_uid = $4::uuid,
            assigned_role_codes = ARRAY[]::text[],
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'assignment_handoff_event_id', $5::text,
              'assignment_handoff_receipt', $6::text,
              'assignment_handoff_from_uid', $3::text,
              'assignment_handoff_to_uid', $4::text,
              'assignment_handoff_at', $7::text
            ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND assigned_user_uid = $3::uuid
        AND completed_at IS NULL
        AND status IN ('active', 'breached', 'escalated')
      RETURNING id`,
    tenantId,
    current.workflow_sla_instance_id,
    expectedUid,
    targetUid,
    String(eventId),
    handoffReceipt,
    occurredAt,
  );
  const caseRows = await tx.$queryRawUnsafe(
    `UPDATE mar_medication_exception_cases
        SET assigned_prescriber_uid = $4::uuid,
            notification_coverage_status = 'notified',
            notified_at = $5::timestamptz
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND assigned_prescriber_uid = $3::uuid
        AND status = 'open'
      RETURNING id, task_id, assigned_prescriber_uid::text`,
    tenantId,
    caseId,
    expectedUid,
    targetUid,
    occurredAt,
  );
  if (!taskRows[0] || !slaRows[0] || !caseRows[0]) {
    throw AppError.conflict(
      'MAR medication exception assignment changed during handoff',
      'MAR_EXCEPTION_HANDOFF_CONFLICT',
    );
  }
  return Object.freeze({
    eventId,
    exceptionCaseId: caseId,
    taskId: Number(current.task_id),
    fromPrescriberUid: expectedUid,
    toPrescriberUid: targetUid,
    occurredAt,
    replayed: false,
  });
}

export async function resolveMarMedicationExceptionTx(tx, {
  tenantId,
  exceptionCaseId,
  disposition,
  reason,
  actorUid,
  commandKey,
  requestFingerprint,
  replacementClinicalOrderId = null,
  completeTaskTx,
}) {
  requiredTx(tx);
  if (typeof completeTaskTx !== 'function') {
    throw AppError.internal(
      'MAR medication exception completion authority is unavailable',
      'MAR_EXCEPTION_COMPLETION_AUTHORITY_REQUIRED',
    );
  }
  const cleanDisposition = String(disposition || '').trim().toLowerCase();
  if (!['hold_released', ...MAR_MEDICATION_EXCEPTION_DISPOSITIONS].includes(cleanDisposition)) {
    throw AppError.badRequest(
      'Unsupported MAR medication exception disposition',
      'MAR_EXCEPTION_DISPOSITION_INVALID',
    );
  }
  const cleanReason = requiredCommand(
    reason,
    'MAR medication exception disposition reason',
    'MAR_EXCEPTION_DISPOSITION_REASON_REQUIRED',
  );
  const cleanCommandKey = requiredCommand(
    commandKey,
    'MAR medication exception command key',
    'MAR_EXCEPTION_IDEMPOTENCY_REQUIRED',
  );
  const fingerprint = requiredFingerprint(requestFingerprint);
  const rows = await tx.$queryRawUnsafe(
    `SELECT exception_case.*,
            administration.status AS administration_status,
            administration.medication_name,
            administration.scheduled_time,
            clinical_order.status AS clinical_order_status,
            task.assigned_to_uid::text,
            actor.role AS actor_role
       FROM mar_medication_exception_cases exception_case
       JOIN medication_administrations administration
         ON administration.tenant_id = exception_case.tenant_id
        AND administration.id = exception_case.medication_administration_id
       JOIN tasks task
         ON task.tenant_id = exception_case.tenant_id
        AND task.id = exception_case.task_id
       JOIN users actor
         ON actor.tenant_id = exception_case.tenant_id
        AND actor.uid = $3::uuid
        AND actor.is_active = TRUE
        AND COALESCE(actor.is_deleted, FALSE) = FALSE
        AND actor.deleted_at IS NULL
        AND LOWER(COALESCE(actor.status, 'active')) = 'active'
       JOIN clinical_orders clinical_order
         ON clinical_order.tenant_id = exception_case.tenant_id
        AND clinical_order.id = exception_case.clinical_order_id
      WHERE exception_case.tenant_id = $1::uuid
        AND exception_case.id = $2::bigint
      FOR UPDATE OF exception_case, administration, clinical_order, task, actor`,
    tenantId,
    requiredMarMedicationExceptionCaseId(exceptionCaseId),
    actorUid,
  );
  const exceptionCase = rows[0];
  if (!exceptionCase) throw AppError.notFound('MAR medication exception not found');
  if (!isDoctor(String(exceptionCase.actor_role || '').trim().toUpperCase())) {
    throw AppError.forbidden(
      'Only an active assigned prescriber may disposition a medication exception',
      'MAR_EXCEPTION_PRESCRIBER_REQUIRED',
    );
  }
  const assignedUid = String(
    exceptionCase.assigned_to_uid || exceptionCase.assigned_prescriber_uid || '',
  ).toLowerCase();
  if (!assignedUid || assignedUid !== String(actorUid).toLowerCase()) {
    throw AppError.forbidden(
      'This medication exception is assigned to another prescriber',
      'MAR_EXCEPTION_ASSIGNMENT_REQUIRED',
    );
  }

  const replayRows = await tx.$queryRawUnsafe(
    `SELECT event.id, event.request_fingerprint, event.disposition
       FROM mar_medication_exception_events event
      WHERE event.tenant_id = $1::uuid
        AND event.exception_case_id = $2::bigint
        AND event.command_key = $3::text
      LIMIT 1`,
    tenantId,
    requiredMarMedicationExceptionCaseId(exceptionCaseId),
    cleanCommandKey,
  );
  if (replayRows[0]) {
    if (String(replayRows[0].request_fingerprint) !== fingerprint) {
      throw AppError.conflict(
        'MAR medication exception command key was reused with a different request',
        'MAR_EXCEPTION_IDEMPOTENCY_CONFLICT',
      );
    }
    return { exceptionCase, event: replayRows[0], replayed: true };
  }
  if (exceptionCase.status !== 'open') {
    throw AppError.conflict(
      'MAR medication exception is already resolved',
      'MAR_EXCEPTION_ALREADY_RESOLVED',
    );
  }
  if (exceptionCase.exception_kind === 'held') {
    if (!['hold_released', 'order_stopped'].includes(cleanDisposition)) {
      throw AppError.badRequest(
        'Held medication exceptions close only from release or exact stopped-order evidence',
        'MAR_EXCEPTION_HELD_DISPOSITION_INVALID',
      );
    }
  } else if (cleanDisposition === 'hold_released') {
    throw AppError.badRequest(
      'Missed medication exceptions cannot be released',
      'MAR_EXCEPTION_MISSED_DISPOSITION_INVALID',
    );
  }
  if (
    cleanDisposition === 'hold_released'
    && String(exceptionCase.administration_status || '').toLowerCase() !== 'scheduled'
  ) {
    throw AppError.conflict(
      'Held medication exception lacks the exact committed release state',
      'MAR_EXCEPTION_RELEASE_EVIDENCE_MISSING',
    );
  }

  let replacementOrder = null;
  if (cleanDisposition === 'replacement_ordered') {
    const replacementId = Number(replacementClinicalOrderId);
    if (!Number.isSafeInteger(replacementId) || replacementId <= 0) {
      throw AppError.badRequest(
        'replacement_clinical_order_id is required for replacement_ordered',
        'MAR_EXCEPTION_REPLACEMENT_ORDER_REQUIRED',
      );
    }
    const replacementRows = await tx.$queryRawUnsafe(
      `SELECT replacement.id, replacement.status
         FROM clinical_orders replacement
        WHERE replacement.tenant_id = $1::uuid
          AND replacement.id = $2::integer
          AND replacement.id IS DISTINCT FROM $3::integer
          AND replacement.patient_uid = $4::uuid
          AND replacement.order_type = 'medication'
          AND LOWER(replacement.status) = ANY($5::text[])
          AND replacement.created_at >= $6::timestamptz
        LIMIT 1
        FOR SHARE`,
      tenantId,
      replacementId,
      exceptionCase.clinical_order_id == null ? null : Number(exceptionCase.clinical_order_id),
      exceptionCase.patient_uid,
      [...ACTIVE_ORDER_STATUSES],
      exceptionCase.raised_at,
    );
    replacementOrder = replacementRows[0];
    if (!replacementOrder) {
      throw AppError.conflict(
        'Referenced replacement is not a separately authorized active medication order',
        'MAR_EXCEPTION_REPLACEMENT_ORDER_INVALID',
      );
    }
  } else if (replacementClinicalOrderId != null) {
    throw AppError.badRequest(
      'replacement_clinical_order_id is allowed only for replacement_ordered',
      'MAR_EXCEPTION_REPLACEMENT_ORDER_UNEXPECTED',
    );
  }

  if (cleanDisposition === 'order_stopped') {
    if (
      exceptionCase.clinical_order_id == null
      || ACTIVE_ORDER_STATUSES.has(String(exceptionCase.clinical_order_status || '').toLowerCase())
    ) {
      throw AppError.conflict(
        'The original medication order does not contain exact stopped-order evidence',
        'MAR_EXCEPTION_ORDER_STILL_ACTIVE',
      );
    }
  }

  const eventRows = await tx.$queryRawUnsafe(
    `INSERT INTO mar_medication_exception_events
       (tenant_id, exception_case_id, medication_administration_id,
        event_type, disposition, actor_uid, actor_role, reason,
        replacement_clinical_order_id, command_key, request_fingerprint, payload)
     VALUES ($1::uuid, $2::bigint, $3::integer,
             'resolved', $4::text, $5::uuid, $6::text, $7::text,
             $8::integer, $9::text, $10::char(64), $11::jsonb)
     RETURNING id, disposition, occurred_at`,
    tenantId,
    requiredMarMedicationExceptionCaseId(exceptionCaseId),
    Number(exceptionCase.medication_administration_id),
    cleanDisposition,
    actorUid,
    exceptionCase.actor_role,
    cleanReason,
    replacementOrder ? Number(replacementOrder.id) : null,
    cleanCommandKey,
    fingerprint,
    JSON.stringify({
      clinical_order_id: exceptionCase.clinical_order_id == null
        ? null
        : Number(exceptionCase.clinical_order_id),
      clinical_order_status: exceptionCase.clinical_order_status || null,
      replacement_clinical_order_status: replacementOrder?.status || null,
    }),
  );
  const event = eventRows[0];
  await completeTaskTx({
    tenantId,
    id: Number(exceptionCase.task_id),
    evidenceKind: 'mar_medication_exception_resolution',
    evidenceResourceType: 'mar_medication_exception_event',
    evidenceResourceId: String(event.id),
    actorUid,
    tx,
  });
  const resolvedRows = await tx.$queryRawUnsafe(
    `UPDATE mar_medication_exception_cases
        SET status = 'resolved',
            resolution_kind = $3::text,
            resolution_event_id = $4::bigint,
            resolved_by = $5::uuid,
            resolved_at = $6::timestamptz
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = 'open'
      RETURNING *`,
    tenantId,
    requiredMarMedicationExceptionCaseId(exceptionCaseId),
    cleanDisposition,
    String(event.id),
    actorUid,
    event.occurred_at,
  );
  if (resolvedRows.length !== 1) {
    throw AppError.conflict(
      'MAR medication exception state changed concurrently',
      'MAR_EXCEPTION_STATE_CONFLICT',
    );
  }
  return {
    exceptionCase: { ...exceptionCase, ...resolvedRows[0] },
    event,
    replayed: false,
  };
}

export async function listAssignedMarMedicationExceptions({
  db,
  tenantId,
  actorUid,
  caseId = null,
}) {
  if (!db?.$queryRawUnsafe) {
    throw AppError.internal('MAR medication exception list requires a database client');
  }
  const actorRows = await db.$queryRawUnsafe(
    `SELECT role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND COALESCE(is_deleted, FALSE) = FALSE
        AND deleted_at IS NULL
        AND LOWER(COALESCE(status, 'active')) = 'active'
      LIMIT 1`,
    tenantId,
    actorUid,
  );
  if (!isDoctor(String(actorRows[0]?.role || '').trim().toUpperCase())) {
    throw AppError.forbidden(
      'Only an active prescriber may view assigned medication exceptions',
      'MAR_EXCEPTION_PRESCRIBER_REQUIRED',
    );
  }
  const requestedCaseId = caseId == null
    ? null
    : requiredMarMedicationExceptionCaseId(caseId);
  const rows = await db.$queryRawUnsafe(
    `SELECT administration.id,
            exception_case.id AS exception_case_id,
            exception_case.exception_kind,
            exception_case.reason AS exception_reason,
            exception_case.raised_at,
            exception_case.notification_coverage_status,
            exception_case.patient_uid::text,
            administration.medication_name,
            administration.dose,
            administration.dosage,
            administration.route,
            administration.scheduled_time,
            administration.status,
            administration.notes,
            clinical_order.id AS clinical_order_id,
            clinical_order.encounter_id::text,
            clinical_order.status AS clinical_order_status,
            patient.name AS patient_name,
            bed.bed_number,
            bed.ward_id,
            bed.ward_name,
            task.id AS exception_task_id,
            task.status AS exception_task_status,
            sla.due_at AS exception_due_at,
            sla.status AS exception_sla_status
       FROM mar_medication_exception_cases exception_case
       JOIN medication_administrations administration
         ON administration.tenant_id = exception_case.tenant_id
        AND administration.id = exception_case.medication_administration_id
       JOIN users patient
         ON patient.tenant_id = exception_case.tenant_id
        AND patient.uid = exception_case.patient_uid
       JOIN tasks task
         ON task.tenant_id = exception_case.tenant_id
        AND task.id = exception_case.task_id
       JOIN workflow_sla_instances sla
         ON sla.tenant_id = exception_case.tenant_id
        AND sla.id = exception_case.workflow_sla_instance_id
       LEFT JOIN clinical_orders clinical_order
         ON clinical_order.tenant_id = exception_case.tenant_id
        AND clinical_order.id = exception_case.clinical_order_id
       LEFT JOIN LATERAL (
         SELECT patient_bed.bed_number,
                ward.id AS ward_id,
                ward.name AS ward_name
           FROM beds patient_bed
           LEFT JOIN wards ward
             ON ward.tenant_id = patient_bed.tenant_id
            AND ward.id = patient_bed.ward_id
          WHERE patient_bed.tenant_id = exception_case.tenant_id
            AND patient_bed.patient_id = patient.id
          ORDER BY patient_bed.updated_at DESC NULLS LAST, patient_bed.id DESC
          LIMIT 1
       ) bed ON TRUE
      WHERE exception_case.tenant_id = $1::uuid
        AND exception_case.status = 'open'
        AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
        AND COALESCE(task.assigned_to_uid, exception_case.assigned_prescriber_uid) = $2::uuid
        AND ($3::bigint IS NULL OR exception_case.id = $3::bigint)
      ORDER BY
        CASE WHEN sla.due_at < NOW() THEN 0 ELSE 1 END,
        sla.due_at ASC,
        exception_case.raised_at ASC,
        exception_case.id ASC`,
    tenantId,
    actorUid,
    requestedCaseId,
  );
  return rows.map((row) => ({
    ...row,
    exception_case_id: requiredMarMedicationExceptionCaseId(row.exception_case_id),
  }));
}

export async function getMarExceptionMedicationAdministrationId({
  db,
  tenantId,
  exceptionCaseId,
}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT medication_administration_id
       FROM mar_medication_exception_cases
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      LIMIT 1`,
    tenantId,
    requiredMarMedicationExceptionCaseId(exceptionCaseId),
  );
  return rows[0]?.medication_administration_id == null
    ? null
    : Number(rows[0].medication_administration_id);
}

export default {
  openMarMedicationExceptionTx,
  claimMarMedicationExceptionTx,
  resolveMarMedicationExceptionTx,
  listAssignedMarMedicationExceptions,
  getMarExceptionMedicationAdministrationId,
  reconcileMarMedicationExceptions,
  escalateMarMedicationExceptionCases,
};
