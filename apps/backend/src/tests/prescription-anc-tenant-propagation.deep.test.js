import { randomUUID } from 'crypto';
import { jest } from '@jest/globals';

import prisma from '../lib/prisma.js';

// Deep-suite convention (see composition-identity-persistence.deep.test.js):
// DB round-trips in beforeAll/afterAll can exceed Jest's 5s default on this
// stack, so raise the per-hook/test budget for the whole file.
jest.setTimeout(60000);

jest.unstable_mockModule('../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(async () => ({ ok: true })),
  getSignedFileUrl: jest.fn(async () => 'https://example.invalid/prescription.pdf'),
}));
jest.unstable_mockModule('../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn(async () => ({ ok: true })),
}));
jest.unstable_mockModule('../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => null),
}));
jest.unstable_mockModule('../services/patient/medicationReminderService.js', () => ({
  createPrescriptionReminders: jest.fn(async () => []),
}));

const { createPrescription } = await import('../controllers/prescription/ePrescriptionController.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const TENANT_SLUG = `rx-anc-${TENANT_ID.slice(0, 8)}`;
const PATIENT_PHONE = `+9187${String(Date.now()).slice(-8)}`;
const DOCTOR_PHONE = `+9186${String(Date.now()).slice(-8)}`;

let patientId;
let doctorId;

function makeReqRes(body) {
  const req = {
    body,
    params: {},
    query: {},
    headers: {},
    id: 'req-prescription-anc-tenant',
    method: 'POST',
    originalUrl: '/api/v1/prescriptions/create',
    tenantId: TENANT_ID,
    user: {
      uid: DOCTOR_UID,
      id: doctorId,
      role: 'DOCTOR',
      tenant_id: TENANT_ID,
    },
  };
  const res = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  return { req, res };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_reminders WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM prescription_safety_overrides
      WHERE prescription_id IN (
        SELECT id FROM e_prescriptions WHERE patient_uid = $1::uuid
      )`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM maternity_supplements
      WHERE pregnancy_id IN (
        SELECT id FROM maternity_pregnancies WHERE patient_uid = $1::uuid
      )`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM maternity_pregnancies WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
}

d('prescription-originated ANC supplement tenant propagation', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'Prescription ANC Tenant Test')`,
      TENANT_ID,
      TENANT_SLUG,
    );

    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (uid, phone, name, role, is_active, is_pregnant, tenant_id, updated_at)
       VALUES
         ($1::uuid, $2, 'Prescription ANC Patient', 'PATIENT', true, true, $5::uuid, NOW()),
         ($3::uuid, $4, 'Prescription ANC Doctor', 'DOCTOR', true, false, $5::uuid, NOW())
       RETURNING id, uid::text AS uid`,
      PATIENT_UID,
      PATIENT_PHONE,
      DOCTOR_UID,
      DOCTOR_PHONE,
      TENANT_ID,
    );
    patientId = Number(users.find((row) => row.uid === PATIENT_UID).id);
    doctorId = Number(users.find((row) => row.uid === DOCTOR_UID).id);

    await prisma.$executeRawUnsafe(
      `INSERT INTO maternity_pregnancies
         (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
       VALUES ($1::uuid, 1, CURRENT_DATE - 84, CURRENT_DATE + 196,
               'ongoing', $2::uuid, $3::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      TENANT_ID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('uses the resolved request tenant when the JWT shape has tenant_id but no camelCase alias', async () => {
    const { req, res } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'Routine antenatal supplementation',
      medications: [
        {
          name: 'Iron with Folic Acid',
          dosage: '60 mg',
          frequency: 'OD',
          duration: '90 days',
          route: 'oral',
        },
      ],
    });

    expect(req.user.tenantId).toBeUndefined();
    await createPrescription(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.payload?.success).toBe(true);
    expect(res.payload?.data).toMatchObject({
      patient_uid: PATIENT_UID,
      tenant_id: TENANT_ID,
    });

    // Deliberately NO tenant filter here: a row missing entirely AND a row
    // written under the wrong tenant (e.g. the single-tenant default) must
    // both fail this assertion. Tenant correctness is asserted on the row.
    const supplements = await prisma.$queryRawUnsafe(
      `SELECT ms.id, ms.supplement, ms.dose, ms.frequency, ms.reminder_enabled,
              ms.tenant_id::text AS tenant_id
         FROM maternity_supplements ms
         JOIN maternity_pregnancies mp ON mp.id = ms.pregnancy_id
        WHERE mp.patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(supplements).toHaveLength(1);
    // "Iron with Folic Acid" matches both the iron and folic_acid patterns;
    // collapseComboSupplementMatches keeps only 'iron' for the IFA combo.
    expect(supplements[0]).toMatchObject({
      supplement: 'iron',
      dose: '60 mg',
      frequency: 'once_daily',
      reminder_enabled: true,
      tenant_id: TENANT_ID,
    });

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, event_type, event_subtype,
              source_table, source_id, visible_to_patient
         FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid
          AND event_type = 'maternity.supplement_recorded'`,
      PATIENT_UID,
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, action, resource_table, resource_id
         FROM clinical_audit_events
        WHERE patient_uid = $1::uuid
          AND action = 'maternity.supplement_recorded'`,
      PATIENT_UID,
    );
    expect(timeline).toEqual([
      expect.objectContaining({
        tenant_id: TENANT_ID,
        event_type: 'maternity.supplement_recorded',
        event_subtype: 'prescription_propagated',
        source_table: 'maternity_supplements',
        source_id: String(supplements[0].id),
        visible_to_patient: false,
      }),
    ]);
    expect(audit).toEqual([
      expect.objectContaining({
        tenant_id: TENANT_ID,
        action: 'maternity.supplement_recorded',
        resource_table: 'maternity_supplements',
        resource_id: String(supplements[0].id),
      }),
    ]);
  });
});
