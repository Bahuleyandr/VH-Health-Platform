// Roadmap B5 — transfusion closed loop deep round-trip.
//
// register units → request → unit-level crossmatch (matrix conflicts need
// override) → issue → two-person bedside verification (same-verifier
// blocked, failed checks need override) → start → complete; legacy
// /transfused honours the verification gate; structured reaction lands with
// canonical events throughout.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const RUN = String(Date.now() % 100000).padStart(5, '0');
const PHONE = `+9199910${String(Date.now() % 10000).padStart(4, '0')}`;
let patientUid;
let requestId;      // the closed-loop request
let legacyRequestId; // exercises the legacy /transfused gate
let unitId;
let unitNumber;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM blood_requests WHERE clinical_indication LIKE 'B5TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM blood_units WHERE unit_number LIKE 'B5TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'B5TEST Patient'`).catch(() => {});
}

d('Transfusion closed loop — deep round-trip (roadmap B5)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, blood_group, updated_at)
       VALUES ($1, 'B5TEST Patient', 'PATIENT', true, 'A+', NOW()) RETURNING id, uid`,
      PHONE,
    );
    patientUid = p[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('register units; stock lists with expiry-first ordering', async () => {
    unitNumber = `B5TEST-${RUN}-1`;
    const ok = await authClient('BLOOD_BANK_TECHNICIAN')
      .post('/api/v1/blood-bank/units')
      .send({
        unit_number: unitNumber,
        blood_group: 'O-',
        component: 'prbc',
        expiry_date: '2027-01-01',
        source_blood_bank: 'B5TEST Regional Blood Bank',
      });
    expect(ok.status).toBe(201);
    unitId = Number(ok.body.data.id);
    expect(ok.body.data.status).toBe('available');

    const wrongGroup = await authClient('BLOOD_BANK_TECHNICIAN')
      .post('/api/v1/blood-bank/units')
      .send({
        unit_number: `B5TEST-${RUN}-B`,
        blood_group: 'B+',
        component: 'prbc',
        expiry_date: '2027-01-01',
      });
    expect(wrongGroup.status).toBe(201);

    const list = await authClient('BLOOD_BANK_TECHNICIAN')
      .get('/api/v1/blood-bank/units')
      .query({ status: 'available' });
    expect(list.status).toBe(200);
    expect(list.body.data.units.some((u) => u.unit_number === unitNumber)).toBe(true);
  });

  test('create request; matrix-incompatible unit cannot be recorded compatible without override', async () => {
    const req = await authClient('DOCTOR')
      .post('/api/v1/blood-bank/request')
      .send({
        patient_uid: patientUid,
        blood_group: 'A+',
        component: 'prbc',
        units: 1,
        urgency: 'urgent',
        clinical_indication: 'B5TEST symptomatic anaemia Hb 6.2',
      });
    expect(req.status).toBe(201);
    requestId = Number(req.body.data.id);

    const wrongUnits = await prisma.$queryRawUnsafe(
      `SELECT id FROM blood_units WHERE unit_number = $1`, `B5TEST-${RUN}-B`,
    );
    const conflict = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/${requestId}/crossmatch-unit`)
      .send({ unit_id: Number(wrongUnits[0].id), result: 'compatible' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.details.matrix_verdict.mode).toBe('incompatible');
  });

  test('crossmatch the compatible unit; request + unit are pinned; timeline event lands', async () => {
    const res = await authClient('BLOOD_BANK_TECHNICIAN')
      .post(`/api/v1/blood-bank/${requestId}/crossmatch-unit`)
      .send({ unit_id: unitId, result: 'compatible' });
    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe('cross_matched');
    expect(Number(res.body.data.request.crossmatched_unit_id)).toBe(unitId);
    expect(res.body.data.matrix_verdict.compatible).toBe(true); // O- → A+ red cells

    const unit = await prisma.$queryRawUnsafe(`SELECT status, request_id FROM blood_units WHERE id = $1`, unitId);
    expect(unit[0].status).toBe('crossmatched');
    expect(Number(unit[0].request_id)).toBe(requestId);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'blood_requests' AND source_id = $1`,
      String(requestId),
    );
    expect(timeline.map((t) => t.event_type)).toContain('transfusion.crossmatched');
  });

  test('issue, then bedside verification: wrong scans fail closed; same second verifier blocked', async () => {
    const issue = await authClient('BLOOD_BANK_TECHNICIAN')
      .put(`/api/v1/blood-bank/${requestId}/issue`).send({});
    expect(issue.status).toBe(200);

    // start/complete blocked before verification
    const earlyStart = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/start-transfusion`).send({});
    expect(earlyStart.status).toBe(409);

    const badScan = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/verify-bedside`)
      .send({
        verifier_role: 'first',
        scanned_unit_number: 'WRONG-UNIT-1',
        scanned_patient_uid: patientUid,
      });
    expect(badScan.status).toBe(409);
    expect(badScan.body.details.checks.unit_match).toBe(false);

    const first = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/verify-bedside`)
      .send({
        verifier_role: 'first',
        scanned_unit_number: unitNumber,
        scanned_patient_uid: patientUid,
      });
    expect(first.status).toBe(200);
    expect(first.body.data.all_checks_passed).toBe(true);

    // Same human cannot be the second pair of eyes (same default test uid).
    const sameVerifier = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/verify-bedside`)
      .send({
        verifier_role: 'second',
        scanned_unit_number: unitNumber,
        scanned_patient_uid: patientUid,
      });
    expect(sameVerifier.status).toBe(409);

    const second = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/verify-bedside`)
      .send({
        verifier_role: 'second',
        scanned_unit_number: unitNumber,
        scanned_patient_uid: patientUid,
      });
    // Second verifier with a DIFFERENT uid:
    expect(sameVerifier.status).toBe(409);
    expect(second.status).toBe(409); // still same uid — now do it properly below
  });

  test('second verifier with a different identity clears the gate; start + complete proceed', async () => {
    // Insert the second verification as a different staff member directly
    // through the service contract (HTTP token carries a fixed test uid).
    const { recordBedsideVerification } = await import('../services/bloodbank/transfusionSafetyService.js');
    const second = await recordBedsideVerification(requestId, {
      verifierRole: 'second',
      scannedUnitNumber: unitNumber,
      scannedPatientUid: patientUid,
    }, { actorUid: 'b5b5b5b5-2222-4222-8222-b5b5b5b5fd02', actorRole: 'NURSING_INCHARGE' });
    expect(second.all_checks_passed).toBe(true);

    const start = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/start-transfusion`).send({});
    expect(start.status).toBe(200);
    expect(start.body.data.transfusion_started_at).toBeTruthy();

    const complete = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/complete-transfusion`)
      .send({ notes: 'B5TEST uneventful 1 unit over 3h' });
    expect(complete.status).toBe(200);
    expect(complete.body.data.status).toBe('transfused');

    const unit = await prisma.$queryRawUnsafe(`SELECT status FROM blood_units WHERE id = $1`, unitId);
    expect(unit[0].status).toBe('transfused');

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'blood_requests' AND source_id = $1`,
      String(requestId),
    );
    const types = timeline.map((t) => t.event_type);
    expect(types).toEqual(expect.arrayContaining([
      'transfusion.crossmatched', 'transfusion.bedside_verified',
      'transfusion.started', 'transfusion.completed',
    ]));
  });

  test('structured reaction report validates enums and lands with an event', async () => {
    const bad = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/reaction`)
      .send({ reaction_type: 'sneeze', severity: 'mild' });
    expect(bad.status).toBe(400);

    const ok = await authClient('NURSING_STAFF')
      .post(`/api/v1/blood-bank/${requestId}/reaction`)
      .send({
        reaction_type: 'febrile',
        severity: 'mild',
        symptoms: 'B5TEST rigors, temp 38.4 at 45 min',
        vitals: { temp_c: 38.4, hr: 104, bp: '118/76' },
        intervention: 'Paused, paracetamol given, restarted at slower rate',
        transfusion_stopped: false,
      });
    expect(ok.status).toBe(201);
    expect(ok.body.data.reaction_type).toBe('febrile');

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'blood_requests' AND source_id = $1
          AND event_type = 'transfusion.reaction_reported'`,
      String(requestId),
    );
    expect(timeline.length).toBeGreaterThanOrEqual(1);
  });

  test('legacy PUT /:id/transfused honours the verification gate', async () => {
    const req = await authClient('DOCTOR')
      .post('/api/v1/blood-bank/request')
      .send({
        patient_uid: patientUid,
        blood_group: 'A+',
        component: 'prbc',
        units: 1,
        clinical_indication: 'B5TEST second unit',
      });
    legacyRequestId = Number(req.body.data.id);

    // Walk it to issued via the legacy unit-less endpoints.
    const cm = await authClient('BLOOD_BANK_TECHNICIAN')
      .put(`/api/v1/blood-bank/${legacyRequestId}/cross-match`)
      .send({ cross_match_status: 'compatible' });
    expect(cm.status).toBe(200);
    const issue = await authClient('BLOOD_BANK_TECHNICIAN')
      .put(`/api/v1/blood-bank/${legacyRequestId}/issue`).send({});
    expect(issue.status).toBe(200);

    const blocked = await authClient('NURSING_STAFF')
      .put(`/api/v1/blood-bank/${legacyRequestId}/transfused`).send({});
    expect(blocked.status).toBe(409);
  });
});
