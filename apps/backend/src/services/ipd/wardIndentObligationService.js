import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { startWorkflowSla } from '../clinical/canonicalClinicalPlatformService.js';
import {
  completeTaskFromDomainEvidence,
  createWardMedicationObligationTaskTx,
  postTaskComment,
} from '../workflow/taskService.js';

const RECIPIENT_LIMIT = 12;
const COVERAGE_RECOVERY_LIMIT = 25;
const COVERAGE_RECOVERY_MAX_LIMIT = 100;
const COVERAGE_RECOVERY_SOURCE = 'ward-indent-notification-coverage-recovery.v1';
const COVERAGE_RECOVERY_MANUAL_HOLD = 'manual_hold';
const COVERAGE_ROLES = ['ADMIN', 'SUPER_ADMIN'];
const BILLING_ROLES = ['BILLING_INCHARGE', 'FINANCE_INCHARGE'];
const REFUND_APPROVAL_ROLES = ['ADMIN', 'SUPER_ADMIN'];
const CREDIT_NOTE_NOTIFICATION_ACTION_LABEL_KEY = 'med03.credit_note.notification_action';
const MAR_SUPPLY_RECONCILIATION_ROLES = [
  'PHARMACY_INCHARGE',
  'NURSING_INCHARGE',
  'IP_INCHARGE',
];
const ACTIONABLE_TASK_STATUSES = ['open', 'in_progress', 'blocked', 'overdue'];

const STATE_PRESENTATION = Object.freeze({
  requested: {
    title: 'Review ward medication request',
    description: 'Confirm exact Inventory V2 availability and reserve the requested ward medication.',
    priority: 'high',
    notificationKind: 'ward_indent_request',
    departments: ['pharmacy'],
  },
  reserved: {
    title: 'Issue reserved ward medication',
    description: 'Issue the exact reserved batches and preserve movement and charge lineage.',
    priority: 'high',
    notificationKind: 'ward_indent_reserved',
    departments: ['pharmacy'],
  },
  short_supply: {
    title: 'Resolve ward medication short supply',
    description: 'Resolve the documented shortfall or propose a clinically governed substitution.',
    priority: 'high',
    notificationKind: 'ward_indent_short_supply',
    departments: ['pharmacy'],
  },
  substitution_pending: {
    title: 'Authorize ward medication substitution',
    description: 'Review the exact proposed substitute before pharmacy re-reserves stock.',
    priority: 'critical',
    notificationKind: 'ward_indent_substitution',
    departments: ['medical'],
  },
  controlled_handoff_required: {
    title: 'Complete controlled-medication handoff',
    description: 'Record witnessed statutory handoff evidence before the ward medication can be issued.',
    priority: 'critical',
    notificationKind: 'ward_indent_controlled_handoff',
    departments: ['pharmacy'],
  },
  approved: {
    title: 'Issue approved ward medication',
    description: 'Issue the approved exact batches and preserve inventory and billing evidence.',
    priority: 'high',
    notificationKind: 'ward_indent_approved',
    departments: ['pharmacy'],
  },
  issued: {
    title: 'Acknowledge ward medication receipt',
    description: 'Record exact quantities received and acknowledge any approved substitution.',
    priority: 'critical',
    notificationKind: 'ward_indent_issued',
    departments: ['nursing'],
  },
  partially_received: {
    title: 'Complete ward medication receipt',
    description: 'Resolve the remaining issued-versus-received discrepancy.',
    priority: 'critical',
    notificationKind: 'ward_indent_partial_receipt',
    departments: ['nursing'],
  },
  received: {
    title: 'Reconcile ward medication custody',
    description: 'Confirm received custody, MAR availability, and any pending return or variance.',
    priority: 'high',
    notificationKind: 'ward_indent_received',
    departments: ['pharmacy', 'nursing'],
  },
  return_pending: {
    title: 'Reconcile ward medication return',
    description: 'Validate unconsumed custody and complete exact-batch return and patient credit evidence.',
    priority: 'high',
    notificationKind: 'ward_indent_return_pending',
    departments: ['pharmacy', 'nursing'],
  },
  reconciliation_required: {
    title: 'Resolve ward medication discrepancy',
    description: 'Resolve the documented custody discrepancy without rewriting clinical or stock evidence.',
    priority: 'critical',
    notificationKind: 'ward_indent_reconciliation',
    departments: ['pharmacy', 'nursing'],
  },
  reconciled: {
    title: 'Close reconciled ward medication indent',
    description: 'Verify every clinical, inventory, financial, and return obligation before closure.',
    priority: 'high',
    notificationKind: 'ward_indent_reconciled',
    departments: ['pharmacy', 'nursing'],
  },
});

function requiredTx(tx) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'Ward medication obligations require the caller transaction',
      'WARD_MEDICATION_OBLIGATION_TRANSACTION_REQUIRED',
    );
  }
  return tx;
}

function sourceKey(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw AppError.internal(
      'Ward medication obligation requires an SLA source identity',
      'WARD_MEDICATION_OBLIGATION_SOURCE_REQUIRED',
    );
  }
  return text;
}

function stageOccurrenceKey(tenantId, sourceId) {
  const digest = createHash('sha256')
    .update(`${tenantId}:${sourceId}`, 'utf8')
    .digest('hex');
  return `ward-medication-obligation:${digest}`;
}

function notificationSourceKey(event, kind) {
  return `ward-indent:${event.ward_indent_id}:v${event.state_version}:${kind}`;
}

function deepLink(indentId) {
  return `/pharmacy?tab=ward-indents&indent_id=${Number(indentId)}`;
}

async function loadSla(tx, { tenantId, sourceId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, rule_code, source_table, source_id, status, completed_at, due_at
       FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid
        AND source_table = 'ward_indents'
        AND source_id = $2::text
      LIMIT 1
      FOR SHARE`,
    tenantId,
    sourceId,
  );
  const sla = rows[0];
  if (
    !sla?.id
    || sla.completed_at != null
    || !['active', 'breached', 'escalated'].includes(String(sla.status || '').toLowerCase())
  ) {
    throw AppError.internal(
      'Ward medication obligation requires an actionable workflow SLA',
      'WARD_MEDICATION_OBLIGATION_SLA_UNAVAILABLE',
    );
  }
  return sla;
}

async function resolveRecipients(tx, {
  tenantId,
  roles,
  departments = [],
  at = new Date(),
}) {
  const roleCodes = [...new Set((roles || []).map(String).map((role) => role.trim()).filter(Boolean))];
  if (roleCodes.length === 0) return [];
  return tx.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.phone, u.role,
            EXISTS (
              SELECT 1
                FROM staff_on_call_assignments call
               WHERE call.tenant_id = u.tenant_id
                 AND call.staff_id = u.id
                 AND call.is_active = TRUE
                 AND call.start_at <= $4::timestamptz
                 AND call.end_at > $4::timestamptz
                 AND (
                   cardinality($3::text[]) = 0
                   OR LOWER(call.department) = ANY($3::text[])
                 )
            ) AS is_on_call
       FROM users u
      WHERE u.tenant_id = $1::uuid
        AND u.role = ANY($2::text[])
        AND u.is_active = TRUE
        AND COALESCE(u.is_deleted, FALSE) = FALSE
        AND LOWER(COALESCE(u.status, 'active')) = 'active'
      ORDER BY is_on_call DESC, u.last_sign_in_at DESC NULLS LAST, u.id ASC
      LIMIT $5::int`,
    tenantId,
    roleCodes,
    [...new Set(departments.map(String).map((value) => value.toLowerCase()))],
    at.toISOString(),
    RECIPIENT_LIMIT,
  );
}

async function queueRecipientNotifications(tx, {
  tenantId,
  recipients,
  task,
  indent,
  event,
  presentation,
  sourceEventKey = null,
  coverageTaskId = null,
  recoverySource = null,
  recoveryActorUid = null,
}) {
  const queued = [];
  for (const recipient of recipients) {
    const outbox = await notificationOutbox.queue({
      tenantId,
      type: presentation.notificationKind,
      channel: 'inapp',
      recipientId: recipient.id,
      recipientPhone: recipient.phone || null,
      title: presentation.title,
      body: `Ward indent ${indent.indent_number} requires action.`,
      sourceEventKey: sourceEventKey || notificationSourceKey(event, presentation.notificationKind),
      templateVersion: `${presentation.notificationKind}.v1`,
      data: {
        kind: presentation.notificationKind,
        task_id: Number(task.id),
        ward_indent_id: Number(indent.id),
        ward_indent_item_id: null,
        state: indent.status,
        state_version: Number(indent.state_version),
        deep_link: deepLink(indent.id),
        ...(coverageTaskId ? { coverage_task_id: Number(coverageTaskId) } : {}),
        ...(recoverySource ? { recovery_source: recoverySource } : {}),
        ...(recoveryActorUid ? { recovery_actor_uid: recoveryActorUid } : {}),
      },
    }, { tx, strict: true });
    if (!outbox?.id) {
      throw AppError.internal(
        'Ward medication notification intent was not persisted',
        'WARD_MEDICATION_NOTIFICATION_INTENT_MISSING',
      );
    }
    queued.push(outbox);
  }
  return queued;
}

function coverageNotificationIntent({
  taskId,
  type,
  title,
  body,
  sourceEventKey,
  templateVersion,
  data,
}) {
  const originalTaskId = Number(taskId);
  const notificationType = String(type || '').trim();
  const notificationTitle = String(title || '').trim();
  const notificationBody = String(body || '').trim();
  const notificationSourceEventKey = String(sourceEventKey || '').trim();
  const notificationTemplateVersion = String(templateVersion || '').trim();
  const notificationData = data && typeof data === 'object' && !Array.isArray(data)
    ? data
    : null;
  if (
    !Number.isSafeInteger(originalTaskId)
    || originalTaskId <= 0
    || !notificationType
    || !notificationTitle
    || !notificationBody
    || !notificationSourceEventKey
    || !notificationTemplateVersion
    || !notificationData
    || typeof notificationData.deep_link !== 'string'
    || !notificationData.deep_link.startsWith('/')
  ) {
    throw AppError.internal(
      'Notification coverage requires one exact actionable notification intent',
      'WARD_MEDICATION_COVERAGE_INTENT_INVALID',
    );
  }
  return {
    type: notificationType,
    title: notificationTitle,
    body: notificationBody,
    source_event_key: notificationSourceEventKey,
    template_version: notificationTemplateVersion,
    data: {
      ...notificationData,
      kind: notificationType,
      task_id: originalTaskId,
    },
  };
}

function storedCoverageNotificationIntent(metadata) {
  const intent = metadata?.notification_intent;
  return coverageNotificationIntent({
    taskId: intent?.data?.task_id,
    type: intent?.type,
    title: intent?.title,
    body: intent?.body,
    sourceEventKey: intent?.source_event_key,
    templateVersion: intent?.template_version,
    data: intent?.data,
  });
}

function isInvalidCoverageIntent(error) {
  return error?.code === 'WARD_MEDICATION_COVERAGE_INTENT_INVALID';
}

async function holdInvalidCoverageIntentTx(tx, {
  tenantId,
  gap,
}) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status = 'blocked',
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND metadata->>'task_contract' = 'ward_medication_obligation_v1'
        AND metadata->>'obligation_kind' = 'notification_coverage'
        AND status = ANY($4::text[])
      RETURNING id`,
    tenantId,
    Number(gap.id),
    JSON.stringify({
      notification_recovery_status: COVERAGE_RECOVERY_MANUAL_HOLD,
      notification_recovery_hold_code: 'WARD_MEDICATION_COVERAGE_INTENT_INVALID',
      notification_recovery_hold_reason: 'Exact pre-upgrade notification intent is unavailable; manual evidence review is required. No replacement notification was emitted.',
      notification_recovery_held_at: new Date().toISOString(),
    }),
    ACTIONABLE_TASK_STATUSES,
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function queueRecoveredCoverageNotifications(tx, {
  tenantId,
  recipients,
  gap,
  actorUid,
}) {
  const intent = storedCoverageNotificationIntent(gap.metadata);
  const queued = [];
  for (const recipient of recipients) {
    const outbox = await notificationOutbox.queue({
      tenantId,
      type: intent.type,
      channel: 'inapp',
      recipientId: recipient.id,
      recipientPhone: recipient.phone || null,
      title: intent.title,
      body: intent.body,
      sourceEventKey: intent.source_event_key,
      templateVersion: intent.template_version,
      data: {
        ...intent.data,
        coverage_task_id: Number(gap.id),
        recovery_source: COVERAGE_RECOVERY_SOURCE,
        recovery_actor_uid: actorUid,
      },
    }, { tx, strict: true });
    if (!outbox?.id) {
      throw AppError.internal(
        'Recovered notification intent was not persisted',
        'WARD_MEDICATION_COVERAGE_RECOVERY_INTENT_MISSING',
      );
    }
    queued.push(outbox);
  }
  return queued;
}

async function createCoverageGap(tx, {
  indent,
  actorUid,
  event,
  presentation,
  intendedRoles,
  notificationIntent,
}) {
  const tenantId = String(indent.tenant_id);
  const exactNotificationIntent = storedCoverageNotificationIntent({
    notification_intent: notificationIntent,
  });
  const coverageIntentDigest = createHash('sha256')
    .update([
      exactNotificationIntent.type,
      exactNotificationIntent.source_event_key,
      exactNotificationIntent.template_version,
    ].join(':'), 'utf8')
    .digest('hex');
  const coverageSourceId = `ward-indent-coverage:${indent.id}:${coverageIntentDigest}`;
  const sla = await startWorkflowSla({
    tenantId,
    ruleCode: 'ward_indent_notification_coverage',
    patientUid: indent.patient_uid || null,
    encounterId: indent.encounter_id || null,
    sourceTable: 'ward_indents',
    sourceId: coverageSourceId,
    priority: 'critical',
    assignedRoleCodes: COVERAGE_ROLES,
    metadata: {
      med_03: true,
      ward_indent_id: Number(indent.id),
      state_version: Number(indent.state_version),
      missing_recipient_roles: intendedRoles,
    },
  }, { db: tx, strict: true });
  if (!sla?.id) {
    throw AppError.internal(
      'Notification coverage SLA could not be materialized',
      'WARD_MEDICATION_COVERAGE_SLA_MISSING',
    );
  }
  const task = await createWardMedicationObligationTaskTx({
    tenantId,
    taskKind: 'escalation',
    title: 'Restore ward medication notification coverage',
    description: 'No active concrete recipient could be resolved for a medication obligation. Restore roster coverage and reconcile the durable notification intent.',
    patientUid: indent.patient_uid || null,
    encounterId: indent.encounter_id || null,
    relatedResourceType: 'ward_indents',
    relatedResourceId: coverageSourceId,
    priority: 'critical',
    assignedToRole: COVERAGE_ROLES[0],
    createdBy: actorUid,
    workflowSlaInstanceId: sla.id,
    stageOccurrenceKey: stageOccurrenceKey(tenantId, coverageSourceId),
    metadata: {
      med_03: true,
      sla_key: 'ward_indent_notification_coverage',
      obligation_kind: 'notification_coverage',
      evidence_kind: 'notification_coverage_restored',
      ward_indent_id: Number(indent.id),
      current_state: indent.status,
      state_version: Number(indent.state_version),
      source_event_id: String(event.id),
      intended_roles: intendedRoles,
      intended_departments: presentation.departments || [],
      intended_notification_title: presentation.title,
      intended_notification_kind: presentation.notificationKind,
      deep_link: exactNotificationIntent.data.deep_link,
      notification_intent: exactNotificationIntent,
    },
    tx,
  });
  if (!task?.id) {
    throw AppError.internal(
      'Notification coverage task could not be materialized',
      'WARD_MEDICATION_COVERAGE_TASK_MISSING',
    );
  }

  const adminRecipients = await resolveRecipients(tx, {
    tenantId,
    roles: COVERAGE_ROLES,
    departments: ['administration'],
  });
  if (adminRecipients.length > 0) {
    await queueRecipientNotifications(tx, {
      tenantId,
      recipients: adminRecipients,
      task,
      indent,
      event,
      presentation: {
        title: 'Ward medication notification coverage gap',
        notificationKind: 'ward_indent_notification_coverage',
      },
      sourceEventKey: `ward-indent-coverage:${task.id}`,
    });
  }
  return task;
}

async function loadOpenStateTask(tx, tenantId, slaId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, metadata, status, workflow_sla_instance_id
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND workflow_sla_instance_id = $2::uuid
        AND metadata->>'task_contract' = 'ward_medication_obligation_v1'
        AND metadata->>'obligation_kind' = 'ward_indent_state'
        AND status = ANY($3::text[])
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    slaId,
    ACTIONABLE_TASK_STATUSES,
  );
  return rows[0] || null;
}

async function ensureStateTask(tx, {
  indent,
  actorUid,
  event,
  notify,
}) {
  const tenantId = String(indent.tenant_id);
  const sourceId = sourceKey(indent.active_sla_source_id);
  const presentation = STATE_PRESENTATION[indent.status];
  if (!presentation) return null;
  const sla = await loadSla(tx, { tenantId, sourceId });
  let task = await loadOpenStateTask(tx, tenantId, sla.id);
  if (task) {
    const previousVersion = Number(task.metadata?.state_version || 0);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE tasks
          SET title = $3::text,
              description = $4::text,
              priority = $5::text,
              assigned_to_uid = NULL,
              assigned_to_role = $6::text,
              metadata = COALESCE(metadata, '{}'::jsonb) || $7::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        RETURNING id, metadata, status, workflow_sla_instance_id`,
      tenantId,
      Number(task.id),
      presentation.title,
      presentation.description,
      presentation.priority,
      indent.owner_role_codes[0],
      JSON.stringify({
        current_state: indent.status,
        state_version: Number(indent.state_version),
        ward_indent_event_id: String(event.id),
        owner_role_codes: indent.owner_role_codes,
        deep_link: deepLink(indent.id),
      }),
    );
    task = rows[0];
    if (previousVersion !== Number(indent.state_version)) {
      await postTaskComment({
        tenantId,
        taskId: Number(task.id),
        authorUid: actorUid,
        body: `Ward indent obligation advanced to ${indent.status}.`,
        bodyKind: 'system_event',
        metadata: {
          state: indent.status,
          state_version: Number(indent.state_version),
          ward_indent_event_id: String(event.id),
        },
        tx,
      });
    }
  } else {
    task = await createWardMedicationObligationTaskTx({
      tenantId,
      taskKind: indent.status === 'controlled_handoff_required' ? 'verification' : 'review',
      title: presentation.title,
      description: presentation.description,
      patientUid: indent.patient_uid || null,
      encounterId: indent.encounter_id || null,
      relatedResourceType: 'ward_indents',
      relatedResourceId: sourceId,
      priority: presentation.priority,
      assignedToRole: indent.owner_role_codes[0],
      createdBy: actorUid,
      workflowSlaInstanceId: sla.id,
      stageOccurrenceKey: stageOccurrenceKey(tenantId, sourceId),
      metadata: {
        med_03: true,
        sla_key: sla.rule_code,
        obligation_kind: 'ward_indent_state',
        evidence_kind: 'ward_indent_transition',
        ward_indent_id: Number(indent.id),
        current_state: indent.status,
        state_version: Number(indent.state_version),
        ward_indent_event_id: String(event.id),
        owner_role_codes: indent.owner_role_codes,
        deep_link: deepLink(indent.id),
      },
      tx,
    });
  }
  if (!task?.id) {
    throw AppError.internal(
      'Ward medication state task could not be materialized',
      'WARD_MEDICATION_STATE_TASK_MISSING',
    );
  }

  if (notify) {
    const recipients = await resolveRecipients(tx, {
      tenantId,
      roles: indent.owner_role_codes,
      departments: presentation.departments,
    });
    if (recipients.length === 0) {
      await createCoverageGap(tx, {
        indent,
        actorUid,
        event,
        presentation,
        intendedRoles: indent.owner_role_codes,
        notificationIntent: coverageNotificationIntent({
          taskId: task.id,
          type: presentation.notificationKind,
          title: presentation.title,
          body: `Ward indent ${indent.indent_number} requires action.`,
          sourceEventKey: notificationSourceKey(event, presentation.notificationKind),
          templateVersion: `${presentation.notificationKind}.v1`,
          data: {
            ward_indent_id: Number(indent.id),
            ward_indent_item_id: null,
            state: indent.status,
            state_version: Number(indent.state_version),
            deep_link: deepLink(indent.id),
          },
        }),
      });
    } else {
      await queueRecipientNotifications(tx, {
        tenantId,
        recipients,
        task,
        indent,
        event,
        presentation,
      });
    }
  }
  return task;
}

export async function completeWardIndentStateObligationTx(tx, {
  before,
  after,
  event,
  actorUid,
}) {
  requiredTx(tx);
  const previousSourceId = String(before?.active_sla_source_id || '').trim();
  if (!previousSourceId || previousSourceId === String(after?.active_sla_source_id || '').trim()) {
    return null;
  }
  const sla = await loadSla(tx, {
    tenantId: String(before.tenant_id),
    sourceId: previousSourceId,
  });
  let task = await loadOpenStateTask(tx, String(before.tenant_id), sla.id);
  if (!task) {
    task = await ensureStateTask(tx, {
      indent: before,
      actorUid,
      event: {
        id: `backfill-${event.id}`,
        ward_indent_id: before.id,
        state_version: before.state_version,
      },
      notify: false,
    });
  }
  return completeTaskFromDomainEvidence({
    tenantId: String(before.tenant_id),
    id: Number(task.id),
    evidenceKind: 'ward_indent_transition',
    evidenceResourceType: 'ward_indent_event',
    evidenceResourceId: String(event.id),
    actorUid,
    tx,
  });
}

export async function materializeWardIndentStateObligationTx(tx, {
  indent,
  event,
  actorUid,
  notify = true,
}) {
  requiredTx(tx);
  if (!STATE_PRESENTATION[indent?.status]) return null;
  return ensureStateTask(tx, { indent, actorUid, event, notify });
}

export async function reconcileWardIndentNotificationCoverageTx(tx, {
  tenantId,
  indent,
  actorUid,
  limit = 20,
}) {
  requiredTx(tx);
  const gaps = await tx.$queryRawUnsafe(
    `SELECT id, metadata
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND metadata->>'task_contract' = 'ward_medication_obligation_v1'
        AND metadata->>'obligation_kind' = 'notification_coverage'
        AND metadata->>'ward_indent_id' = $2::text
        AND status = ANY($3::text[])
        AND COALESCE(metadata->>'notification_recovery_status', '') <> $5::text
      ORDER BY created_at ASC, id ASC
      LIMIT $4::int
      FOR UPDATE SKIP LOCKED`,
    tenantId,
    String(indent.id),
    ACTIONABLE_TASK_STATUSES,
    Math.min(Math.max(Number(limit) || 20, 1), 100),
    COVERAGE_RECOVERY_MANUAL_HOLD,
  );
  const completed = [];
  for (const gap of gaps) {
    try {
      storedCoverageNotificationIntent(gap.metadata);
    } catch (error) {
      if (!isInvalidCoverageIntent(error)) throw error;
      await holdInvalidCoverageIntentTx(tx, { tenantId, gap });
      continue;
    }
    const roles = Array.isArray(gap.metadata?.intended_roles) ? gap.metadata.intended_roles : [];
    const departments = Array.isArray(gap.metadata?.intended_departments)
      ? gap.metadata.intended_departments
      : [];
    const recipients = await resolveRecipients(tx, { tenantId, roles, departments });
    if (recipients.length === 0) continue;
    const queued = await queueRecoveredCoverageNotifications(tx, {
      tenantId,
      recipients,
      gap,
      actorUid,
    });
    await completeTaskFromDomainEvidence({
      tenantId,
      id: Number(gap.id),
      evidenceKind: 'notification_coverage_restored',
      evidenceResourceType: 'notification_outbox',
      evidenceResourceId: String(queued[0].id),
      actorUid,
      tx,
    });
    completed.push(Number(gap.id));
  }
  return completed;
}

function coverageRecoveryLimit(value) {
  const requested = Number(value);
  if (!Number.isSafeInteger(requested) || requested <= 0) return COVERAGE_RECOVERY_LIMIT;
  return Math.min(requested, COVERAGE_RECOVERY_MAX_LIMIT);
}

async function recoverCoverageGapTx(tx, {
  tenantId,
  gap,
  actorUid,
}) {
  storedCoverageNotificationIntent(gap.metadata);
  const roles = Array.isArray(gap.metadata?.intended_roles) ? gap.metadata.intended_roles : [];
  const departments = Array.isArray(gap.metadata?.intended_departments)
    ? gap.metadata.intended_departments
    : [];
  const recipients = await resolveRecipients(tx, { tenantId, roles, departments });
  if (recipients.length === 0) return null;
  const completionActorUid = actorUid || recipients[0].uid;

  const queued = await queueRecoveredCoverageNotifications(tx, {
    tenantId,
    recipients,
    gap,
    actorUid: completionActorUid,
  });
  await completeTaskFromDomainEvidence({
    tenantId,
    id: Number(gap.id),
    evidenceKind: 'notification_coverage_restored',
    evidenceResourceType: 'notification_outbox',
    evidenceResourceId: String(queued[0].id),
    actorUid: completionActorUid,
    tx,
  });
  return Number(gap.id);
}

/**
 * Recreates durable, actionable notification coverage after roster recovery.
 * The task row is the claim: SKIP LOCKED makes concurrent ticks disjoint, and
 * task completion remains evidence-gated on the notification_outbox row.
 */
export async function sweepWardIndentNotificationCoverage({
  tenantId,
  actorUid = null,
  limit = COVERAGE_RECOVERY_LIMIT,
} = {}) {
  const tid = String(tenantId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tid)) {
    throw AppError.badRequest(
      'Ward medication notification recovery requires tenantId',
      'WARD_MEDICATION_COVERAGE_TENANT_REQUIRED',
    );
  }
  const boundedLimit = coverageRecoveryLimit(limit);
  const candidateIds = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT gap.id
       FROM tasks gap
       JOIN workflow_sla_instances sla
         ON sla.tenant_id = gap.tenant_id
        AND sla.id = gap.workflow_sla_instance_id
      WHERE gap.tenant_id = $1::uuid
        AND gap.metadata->>'task_contract' = 'ward_medication_obligation_v1'
        AND gap.metadata->>'obligation_kind' = 'notification_coverage'
        AND gap.status = ANY($2::text[])
        AND COALESCE(gap.metadata->>'notification_recovery_status', '') <> $3::text
        AND sla.rule_code = 'ward_indent_notification_coverage'
        AND sla.completed_at IS NULL
        AND sla.status = ANY($4::text[])
      ORDER BY gap.created_at ASC, gap.id ASC
      LIMIT $5::int`,
    tid,
    ACTIONABLE_TASK_STATUSES,
    COVERAGE_RECOVERY_MANUAL_HOLD,
    ['active', 'breached', 'escalated'],
    boundedLimit,
  ));

  const recoveredTaskIds = [];
  const heldTaskIds = [];
  let awaitingRecipients = 0;
  for (const candidateId of candidateIds) {
    const outcome = await setTenantTx(tid, async (tx) => {
      const candidates = await tx.$queryRawUnsafe(
        `SELECT gap.id, gap.metadata,
                indent.id AS indent_id,
                indent.indent_number,
                indent.patient_uid,
                indent.encounter_id,
                indent.status AS indent_status,
                indent.state_version AS indent_state_version
           FROM tasks gap
           JOIN workflow_sla_instances sla
             ON sla.tenant_id = gap.tenant_id
            AND sla.id = gap.workflow_sla_instance_id
           JOIN ward_indents indent
             ON indent.tenant_id = gap.tenant_id
            AND indent.id = CASE
                  WHEN gap.metadata->>'ward_indent_id' ~ '^[1-9][0-9]*$'
                    THEN (gap.metadata->>'ward_indent_id')::int
                  ELSE NULL
                END
          WHERE gap.tenant_id = $1::uuid
            AND gap.id = $2::int
            AND gap.metadata->>'task_contract' = 'ward_medication_obligation_v1'
            AND gap.metadata->>'obligation_kind' = 'notification_coverage'
            AND gap.status = ANY($3::text[])
            AND COALESCE(gap.metadata->>'notification_recovery_status', '') <> $4::text
            AND sla.rule_code = 'ward_indent_notification_coverage'
            AND sla.completed_at IS NULL
            AND sla.status = ANY($5::text[])
          FOR UPDATE OF gap SKIP LOCKED`,
        tid,
        Number(candidateId.id),
        ACTIONABLE_TASK_STATUSES,
        COVERAGE_RECOVERY_MANUAL_HOLD,
        ['active', 'breached', 'escalated'],
      );
      const candidate = candidates[0];
      if (!candidate) return { kind: 'skipped' };
      const gap = {
        id: candidate.id,
        metadata: candidate.metadata,
        indent: {
          id: Number(candidate.indent_id),
          indent_number: candidate.indent_number,
          tenant_id: tid,
          patient_uid: candidate.patient_uid,
          encounter_id: candidate.encounter_id,
          status: candidate.indent_status,
          state_version: Number(candidate.indent_state_version),
        },
      };
      try {
        const taskId = await recoverCoverageGapTx(tx, {
          tenantId: tid,
          gap,
          actorUid,
        });
        return taskId == null
          ? { kind: 'awaiting_recipients' }
          : { kind: 'recovered', taskId };
      } catch (error) {
        if (!isInvalidCoverageIntent(error)) throw error;
        const taskId = await holdInvalidCoverageIntentTx(tx, { tenantId: tid, gap });
        return { kind: 'held', taskId };
      }
    });
    if (outcome.kind === 'recovered') recoveredTaskIds.push(outcome.taskId);
    if (outcome.kind === 'held' && outcome.taskId != null) heldTaskIds.push(outcome.taskId);
    if (outcome.kind === 'awaiting_recipients') awaitingRecipients += 1;
  }
  return {
    scanned: candidateIds.length,
    recovered: recoveredTaskIds.length,
    held: heldTaskIds.length,
    awaitingRecipients,
    recoveredTaskIds,
    heldTaskIds,
    limit: boundedLimit,
  };
}

async function loadOpenCreditNoteTask(tx, tenantId, creditNoteId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, metadata, status, workflow_sla_instance_id
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND metadata->>'task_contract' = 'ward_medication_obligation_v1'
        AND metadata->>'obligation_kind' = 'credit_note_review'
        AND metadata->>'credit_note_id' = $2::text
        AND status = ANY($3::text[])
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    String(creditNoteId),
    ACTIONABLE_TASK_STATUSES,
  );
  return rows[0] || null;
}

export async function materializeBillingCreditNoteObligationTx(tx, {
  creditNote,
  actorUid,
  sourceEvent,
  notify = true,
}) {
  requiredTx(tx);
  if (!creditNote?.id || creditNote.status !== 'pending') return null;
  const tenantId = String(creditNote.tenant_id);
  const creditNoteId = String(creditNote.id);
  let task = await loadOpenCreditNoteTask(tx, tenantId, creditNoteId);
  if (!task) {
    const sourceId = creditNoteId;
    const sla = await startWorkflowSla({
      tenantId,
      ruleCode: 'ward_indent_credit_note_review',
      patientUid: creditNote.patient_uid,
      encounterId: creditNote.encounter_id || null,
      sourceTable: 'billing_credit_notes',
      sourceId,
      priority: 'high',
      assignedRoleCodes: BILLING_ROLES,
      metadata: {
        med_03: true,
        credit_note_id: creditNoteId,
        ward_indent_id: Number(creditNote.ward_indent_id),
        invoice_id: Number(creditNote.invoice_id),
      },
    }, { db: tx, strict: true });
    if (!sla?.id) {
      throw AppError.internal(
        'Ward medication credit-note SLA could not be materialized',
        'WARD_MEDICATION_CREDIT_NOTE_SLA_MISSING',
      );
    }
    task = await createWardMedicationObligationTaskTx({
      tenantId,
      taskKind: 'review',
      title: 'Review ward medication credit note',
      description: 'Approve or reject the append-only original-price medication credit before it can alter an issued patient account.',
      patientUid: creditNote.patient_uid,
      encounterId: creditNote.encounter_id || null,
      relatedResourceType: 'billing_credit_notes',
      relatedResourceId: sourceId,
      priority: 'high',
      assignedToRole: BILLING_ROLES[0],
      createdBy: actorUid,
      workflowSlaInstanceId: sla.id,
      stageOccurrenceKey: stageOccurrenceKey(tenantId, `credit-note:${sourceId}`),
      metadata: {
        med_03: true,
        sla_key: 'ward_indent_credit_note_review',
        obligation_kind: 'credit_note_review',
        evidence_kind: 'billing_credit_note_decision',
        credit_note_id: creditNoteId,
        ward_indent_id: Number(creditNote.ward_indent_id),
        ward_indent_item_id: Number(creditNote.ward_indent_item_id),
        invoice_id: Number(creditNote.invoice_id),
        source_financial_event_id: String(creditNote.source_financial_event_id),
        deep_link: `/billing/credit-notes/${creditNoteId}`,
      },
      tx,
    });
  }
  if (!task?.id) {
    throw AppError.internal(
      'Ward medication credit-note task could not be materialized',
      'WARD_MEDICATION_CREDIT_NOTE_TASK_MISSING',
    );
  }
  if (!notify) return task;

  const recipients = await resolveRecipients(tx, {
    tenantId,
    roles: BILLING_ROLES,
    departments: ['billing', 'finance'],
  });
  if (recipients.length === 0) {
    await createCoverageGap(tx, {
      indent: {
        id: Number(creditNote.ward_indent_id),
        indent_number: creditNote.indent_number || `#${creditNote.ward_indent_id}`,
        tenant_id: tenantId,
        patient_uid: creditNote.patient_uid,
        encounter_id: creditNote.encounter_id || null,
        status: creditNote.ward_indent_status || 'reconciliation_required',
        state_version: Number(creditNote.ward_indent_state_version || 1),
      },
      actorUid,
      event: {
        id: sourceEvent.id,
        ward_indent_id: Number(creditNote.ward_indent_id),
        state_version: Number(creditNote.ward_indent_state_version || 1),
      },
      presentation: {
        title: 'Ward medication credit note requires review',
        notificationKind: 'ward_indent_credit_note_review',
        departments: ['billing', 'finance'],
      },
      intendedRoles: BILLING_ROLES,
      notificationIntent: coverageNotificationIntent({
        taskId: task.id,
        type: 'ward_indent_credit_note_review',
        title: 'Ward medication credit note requires review',
        body: `Credit note ${creditNote.credit_note_number} requires a finance decision.`,
        sourceEventKey: `billing-credit-note:${creditNoteId}:raised`,
        templateVersion: 'ward_indent_credit_note_review.v1',
        data: {
          credit_note_id: creditNoteId,
          invoice_id: Number(creditNote.invoice_id),
          ward_indent_id: Number(creditNote.ward_indent_id),
          deep_link: `/billing/credit-notes/${creditNoteId}`,
          action_label_key: CREDIT_NOTE_NOTIFICATION_ACTION_LABEL_KEY,
        },
      }),
    });
    return task;
  }

  for (const recipient of recipients) {
    const outbox = await notificationOutbox.queue({
      tenantId,
      type: 'ward_indent_credit_note_review',
      channel: 'inapp',
      recipientId: recipient.id,
      recipientPhone: recipient.phone || null,
      title: 'Ward medication credit note requires review',
      body: `Credit note ${creditNote.credit_note_number} requires a finance decision.`,
      sourceEventKey: `billing-credit-note:${creditNoteId}:raised`,
      templateVersion: 'ward_indent_credit_note_review.v1',
      data: {
        kind: 'ward_indent_credit_note_review',
        task_id: Number(task.id),
        credit_note_id: creditNoteId,
        invoice_id: Number(creditNote.invoice_id),
        ward_indent_id: Number(creditNote.ward_indent_id),
        deep_link: `/billing/credit-notes/${creditNoteId}`,
        action_label_key: CREDIT_NOTE_NOTIFICATION_ACTION_LABEL_KEY,
      },
    }, { tx, strict: true });
    if (!outbox?.id) {
      throw AppError.internal(
        'Credit-note notification intent was not persisted',
        'WARD_MEDICATION_CREDIT_NOTE_NOTIFICATION_MISSING',
      );
    }
  }
  return task;
}

export async function completeBillingCreditNoteObligationTx(tx, {
  creditNote,
  lifecycleEvent,
  evidenceKind,
  actorUid,
}) {
  requiredTx(tx);
  if (!['billing_credit_note_decision', 'billing_credit_note_application'].includes(evidenceKind)) {
    throw AppError.internal(
      'Billing credit-note completion requires registered lifecycle evidence',
      'BILLING_CREDIT_NOTE_COMPLETION_EVIDENCE_INVALID',
    );
  }
  let task = await loadOpenCreditNoteTask(
    tx,
    String(creditNote.tenant_id),
    String(creditNote.id),
  );
  if (!task) {
    const raised = await tx.$queryRawUnsafe(
      `SELECT id
         FROM billing_credit_note_events
        WHERE tenant_id = $1::uuid
          AND credit_note_id = $2::bigint
          AND event_type = 'raised'
        ORDER BY id ASC
        LIMIT 1`,
      String(creditNote.tenant_id),
      BigInt(creditNote.id),
    );
    task = await materializeBillingCreditNoteObligationTx(tx, {
      creditNote: { ...creditNote, status: 'pending' },
      actorUid,
      sourceEvent: raised[0] || lifecycleEvent,
      notify: false,
    });
  }
  return completeTaskFromDomainEvidence({
    tenantId: String(creditNote.tenant_id),
    id: Number(task.id),
    evidenceKind,
    evidenceResourceType: 'billing_credit_note_event',
    evidenceResourceId: String(lifecycleEvent.id),
    actorUid,
    tx,
  });
}

export async function advanceBillingCreditNoteObligationTx(tx, {
  creditNote,
  approvalEvent,
  actorUid,
}) {
  requiredTx(tx);
  let task = await loadOpenCreditNoteTask(
    tx,
    String(creditNote.tenant_id),
    String(creditNote.id),
  );
  if (!task) {
    const raised = await tx.$queryRawUnsafe(
      `SELECT id
         FROM billing_credit_note_events
        WHERE tenant_id = $1::uuid
          AND credit_note_id = $2::bigint
          AND event_type = 'raised'
        ORDER BY id ASC
        LIMIT 1`,
      String(creditNote.tenant_id),
      BigInt(creditNote.id),
    );
    task = await materializeBillingCreditNoteObligationTx(tx, {
      creditNote: { ...creditNote, status: 'pending' },
      actorUid,
      sourceEvent: raised[0] || approvalEvent,
      notify: false,
    });
  }
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET title = 'Apply approved ward medication credit note',
            description = 'Apply the approved credit to the patient account and preserve any refund as a separately authorized payout obligation.',
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND status = ANY($4::text[])
      RETURNING id, metadata, status, workflow_sla_instance_id`,
    String(creditNote.tenant_id),
    Number(task.id),
    JSON.stringify({
      evidence_kind: 'billing_credit_note_application',
      credit_note_stage: 'approved',
      approval_event_id: String(approvalEvent.id),
    }),
    ACTIONABLE_TASK_STATUSES,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Credit-note review task changed before application ownership could be recorded',
      'BILLING_CREDIT_NOTE_TASK_STAGE_CONFLICT',
    );
  }
  await postTaskComment({
    tenantId: String(creditNote.tenant_id),
    taskId: Number(task.id),
    authorUid: actorUid,
    body: 'Credit note approved; the same SLA remains open until account application.',
    bodyKind: 'system_event',
    metadata: {
      credit_note_id: String(creditNote.id),
      approval_event_id: String(approvalEvent.id),
      next_stage: 'application',
    },
    tx,
  });
  return rows[0];
}

async function queueCreditNoteStageNotifications(tx, {
  creditNote,
  lifecycleEvent,
  task,
  roles,
  departments,
  notificationKind,
  title,
  body,
  sourceEventKey,
}) {
  const tenantId = String(creditNote.tenant_id);
  const recipients = await resolveRecipients(tx, { tenantId, roles, departments });
  if (recipients.length === 0) {
    const stateVersion = Number(
      creditNote.current_ward_indent_state_version
      || creditNote.ward_indent_state_version
      || 1,
    );
    await createCoverageGap(tx, {
      indent: {
        id: Number(creditNote.ward_indent_id),
        indent_number: creditNote.indent_number || `#${creditNote.ward_indent_id}`,
        tenant_id: tenantId,
        patient_uid: creditNote.patient_uid,
        encounter_id: creditNote.encounter_id || null,
        status: creditNote.ward_indent_status || 'reconciliation_required',
        state_version: stateVersion,
      },
      actorUid: String(lifecycleEvent.actor_uid),
      event: {
        id: lifecycleEvent.id,
        ward_indent_id: Number(creditNote.ward_indent_id),
        state_version: stateVersion,
      },
      presentation: { title, notificationKind, departments },
      intendedRoles: roles,
      notificationIntent: coverageNotificationIntent({
        taskId: task.id,
        type: notificationKind,
        title,
        body,
        sourceEventKey,
        templateVersion: `${notificationKind}.v1`,
        data: {
          credit_note_id: String(creditNote.id),
          refund_id: Number(creditNote.refund_id),
          invoice_id: Number(creditNote.invoice_id),
          ward_indent_id: Number(creditNote.ward_indent_id),
          deep_link: `/billing/credit-notes/${creditNote.id}`,
          action_label_key: CREDIT_NOTE_NOTIFICATION_ACTION_LABEL_KEY,
        },
      }),
    });
    return;
  }
  for (const recipient of recipients) {
    const outbox = await notificationOutbox.queue({
      tenantId,
      type: notificationKind,
      channel: 'inapp',
      recipientId: recipient.id,
      recipientPhone: recipient.phone || null,
      title,
      body,
      sourceEventKey,
      templateVersion: `${notificationKind}.v1`,
      data: {
        kind: notificationKind,
        task_id: Number(task.id),
        credit_note_id: String(creditNote.id),
        refund_id: Number(creditNote.refund_id),
        invoice_id: Number(creditNote.invoice_id),
        ward_indent_id: Number(creditNote.ward_indent_id),
        deep_link: `/billing/credit-notes/${creditNote.id}`,
        action_label_key: CREDIT_NOTE_NOTIFICATION_ACTION_LABEL_KEY,
      },
    }, { tx, strict: true });
    if (!outbox?.id) {
      throw AppError.internal(
        'Credit-note refund notification intent was not persisted',
        'BILLING_CREDIT_NOTE_REFUND_NOTIFICATION_MISSING',
      );
    }
  }
}

export async function advanceBillingCreditNoteRefundObligationTx(tx, {
  creditNote,
  applicationEvent,
  actorUid,
}) {
  requiredTx(tx);
  const refundId = Number(creditNote.refund_id);
  if (!Number.isSafeInteger(refundId) || refundId <= 0) {
    throw AppError.internal(
      'Credit-note refund ownership requires an exact refund',
      'BILLING_CREDIT_NOTE_REFUND_ID_MISSING',
    );
  }
  const task = await loadOpenCreditNoteTask(
    tx,
    String(creditNote.tenant_id),
    String(creditNote.id),
  );
  if (!task) {
    throw AppError.conflict(
      'Credit-note task was not actionable when refund ownership was created',
      'BILLING_CREDIT_NOTE_REFUND_TASK_MISSING',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET title = 'Authorize ward medication credit refund',
            description = 'Approve the patient refund obligation created by the applied medication credit; payout remains separately controlled.',
            assigned_to_uid = NULL,
            assigned_to_role = $3::text,
            metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND status = ANY($5::text[])
      RETURNING id, metadata, status, workflow_sla_instance_id`,
    String(creditNote.tenant_id),
    Number(task.id),
    REFUND_APPROVAL_ROLES[0],
    JSON.stringify({
      evidence_kind: 'billing_credit_note_refund_paid',
      credit_note_stage: 'refund_approval',
      application_event_id: String(applicationEvent.id),
      refund_id: refundId,
    }),
    ACTIONABLE_TASK_STATUSES,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Credit-note task changed before refund ownership could be recorded',
      'BILLING_CREDIT_NOTE_REFUND_TASK_STAGE_CONFLICT',
    );
  }
  await postTaskComment({
    tenantId: String(creditNote.tenant_id),
    taskId: Number(task.id),
    authorUid: actorUid,
    body: 'Credit application created a patient refund; the SLA remains open through authorized payout.',
    bodyKind: 'system_event',
    metadata: {
      credit_note_id: String(creditNote.id),
      refund_id: refundId,
      next_stage: 'refund_approval',
    },
    tx,
  });
  await queueCreditNoteStageNotifications(tx, {
    creditNote,
    lifecycleEvent: applicationEvent,
    task: rows[0],
    roles: REFUND_APPROVAL_ROLES,
    departments: ['administration', 'finance'],
    notificationKind: 'ward_indent_credit_note_refund_approval',
    title: 'Medication credit refund requires approval',
    body: `Refund #${refundId} for credit note ${creditNote.credit_note_number} requires approval.`,
    sourceEventKey: `billing-credit-note:${creditNote.id}:refund:${refundId}:approval`,
  });
  return rows[0];
}

export async function advanceBillingCreditNoteRefundPayoutObligationTx(tx, {
  creditNote,
  refund,
  actorUid,
}) {
  requiredTx(tx);
  const task = await loadOpenCreditNoteTask(
    tx,
    String(creditNote.tenant_id),
    String(creditNote.id),
  );
  if (!task) {
    throw AppError.conflict(
      'Credit-note refund task was not actionable at approval',
      'BILLING_CREDIT_NOTE_REFUND_TASK_MISSING',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET title = 'Settle approved ward medication credit refund',
            description = 'Complete the approved refund through its exact manual or provider payout rail and retain settlement evidence.',
            assigned_to_uid = NULL,
            assigned_to_role = $3::text,
            metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND status = ANY($5::text[])
      RETURNING id, metadata, status, workflow_sla_instance_id`,
    String(creditNote.tenant_id),
    Number(task.id),
    BILLING_ROLES[1],
    JSON.stringify({
      evidence_kind: 'billing_credit_note_refund_paid',
      credit_note_stage: 'refund_payout',
      refund_id: Number(refund.id),
      refund_approved_at: refund.approved_at,
    }),
    ACTIONABLE_TASK_STATUSES,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Credit-note refund task changed before payout ownership could be recorded',
      'BILLING_CREDIT_NOTE_REFUND_TASK_STAGE_CONFLICT',
    );
  }
  await postTaskComment({
    tenantId: String(creditNote.tenant_id),
    taskId: Number(task.id),
    authorUid: actorUid,
    body: 'Patient refund approved; the SLA remains open until exact payout evidence is recorded.',
    bodyKind: 'system_event',
    metadata: {
      credit_note_id: String(creditNote.id),
      refund_id: Number(refund.id),
      next_stage: 'refund_payout',
    },
    tx,
  });
  await queueCreditNoteStageNotifications(tx, {
    creditNote: { ...creditNote, refund_id: refund.id },
    lifecycleEvent: {
      id: refund.id,
      actor_uid: actorUid,
    },
    task: rows[0],
    roles: BILLING_ROLES,
    departments: ['billing', 'finance'],
    notificationKind: 'ward_indent_credit_note_refund_payout',
    title: 'Medication credit refund is ready for payout',
    body: `Approved refund #${refund.id} requires settlement evidence.`,
    sourceEventKey: `billing-credit-note:${creditNote.id}:refund:${refund.id}:payout`,
  });
  return rows[0];
}

export async function completeBillingCreditNoteRefundObligationTx(tx, {
  creditNote,
  refund,
  actorUid,
}) {
  requiredTx(tx);
  const task = await loadOpenCreditNoteTask(
    tx,
    String(creditNote.tenant_id),
    String(creditNote.id),
  );
  if (!task) {
    throw AppError.conflict(
      'Credit-note refund task was not actionable at payout',
      'BILLING_CREDIT_NOTE_REFUND_TASK_MISSING',
    );
  }
  return completeTaskFromDomainEvidence({
    tenantId: String(creditNote.tenant_id),
    id: Number(task.id),
    evidenceKind: 'billing_credit_note_refund_paid',
    evidenceResourceType: 'billing_refund',
    evidenceResourceId: String(refund.id),
    actorUid,
    tx,
  });
}

async function loadOpenMarSupplyTask(tx, tenantId, medicationAdministrationId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, metadata, status, workflow_sla_instance_id
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND metadata->>'task_contract' = 'ward_medication_obligation_v1'
        AND metadata->>'obligation_kind' = 'mar_supply_reconciliation'
        AND metadata->>'medication_administration_id' = $2::text
        AND status = ANY($3::text[])
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    String(medicationAdministrationId),
    ACTIONABLE_TASK_STATUSES,
  );
  return rows[0] || null;
}

export async function materializeMarSupplyReconciliationObligationTx(tx, {
  administration,
  wardItem,
  indent,
  actorUid,
  overrideReason,
}) {
  requiredTx(tx);
  if (!administration?.id || !wardItem?.id || !indent?.id) {
    throw AppError.internal(
      'MAR supply reconciliation requires administration and ward-indent context',
      'MAR_SUPPLY_RECONCILIATION_CONTEXT_REQUIRED',
    );
  }
  const tenantId = String(administration.tenant_id);
  const medicationAdministrationId = String(administration.id);
  let task = await loadOpenMarSupplyTask(tx, tenantId, medicationAdministrationId);
  if (!task) {
    const sla = await startWorkflowSla({
      tenantId,
      ruleCode: 'ward_indent_mar_supply_reconciliation',
      patientUid: administration.patient_uid,
      encounterId: indent.encounter_id || null,
      sourceTable: 'medication_administrations',
      sourceId: medicationAdministrationId,
      priority: 'critical',
      assignedRoleCodes: MAR_SUPPLY_RECONCILIATION_ROLES,
      metadata: {
        med_03: true,
        medication_administration_id: Number(administration.id),
        clinical_order_id: Number(administration.clinical_order_id),
        ward_indent_id: Number(indent.id),
        ward_indent_item_id: Number(wardItem.id),
      },
    }, { db: tx, strict: true });
    if (!sla?.id) {
      throw AppError.internal(
        'MAR supply reconciliation SLA could not be materialized',
        'MAR_SUPPLY_RECONCILIATION_SLA_MISSING',
      );
    }
    task = await createWardMedicationObligationTaskTx({
      tenantId,
      taskKind: 'review',
      title: 'Reconcile MAR administration with ward custody',
      description: 'Match the documented emergency or downtime administration to exact received ward stock without creating a second pharmacy movement.',
      patientUid: administration.patient_uid,
      encounterId: indent.encounter_id || null,
      relatedResourceType: 'medication_administrations',
      relatedResourceId: medicationAdministrationId,
      priority: 'critical',
      assignedToRole: MAR_SUPPLY_RECONCILIATION_ROLES[0],
      createdBy: actorUid,
      workflowSlaInstanceId: sla.id,
      stageOccurrenceKey: stageOccurrenceKey(
        tenantId,
        `mar-supply:${medicationAdministrationId}`,
      ),
      metadata: {
        med_03: true,
        sla_key: 'ward_indent_mar_supply_reconciliation',
        obligation_kind: 'mar_supply_reconciliation',
        evidence_kind: 'mar_supply_reconciled',
        medication_administration_id: Number(administration.id),
        clinical_order_id: Number(administration.clinical_order_id),
        ward_indent_id: Number(indent.id),
        ward_indent_item_id: Number(wardItem.id),
        override_reason: String(overrideReason).slice(0, 500),
        deep_link: `/clinical/mar/${administration.id}?supply-reconciliation=1`,
      },
      tx,
    });
  }
  if (!task?.id) {
    throw AppError.internal(
      'MAR supply reconciliation task could not be materialized',
      'MAR_SUPPLY_RECONCILIATION_TASK_MISSING',
    );
  }

  const recipients = await resolveRecipients(tx, {
    tenantId,
    roles: MAR_SUPPLY_RECONCILIATION_ROLES,
    departments: ['pharmacy', 'nursing'],
  });
  if (recipients.length === 0) {
    const events = await tx.$queryRawUnsafe(
      `SELECT id, ward_indent_id, state_version
         FROM ward_indent_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
        ORDER BY state_version DESC, id DESC
        LIMIT 1`,
      tenantId,
      Number(indent.id),
    );
    if (!events[0]) {
      throw AppError.internal(
        'MAR supply notification coverage requires ward-indent event evidence',
        'MAR_SUPPLY_NOTIFICATION_EVENT_MISSING',
      );
    }
    await createCoverageGap(tx, {
      indent,
      actorUid,
      event: events[0],
      presentation: {
        title: 'MAR supply reconciliation requires coverage',
        notificationKind: 'ward_indent_mar_supply_reconciliation',
        departments: ['pharmacy', 'nursing'],
      },
      intendedRoles: MAR_SUPPLY_RECONCILIATION_ROLES,
      notificationIntent: coverageNotificationIntent({
        taskId: task.id,
        type: 'ward_indent_mar_supply_reconciliation',
        title: 'MAR administration requires supply reconciliation',
        body: `Administration ${administration.id} must be matched to exact received ward stock.`,
        sourceEventKey: `mar-supply:${medicationAdministrationId}:unmatched`,
        templateVersion: 'ward_indent_mar_supply_reconciliation.v1',
        data: {
          medication_administration_id: Number(administration.id),
          clinical_order_id: Number(administration.clinical_order_id),
          ward_indent_id: Number(indent.id),
          ward_indent_item_id: Number(wardItem.id),
          deep_link: `/clinical/mar/${administration.id}?supply-reconciliation=1`,
        },
      }),
    });
    return task;
  }

  for (const recipient of recipients) {
    const outbox = await notificationOutbox.queue({
      tenantId,
      type: 'ward_indent_mar_supply_reconciliation',
      channel: 'inapp',
      recipientId: recipient.id,
      recipientPhone: recipient.phone || null,
      title: 'MAR administration requires supply reconciliation',
      body: `Administration ${administration.id} must be matched to exact received ward stock.`,
      sourceEventKey: `mar-supply:${medicationAdministrationId}:unmatched`,
      templateVersion: 'ward_indent_mar_supply_reconciliation.v1',
      data: {
        kind: 'ward_indent_mar_supply_reconciliation',
        task_id: Number(task.id),
        medication_administration_id: Number(administration.id),
        clinical_order_id: Number(administration.clinical_order_id),
        ward_indent_id: Number(indent.id),
        ward_indent_item_id: Number(wardItem.id),
        deep_link: `/clinical/mar/${administration.id}?supply-reconciliation=1`,
      },
    }, { tx, strict: true });
    if (!outbox?.id) {
      throw AppError.internal(
        'MAR supply reconciliation notification intent was not persisted',
        'MAR_SUPPLY_RECONCILIATION_NOTIFICATION_MISSING',
      );
    }
  }
  return task;
}

export async function completeMarSupplyReconciliationObligationTx(tx, {
  consumption,
  reconciliationLink,
  actorUid,
}) {
  requiredTx(tx);
  if (!consumption?.reconciliation_task_id || !reconciliationLink?.id) {
    throw AppError.internal(
      'MAR supply reconciliation completion requires task and link evidence',
      'MAR_SUPPLY_RECONCILIATION_EVIDENCE_REQUIRED',
    );
  }
  return completeTaskFromDomainEvidence({
    tenantId: String(consumption.tenant_id),
    id: Number(consumption.reconciliation_task_id),
    evidenceKind: 'mar_supply_reconciled',
    evidenceResourceType: 'mar_supply_reconciliation_link',
    evidenceResourceId: String(reconciliationLink.id),
    actorUid,
    tx,
  });
}

export default {
  completeWardIndentStateObligationTx,
  materializeWardIndentStateObligationTx,
  reconcileWardIndentNotificationCoverageTx,
  sweepWardIndentNotificationCoverage,
  materializeBillingCreditNoteObligationTx,
  advanceBillingCreditNoteObligationTx,
  advanceBillingCreditNoteRefundObligationTx,
  advanceBillingCreditNoteRefundPayoutObligationTx,
  completeBillingCreditNoteRefundObligationTx,
  completeBillingCreditNoteObligationTx,
  materializeMarSupplyReconciliationObligationTx,
  completeMarSupplyReconciliationObligationTx,
};
