import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { validatePrescriptionSafety } from '../utils/clinical/prescriptionSafetyCheck.js';

const PATIENT_UID = 'a5555555-5555-4555-8555-555555555a01';
const DOCTOR_UID = 'a5555555-5555-4555-8555-555555555a02';
const STAFF_UID = 'a5555555-5555-4555-8555-555555555a03';
const PEDIATRIC_PARACETAMOL_NAME = 'Paracetamol Syrup 125mg/5ml Test';

function staffAs(id) {
  const token = generateTestToken('NURSING_STAFF', {
    uid: STAFF_UID,
    id,
    phone: '9000050003'
  });
  return {
    post: path =>
      request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
  };
}

function clientAs(role, uid, id) {
  const token = generateTestToken(role, { uid, id });
  return {
    get: path => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: path => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanupFixtures(patientId, doctorId) {
  const existingUsers = await prisma
    .$queryRawUnsafe(
      `SELECT id, uid::text AS uid
     FROM users
     WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      STAFF_UID
    )
    .catch(() => []);
  const resolvedPatientId = patientId || existingUsers.find(row => row.uid === PATIENT_UID)?.id;
  const resolvedDoctorId = doctorId || existingUsers.find(row => row.uid === DOCTOR_UID)?.id;

  if (resolvedPatientId || resolvedDoctorId) {
    await prisma
      .$executeRawUnsafe(`DELETE FROM medication_reminders WHERE patient_uid = $1::uuid`, PATIENT_UID)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM pharmacy_order_history
          WHERE order_id IN (
            SELECT id FROM pharmacy_orders
             WHERE patient_id = $1 OR patient_id = $2
          )`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM prescription_safety_overrides
       WHERE patient_id = $1 OR doctor_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM e_prescriptions
       WHERE patient_id = $1 OR doctor_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM pharmacy_orders
          WHERE patient_id = $1 OR patient_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM appointments
       WHERE patient_id = $1 OR doctor_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM pharmacy_catalog WHERE name = $1`,
      PEDIATRIC_PARACETAMOL_NAME
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      STAFF_UID
    )
    .catch(() => {});
}

describe('E-prescriptions — deep integration', () => {
  let patientId;
  let doctorId;
  let staffId;

  beforeAll(async () => {
    await cleanupFixtures();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, birthday, is_active, updated_at)
       VALUES
         ($1::uuid, '9000050001', 'Prescription Test Patient', 'PATIENT', CURRENT_DATE - INTERVAL '2 years', true, NOW()),
         ($2::uuid, '9000050002', 'Prescription Test Doctor', 'DOCTOR', NULL, true, NOW()),
         ($3::uuid, '9000050003', 'Prescription Test Nurse', 'NURSING_STAFF', NULL, true, NOW())
       RETURNING id, uid`,
      PATIENT_UID,
      DOCTOR_UID,
      STAFF_UID
    );
    patientId = rows.find(row => row.uid === PATIENT_UID).id;
    doctorId = rows.find(row => row.uid === DOCTOR_UID).id;
    staffId = rows.find(row => row.uid === STAFF_UID).id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO vitals_chart (patient_uid, weight_kg, recorded_by, recorded_at)
       VALUES ($1::uuid, 12.5, $2::uuid, NOW())`,
      PATIENT_UID,
      STAFF_UID,
    );
  });

  afterAll(async () => {
    await cleanupFixtures(patientId, doctorId);
    await prisma.$disconnect().catch(() => {});
  });

  it('checks duplicate active medicines from the current jsonb prescription schema', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions (patient_id, doctor_id, medications, follow_up_date, status, created_by)
       VALUES ($1, $2, $3::jsonb, CURRENT_DATE + INTERVAL '7 days', 'active', $4)`,
      patientId,
      doctorId,
      JSON.stringify([{ name: 'Cetirizine', dosage: '5mg' }]),
      staffId
    );

    const safety = await validatePrescriptionSafety(patientId, [
      { name: 'Cetirizine', dosage: '5mg' }
    ]);

    expect(safety.safe).toBe(true);
    expect(safety.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'DUPLICATE_MEDICATION',
          medication: 'Cetirizine'
        })
      ])
    );
  });

  it('blocks inconsistent paediatric syrup mg/ml dose text', async () => {
    const safety = await validatePrescriptionSafety(patientId, [
      {
        name: 'Paracetamol syrup 125mg/5ml',
        dosage: '187.5 mg (5 ml)',
        dose: '187.5 mg (5 ml)',
        frequency: 'q6h PRN fever',
        route: 'oral',
      },
    ]);

    expect(safety.safe).toBe(false);
    expect(safety.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PAEDIATRIC_LIQUID_DOSE_MISMATCH',
          expected_ml: 7.5,
          entered_ml: 5,
        }),
      ]),
    );
  });

  it('creates a structured prescription with medications and vitals stored as jsonb', async () => {
    const res = await staffAs(staffId)
      .post('/api/v1/prescriptions/create')
      .send({
        patient_id: patientId,
        doctor_id: doctorId,
        diagnosis: 'Seasonal allergy',
        clinical_notes: 'No respiratory distress.',
        medications: [
          {
            name: 'Cetirizine',
            dosage: '10mg',
            frequency: 'OD',
            duration: '5 days',
            route: 'Oral',
            instructions: 'After food',
            qty: 5
          }
        ],
        vitals: { pulse: 72, spo2: 99 },
        follow_up_date: '2026-05-13',
        follow_up_notes: 'Review if symptoms persist.'
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.patient_id).toBe(patientId);
    expect(res.body.data.doctor_id).toBe(doctorId);
    expect(res.body.data.medications[0].name).toBe('Cetirizine');

    const stored = await prisma.$queryRawUnsafe(
      `SELECT jsonb_typeof(medications) AS medications_type,
              jsonb_typeof(vitals) AS vitals_type,
              medications->0->>'name' AS medication_name,
              vitals->>'pulse' AS pulse
       FROM e_prescriptions
       WHERE id = $1`,
      res.body.data.id
    );

    expect(stored[0]).toMatchObject({
      medications_type: 'array',
      vitals_type: 'object',
      medication_name: 'Cetirizine',
      pulse: '72'
    });
  });

  it('returns patient-facing prescription safety context without integer-param 500s', async () => {
    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, doctor_id, medications, diagnosis, status, created_by)
       VALUES ($1::int, $2::int, $3::jsonb, 'Paediatric fever', 'active', $4::int)
       RETURNING id`,
      patientId,
      doctorId,
      JSON.stringify([{ name: 'Paracetamol syrup 125mg/5ml', dosage: '125 mg (5 ml)', route: 'oral' }]),
      staffId,
    );

    const patient = clientAs('PATIENT', PATIENT_UID, patientId);
    const res = await patient.get(`/api/v1/prescriptions/${rxRows[0].id}/safety`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      indication: 'Paediatric fever',
      warnings: expect.any(Array),
      blockers: expect.any(Array),
      overrides: expect.any(Array),
    });
  });

  // Finding: 2026-05-09-inpatient-admission-patient-discharge-rx-unlinked-to-followup
  // When the doctor enters a follow_up_date on a prescription that has
  // no source-visit appointment_id (the discharge-desk path is the
  // canonical case), the auto-booked follow-up appointment must be
  // linked back to the prescription so the patient app can render
  // "your follow-up is on X — here are the meds to take until then"
  // as a single card.
  it('back-links the auto-booked follow-up appointment to a discharge-style prescription', async () => {
    const res = await staffAs(staffId)
      .post('/api/v1/prescriptions/create')
      .send({
        patient_id: patientId,
        doctor_id: doctorId,
        // No appointment_id — mimics the discharge desk
        diagnosis: 'IPD discharge — electrolyte review',
        clinical_notes: 'Review serum electrolytes; repeat CBC.',
        medications: [
          { name: 'Tab Pan-40', dosage: '40mg', frequency: 'OD', duration: '7 days' },
          { name: 'Syp K-Lyte', dosage: '15mL', frequency: 'TDS', duration: '5 days' }
        ],
        follow_up_date: '2026-05-20',
        follow_up_notes: 'Review in 1 week. Repeat serum electrolytes.'
      });

    expect(res.statusCode).toBe(201);
    const prescriptionId = res.body.data.id;
    expect(prescriptionId).toBeTruthy();

    const linked = await prisma.$queryRawUnsafe(
      `SELECT ep.appointment_id,
              a.visit_type,
              a.appointment_date::text AS appointment_date,
              a.status
         FROM e_prescriptions ep
         LEFT JOIN appointments a ON a.id = ep.appointment_id
        WHERE ep.id = $1`,
      prescriptionId
    );
    expect(linked).toHaveLength(1);
    expect(linked[0].appointment_id).not.toBeNull();
    expect(linked[0].visit_type).toBe('FOLLOW_UP');
    expect(linked[0].appointment_date).toBe('2026-05-20');
    expect(['SCHEDULED', 'CONFIRMED', 'BOOKED']).toContain(linked[0].status);
  });

  it('lets pharmacy map a generic pediatric prescription to an explicit syrup catalog selection', async () => {
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, category, unit_price, price, pack_size,
          requires_prescription, in_stock, is_active, is_available,
          stock_quantity, stock, reorder_level, description, updated_at)
       VALUES
         ($1, 'Paracetamol', 'analgesic', 35.00, 35.00, '60 ml bottle',
          true, true, true, true, 50, 50, 10,
          'Regression fixture for paediatric syrup substitution', NOW())
       RETURNING id`,
      PEDIATRIC_PARACETAMOL_NAME
    );

    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, doctor_id, medications, status, created_by)
       VALUES ($1, $2, $3::jsonb, 'active', $4)
       RETURNING id`,
      patientId,
      doctorId,
      JSON.stringify([
        {
          name: 'Paracetamol',
          dosage: 'Syrup 125 mg/5 mL: 7.5 mL',
          frequency: 'QID',
          duration: '3 days',
          route: 'Oral',
          instructions: 'Give 7.5 ml by mouth every 6 hours as needed for fever. Max 4 doses/day. Weight 12.5 kg x 15 mg/kg = 187.5 mg.',
          qty: 1,
        },
      ]),
      staffId
    );

    const unmapped = await staffAs(staffId)
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .send({ delivery_type: 'counter' });
    expect(unmapped.statusCode).toBe(400);
    expect(unmapped.body.details?.code).toBe('ITEM_NOT_IN_CATALOG');
    expect(unmapped.body.details?.suggestions?.Paracetamol?.length).toBeGreaterThan(0);

    const mapped = await staffAs(staffId)
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .send({
        delivery_type: 'counter',
        catalog_overrides: {
          Paracetamol: catalogRows[0].id,
        },
      });
    expect(mapped.statusCode).toBe(200);
    expect(mapped.body.data.id).toBeDefined();

    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT items_list, total_amount
         FROM pharmacy_orders
        WHERE id = $1`,
      mapped.body.data.id
    );
    expect(Number(orderRows[0].total_amount)).toBe(35);
    expect(orderRows[0].items_list[0].catalog_id).toBe(catalogRows[0].id);
    expect(orderRows[0].items_list[0].catalog_name).toBe(PEDIATRIC_PARACETAMOL_NAME);
    expect(orderRows[0].items_list[0].substitution).toMatchObject({
      requested_name: 'Paracetamol',
      catalog_name: PEDIATRIC_PARACETAMOL_NAME,
      explicit: true,
    });
    expect(orderRows[0].items_list[0]).toMatchObject({
      dispensed_quantity_ml: 7.5,
      child_weight_kg: 12.5,
    });
    expect(orderRows[0].items_list[0].measuring_instruction).toMatch(/medicine cup/i);

    const pharmacy = clientAs('PHARMACY_STAFF', STAFF_UID, staffId);
    const unpaid = await pharmacy.post(`/api/v1/pharmacy/orders/${mapped.body.data.id}/dispense-counter`).send({});
    expect(unpaid.statusCode).toBe(400);
    expect(unpaid.body.details?.code).toBe('COUNTER_PAYMENT_REQUIRED');

    const paid = await pharmacy.post(`/api/v1/pharmacy/orders/${mapped.body.data.id}/dispense-counter`).send({
      payment_mode: 'cash',
      amount_collected: 35,
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.body.data.payment_status).toBe('paid');

    const detail = await pharmacy.get(`/api/v1/pharmacy/orders/${mapped.body.data.id}/detail`);
    expect(detail.statusCode).toBe(200);
    const labelItem = detail.body.data.order.dispense_label.items[0];
    expect(labelItem.child_weight_kg).toBe(12.5);
    expect(labelItem.dispensed_quantity_ml).toBe(7.5);
    expect(labelItem.measuring_instruction).toMatch(/oral syringe/i);

    const patient = clientAs('PATIENT', PATIENT_UID, patientId);
    const patientList = await patient.get('/api/v1/prescriptions/patient/my');
    expect(patientList.statusCode).toBe(200);
    const patientRx = patientList.body.data.find((row) => row.id === rxRows[0].id);
    expect(patientRx).toMatchObject({
      pharmacy_order_id: mapped.body.data.id,
      pharmacy_order_status: 'DISPENSED',
      pharmacy_payment_status: 'paid',
      pharmacy_partial_dispense: false,
    });
    expect(Number(patientRx.pharmacy_amount_collected)).toBe(35);
  });

  it('recalculates dispensed mL when substituting to a different concentration', async () => {
    // Finding 2026-05-21-walk-in-opd-pharmacy-c05e2adb: prescribed 3.75 mL of
    // 250mg/5mL (187.5 mg); substituting to 125mg/5mL must recalc to 7.5 mL to
    // preserve the mg dose, not silently keep 3.75 mL (a 50% paediatric underdose).
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, category, unit_price, price, pack_size,
          requires_prescription, in_stock, is_active, is_available,
          stock_quantity, stock, reorder_level, description, updated_at)
       VALUES
         ('Paracetamol Syrup 125mg/5ml Recalc Test', 'Paracetamol', 'analgesic', 35.00, 35.00, '60 ml bottle',
          true, true, true, true, 50, 50, 10, 'Recalc substitution fixture', NOW())
       RETURNING id`,
    );
    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions (patient_id, doctor_id, medications, status, created_by)
       VALUES ($1, $2, $3::jsonb, 'active', $4) RETURNING id`,
      patientId, doctorId,
      JSON.stringify([{
        name: 'Paracetamol 250mg/5mL syrup',
        dosage: 'Syrup 250 mg/5 mL: 3.75 mL',
        frequency: 'QID', duration: '3 days', route: 'Oral',
        instructions: 'Give 3.75 ml every 6 hours. Weight 12.5 kg.',
        qty: 1,
      }]),
      staffId,
    );
    const mapped = await staffAs(staffId)
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .send({
        delivery_type: 'counter',
        catalog_overrides: { 'Paracetamol 250mg/5mL syrup': catalogRows[0].id },
      });
    expect(mapped.statusCode).toBe(200);
    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT items_list FROM pharmacy_orders WHERE id = $1`, mapped.body.data.id);
    const item = orderRows[0].items_list[0];
    expect(item.dispensed_quantity_ml).toBe(7.5);
    expect(item.substitution).toMatchObject({
      explicit: true,
      original_dispensed_quantity_ml: 3.75,
      recalculated_dispensed_quantity_ml: 7.5,
    });
    expect(item.measuring_instruction).toMatch(/7\.5 ml/i);

    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE id = $1`, mapped.body.data.id).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE id = $1`, rxRows[0].id).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE id = $1`, catalogRows[0].id).catch(() => {});
  });

  it('creates medication reminders from a q6h paediatric prescription', async () => {
    const res = await staffAs(staffId)
      .post('/api/v1/prescriptions/create')
      .send({
        patient_id: patientId,
        doctor_id: doctorId,
        diagnosis: 'Viral fever',
        clinical_notes: 'Hydration advice given.',
        medications: [
          {
            name: 'Paracetamol syrup 125mg/5ml',
            dosage: '187.5 mg (7.5 ml)',
            dose: '187.5 mg (7.5 ml)',
            frequency: 'q6h PRN fever',
            duration: '3 days',
            route: 'oral',
            instructions: 'Give 7.5 ml by mouth every 6 hours as needed for fever. Max 4 doses/day.',
            max_doses_per_day: 4,
          },
        ],
      });

    expect(res.statusCode).toBe(201);
    const reminders = await prisma.$queryRawUnsafe(
      `SELECT medication_name, dosage, frequency, reminder_times, notes
         FROM medication_reminders
        WHERE patient_uid = $1::uuid
          AND medication_name ILIKE 'Paracetamol%'
          AND is_active = true
        ORDER BY created_at DESC
        LIMIT 1`,
      PATIENT_UID,
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0].frequency).toBe('four_times_daily');
    expect(reminders[0].reminder_times).toEqual(['06:00', '12:00', '18:00', '00:00']);
    expect(reminders[0].notes).toMatch(/Max 4 doses\/day/i);
  });
});
