import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Client } from 'pg';

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  claimDueInboxRows,
  processClaimedInboxRow,
} from '../services/events/pathwayProjectorService.js';
import { createPathwayProjectorRegistry } from '../services/events/pathwayProjectorRegistry.js';
import {
  I03_RECOVERY_SCHEMA,
  i03DuplicateKey,
  i03SourceToken,
  sha256Utf8,
  submitHl7InboundRecovery,
} from '../services/integrations/externalHl7InboundRecoveryService.js';
import {
  resolveInteropCredentialSnapshot,
  upsertInteropSecret,
} from '../services/interop/tenantInteropSecretService.js';
import { provisionTenantKek, tenantKeyId } from '../services/security/tenantKekProvider.js';
import { getKeyId, isEncrypted } from '../utils/fieldEncryption.js';
import {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset,
} from './helpers/externalRecoveryOperabilityTestHelper.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const FINGERPRINT = 'a'.repeat(64);
const OCCURRED_AT = '2026-07-30T12:00:00.000Z';
const CONSUMER_KEY = `c61_late_fence_${SUFFIX}`;
const GENERATION = 77;
const EVENT_TYPE = `test.external_recovery.late_${SUFFIX}`;

function ownerDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

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
    const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      for (const sql of [
        `DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid`,
        `DELETE FROM event_outbox WHERE tenant_id = $1::uuid`,
        `DELETE FROM event_consumer_offsets WHERE tenant_id = $1::uuid`,
        `DELETE FROM external_recovery_operability_actions WHERE tenant_id = $1::uuid`,
        `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`,
        `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
        `DELETE FROM vitals_chart WHERE tenant_id = $1::uuid`,
        `DELETE FROM appointments WHERE tenant_id = $1::uuid`,
        `DELETE FROM emergency_visits WHERE tenant_id = $1::uuid`,
        `DELETE FROM users WHERE tenant_id = $1::uuid`,
        `DELETE FROM facilities WHERE tenant_id = $1::uuid`,
        `DELETE FROM tenants WHERE id = $1::uuid`,
      ]) {
        await client.query(sql, [TENANT_ID]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
    await prisma.$disconnect().catch(() => {});
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

describeIfDb('I03 real adapter late-effect suppression', () => {
  const tenantId = randomUUID();
  const patientUid = randomUUID();
  const localSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const facility = `I03-LATE-${localSuffix}`;
  const secret = `i03-late-${localSuffix}-secret`;
  const initialToken = sha256Utf8(`i03-late-${localSuffix}-10`);
  let credential;
  let offset;
  let recovery;
  let message;

  async function domainEffectCounts() {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM admissions WHERE tenant_id = $1::uuid) AS admissions,
         (SELECT COUNT(*)::integer FROM investigations WHERE tenant_id = $1::uuid) AS investigations,
         (SELECT COUNT(*)::integer FROM clinical_timeline_events WHERE tenant_id = $1::uuid) AS timeline,
         (SELECT COUNT(*)::integer FROM clinical_audit_events WHERE tenant_id = $1::uuid) AS audit,
         (SELECT COUNT(*)::integer FROM event_outbox WHERE tenant_id = $1::uuid) AS outbox,
         (SELECT COUNT(*)::integer FROM webhook_deliveries WHERE tenant_id = $1::uuid) AS webhooks,
         (SELECT COUNT(*)::integer FROM notification_outbox WHERE tenant_id = $1::uuid) AS notification_outbox,
         (SELECT COUNT(*)::integer FROM notifications WHERE tenant_id = $1::uuid) AS notifications,
         (SELECT COUNT(*)::integer FROM workflow_sla_instances WHERE tenant_id = $1::uuid) AS slas,
         (SELECT COUNT(*)::integer FROM care_pathway_instances WHERE tenant_id = $1::uuid) AS pathways,
         (SELECT COUNT(*)::integer FROM care_pathway_transition_events WHERE tenant_id = $1::uuid) AS transitions,
         (SELECT COUNT(*)::integer FROM clinical_alerts WHERE tenant_id = $1::uuid) AS clinical_alerts,
         (SELECT COUNT(*)::integer FROM lab_critical_alerts WHERE tenant_id = $1::uuid) AS lab_alerts,
         (SELECT COUNT(*)::integer FROM virtual_ward_escalations WHERE tenant_id = $1::uuid) AS escalations`,
      tenantId,
    );
    return rows[0];
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I03 late-effect tenant')`,
      tenantId,
      `i03-late-${localSuffix}`,
    );
    await provisionTenantKek(tenantId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'I03 late-effect patient',
               'PATIENT', TRUE, 'active', NOW())`,
      patientUid,
      tenantId,
      `89${localSuffix.slice(0, 10)}`,
    );
    await upsertInteropSecret({
      tenantId,
      kind: 'hl7_inbound',
      senderIdentifier: facility,
      secret,
    });
    credential = await resolveInteropCredentialSnapshot('hl7_inbound', facility);
    const sourcePartition = `i03/credential/${credential.id}/family/adt`;
    offset = await registerExternalRecoveryOffset({
      tenantId,
      interfaceFamily: 'I03',
      sourcePartition,
      initialPosition: '10',
      initialToken,
      retainedFromPosition: '10',
      retainedFromToken: initialToken,
      policyVersion: 'c6-1-i03-late-v1',
      policySignature: `i03-late-signature-${localSuffix}`,
      retentionPolicy: 'hl7-clinical-recovery-730d',
      retentionUntil: '2029-08-06T00:00:00.000Z',
    });
    const controlId = `I03-LATE-${localSuffix}`;
    const occurrence = '20260806103045.123456+0530';
    message = [
      `MSH|^~\\&|EXT|SRC|VH|${facility}|${occurrence}||ADT^A01|${controlId}|P|2.5|1042`,
      `EVN|A01|${occurrence}`,
      `PID|1||${patientUid}`,
      'PV1|1|I|WARD-3',
    ].join('\r');
    const messageSha256 = sha256Utf8(message);
    const duplicateKey = i03DuplicateKey({
      tenantId,
      signingCredentialId: credential.id,
      messageFamily: 'adt',
      messageType: 'ADT',
      triggerEvent: 'A01',
      messageControlId: controlId,
    });
    recovery = {
      schema: I03_RECOVERY_SCHEMA,
      interface_family: 'I03',
      arrival_class: 'recovery_backlog',
      tenant_id: tenantId,
      signing_credential_id: credential.id,
      offset_id: offset.offset_id,
      source_partition: sourcePartition,
      generation: 1,
      source_position: '11',
      source_token: '',
      predecessor_token: initialToken,
      duplicate_key: duplicateKey,
      message_family: 'adt',
      message_type: 'ADT',
      trigger_event: 'A01',
      message_control_id: controlId,
      message_sha256: messageSha256,
      source_observed_at: '2026-08-06T10:30:45.123456+05:30',
      source_received_at: '2026-08-06T10:30:45.123999+05:30',
      clock_evidence: {
        source_clock_id: `i03-late-${localSuffix}`,
        synchronized_at: '2026-08-06T10:29:00+05:30',
        maximum_error_ms: 1000,
      },
    };
    recovery.source_token = i03SourceToken({
      tenantId,
      sourcePartition,
      generation: 1,
      sourcePosition: '11',
      predecessorToken: initialToken,
      duplicateKey,
      messageSha256,
    });
    await authorizeExternalRecoveryResume({
      tenantId,
      offsetId: offset.offset_id,
      interfaceFamily: 'I03',
      resumeCutoffPosition: '11',
      resumeCutoffToken: recovery.source_token,
    });
  }, 60_000);

  afterAll(async () => {
    const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      for (const sql of [
        `DELETE FROM hl7_inbound_recovery_receipts WHERE tenant_id = $1::uuid`,
        `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
        `DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid`,
        `DELETE FROM event_consumer_offsets WHERE tenant_id = $1::uuid`,
        `DELETE FROM external_recovery_operability_actions WHERE tenant_id = $1::uuid`,
        `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`,
        `DELETE FROM tenant_interop_secrets WHERE tenant_id = $1::uuid`,
        `DELETE FROM users WHERE tenant_id = $1::uuid`,
        `DELETE FROM tenants WHERE id = $1::uuid`,
      ]) {
        await client.query(sql, [tenantId]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  it('creates only encrypted receipt and no-SLA review work across every late-effect family', async () => {
    const before = await domainEffectCounts();
    const result = await submitHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: credential,
    });
    expect(result).toMatchObject({ httpStatus: 200, duplicate: false });
    expect(result.ack).toContain('MSA|AA');
    expect(await domainEffectCounts()).toEqual(before);

    const rows = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
      `SELECT r.id::text, r.patient_uid::text, r.status, r.outcome_code,
              r.ack_code, r.http_status, r.payload_sha256::text,
              r.payload_ciphertext, r.ack_ciphertext,
              i.status AS inbox_status, i.arrival_class, i.effect_disposition,
              t.task_kind, t.status AS task_status, t.assigned_to_role,
              t.workflow_sla_instance_id, t.due_at, t.sla_completion_semantics,
              o.high_water_position::text, o.high_water_token, o.recovery_state
         FROM hl7_inbound_recovery_receipts r
         JOIN pathway_projector_inbox i
           ON i.tenant_id = r.tenant_id AND i.inbox_id = r.recovery_inbox_id
         JOIN tasks t ON t.tenant_id = r.tenant_id AND t.id = r.pending_task_id
         JOIN event_consumer_offsets o
           ON o.tenant_id = r.tenant_id AND o.offset_id = i.offset_id
        WHERE r.tenant_id = $1::uuid AND r.source_partition = $2::text`,
      tenantId,
      recovery.source_partition,
    ));
    expect(rows).toHaveLength(1);
    expect(isEncrypted(rows[0].payload_ciphertext)).toBe(true);
    expect(isEncrypted(rows[0].ack_ciphertext)).toBe(true);
    expect(getKeyId(rows[0].payload_ciphertext)).toBe(tenantKeyId(tenantId));
    expect(getKeyId(rows[0].ack_ciphertext)).toBe(tenantKeyId(tenantId));
    expect(rows[0].payload_ciphertext).not.toContain(message);
    expect(rows[0].ack_ciphertext).not.toContain(result.ack);
    expect(rows[0]).toMatchObject({
      id: expect.stringMatching(/^[1-9][0-9]*$/),
      patient_uid: patientUid,
      status: 'pending_review',
      outcome_code: 'i03_adt_pending_admission_reconciliation',
      ack_code: 'AA',
      http_status: 200,
      payload_sha256: recovery.message_sha256,
      inbox_status: 'handled',
      arrival_class: 'recovery_backlog',
      effect_disposition: 'late_pending_only',
      task_kind: 'review',
      task_status: 'open',
      assigned_to_role: 'MEDICAL_RECORDS',
      workflow_sla_instance_id: null,
      due_at: null,
      sla_completion_semantics: 'none',
      high_water_position: '11',
      high_water_token: recovery.source_token,
      recovery_state: 'ready',
    });
  }, 60_000);
});
