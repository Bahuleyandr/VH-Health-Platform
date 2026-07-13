// Patient-facing staff mutations must not commit their detail row when the
// canonical timeline/audit pair cannot be persisted. This fault-injection suite
// keeps Prisma real and makes canonical persistence return null, proving the
// enclosing tenant transaction rolls the clinical mutation back.

import { randomUUID } from 'crypto';
import { jest } from '@jest/globals';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const actualCanonical = await import('../services/clinical/canonicalClinicalPlatformService.js');
jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonical,
  recordCanonicalClinicalEvent: jest.fn().mockResolvedValue({ timeline: null, audit: null }),
}));

const prisma = (await import('../lib/prisma.js')).default;
const orderService = await import('../services/investigation/orderService.js');
const bloodBankService = (await import('../services/bloodbank/bloodBankService.js')).default;
const bedService = (await import('../services/bed/bedService.js')).default;
const { createLegacyStaffConsultation } = await import('../services/emr/legacyStaffMedicalService.js');
const { uploadInvestigationFile } = await import('../services/investigation/fileService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = randomUUID();
const ACTOR_UID = randomUUID();
const PHONE = `8${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const WARD_NAME = `CANON-NULL-${randomUUID().slice(0, 8)}`;
const BED_NUMBER = `CN-${randomUUID().slice(0, 8)}`;

let patientId;
let wardId;
let bedId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM medical_records WHERE tenant_id = $1::uuid AND patient_id = $2::uuid`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM blood_requests WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigation_files WHERE investigation_id IN
       (SELECT id FROM investigations WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid)`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigations WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM bed_transfers WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number = $1`, BED_NUMBER).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    ACTOR_UID,
  ).catch(() => {});
}

d('canonical null-result rollback for staff clinical mutations', () => {
  beforeAll(async () => {
    await cleanup();
    const patientRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Canonical Null Patient', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID,
      PHONE,
      TENANT_ID,
    );
    patientId = patientRows[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Canonical Null Doctor', 'DOCTOR', true, $3::uuid, NOW())`,
      ACTOR_UID,
      `7${PHONE.slice(1)}`,
      TENANT_ID,
    );
    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 1) RETURNING id`,
      WARD_NAME,
    );
    wardId = wardRows[0].id;
    const bedRows = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, bed_type, status, tenant_id)
       VALUES ($1, $2, $3, 'general', 'available', $4::uuid) RETURNING id`,
      wardId,
      WARD_NAME,
      BED_NUMBER,
      TENANT_ID,
    );
    bedId = bedRows[0].id;
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('rolls back a legacy investigation insert', async () => {
    await expect(orderService.createLegacyInvestigation({
      phone: PHONE,
      test_name: 'Canonical null CBC',
      createdBy: ACTOR_UID,
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'INVESTIGATION_CANONICAL_EVENT_REQUIRED' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM investigations
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_name = 'Canonical null CBC'`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(rows).toHaveLength(0);
  });

  it('rolls back a legacy staff consultation entry', async () => {
    await expect(createLegacyStaffConsultation({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      consultationType: 'Handover note',
      notes: 'Must roll back with the missing canonical pair',
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'CONSULTATION_CANONICAL_EVENT_REQUIRED' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM medical_records WHERE tenant_id = $1::uuid AND patient_id = $2::uuid`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(rows).toHaveLength(0);
  });

  it('rolls back a legacy blood request insert', async () => {
    await expect(bloodBankService.createRequest({
      patient_uid: PATIENT_UID,
      blood_group: 'A+',
      component: 'prbc',
      units: 1,
      clinical_indication: 'Canonical null rollback proof',
      ordered_by: ACTOR_UID,
    }, {
      tenantId: TENANT_ID,
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'BLOOD_BANK_CANONICAL_EVENT_REQUIRED' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM blood_requests
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(rows).toHaveLength(0);
  });

  it('rolls back an investigation file row when canonical persistence returns null', async () => {
    const investigationRows = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (tenant_id, patient_uid, patient_id, phone, test_name, test_type, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'Canonical null document', 'LAB', 'REQUESTED', NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      patientId,
      PHONE,
    );
    const investigationId = investigationRows[0].id;
    const buffer = Buffer.from('%PDF-1.4 canonical null rollback proof');

    await expect(uploadInvestigationFile(investigationId, {
      originalname: 'canonical-null.pdf',
      size: buffer.length,
      buffer,
    }, ACTOR_UID, {
      tenantId: TENANT_ID,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'INVESTIGATION_FILE_CANONICAL_EVENT_REQUIRED' });

    const files = await prisma.$queryRawUnsafe(
      `SELECT id FROM investigation_files WHERE investigation_id = $1`,
      investigationId,
    );
    expect(files).toHaveLength(0);
  });

  it('rolls back quick-admit admission, bed occupancy, and transfer rows', async () => {
    await expect(bedService.admitPatient(
      bedId,
      { patient_id: patientId, patient_name: 'Canonical Null Patient' },
      'DOCTOR',
      { tenantId: TENANT_ID, actorUid: ACTOR_UID },
    )).rejects.toMatchObject({ code: 'BED_CANONICAL_EVENT_REQUIRED' });

    const beds = await prisma.$queryRawUnsafe(
      `SELECT status, patient_uid, admission_id FROM beds WHERE id = $1`,
      bedId,
    );
    expect(beds[0].status).toBe('available');
    expect(beds[0].patient_uid).toBeNull();
    expect(beds[0].admission_id).toBeNull();

    const admissions = await prisma.$queryRawUnsafe(
      `SELECT id FROM admissions WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID,
    );
    const transfers = await prisma.$queryRawUnsafe(
      `SELECT id FROM bed_transfers WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID,
    );
    expect(admissions).toHaveLength(0);
    expect(transfers).toHaveLength(0);
  });
});
