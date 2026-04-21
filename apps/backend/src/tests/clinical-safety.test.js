import prisma from '../lib/prisma.js';
import { administerWithScan, evaluate5Rights } from '../services/clinical/marFiveRightsService.js';
import { acknowledgeAlert, checkOrder } from '../services/emr/cdsEngine.js';

const PATIENT_UID = 'a7777777-7777-4777-8777-777777777a01';
const OTHER_PATIENT_UID = 'a7777777-7777-4777-8777-777777777a02';
const CLINICIAN_UID = 'a7777777-7777-4777-8777-777777777a03';

async function cleanupFixtures() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM cds_alerts WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    OTHER_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    OTHER_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_allergies WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    OTHER_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID,
    OTHER_PATIENT_UID,
    CLINICIAN_UID,
  ).catch(() => {});
}

async function seedMedicationAdministration(overrides = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO medication_administrations (
       patient_uid, medication_name, dose, route, scheduled_time, status, created_at, updated_at
     ) VALUES (
       $1::uuid, $2, $3, $4, NOW(), 'scheduled', NOW(), NOW()
     )
     RETURNING id`,
    overrides.patientUid || PATIENT_UID,
    overrides.medicationName || 'Amoxicillin 500mg',
    overrides.dose || '500 mg',
    overrides.route || 'oral',
  );
  return rows[0].id;
}

describe('Clinical safety controls', () => {
  beforeAll(async () => {
    await cleanupFixtures();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, '9000070001', 'Clinical Safety Patient', 'PATIENT', true, NOW()),
         ($2::uuid, '9000070002', 'Clinical Safety Other Patient', 'PATIENT', true, NOW()),
         ($3::uuid, '9000070003', 'Clinical Safety Clinician', 'DOCTOR', true, NOW())`,
      PATIENT_UID,
      OTHER_PATIENT_UID,
      CLINICIAN_UID,
    );
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect().catch(() => {});
  });

  it('passes all five MAR rights when patient, drug, dose, route, and time match', async () => {
    const maId = await seedMedicationAdministration();

    const result = await evaluate5Rights({
      ma_id: maId,
      scanned_patient_uid: PATIENT_UID,
      scanned_barcode: 'amoxicillin',
    });

    expect(result.allPassed).toBe(true);
    expect(result.rights).toEqual({
      patient: true,
      drug: true,
      dose: true,
      route: true,
      time: true,
    });
  });

  it('blocks MAR administration when a five-rights failure has no override', async () => {
    const maId = await seedMedicationAdministration();

    await expect(
      administerWithScan({
        ma_id: maId,
        scanned_patient_uid: OTHER_PATIENT_UID,
        scanned_barcode: 'amoxicillin',
        administeredBy: CLINICIAN_UID,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { rights: expect.objectContaining({ patient: false }) },
    });
  });

  it('records the override audit trail when a five-rights failure is overridden', async () => {
    const maId = await seedMedicationAdministration();

    const updated = await administerWithScan({
      ma_id: maId,
      scanned_patient_uid: OTHER_PATIENT_UID,
      scanned_barcode: 'amoxicillin',
      administeredBy: CLINICIAN_UID,
      overrideReason: 'Patient wristband replaced after manual identity verification',
    });

    expect(updated.status).toBe('administered');
    expect(updated.all_rights_passed).toBe(false);
    expect(updated.rights_passed).toMatchObject({ patient: false, drug: true });
    expect(updated.override_reason).toContain('manual identity');
  });

  it('returns an unsafe CDS allergy blocker for a medication allergen match', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (patient_uid, allergy_name, severity, reaction, is_active, created_at)
       VALUES ($1::uuid, 'amoxicillin', 'severe', 'anaphylaxis', true, NOW())`,
      PATIENT_UID,
    );

    const result = await checkOrder({
      type: 'medication',
      medication_name: 'Amoxicillin 500mg',
      patient_uid: PATIENT_UID,
    });

    expect(result.safe).toBe(false);
    expect(result.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'allergy',
          severity: 'critical',
          canOverride: true,
        }),
      ]),
    );
  });

  it('persists CDS override acknowledgement with the clinical reason', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO cds_alerts (
         patient_uid, alert_type, severity, title, description, source_data, created_at
       ) VALUES (
         $1::uuid, 'allergy', 'critical', 'Allergy alert', 'Ordered medication matches allergy', '{}'::jsonb, NOW()
       )
       RETURNING id`,
      PATIENT_UID,
    );

    const acknowledged = await acknowledgeAlert(
      rows[0].id,
      CLINICIAN_UID,
      'Benefit outweighs risk after consultant review',
    );

    expect(acknowledged.acknowledged).toBe(true);
    expect(acknowledged.acknowledged_by).toBe(CLINICIAN_UID);
    expect(acknowledged.override_reason).toContain('consultant review');
  });
});
