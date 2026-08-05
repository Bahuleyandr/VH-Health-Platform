import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Client } from 'pg';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  claimDueInboxRows,
  processClaimedInboxRow,
} from '../services/events/pathwayProjectorService.js';
import { createPathwayProjectorRegistry } from '../services/events/pathwayProjectorRegistry.js';
import { registerExternalRecoveryOffset } from './helpers/externalRecoveryOperabilityTestHelper.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const FINGERPRINT = 'a'.repeat(64);
const OCCURRED_AT = '2026-07-30T12:00:00.000Z';
const CONSUMER_KEY = `c61_late_fence_${SUFFIX}`;
const GENERATION = 77;
const EVENT_TYPE = `test.external_recovery.late_${SUFFIX}`;

let facilityId;
let taskId;
let offsetId;
let recoveryInboxId;
let eventId;
const PATIENT_UID = randomUUID();
let patientId;
let emergencyVisitId;
let appointmentId;
let vitalsId;

async function guardedInsert(statement, params = []) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1::text, true)",
      [TENANT_ID],
    );
    await client.query(
      "SELECT set_config('app.external_recovery_effect_disposition', 'late_pending_only', true)",
    );
    let failure;
    try {
      await client.query(statement, params);
    } catch (error) {
      failure = error;
    }
    await client.query('ROLLBACK');
    expect(failure).toMatchObject({
      code: '23514',
      constraint: 'chk_external_recovery_late_effect_guard',
    });
  } finally {
    await client.end();
  }
}

describeIfDb('late external-recovery effect fences', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1 late fence tenant')`,
      TENANT_ID,
      `c61-late-${SUFFIX}`,
    );
    const facilities = await prisma.$queryRawUnsafe(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, timezone)
       VALUES ($1::uuid, $2::text, 'C6.1 late fence facility', 'Asia/Kolkata')
       RETURNING id`,
      TENANT_ID,
      `C61-LATE-${SUFFIX}`,
    );
    facilityId = facilities[0].id;
    const patients = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'C6.1 late patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID,
      TENANT_ID,
      `93${SUFFIX.slice(0, 10)}`,
    );
    patientId = patients[0].id;
    const emergency = await prisma.$queryRawUnsafe(
      `INSERT INTO emergency_visits
         (tenant_id, visit_number, patient_uid, arrival_mode, chief_complaint, status)
       VALUES ($1::uuid, $2::text, $3::uuid, 'walk_in', 'Late fence fixture', 'arriving')
       RETURNING id`,
      TENANT_ID,
      `C61-LATE-${SUFFIX}`,
      PATIENT_UID,
    );
    emergencyVisitId = emergency[0].id;
    const appointments = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (tenant_id, phone, patient_id, patient_name, doctor_name,
          appointment_date, appointment_time, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, $3::integer, 'C6.1 late patient', '',
               CURRENT_DATE, '09:15', 'CONFIRMED', NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      `93${SUFFIX.slice(0, 10)}`,
      patientId,
    );
    appointmentId = appointments[0].id;
    const vitals = await prisma.$queryRawUnsafe(
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, heart_rate, source, device_verified)
       VALUES ($1::uuid, $2::uuid, 88, 'staff', NULL)
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
    );
    vitalsId = vitals[0].id;
    const tasks = await prisma.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, related_resource_type,
          related_resource_id, priority, status, metadata)
       VALUES
         ($1::uuid, 'review', 'Synthetic late recovery review',
          'cold_chain_readings', $2::text, 'normal', 'open',
          '{"contract":"external_recovery_late_pending_only_v1"}'::jsonb)
       RETURNING id`,
      TENANT_ID,
      `synthetic-${SUFFIX}`,
    );
    taskId = tasks[0].id;
    const offset = await registerExternalRecoveryOffset({
      tenantId: TENANT_ID,
      facilityId,
      interfaceFamily: 'I10',
      sourcePartition: `late-fence-${SUFFIX}`,
      generation: 1,
      initialPosition: 10,
      initialToken: 'token-10',
      policyVersion: 'c-d8-v1',
      policySignature: 'synthetic-signature',
      retentionPolicy: 'cold-chain-730d',
      retentionUntil: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString(),
    });
    offsetId = offset.offset_id;
    await setTenantTx(TENANT_ID, async (tx) => {
      const inbox = await tx.$queryRawUnsafe(
        `INSERT INTO pathway_projector_inbox
           (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
            interface_family, direction, source_partition, source_position,
            source_token, predecessor_token, duplicate_key, command_fingerprint,
            occurred_at, received_at, recorded_at, arrival_class,
            effect_disposition, status, outcome_at, outcome_code, pending_task_id,
            policy_version, policy_signature, retention_policy, retention_until)
         VALUES
           ('external_interface', $1::uuid, 'external:I10', 1, $2::uuid,
            $3::integer, 'I10', 'inbound', $4::text, 11, 'token-11', 'token-10',
            $5::text, $6::char(64), $7::timestamptz, NOW(), NOW(),
            'recovery_backlog', 'late_pending_only', 'handled', NOW(),
            'cold_chain_reading_pending_review', $8::integer,
            'c-d8-v1', 'synthetic-signature', 'cold-chain-730d',
            NOW() + INTERVAL '730 days')
         RETURNING inbox_id::text`,
        TENANT_ID,
        offsetId,
        facilityId,
        `late-fence-${SUFFIX}`,
        `reading-${SUFFIX}`,
        FINGERPRINT,
        OCCURRED_AT,
        taskId,
      );
      recoveryInboxId = inbox[0].inbox_id;
    });
    const events = await prisma.$queryRawUnsafe(
      `INSERT INTO event_outbox
         (event_type, aggregate_type, aggregate_id, payload, tenant_id, status,
          available_at, created_at, occurred_at, occurred_at_source,
          recovery_inbox_id, recovery_fingerprint,
          recovery_effect_disposition)
       VALUES
         ($1::text, 'c6_1_late_test', $2::text, '{}'::jsonb, $3::uuid,
          'pending', NOW(), NOW(), $4::timestamptz, 'explicit', $5::uuid,
          $6::char(64), 'late_pending_only')
       RETURNING id::text`,
      EVENT_TYPE,
      SUFFIX,
      TENANT_ID,
      OCCURRED_AT,
      recoveryInboxId,
      FINGERPRINT,
    );
    eventId = events[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, event_id)
       VALUES
         ('pathway_registry', $1::uuid, $2::text, $3::integer, $4::bigint)
       ON CONFLICT DO NOTHING`,
      TENANT_ID,
      CONSUMER_KEY,
      GENERATION,
      eventId,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid
          AND scope_kind = 'pathway_registry'
          AND (event_id = $2::bigint OR consumer_key = $3::text)`,
      TENANT_ID,
      eventId,
      CONSUMER_KEY,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM event_outbox
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      eventId,
    ).catch(() => {});
    await setTenantTx(TENANT_ID, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM pathway_projector_inbox
          WHERE tenant_id = $1::uuid
            AND scope_kind = 'external_interface'
            AND inbox_id = $2::uuid`,
        TENANT_ID,
        recoveryInboxId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM event_consumer_offsets
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
        TENANT_ID,
        offsetId,
      );
    }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM vitals_chart WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM emergency_visits WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM facilities WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      TENANT_ID,
    ).catch(() => {});
    await prisma.$disconnect();
  }, 60_000);

  it.each([
    [
      'workflow SLA',
      `INSERT INTO workflow_sla_instances (tenant_id)
       VALUES ($1::uuid)`,
      [TENANT_ID],
    ],
    [
      'pathway transition',
      `INSERT INTO care_pathway_transition_events (tenant_id)
       VALUES ($1::uuid)`,
      [TENANT_ID],
    ],
    [
      'notification',
      `INSERT INTO notification_outbox (type, title, body)
       VALUES ('push', 'blocked', 'blocked')`,
      [],
    ],
    [
      'NEWS2 score',
      'INSERT INTO news2_scores DEFAULT VALUES',
      [],
    ],
    [
      'clinical alert',
      'INSERT INTO clinical_alerts DEFAULT VALUES',
      [],
    ],
    [
      'vitals triage',
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, heart_rate, source, triage_acuity)
       VALUES ($1::uuid, $2::uuid, 170, 'staff', 1)`,
      [TENANT_ID, PATIENT_UID],
    ],
  ])('database guard rejects retrospective %s creation', async (
    _label,
    statement,
    params,
  ) => {
    await guardedInsert(statement, params);
  });

  it.each([
    [
      'emergency triage',
      `UPDATE emergency_visits
          SET triage_priority = 'esi_1', triage_started_at = NOW(), status = 'in_triage'
        WHERE id = $1::integer AND tenant_id = $2::uuid`,
      () => [emergencyVisitId, TENANT_ID],
    ],
    [
      'appointment triage',
      `UPDATE appointments SET triage_acuity = 1
        WHERE id = $1::integer AND tenant_id = $2::uuid`,
      () => [appointmentId, TENANT_ID],
    ],
    [
      'vitals triage',
      `UPDATE vitals_chart SET triage_acuity = 1
        WHERE id = $1::integer AND tenant_id = $2::uuid`,
      () => [vitalsId, TENANT_ID],
    ],
  ])('database guard rejects retrospective %s mutation', async (
    _label,
    statement,
    params,
  ) => {
    await guardedInsert(statement, params());
  });

  it('records a typed ignored projector outcome without invoking the handler', async () => {
    const handler = jest.fn().mockResolvedValue({ should_not_run: true });
    const registry = createPathwayProjectorRegistry({
      generation: GENERATION,
      entries: [[EVENT_TYPE, handler]],
    });
    const claims = await claimDueInboxRows({
      consumerKey: CONSUMER_KEY,
      generation: GENERATION,
      limit: 1,
      leaseOwner: randomUUID(),
    });
    expect(claims).toHaveLength(1);
    const outcome = await processClaimedInboxRow({
      claim: claims[0],
      registry,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'ignored',
      outcome_code: 'late_pending_only_pathway_suppressed',
      metadata: {
        recovery_inbox_id: recoveryInboxId,
        pending_task_id: taskId,
      },
    });
  });
});
