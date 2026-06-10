// Roadmap D7 — dialysis depth deep round-trip.
//
// Prescription (one active, supersession) → session inherits prescription
// params → machine-data ingestion through the B3 inbox (matched by
// machine_no, observations tagged source=device, failures replayable) →
// structured complication events (session flags + canonical timeline).

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TEST_NAME = 'D7TEST DialysisPatient';
const MACHINE = `D7T-MACH-${String(Date.now()).slice(-5)}`;

let patientUid;
let dialysisPatientId;
let sessionId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM dialysis_patients WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_interface_messages WHERE analyzer_code = $1`, MACHINE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  // clinical_audit_events is append-only — the C4 hash chain must never
  // have holes, so test cleanup deliberately leaves audit rows in place.
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, TEST_NAME).catch(() => {});
}

d('Dialysis depth — prescriptions, machine ingest, complications (roadmap D7)', () => {
  const doctor = authClient('DOCTOR');
  const nurse = authClient('NURSE');

  beforeAll(async () => {
    await cleanup();
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, $2, 'PATIENT', true, NOW()) RETURNING uid`,
      `+9198844${String(Date.now() % 10000).padStart(4, '0')}`,
      TEST_NAME,
    );
    patientUid = u[0].uid;

    const enrol = await doctor.post('/api/v1/dialysis/patients').send({
      patient_uid: patientUid,
      modality: 'hd',
    });
    expect(enrol.status).toBe(200);
    dialysisPatientId = enrol.body.data.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('doctor writes a standing prescription; nurse cannot; supersession works', async () => {
    const denied = await nurse.post(`/api/v1/dialysis/patients/${dialysisPatientId}/prescription`).send({
      duration_minutes: 240,
    });
    expect(denied.status).toBe(403);

    const first = await doctor.post(`/api/v1/dialysis/patients/${dialysisPatientId}/prescription`).send({
      modality: 'hd',
      sessions_per_week: 3,
      duration_minutes: 240,
      dialyser: 'F8 HPS',
      dialysate_k_mmol: 2.0,
      blood_flow_ml_min: 300,
      max_uf_ml_per_session: 3000,
      anticoag: 'heparin',
      anticoag_loading: '2000 IU',
      anticoag_maintenance: '500 IU/hr',
      target_dry_weight_kg: 62.5,
    });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('active');

    const second = await doctor.post(`/api/v1/dialysis/patients/${dialysisPatientId}/prescription`).send({
      modality: 'hdf',
      sessions_per_week: 3,
      duration_minutes: 270,
      dialyser: 'FX80',
      anticoag: 'lmwh',
      anticoag_loading: '40 mg enoxaparin',
    });
    expect(second.status).toBe(200);

    const list = await doctor.get(`/api/v1/dialysis/patients/${dialysisPatientId}/prescription`);
    expect(list.status).toBe(200);
    expect(list.body.data.active.modality).toBe('hdf');
    expect(list.body.data.history).toHaveLength(2);
    expect(list.body.data.history.filter((p) => p.status === 'active')).toHaveLength(1);

    // Roster snapshot stays in sync.
    const roster = await prisma.$queryRawUnsafe(
      `SELECT modality, prescribed_minutes, anticoag_default FROM dialysis_patients WHERE id = $1`,
      dialysisPatientId,
    );
    expect(roster[0].modality).toBe('hdf');
    expect(roster[0].prescribed_minutes).toBe(270);
    expect(roster[0].anticoag_default).toBe('lmwh');

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'dialysis.prescribed'`,
      patientUid,
    );
    expect(events.length).toBe(2);
  });

  test('scheduled sessions inherit the active prescription', async () => {
    const res = await nurse.post('/api/v1/dialysis/sessions').send({
      dialysis_patient_id: dialysisPatientId,
      session_date: '2026-06-11',
      machine_no: MACHINE,
    });
    expect(res.status).toBe(200);
    const session = res.body.data;
    sessionId = session.id;
    expect(session.modality).toBe('hdf');
    expect(session.dialyser).toBe('FX80');
    expect(session.anticoag).toBe('lmwh');
    expect(session.anticoag_initial_dose).toBe('40 mg enoxaparin');
    expect(session.prescription_id).toBeTruthy();
  });

  test('machine ingest fails cleanly when no session is in progress (inbox: failed)', async () => {
    const res = await nurse.post('/api/v1/dialysis/machines/ingest').send({
      machine_no: MACHINE,
      observations: [{ bp_systolic: 118, bp_diastolic: 74 }],
    });
    expect(res.status).toBe(404);

    const inbox = await prisma.$queryRawUnsafe(
      `SELECT status, error FROM lab_interface_messages
       WHERE analyzer_code = $1 ORDER BY id DESC LIMIT 1`,
      MACHINE,
    );
    expect(inbox[0].status).toBe('failed');
    expect(inbox[0].error).toContain('No in-progress dialysis session');
  });

  test('machine observations land on the in-progress session tagged device', async () => {
    const start = await nurse.post(`/api/v1/dialysis/sessions/${sessionId}/start`).send({
      pre_weight_kg: 65.2, pre_bp_systolic: 142, pre_bp_diastolic: 88,
    });
    expect(start.status).toBe(200);

    const res = await nurse.post('/api/v1/dialysis/machines/ingest').send({
      machine_no: MACHINE,
      observations: [
        { bp_systolic: 121, bp_diastolic: 75, pulse: 80, blood_flow_ml_min: 320, uf_rate_ml_hr: 850, uf_total_ml: 400, junk_field: 'ignored' },
        { bp_systolic: 112, bp_diastolic: 70, pulse: 84, blood_flow_ml_min: 320, uf_rate_ml_hr: 850, uf_total_ml: 820, conductivity_ms_cm: 14.1 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.ingested).toBe(2);
    expect(res.body.data.session_id).toBe(sessionId);

    const obs = await nurse.get(`/api/v1/dialysis/sessions/${sessionId}/obs`);
    const deviceObs = obs.body.data.filter((o) => o.source === 'device');
    expect(deviceObs).toHaveLength(2);
    expect(deviceObs[0].source_device).toBe(MACHINE);
    expect(deviceObs.every((o) => o.junk_field === undefined)).toBe(true);

    const inbox = await prisma.$queryRawUnsafe(
      `SELECT status, result_count FROM lab_interface_messages
       WHERE analyzer_code = $1 ORDER BY id DESC LIMIT 1`,
      MACHINE,
    );
    expect(inbox[0].status).toBe('ingested');
    expect(inbox[0].result_count).toBe(2);
  });

  test('manual observations stay source=staff', async () => {
    const res = await nurse.post(`/api/v1/dialysis/sessions/${sessionId}/obs`).send({
      bp_systolic: 100, bp_diastolic: 64, pulse: 92,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('staff');
  });

  test('structured complication sets the session flag and hits the timeline', async () => {
    const bad = await nurse.post(`/api/v1/dialysis/sessions/${sessionId}/events`).send({
      event_type: 'spontaneous_combustion',
    });
    expect(bad.status).toBe(400);

    const res = await nurse.post(`/api/v1/dialysis/sessions/${sessionId}/events`).send({
      event_type: 'hypotension',
      severity: 'moderate',
      bp_systolic: 84,
      bp_diastolic: 50,
      intervention: 'Saline bolus',
      intervention_dose: '250 mL',
      resolved: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.event_type).toBe('hypotension');

    const session = await prisma.$queryRawUnsafe(
      `SELECT intra_dialytic_hypotension FROM dialysis_sessions WHERE id = $1`,
      sessionId,
    );
    expect(session[0].intra_dialytic_hypotension).toBe(true);

    const events = await nurse.get(`/api/v1/dialysis/sessions/${sessionId}/events`);
    expect(events.body.data).toHaveLength(1);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'dialysis.complication'`,
      patientUid,
    );
    expect(timeline.length).toBe(1);
  });
});
