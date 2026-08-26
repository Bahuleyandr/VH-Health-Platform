import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';

import prisma from '../lib/prisma.js';
import { parseHL7 } from '../services/hl7/hl7Parser.js';
import { ingestOruMessage } from '../services/lab/labResultsService.js';
import {
  cleanupGovernedOruFixture,
  seedActiveLabThresholdPolicy,
} from './helpers/labThresholdGovernanceFixture.js';
import { authClient } from './testClient.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfTestDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const ACTOR_A = randomUUID();
const ACTOR_B = randomUUID();
const DOCTOR_UID = randomUUID();
const PATIENT_UID = randomUUID();
const POLICY_AUTHOR_UID = randomUUID();
const POLICY_APPROVER_UID = randomUUID();
const POLICY_ACTIVATOR_UID = randomUUID();
const ANALYZER_A = `ORU-${RUN_ID}-A`;
const ANALYZER_B = `ORU-${RUN_ID}-B`;
const CLIENT_A = 71_000_000 + Number.parseInt(RUN_ID.slice(0, 5), 16);
const CLIENT_B = CLIENT_A + 1;
const CRITICAL_TEST_CODE = `CRIT${RUN_ID}`;
const COLLISION_TEST_CODE = `COLL${RUN_ID}`;
let criticalInvestigationId;
let collisionInvestigationId;
let collidingBookingInvestigationId;
let unstructuredInvestigationId;
let policyFixture;

function phoneFor(seed) {
  const numeric = Number.parseInt(seed.replaceAll('-', '').slice(0, 8), 16);
  return `+91${String(numeric).padStart(10, '0').slice(-10)}`;
}

function messageFor({
  sender = ANALYZER_A,
  patientUid = PATIENT_UID,
  controlId,
  testCode = `K${RUN_ID}`,
  obrTestCode = testCode,
  obxTestCode = testCode,
  value = '4.1',
  placerOrderId = null,
  extraSegments = [],
} = {}) {
  return [
    `MSH|^~\\&|${sender}|LAB|VH|VH|20260719120000||ORU^R01|${controlId}|P|2.5`,
    `PID|1||${patientUid}||Patient^ORU`,
    `OBR|1|${placerOrderId ?? ''}||${obrTestCode}^Integration test`,
    ...extraSegments,
    `OBX|1|NM|${obxTestCode}^Integration test||${value}|mmol/L|3.5-5.1|N|||F`,
  ].join('\r');
}

async function ingest(message, overrides = {}) {
  return ingestOruMessage(message, {
    tenantId: TENANT_ID,
    actorUid: ACTOR_A,
    actorRole: 'LAB_STAFF',
    actorRoles: ['LAB_STAFF'],
    ...overrides,
  });
}

async function countsFor(sender, controlId) {
  const claims = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM lab_oru_ingest_messages
      WHERE tenant_id = $1::uuid
        AND trusted_sender_identity = $2
        AND message_control_id = $3`,
    TENANT_ID,
    sender,
    controlId,
  );
  const results = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND performed_by_lab = $2
        AND hl7_message_id = $3`,
    TENANT_ID,
    sender,
    controlId,
  );
  return { claims: claims[0].count, results: results[0].count };
}

describeIfTestDb('HL7 ORU atomic ingest and exact replay', () => {
  let firstMessage;
  let firstOutput;

  beforeAll(async () => {
    const tenant = await prisma.$queryRawUnsafe(
      'SELECT id FROM tenants WHERE id = $1::uuid LIMIT 1',
      TENANT_ID,
    );
    if (!tenant[0]) throw new Error(`ORU integration tenant ${TENANT_ID} is missing`);

    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $5::uuid, $6, 'ORU Actor A', 'LAB_STAFF', true, 'active', NOW()),
         ($2::uuid, $5::uuid, $7, 'ORU Actor B', 'LAB_STAFF', true, 'active', NOW()),
         ($3::uuid, $5::uuid, $8, 'ORU Patient', 'PATIENT', true, 'active', NOW()),
         ($4::uuid, $5::uuid, $9, 'ORU Ordering Doctor', 'DOCTOR', true, 'active', NOW())`,
      ACTOR_A,
      ACTOR_B,
      PATIENT_UID,
      DOCTOR_UID,
      TENANT_ID,
      phoneFor(ACTOR_A),
      phoneFor(ACTOR_B),
      phoneFor(PATIENT_UID),
      phoneFor(DOCTOR_UID),
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5, 'ORU Policy Author', 'ADMIN', true, 'active', NOW()),
         ($2::uuid, $4::uuid, $6, 'ORU Policy Approver', 'PATHOLOGIST', true, 'active', NOW()),
         ($3::uuid, $4::uuid, $7, 'ORU Policy Activator', 'SUPER_ADMIN', true, 'active', NOW())`,
      POLICY_AUTHOR_UID,
      POLICY_APPROVER_UID,
      POLICY_ACTIVATOR_UID,
      TENANT_ID,
      phoneFor(POLICY_AUTHOR_UID),
      phoneFor(POLICY_APPROVER_UID),
      phoneFor(POLICY_ACTIVATOR_UID),
    );
    policyFixture = await seedActiveLabThresholdPolicy({
      db: prisma,
      tenantId: TENANT_ID,
      facilityCode: `oru-policy-${RUN_ID.toLowerCase()}`,
      facilityName: `ORU governed-policy facility ${RUN_ID}`,
      authorUid: POLICY_AUTHOR_UID,
      approverUid: POLICY_APPROVER_UID,
      activatorUid: POLICY_ACTIVATOR_UID,
      sourceReference: `ORU-DEEP-${RUN_ID}`,
      metadata: { test_fixture: 'lab-oru-ingest-deep' },
      entries: [{
        testCode: CRITICAL_TEST_CODE,
        testName: `${CRITICAL_TEST_CODE} critical test`,
        specimenType: 'any',
        unit: 'mmol/L',
        referenceLow: 3.5,
        referenceHigh: 5.1,
        criticalLow: 2.5,
        criticalHigh: 6.5,
      }],
    });
    await prisma.$queryRawUnsafe(
      `INSERT INTO lab_analyzers
         (tenant_id, facility_id, analyzer_code, display_name, interface_kind, status, metadata,
          created_at, updated_at)
       VALUES
         ($1::uuid, $8::int, $2, $2, 'hl7', 'active',
          jsonb_build_object('hl7_actor_uids', jsonb_build_array($4::text),
                             'hl7_api_client_ids', jsonb_build_array($6::text)),
          NOW(), NOW()),
         ($1::uuid, $8::int, $3, $3, 'hl7', 'active',
          jsonb_build_object('hl7_actor_uids', jsonb_build_array($5::text),
                             'hl7_api_client_ids', jsonb_build_array($7::text)),
          NOW(), NOW())`,
      TENANT_ID,
      ANALYZER_A,
      ANALYZER_B,
      ACTOR_A,
      ACTOR_B,
      String(CLIENT_A),
      String(CLIENT_B),
      policyFixture.facilityId,
    );

    const patients = await prisma.$queryRawUnsafe(
      `SELECT id FROM users
        WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = 'PATIENT'`,
      TENANT_ID,
      PATIENT_UID,
    );
    const investigations = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (tenant_id, patient_id, patient_uid, phone, test_name, test_code, test_type,
          status, priority, requested_by, requested_at, updated_at, results)
        VALUES ($1::uuid, $2::int, $3::uuid, $4, $5::text, $6::text, 'blood',
                'REQUESTED', 'STAT', $7::uuid, NOW(), NOW(),
                jsonb_build_array(jsonb_build_object(
                  'test_code', $6,
                  'name', $5,
                  'value', '4.1',
                  'unit', 'mmol/L',
                  'reference_range', '3.5-5.1',
                  'status', 'F'
                )))
        RETURNING id`,
      TENANT_ID,
      patients[0].id,
      PATIENT_UID,
      phoneFor(PATIENT_UID),
      `${CRITICAL_TEST_CODE} critical test`,
      CRITICAL_TEST_CODE,
      DOCTOR_UID,
    );
    criticalInvestigationId = Number(investigations[0].id);

    const freeIds = await prisma.$queryRawUnsafe(
      `SELECT candidate::int AS id
         FROM generate_series(1800000000, 1800000999) AS candidate
        WHERE NOT EXISTS (SELECT 1 FROM investigations WHERE id = candidate::int)
          AND NOT EXISTS (SELECT 1 FROM investigation_bookings WHERE id = candidate::bigint)
        LIMIT 1`,
    );
    if (!freeIds[0]) throw new Error('No collision fixture id is available');
    collisionInvestigationId = Number(freeIds[0].id);
    const collisionInvestigations = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (id, tenant_id, patient_id, patient_uid, phone, test_name, test_code, test_type,
          status, priority, requested_by, requested_at, updated_at)
       VALUES
         ($1::int, $2::uuid, $3::int, $4::uuid, $5, $6, $7, 'blood',
          'REQUESTED', 'ROUTINE', $8::uuid, NOW(), NOW()),
         (DEFAULT, $2::uuid, $3::int, $4::uuid, $5, $9, $10, 'blood',
          'REQUESTED', 'ROUTINE', $8::uuid, NOW(), NOW())
       RETURNING id, test_code`,
      collisionInvestigationId,
      TENANT_ID,
      patients[0].id,
      PATIENT_UID,
      phoneFor(PATIENT_UID),
      `${COLLISION_TEST_CODE} collision target`,
      COLLISION_TEST_CODE,
      DOCTOR_UID,
      `OTHER${RUN_ID} colliding booking target`,
      `OTHER${RUN_ID}`,
    );
    collidingBookingInvestigationId = Number(
      collisionInvestigations.find(row => row.test_code === `OTHER${RUN_ID}`).id,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_bookings
         (id, tenant_id, patient_id, investigation_id, selected_tests, actual_tests,
          status, updated_at)
       VALUES ($1::bigint, $2::uuid, $3::int, $4::int,
               '{}'::int[], '{}'::int[], 'BOOKED', NOW())`,
      collisionInvestigationId,
      TENANT_ID,
      patients[0].id,
      collidingBookingInvestigationId,
    );
    const unstructuredInvestigations = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (tenant_id, patient_id, patient_uid, phone, test_name, test_type,
          status, priority, requested_by, requested_at, updated_at, results)
       VALUES ($1::uuid, $2::int, $3::uuid, $4, 'Legacy unstructured test', 'blood',
               'REQUESTED', 'ROUTINE', $5::uuid, NOW(), NOW(),
               '[{"name":"Legacy result","value":"4.1"}]'::jsonb)
       RETURNING id`,
      TENANT_ID,
      patients[0].id,
      PATIENT_UID,
      phoneFor(PATIENT_UID),
      DOCTOR_UID,
    );
    unstructuredInvestigationId = Number(unstructuredInvestigations[0].id);
  }, 30000);

  afterAll(async () => {
    try {
      await cleanupGovernedOruFixture({
        tenantId: TENANT_ID,
        analyzerCodes: [ANALYZER_A, ANALYZER_B],
        userUids: [
          ACTOR_A,
          ACTOR_B,
          DOCTOR_UID,
          PATIENT_UID,
          POLICY_AUTHOR_UID,
          POLICY_APPROVER_UID,
          POLICY_ACTIVATOR_UID,
        ],
        facilityIds: [policyFixture?.facilityId],
        investigationIds: [
          criticalInvestigationId,
          collisionInvestigationId,
          collidingBookingInvestigationId,
          unstructuredInvestigationId,
        ],
        bookingIds: [collisionInvestigationId],
      });
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it('commits the immutable claim, exact raw OBX, generated hash, result, and canonical pair together', async () => {
    const controlId = `BASE-${RUN_ID}`;
    firstMessage = messageFor({ controlId });
    firstOutput = await ingest(firstMessage);

    expect(firstOutput).toMatchObject({
      messageControlId: controlId,
      replayed: false,
      bookingId: null,
    });
    expect(firstOutput.results).toHaveLength(1);
    expect(firstOutput.alerts).toHaveLength(0);
    expect(firstOutput.messageSha256).toBe(
      createHash('sha256').update(firstMessage).digest('hex'),
    );

    const durable = await prisma.$queryRawUnsafe(
      `SELECT claim.status, claim.raw_message, claim.message_sha256,
              claim.result_ids, claim.authenticated_actor_uid,
              claim.authenticated_actor_roles, claim.sender_binding_mode,
              claim.sender_binding_identity,
              result.id AS result_id, result.raw_obx, result.patient_uid,
              result.oru_ingest_message_id::text AS oru_ingest_message_id,
              result.is_critical,
              (SELECT COUNT(*)::int FROM clinical_timeline_events AS timeline
                WHERE timeline.tenant_id = result.tenant_id
                  AND timeline.source_table = 'lab_results'
                  AND timeline.source_id = result.id::text
                  AND timeline.event_type = 'lab.result_recorded') AS timeline_count,
              (SELECT COUNT(*)::int FROM clinical_audit_events AS audit
                WHERE audit.tenant_id = result.tenant_id
                  AND audit.resource_table = 'lab_results'
                  AND audit.resource_id = result.id::text
                  AND audit.action = 'lab.result_recorded') AS audit_count
         FROM lab_oru_ingest_messages AS claim
         JOIN lab_results AS result
           ON result.tenant_id = claim.tenant_id
          AND result.oru_ingest_message_id = claim.id
        WHERE claim.tenant_id = $1::uuid
          AND claim.trusted_sender_identity = $2
          AND claim.message_control_id = $3`,
      TENANT_ID,
      ANALYZER_A,
      controlId,
    );
    expect(durable).toHaveLength(1);
    expect(durable[0]).toMatchObject({
      status: 'completed',
      raw_message: firstMessage,
      message_sha256: createHash('sha256').update(firstMessage).digest('hex'),
      authenticated_actor_uid: ACTOR_A,
      authenticated_actor_roles: ['LAB_STAFF'],
      sender_binding_mode: 'actor_uid',
      sender_binding_identity: ACTOR_A,
      patient_uid: PATIENT_UID,
      oru_ingest_message_id: firstOutput.claimId,
      is_critical: false,
      timeline_count: 1,
      audit_count: 1,
    });
    expect(durable[0].result_ids.map(Number)).toEqual([Number(durable[0].result_id)]);
    expect(durable[0].raw_obx).toBe(firstMessage.split('\r').at(-1));
  }, 30000);

  it('replays the exact raw message to the same result without duplicate canonical evidence', async () => {
    const replay = await ingest(firstMessage);

    expect(replay.replayed).toBe(true);
    expect(replay.claimId).toBe(firstOutput.claimId);
    expect(replay.results.map(row => Number(row.id)))
      .toEqual(firstOutput.results.map(row => Number(row.id)));
    expect(await countsFor(ANALYZER_A, firstOutput.messageControlId))
      .toEqual({ claims: 1, results: 1 });

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND source_table = 'lab_results'
          AND source_id = $2`,
      TENANT_ID,
      String(firstOutput.results[0].id),
    );
    expect(timeline[0].count).toBe(1);
  });

  it('adopts one exact pre-migration ORU row and rejects an altered raw replay without duplication', async () => {
    const controlId = `LEGACY-${RUN_ID}`;
    const testCode = `LEG${RUN_ID}`;
    const message = messageFor({ controlId, testCode });
    const rawObx = message.split('\r').at(-1);
    const legacyClient = new Client({ connectionString: databaseUrl });
    let legacyResultId;
    await legacyClient.connect();
    try {
      await legacyClient.query("SET session_replication_role = 'replica'");
      const inserted = await legacyClient.query(
        `INSERT INTO lab_results
           (tenant_id, patient_uid, patient_name, hl7_message_id,
            hl7_segment_index, loinc_code, test_code, test_name, value_text,
            value_numeric, unit, reference_range, abnormal_flag, status,
            is_critical, performed_by_lab, raw_obx, analyzer_id,
            oru_ingest_message_id)
         VALUES ($1::uuid, $2::uuid, 'ORU Patient', $3, 1, NULL, $4,
                 'Integration test', '4.1', 4.1, 'mmol/L', '3.5-5.1', 'N',
                 'final', false, $5, $6, NULL, NULL)
         RETURNING id`,
        [TENANT_ID, PATIENT_UID, controlId, testCode, ANALYZER_A, rawObx],
      );
      legacyResultId = Number(inserted.rows[0].id);
    } finally {
      await legacyClient.query("SET session_replication_role = 'origin'").catch(() => {});
      await legacyClient.end().catch(() => {});
    }

    const adopted = await ingest(message);
    expect(adopted).toMatchObject({ replayed: false, bookingId: null });
    expect(adopted.results.map(result => Number(result.id))).toEqual([legacyResultId]);
    expect(adopted.alerts).toEqual([]);

    const durable = await prisma.$queryRawUnsafe(
      `SELECT claim.id::text AS claim_id, claim.status, claim.legacy_adoption,
              claim.result_ids, result.id AS result_id, result.analyzer_id,
              result.oru_ingest_message_id::text AS result_claim_id,
              (SELECT COUNT(*)::int FROM clinical_timeline_events AS timeline
                WHERE timeline.tenant_id = result.tenant_id
                  AND timeline.source_table = 'lab_results'
                  AND timeline.source_id = result.id::text
                  AND timeline.event_type = 'lab.result_recorded') AS timeline_count,
              (SELECT COUNT(*)::int FROM clinical_audit_events AS audit
                WHERE audit.tenant_id = result.tenant_id
                  AND audit.resource_table = 'lab_results'
                  AND audit.resource_id = result.id::text
                  AND audit.action = 'lab.result_recorded') AS audit_count
         FROM lab_oru_ingest_messages AS claim
         JOIN lab_results AS result
           ON result.tenant_id = claim.tenant_id
          AND result.oru_ingest_message_id = claim.id
        WHERE claim.tenant_id = $1::uuid
          AND claim.trusted_sender_identity = $2
          AND claim.message_control_id = $3`,
      TENANT_ID,
      ANALYZER_A,
      controlId,
    );
    expect(durable).toHaveLength(1);
    expect(durable[0]).toMatchObject({
      status: 'completed',
      legacy_adoption: true,
      result_id: legacyResultId,
      claim_id: adopted.claimId,
      result_claim_id: adopted.claimId,
      timeline_count: 1,
      audit_count: 1,
    });
    expect(durable[0].result_ids.map(Number)).toEqual([legacyResultId]);
    expect(Number(durable[0].analyzer_id)).toBeGreaterThan(0);

    await expect(ingest(message.replace('|4.1|mmol/L|', '|4.2|mmol/L|')))
      .rejects.toMatchObject({ statusCode: 409, code: 'LAB_ORU_REPLAY_CONFLICT' });
    expect(await countsFor(ANALYZER_A, controlId)).toEqual({ claims: 1, results: 1 });
  }, 30000);

  it('rejects altered raw bytes under the same sender/control identity with no extra row', async () => {
    const altered = firstMessage.replace('|4.1|', '|4.2|');

    await expect(ingest(altered)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_ORU_REPLAY_CONFLICT',
    });
    expect(await countsFor(ANALYZER_A, firstOutput.messageControlId))
      .toEqual({ claims: 1, results: 1 });
  });

  it('serializes concurrent identical submissions into one commit and one exact replay', async () => {
    const controlId = `CONCURRENT-${RUN_ID}`;
    const message = messageFor({ controlId, testCode: `NA${RUN_ID}` });
    const outputs = await Promise.all([ingest(message), ingest(message)]);

    expect(outputs.map(output => output.replayed).sort()).toEqual([false, true]);
    expect(new Set(outputs.map(output => output.claimId)).size).toBe(1);
    expect(new Set(outputs.flatMap(output => output.results.map(row => Number(row.id)))).size).toBe(1);
    expect(await countsFor(ANALYZER_A, controlId)).toEqual({ claims: 1, results: 1 });
  }, 30000);

  it('allows the same control ID from a different exact sender principal', async () => {
    const controlId = `CROSS-${RUN_ID}`;
    const fromA = messageFor({ controlId, sender: ANALYZER_A, testCode: `CLA${RUN_ID}` });
    const fromB = messageFor({ controlId, sender: ANALYZER_B, testCode: `CLB${RUN_ID}` });

    const [a, b] = await Promise.all([
      ingest(fromA),
      ingest(fromB, {
        actorUid: ACTOR_B,
        actorRole: 'LAB_STAFF',
        actorRoles: ['LAB_STAFF'],
      }),
    ]);

    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(a.claimId).not.toBe(b.claimId);
    expect(await countsFor(ANALYZER_A, controlId)).toEqual({ claims: 1, results: 1 });
    expect(await countsFor(ANALYZER_B, controlId)).toEqual({ claims: 1, results: 1 });
  }, 30000);

  it('roundtrips the actual generated ORM/ORU VHINV identity and exact analyte contract', async () => {
    const admin = authClient('ADMIN', { tenant_id: TENANT_ID });
    const ormResponse = await admin
      .post('/api/v1/hl7/generate')
      .send({ event_type: 'ORM_O01', investigation_id: criticalInvestigationId });
    expect(ormResponse.statusCode).toBe(200);
    const generatedOrm = parseHL7(ormResponse.text);
    expect(generatedOrm.obr).toMatchObject({
      placerOrderNumber: `VHINV-${criticalInvestigationId}`,
      testCode: `${CRITICAL_TEST_CODE}^${CRITICAL_TEST_CODE} critical test`,
    });

    const oruResponse = await admin
      .post('/api/v1/hl7/generate')
      .send({ event_type: 'ORU_R01', investigation_id: criticalInvestigationId });
    expect(oruResponse.statusCode).toBe(200);
    const generatedOru = parseHL7(oruResponse.text);
    expect(generatedOru.obr).toMatchObject({
      placerOrderNumber: `VHINV-${criticalInvestigationId}`,
      testCode: `${CRITICAL_TEST_CODE}^${CRITICAL_TEST_CODE} critical test`,
    });
    expect(generatedOru.obx[0].observationId)
      .toBe(`${CRITICAL_TEST_CODE}^${CRITICAL_TEST_CODE} critical test`);

    const segments = oruResponse.text.split('\r');
    const msh = segments[0].split('|');
    msh[2] = ANALYZER_A;
    segments[0] = msh.join('|');
    const roundtripMessage = segments.join('\r');
    const first = await ingest(roundtripMessage);
    expect(first).toMatchObject({
      replayed: false,
      bookingId: null,
      investigationId: criticalInvestigationId,
    });
    expect(first.results[0]).toMatchObject({
      booking_id: null,
      investigation_id: criticalInvestigationId,
      test_code: CRITICAL_TEST_CODE,
    });
    const replay = await ingest(roundtripMessage);
    expect(replay).toMatchObject({
      replayed: true,
      claimId: first.claimId,
      bookingId: null,
      investigationId: criticalInvestigationId,
    });
    expect(replay.results.map(result => Number(result.id)))
      .toEqual(first.results.map(result => Number(result.id)));
  }, 30000);

  it('returns a structured 400 when strict local export has no analyte contract', async () => {
    const response = await authClient('ADMIN', { tenant_id: TENANT_ID })
      .post('/api/v1/hl7/generate')
      .send({ event_type: 'ORU_R01', investigation_id: unstructuredInvestigationId });

    expect(response.statusCode).toBe(400);
    expect(response.body?.code).toBe('HL7_LOCAL_ORDER_ANALYTE_CONTRACT_REQUIRED');
    expect(JSON.stringify(response.body)).not.toContain(PATIENT_UID);
  });

  it('commits a critical result with its exact alert, actionable task, active SLA, canonical pair, and completed replay', async () => {
    const controlId = `CRITICAL-${RUN_ID}`;
    const message = messageFor({
      controlId,
      testCode: CRITICAL_TEST_CODE,
      value: '7.2',
      placerOrderId: `VHINV-${criticalInvestigationId}`,
    });
    const output = await ingest(message);

    expect(output).toMatchObject({
      replayed: false,
      bookingId: null,
      investigationId: criticalInvestigationId,
    });
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({
      patient_uid: PATIENT_UID,
      booking_id: null,
      investigation_id: criticalInvestigationId,
      is_critical: true,
      criticality_status: 'critical',
      facility_id: policyFixture.facilityId,
      threshold_policy_bundle_id: policyFixture.bundleId,
      threshold_policy_rule_id: policyFixture.policyRules.get(CRITICAL_TEST_CODE),
      threshold_catalog_entry_id: policyFixture.catalogEntries.get(CRITICAL_TEST_CODE),
    });
    expect(output.alerts).toHaveLength(1);
    expect(output.alerts[0]).toMatchObject({
      threshold_policy_bundle_id: policyFixture.bundleId,
      threshold_policy_rule_id: policyFixture.policyRules.get(CRITICAL_TEST_CODE),
      threshold_catalog_entry_id: policyFixture.catalogEntries.get(CRITICAL_TEST_CODE),
    });

    const evidence = await prisma.$queryRawUnsafe(
      `SELECT claim.status AS claim_status, claim.result_ids,
              claim.critical_result_ids, claim.active_critical_result_ids,
              claim.closed_critical_result_ids, claim.alert_ids,
              claim.task_ids, claim.sla_instance_ids,
              result.id AS result_id, result.is_critical, result.criticality_status,
              result.facility_id,
              result.threshold_policy_bundle_id AS result_policy_bundle_id,
              result.threshold_policy_rule_id AS result_policy_rule_id,
              result.threshold_catalog_entry_id AS result_catalog_entry_id,
              alert.id AS alert_id, alert.acknowledged_at, alert.superseded_at,
              alert.acknowledgement_task_id,
              alert.threshold_policy_bundle_id AS alert_policy_bundle_id,
              alert.threshold_policy_rule_id AS alert_policy_rule_id,
              alert.threshold_catalog_entry_id AS alert_catalog_entry_id,
              task.id AS task_id, task.status AS task_status,
              task.assigned_to_uid, task.assigned_to_role,
              task.sla_completion_semantics, task.completed_at AS task_completed_at,
              sla.id AS sla_id, sla.status AS sla_status, sla.rule_code,
              sla.source_table, sla.source_id, sla.completed_at AS sla_completed_at,
              (SELECT COUNT(*)::int FROM clinical_timeline_events AS timeline
                WHERE timeline.tenant_id = result.tenant_id
                  AND timeline.source_table = 'lab_results'
                  AND timeline.source_id = result.id::text
                  AND timeline.event_type = 'lab.result_recorded') AS timeline_count,
              (SELECT COUNT(*)::int FROM clinical_audit_events AS audit
                WHERE audit.tenant_id = result.tenant_id
                  AND audit.resource_table = 'lab_results'
                  AND audit.resource_id = result.id::text
                  AND audit.action = 'lab.result_recorded') AS audit_count,
              (SELECT COUNT(*)::int FROM clinical_timeline_events AS timeline
                WHERE timeline.tenant_id = result.tenant_id
                  AND timeline.source_table = 'lab_results'
                  AND timeline.source_id = result.id::text
                  AND timeline.event_type = 'lab.result_recorded'
                  AND timeline.payload->'threshold_assessment'->>'policy_bundle_id' = $4::text
                  AND timeline.payload->'threshold_assessment'->>'policy_rule_id' = $5::text
                  AND timeline.payload->'threshold_assessment'->>'catalog_entry_id' = $6::text
                  AND (timeline.payload->'threshold_assessment'->>'facility_id')::int = $7::int)
                AS governed_timeline_count,
              (SELECT COUNT(*)::int FROM clinical_audit_events AS audit
                WHERE audit.tenant_id = result.tenant_id
                  AND audit.resource_table = 'lab_results'
                  AND audit.resource_id = result.id::text
                  AND audit.action = 'lab.result_recorded'
                  AND audit.metadata->'threshold_assessment'->>'policy_bundle_id' = $4::text
                  AND audit.metadata->'threshold_assessment'->>'policy_rule_id' = $5::text
                  AND audit.metadata->'threshold_assessment'->>'catalog_entry_id' = $6::text
                  AND (audit.metadata->'threshold_assessment'->>'facility_id')::int = $7::int)
                AS governed_audit_count
         FROM lab_oru_ingest_messages AS claim
         JOIN lab_results AS result
           ON result.tenant_id = claim.tenant_id
          AND result.oru_ingest_message_id = claim.id
         JOIN lab_critical_alerts AS alert
           ON alert.tenant_id = result.tenant_id
          AND alert.result_id = result.id
          AND alert.superseded_at IS NULL
         JOIN tasks AS task
           ON task.tenant_id = alert.tenant_id
          AND task.id = alert.acknowledgement_task_id
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE claim.tenant_id = $1::uuid
          AND claim.trusted_sender_identity = $2
          AND claim.message_control_id = $3`,
      TENANT_ID,
      ANALYZER_A,
      controlId,
      policyFixture.bundleId,
      policyFixture.policyRules.get(CRITICAL_TEST_CODE),
      policyFixture.catalogEntries.get(CRITICAL_TEST_CODE),
      policyFixture.facilityId,
    );
    expect(evidence).toHaveLength(1);
    const row = evidence[0];
    expect(row).toMatchObject({
      claim_status: 'completed',
      is_critical: true,
      criticality_status: 'critical',
      facility_id: policyFixture.facilityId,
      result_policy_bundle_id: policyFixture.bundleId,
      result_policy_rule_id: policyFixture.policyRules.get(CRITICAL_TEST_CODE),
      result_catalog_entry_id: policyFixture.catalogEntries.get(CRITICAL_TEST_CODE),
      alert_policy_bundle_id: policyFixture.bundleId,
      alert_policy_rule_id: policyFixture.policyRules.get(CRITICAL_TEST_CODE),
      alert_catalog_entry_id: policyFixture.catalogEntries.get(CRITICAL_TEST_CODE),
      acknowledged_at: null,
      superseded_at: null,
      task_status: 'open',
      assigned_to_uid: DOCTOR_UID,
      sla_completion_semantics: 'acknowledgement',
      task_completed_at: null,
      sla_status: 'active',
      rule_code: 'critical_result_ack',
      source_table: 'lab_result',
      source_id: String(row.result_id),
      sla_completed_at: null,
      timeline_count: 1,
      audit_count: 1,
      governed_timeline_count: 1,
      governed_audit_count: 1,
    });
    expect(Number(row.acknowledgement_task_id)).toBe(Number(row.task_id));
    expect(row.result_ids.map(Number)).toEqual([Number(row.result_id)]);
    expect(row.critical_result_ids.map(Number)).toEqual([Number(row.result_id)]);
    expect(row.active_critical_result_ids.map(Number)).toEqual([Number(row.result_id)]);
    expect(row.closed_critical_result_ids).toEqual([]);
    expect(row.alert_ids.map(Number)).toEqual([Number(row.alert_id)]);
    expect(row.task_ids.map(Number)).toEqual([Number(row.task_id)]);
    expect(row.sla_instance_ids.map(String)).toEqual([String(row.sla_id)]);

    const replay = await ingest(message);
    expect(replay.replayed).toBe(true);
    expect(replay.claimId).toBe(output.claimId);
    expect(replay.results.map(result => Number(result.id))).toEqual([Number(row.result_id)]);
    expect(replay.results[0]).toMatchObject({
      criticality_status: 'critical',
      facility_id: policyFixture.facilityId,
      threshold_policy_bundle_id: policyFixture.bundleId,
      threshold_policy_rule_id: policyFixture.policyRules.get(CRITICAL_TEST_CODE),
      threshold_catalog_entry_id: policyFixture.catalogEntries.get(CRITICAL_TEST_CODE),
    });
    expect(replay.alerts.map(alert => Number(alert.id))).toEqual([Number(row.alert_id)]);

    const counts = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM lab_oru_ingest_messages
           WHERE tenant_id = $1::uuid AND trusted_sender_identity = $2
             AND message_control_id = $3) AS claims,
         (SELECT COUNT(*)::int FROM lab_results
           WHERE tenant_id = $1::uuid AND performed_by_lab = $2
             AND hl7_message_id = $3) AS results,
         (SELECT COUNT(*)::int FROM lab_critical_alerts
           WHERE tenant_id = $1::uuid AND result_id = $4::int) AS alerts,
         (SELECT COUNT(*)::int FROM tasks
           WHERE tenant_id = $1::uuid AND related_resource_type = 'lab_result'
             AND related_resource_id = $4::text) AS tasks,
         (SELECT COUNT(*)::int FROM workflow_sla_instances
           WHERE tenant_id = $1::uuid AND source_table = 'lab_result'
             AND source_id = $4::text) AS slas`,
      TENANT_ID,
      ANALYZER_A,
      controlId,
      Number(row.result_id),
    );
    expect(counts[0]).toEqual({ claims: 1, results: 1, alerts: 1, tasks: 1, slas: 1 });
  }, 30000);

  it('rejects a staff UID asserted as PID-3 and rolls the message claim back', async () => {
    const controlId = `STAFF-PID-${RUN_ID}`;
    const message = messageFor({ controlId, patientUid: ACTOR_A, testCode: `STF${RUN_ID}` });

    await expect(ingest(message)).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_SOURCE_MISMATCH',
    });
    expect(await countsFor(ANALYZER_A, controlId)).toEqual({ claims: 0, results: 0 });
  });

  it('links VHINV to the investigation table even when a booking has the same numeric id', async () => {
    const controlId = `COLLISION-${RUN_ID}`;
    const message = messageFor({
      controlId,
      placerOrderId: `VHINV-${collisionInvestigationId}`,
      testCode: COLLISION_TEST_CODE,
    });

    const output = await ingest(message);
    expect(output).toMatchObject({
      replayed: false,
      bookingId: null,
      investigationId: collisionInvestigationId,
    });
    expect(output.results[0]).toMatchObject({
      booking_id: null,
      investigation_id: collisionInvestigationId,
    });
    expect(Number(output.results[0].investigation_id))
      .not.toBe(collidingBookingInvestigationId);
  }, 30000);

  it.each([
    ['OBR mismatch', `WRONG${RUN_ID}`, COLLISION_TEST_CODE],
    ['OBX mismatch', COLLISION_TEST_CODE, `WRONG${RUN_ID}`],
  ])('rejects a same-patient %s without any durable write', async (
    label,
    obrTestCode,
    obxTestCode,
  ) => {
    const controlId = `ANALYTE-${label.replaceAll(' ', '-')}-${RUN_ID}`;
    const message = messageFor({
      controlId,
      placerOrderId: `VHINV-${collisionInvestigationId}`,
      testCode: COLLISION_TEST_CODE,
      obrTestCode,
      obxTestCode,
    });

    await expect(ingest(message)).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_ORU_ORDER_ANALYTE_MISMATCH',
    });
    expect(await countsFor(ANALYZER_A, controlId)).toEqual({ claims: 0, results: 0 });
  }, 30000);

  it('rejects a namespaced local investigation that does not resolve on both first attempt and retry', async () => {
    const controlId = `MISSING-ORDER-${RUN_ID}`;
    const message = messageFor({
      controlId,
      placerOrderId: 'VHINV-2147483000',
      testCode: `MISS${RUN_ID}`,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(ingest(message)).rejects.toMatchObject({
        statusCode: 400,
        code: 'LAB_RESULT_SOURCE_MISMATCH',
      });
      expect(await countsFor(ANALYZER_A, controlId)).toEqual({ claims: 0, results: 0 });
    }
  });

  it('rejects a bare numeric id even when investigation and booking rows collide', async () => {
    const controlId = `BARE-COLLISION-${RUN_ID}`;
    const message = messageFor({
      controlId,
      placerOrderId: String(collisionInvestigationId),
      testCode: COLLISION_TEST_CODE,
    });

    await expect(ingest(message)).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_ORU_ORDER_NAMESPACE_REQUIRED',
    });
    expect(await countsFor(ANALYZER_A, controlId)).toEqual({ claims: 0, results: 0 });
  });

  test.each([
    ['bare positive integer', '42'],
    ['zero', '0'],
    ['negative', '-1'],
    ['overflow', '999999999999999999999999'],
    ['reserved zero', 'VHINV-0'],
    ['reserved leading zero', 'VHINV-01'],
    ['reserved overflow', 'VHINV-2147483648'],
    ['reserved malformed', 'VHINV-'],
    ['reserved underscore typo', 'VHINV_42'],
    ['reserved whitespace typo', 'VHINV 42'],
    ['reserved plus typo', 'VHINV+42'],
    ['reserved missing delimiter', 'VHINV123'],
    ['reserved wrong case', 'vhinv-42'],
    ['unsupported booking namespace', 'VHBOOK-42'],
    ['unsupported booking namespace typo', 'VHBOOK_42'],
  ])('rejects a %s ambiguous or reserved order token before any write', async (_label, placerOrderId) => {
    const controlId = `INVALID-${_label.toUpperCase()}-${RUN_ID}`;
    const message = messageFor({
      controlId,
      placerOrderId,
      testCode: `INV${RUN_ID}`,
    });

    await expect(ingest(message)).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_ORU_ORDER_NAMESPACE_REQUIRED',
    });
    expect(await countsFor(ANALYZER_A, controlId)).toEqual({ claims: 0, results: 0 });
  });

  it('retains a genuinely external alphanumeric order as unlinked shadow data', async () => {
    const controlId = `EXTERNAL-${RUN_ID}`;
    const output = await ingest(messageFor({
      controlId,
      placerOrderId: `EXT-LAB-${RUN_ID}`,
      testCode: `EXT${RUN_ID}`,
    }));

    expect(output).toMatchObject({
      replayed: false,
      bookingId: null,
      investigationId: null,
    });
    expect(output.results[0]).toMatchObject({ booking_id: null, investigation_id: null });
  }, 30000);

  it('rejects a conflicting or unbound DB credential before creating a claim', async () => {
    const conflictingControl = `KEY-CONFLICT-${RUN_ID}`;
    const unboundControl = `KEY-UNBOUND-${RUN_ID}`;

    await expect(ingest(messageFor({ controlId: conflictingControl }), {
      apiClient: 'analyzer-b-client',
      apiClientId: CLIENT_B,
      apiClientTenantId: TENANT_ID,
    })).rejects.toMatchObject({ statusCode: 403, code: 'LAB_ORU_ANALYZER_UNTRUSTED' });
    await expect(ingest(messageFor({ controlId: unboundControl }), {
      apiClient: 'unbound-client',
      apiClientId: CLIENT_B + 100,
      apiClientTenantId: TENANT_ID,
    })).rejects.toMatchObject({ statusCode: 403, code: 'LAB_ORU_ANALYZER_UNTRUSTED' });

    expect(await countsFor(ANALYZER_A, conflictingControl)).toEqual({ claims: 0, results: 0 });
    expect(await countsFor(ANALYZER_A, unboundControl)).toEqual({ claims: 0, results: 0 });
  });

  it('rejects a cross-tenant DB credential before creating a claim', async () => {
    const controlId = `KEY-TENANT-${RUN_ID}`;

    await expect(ingest(messageFor({ controlId }), {
      apiClient: 'analyzer-a-client',
      apiClientId: CLIENT_A,
      apiClientTenantId: randomUUID(),
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'LAB_ORU_API_CLIENT_TENANT_MISMATCH',
    });
    expect(await countsFor(ANALYZER_A, controlId)).toEqual({ claims: 0, results: 0 });
  });

  it('rejects ambiguous observation groups and ORC/OBR disagreement before any DB write', async () => {
    const ambiguousControl = `AMBIG-${RUN_ID}`;
    const mismatchControl = `ORDER-MISMATCH-${RUN_ID}`;
    const ambiguous = [
      `MSH|^~\\&|${ANALYZER_A}|LAB|VH|VH|20260719120000||ORU^R01|${ambiguousControl}|P|2.5`,
      `PID|1||${PATIENT_UID}||Patient^ORU`,
      `PID|2||${PATIENT_UID}||Patient^ORU`,
      `OBR|1|||AMB${RUN_ID}^Ambiguous`,
      `OBX|1|NM|AMB${RUN_ID}^Ambiguous||4.1|mmol/L|3.5-5.1|N|||F`,
    ].join('\r');
    const mismatch = [
      `MSH|^~\\&|${ANALYZER_A}|LAB|VH|VH|20260719120000||ORU^R01|${mismatchControl}|P|2.5`,
      `PID|1||${PATIENT_UID}||Patient^ORU`,
      'ORC|RE|12345',
      `OBR|1|67890||ORD${RUN_ID}^Order mismatch`,
      `OBX|1|NM|ORD${RUN_ID}^Order mismatch||4.1|mmol/L|3.5-5.1|N|||F`,
    ].join('\r');

    await expect(ingest(ambiguous)).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_ORU_AMBIGUOUS_OBSERVATION_GROUP',
    });
    await expect(ingest(mismatch)).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_ORU_ORDER_IDENTITY_MISMATCH',
    });
    expect(await countsFor(ANALYZER_A, ambiguousControl)).toEqual({ claims: 0, results: 0 });
    expect(await countsFor(ANALYZER_A, mismatchControl)).toEqual({ claims: 0, results: 0 });
  });
});
