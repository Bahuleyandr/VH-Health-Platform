import { createHash } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { startWorkflowSla } from '../clinical/canonicalClinicalPlatformService.js';
import {
  completeTaskFromDomainEvidence,
  createWardMedicationObligationTaskTx,
  postTaskComment,
} from '../workflow/taskService.js';

const RECIPIENT_LIMIT = 12;
const COVERAGE_ROLES = ['ADMIN', 'SUPER_ADMIN'];
const BILLING_ROLES = ['BILLING_INCHARGE', 'FINANCE_INCHARGE'];
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
  return `/pharmacy/ward-indents/${indentId}`;
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

async function createCoverageGap(tx, {
  indent,
  actorUid,
  event,
  presentation,
  intendedRoles,
}) {
  const tenantId = String(indent.tenant_id);
  const coverageSourceId = `ward-indent-coverage:${indent.id}:v${indent.state_version}:${event.id}`;
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
      intended_notification_kind: presentation.notificationKind,
      deep_link: deepLink(indent.id),
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
      ORDER BY created_at ASC, id ASC
      LIMIT $4::int
      FOR UPDATE SKIP LOCKED`,
    tenantId,
    String(indent.id),
    ACTIONABLE_TASK_STATUSES,
    Math.min(Math.max(Number(limit) || 20, 1), 100),
  );
  const completed = [];
  for (const gap of gaps) {
    const roles = Array.isArray(gap.metadata?.intended_roles) ? gap.metadata.intended_roles : [];
    const recipients = await resolveRecipients(tx, { tenantId, roles });
    if (recipients.length === 0) continue;
    const presentation = {
      title: 'Ward medication notification coverage restored',
      notificationKind: 'ward_indent_notification_coverage_restored',
    };
    const queued = await queueRecipientNotifications(tx, {
      tenantId,
      recipients,
      task: gap,
      indent,
      event: {
        ward_indent_id: indent.id,
        state_version: indent.state_version,
      },
      presentation,
      sourceEventKey: `ward-indent-coverage-restored:${gap.id}`,
      coverageTaskId: gap.id,
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
      },
      intendedRoles: BILLING_ROLES,
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
  decisionEvent,
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
      sourceEvent: raised[0] || decisionEvent,
      notify: false,
    });
  }
  return completeTaskFromDomainEvidence({
    tenantId: String(creditNote.tenant_id),
    id: Number(task.id),
    evidenceKind: 'billing_credit_note_decision',
    evidenceResourceType: 'billing_credit_note_event',
    evidenceResourceId: String(decisionEvent.id),
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
        LIMIT 1
        FOR SHARE`,
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
      },
      intendedRoles: MAR_SUPPLY_RECONCILIATION_ROLES,
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
  materializeBillingCreditNoteObligationTx,
  completeBillingCreditNoteObligationTx,
  materializeMarSupplyReconciliationObligationTx,
  completeMarSupplyReconciliationObligationTx,
};
