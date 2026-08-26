import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

const actualCriticalAlertService = await import(
  '../services/lab/labCriticalAlertService.js'
);
let materializedBeforeFailure = null;
let failNextCriticalMaterialization = true;

jest.unstable_mockModule('../services/lab/labCriticalAlertService.js', () => ({
  ...actualCriticalAlertService,
  materializeLabCriticalAlertGeneration: jest.fn(async (args) => {
    const outcome = await actualCriticalAlertService.materializeLabCriticalAlertGeneration(args);
    materializedBeforeFailure = outcome;
    if (outcome.created && failNextCriticalMaterialization) {
      failNextCriticalMaterialization = false;
      throw new Error('late ORU materializer failure (injected)');
    }
    return outcome;
  }),
}));

const { default: prisma } = await import('../lib/prisma.js');
const { ingestOruMessage } = await import('../services/lab/labResultsService.js');
const { cleanupGovernedOruFixture, seedActiveLabThresholdPolicy } = await import(
  './helpers/labThresholdGovernanceFixture.js'
);

const describeIfTestDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const ACTOR_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const PATIENT_UID = randomUUID();
const POLICY_AUTHOR_UID = randomUUID();
const POLICY_APPROVER_UID = randomUUID();
const POLICY_ACTIVATOR_UID = randomUUID();
const ANALYZER_CODE = `ORU-ROLLBACK-${RUN_ID}`;
const TEST_CODE = `RB${RUN_ID}`;
const CONTROL_ID = `ROLLBACK-${RUN_ID}`;
let investigationId;
let policyFixture;

function phoneFor(seed) {
  const numeric = Number.parseInt(seed.replaceAll('-', '').slice(0, 8), 16);
  return `+91${String(numeric).padStart(10, '0').slice(-10)}`;
}

function rawMessage() {
  return [
    `MSH|^~\\&|${ANALYZER_CODE}|LAB|VH|VH|20260719120000||ORU^R01|${CONTROL_ID}|P|2.5`,
    `PID|1||${PATIENT_UID}||Patient^Rollback`,
    `OBR|1|VHINV-${investigationId}||${TEST_CODE}^Rollback critical`,
    `OBX|1|NM|${TEST_CODE}^Rollback critical||7.2|mmol/L|3.5-5.1|HH|||F`,
  ].join('\r');
}

describeIfTestDb('HL7 ORU late-failure transaction rollback', () => {
  beforeAll(async () => {
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5, 'ORU Rollback Actor', 'LAB_STAFF', true, 'active', NOW()),
         ($2::uuid, $4::uuid, $6, 'ORU Rollback Doctor', 'DOCTOR', true, 'active', NOW()),
         ($3::uuid, $4::uuid, $7, 'ORU Rollback Patient', 'PATIENT', true, 'active', NOW())
       RETURNING id, uid, role`,
      ACTOR_UID,
      DOCTOR_UID,
      PATIENT_UID,
      TENANT_ID,
      phoneFor(ACTOR_UID),
      phoneFor(DOCTOR_UID),
      phoneFor(PATIENT_UID),
    );
    const patientId = users.find(row => row.role === 'PATIENT').id;
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5, 'ORU Rollback Policy Author', 'ADMIN', true, 'active', NOW()),
         ($2::uuid, $4::uuid, $6, 'ORU Rollback Policy Approver', 'PATHOLOGIST', true, 'active', NOW()),
         ($3::uuid, $4::uuid, $7, 'ORU Rollback Policy Activator', 'SUPER_ADMIN', true, 'active', NOW())`,
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
      facilityCode: `oru-rollback-policy-${RUN_ID.toLowerCase()}`,
      facilityName: `ORU rollback governed-policy facility ${RUN_ID}`,
      authorUid: POLICY_AUTHOR_UID,
      approverUid: POLICY_APPROVER_UID,
      activatorUid: POLICY_ACTIVATOR_UID,
      sourceReference: `ORU-ROLLBACK-${RUN_ID}`,
      metadata: { test_fixture: 'lab-oru-ingest-rollback-deep' },
      entries: [{
        testCode: TEST_CODE,
        testName: `${TEST_CODE} rollback critical`,
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
       VALUES ($1::uuid, $4::int, $2, $2, 'hl7', 'active',
               jsonb_build_object('hl7_actor_uids', jsonb_build_array($3::text)),
               NOW(), NOW())`,
      TENANT_ID,
      ANALYZER_CODE,
      ACTOR_UID,
      policyFixture.facilityId,
    );
    const investigations = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (tenant_id, patient_id, patient_uid, phone, test_name, test_code, test_type,
          status, priority, requested_by, requested_at, updated_at)
        VALUES ($1::uuid, $2::int, $3::uuid, $4, $5, $6, 'blood',
                'REQUESTED', 'STAT', $7::uuid, NOW(), NOW())
        RETURNING id`,
      TENANT_ID,
      patientId,
      PATIENT_UID,
      phoneFor(PATIENT_UID),
      `${TEST_CODE} rollback critical`,
      TEST_CODE,
      DOCTOR_UID,
    );
    investigationId = Number(investigations[0].id);
  }, 30000);

  afterAll(async () => {
    try {
      await cleanupGovernedOruFixture({
        tenantId: TENANT_ID,
        analyzerCodes: [ANALYZER_CODE],
        userUids: [
          ACTOR_UID,
          DOCTOR_UID,
          PATIENT_UID,
          POLICY_AUTHOR_UID,
          POLICY_APPROVER_UID,
          POLICY_ACTIVATOR_UID,
        ],
        facilityIds: [policyFixture?.facilityId],
        investigationIds: [investigationId],
      });
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it('rolls back claim, result, critical alert, task, SLA, canonical pair, and order advance after the real materializer writes', async () => {
    await expect(ingestOruMessage(rawMessage(), {
      tenantId: TENANT_ID,
      actorUid: ACTOR_UID,
      actorRole: 'LAB_STAFF',
      actorRoles: ['LAB_STAFF'],
    })).rejects.toThrow('late ORU materializer failure (injected)');

    expect(materializedBeforeFailure).toMatchObject({
      created: true,
      state: 'critical',
      alert: { patient_uid: PATIENT_UID },
      task: { assignedToUid: DOCTOR_UID },
      result: {
        criticality_status: 'critical',
        facility_id: policyFixture.facilityId,
        threshold_policy_bundle_id: policyFixture.bundleId,
        threshold_policy_rule_id: policyFixture.policyRules.get(TEST_CODE),
        threshold_catalog_entry_id: policyFixture.catalogEntries.get(TEST_CODE),
      },
    });
    const attemptedResultId = Number(materializedBeforeFailure.alert.result_id);
    const attemptedAlertId = Number(materializedBeforeFailure.alert.id);
    const attemptedTaskId = Number(materializedBeforeFailure.task.taskId);
    const attemptedSlaId = String(materializedBeforeFailure.task.slaInstanceId);

    const counts = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM lab_oru_ingest_messages
           WHERE tenant_id = $1::uuid AND trusted_sender_identity = $2
             AND message_control_id = $3) AS claims,
         (SELECT COUNT(*)::int FROM lab_results
           WHERE tenant_id = $1::uuid AND id = $4::int) AS results,
         (SELECT COUNT(*)::int FROM lab_critical_alerts
           WHERE tenant_id = $1::uuid AND id = $5::int) AS alerts,
         (SELECT COUNT(*)::int FROM tasks
           WHERE tenant_id = $1::uuid AND id = $6::int) AS tasks,
         (SELECT COUNT(*)::int FROM workflow_sla_instances
           WHERE tenant_id = $1::uuid AND id = $7::uuid) AS slas,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid AND source_table = 'lab_results'
             AND source_id = $4::text) AS timelines,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid AND resource_table = 'lab_results'
             AND resource_id = $4::text) AS audits`,
      TENANT_ID,
      ANALYZER_CODE,
      CONTROL_ID,
      attemptedResultId,
      attemptedAlertId,
      attemptedTaskId,
      attemptedSlaId,
    );
    expect(counts[0]).toEqual({
      claims: 0,
      results: 0,
      alerts: 0,
      tasks: 0,
      slas: 0,
      timelines: 0,
      audits: 0,
    });
    const investigations = await prisma.$queryRawUnsafe(
      `SELECT status, result_uploaded_at
         FROM investigations
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_ID,
      investigationId,
    );
    expect(investigations[0]).toMatchObject({ status: 'REQUESTED', result_uploaded_at: null });

    const retry = await ingestOruMessage(rawMessage(), {
      tenantId: TENANT_ID,
      actorUid: ACTOR_UID,
      actorRole: 'LAB_STAFF',
      actorRoles: ['LAB_STAFF'],
    });
    expect(retry).toMatchObject({
      replayed: false,
      bookingId: null,
      investigationId,
    });
    expect(retry.results).toHaveLength(1);
    expect(retry.results[0]).toMatchObject({
      is_critical: true,
      criticality_status: 'critical',
      facility_id: policyFixture.facilityId,
      threshold_policy_bundle_id: policyFixture.bundleId,
      threshold_policy_rule_id: policyFixture.policyRules.get(TEST_CODE),
      threshold_catalog_entry_id: policyFixture.catalogEntries.get(TEST_CODE),
    });
    expect(retry.alerts).toHaveLength(1);

    const committed = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM lab_oru_ingest_messages
           WHERE tenant_id = $1::uuid AND trusted_sender_identity = $2
             AND message_control_id = $3 AND status = 'completed') AS claims,
         (SELECT COUNT(*)::int FROM lab_results
           WHERE tenant_id = $1::uuid AND performed_by_lab = $2
             AND hl7_message_id = $3) AS results,
         (SELECT COUNT(*)::int FROM lab_critical_alerts AS alert
           JOIN lab_results AS result ON result.tenant_id = alert.tenant_id
             AND result.id = alert.result_id
          WHERE result.tenant_id = $1::uuid AND result.performed_by_lab = $2
            AND result.hl7_message_id = $3) AS alerts,
         (SELECT COUNT(*)::int FROM tasks AS task
           JOIN lab_results AS result ON result.tenant_id = task.tenant_id
             AND task.related_resource_type = 'lab_result'
             AND task.related_resource_id = result.id::text
          WHERE result.tenant_id = $1::uuid AND result.performed_by_lab = $2
            AND result.hl7_message_id = $3) AS tasks,
         (SELECT COUNT(*)::int FROM workflow_sla_instances AS sla
           JOIN lab_results AS result ON result.tenant_id = sla.tenant_id
             AND sla.source_table = 'lab_result' AND sla.source_id = result.id::text
          WHERE result.tenant_id = $1::uuid AND result.performed_by_lab = $2
            AND result.hl7_message_id = $3) AS slas`,
      TENANT_ID,
      ANALYZER_CODE,
      CONTROL_ID,
    );
    expect(committed[0]).toEqual({ claims: 1, results: 1, alerts: 1, tasks: 1, slas: 1 });
  }, 30000);
});
