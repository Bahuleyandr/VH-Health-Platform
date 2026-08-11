// NL-13 P3 — oncology completion deep journey.
//
// AP malignancy flag -> oncology diagnosis -> owner-sourced staging ->
// tumor board -> recommendation -> chemo-plan link -> CTCAE toxicity,
// with canonical timeline + audit evidence for patient-facing writes.

import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import {
  createOncologyDiagnosis,
  createRegistryExport,
  createStagingRecord,
  createToxicityEvent,
  createTumorBoardCase,
  createTumorBoardMeeting,
  createTumorBoardRecommendation,
  setOncologyCompletionSettings,
  signStagingRecord,
} from '../services/oncology/oncologyCompletionService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = DEFAULT_TENANT_ID;
const PATIENT_UID = 'fa130000-0000-4000-8000-000000000001';
const OTHER_PATIENT_UID = 'fa130000-0000-4000-8000-000000000004';
const DOCTOR_UID = 'fa130000-0000-4000-8000-000000000002';
const PATHOLOGIST_UID = 'fa130000-0000-4000-8000-000000000003';

let priorSettings = null;
let apReportId;
let chemoPlanId;
let chemoCycleId;
let chemoAdministrationId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM oncology_registry_exports WHERE registry_name = 'NL13TEST Registry'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tumor_board_recommendations WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tumor_board_cases WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tumor_board_meetings WHERE service_line = 'NL13TEST Oncology'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM oncology_toxicity_events WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    OTHER_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM oncology_staging_records WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM oncology_diagnoses WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE patient_uid IN ($1::uuid, $2::uuid)
        AND source_table IN (
          'oncology_diagnoses',
          'oncology_staging_records',
          'oncology_toxicity_events',
          'tumor_board_cases',
          'tumor_board_recommendations'
        )`,
    PATIENT_UID,
    OTHER_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM chemo_administrations
      WHERE cycle_id IN (
        SELECT id FROM chemo_cycles
         WHERE plan_id IN (SELECT id FROM chemo_treatment_plans WHERE patient_uid = $1::uuid)
      )`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM chemo_cycles
      WHERE plan_id IN (SELECT id FROM chemo_treatment_plans WHERE patient_uid = $1::uuid)`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM chemo_treatment_plans WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM chemo_protocol_drugs
      WHERE protocol_id IN (SELECT id FROM chemo_protocols WHERE code = 'NL13TEST')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM chemo_protocols WHERE code = 'NL13TEST'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ap_reports
      WHERE ap_case_id IN (SELECT id FROM ap_cases WHERE patient_uid = $1::uuid)`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ap_cases WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
    PATHOLOGIST_UID,
    OTHER_PATIENT_UID,
  ).catch(() => {});
}

async function seedFixture() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES
       ($1::uuid, '9199130001', 'NL13TEST Patient', 'PATIENT', true, $5::uuid, NOW()),
       ($2::uuid, '9199130002', 'NL13TEST Doctor', 'DOCTOR', true, $5::uuid, NOW()),
       ($3::uuid, '9199130003', 'NL13TEST Pathologist', 'PATHOLOGIST', true, $5::uuid, NOW()),
       ($4::uuid, '9199130004', 'NL13TEST Other Patient', 'PATIENT', true, $5::uuid, NOW())
     ON CONFLICT (uid) DO UPDATE SET
       phone = EXCLUDED.phone,
       name = EXCLUDED.name,
       role = EXCLUDED.role,
       is_active = true,
       tenant_id = EXCLUDED.tenant_id,
       updated_at = NOW()`,
    PATIENT_UID,
    DOCTOR_UID,
    PATHOLOGIST_UID,
    OTHER_PATIENT_UID,
    TENANT_ID,
  );

  const apCase = await prisma.$queryRawUnsafe(
    `INSERT INTO ap_cases
       (tenant_id, case_number, patient_uid, case_kind, priority, status,
        clinical_history, accessioned_by)
     VALUES ($1::uuid, 'NL13TEST-AP-1', $2::uuid, 'histopathology', 'urgent',
             'signed', 'Breast mass biopsy', $3::uuid)
     RETURNING id`,
    TENANT_ID,
    PATIENT_UID,
    PATHOLOGIST_UID,
  );

  const apReport = await prisma.$queryRawUnsafe(
    `INSERT INTO ap_reports
       (tenant_id, ap_case_id, report_status, diagnosis_text, synoptic_fields,
        malignancy_flag, report_author_uid, signed_at, signed_by)
     VALUES ($1::uuid, $2::bigint, 'final', 'NL13TEST invasive carcinoma',
             $3::jsonb, 'malignant', $4::uuid, NOW(), $4::uuid)
     RETURNING id`,
    TENANT_ID,
    apCase[0].id,
    JSON.stringify({ tumor_site: 'breast', diagnosis: 'invasive carcinoma' }),
    PATHOLOGIST_UID,
  );
  apReportId = Number(apReport[0].id);

  const protocol = await prisma.$queryRawUnsafe(
    `INSERT INTO chemo_protocols
       (tenant_id, code, name, indication, cycle_length_days, total_cycles,
        status, reference, created_by)
     VALUES ($1::uuid, 'NL13TEST', 'NL13TEST Protocol', 'Breast carcinoma',
             21, 4, 'active', 'owner supplied', $2::uuid)
     RETURNING id`,
    TENANT_ID,
    DOCTOR_UID,
  );
  const drug = await prisma.$queryRawUnsafe(
    `INSERT INTO chemo_protocol_drugs
       (protocol_id, drug_name, dose_per_m2, dose_unit, route, days_of_cycle, sequence)
     VALUES ($1::int, 'nl13test-drug', 60, 'mg', 'IV', ARRAY[1], 1)
     RETURNING id`,
    protocol[0].id,
  );
  const plan = await prisma.$queryRawUnsafe(
    `INSERT INTO chemo_treatment_plans
       (tenant_id, patient_uid, protocol_id, indication, planned_cycles,
        height_cm, weight_kg, bsa_m2, start_date, created_by)
     VALUES ($1::uuid, $2::uuid, $3::int, 'Breast carcinoma', 4,
             165, 62, 1.68, CURRENT_DATE, $4::uuid)
     RETURNING id`,
    TENANT_ID,
    PATIENT_UID,
    protocol[0].id,
    DOCTOR_UID,
  );
  chemoPlanId = Number(plan[0].id);
  const cycle = await prisma.$queryRawUnsafe(
    `INSERT INTO chemo_cycles
       (tenant_id, plan_id, cycle_number, scheduled_date, weight_kg, bsa_m2, created_by)
     VALUES ($1::uuid, $2::int, 1, CURRENT_DATE, 62, 1.68, $3::uuid)
     RETURNING id`,
    TENANT_ID,
    chemoPlanId,
    DOCTOR_UID,
  );
  chemoCycleId = Number(cycle[0].id);
  const admin = await prisma.$queryRawUnsafe(
    `INSERT INTO chemo_administrations
       (tenant_id, cycle_id, protocol_drug_id, drug_name, calculated_dose,
        final_dose, dose_unit, route, status)
     VALUES ($1::uuid, $2::int, $3::int, 'nl13test-drug', 100.8,
             100.8, 'mg', 'IV', 'pending')
     RETURNING id`,
    TENANT_ID,
    chemoCycleId,
    drug[0].id,
  );
  chemoAdministrationId = Number(admin[0].id);
}

d('NL-13 P3 oncology completion deep chain', () => {
  beforeAll(async () => {
    const settings = await prisma.$queryRawUnsafe(
      `SELECT *
         FROM oncology_completion_settings
        WHERE tenant_id = $1::uuid`,
      TENANT_ID,
    ).catch(() => []);
    priorSettings = settings[0] || null;
    await cleanup();
    await seedFixture();
    await setOncologyCompletionSettings({
      tenantId: TENANT_ID,
      enabled: true,
      ownerSourcePolicyRef: 'NL13TEST owner-source policy',
      tumorBoardQuorumPolicyRef: 'NL13TEST quorum policy',
      acceptanceSnapshot: { test: 'nl13-p3' },
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' });
  });

  afterAll(async () => {
    await cleanup();
    await setOncologyCompletionSettings({
      tenantId: TENANT_ID,
      enabled: priorSettings?.enabled === true,
      ownerSourcePolicyRef: priorSettings?.owner_source_policy_ref || null,
      tumorBoardQuorumPolicyRef: priorSettings?.tumor_board_quorum_policy_ref || null,
      acceptanceSnapshot: priorSettings?.acceptance_snapshot || null,
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  test('AP malignancy flag feeds diagnosis, staging, tumor board, recommendation, toxicity, and canonical evidence', async () => {
    const diagnosis = await createOncologyDiagnosis({
      tenantId: TENANT_ID,
      pathologyReportId: apReportId,
      cancerSite: 'Breast',
      diagnosisDate: '2026-07-09',
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' });
    expect(diagnosis.patient_uid).toBe(PATIENT_UID);
    expect(Number(diagnosis.pathology_report_id)).toBe(apReportId);
    expect(diagnosis.malignancy_flag).toBe('malignant');

    const unsigned = await createStagingRecord(diagnosis.id, {
      tenantId: TENANT_ID,
      tCategory: 'cT2',
      nCategory: 'cN1',
      mCategory: 'M0',
      clinicalStage: 'owner supplied stage label',
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' });
    await expect(signStagingRecord(unsigned.id, {
      tenantId: TENANT_ID,
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' })).rejects.toThrow(/Owner-sourced/);

    const staging = await createStagingRecord(diagnosis.id, {
      tenantId: TENANT_ID,
      tCategory: 'cT2',
      nCategory: 'cN1',
      mCategory: 'M0',
      clinicalStage: 'owner supplied stage label',
      ajccEdition: 'AJCC owner edition',
      stagingSource: 'Hospital supplied staging reference',
      stagingSourceVersion: '2026-07',
      stagingSourceAttachmentRefs: [{ ref: 'owner://ajcc-license-evidence' }],
      verify: true,
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' });
    expect(staging.verification_status).toBe('verified');

    const meeting = await createTumorBoardMeeting({
      tenantId: TENANT_ID,
      serviceLine: 'NL13TEST Oncology',
      meetingDate: '2026-07-10T09:00:00.000Z',
      chairUid: DOCTOR_UID,
      attendeeUids: [DOCTOR_UID, PATHOLOGIST_UID],
      quorumReference: 'NL13TEST quorum policy',
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' });
    expect(meeting.status).toBe('scheduled');

    const boardCase = await createTumorBoardCase({
      tenantId: TENANT_ID,
      diagnosisId: diagnosis.id,
      meetingId: meeting.id,
      stagingRecordId: staging.id,
      question: 'Confirm systemic therapy sequence',
      priority: 'urgent',
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' });
    expect(boardCase.discussion_state).toBe('queued');

    const [{ due_date: recommendationDueDate }] = await prisma.$queryRawUnsafe(
      `SELECT (CURRENT_DATE + INTERVAL '7 days')::date::text AS due_date`,
    );
    const recommendation = await createTumorBoardRecommendation(boardCase.id, {
      tenantId: TENANT_ID,
      recommendationType: 'systemic_therapy',
      recommendationText: 'Proceed with owner-approved protocol after consent review',
      dueDate: recommendationDueDate,
      chemoPlanId,
      responsibleOwnerUid: DOCTOR_UID,
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' });
    expect(Number(recommendation.chemo_plan_id)).toBe(chemoPlanId);

    await expect(createToxicityEvent({
      tenantId: TENANT_ID,
      patientUid: OTHER_PATIENT_UID,
      diagnosisId: diagnosis.id,
      toxicityTerm: 'Nausea',
      ctcaeGrade: 2,
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' }))
      .rejects.toMatchObject({ code: 'ONCOLOGY_TOXICITY_PATIENT_MISMATCH' });

    await expect(createToxicityEvent({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      diagnosisId: diagnosis.id,
      toxicityTerm: 'Neuropathy',
      ctcaeGrade: 2,
      signoff: true,
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' })).rejects.toThrow(/Owner-sourced/);

    const toxicity = await createToxicityEvent({
      tenantId: TENANT_ID,
      diagnosisId: diagnosis.id,
      toxicityTerm: 'Neuropathy',
      ctcaeGrade: 2,
      ctcaeSource: 'Hospital supplied CTCAE reference',
      ctcaeSourceVersion: 'v5.0-owner',
      actionTaken: 'monitor',
      chemoPlanId,
      chemoCycleId,
      chemoAdministrationId,
      signoff: true,
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' });
    expect(toxicity.signoff_status).toBe('signed');
    expect(Number(toxicity.chemo_cycle_id)).toBe(chemoCycleId);

    const registry = await createRegistryExport({
      tenantId: TENANT_ID,
      registryName: 'NL13TEST Registry',
      exportPeriodStart: '2026-07-01',
      exportPeriodEnd: '2026-07-31',
      evidenceRefs: [{ diagnosis_id: diagnosis.id }],
      rowCount: 1,
    }, { actorUid: DOCTOR_UID, actorRole: 'DOCTOR' });
    expect(registry.clinical_audit_event_id).toBeTruthy();

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, source_table, source_id
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND source_table IN (
            'oncology_diagnoses',
            'oncology_staging_records',
            'oncology_toxicity_events',
            'tumor_board_cases',
            'tumor_board_recommendations'
          )
        ORDER BY occurred_at, created_at`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(timeline.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      'oncology.diagnosis_created',
      'oncology.staging_verified',
      'oncology.tumor_board_case_created',
      'oncology.tumor_board_recommendation_created',
      'oncology.toxicity_signed',
    ]));

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, resource_table
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND (
            patient_uid = $2::uuid
            OR resource_table = 'oncology_registry_exports'
          )
          AND resource_table IN (
            'oncology_diagnoses',
            'oncology_staging_records',
            'oncology_toxicity_events',
            'tumor_board_cases',
            'tumor_board_recommendations',
            'oncology_registry_exports'
          )`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(audit.map((row) => row.resource_table)).toEqual(expect.arrayContaining([
      'oncology_diagnoses',
      'oncology_staging_records',
      'tumor_board_cases',
      'tumor_board_recommendations',
      'oncology_toxicity_events',
      'oncology_registry_exports',
    ]));
  });
});
