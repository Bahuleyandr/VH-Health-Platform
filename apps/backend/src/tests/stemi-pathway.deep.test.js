import { randomUUID } from 'node:crypto';

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = randomUUID();
const APP_ROLE = 'rls_test_app';
const PATIENT_A = randomUUID();
const OTHER_PATIENT_A = randomUUID();
const PATIENT_B = randomUUID();
const DOCTOR_UID = randomUUID();
const ADMIN_UID = randomUUID();
const CATH_UID = randomUUID();
const CATH_B_UID = randomUUID();
const ENCOUNTER_A = randomUUID();
const OTHER_ENCOUNTER_A = randomUUID();
const ENCOUNTER_B = randomUUID();
const RUN = randomUUID().slice(0, 8);
const PHONE_SEED = String(Date.now()).slice(-6);
const ARRIVAL_AT = '2026-07-11T10:00:00.000Z';
const TEST_PATIENT_UIDS = [PATIENT_A, OTHER_PATIENT_A, PATIENT_B];
const TEST_ENCOUNTER_IDS = [ENCOUNTER_A, OTHER_ENCOUNTER_A, ENCOUNTER_B];
const TEST_USER_UIDS = [
  ...TEST_PATIENT_UIDS,
  DOCTOR_UID,
  ADMIN_UID,
  CATH_UID,
  CATH_B_UID,
];

let visitId;
let activationId;
let cathCaseId;
let pendingTargetActivationId;
let tenantBActivationId;
let previousSettings = null;

function doctor() {
  return authClient('DOCTOR', { uid: DOCTOR_UID, id: 1 });
}

function admin() {
  return authClient('ADMIN', { uid: ADMIN_UID, id: 2 });
}

function cathMember() {
  return authClient('CATH_LAB_INCHARGE', { uid: CATH_UID, id: 3 });
}

async function asAppRole(sql, params, tenantId) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      tenantId,
    );
    return tx.$queryRawUnsafe(sql, ...params);
  });
}

async function settingsRow() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, enabled, enabled_at, enabled_by,
            clock_definition_source, clock_definition_version,
            clock_definition_attachment_refs, activation_criteria_source,
            activation_criteria_version, activation_criteria,
            door_to_ecg_target_minutes, door_to_lab_target_minutes,
            door_to_balloon_target_minutes, notification_role_codes,
            acceptance_snapshot, metadata, created_at, updated_at
       FROM stemi_pathway_settings
      WHERE tenant_id = $1::uuid`,
    TENANT_A,
  ).catch(() => []);
  return rows[0] || null;
}

async function restoreSettings() {
  if (!previousSettings) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM stemi_pathway_settings WHERE tenant_id = $1::uuid`,
      TENANT_A,
    ).catch(() => {});
    return;
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO stemi_pathway_settings
       (tenant_id, enabled, enabled_at, enabled_by,
        clock_definition_source, clock_definition_version,
        clock_definition_attachment_refs, activation_criteria_source,
        activation_criteria_version, activation_criteria,
        door_to_ecg_target_minutes, door_to_lab_target_minutes,
        door_to_balloon_target_minutes, notification_role_codes,
        acceptance_snapshot, metadata, created_at, updated_at)
     VALUES ($1::uuid, $2, $3::timestamptz, $4::uuid,
             $5, $6, $7::jsonb, $8, $9, $10::jsonb,
             $11::int, $12::int, $13::int, $14::text[],
             $15::jsonb, $16::jsonb, $17::timestamptz, $18::timestamptz)
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       enabled_at = EXCLUDED.enabled_at,
       enabled_by = EXCLUDED.enabled_by,
       clock_definition_source = EXCLUDED.clock_definition_source,
       clock_definition_version = EXCLUDED.clock_definition_version,
       clock_definition_attachment_refs = EXCLUDED.clock_definition_attachment_refs,
       activation_criteria_source = EXCLUDED.activation_criteria_source,
       activation_criteria_version = EXCLUDED.activation_criteria_version,
       activation_criteria = EXCLUDED.activation_criteria,
       door_to_ecg_target_minutes = EXCLUDED.door_to_ecg_target_minutes,
       door_to_lab_target_minutes = EXCLUDED.door_to_lab_target_minutes,
       door_to_balloon_target_minutes = EXCLUDED.door_to_balloon_target_minutes,
       notification_role_codes = EXCLUDED.notification_role_codes,
       acceptance_snapshot = EXCLUDED.acceptance_snapshot,
       metadata = EXCLUDED.metadata,
       updated_at = EXCLUDED.updated_at`,
    TENANT_A,
    previousSettings.enabled,
    previousSettings.enabled_at,
    previousSettings.enabled_by,
    previousSettings.clock_definition_source,
    previousSettings.clock_definition_version,
    JSON.stringify(previousSettings.clock_definition_attachment_refs || []),
    previousSettings.activation_criteria_source,
    previousSettings.activation_criteria_version,
    JSON.stringify(previousSettings.activation_criteria || {}),
    previousSettings.door_to_ecg_target_minutes,
    previousSettings.door_to_lab_target_minutes,
    previousSettings.door_to_balloon_target_minutes,
    previousSettings.notification_role_codes || [],
    previousSettings.acceptance_snapshot == null
      ? null
      : JSON.stringify(previousSettings.acceptance_snapshot),
    JSON.stringify(previousSettings.metadata || {}),
    previousSettings.created_at,
    previousSettings.updated_at,
  ).catch(() => {});
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE stemi_pathway_events
       DISABLE TRIGGER trg_stemi_pathway_events_append_only`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM stemi_pathway_events
      WHERE patient_uid = ANY($1::uuid[])`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `ALTER TABLE stemi_pathway_events
       ENABLE TRIGGER trg_stemi_pathway_events_append_only`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM stemi_team_notifications
      WHERE activation_id IN (
        SELECT id FROM stemi_activations
         WHERE patient_uid = ANY($1::uuid[])
      )`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox
      WHERE payload->>'patient_uid' = ANY($1::text[])`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances
      WHERE source_table = 'stemi_activations'
        AND source_id IN (
          SELECT id::text FROM stemi_activations
           WHERE patient_uid = ANY($1::uuid[])
        )`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM stemi_activations
      WHERE patient_uid = ANY($1::uuid[])`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM cath_procedure_logs
      WHERE patient_uid = ANY($1::uuid[])`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM cath_lab_readiness_checks
      WHERE case_id IN (
        SELECT id FROM cath_lab_cases
         WHERE patient_uid = ANY($1::uuid[])
      )`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_lab_cases
        WHERE patient_uid = ANY($1::uuid[])`,
      TEST_PATIENT_UIDS,
    );
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE patient_uid = ANY($1::uuid[])`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events
      WHERE patient_uid = ANY($1::uuid[])`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM emergency_visits
      WHERE patient_uid = ANY($1::uuid[])`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM prehospital_handovers
      WHERE patient_uid = ANY($1::uuid[])`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ambulance_requests
      WHERE patient_uid = ANY($1::uuid[])`,
    TEST_PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_encounters
      WHERE id = ANY($1::uuid[])`,
    TEST_ENCOUNTER_IDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_shift_roster_boards
      WHERE tenant_id = $1::uuid
        AND notes = $2::text`,
    TENANT_A,
    `stemi-deep-${RUN}`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
    TEST_USER_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM stemi_pathway_settings WHERE tenant_id = $1::uuid`,
    TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_B,
  ).catch(() => {});
}

d('NL-13 P1c STEMI pathway deep workflow', () => {
  let facilityAId;

  beforeAll(async () => {
    previousSettings = await settingsRow();
    await cleanup();
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_test_app') THEN
          CREATE ROLE rls_test_app NOLOGIN;
        END IF;
        ALTER ROLE rls_test_app NOSUPERUSER NOBYPASSRLS;
      END $$;
    `);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE
         ON stemi_activations, stemi_pathway_events,
            stemi_pathway_settings, stemi_team_notifications
         TO ${APP_ROLE}`,
    );
    await prisma.$executeRawUnsafe(
      `GRANT SELECT ON tenants, users, patient_encounters, emergency_visits,
                       cath_lab_cases, workflow_sla_instances
         TO ${APP_ROLE}`,
    );
    await prisma.$executeRawUnsafe(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, $2, 'STEMI Deep Tenant B', 'IN', 'DPDP', 'active')`,
      TENANT_B,
      `stemi-deep-${RUN}`,
    );
    const facilityRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM facilities
        WHERE tenant_id=$1::uuid AND status='active'
        ORDER BY is_default DESC, id
        LIMIT 1`,
      TENANT_A,
    );
    facilityAId = Number(facilityRows[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, $5, 'STEMI Deep Patient A', 'PATIENT', TRUE, $4::uuid, NOW()),
         ($2::uuid, $6, 'STEMI Deep Other Patient A', 'PATIENT', TRUE, $4::uuid, NOW()),
         ($3::uuid, $7, 'STEMI Deep Doctor', 'DOCTOR', TRUE, $4::uuid, NOW())`,
      PATIENT_A,
      OTHER_PATIENT_A,
      DOCTOR_UID,
      TENANT_A,
      `+919${PHONE_SEED}001`,
      `+919${PHONE_SEED}002`,
      `+919${PHONE_SEED}003`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, $4, 'STEMI Deep Admin', 'ADMIN', TRUE, $3::uuid, NOW()),
         ($2::uuid, $5, 'STEMI Deep Cath Lead', 'CATH_LAB_INCHARGE', TRUE, $3::uuid, NOW())`,
      ADMIN_UID,
      CATH_UID,
      TENANT_A,
      `+919${PHONE_SEED}004`,
      `+919${PHONE_SEED}005`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, $3, 'STEMI Deep Patient B', 'PATIENT', TRUE, $5::uuid, NOW()),
         ($2::uuid, $4, 'STEMI Deep Cath Lead B', 'CATH_LAB_INCHARGE', TRUE, $5::uuid, NOW())`,
      PATIENT_B,
      CATH_B_UID,
      `+919${PHONE_SEED}006`,
      `+919${PHONE_SEED}007`,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_encounters
         (id, tenant_id, patient_uid, encounter_type, status, primary_doctor_uid,
          care_team_uids, created_by, updated_by, metadata)
       VALUES
         ($1::uuid, $4::uuid, $5::uuid, 'er', 'open', $7::uuid,
          ARRAY[$7::uuid]::uuid[], $7::uuid, $7::uuid,
          jsonb_build_object('test','stemi_deep','facility_id',$10::int)),
         ($2::uuid, $4::uuid, $6::uuid, 'er', 'open', $7::uuid,
          ARRAY[$7::uuid]::uuid[], $7::uuid, $7::uuid,
          jsonb_build_object('test','stemi_deep','facility_id',$10::int)),
         ($3::uuid, $8::uuid, $9::uuid, 'er', 'open', NULL,
          ARRAY[]::uuid[], NULL, NULL, '{"test":"stemi_deep"}'::jsonb)`,
      ENCOUNTER_A,
      OTHER_ENCOUNTER_A,
      ENCOUNTER_B,
      TENANT_A,
      PATIENT_A,
      OTHER_PATIENT_A,
      DOCTOR_UID,
      TENANT_B,
      PATIENT_B,
      facilityAId,
    );
    const visits = await prisma.$queryRawUnsafe(
      `INSERT INTO emergency_visits
         (tenant_id, visit_number, patient_uid, encounter_id, arrival_at,
          arrival_mode, status, chief_complaint, created_by)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::timestamptz,
               'walk_in', 'in_treatment', 'Synthetic STEMI deep test', $6::uuid)
       RETURNING id`,
      TENANT_A,
      `STEMI-DEEP-${RUN}`,
      PATIENT_A,
      ENCOUNTER_A,
      new Date(ARRIVAL_AT),
      DOCTOR_UID,
    );
    visitId = Number(visits[0].id);
    const rosterBoards = await prisma.$queryRawUnsafe(
      `INSERT INTO staff_shift_roster_boards
         (tenant_id, department, roster_date, shift_label, shift_start,
          shift_end, status, notes, published_by_uid, published_at)
       VALUES ($1::uuid, 'cath_lab', DATE '2026-07-11', $2::text,
               TIME '00:00:00', TIME '23:59:59', 'published', $3::text,
               $4::uuid, NOW())
       RETURNING id`,
      TENANT_A,
      `STEMI Deep ${RUN}`,
      `stemi-deep-${RUN}`,
      ADMIN_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_shift_roster_assignments
         (tenant_id, roster_id, staff_id, staff_uid, staff_role,
          assignment_target_type, assignment_target_label, is_lead, status)
       SELECT $1::uuid, $2::int, u.id, u.uid, u.role,
              'department', 'Cath Lab', TRUE, 'published'
         FROM users u
        WHERE u.tenant_id = $1::uuid AND u.uid = $3::uuid`,
      TENANT_A,
      Number(rosterBoards[0].id),
      CATH_UID,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await restoreSettings();
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  test('ED activation fans out durably, spawns primary-PCI evidence, records SLA outcomes, and writes canonical pairs', async () => {
    const invalidRoles = await admin().patch('/api/v1/stemi-pathway/settings').send({
      enabled: true,
      clock_definition_source: 'Synthetic owner STEMI clock SOP',
      clock_definition_version: '2026.07',
      activation_criteria_source: 'Synthetic owner STEMI activation SOP',
      activation_criteria_version: '2026.07',
      notification_role_codes: ['HOUSEKEEPING_STAFF'],
    });
    expect(invalidRoles.status).toBe(400);

    const settings = await admin().patch('/api/v1/stemi-pathway/settings').send({
      enabled: true,
      clock_definition_source: 'Synthetic owner STEMI clock SOP',
      clock_definition_version: '2026.07',
      activation_criteria_source: 'Synthetic owner STEMI activation SOP',
      activation_criteria_version: '2026.07',
      activation_criteria: { owner_checklist_ref: 'synthetic-fixture' },
      door_to_ecg_target_minutes: 10,
      door_to_lab_target_minutes: 30,
      door_to_balloon_target_minutes: 60,
      notification_role_codes: ['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF'],
      acceptance_snapshot: { build: 'nl13_p1c' },
    });
    expect(settings.status).toBe(200);

    const storedVisits = await prisma.$queryRawUnsafe(
      `SELECT arrival_at FROM emergency_visits
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      visitId,
    );
    expect(new Date(storedVisits[0].arrival_at).toISOString()).toBe(ARRIVAL_AT);

    const activationResponse = await doctor().post('/api/v1/stemi-pathway/activations').send({
      patient_uid: PATIENT_A,
      emergency_visit_id: visitId,
      activation_source: 'clinician',
      activated_at: '2026-07-11T10:05:00.000Z',
      ecg_at: '2026-07-11T10:15:01.000Z',
    });
    expect(activationResponse.body).toMatchObject({ success: true });
    expect(activationResponse.status).toBe(200);
    const detail = activationResponse.body.data;
    activationId = Number(detail.activation.id);
    cathCaseId = Number(detail.activation.cath_case_id);
    expect(detail.activation.door_time_at).toBe(ARRIVAL_AT);
    expect(detail.activation.ecg_at).toBe('2026-07-11T10:15:01.000Z');
    expect(detail.activation.status).toBe('lab_notified');
    expect(detail.sla_instances).toHaveLength(3);
    expect(detail.sla_instances.every((sla) => sla.started_at === ARRIVAL_AT)).toBe(true);
    expect(detail.pathway_events.map((event) => event.event_type)).toEqual([
      'activation',
      'ecg_acquired',
    ]);
    expect(detail.primary_pci_evidence.cath_case).toMatchObject({
      id: cathCaseId,
      urgency: 'emergency',
    });
    expect(detail.primary_pci_evidence.readiness_checks).toHaveLength(8);

    const notificationRows = await prisma.$queryRawUnsafe(
      `SELECT n.notification_status, n.staff_uid, n.assignment_source,
              n.notification_outbox_id, o.tenant_id AS outbox_tenant_id
         FROM stemi_team_notifications n
         JOIN notification_outbox o ON o.id = n.notification_outbox_id
        WHERE n.tenant_id = $1::uuid AND n.activation_id = $2::bigint`,
      TENANT_A,
      activationId,
    );
    expect(notificationRows).toHaveLength(1);
    expect(notificationRows[0]).toMatchObject({
      notification_status: 'notified',
      staff_uid: CATH_UID,
      assignment_source: 'on_call_role',
      outbox_tenant_id: TENANT_A,
    });
    expect(notificationRows[0].notification_outbox_id).not.toBeNull();

    const ack = await cathMember()
      .post(`/api/v1/stemi-pathway/activations/${activationId}/ack`)
      .send({ acknowledgement_note: 'Cath team mobilized' });
    expect(ack.status).toBe(200);
    expect(ack.body.data.notification_status).toBe('acknowledged');

    for (const event of [
      ['patient_in_lab', '2026-07-11T10:20:00.000Z'],
      ['device_deployed', '2026-07-11T11:01:00.000Z'],
      ['disposition', '2026-07-11T11:05:00.000Z'],
    ]) {
      const response = await doctor()
        .post(`/api/v1/stemi-pathway/activations/${activationId}/events`)
        .send({ event_type: event[0], occurred_at: event[1], event_payload: { synthetic: true } });
      expect(response.status).toBe(200);
    }

    const slas = await prisma.$queryRawUnsafe(
      `SELECT rule_code, status, started_at, due_at, completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'stemi_activations'
          AND source_id = $2::text
        ORDER BY rule_code`,
      TENANT_A,
      String(activationId),
    );
    expect(Object.fromEntries(slas.map((sla) => [sla.rule_code, sla.status]))).toEqual({
      stemi_door_to_balloon: 'breached',
      stemi_door_to_ecg: 'breached',
      stemi_door_to_lab: 'completed',
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO cath_procedure_logs
         (tenant_id, case_id, patient_uid, encounter_id, procedure_type,
          status, started_at, ended_at, logged_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid, 'Primary PCI',
               'finalized', $5::timestamptz, $6::timestamptz, $7::uuid,
               '{"synthetic_fixture":true}'::jsonb)`,
      TENANT_A,
      cathCaseId,
      PATIENT_A,
      ENCOUNTER_A,
      new Date('2026-07-11T10:20:00.000Z'),
      new Date('2026-07-11T11:05:00.000Z'),
      DOCTOR_UID,
    );
    const hydrated = await doctor().get(`/api/v1/stemi-pathway/activations/${activationId}`);
    expect(hydrated.status).toBe(200);
    expect(hydrated.body.data.primary_pci_evidence.cath_procedure_logs).toHaveLength(1);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND (event_type LIKE 'stemi.%' OR event_type = 'cath_lab.case_created')`,
      TENANT_A,
      PATIENT_A,
    );
    expect(timeline.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      'stemi.activation.created',
      'stemi.team.notified',
      'stemi.team.acknowledged',
      'stemi.pathway.ecg_acquired',
      'stemi.pathway.patient_in_lab',
      'stemi.pathway.device_deployed',
      'cath_lab.case_created',
    ]));
    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT action
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND (action LIKE 'stemi.%' OR action = 'cath_lab.case_created')`,
      TENANT_A,
      PATIENT_A,
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(timeline.length);
  }, 60_000);

  test('missing owner targets create three non-breachable pending SLA clocks', async () => {
    const settings = await admin().patch('/api/v1/stemi-pathway/settings').send({
      door_to_ecg_target_minutes: null,
      door_to_lab_target_minutes: null,
      door_to_balloon_target_minutes: null,
    });
    expect(settings.status).toBe(200);

    const activationResponse = await doctor().post('/api/v1/stemi-pathway/activations').send({
      patient_uid: OTHER_PATIENT_A,
      encounter_id: OTHER_ENCOUNTER_A,
      activation_source: 'clinician',
      door_time_at: '2026-07-11T12:00:00.000Z',
      activated_at: '2026-07-11T12:05:00.000Z',
      spawn_cath_case: false,
    });
    expect(activationResponse.status).toBe(200);
    pendingTargetActivationId = Number(activationResponse.body.data.activation.id);
    const pending = activationResponse.body.data.sla_instances;
    expect(pending).toHaveLength(3);
    expect(pending.every((sla) => (
      sla.due_at == null
      && sla.metadata.targets_pending === true
      && sla.status === 'active'
      && sla.breached_at == null
    ))).toBe(true);

    const duplicate = await doctor().post('/api/v1/stemi-pathway/activations').send({
      patient_uid: OTHER_PATIENT_A,
      encounter_id: OTHER_ENCOUNTER_A,
      activation_source: 'clinician',
      door_time_at: '2026-07-11T12:00:00.000Z',
      activated_at: '2026-07-11T12:06:00.000Z',
      spawn_cath_case: false,
    });
    expect(duplicate.status).toBe(409);

    const directCompletion = await doctor()
      .patch(`/api/v1/stemi-pathway/activations/${pendingTargetActivationId}/status`)
      .send({ status: 'completed' });
    expect(directCompletion.status).toBe(400);

    const ecg = await doctor()
      .post(`/api/v1/stemi-pathway/activations/${pendingTargetActivationId}/events`)
      .send({
        event_type: 'ecg_acquired',
        occurred_at: '2026-07-11T12:30:00.000Z',
        event_payload: {
          activation_id: 999999,
          sequence_number: 999999,
          event_type: 'disposition',
          workflow_sla_instance_id: 'spoofed',
        },
      });
    expect(ecg.status).toBe(200);
    expect(ecg.body.data.sla_instance).toMatchObject({
      rule_code: 'stemi_door_to_ecg',
      status: 'completed',
      due_at: null,
      breached_at: null,
    });

    await expect(prisma.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'breached', breached_at = NOW()
        WHERE tenant_id = $1::uuid
          AND source_table = 'stemi_activations'
          AND source_id = $2::text
          AND rule_code = 'stemi_door_to_lab'`,
      TENANT_A,
      String(pendingTargetActivationId),
    )).rejects.toThrow(/targets_pending_not_breached|check constraint/i);

    const timelinePayload = await prisma.$queryRawUnsafe(
      `SELECT payload
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND event_type = 'stemi.pathway.ecg_acquired'
        ORDER BY occurred_at DESC
        LIMIT 1`,
      TENANT_A,
      OTHER_PATIENT_A,
    );
    expect(timelinePayload[0].payload).toMatchObject({
      activation_id: pendingTargetActivationId,
      event_type: 'ecg_acquired',
    });
    expect(timelinePayload[0].payload.sequence_number).not.toBe(999999);

    const standDown = await doctor()
      .patch(`/api/v1/stemi-pathway/activations/${pendingTargetActivationId}/status`)
      .send({ status: 'stood_down', stand_down_reason: 'Synthetic test cleanup' });
    expect(standDown.status).toBe(200);
  }, 60_000);

  test('pre-hospital activation defers all door clocks and starts them once door time is recorded', async () => {
    const settings = await admin().patch('/api/v1/stemi-pathway/settings').send({
      door_to_ecg_target_minutes: 10,
      door_to_lab_target_minutes: 30,
      door_to_balloon_target_minutes: 60,
    });
    expect(settings.status).toBe(200);

    const ambulanceRows = await prisma.$queryRawUnsafe(
      `INSERT INTO ambulance_requests
         (tenant_id, request_number, patient_uid, patient_name, status,
          requested_at, created_by, metadata)
       VALUES ($1::uuid, $2::text, $3::uuid, 'STEMI Deep Patient A',
               'en_route', $4::timestamptz, $5::uuid, $6::jsonb)
       RETURNING id`,
      TENANT_A,
      `STEMI-AMB-${RUN}`,
      PATIENT_A,
      new Date('2026-07-11T05:30:00.000Z'),
      DOCTOR_UID,
      JSON.stringify({ test: `stemi-deep-${RUN}` }),
    );
    const handoverRows = await prisma.$queryRawUnsafe(
      `INSERT INTO prehospital_handovers
         (tenant_id, handover_number, ambulance_request_id, patient_uid,
          status, presenting_complaint, created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::text, $3::int, $4::uuid,
               'ready_for_acceptance', 'Synthetic pre-hospital STEMI',
               $5::uuid, $5::uuid, $6::jsonb)
       RETURNING id`,
      TENANT_A,
      `STEMI-HO-${RUN}`,
      Number(ambulanceRows[0].id),
      PATIENT_A,
      DOCTOR_UID,
      JSON.stringify({ test: `stemi-deep-${RUN}` }),
    );

    const activationResponse = await doctor().post('/api/v1/stemi-pathway/activations').send({
      patient_uid: PATIENT_A,
      encounter_id: ENCOUNTER_A,
      prehospital_handover_id: Number(handoverRows[0].id),
      activation_source: 'prehospital_handover',
      activated_at: '2026-07-11T06:00:00.000Z',
      spawn_cath_case: false,
    });
    expect(activationResponse.status).toBe(200);
    const prehospitalActivationId = Number(activationResponse.body.data.activation.id);
    expect(activationResponse.body.data.activation.door_time_at).toBeNull();
    expect(activationResponse.body.data.sla_instances).toHaveLength(3);
    expect(activationResponse.body.data.sla_instances.every((sla) => (
      sla.started_at == null
      && sla.due_at == null
      && sla.metadata.clock_start_pending === true
      && sla.metadata.targets_pending === false
    ))).toBe(true);

    const doorTime = '2026-07-11T06:20:00.000Z';
    const recorded = await doctor()
      .patch(`/api/v1/stemi-pathway/activations/${prehospitalActivationId}/clocks`)
      .send({ door_time_at: doorTime });
    expect(recorded.status).toBe(200);
    expect(recorded.body.data.activation.door_time_at).toBe(doorTime);
    expect(recorded.body.data.sla_instances.every((sla) => (
      sla.started_at === doorTime
      && sla.due_at != null
      && sla.metadata.clock_start_pending === false
    ))).toBe(true);

    const standDown = await doctor()
      .patch(`/api/v1/stemi-pathway/activations/${prehospitalActivationId}/status`)
      .send({ status: 'stood_down', stand_down_reason: 'Synthetic test cleanup' });
    expect(standDown.status).toBe(200);
  }, 60_000);

  test('rejects cross-patient and cross-tenant encounter references before writing', async () => {
    const beforeRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM stemi_activations
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_A,
      PATIENT_A,
    );
    const crossPatient = await doctor().post('/api/v1/stemi-pathway/activations').send({
      patient_uid: PATIENT_A,
      encounter_id: OTHER_ENCOUNTER_A,
      activation_source: 'clinician',
      door_time_at: ARRIVAL_AT,
      activated_at: '2026-07-11T10:05:00.000Z',
    });
    expect(crossPatient.status).toBe(409);
    const crossTenant = await doctor().post('/api/v1/stemi-pathway/activations').send({
      patient_uid: PATIENT_A,
      encounter_id: ENCOUNTER_B,
      activation_source: 'clinician',
      door_time_at: ARRIVAL_AT,
      activated_at: '2026-07-11T10:05:00.000Z',
    });
    expect(crossTenant.status).toBe(404);
    const unrelatedTeamMember = await doctor().post('/api/v1/stemi-pathway/activations').send({
      patient_uid: OTHER_PATIENT_A,
      encounter_id: OTHER_ENCOUNTER_A,
      activation_source: 'clinician',
      door_time_at: ARRIVAL_AT,
      activated_at: '2026-07-11T10:05:00.000Z',
      spawn_cath_case: false,
      team: { members: [{ staff_uid: DOCTOR_UID, role_code: 'CATH_LAB_INCHARGE' }] },
    });
    expect(unrelatedTeamMember.status).toBe(400);
    const afterRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM stemi_activations
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_A,
      PATIENT_A,
    );
    expect(afterRows[0].count).toBe(beforeRows[0].count);
  });

  test('forced RLS provides bidirectional visibility and blocks cross-tenant writes', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO stemi_activations
         (tenant_id, patient_uid, encounter_id, activation_source,
          door_time_at, activated_at, status, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'clinician',
               NOW(), NOW(), 'activated', $4::jsonb)
       RETURNING id`,
      TENANT_B,
      PATIENT_B,
      ENCOUNTER_B,
      JSON.stringify({ test: `stemi-deep-${RUN}` }),
    );
    tenantBActivationId = Number(rows[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO stemi_pathway_settings (tenant_id, enabled)
       VALUES ($1::uuid, FALSE)`,
      TENANT_B,
    );
    const tenantAEvents = await prisma.$queryRawUnsafe(
      `SELECT id FROM stemi_pathway_events
        WHERE tenant_id = $1::uuid AND activation_id = $2::bigint
        ORDER BY sequence_number
        LIMIT 1`,
      TENANT_A,
      activationId,
    );
    const tenantBEvents = await prisma.$queryRawUnsafe(
      `INSERT INTO stemi_pathway_events
         (tenant_id, activation_id, patient_uid, encounter_id,
          sequence_number, event_type, occurred_at)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid, 1, 'activation', NOW())
       RETURNING id`,
      TENANT_B,
      tenantBActivationId,
      PATIENT_B,
      ENCOUNTER_B,
    );
    const tenantANotifications = await prisma.$queryRawUnsafe(
      `SELECT id FROM stemi_team_notifications
        WHERE tenant_id = $1::uuid AND activation_id = $2::bigint
        ORDER BY id
        LIMIT 1`,
      TENANT_A,
      activationId,
    );
    const tenantBNotifications = await prisma.$queryRawUnsafe(
      `INSERT INTO stemi_team_notifications
         (tenant_id, activation_id, staff_uid, role_code,
          assignment_source, notification_status)
       VALUES ($1::uuid, $2::bigint, $3::uuid, 'CATH_LAB_INCHARGE',
               'on_call_role', 'pending')
       RETURNING id`,
      TENANT_B,
      tenantBActivationId,
      CATH_B_UID,
    );

    const asA = await asAppRole(
      `SELECT id FROM stemi_activations WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[activationId, tenantBActivationId]],
      TENANT_A,
    );
    expect(asA.map((row) => Number(row.id))).toEqual([activationId]);
    const asB = await asAppRole(
      `SELECT id FROM stemi_activations WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[activationId, tenantBActivationId]],
      TENANT_B,
    );
    expect(asB.map((row) => Number(row.id))).toEqual([tenantBActivationId]);

    const eventIds = [tenantAEvents[0].id, tenantBEvents[0].id];
    const eventsAsA = await asAppRole(
      `SELECT id FROM stemi_pathway_events WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [eventIds],
      TENANT_A,
    );
    expect(eventsAsA.map((row) => row.id)).toEqual([tenantAEvents[0].id]);
    const eventsAsB = await asAppRole(
      `SELECT id FROM stemi_pathway_events WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [eventIds],
      TENANT_B,
    );
    expect(eventsAsB.map((row) => row.id)).toEqual([tenantBEvents[0].id]);

    const notificationIds = [
      Number(tenantANotifications[0].id),
      Number(tenantBNotifications[0].id),
    ];
    const notificationsAsA = await asAppRole(
      `SELECT id FROM stemi_team_notifications WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [notificationIds],
      TENANT_A,
    );
    expect(notificationsAsA.map((row) => Number(row.id))).toEqual([notificationIds[0]]);
    const notificationsAsB = await asAppRole(
      `SELECT id FROM stemi_team_notifications WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [notificationIds],
      TENANT_B,
    );
    expect(notificationsAsB.map((row) => Number(row.id))).toEqual([notificationIds[1]]);

    const settingsAsA = await asAppRole(
      `SELECT tenant_id FROM stemi_pathway_settings
        WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id`,
      [[TENANT_A, TENANT_B]],
      TENANT_A,
    );
    expect(settingsAsA.map((row) => row.tenant_id)).toEqual([TENANT_A]);
    const settingsAsB = await asAppRole(
      `SELECT tenant_id FROM stemi_pathway_settings
        WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id`,
      [[TENANT_A, TENANT_B]],
      TENANT_B,
    );
    expect(settingsAsB.map((row) => row.tenant_id)).toEqual([TENANT_B]);

    await expect(asAppRole(
      `INSERT INTO stemi_activations
         (tenant_id, patient_uid, encounter_id, activation_source,
          door_time_at, activated_at, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'clinician', NOW(), NOW(), 'activated')
       RETURNING id`,
      [TENANT_B, PATIENT_B, ENCOUNTER_B],
      TENANT_A,
    )).rejects.toThrow(/row-level security|violates/i);
  });
});
