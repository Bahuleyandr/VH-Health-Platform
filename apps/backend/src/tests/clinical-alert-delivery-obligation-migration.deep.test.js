import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

import prisma, {
  ensureTenantRlsRuntimeRoleGrants,
} from '../lib/prisma.js';
import {
  CLINICAL_ALERT_RECIPIENT_POLICY,
  persistClinicalAlertFailureWithCanonical,
} from '../services/clinical/clinicalAlertDeliveryObligationService.js';
import {
  recordClinicalAuditEvent,
} from '../services/clinical/canonicalClinicalPlatformService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migration = readFileSync(
  new URL('../migrations/745_clinical_alert_delivery_obligations.sql', import.meta.url),
  'utf8',
);
const runtimeBootstrap = readFileSync(
  new URL('../../../../infra/kubernetes/overlays/dalekdefender/rls-runtime-role.sql', import.meta.url),
  'utf8',
);
const prismaSource = readFileSync(new URL('../lib/prisma.js', import.meta.url), 'utf8');

function orderIntent(order, failureCode) {
  const sourceEventKey = `clinical_orders:${order.id}:mar_schedule_failed:alert`;
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
    },
  };
}

function obligationKey(tenantId, sourceEventKey) {
  return createHash('sha256')
    .update(`${tenantId}:${sourceEventKey}`, 'utf8')
    .digest('hex');
}

function canonicalAuditInput({ tenantId, order, failureCode, obligationId }) {
  return {
    tenantId,
    patientUid: order.patient_uid,
    encounterId: order.encounter_id,
    action: 'mar_scheduling_failed',
    actionStatus: 'failed',
    actorUid: order.ordered_by,
    resourceType: 'clinical_order',
    resourceTable: 'clinical_orders',
    resourceId: String(order.id),
    metadata: {
      failure_stage: 'mar_schedule',
      error_code: failureCode,
      alert_queued: false,
      alert_recovery_obligation_id: Number(obligationId),
    },
    idempotencyKey: `clinical_orders:${order.id}:mar_schedule_failed`,
  };
}

describe('migration 745 clinical alert delivery obligation contract', () => {
  test('is isolated from migration 744 and carries the recovery backstops', () => {
    expect(migration).toContain('BEGIN;');
    expect(migration).toContain('COMMIT;');
    expect(migration).toContain('CREATE TABLE public.clinical_alert_delivery_obligations');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('AS RESTRICTIVE');
    expect(migration).toContain('completion lacks exact outbox evidence');
    expect(migration).toContain("status IN ('pending', 'completed', 'manual_hold')");
  });

  test('version 1 pins the exact recipient policy used by replay', () => {
    expect(CLINICAL_ALERT_RECIPIENT_POLICY).toEqual({
      version: 1,
      strategy: 'duty_doctor_then_doctor_tiers',
      primary_role: 'DUTY_DOCTOR',
      fallback_roles: [
        'DOCTOR',
        'DUTY_DOCTOR',
        'CONSULTANT',
        'JUNIOR_DOCTOR',
        'RESIDENT',
      ],
    });
  });

  test('preserves the exact MAR exception task trigger introduced by 744', () => {
    expect(migration).toMatch(
      /trg_tasks_workflow_sla_compat_insert[\s\S]*?'ward_medication_obligation_v1',[\s\S]*?'mar_medication_exception_v1',[\s\S]*?'clinical_alert_delivery_recovery_v1'/,
    );
    expect(migration).toMatch(
      /trg_tasks_workflow_sla_compat_update[\s\S]*?'ward_medication_obligation_v1',[\s\S]*?'mar_medication_exception_v1',[\s\S]*?'clinical_alert_delivery_recovery_v1'/,
    );
    expect(migration).not.toContain(
      'DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_mar_exception',
    );
    expect(migration).toContain(
      'care_pathway_assert_task_sla_source_binding_pre_745',
    );
    expect(migration).toContain(
      'care_pathway_assert_task_sla_completion_receipt_pre_745',
    );
  });

  test.each([
    ['startup grant fence', prismaSource],
    ['DalekDefender grant fence', runtimeBootstrap],
  ])('%s re-narrows the table and guard function after broad grants', (_label, source) => {
    expect(source).toContain("'clinical_alert_delivery_obligations'");
    expect(source).toContain("'clinical_alert_delivery_obligation_guard'");
    expect(source).toContain("'GRANT INSERT (");
    expect(source).toContain('recipient_policy, notification_intent');
    expect(source).toContain("'GRANT UPDATE (");
    expect(source).toContain('completion_evidence, completed_at, manual_hold_code');
    expect(source).toContain("'GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I'");

    const appendOnlyRelations = source.match(
      /(?:med03_)?append_only_relations CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\];/,
    );
    expect(appendOnlyRelations?.[1]).not.toContain(
      "'clinical_alert_delivery_recovery_actions'",
    );
    const recoveryActionGrant = source.match(
      /to_regclass\('public\.clinical_alert_delivery_recovery_actions'\)[\s\S]*?END IF;/,
    );
    expect(recoveryActionGrant?.[0]).toContain(
      'tenant_id, case_id, action_type, actor_uid, operator_reason',
    );
    expect(recoveryActionGrant?.[0]).toContain(
      'idempotency_key, command_sha256, request_id, outcome, response_payload',
    );
    expect(recoveryActionGrant?.[0]).not.toContain('created_at');
  });
});

describeIfDb('migration 745 runtime ACL and explicit tenant RLS', () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const patientUid = randomUUID();
  const doctorUid = randomUUID();
  let sourceEventKey;
  let runtimeOrder;
  let previousRuntimeRole;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'Migration 745 RLS')`,
      tenantId,
      `migration-745-${tenantId.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'Migration 745 Other RLS')`,
      otherTenantId,
      `migration-745-other-${otherTenantId.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2::text, 'Migration 745 Patient', 'PATIENT', TRUE,
               $3::uuid, NOW()),
              ($4::uuid, $5::text, 'Migration 745 Doctor', 'DOCTOR', TRUE,
               $3::uuid, NOW())`,
      patientUid,
      `+91981${Date.now().toString().slice(-7)}`,
      tenantId,
      doctorUid,
      `+91982${Date.now().toString().slice(-7)}`,
    );
    const orders = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, priority, details,
          status, ordered_by, start_date, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'routine',
               '{}'::jsonb, 'ordered', $4::uuid, NOW(), NOW()),
              ($1::uuid, $5::text, $3::uuid, 'medication', 'routine',
               '{}'::jsonb, 'ordered', $4::uuid, NOW(), NOW())
       RETURNING id, order_number, patient_uid::text, encounter_id::text,
                 order_type, priority, ordered_by::text`,
      tenantId,
      `M745-RLS-${tenantId.slice(0, 8)}`,
      patientUid,
      doctorUid,
      `M745-RUNTIME-${tenantId.slice(0, 8)}`,
    );
    const initialOrder = orders[0];
    runtimeOrder = orders[1];
    sourceEventKey = `clinical_orders:${initialOrder.id}:mar_schedule_failed:alert`;
    await persistClinicalAlertFailureWithCanonical({
      tenantId,
      obligation: {
        sourceTable: 'clinical_orders',
        sourceId: String(initialOrder.id),
        failureKind: 'order_mar_schedule',
        patientUid,
        encounterId: initialOrder.encounter_id,
        originActorUid: doctorUid,
        failureCode: 'MIGRATION_TEST',
        recipientPolicy: CLINICAL_ALERT_RECIPIENT_POLICY,
        notificationIntent: orderIntent(initialOrder, 'MIGRATION_TEST'),
      },
      recordCanonical: (tx, obligation) => recordClinicalAuditEvent(
        canonicalAuditInput({
          tenantId,
          order: initialOrder,
          failureCode: 'MIGRATION_TEST',
          obligationId: obligation.id,
        }),
        { db: tx, strict: true },
      ),
    });
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    for (const role of ['vhhealth_app', 'vhhealth_runtime']) {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role;
      await ensureTenantRlsRuntimeRoleGrants();
    }
  }, 30_000);

  afterAll(async () => {
    if (previousRuntimeRole === undefined) {
      delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    } else {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }
    await prisma.$disconnect().catch(() => {});
  });

  test.each(['vhhealth_app', 'vhhealth_runtime'])(
    '%s has only the mutation privileges recovery needs',
    async (role) => {
      const rows = await prisma.$queryRawUnsafe(
      `SELECT has_table_privilege($1::name, $2::text, 'SELECT') AS can_select,
              has_table_privilege($1::name, $2::text, 'INSERT') AS can_insert_table,
              has_table_privilege($1::name, $2::text, 'UPDATE') AS can_update_table,
              has_column_privilege(
                $1::name, $2::text, 'notification_intent', 'INSERT'
              ) AS can_insert_intent,
              has_column_privilege(
                $1::name, $2::text, 'status', 'INSERT'
              ) AS can_insert_status,
              has_column_privilege(
                $1::name, $2::text, 'status', 'UPDATE'
              ) AS can_update_status,
              has_column_privilege(
                $1::name, $2::text, 'notification_intent', 'UPDATE'
              ) AS can_update_intent,
              has_table_privilege($1::name, $2::text, 'DELETE') AS can_delete,
              has_table_privilege($1::name, $2::text, 'TRUNCATE') AS can_truncate,
              has_sequence_privilege($1::name, $3::text, 'USAGE') AS can_use_sequence,
              has_sequence_privilege($1::name, $3::text, 'UPDATE') AS can_set_sequence,
              has_function_privilege(
                $1::name,
                'public.clinical_alert_delivery_obligation_guard()',
                'EXECUTE'
              ) AS can_execute_guard`,
        role,
        'public.clinical_alert_delivery_obligations',
        'public.clinical_alert_delivery_obligations_id_seq',
      );
      expect(rows[0]).toEqual({
        can_select: true,
        can_insert_table: false,
        can_update_table: false,
        can_insert_intent: true,
        can_insert_status: false,
        can_update_status: true,
        can_update_intent: false,
        can_delete: false,
        can_truncate: false,
        can_use_sequence: true,
        can_set_sequence: false,
        can_execute_guard: false,
      });
    },
  );

  test.each(['vhhealth_app', 'vhhealth_runtime'])(
    '%s recovery case and action privileges remain column/table bounded',
    async (role) => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT
           has_table_privilege($1::name, 'public.clinical_alert_delivery_recovery_cases', 'SELECT')
             AS can_select_cases,
           has_table_privilege($1::name, 'public.clinical_alert_delivery_recovery_cases', 'INSERT')
             AS can_insert_cases_table,
           has_table_privilege($1::name, 'public.clinical_alert_delivery_recovery_cases', 'UPDATE')
             AS can_update_cases_table,
           has_column_privilege($1::name, 'public.clinical_alert_delivery_recovery_cases', 'id', 'INSERT')
             AS can_insert_case_id,
           has_column_privilege($1::name, 'public.clinical_alert_delivery_recovery_cases', 'obligation_id', 'UPDATE')
             AS can_update_case_identity,
           has_column_privilege($1::name, 'public.clinical_alert_delivery_recovery_cases', 'resolution_action_id', 'UPDATE')
             AS can_update_case_resolution,
           has_table_privilege($1::name, 'public.clinical_alert_delivery_recovery_cases', 'DELETE')
             AS can_delete_cases,
           has_table_privilege($1::name, 'public.clinical_alert_delivery_recovery_actions', 'SELECT')
             AS can_select_actions,
           has_table_privilege($1::name, 'public.clinical_alert_delivery_recovery_actions', 'INSERT')
             AS can_insert_actions_table,
           has_column_privilege($1::name, 'public.clinical_alert_delivery_recovery_actions', 'action_type', 'INSERT')
             AS can_insert_action_type,
           has_column_privilege($1::name, 'public.clinical_alert_delivery_recovery_actions', 'created_at', 'INSERT')
             AS can_insert_action_created_at,
           has_table_privilege($1::name, 'public.clinical_alert_delivery_recovery_actions', 'UPDATE')
             AS can_update_actions,
           has_table_privilege($1::name, 'public.clinical_alert_delivery_recovery_actions', 'DELETE')
             AS can_delete_actions,
           has_sequence_privilege($1::name, 'public.clinical_alert_delivery_recovery_cases_id_seq', 'USAGE')
             AS can_use_case_sequence,
           has_sequence_privilege($1::name, 'public.clinical_alert_delivery_recovery_cases_id_seq', 'UPDATE')
             AS can_set_case_sequence,
           has_function_privilege($1::name, 'public.clinical_alert_delivery_recovery_case_guard()', 'EXECUTE')
             AS can_execute_case_guard,
           has_function_privilege($1::name, 'public.clinical_alert_delivery_recovery_action_guard()', 'EXECUTE')
             AS can_execute_action_guard`,
        role,
      );
      expect(rows[0]).toEqual({
        can_select_cases: true,
        can_insert_cases_table: false,
        can_update_cases_table: false,
        can_insert_case_id: true,
        can_update_case_identity: false,
        can_update_case_resolution: true,
        can_delete_cases: false,
        can_select_actions: true,
        can_insert_actions_table: false,
        can_insert_action_type: true,
        can_insert_action_created_at: false,
        can_update_actions: false,
        can_delete_actions: false,
        can_use_case_sequence: true,
        can_set_case_sequence: false,
        can_execute_case_guard: false,
        can_execute_action_guard: false,
      });
    },
  );

  test('runtime role can create and advance only the governed pending shape', async () => {
    const runtimeSourceEventKey =
      `clinical_orders:${runtimeOrder.id}:mar_schedule_failed:alert`;
    const failureCode = 'RUNTIME_ACL_TEST';
    const notificationIntent = orderIntent(runtimeOrder, failureCode);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_runtime');
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        tenantId,
      );
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_alert_delivery_obligations
           (tenant_id, obligation_key, source_table, source_id, source_event_key,
            failure_kind, patient_uid, encounter_id, origin_actor_uid,
            failure_code, recipient_policy, notification_intent)
         VALUES ($1::uuid, $2::char(64), 'clinical_orders', $3::text, $4::text,
                 'order_mar_schedule', $5::uuid, $6::uuid, $7::uuid,
                 $8::text, $9::jsonb, $10::jsonb)
         RETURNING id`,
        tenantId,
        obligationKey(tenantId, runtimeSourceEventKey),
        String(runtimeOrder.id),
        runtimeSourceEventKey,
        patientUid,
        runtimeOrder.encounter_id,
        doctorUid,
        failureCode,
        JSON.stringify(CLINICAL_ALERT_RECIPIENT_POLICY),
        JSON.stringify(notificationIntent),
      );
      expect(inserted).toHaveLength(1);
      const audit = canonicalAuditInput({
        tenantId,
        order: runtimeOrder,
        failureCode,
        obligationId: inserted[0].id,
      });
      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_audit_events
           (tenant_id, patient_uid, encounter_id, action, action_status,
            actor_uid, resource_type, resource_table, resource_id, metadata,
            idempotency_key)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
                 $6::uuid, $7::text, $8::text, $9::text, $10::jsonb,
                 $11::text)`,
        tenantId,
        audit.patientUid,
        audit.encounterId,
        audit.action,
        audit.actionStatus,
        audit.actorUid,
        audit.resourceType,
        audit.resourceTable,
        audit.resourceId,
        JSON.stringify(audit.metadata),
        audit.idempotencyKey,
      );
      const advanced = await tx.$queryRawUnsafe(
        `UPDATE clinical_alert_delivery_obligations
            SET attempt_count = attempt_count + 1,
                last_attempted_at = NOW(),
                next_attempt_at = NOW() + INTERVAL '5 minutes',
                last_error_code = 'runtime_acl_probe'
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
          RETURNING attempt_count, last_error_code`,
        tenantId,
        inserted[0].id,
      );
      expect(advanced[0]).toMatchObject({
        attempt_count: 1,
        last_error_code: 'runtime_acl_probe',
      });
    });

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_runtime');
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE clinical_alert_delivery_obligations
            SET notification_intent = notification_intent
          WHERE tenant_id = $1::uuid
            AND source_event_key = $2::text`,
        tenantId,
        runtimeSourceEventKey,
      );
    })).rejects.toThrow(/permission denied/i);
  });

  test('FORCE RLS returns no rows without exact tenant context', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_app');
      const noContext = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM clinical_alert_delivery_obligations
          WHERE source_event_key = $1::text`,
        sourceEventKey,
      );
      expect(noContext[0].count).toBe(0);

      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        tenantId,
      );
      const ownContext = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM clinical_alert_delivery_obligations
          WHERE source_event_key = $1::text`,
        sourceEventKey,
      );
      expect(ownContext[0].count).toBe(1);

      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        otherTenantId,
      );
      const otherContext = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM clinical_alert_delivery_obligations
          WHERE source_event_key = $1::text`,
        sourceEventKey,
      );
      expect(otherContext[0].count).toBe(0);
    });
  });
});
