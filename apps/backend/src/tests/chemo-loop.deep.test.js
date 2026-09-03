// Roadmap D1 — chemo closed-loop deep round-trip.
//
// Protocol (with an anthracycline ceiling) → activate → treatment plan
// (BSA from latest vitals) → cycle 1 schedule (per-drug administrations at
// BSA dose) → two-person verification (different-human guard) → administer
// (cumulative dose updated in-tx) → ceiling breach blocks a later cycle
// without an override reason → withhold requires a reason.

import jwt from 'jsonwebtoken';
import request from 'supertest';
import prisma from '../lib/prisma.js';
import app from '../app.js';
import { authClient, API_KEY, ensureTestIdentity } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TEST_NAME = 'D1TEST OncoPatient';
const OTHER_TEST_NAME = 'D1TEST OncoPatient Two';
const PROTO_CODE = `D1T${String(Date.now()).slice(-6)}`;

let patientUid;
let otherPatientUid;
let protocolId;
let planId;
let otherPlanId;
let cycle;
let otherCycle;
let doxAdminId;
let chairId;
let bookingId;

// Second verifier must be a DIFFERENT human — mint a token with another uid.
// It is hand-signed rather than built by the test helper, and the subject has
// to exist: authentication now fails closed on a uid with no live identity
// row, so an unseeded second verifier 401s and the different-human guard
// below never actually runs.
const SECOND_NURSE_UID = '660e8400-e29b-41d4-a716-446655440111';

beforeAll(async () => {
  await ensureTestIdentity(SECOND_NURSE_UID, { role: 'NURSE' });
});

function secondNurse() {
  const secret = process.env.JWT_SECRET || 'test-jwt-secret';
  const token = jwt.sign({
    uid: SECOND_NURSE_UID,
    id: 2,
    phone: '9876543211',
    role: 'NURSE',
    deviceType: 'desktop',
  }, secret, { expiresIn: '1h' });
  return {
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM chair_bookings WHERE patient_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))`,
    TEST_NAME,
    OTHER_TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM infusion_chairs WHERE chair_code LIKE 'D1T-%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM chemo_cumulative_doses WHERE patient_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))`,
    TEST_NAME,
    OTHER_TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM chemo_treatment_plans WHERE patient_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))`,
    TEST_NAME,
    OTHER_TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM chemo_protocols WHERE code LIKE 'D1T%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM vitals_chart WHERE patient_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))`,
    TEST_NAME,
    OTHER_TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid IN (SELECT uid FROM users WHERE name IN ($1, $2))`,
    TEST_NAME,
    OTHER_TEST_NAME,
  ).catch(() => {});
  // clinical_audit_events is append-only — the C4 hash chain must never
  // have holes, so test cleanup deliberately leaves audit rows in place.
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name IN ($1, $2)`, TEST_NAME, OTHER_TEST_NAME).catch(() => {});
}

d('Chemo closed loop — deep round-trip (roadmap D1)', () => {
  const doctor = authClient('DOCTOR');
  const nurse = authClient('NURSE');

  beforeAll(async () => {
    await cleanup();
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, $2, 'PATIENT', true, NOW()) RETURNING uid`,
      `+9198833${String(Date.now() % 10000).padStart(4, '0')}`,
      TEST_NAME,
    );
    patientUid = u[0].uid;
    const u2 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, $2, 'PATIENT', true, NOW()) RETURNING uid`,
      `+9198844${String(Date.now() % 10000).padStart(4, '0')}`,
      OTHER_TEST_NAME,
    );
    otherPatientUid = u2[0].uid;
    // 170 cm / 70 kg → BSA 1.82 m² (Mosteller).
    await prisma.$queryRawUnsafe(
      `INSERT INTO vitals_chart (patient_uid, weight_kg, height_cm, recorded_at)
       VALUES ($1::uuid, 70, 170, NOW())`,
      patientUid,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO vitals_chart (patient_uid, weight_kg, height_cm, recorded_at)
       VALUES ($1::uuid, 62, 166, NOW())`,
      otherPatientUid,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('doctor creates + activates a protocol with an anthracycline ceiling', async () => {
    const res = await doctor.post('/api/v1/oncology/protocols').send({
      code: PROTO_CODE,
      name: 'AC test protocol',
      cycle_length_days: 21,
      total_cycles: 4,
      drugs: [
        // Ceiling chosen so cycle 1 passes (60 × 1) and cycle 2 breaches (120 > 100).
        { drug_name: 'Doxorubicin', dose_per_m2: 60, max_lifetime_dose_per_m2: 100, is_vesicant: true },
        { drug_name: 'Cyclophosphamide', dose_per_m2: 600 },
      ],
    });
    expect(res.status).toBe(201);
    protocolId = res.body.data.protocol.id;

    const nurseDenied = await nurse.post('/api/v1/oncology/protocols').send({
      code: `${PROTO_CODE}X`, name: 'no', cycle_length_days: 21, drugs: [{ drug_name: 'X', fixed_dose: 1 }],
    });
    expect(nurseDenied.status).toBe(403);

    const act = await doctor.post(`/api/v1/oncology/protocols/${protocolId}/activate`).send({});
    expect(act.status).toBe(200);
    expect(act.body.data.protocol.status).toBe('active');
  });

  test('rejects protocols with broken dosing definitions', async () => {
    const both = await doctor.post('/api/v1/oncology/protocols').send({
      code: `${PROTO_CODE}B`, name: 'bad', cycle_length_days: 21,
      drugs: [{ drug_name: 'Bad', dose_per_m2: 60, fixed_dose: 100 }],
    });
    expect(both.status).toBe(400);

    const badDay = await doctor.post('/api/v1/oncology/protocols').send({
      code: `${PROTO_CODE}C`, name: 'bad days', cycle_length_days: 21,
      drugs: [{ drug_name: 'Bad', dose_per_m2: 60, days_of_cycle: [25] }],
    });
    expect(badDay.status).toBe(400);
  });

  test('creates a treatment plan with BSA pulled from vitals', async () => {
    const res = await doctor.post(`/api/v1/oncology/protocols/${protocolId}/plans`).send({
      patient_uid: patientUid,
      consent_ref: 'CONSENT-D1-001',
    });
    expect(res.status).toBe(201);
    planId = res.body.data.plan.id;
    expect(Number(res.body.data.plan.bsa_m2)).toBe(1.82);
    expect(Number(res.body.data.plan.height_cm)).toBe(170);

    const dup = await doctor.post(`/api/v1/oncology/protocols/${protocolId}/plans`).send({
      patient_uid: patientUid,
    });
    expect(dup.status).toBe(409);

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'chemo.plan_created'`,
      patientUid,
    );
    expect(events.length).toBe(1);
  });

  test('creates a second patient plan for chair conflict coverage', async () => {
    const res = await doctor.post(`/api/v1/oncology/protocols/${protocolId}/plans`).send({
      patient_uid: otherPatientUid,
      consent_ref: 'CONSENT-D1-002',
    });
    expect(res.status).toBe(201);
    otherPlanId = res.body.data.plan.id;
  });

  test('schedules cycle 1 with per-drug BSA doses', async () => {
    const res = await doctor.post(`/api/v1/oncology/plans/${planId}/cycles`).send({
      cycle_number: 1,
      scheduled_date: '2026-06-15',
    });
    expect(res.status).toBe(201);
    cycle = res.body.data.cycle;
    const administrations = res.body.data.administrations;
    expect(administrations).toHaveLength(2);

    const dox = administrations.find((a) => a.drug_name === 'Doxorubicin');
    const cyclo = administrations.find((a) => a.drug_name === 'Cyclophosphamide');
    doxAdminId = dox.id;
    expect(Number(dox.final_dose)).toBe(109.2);   // 60 × 1.82
    expect(Number(cyclo.final_dose)).toBe(1092);  // 600 × 1.82
    expect(res.body.data.ceiling_breaches).toEqual([]);

    const dupCycle = await doctor.post(`/api/v1/oncology/plans/${planId}/cycles`).send({
      cycle_number: 1, scheduled_date: '2026-06-16',
    });
    expect(dupCycle.status).toBe(409);

    const other = await doctor.post(`/api/v1/oncology/plans/${otherPlanId}/cycles`).send({
      cycle_number: 1,
      scheduled_date: '2026-06-15',
    });
    expect(other.status).toBe(201);
    otherCycle = other.body.data.cycle;
  });

  test('books an infusion chair, rejects double-booking, and surfaces on the plan', async () => {
    const chair = await doctor.post('/api/v1/oncology/infusion-chairs').send({
      unit_name: 'Day Care',
      chair_code: `D1T-${String(Date.now()).slice(-5)}`,
      display_name: 'Day Care Infusion Chair D1',
    });
    expect(chair.status).toBe(201);
    chairId = chair.body.data.chair.id;

    const booking = await doctor.post('/api/v1/oncology/chair-bookings').send({
      cycle_id: cycle.id,
      chair_id: chairId,
      start_at: '2026-06-15T09:00:00+05:30',
      end_at: '2026-06-15T11:00:00+05:30',
      notes: 'Premeds at 08:45; vesicant precautions.',
    });
    expect(booking.status).toBe(201);
    bookingId = booking.body.data.booking.id;
    expect(booking.body.data.booking.status).toBe('booked');
    expect(booking.body.data.warnings).toEqual([]);

    const conflict = await doctor.post('/api/v1/oncology/chair-bookings').send({
      cycle_id: otherCycle.id,
      chair_id: chairId,
      start_at: '2026-06-15T10:00:00+05:30',
      end_at: '2026-06-15T12:00:00+05:30',
    });
    expect(conflict.status).toBe(409);
    expect(JSON.stringify(conflict.body)).toContain('already booked');

    const detail = await doctor.get(`/api/v1/oncology/plans/${planId}`);
    expect(detail.status).toBe(200);
    const bookedCycle = detail.body.data.plan.cycles.find((c) => c.id === cycle.id);
    expect(bookedCycle.chair_bookings).toHaveLength(1);
    expect(bookedCycle.chair_bookings[0].chair_id).toBe(chairId);

    const board = await doctor.get('/api/v1/oncology/infusion-board?date=2026-06-15');
    expect(board.status).toBe(200);
    expect(board.body.data.board.bookings.some((b) => b.id === bookingId)).toBe(true);
  });

  test('two-person verification enforces the different-human guard', async () => {
    const first = await nurse.post(`/api/v1/oncology/administrations/${doxAdminId}/verify`).send({
      verifier_role: 'first',
      scanned_patient_uid: patientUid,
    });
    expect(first.status).toBe(200);
    expect(first.body.data.verification.status).toBe('first_verified');

    // Same human tries the second check → blocked.
    const sameHuman = await nurse.post(`/api/v1/oncology/administrations/${doxAdminId}/verify`).send({
      verifier_role: 'second',
    });
    expect(sameHuman.status).toBe(403);

    // Administering before double verification → blocked.
    const early = await nurse.post(`/api/v1/oncology/administrations/${doxAdminId}/administer`).send({});
    expect(early.status).toBe(400);

    const second = await secondNurse().post(`/api/v1/oncology/administrations/${doxAdminId}/verify`).send({
      verifier_role: 'second',
      scanned_patient_uid: patientUid,
    });
    expect(second.status).toBe(200);
    expect(second.body.data.verification.status).toBe('double_verified');
  });

  test('wristband mismatch blocks verification', async () => {
    const cyclo = await prisma.$queryRawUnsafe(
      `SELECT id FROM chemo_administrations WHERE cycle_id = $1 AND drug_name = 'Cyclophosphamide'`,
      cycle.id,
    );
    const res = await nurse.post(`/api/v1/oncology/administrations/${cyclo[0].id}/verify`).send({
      verifier_role: 'first',
      scanned_patient_uid: '770e8400-e29b-41d4-a716-446655440999',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('wristband');
  });

  test('administers the double-verified line and updates cumulative dose in-tx', async () => {
    const res = await nurse.post(`/api/v1/oncology/administrations/${doxAdminId}/administer`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.administration.status).toBe('administered');

    const cumulative = await prisma.$queryRawUnsafe(
      `SELECT total_dose, total_dose_per_m2, administration_count FROM chemo_cumulative_doses
       WHERE patient_uid = $1::uuid AND drug_name = 'doxorubicin'`,
      patientUid,
    );
    expect(cumulative.length).toBe(1);
    expect(Number(cumulative[0].total_dose)).toBe(109.2);
    expect(Number(cumulative[0].total_dose_per_m2)).toBe(60);
    expect(cumulative[0].administration_count).toBe(1);

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'chemo.administered'`,
      patientUid,
    );
    expect(events.length).toBe(1);

    const chairBooking = await prisma.$queryRawUnsafe(
      `SELECT status FROM chair_bookings WHERE id = $1`,
      bookingId,
    );
    expect(chairBooking[0].status).toBe('booked');
  });

  test('cancelling a chair booking frees the slot', async () => {
    const cancelled = await doctor.post(`/api/v1/oncology/chair-bookings/${bookingId}/cancel`).send({
      reason: 'Moved to observation bay after premeds',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.booking.status).toBe('cancelled');

    const reused = await doctor.post('/api/v1/oncology/chair-bookings').send({
      cycle_id: otherCycle.id,
      chair_id: chairId,
      start_at: '2026-06-15T09:30:00+05:30',
      end_at: '2026-06-15T10:30:00+05:30',
    });
    expect(reused.status).toBe(201);
    expect(reused.body.data.booking.status).toBe('booked');
  });

  test('cumulative ceiling blocks cycle 2 without an override, allows with one', async () => {
    // Cycle 2 doxorubicin: 60 existing + 60 planned = 120 > 100 ceiling.
    const blocked = await doctor.post(`/api/v1/oncology/plans/${planId}/cycles`).send({
      cycle_number: 2,
      scheduled_date: '2026-07-06',
    });
    expect(blocked.status).toBe(400);
    expect(JSON.stringify(blocked.body)).toContain('ceiling would be breached');
    expect(JSON.stringify(blocked.body)).toContain('Doxorubicin');

    const overridden = await doctor.post(`/api/v1/oncology/plans/${planId}/cycles`).send({
      cycle_number: 2,
      scheduled_date: '2026-07-06',
      ceiling_override_reason: 'Oncology board approved final cycle with cardiac monitoring',
    });
    expect(overridden.status).toBe(201);
    expect(overridden.body.data.ceiling_breaches).toHaveLength(1);
    const dox2 = overridden.body.data.administrations.find((a) => a.drug_name === 'Doxorubicin');
    expect(dox2.ceiling_override_reason).toContain('Oncology board');
  });

  test('withholding requires a reason and is recorded', async () => {
    const cyclo = await prisma.$queryRawUnsafe(
      `SELECT id FROM chemo_administrations WHERE cycle_id = $1 AND drug_name = 'Cyclophosphamide'`,
      cycle.id,
    );
    const noReason = await nurse.post(`/api/v1/oncology/administrations/${cyclo[0].id}/withhold`).send({});
    expect(noReason.status).toBe(400);

    const res = await nurse.post(`/api/v1/oncology/administrations/${cyclo[0].id}/withhold`).send({
      reason: 'Neutropenia — ANC below threshold',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.administration.status).toBe('withheld');

    // Every line in cycle 1 is now administered/withheld → cycle flips.
    const cycleRow = await prisma.$queryRawUnsafe(
      `SELECT status FROM chemo_cycles WHERE id = $1`, cycle.id,
    );
    expect(cycleRow[0].status).toBe('administered');
  });

  test('plan detail exposes cycles, administrations, and cumulative doses', async () => {
    const res = await doctor.get(`/api/v1/oncology/plans/${planId}`);
    expect(res.status).toBe(200);
    const plan = res.body.data.plan;
    expect(plan.cycles).toHaveLength(2);
    expect(plan.cumulative.find((c) => c.drug_name === 'doxorubicin')).toBeTruthy();
  });
});
