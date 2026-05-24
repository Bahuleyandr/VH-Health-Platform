// Regression for H' D5 / D71:
// discharge summary drafts must not leave the patient-facing diagnosis and
// take-home medication sections blank when structured admission/order data
// already exists.

import prisma from '../lib/prisma.js';
import { createDraft } from '../services/discharge/dischargeService.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd5d5d5d5-0001-4d5d-8d5d-d5d5d5d50001';
const DOCTOR_UID = 'd5d5d5d5-0002-4d5d-8d5d-d5d5d5d50002';
const ENCOUNTER_ID = 'd5d5d5d5-0003-4d5d-8d5d-d5d5d5d50003';
const TEMPLATE_CODE = 'DISCH_AUTO_D5_TEST';

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_summary_sections
      WHERE discharge_summary_id IN (
        SELECT id FROM discharge_summaries WHERE patient_uid = $1::uuid
      )`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM discharge_summaries WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE order_number LIKE 'DISCH-AUTO-%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_summary_templates WHERE tenant_id = $1::uuid AND code = $2`,
    TENANT_ID,
    TEMPLATE_CODE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
}

describe('discharge summary draft autofill', () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9005050001', 'D5 Discharge Patient', 'PATIENT', true, NOW()),
              ($2::uuid, '9005050002', 'D5 Discharge Doctor', 'DOCTOR', true, NOW())`,
      PATIENT_UID,
      DOCTOR_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO discharge_summary_templates
         (code, display_name, specialty, sections, active, tenant_id)
       VALUES ($1, 'D5 autofill test template', 'general_medicine', $2::jsonb, true, $3::uuid)`,
      TEMPLATE_CODE,
      JSON.stringify([
        { section_key: 'diagnosis', section_title: 'Diagnosis', display_order: 1 },
        { section_key: 'discharge_medications', section_title: 'Discharge Medications', display_order: 2 },
      ]),
      TENANT_ID,
    );
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('fills diagnosis and oral take-home meds from the admission encounter', async () => {
    const admissionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, encounter_id, admitting_doctor, admitting_diagnosis,
          admission_type, status, admitted_at, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Acute gastroenteritis with dehydration',
               'emergency', 'admitted', NOW() - INTERVAL '1 day', $3::uuid)
       RETURNING id`,
      PATIENT_UID,
      ENCOUNTER_ID,
      DOCTOR_UID,
    );
    const admissionId = admissionRows[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_orders
         (order_number, encounter_id, patient_uid, order_type, priority, details,
          status, ordered_by, tenant_id)
       VALUES
         ('DISCH-AUTO-ORS', $1::uuid, $2::uuid, 'medication', 'routine',
          $4::jsonb, 'in_progress', $3::uuid, $5::uuid),
         ('DISCH-AUTO-IV', $1::uuid, $2::uuid, 'medication', 'routine',
          $6::jsonb, 'in_progress', $3::uuid, $5::uuid),
         ('DISCH-AUTO-STOPPED', $1::uuid, $2::uuid, 'medication', 'routine',
          $7::jsonb, 'stopped', $3::uuid, $5::uuid)`,
      ENCOUNTER_ID,
      PATIENT_UID,
      DOCTOR_UID,
      JSON.stringify({
        medication_name: 'ORS Sachet',
        dose: '1 sachet',
        route: 'oral',
        frequency: 'TDS',
        duration: '3 days',
      }),
      TENANT_ID,
      JSON.stringify({
        medication_name: 'Normal Saline',
        dose: '500 mL',
        route: 'IV infusion',
        frequency: 'once',
      }),
      JSON.stringify({
        medication_name: 'Ondansetron',
        dose: '4 mg',
        route: 'oral',
        frequency: 'BD',
      }),
    );

    const draft = await createDraft({
      tenantId: TENANT_ID,
      admission_id: admissionId,
      patient_uid: PATIENT_UID,
      template_code: TEMPLATE_CODE,
      created_by: DOCTOR_UID,
    });

    const diagnosis = draft.sections.find((s) => s.section_key === 'diagnosis');
    const meds = draft.sections.find((s) => s.section_key === 'discharge_medications');

    expect(String(diagnosis?.body)).toContain('Acute gastroenteritis with dehydration');
    expect(String(meds?.body)).toContain('ORS Sachet 1 sachet oral TDS 3 days');
    expect(String(meds?.body)).not.toContain('Normal Saline');
    expect(String(meds?.body)).not.toContain('Ondansetron');
    expect(String(meds?.body).toLowerCase()).not.toContain('[placeholder');
  });
});
