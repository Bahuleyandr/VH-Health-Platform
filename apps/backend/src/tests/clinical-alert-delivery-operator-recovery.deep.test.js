import { createHash, randomUUID } from 'node:crypto';

import prisma, {
  ensureTenantRlsRuntimeRoleGrants,
  setTenantTx,
} from '../lib/prisma.js';
import {
  CLINICAL_ALERT_RECIPIENT_POLICY,
  CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS,
  escalateClinicalAlertRecoveryCases,
  listClinicalAlertRecoveryCases,
  persistClinicalAlertFailureWithCanonical,
  retryClinicalAlertRecoveryCase,
  supersedeClinicalAlertRecoveryCase,
  sweepClinicalAlertDeliveryObligations,
} from '../services/clinical/clinicalAlertDeliveryObligationService.js';
import {
  recordClinicalAuditEvent,
} from '../services/clinical/canonicalClinicalPlatformService.js';
import {
  acknowledgeTask,
  claimInboxTask,
  listInboxTasks,
  reassignTask,
  transitionTask,
} from '../services/workflow/taskService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const OTHER_PATIENT_UID = randomUUID();
const ORDERING_DOCTOR_UID = randomUUID();
const ADMIN_UID = randomUUID();
const SUPER_ADMIN_UID = randomUUID();
const SOFT_DELETED_ADMIN_UID = randomUUID();
const DUTY_DOCTOR_UID = randomUUID();
const SUFFIX = randomUUID().slice(0, 8);

function phone(lastDigit) {
  return `+91971${Date.now().toString().slice(-6)}${lastDigit}`;
}

async function tenantRows(sql, ...params) {
  return setTenantTx(TENANT_ID, (tx) => tx.$queryRawUnsafe(sql, ...params));
}

async function seedUser({
  uid, role, active = true, name, lastDigit, preferredLanguage = 'en',
}) {
  return prisma.$queryRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, role, is_active, tenant_id, preferred_language, updated_at)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::boolean, $6::uuid,
             $7::text, NOW())
     RETURNING id, uid::text, phone, role`,
    uid,
    phone(lastDigit),
    name,
    role,
    active,
    TENANT_ID,
    preferredLanguage,
  ).then((rows) => rows[0]);
}

async function createOrder(label) {
  return prisma.$queryRawUnsafe(
    `INSERT INTO clinical_orders
       (tenant_id, order_number, patient_uid, order_type, priority, details,
        status, ordered_by, start_date, updated_at)
     VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'routine',
             $4::jsonb, 'ordered', $5::uuid, NOW(), NOW())
     RETURNING id, order_number, encounter_id, patient_uid::text, order_type,
               priority, ordered_by::text`,
    TENANT_ID,
    `ORD-${label}-${SUFFIX}`,
    PATIENT_UID,
    JSON.stringify({ medication_name: `${label} Drug`, dose: '5 mg', route: 'PO' }),
    ORDERING_DOCTOR_UID,
  ).then((rows) => rows[0]);
}

function orderIntent(order, failureCode, supersedesObligationId = null) {
  const sourceEventKey = `clinical_orders:${order.id}:mar_schedule_failed:alert`
    + (supersedesObligationId == null ? '' : `:supersession:${supersedesObligationId}`);
  return {
    type: 'push',
    channel: 'push',
    title: 'Medication order has NO scheduled MAR doses',
    body: `MAR scheduling FAILED for medication order ${order.order_number} — no doses are on the drug chart. Open the order and use Repair MAR; if the schedule definition is invalid, discontinue it and place a corrected CPOE order.`,
    source_event_key: sourceEventKey,
    template_version: 'clinical-alert-order-integration-failure.v1',
    data: {
      source_event_key: sourceEventKey,
      order_id: Number(order.id),
      order_number: order.order_number,
      order_type: order.order_type,
      priority: order.priority,
      patient_uid: order.patient_uid,
      failure_stage: 'mar_schedule',
      error_code: failureCode,
      recovery_endpoint: `/api/v1/emr/orders/${order.id}/retry-mar-scheduling`,
      deep_link: `/emr/orders/${order.patient_uid}?mar_recovery_order=${order.id}`,
      requires_doctor_authority: true,
      ...(supersedesObligationId == null
        ? {}
        : { supersedes_obligation_id: String(supersedesObligationId) }),
    },
  };
}

async function createValidObligation(order, failureCode) {
  const persisted = await persistClinicalAlertFailureWithCanonical({
    tenantId: TENANT_ID,
    obligation: {
      sourceTable: 'clinical_orders',
      sourceId: String(order.id),
      failureKind: 'order_mar_schedule',
      patientUid: PATIENT_UID,
      encounterId: order.encounter_id,
      originActorUid: ORDERING_DOCTOR_UID,
      failureCode,
      recipientPolicy: CLINICAL_ALERT_RECIPIENT_POLICY,
      notificationIntent: orderIntent(order, failureCode),
    },
    recordCanonical: (tx, obligation) => recordClinicalAuditEvent({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      encounterId: order.encounter_id,
      action: 'mar_scheduling_failed',
      actionStatus: 'failed',
      actorUid: ORDERING_DOCTOR_UID,
      resourceType: 'clinical_order',
      resourceTable: 'clinical_orders',
      resourceId: String(order.id),
      metadata: {
        failure_stage: 'mar_schedule',
        alert_queued: false,
        alert_recovery_obligation_id: Number(obligation.id),
      },
      idempotencyKey: `clinical_orders:${order.id}:mar_schedule_failed`,
    }, { db: tx, strict: true }),
  });
  return persisted.obligation;
}

async function createOverdueRecipientCoverageCase(
  obligation,
  order,
  { establishEligibility = true } = {},
) {
  return setTenantTx(TENANT_ID, async (tx) => {
    if (establishEligibility) await tx.$executeRawUnsafe(
      `UPDATE clinical_alert_delivery_obligations
          SET attempt_count = attempt_count + 1,
              last_attempted_at = NOW() - INTERVAL '2 minutes',
              next_attempt_at = NOW() + INTERVAL '5 minutes',
              last_error_code = 'no_active_clinical_recipients'
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      TENANT_ID,
      obligation.id,
    );
    const caseRows = await tx.$queryRawUnsafe(
      `SELECT nextval('clinical_alert_delivery_recovery_cases_id_seq')::bigint AS id`,
    );
    const caseId = String(caseRows[0].id);
    const slaRows = await tx.$queryRawUnsafe(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_id, rule_code, patient_uid, encounter_id,
          source_table, source_id, status, priority, started_at, due_at,
          assigned_role_codes, metadata)
       SELECT $1::uuid, policy.id, policy.rule_code, $2::uuid, $3::uuid,
              'clinical_alert_delivery_recovery_cases', $4::text,
              'active', 'critical',
              date_trunc('milliseconds', NOW() - INTERVAL '2 minutes'),
              date_trunc('milliseconds', NOW() - INTERVAL '1 minute'),
              ARRAY['ADMIN']::text[],
              jsonb_build_object(
                'task_contract', 'clinical_alert_delivery_recovery_v1',
                'case_kind', 'recipient_coverage',
                'obligation_id', $5::text
              )
         FROM workflow_sla_rules policy
        WHERE policy.rule_code = 'clinical_alert_delivery_recipient_coverage'
          AND policy.enabled = TRUE
          AND (policy.tenant_id = $1::uuid OR policy.tenant_id IS NULL)
        ORDER BY (policy.tenant_id = $1::uuid) DESC
        LIMIT 1
       RETURNING id, due_at`,
      TENANT_ID,
      PATIENT_UID,
      order.encounter_id,
      caseId,
      String(obligation.id),
    );
    const sla = slaRows[0];
    const taskRows = await tx.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, description, patient_uid,
          related_resource_type, related_resource_id, priority, status,
          assigned_to_role, due_at, workflow_sla_instance_id,
          sla_completion_semantics, stage_occurrence_key, metadata)
       VALUES ($1::uuid, 'escalation',
               'Clinical alert has no deliverable clinical recipient',
               'Restore an eligible recipient and run the governed retry.',
               $2::uuid, 'clinical_alert_delivery_recovery_cases', $3::text,
               'critical', 'open', 'ADMIN', $4::timestamptz, $5::uuid,
               'domain_evidence', $6::text, $7::jsonb)
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      caseId,
      sla.due_at,
      sla.id,
      `clinical-alert-delivery-recovery:${caseId}`,
      JSON.stringify({
        task_contract: 'clinical_alert_delivery_recovery_v1',
        case_kind: 'recipient_coverage',
        obligation_id: String(obligation.id),
        assignment_origin: 'admin_coverage_queue',
        canonical_encounter_id: order.encounter_id == null
          ? null
          : String(order.encounter_id),
        action_path: `/api/v1/admin/clinical-alert-delivery/recovery-cases/${caseId}`,
        route: `/clinical-inbox/recovery?case_id=${caseId}`,
        deep_link: `/clinical-inbox/recovery?case_id=${caseId}`,
        action_label_key: 'clinical_inbox.open_workflow',
      }),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO clinical_alert_delivery_recovery_cases
         (id, tenant_id, obligation_id, case_kind, status,
          workflow_sla_instance_id, task_id, due_at)
       VALUES ($1::bigint, $2::uuid, $3::bigint, 'recipient_coverage', 'open',
               $4::uuid, $5::int, $6::timestamptz)`,
      caseId,
      TENANT_ID,
      obligation.id,
      sla.id,
      taskRows[0].id,
      sla.due_at,
    );
    return { caseId, taskId: taskRows[0].id, slaId: sla.id };
  });
}

describeIfDb('MED-03 governed clinical-alert operator recovery', () => {
  let previousRuntimeRole;

  beforeAll(async () => {
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_runtime';
    await ensureTenantRlsRuntimeRoleGrants();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, $3::text)`,
      TENANT_ID,
      `med03-alert-operator-${SUFFIX}`,
      `MED03 Alert Operator ${SUFFIX}`,
    );
    await seedUser({
      uid: PATIENT_UID,
      role: 'PATIENT',
      name: 'Operator Recovery Patient',
      lastDigit: 1,
    });
    await seedUser({
      uid: OTHER_PATIENT_UID,
      role: 'PATIENT',
      name: 'Operator Recovery Mismatch Patient',
      lastDigit: 7,
    });
    await seedUser({
      uid: ORDERING_DOCTOR_UID,
      role: 'DOCTOR',
      active: false,
      name: 'Inactive Ordering Doctor',
      lastDigit: 2,
    });
    await seedUser({
      uid: ADMIN_UID,
      role: 'ADMIN',
      name: 'Alert Recovery Administrator',
      lastDigit: 3,
      preferredLanguage: 'hi-IN',
    });
    await seedUser({
      uid: SUPER_ADMIN_UID,
      role: 'SUPER_ADMIN',
      name: 'Alert Recovery Super Administrator',
      lastDigit: 5,
      preferredLanguage: 'ml_IN',
    });
    await seedUser({
      uid: SOFT_DELETED_ADMIN_UID,
      role: 'ADMIN',
      name: 'Deleted Alert Recovery Administrator',
      lastDigit: 6,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET status = 'inactive',
              is_deleted = TRUE,
              deleted_at = NOW()
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid`,
      TENANT_ID,
      SOFT_DELETED_ADMIN_UID,
    );
  }, 30_000);

  afterAll(async () => {
    if (previousRuntimeRole === undefined) {
      delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    } else {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }
    await prisma.$disconnect().catch(() => {});
  });

  test('manual hold creates an actionable SLA/task and supersedes only from immutable source', async () => {
    const order = await createOrder('HOLD');
    const sourceEventKey = `clinical_orders:${order.id}:mar_schedule_failed:alert`;
    const obligation = await createValidObligation(order, 'SOURCE_MISMATCH_TEST');
    const originalId = obligation.id;
    await tenantRows(
      `UPDATE clinical_orders
          SET patient_uid = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      TENANT_ID,
      order.id,
      OTHER_PATIENT_UID,
    );

    const sweep = await sweepClinicalAlertDeliveryObligations({ tenantId: TENANT_ID });
    expect(sweep).toMatchObject({ held: 1, failed: 0 });

    const workbench = await listClinicalAlertRecoveryCases({
      tenantId: TENANT_ID,
      caseKind: 'manual_hold',
    });
    expect(workbench.count).toBe(1);
    expect(workbench.cases[0]).toMatchObject({
      case_kind: 'manual_hold',
      case_status: 'open',
      obligation_id: Number(originalId),
      obligation_status: 'manual_hold',
      sla_rule_code: 'clinical_alert_delivery_manual_hold_review',
      sla_status: 'active',
      task_status: 'open',
      assigned_to_role: 'ADMIN',
      overdue: false,
    });
    expect(workbench.cases[0].open_age_seconds).toBeGreaterThanOrEqual(0);
    expect(workbench.cases[0].due_at).toBeTruthy();

    await expect(reassignTask({
      tenantId: TENANT_ID,
      id: workbench.cases[0].task_id,
      assignedToRole: 'DOCTOR',
    })).rejects.toMatchObject({
      code: 'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    });

    await expect(transitionTask({
      tenantId: TENANT_ID,
      id: workbench.cases[0].task_id,
      nextStatus: 'blocked',
      actorUid: ADMIN_UID,
    })).rejects.toMatchObject({
      code: 'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    });

    await expect(setTenantTx(TENANT_ID, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO clinical_alert_delivery_recovery_cases
         (tenant_id, obligation_id, case_kind, status,
          workflow_sla_instance_id, task_id, due_at)
       SELECT tenant_id, obligation_id, 'recipient_coverage', 'open',
              workflow_sla_instance_id, task_id, due_at
         FROM clinical_alert_delivery_recovery_cases
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      TENANT_ID,
      workbench.cases[0].case_id,
    ))).rejects.toThrow(
      /clinical alert recovery|ux_alert_recovery_case|UniqueConstraintViolation/i,
    );

    await expect(prisma.$executeRawUnsafe(
      `UPDATE clinical_alert_delivery_recovery_cases
          SET task_id = task_id + 1
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      TENANT_ID,
      workbench.cases[0].case_id,
    )).rejects.toThrow(/clinical alert recovery case identity/i);

    await expect(prisma.$executeRawUnsafe(
      `DELETE FROM clinical_alert_delivery_recovery_cases
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      TENANT_ID,
      workbench.cases[0].case_id,
    )).rejects.toThrow(/clinical alert recovery cases are retained/i);

    await expect(setTenantTx(TENANT_ID, async (tx) => {
      const actionRows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_alert_delivery_recovery_actions
           (tenant_id, case_id, action_type, actor_uid, operator_reason,
            idempotency_key, command_sha256, outcome, response_payload)
         VALUES ($1::uuid, $2::bigint, 'retry_delivery', $3::uuid, $4::text,
                 $5::text, $6::char(64), 'recovered', '{}'::jsonb)
         RETURNING id`,
        TENANT_ID,
        workbench.cases[0].case_id,
        ADMIN_UID,
        'Direct case-only resolution must fail',
        `alert-case-only-resolution-${SUFFIX}`,
        createHash('sha256').update(`case-only:${SUFFIX}`).digest('hex'),
      );
      await tx.$executeRawUnsafe(
        `UPDATE clinical_alert_delivery_recovery_cases
            SET status = 'resolved',
                resolution_kind = 'recovered',
                resolution_action_id = $3::bigint,
                resolved_by_uid = $4::uuid,
                resolution_reason = $5::text,
                resolution_evidence = '{}'::jsonb,
                resolved_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        TENANT_ID,
        workbench.cases[0].case_id,
        actionRows[0].id,
        ADMIN_UID,
        'Direct case-only resolution must fail',
      );
    })).rejects.toThrow(
      /clinical alert recovery task, SLA, and case ownership|action does not match/i,
    );

    const protectedCases = await tenantRows(
      `SELECT COUNT(*)::integer AS count,
              MIN(recovery_case.status) AS case_status,
              MIN(task.status) AS task_status,
              MIN(sla.status) AS sla_status,
              COUNT(action.id)::integer AS action_count
         FROM clinical_alert_delivery_recovery_cases recovery_case
         JOIN tasks task
           ON task.tenant_id = recovery_case.tenant_id
          AND task.id = recovery_case.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = recovery_case.tenant_id
          AND sla.id = recovery_case.workflow_sla_instance_id
         LEFT JOIN clinical_alert_delivery_recovery_actions action
           ON action.tenant_id = recovery_case.tenant_id
          AND action.case_id = recovery_case.id
        WHERE recovery_case.tenant_id = $1::uuid
          AND recovery_case.task_id = $2::integer`,
      TENANT_ID,
      workbench.cases[0].task_id,
    );
    expect(protectedCases[0]).toEqual({
      count: 1,
      case_status: 'open',
      task_status: 'open',
      sla_status: 'active',
      action_count: 0,
    });

    const claimed = await claimInboxTask({
      tenantId: TENANT_ID,
      id: workbench.cases[0].task_id,
      actorUid: ADMIN_UID,
      actorRoles: ['ADMIN'],
      actorPrimaryRole: 'ADMIN',
      actorRawRole: 'ADMIN',
      idempotencyKey: `alert-recovery-admin-claim-${SUFFIX}`,
    });
    expect(claimed).toMatchObject({
      assigned_to_uid: ADMIN_UID,
      assigned_to_role: null,
      replayed: false,
    });

    await expect(tenantRows(
      `DELETE FROM task_comments
        WHERE tenant_id = $1::uuid
          AND task_id = $2::integer
          AND metadata->>'claim_receipt' = $3::text`,
      TENANT_ID,
      workbench.cases[0].task_id,
      claimed.metadata.role_claim_receipt,
    )).rejects.toThrow(/claim receipts are append-only/i);
    await expect(tenantRows(
      `UPDATE users
          SET is_active = FALSE,
              status = 'inactive',
              is_deleted = TRUE,
              deleted_at = NOW()
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid`,
      TENANT_ID,
      ADMIN_UID,
    )).rejects.toThrow(/assignee must remain an active administrator/i);

    await expect(transitionTask({
      tenantId: TENANT_ID,
      id: workbench.cases[0].task_id,
      nextStatus: 'in_progress',
      actorUid: ADMIN_UID,
    })).resolves.toMatchObject({ status: 'in_progress' });

    const acknowledgementBefore = (await tenantRows(
      `SELECT task.status,
              task.metadata,
              sla.status AS sla_status,
              sla.completed_at,
              COUNT(comment.id)::integer AS comment_count
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
         LEFT JOIN task_comments comment
           ON comment.tenant_id = task.tenant_id
          AND comment.task_id = task.id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::integer
        GROUP BY task.status, task.metadata, sla.status, sla.completed_at`,
      TENANT_ID,
      workbench.cases[0].task_id,
    ))[0];
    await expect(acknowledgeTask({
      tenantId: TENANT_ID,
      id: workbench.cases[0].task_id,
      actorUid: ADMIN_UID,
      actorRoles: ['ADMIN'],
      actorPrimaryRole: 'ADMIN',
      actorRawRole: 'ADMIN',
    })).rejects.toMatchObject({
      code: 'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    });
    const acknowledgementAfter = (await tenantRows(
      `SELECT task.status,
              task.metadata,
              sla.status AS sla_status,
              sla.completed_at,
              COUNT(comment.id)::integer AS comment_count
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
         LEFT JOIN task_comments comment
           ON comment.tenant_id = task.tenant_id
          AND comment.task_id = task.id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::integer
        GROUP BY task.status, task.metadata, sla.status, sla.completed_at`,
      TENANT_ID,
      workbench.cases[0].task_id,
    ))[0];
    expect(acknowledgementAfter).toEqual(acknowledgementBefore);

    await tenantRows(
      `UPDATE clinical_orders
          SET patient_uid = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      TENANT_ID,
      order.id,
      PATIENT_UID,
    );

    const arbitrary = orderIntent(order, 'SOURCE_MISMATCH_TEST', originalId);
    arbitrary.title = 'Arbitrary replacement clinical intent';
    await expect(tenantRows(
      `INSERT INTO clinical_alert_delivery_obligations
         (tenant_id, obligation_key, source_table, source_id, source_event_key,
          failure_kind, patient_uid, origin_actor_uid, failure_code,
          recipient_policy, notification_intent, supersedes_obligation_id)
       VALUES ($1::uuid, $2::char(64), 'clinical_orders', $3::text, $4::text,
               'order_mar_schedule', $5::uuid, $6::uuid, 'SOURCE_MISMATCH_TEST',
               $7::jsonb, $8::jsonb, $9::bigint)`,
      TENANT_ID,
      'f'.repeat(64),
      String(order.id),
      `${sourceEventKey}:supersession:${originalId}`,
      PATIENT_UID,
      ORDERING_DOCTOR_UID,
      JSON.stringify(CLINICAL_ALERT_RECIPIENT_POLICY),
      JSON.stringify(arbitrary),
      originalId,
    )).rejects.toThrow(/source-event contract|derived exactly|supersession/i);

    const reason = 'Reviewed the current medication order and approved a source-derived alert.';
    const command = {
      tenantId: TENANT_ID,
      caseId: workbench.cases[0].case_id,
      actorUid: ADMIN_UID,
      reason,
      idempotencyKey: `supersede-${SUFFIX}`,
    };
    const superseded = await supersedeClinicalAlertRecoveryCase({
      ...command,
      notificationIntent: { title: 'operator supplied text must be ignored' },
      recipientIds: [ADMIN_UID],
    });
    expect(superseded).toMatchObject({ outcome: 'superseded', replayed: false });

    const replay = await supersedeClinicalAlertRecoveryCase(command);
    expect(replay).toMatchObject({
      outcome: 'superseded',
      replayed: true,
      action_id: superseded.action_id,
      replacement_obligation_id: superseded.replacement_obligation_id,
    });
    await expect(supersedeClinicalAlertRecoveryCase({
      ...command,
      reason: 'A different clinical justification must not reuse the original command key.',
    })).rejects.toMatchObject({ code: 'CLINICAL_ALERT_RECOVERY_IDEMPOTENCY_MISMATCH' });

    const obligations = await tenantRows(
      `SELECT id, status, supersedes_obligation_id, notification_intent,
              manual_hold_code, held_at
         FROM clinical_alert_delivery_obligations
        WHERE tenant_id = $1::uuid
          AND (id = $2::bigint OR supersedes_obligation_id = $2::bigint)
        ORDER BY id`,
      TENANT_ID,
      originalId,
    );
    expect(obligations).toHaveLength(2);
    expect(obligations[0]).toMatchObject({
      id: originalId,
      status: 'manual_hold',
      supersedes_obligation_id: null,
      manual_hold_code: 'CLINICAL_ALERT_OBLIGATION_SOURCE_MISMATCH',
    });
    expect(obligations[0].held_at).toBeTruthy();
    expect(obligations[1]).toMatchObject({
      status: 'pending',
      supersedes_obligation_id: originalId,
      notification_intent: orderIntent(order, 'SOURCE_MISMATCH_TEST', originalId),
    });

    const resolved = await listClinicalAlertRecoveryCases({
      tenantId: TENANT_ID,
      status: 'resolved',
      caseKind: 'manual_hold',
    });
    expect(resolved.cases[0]).toMatchObject({
      resolution_kind: 'superseded',
      resolution_action_id: superseded.action_id,
      replacement_obligation_id: superseded.replacement_obligation_id,
      task_status: 'completed',
      sla_status: 'completed',
    });

    await expect(tenantRows(
      `UPDATE clinical_alert_delivery_obligations
          SET manual_hold_reason = 'mutated'
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      originalId,
    )).rejects.toThrow(/terminal/i);

    await expect(prisma.$queryRawUnsafe(
      `UPDATE clinical_alert_delivery_recovery_actions
          SET operator_reason = operator_reason
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      superseded.action_id,
    )).rejects.toThrow(/append-only/i);

    await tenantRows(
      `UPDATE clinical_alert_delivery_obligations
          SET next_attempt_at = NOW() + INTERVAL '1 hour'
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'pending'`,
      TENANT_ID,
      superseded.replacement_obligation_id,
    );

  });

  test('persistent no-recipient backlog stays actionable until an exact retry delivers', async () => {
    const order = await createOrder('RECIPIENT');
    const obligation = await createValidObligation(order, 'NO_RECIPIENT_TEST');

    const sweep = await sweepClinicalAlertDeliveryObligations({
      tenantId: TENANT_ID,
      deps: { resolveClinicalAlertRecipients: async () => [] },
    });
    expect(sweep).toMatchObject({ awaitingRecipients: 1, failed: 0 });

    let workbench = await listClinicalAlertRecoveryCases({
      tenantId: TENANT_ID,
      caseKind: 'recipient_coverage',
    });
    expect(workbench.cases[0]).toMatchObject({
      obligation_id: Number(obligation.id),
      case_status: 'open',
      obligation_status: 'pending',
      last_error_code: 'no_active_clinical_recipients',
      sla_rule_code: 'clinical_alert_delivery_recipient_coverage',
      task_status: 'open',
      assigned_to_role: 'ADMIN',
    });

    const unassignedBefore = (await tenantRows(
      `SELECT task.status,
              task.assigned_to_uid::text,
              task.assigned_to_role,
              task.metadata,
              sla.assigned_user_uid::text AS sla_assigned_user_uid,
              sla.assigned_role_codes,
              COUNT(comment.id)::integer AS comment_count
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
         LEFT JOIN task_comments comment
           ON comment.tenant_id = task.tenant_id
          AND comment.task_id = task.id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::integer
        GROUP BY task.status,
                 task.assigned_to_uid,
                 task.assigned_to_role,
                 task.metadata,
                 sla.assigned_user_uid,
                 sla.assigned_role_codes`,
      TENANT_ID,
      workbench.cases[0].task_id,
    ))[0];
    await expect(acknowledgeTask({
      tenantId: TENANT_ID,
      id: workbench.cases[0].task_id,
      actorUid: ADMIN_UID,
      actorRoles: ['ADMIN'],
      actorPrimaryRole: 'ADMIN',
      actorRawRole: 'ADMIN',
    })).rejects.toMatchObject({
      code: 'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    });
    await expect(tenantRows(
      `UPDATE tasks
          SET assigned_to_uid = $3::uuid,
              assigned_to_role = NULL
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      TENANT_ID,
      workbench.cases[0].task_id,
      ORDERING_DOCTOR_UID,
    )).rejects.toThrow(/clinical alert recovery/i);
    await expect(tenantRows(
      `UPDATE tasks
          SET status = 'blocked'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      TENANT_ID,
      workbench.cases[0].task_id,
    )).rejects.toThrow(/unroutable blocked state/i);
    await expect(tenantRows(
      `UPDATE tasks
          SET priority = 'low'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      TENANT_ID,
      workbench.cases[0].task_id,
    )).rejects.toThrow(/clinical alert recovery/i);
    await expect(tenantRows(
      `UPDATE workflow_sla_instances
          SET priority = 'low'
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      TENANT_ID,
      workbench.cases[0].workflow_sla_instance_id,
    )).rejects.toThrow(/clinical alert recovery/i);
    await expect(tenantRows(
      `UPDATE workflow_sla_instances
          SET assigned_user_uid = $3::uuid,
              assigned_role_codes = ARRAY[]::text[]
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      TENANT_ID,
      workbench.cases[0].workflow_sla_instance_id,
      ORDERING_DOCTOR_UID,
    )).rejects.toThrow(/clinical alert recovery/i);
    await expect(setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET assigned_to_uid = $3::uuid,
                assigned_to_role = NULL
          WHERE tenant_id = $1::uuid
            AND id = $2::integer`,
        TENANT_ID,
        workbench.cases[0].task_id,
        ADMIN_UID,
      );
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET assigned_user_uid = $3::uuid,
                assigned_role_codes = ARRAY[]::text[]
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid`,
        TENANT_ID,
        workbench.cases[0].workflow_sla_instance_id,
        ADMIN_UID,
      );
    })).rejects.toThrow(/clinical alert recovery/i);
    const unassignedAfter = (await tenantRows(
      `SELECT task.status,
              task.assigned_to_uid::text,
              task.assigned_to_role,
              task.metadata,
              sla.assigned_user_uid::text AS sla_assigned_user_uid,
              sla.assigned_role_codes,
              COUNT(comment.id)::integer AS comment_count
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
         LEFT JOIN task_comments comment
           ON comment.tenant_id = task.tenant_id
          AND comment.task_id = task.id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::integer
        GROUP BY task.status,
                 task.assigned_to_uid,
                 task.assigned_to_role,
                 task.metadata,
                 sla.assigned_user_uid,
                 sla.assigned_role_codes`,
      TENANT_ID,
      workbench.cases[0].task_id,
    ))[0];
    expect(unassignedAfter).toEqual(unassignedBefore);

    await expect(tenantRows(
      `UPDATE clinical_alert_delivery_obligations
          SET last_error_code = 'forged_recovery_condition'
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      TENANT_ID,
      obligation.id,
    )).rejects.toThrow(/recovery condition/i);

    const awaitingCommand = {
      tenantId: TENANT_ID,
      caseId: workbench.cases[0].case_id,
      actorUid: ADMIN_UID,
      reason: 'Confirmed the clinical roster is still missing an eligible alert recipient.',
      idempotencyKey: `retry-awaiting-${SUFFIX}`,
      deps: { resolveClinicalAlertRecipients: async () => [] },
    };
    const awaiting = await retryClinicalAlertRecoveryCase(awaitingCommand);
    expect(awaiting).toMatchObject({ outcome: 'awaiting_recipients', replayed: false });
    await expect(retryClinicalAlertRecoveryCase(awaitingCommand)).resolves.toMatchObject({
      outcome: 'awaiting_recipients',
      replayed: true,
      action_id: awaiting.action_id,
    });
    await expect(retryClinicalAlertRecoveryCase({
      ...awaitingCommand,
      reason: 'A changed reason cannot replay the original governed retry command.',
    })).rejects.toMatchObject({ code: 'CLINICAL_ALERT_RECOVERY_IDEMPOTENCY_MISMATCH' });

    await seedUser({
      uid: DUTY_DOCTOR_UID,
      role: 'DUTY_DOCTOR',
      name: 'Recovered Duty Doctor',
      lastDigit: 4,
    });
    const recovered = await retryClinicalAlertRecoveryCase({
      tenantId: TENANT_ID,
      caseId: workbench.cases[0].case_id,
      actorUid: ADMIN_UID,
      reason: 'Verified the active duty doctor roster and retried the immutable alert intent.',
      idempotencyKey: `retry-recovered-${SUFFIX}`,
    });
    expect(recovered).toMatchObject({ outcome: 'recovered', replayed: false });

    workbench = await listClinicalAlertRecoveryCases({
      tenantId: TENANT_ID,
      status: 'resolved',
      caseKind: 'recipient_coverage',
    });
    expect(workbench.cases[0]).toMatchObject({
      case_status: 'resolved',
      resolution_kind: 'recovered',
      obligation_status: 'completed',
      task_status: 'completed',
      sla_status: 'completed',
    });

    const actions = await tenantRows(
      `SELECT action_type, actor_uid::text, outcome, operator_reason
         FROM clinical_alert_delivery_recovery_actions
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint
        ORDER BY id`,
      TENANT_ID,
      workbench.cases[0].case_id,
    );
    expect(actions).toEqual([
      expect.objectContaining({
        action_type: 'retry_delivery',
        actor_uid: ADMIN_UID,
        outcome: 'awaiting_recipients',
      }),
      expect.objectContaining({
        action_type: 'retry_delivery',
        actor_uid: ADMIN_UID,
        outcome: 'recovered',
      }),
    ]);

    const outbox = await tenantRows(
      `SELECT recipient_id, source_event_key, title, body, payload
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT_ID,
      orderIntent(order, 'NO_RECIPIENT_TEST').source_event_key,
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      recipient_id: DUTY_DOCTOR_UID,
      source_event_key: orderIntent(order, 'NO_RECIPIENT_TEST').source_event_key,
      title: orderIntent(order, 'NO_RECIPIENT_TEST').title,
      body: orderIntent(order, 'NO_RECIPIENT_TEST').body,
    });
    expect(outbox[0].payload).toMatchObject({
      ...orderIntent(order, 'NO_RECIPIENT_TEST').data,
      recipient_role: 'DUTY_DOCTOR',
    });
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET is_active = FALSE,
              status = 'inactive'
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid`,
      TENANT_ID,
      DUTY_DOCTOR_UID,
    );
  });

  test('operator action receipts reject clinical staff outside ADMIN and SUPER_ADMIN', async () => {
    const order = await createOrder('ROLE');
    await createValidObligation(order, 'ROLE_GUARD_TEST');
    await sweepClinicalAlertDeliveryObligations({
      tenantId: TENANT_ID,
      deps: { resolveClinicalAlertRecipients: async () => [] },
    });
    const cases = await listClinicalAlertRecoveryCases({
      tenantId: TENANT_ID,
      caseKind: 'recipient_coverage',
    });

    const allowed = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_runtime');
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        TENANT_ID,
      );
      return tx.$queryRawUnsafe(
        `INSERT INTO clinical_alert_delivery_recovery_actions
           (tenant_id, case_id, action_type, actor_uid, operator_reason,
            idempotency_key, command_sha256, request_id, outcome,
            response_payload)
         VALUES ($1::uuid, $2::bigint, 'retry_delivery', $3::uuid,
                 'An administrator recorded this bounded runtime privilege probe.',
                 $4::text, $5::char(64), $6::text,
                  'awaiting_recipients', $7::jsonb)
         RETURNING id, created_at`,
        TENANT_ID,
        cases.cases[0].case_id,
        ADMIN_UID,
        `runtime-allowed-${SUFFIX}`,
        'b'.repeat(64),
        `runtime-allowed-${SUFFIX}`,
        JSON.stringify({
          case_id: cases.cases[0].case_id,
          obligation_id: cases.cases[0].obligation_id,
          outcome: 'awaiting_recipients',
        }),
      );
    });
    expect(allowed).toHaveLength(1);
    expect(allowed[0].created_at).toBeTruthy();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_runtime');
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_alert_delivery_recovery_actions
           (tenant_id, case_id, action_type, actor_uid, operator_reason,
            idempotency_key, command_sha256, outcome, response_payload, created_at)
         VALUES ($1::uuid, $2::bigint, 'retry_delivery', $3::uuid,
                 'A runtime caller must not choose the durable receipt timestamp.',
                 $4::text, $5::char(64), 'awaiting_recipients', '{}'::jsonb,
                 NOW() - INTERVAL '1 day')`,
        TENANT_ID,
        cases.cases[0].case_id,
        ADMIN_UID,
        `runtime-created-at-${SUFFIX}`,
        'c'.repeat(64),
      );
    })).rejects.toThrow(/permission denied/i);

    await expect(tenantRows(
      `INSERT INTO clinical_alert_delivery_recovery_actions
         (tenant_id, case_id, action_type, actor_uid, operator_reason,
          idempotency_key, command_sha256, outcome, response_payload)
       VALUES ($1::uuid, $2::bigint, 'retry_delivery', $3::uuid,
               'A doctor may not forge an operator recovery receipt.',
               $4::text, $5::char(64), 'awaiting_recipients', '{}'::jsonb)`,
      TENANT_ID,
      cases.cases[0].case_id,
      ORDERING_DOCTOR_UID,
      `forged-${SUFFIX}`,
      'a'.repeat(64),
    )).rejects.toThrow(/platform administrator/i);

    await expect(setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE users
            SET status = 'inactive',
                is_deleted = TRUE,
                deleted_at = NOW()
          WHERE tenant_id = $1::uuid
            AND uid = $2::uuid`,
        TENANT_ID,
        ADMIN_UID,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_alert_delivery_recovery_actions
           (tenant_id, case_id, action_type, actor_uid, operator_reason,
            idempotency_key, command_sha256, outcome, response_payload)
         VALUES ($1::uuid, $2::bigint, 'retry_delivery', $3::uuid,
                 'An inactive administrator cannot author a recovery receipt.',
                 $4::text, $5::char(64), 'awaiting_recipients', '{}'::jsonb)`,
        TENANT_ID,
        cases.cases[0].case_id,
        ADMIN_UID,
        `inactive-admin-${SUFFIX}`,
        'd'.repeat(64),
      );
    })).rejects.toThrow(/active platform administrator/i);
  });

  test('a valid obligation cannot be forged into a recipient-coverage queue', async () => {
    const order = await createOrder('FORGED-COVERAGE');
    const obligation = await createValidObligation(order, 'FORGED_COVERAGE_TEST');

    await expect(createOverdueRecipientCoverageCase(obligation, order, {
      establishEligibility: false,
    })).rejects.toThrow(
      /recovery condition|task, SLA, and case ownership|no matching pending obligation/i,
    );

    const recoveryRows = await tenantRows(
      `SELECT COUNT(*)::integer AS count
         FROM clinical_alert_delivery_recovery_cases
        WHERE tenant_id = $1::uuid
          AND obligation_id = $2::bigint`,
      TENANT_ID,
      obligation.id,
    );
    expect(recoveryRows[0].count).toBe(0);

    const superAdminInbox = await listInboxTasks({
      tenantId: TENANT_ID,
      assigneeUid: SUPER_ADMIN_UID,
      roles: ['SUPER_ADMIN'],
      primaryRole: 'SUPER_ADMIN',
      rawRole: 'SUPER_ADMIN',
    });
    const openCases = await listClinicalAlertRecoveryCases({
      tenantId: TENANT_ID,
      status: 'open',
    });
    const openTaskIds = new Set(openCases.cases.map((row) => Number(row.task_id)));
    expect(superAdminInbox.tasks.some((task) => (
      task.metadata?.task_contract === 'clinical_alert_delivery_recovery_v1'
      && openTaskIds.has(Number(task.id))
    ))).toBe(true);
  });

  test('overdue recovery escalates exactly once to ADMIN and SUPER_ADMIN', async () => {
    const order = await createOrder('ESCALATION');
    const obligation = await createValidObligation(order, 'ESCALATION_TEST');
    const overdue = await createOverdueRecipientCoverageCase(obligation, order);

    await expect(escalateClinicalAlertRecoveryCases({
      tenantId: TENANT_ID,
    })).resolves.toEqual({
      scanned: 1,
      escalated: 1,
      awaitingAdmin: 0,
      failed: 0,
    });
    await expect(escalateClinicalAlertRecoveryCases({
      tenantId: TENANT_ID,
    })).resolves.toEqual({
      scanned: 0,
      escalated: 0,
      awaitingAdmin: 0,
      failed: 0,
    });

    const workbench = await listClinicalAlertRecoveryCases({
      tenantId: TENANT_ID,
      caseId: overdue.caseId,
    });
    expect(workbench.cases[0]).toMatchObject({
      case_id: Number(overdue.caseId),
      case_kind: 'recipient_coverage',
      case_status: 'open',
      overdue: true,
      escalation_attempt_count: 1,
      task_id: overdue.taskId,
      task_status: 'overdue',
      sla_status: 'escalated',
    });
    expect(workbench.cases[0].escalated_at).toBeTruthy();
    expect(workbench.cases[0].sla_escalated_at).toBeTruthy();

    const outbox = await tenantRows(
      `SELECT recipient_id, source_event_key, template_version, title, body, payload
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND source_event_key LIKE $2::text
        ORDER BY recipient_id`,
      TENANT_ID,
      `clinical-alert-recovery-case:${overdue.caseId}:overdue:%`,
    );
    expect(outbox).toHaveLength(2);
    expect(outbox.map((row) => row.recipient_id).sort()).toEqual(
      [ADMIN_UID, SUPER_ADMIN_UID].sort(),
    );
    expect(outbox.map((row) => row.recipient_id)).not.toContain(SOFT_DELETED_ADMIN_UID);
    for (const row of outbox) {
      const locale = row.recipient_id === ADMIN_UID ? 'hi' : 'ml';
      const presentation = CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS[locale];
      expect(row).toMatchObject({
        template_version: 'clinical-alert-delivery-recovery-escalation.v1',
        title: presentation.title,
        body: presentation.recipientCoverageBody,
        payload: {
          recovery_case_id: Number(overdue.caseId),
          obligation_id: Number(obligation.id),
          case_kind: 'recipient_coverage',
          route: `/clinical-inbox/recovery?case_id=${overdue.caseId}`,
          deep_link: `/clinical-inbox/recovery?case_id=${overdue.caseId}`,
          action_label_key: 'clinical_inbox.open_workflow',
          presentation_key: 'clinical_alert_delivery_recovery_overdue',
          presentation_locale: locale,
          presentation_copy_version:
            'clinical-alert-delivery-recovery-escalation.v1',
          presentations: CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS,
        },
      });
      expect(['ADMIN', 'SUPER_ADMIN']).toContain(row.payload.recipient_role);
    }
  });
});
