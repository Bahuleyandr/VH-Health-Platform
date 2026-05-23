// Regression test for findings
//   2026-05-22-inpatient-admission-doctor-7ded987b
//   2026-05-22-dynamic-acute-abdomen-doctor-449c93ec
//   2026-05-22-inpatient-admission-doctor-a8d4e86f
//   2026-05-23-inpatient-admission-doctor-2de6874d / -cdf1c658
//   2026-05-23-dynamic-acute-abdomen-doctor-a69c2203
//
// `POST /api/v1/radiology/orders` returned a generic 500 whenever the
// doctor supplied an `encounter_id` from admission detail. Root cause:
// `radiology_orders.encounter_id` is INTEGER, but `admissions.encounter_id`
// (the canonical encounter handle surfaced on admission detail) is UUID.
// The service inserted the uuid string straight into the integer column
// → 22P02 "invalid input syntax for type integer" → 500. The doctor's
// only workaround was omitting `encounter_id`, producing an orphan
// radiology order with no admission linkage.
//
// Fix: a uuid input is resolved via `admissions.encounter_id` → `admissions.id`
// (the de-facto IPD encounter). Integer / numeric input passes through.
// Anything unparseable or with no admission match falls back to null with
// a warning — the radiology worklist still needs the order in front of
// the radiologist, so we degrade gracefully rather than 400-ing.

import prisma from '../lib/prisma.js';
import * as radSvc from '../services/radiology/radiologyService.js';
import { resolveEncounterIdForRadiology } from '../services/radiology/radiologyService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd8888888-8888-4888-8888-cccccccc5d80';
const DOCTOR_UID  = 'd8888888-8888-4888-8888-cccccccc5d81';
const ADMISSION_ENCOUNTER_UUID = 'd8888888-8888-4888-8888-eeeeeeee5e80';
const RANDOM_UNMATCHED_UUID    = 'd8888888-8888-4888-8888-ffffffff5f80';

const createdOrderIds = [];
let admissionId;

async function freshOrder(extra = {}) {
  const order = await radSvc.default.createOrder({
    patient_uid: PATIENT_UID,
    modality: 'us',
    body_part: 'Abdomen',
    clinical_indication: 'STAT — acute abdomen workup',
    priority: 'stat',
    ordered_by: DOCTOR_UID,
    ...extra,
  });
  createdOrderIds.push(order.id);
  return order;
}

describe('radiology createOrder — encounter_id uuid/int resolution (7ded987b cluster)', () => {
  beforeAll(async () => {
    // Cleanup from any prior failed run.
    await prisma.$executeRawUnsafe(`DELETE FROM radiology_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000220080', 'Rad Encounter Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000220081', 'Dr. Rad Encounter', 'DOCTOR', true, NOW())`,
      DOCTOR_UID);

    // Seed an admission stamped with the encounter UUID the driver would
    // see on admission detail. The id of THIS row is what the service
    // must resolve from the uuid. Only patient_uid is NOT NULL on
    // admissions; everything else can stay null for this targeted test.
    const adm = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, encounter_id, status, admitted_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', NOW(), NOW(), NOW())
       RETURNING id`,
      PATIENT_UID, ADMISSION_ENCOUNTER_UUID);
    admissionId = adm[0].id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM radiology_orders WHERE id = $1::int`, id).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  // ---- resolver unit tests (pure logic) ----

  it('resolveEncounterIdForRadiology returns null on null / empty input', async () => {
    expect(await resolveEncounterIdForRadiology(null, PATIENT_UID)).toBeNull();
    expect(await resolveEncounterIdForRadiology('', PATIENT_UID)).toBeNull();
    expect(await resolveEncounterIdForRadiology(undefined, PATIENT_UID)).toBeNull();
  });

  it('resolveEncounterIdForRadiology returns Number(integer) when given an integer string or number', async () => {
    expect(await resolveEncounterIdForRadiology('42', PATIENT_UID)).toBe(42);
    expect(await resolveEncounterIdForRadiology(99, PATIENT_UID)).toBe(99);
  });

  it('resolveEncounterIdForRadiology resolves a matching encounter UUID to the admission integer id', async () => {
    expect(await resolveEncounterIdForRadiology(ADMISSION_ENCOUNTER_UUID, PATIENT_UID)).toBe(admissionId);
  });

  it('resolveEncounterIdForRadiology returns null + warning when UUID does not match any admission', async () => {
    expect(await resolveEncounterIdForRadiology(RANDOM_UNMATCHED_UUID, PATIENT_UID)).toBeNull();
  });

  it('resolveEncounterIdForRadiology returns null on garbage input (not uuid, not integer)', async () => {
    expect(await resolveEncounterIdForRadiology('not-an-id', PATIENT_UID)).toBeNull();
    expect(await resolveEncounterIdForRadiology('123abc', PATIENT_UID)).toBeNull();
  });

  // ---- createOrder integration (the actual repro) ----

  it('createOrder accepts the admission encounter UUID and stores the resolved integer (no 500)', async () => {
    const order = await freshOrder({ encounter_id: ADMISSION_ENCOUNTER_UUID });
    expect(order.id).toBeTruthy();
    expect(order.encounter_id).toBe(admissionId);
    expect(order.modality).toBe('ultrasound');  // 'us' → 'ultrasound' alias
    expect(order.status).toBe('ordered');
  });

  it('createOrder accepts an integer encounter_id and passes it through', async () => {
    const order = await freshOrder({ encounter_id: admissionId });
    expect(order.encounter_id).toBe(admissionId);
  });

  it('createOrder degrades gracefully on an unmatched UUID — saves with encounter_id=null (worklist still gets the order)', async () => {
    const order = await freshOrder({ encounter_id: RANDOM_UNMATCHED_UUID });
    expect(order.id).toBeTruthy();
    expect(order.encounter_id == null).toBe(true);
  });

  it('createOrder accepts the legacy `usg` alias and STAT priority on the resolved encounter', async () => {
    const order = await freshOrder({
      encounter_id: ADMISSION_ENCOUNTER_UUID,
      modality: 'usg',     // alias
      priority: 'emergency', // alias → stat
    });
    expect(order.encounter_id).toBe(admissionId);
    expect(order.modality).toBe('ultrasound');
    expect(order.priority).toBe('stat');
  });

  it('createOrder still rejects missing required fields (regression boundary unchanged)', async () => {
    await expect(radSvc.default.createOrder({
      patient_uid: PATIENT_UID,
      // missing modality
      body_part: 'Abdomen',
      clinical_indication: 'x',
      ordered_by: DOCTOR_UID,
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});
