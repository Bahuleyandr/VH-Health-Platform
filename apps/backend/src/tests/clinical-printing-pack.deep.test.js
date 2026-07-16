import PDFDocument from 'pdfkit';
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'b2222222-2222-4222-8222-222222222201';
const DOCTOR_UID = 'b2222222-2222-4222-8222-222222222202';
const ADMIN_UID = 'b2222222-2222-4222-8222-222222222203';

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function withAuth(req, role = 'DOCTOR', overrides = {}) {
  const token = generateTestToken(role, {
    tenant_id: TENANT_ID,
    tenantId: TENANT_ID,
    uid: role === 'ADMIN' ? ADMIN_UID : DOCTOR_UID,
    ...overrides,
  });
  return req.set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
}

describe('clinical printing pack', () => {
  let patientId;
  let doctorId;
  let admissionId;
  let draftSummaryId;
  let signedSummaryId;
  let draftPrescriptionId;
  let signedPrescriptionId;

  beforeAll(async () => {
    await cleanup();

    const patientRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, gender, birthday, updated_at)
       VALUES ($1::uuid, '9022200201', 'Printing Pack Patient', 'PATIENT', true, 'Female', '1988-04-12'::date, NOW())
       RETURNING id`,
      PATIENT_UID,
    );
    patientId = patientRows[0].id;

    const doctorRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9022200202', 'Dr Printing Pack', 'DOCTOR', true, NOW())
       RETURNING id`,
      DOCTOR_UID,
    );
    doctorId = doctorRows[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9022200203', 'Printing Pack Admin', 'ADMIN', true, NOW())`,
      ADMIN_UID,
    );

    const admissionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, tenant_id, admitting_doctor, attending_doctor, status,
          admitted_at, ward, bed_number, chief_complaint, admitting_diagnosis,
          created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, 'admitted',
          NOW() - INTERVAL '1 day', 'General Ward', 'PP-101',
          'Fever', 'Viral fever', $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID,
      TENANT_ID,
      DOCTOR_UID,
    );
    admissionId = admissionRows[0].id;

    const draftSummaryRows = await prisma.$queryRawUnsafe(
      `INSERT INTO discharge_summaries
         (tenant_id, admission_id, patient_uid, patient_name_snapshot,
          age_years_snapshot, sex_snapshot, ward_at_discharge,
          primary_diagnosis, status, created_by)
       VALUES ($1::uuid, $2::int, $3::uuid, 'Printing Pack Patient',
          38, 'Female', 'General Ward', 'Viral fever', 'draft', $4::uuid)
       RETURNING id`,
      TENANT_ID,
      admissionId,
      PATIENT_UID,
      DOCTOR_UID,
    );
    draftSummaryId = draftSummaryRows[0].id;

    const signedSummaryRows = await prisma.$queryRawUnsafe(
      `INSERT INTO discharge_summaries
         (tenant_id, admission_id, patient_uid, patient_name_snapshot,
          age_years_snapshot, sex_snapshot, ward_at_discharge,
          primary_diagnosis, status, signed_by, signed_by_name, signed_at,
          created_by)
       VALUES ($1::uuid, $2::int, $3::uuid, 'Printing Pack Patient',
          38, 'Female', 'General Ward', 'Viral fever', 'signed',
          $4::uuid, 'Dr Printing Pack', NOW(), $4::uuid)
       RETURNING id`,
      TENANT_ID,
      admissionId,
      PATIENT_UID,
      DOCTOR_UID,
    );
    signedSummaryId = signedSummaryRows[0].id;

    const draftPrescriptionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (tenant_id, patient_id, patient_uid, doctor_id, doctor_uid,
          medications, diagnosis, clinical_notes, status, lifecycle_status,
          prescription_number, created_by, created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::int, $5::uuid,
          $6::jsonb, 'Viral fever', 'Hydration advised', 'active', 'draft',
          'RX-PRINT-DRAFT', $4::int, NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      patientId,
      PATIENT_UID,
      doctorId,
      DOCTOR_UID,
      JSON.stringify([{ name: 'Paracetamol', dosage: '500 mg', frequency: 'TDS', duration: '3 days', route: 'Oral' }]),
    );
    draftPrescriptionId = draftPrescriptionRows[0].id;

    const signedPrescriptionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (tenant_id, patient_id, patient_uid, doctor_id, doctor_uid,
          medications, diagnosis, clinical_notes, status, lifecycle_status,
          prescription_number, signed_at, signed_by, locked_at, locked_by,
          created_by, created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::int, $5::uuid,
          $6::jsonb, 'Viral fever', 'Hydration advised', 'active', 'signed',
          'RX-PRINT-SIGNED', NOW(), $5::uuid, NOW(), $5::uuid,
          $4::int, NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      patientId,
      PATIENT_UID,
      doctorId,
      DOCTOR_UID,
      JSON.stringify([{ name: 'Paracetamol', dosage: '500 mg', frequency: 'TDS', duration: '3 days', route: 'Oral' }]),
    );
    signedPrescriptionId = signedPrescriptionRows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('returns a clear 409 when a discharge summary is not signed', async () => {
    const res = await withAuth(
      request(app).get(`/api/v1/discharge-summaries/${draftSummaryId}/pdf`),
      'DOCTOR',
      { id: doctorId },
    );

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    // relayAppError port (dischargeRoutes): the machine-readable code moved
    // from the nested details.code to the envelope root per the documented
    // { success, message, code, details } contract.
    expect(res.body.code).toBe('DISCHARGE_SUMMARY_NOT_SIGNED');
  });

  it('streams signed discharge summary PDF bytes with structural text', async () => {
    const capturedText = [];
    const originalText = PDFDocument.prototype.text;
    PDFDocument.prototype.text = function patchedText(text, ...args) {
      capturedText.push(String(text));
      return originalText.call(this, text, ...args);
    };

    try {
      const res = await withAuth(
        request(app)
          .get(`/api/v1/discharge-summaries/${signedSummaryId}/pdf`)
          .buffer(true)
          .parse(binaryParser),
        'DOCTOR',
        { id: doctorId },
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
      expect(capturedText.join('\n')).toContain('DISCHARGE SUMMARY');
    } finally {
      PDFDocument.prototype.text = originalText;
    }
  });

  it('returns a clear 409 when staff prints a draft e-Rx', async () => {
    const res = await withAuth(
      request(app).get(`/api/v1/prescriptions/${draftPrescriptionId}/print-pdf`),
      'DOCTOR',
      { id: doctorId },
    );

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.details?.code).toBe('PRESCRIPTION_NOT_SIGNED');
  });

  it('streams signed e-Rx PDF bytes with structural text', async () => {
    const capturedText = [];
    const originalText = PDFDocument.prototype.text;
    PDFDocument.prototype.text = function patchedText(text, ...args) {
      capturedText.push(String(text));
      return originalText.call(this, text, ...args);
    };

    try {
      const res = await withAuth(
        request(app)
          .get(`/api/v1/prescriptions/${signedPrescriptionId}/print-pdf`)
          .buffer(true)
          .parse(binaryParser),
        'DOCTOR',
        { id: doctorId },
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
      expect(capturedText.join('\n')).toContain('PRESCRIPTION');
      expect(capturedText.join('\n')).toContain('Paracetamol');
    } finally {
      PDFDocument.prototype.text = originalText;
    }
  });
});

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE prescription_number IN ('RX-PRINT-DRAFT', 'RX-PRINT-SIGNED')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_summary_sections
      WHERE discharge_summary_id IN (
        SELECT id FROM discharge_summaries WHERE patient_uid = $1::uuid
      )`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_summaries WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
    ADMIN_UID,
  ).catch(() => {});
}
