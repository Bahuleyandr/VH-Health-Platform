// Deep integration tests for anatomic pathology and cytology reporting.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'bc000000-0000-4000-8000-00000000c001';
const DOCTOR_UID = 'bc000000-0000-4000-8000-00000000c002';
const PATHOLOGIST_UID = 'bc000000-0000-4000-8000-00000000c003';
const LAB_STAFF_UID = 'bc000000-0000-4000-8000-00000000c004';
const API_KEY = process.env.API_KEY || 'test-api-key';

function mkClient(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanupPathologyRows() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ap_cases WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_specimens WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
}

async function createSpecimen({ suffix, specimenType, priority = 'urgent' }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_specimens
       (tenant_id, patient_uid, accession_number, specimen_type, priority, status,
        collected_at, collected_by, received_at, received_by, created_by, updated_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'received',
             NOW(), $6::uuid, NOW(), $6::uuid, $6::uuid, $6::uuid)
     RETURNING id`,
    TENANT_ID,
    PATIENT_UID,
    `AP-N6-4-${suffix}`,
    specimenType,
    priority,
    LAB_STAFF_UID,
  );
  return Number(rows[0].id);
}

describe('Anatomic pathology deep integration', () => {
  let doctor;
  let pathologist;
  let labStaff;
  let doctorIntId;
  let pathologistIntId;
  let labStaffIntId;

  beforeAll(async () => {
    await cleanupPathologyRows();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      PATHOLOGIST_UID,
      LAB_STAFF_UID,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9010110001', 'AP Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID,
    );
    const doctorRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9010110002', 'Dr. Referring AP', 'DOCTOR', true, NOW())
       RETURNING id`,
      DOCTOR_UID,
    );
    const pathologistRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9010110003', 'Dr. Pathologist N6', 'PATHOLOGIST', true, NOW())
       RETURNING id`,
      PATHOLOGIST_UID,
    );
    const labRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9010110004', 'AP Lab Staff N6', 'LAB_STAFF', true, NOW())
       RETURNING id`,
      LAB_STAFF_UID,
    );
    doctorIntId = doctorRows[0].id;
    pathologistIntId = pathologistRows[0].id;
    labStaffIntId = labRows[0].id;

    doctor = mkClient('DOCTOR', DOCTOR_UID, doctorIntId);
    pathologist = mkClient('PATHOLOGIST', PATHOLOGIST_UID, pathologistIntId);
    labStaff = mkClient('LAB_STAFF', LAB_STAFF_UID, labStaffIntId);
  });

  afterAll(async () => {
    await cleanupPathologyRows();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      PATHOLOGIST_UID,
      LAB_STAFF_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it.each([
    {
      label: 'histopathology biopsy',
      suffix: 'HISTO',
      caseKind: 'histopathology',
      specimenType: 'tissue',
      stainType: 'h_and_e',
      malignancyFlag: 'benign',
    },
    {
      label: 'fluid cytology',
      suffix: 'CYTO',
      caseKind: 'cytology',
      specimenType: 'fluid',
      stainType: 'cytology',
      malignancyFlag: 'suspicious',
    },
  ])('runs the required AP workflow for $label', async ({ suffix, caseKind, specimenType, stainType, malignancyFlag }) => {
    const specimenId = await createSpecimen({ suffix, specimenType, priority: caseKind === 'cytology' ? 'routine' : 'urgent' });

    const accession = await labStaff.post('/api/v1/pathology/cases').send({
      patient_uid: PATIENT_UID,
      specimen_ids: [specimenId],
      case_kind: caseKind,
      priority: caseKind === 'cytology' ? 'routine' : 'urgent',
      clinical_history: `${caseKind} workflow history`,
    });
    expect(accession.statusCode).toBe(201);
    const caseId = accession.body.data.case.id;
    expect(accession.body.data.case.status).toBe('accessioned');

    const gross = await labStaff.post(`/api/v1/pathology/cases/${caseId}/gross`).send({
      gross_text: 'Received labelled specimen; gross description recorded.',
      dimensions_text: '1.2 x 0.8 x 0.4 cm',
      cassette_count: 1,
    });
    expect(gross.statusCode).toBe(201);

    const block = await labStaff.post(`/api/v1/pathology/cases/${caseId}/blocks`).send({
      tissue_site: caseKind === 'cytology' ? 'cell block' : 'lesion edge',
    });
    expect(block.statusCode).toBe(201);
    expect(block.body.data.block_code).toContain('-B01');

    const slide = await labStaff.post(`/api/v1/pathology/blocks/${block.body.data.id}/slides`).send({
      stain_type: stainType,
      stain_name: stainType === 'cytology' ? 'Papanicolaou' : 'H&E',
    });
    expect(slide.statusCode).toBe(201);
    expect(slide.body.data.slide_code).toContain('-S01-');

    const report = await pathologist.put(`/api/v1/pathology/cases/${caseId}/report`).send({
      report_status: 'draft',
      gross_text: 'Gross sections processed.',
      microscopic_text: 'Representative sections reviewed.',
      diagnosis_text: `${caseKind} diagnostic interpretation`,
      malignancy_flag: malignancyFlag,
      synoptic_fields: { adequacy: 'adequate' },
    });
    expect(report.statusCode).toBe(200);
    expect(report.body.data.report_status).toBe('draft');

    const rejectedSignOff = await doctor.post(`/api/v1/pathology/reports/${report.body.data.id}/sign-off`).send({});
    expect(rejectedSignOff.statusCode).toBe(403);
    expect(rejectedSignOff.body.details?.code).toBe('AP_SIGNER_REQUIRED');

    const signed = await pathologist.post(`/api/v1/pathology/reports/${report.body.data.id}/sign-off`).send({
      result_classification: 'abnormal',
      classification_basis: {
        source: 'pathologist_attestation',
        interpretation: `${caseKind}_diagnosis`,
      },
    }).set('Idempotency-Key', `pathology-deep-signoff-${report.body.data.id}`);
    expect(signed.statusCode).toBe(200);
    expect(signed.body.data.report_status).toBe('final');
    expect(signed.body.data.signed_by).toBe(PATHOLOGIST_UID);
    expect(signed.body.data.diagnostic_generation.source_version).toBe(1);

    const addendum = await pathologist.post(`/api/v1/pathology/reports/${report.body.data.id}/addenda`).send({
      addendum_text: 'Addendum appended after clinico-pathologic correlation.',
      result_classification: 'abnormal',
      classification_basis: {
        source: 'pathologist_attestation',
        interpretation: `${caseKind}_correlation`,
      },
      clinical_significance: 'unchanged',
    }).set('Idempotency-Key', `pathology-deep-addendum-${report.body.data.id}`);
    expect(addendum.statusCode).toBe(201);
    expect(addendum.body.data.report.report_status).toBe('amended');
    expect(addendum.body.data.report.report_generation_version).toBe(2);
    expect(addendum.body.data.report.classification_basis).toMatchObject({
      interpretation: `${caseKind}_correlation`,
    });
    expect(addendum.body.data.report).not.toHaveProperty('signoff_idempotency_key');
    expect(addendum.body.data.report).not.toHaveProperty('signoff_request_sha256');
    expect(addendum.body.data.addendum.generation_version).toBe(2);
    expect(addendum.body.data.diagnostic_generation.predecessor_generation_id).toBeTruthy();

    const detail = await pathologist.get(`/api/v1/pathology/cases/${caseId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.data.blocks).toHaveLength(1);
    expect(detail.body.data.slides).toHaveLength(1);
    expect(detail.body.data.addenda).toHaveLength(1);
    expect(detail.body.data.addenda[0]).not.toHaveProperty('idempotency_key');
    expect(detail.body.data.addenda[0]).not.toHaveProperty('request_sha256');
    expect(detail.body.data.case.status).toBe('amended');
    expect(detail.body.data.report).toMatchObject({
      result_classification: 'abnormal',
      classification_basis: {
        interpretation: `${caseKind}_correlation`,
      },
      report_generation_version: 2,
      classification_signed_by: PATHOLOGIST_UID,
      latest_clinical_significance: 'unchanged',
      latest_addendum_id: detail.body.data.addenda[0].id,
    });
    expect(detail.body.data.report).not.toHaveProperty('signoff_idempotency_key');
    expect(detail.body.data.report).not.toHaveProperty('signoff_request_sha256');

    const eventRows = await prisma.$queryRawUnsafe(
      `SELECT event_type, source_table
         FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid
          AND source_table IN ('ap_cases', 'ap_gross_records', 'ap_blocks', 'ap_slides', 'ap_reports', 'ap_report_addenda')
        ORDER BY occurred_at ASC, id ASC`,
      PATIENT_UID,
    );
    const eventTypes = eventRows.map((row) => row.event_type);
    expect(eventTypes).toEqual(expect.arrayContaining([
      'pathology.case_accessioned',
      'pathology.gross_recorded',
      'pathology.block_created',
      'pathology.slide_created',
      'pathology.report_drafted',
      'pathology.report_signed_off',
      'pathology.report_addendum',
    ]));

    const worklist = await pathologist.get('/api/v1/pathology/worklist?limit=10');
    expect(worklist.statusCode).toBe(200);
    const worklistCase = worklist.body.data.find((row) => row.id === caseId);
    expect(worklistCase.current_tat_stage).toBeTruthy();
    expect(worklistCase).toMatchObject({
      result_classification: 'abnormal',
      report_generation_version: 2,
      classification_signed_by: PATHOLOGIST_UID,
      latest_clinical_significance: 'unchanged',
      latest_addendum_id: detail.body.data.addenda[0].id,
    });
  });
});
