import { createHash, randomUUID } from 'node:crypto';

import prisma, {
  ensureTenantRlsRuntimeRoleGrants,
  setTenantTx,
} from '../lib/prisma.js';
import {
  escalateIcuMarCarryoverFailure,
} from '../services/clinical/icuService.js';
import {
  CLINICAL_ALERT_RECIPIENT_POLICY,
  sweepClinicalAlertDeliveryObligations,
} from '../services/clinical/clinicalAlertDeliveryObligationService.js';
import {
  escalateOrderIntegrationFailure,
} from '../services/emr/orderEntryService.js';
import { resolveClinicalAlertRecipients } from '../utils/notifications/clinicalAlertFanout.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = DB_CONFIGURED ? describe : describe.skip;

const TENANT = randomUUID();
const PATIENT_UID = randomUUID();
const ORDERING_DOCTOR_UID = randomUUID();
const DUTY_DOCTOR_UID = randomUUID();
const SUFFIX = randomUUID().slice(0, 8);

function phone(lastDigit) {
  return `+91970${Date.now().toString().slice(-6)}${lastDigit}`;
}

async function tenantRows(sql, ...params) {
  return setTenantTx(TENANT, (tx) => tx.$queryRawUnsafe(sql, ...params));
}

async function seedUser({ uid, role, active, name, lastDigit }) {
  return prisma.$queryRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::boolean, $6::uuid, NOW())
     RETURNING id, uid::text, phone, role`,
    uid,
    phone(lastDigit),
    name,
    role,
    active,
    TENANT,
  ).then((rows) => rows[0]);
}

describeIfDb('MED-03 durable clinical-alert delivery obligations', () => {
  let order;
  let emergencyVisit;
  let icuAdmission;
  let previousRuntimeRole;

  beforeAll(async () => {
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_runtime';
    await ensureTenantRlsRuntimeRoleGrants();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, $3::text)`,
      TENANT,
      `med03-alert-${SUFFIX}`,
      `MED03 Alert ${SUFFIX}`,
    );
    await seedUser({
      uid: PATIENT_UID,
      role: 'PATIENT',
      active: true,
      name: 'Alert Recovery Patient',
      lastDigit: 1,
    });
    await seedUser({
      uid: ORDERING_DOCTOR_UID,
      role: 'DOCTOR',
      active: false,
      name: 'Inactive Ordering Doctor',
      lastDigit: 2,
    });
    const orderRows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, priority, details,
          status, ordered_by, start_date, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'routine',
               $4::jsonb, 'ordered', $5::uuid, NOW(), NOW())
       RETURNING id, order_number, encounter_id, patient_uid::text, order_type,
                 priority, details, status, ordered_by::text, start_date,
                 created_at, tenant_id::text`,
      TENANT,
      `ORD-ALERT-${SUFFIX}`,
      PATIENT_UID,
      JSON.stringify({ medication_name: 'Recovery Drug', dose: '5 mg', route: 'PO' }),
      ORDERING_DOCTOR_UID,
    );
    order = orderRows[0];

    const visitRows = await prisma.$queryRawUnsafe(
      `INSERT INTO emergency_visits
         (tenant_id, visit_number, patient_uid, arrival_mode,
          chief_complaint, attending_doctor_uid, status, created_by)
       VALUES ($1::uuid, $2::text, $3::uuid, 'walk_in',
               'ICU MAR carryover recovery fixture', $4::uuid,
               'in_treatment', $4::uuid)
       RETURNING id, tenant_id::text, patient_uid::text, encounter_id::text`,
      TENANT,
      `EMER-MED03-ALERT-${SUFFIX}`,
      PATIENT_UID,
      ORDERING_DOCTOR_UID,
    );
    emergencyVisit = visitRows[0];

    const icuRows = await prisma.$queryRawUnsafe(
      `INSERT INTO icu_admissions
         (tenant_id, patient_uid, unit_code, admitting_doctor_uid, status,
          er_visit_id)
       VALUES ($1::uuid, $2::uuid, 'ICU-A', $3::uuid, 'active', $4::int)
       RETURNING id, patient_uid::text, tenant_id::text, er_visit_id`,
      TENANT,
      PATIENT_UID,
      ORDERING_DOCTOR_UID,
      emergencyVisit.id,
    );
    icuAdmission = icuRows[0];
  }, 30_000);

  afterAll(async () => {
    if (previousRuntimeRole === undefined) {
      delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    } else {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }
    await prisma.$disconnect();
  });

  test('order MAR empty-recipient failure persists atomically, then replays exactly once after roster recovery', async () => {
    const result = await escalateOrderIntegrationFailure({
      order,
      stage: 'mar_schedule',
      err: Object.assign(new Error('schedule expansion failed'), {
        code: 'MAR_DURATION_EXCEEDS_WINDOW',
      }),
      deps: {
        resolveClinicalAlertRecipients: async () => [],
      },
    });
    expect(result).toEqual({ alertQueued: false, auditRecorded: true });

    const sourceEventKey = `clinical_orders:${order.id}:mar_schedule_failed:alert`;
    let obligations = await tenantRows(
      `SELECT *
         FROM clinical_alert_delivery_obligations
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT,
      sourceEventKey,
    );
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({
      source_table: 'clinical_orders',
      source_id: String(order.id),
      failure_kind: 'order_mar_schedule',
      status: 'pending',
      attempt_count: 0,
    });
    expect(obligations[0].notification_intent).toMatchObject({
      type: 'push',
      channel: 'push',
      source_event_key: sourceEventKey,
      template_version: 'clinical-alert-order-integration-failure.v1',
      data: {
        order_id: Number(order.id),
        patient_uid: PATIENT_UID,
        deep_link: `/emr/orders/${PATIENT_UID}?mar_recovery_order=${order.id}`,
      },
    });

    const auditRows = await tenantRows(
      `SELECT id, action, action_status, metadata
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND idempotency_key = $2::text`,
      TENANT,
      `clinical_orders:${order.id}:mar_schedule_failed`,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'mar_scheduling_failed',
      action_status: 'failed',
    });
    expect(auditRows[0].metadata.alert_recovery_obligation_id)
      .toBe(Number(obligations[0].id));

    const rollbackOrderRows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, priority, details,
          status, ordered_by, start_date, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'routine',
               $4::jsonb, 'ordered', $5::uuid, NOW(), NOW())
       RETURNING id, order_number, encounter_id, patient_uid::text, order_type,
                 priority, details, status, ordered_by::text, start_date,
                 created_at, tenant_id::text`,
      TENANT,
      `ORD-ROLLBACK-${SUFFIX}`,
      PATIENT_UID,
      JSON.stringify({ medication_name: 'Rollback Drug', dose: '2 mg', route: 'PO' }),
      ORDERING_DOCTOR_UID,
    );
    const rollbackOrder = rollbackOrderRows[0];
    await expect(escalateOrderIntegrationFailure({
      order: rollbackOrder,
      stage: 'mar_schedule',
      err: Object.assign(new Error('schedule failed'), { code: 'MAR_TEST_FAILURE' }),
      deps: {
        resolveClinicalAlertRecipients: async () => [],
        recordClinicalAuditEvent: async () => {
          throw new Error('canonical audit failed');
        },
      },
    })).resolves.toEqual({ alertQueued: false, auditRecorded: false });
    const rolledBack = await tenantRows(
      `SELECT id
         FROM clinical_alert_delivery_obligations
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT,
      `clinical_orders:${rollbackOrder.id}:mar_schedule_failed:alert`,
    );
    expect(rolledBack).toHaveLength(0);

    const dutyDoctor = await seedUser({
      uid: DUTY_DOCTOR_UID,
      role: 'DUTY_DOCTOR',
      active: true,
      name: 'Recovered Duty Doctor',
      lastDigit: 3,
    });
    const resolvedPolicies = [];
    const resolveRecipients = (tenantId, options) => {
      resolvedPolicies.push({
        primaryRole: options.primaryRole,
        fallbackRoles: options.fallbackRoles,
      });
      return resolveClinicalAlertRecipients(tenantId, options);
    };
    const sweeps = await Promise.all([
      sweepClinicalAlertDeliveryObligations({
        tenantId: TENANT,
        limit: 25,
        deps: { resolveClinicalAlertRecipients: resolveRecipients },
      }),
      sweepClinicalAlertDeliveryObligations({
        tenantId: TENANT,
        limit: 25,
        deps: { resolveClinicalAlertRecipients: resolveRecipients },
      }),
    ]);
    expect(sweeps.reduce((sum, sweep) => sum + sweep.recovered, 0)).toBe(1);
    expect(resolvedPolicies).toContainEqual({
      primaryRole: 'DUTY_DOCTOR',
      fallbackRoles: ['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT'],
    });

    obligations = await tenantRows(
      `SELECT *
         FROM clinical_alert_delivery_obligations
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT,
      sourceEventKey,
    );
    expect(obligations[0]).toMatchObject({
      status: 'completed',
      attempt_count: 1,
      completion_recipient_ids: [DUTY_DOCTOR_UID],
    });
    expect(obligations[0].completion_notification_outbox_ids).toHaveLength(1);
    expect(obligations[0].completion_evidence).toMatchObject({
      recovery_source: 'clinical-alert-delivery-obligation-recovery.v1',
      recipient_ids: [DUTY_DOCTOR_UID],
    });

    const outboxRows = await tenantRows(
      `SELECT id, type, channel, recipient_id, title, body, payload,
              source_event_key, template_version
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT,
      sourceEventKey,
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      id: obligations[0].completion_notification_outbox_id,
      type: 'push',
      channel: 'push',
      recipient_id: DUTY_DOCTOR_UID,
      source_event_key: sourceEventKey,
      template_version: 'clinical-alert-order-integration-failure.v1',
    });
    expect(outboxRows[0].payload).toMatchObject({
      order_id: Number(order.id),
      patient_uid: PATIENT_UID,
      recipient_role: dutyDoctor.role,
      deep_link: `/emr/orders/${PATIENT_UID}?mar_recovery_order=${order.id}`,
    });
    const rerun = await sweepClinicalAlertDeliveryObligations({ tenantId: TENANT });
    expect(rerun.recovered).toBe(0);
  }, 30_000);

  test('ICU queue failure retains the exact alert and completes from persisted outbox evidence', async () => {
    const visit = emergencyVisit;
    const result = await escalateIcuMarCarryoverFailure({
      admission: icuAdmission,
      visit,
      actorUid: ORDERING_DOCTOR_UID,
      actorRole: 'DOCTOR',
      err: Object.assign(new Error('ICU order query failed'), {
        code: 'MAR_CARRYOVER_QUERY_FAILED',
      }),
      deps: {
        queueClinicalAlertFanout: async () => {
          throw new Error('injected outbox queue failure');
        },
      },
    });
    expect(result).toEqual({
      alertQueued: false,
      canonicalRecorded: true,
      reviewPath: `/emr/orders/${PATIENT_UID}?icu_mar_review=${icuAdmission.id}`,
    });

    const sourceEventKey = `icu_admissions:${icuAdmission.id}:icu.mar_carryover_failed:alert`;
    let obligations = await tenantRows(
      `SELECT *
         FROM clinical_alert_delivery_obligations
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT,
      sourceEventKey,
    );
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({
      source_table: 'icu_admissions',
      source_id: String(icuAdmission.id),
      failure_kind: 'icu_mar_carryover_query',
      status: 'pending',
    });

    const canonicalRows = await tenantRows(
      `SELECT timeline.id AS timeline_id, audit.id AS audit_id,
              timeline.payload, audit.metadata
         FROM clinical_timeline_events timeline
         JOIN clinical_audit_events audit
           ON audit.tenant_id = timeline.tenant_id
          AND audit.idempotency_key = $3::text
        WHERE timeline.tenant_id = $1::uuid
          AND timeline.idempotency_key = $2::text`,
      TENANT,
      `icu_admissions:${icuAdmission.id}:icu.mar_carryover_failed`,
      `icu_admissions:${icuAdmission.id}:icu.mar_carryover_failed:audit`,
    );
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0].payload.alert_recovery_obligation_id)
      .toBe(Number(obligations[0].id));
    expect(canonicalRows[0].metadata.alert_recovery_obligation_id)
      .toBe(Number(obligations[0].id));

    const sweep = await sweepClinicalAlertDeliveryObligations({ tenantId: TENANT });
    expect(sweep.recovered).toBe(1);
    obligations = await tenantRows(
      `SELECT *
         FROM clinical_alert_delivery_obligations
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT,
      sourceEventKey,
    );
    expect(obligations[0].status).toBe('completed');

    const outboxRows = await tenantRows(
      `SELECT type, channel, recipient_id, title, body, payload,
              source_event_key, template_version
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT,
      sourceEventKey,
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      type: 'push',
      channel: 'push',
      recipient_id: DUTY_DOCTOR_UID,
      source_event_key: sourceEventKey,
      template_version: 'clinical-alert-icu-mar-carryover-failure.v1',
    });
    expect(outboxRows[0].payload).toMatchObject({
      icu_admission_id: Number(icuAdmission.id),
      patient_uid: PATIENT_UID,
      deep_link: `/emr/orders/${PATIENT_UID}?icu_mar_review=${icuAdmission.id}`,
    });
  }, 30_000);

  test('malformed stored intent moves to manual hold without a generic replacement alert', async () => {
    const sourceEventKey = `clinical_orders:${order.id}:malformed-alert:${SUFFIX}`;
    const key = createHash('sha256').update(`${TENANT}:${sourceEventKey}`).digest('hex');
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_alert_delivery_obligations
         (tenant_id, obligation_key, source_table, source_id, source_event_key,
          failure_kind, patient_uid, origin_actor_uid, failure_code,
          recipient_policy, notification_intent)
       VALUES ($1::uuid, $2::char(64), 'clinical_orders', $3::text, $4::text,
               'order_mar_schedule', $5::uuid, $6::uuid, 'LEGACY_UNKNOWN',
               $7::jsonb, '{}'::jsonb)`,
      TENANT,
      key,
      String(order.id),
      sourceEventKey,
      PATIENT_UID,
      ORDERING_DOCTOR_UID,
      JSON.stringify(CLINICAL_ALERT_RECIPIENT_POLICY),
      );
    });

    const sweep = await sweepClinicalAlertDeliveryObligations({ tenantId: TENANT });
    expect(sweep.held).toBe(1);
    const rows = await tenantRows(
      `SELECT status, manual_hold_code, manual_hold_reason, held_at
         FROM clinical_alert_delivery_obligations
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT,
      sourceEventKey,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'manual_hold',
      manual_hold_code: 'CLINICAL_ALERT_OBLIGATION_INTENT_INVALID',
    });
    expect(rows[0].manual_hold_reason).toMatch(/No replacement alert was emitted/i);
    expect(rows[0].held_at).toBeTruthy();
    const outboxRows = await tenantRows(
      `SELECT id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND source_event_key = $2::text`,
      TENANT,
      sourceEventKey,
    );
    expect(outboxRows).toHaveLength(0);
  }, 30_000);
});
