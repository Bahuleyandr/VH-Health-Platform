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
const MACHINE_2 = `${MACHINE}-B`;
const TENANT = '00000000-0000-4000-8000-000000000001';

let patientUid;
let dialysisPatientId;
let sessionId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_payments
      WHERE invoice_id IN (
        SELECT id FROM billing_invoices
        WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)
      )`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_invoice_items
      WHERE invoice_id IN (
        SELECT id FROM billing_invoices
        WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)
      )`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_invoices
      WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `UPDATE dialysis_billing_settings
        SET charge_enabled = false, unit_price = NULL, finance_reviewed_at = NULL, updated_at = NOW()
      WHERE tenant_id = $1::uuid`,
    TENANT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM dialysis_machine_qa_logs
      WHERE machine_no IN ($1, $2)`,
    MACHINE, MACHINE_2,
  ).catch(() => {});
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

  test('dialyzer reuse register enforces cycle consistency with session reuse_count', async () => {
    const good = await nurse.post(`/api/v1/dialysis/sessions/${sessionId}/reuse-register`).send({
      dialyzer_serial: `DIALYZER-${MACHINE}`,
      reuse_cycle_count: 4,
      integrity_test_result: 'pass',
      integrity_test_method: 'pressure-hold',
      disinfectant: 'peracetic acid',
    });
    expect(good.status).toBe(200);
    expect(good.body.data.register_format_status).toBe('format_pending');
    expect(good.body.data.reuse_cycle_count).toBe(4);

    const session = await prisma.$queryRawUnsafe(
      `SELECT reuse_count FROM dialysis_sessions WHERE id = $1::int`,
      sessionId,
    );
    expect(session[0].reuse_count).toBe(4);

    const mismatch = await nurse.post(`/api/v1/dialysis/sessions/${sessionId}/reuse-register`).send({
      dialyzer_serial: `DIALYZER-${MACHINE}`,
      reuse_cycle_count: 5,
      integrity_test_result: 'pass',
    });
    expect(mismatch.status).toBe(400);

    const list = await nurse.get(`/api/v1/dialysis/sessions/${sessionId}/reuse-register`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  test('completion surfaces warn-only machine QA and stays billing-inert by default', async () => {
    const qa = await nurse.post('/api/v1/dialysis/machine-qa').send({
      session_id: sessionId,
      machine_no: MACHINE,
      disinfection_completed: false,
      machine_ready: false,
      status: 'failed',
      issues: ['conductivity alarm during turnover'],
    });
    expect(qa.status).toBe(200);

    const beforeLines = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM billing_invoice_items
        WHERE source_ref_type = 'dialysis_session'
          AND source_ref_id = $1::int`,
      sessionId,
    );
    expect(beforeLines[0].n).toBe(0);

    const complete = await nurse.post(`/api/v1/dialysis/sessions/${sessionId}/complete`).send({
      post_weight_kg: 63.8,
      post_bp_systolic: 118,
      post_bp_diastolic: 74,
      actual_uf_l: 1.4,
      urea_pre_mg_dl: 100,
      urea_post_mg_dl: 32,
    });
    expect(complete.status).toBe(200);
    expect(complete.body.data.status).toBe('completed');
    expect(complete.body.data.machine_qa_warnings).toEqual(expect.arrayContaining([
      `Machine ${MACHINE} disinfection is not marked complete`,
      `Machine ${MACHINE} is not marked ready`,
      `Machine ${MACHINE} QA status is failed`,
    ]));
    expect(complete.body.data.billing_hook).toMatchObject({ status: 'disabled', emitted: false });

    const afterLines = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM billing_invoice_items
        WHERE source_ref_type = 'dialysis_session'
          AND source_ref_id = $1::int`,
      sessionId,
    );
    expect(afterLines[0].n).toBe(0);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'dialysis.completed'`,
      patientUid,
    );
    expect(timeline.length).toBe(1);
  });

  test('finance-reviewed dialysis tariff emits one draft billing line on completion', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO dialysis_billing_settings
         (tenant_id, charge_enabled, service_code, unit_price, gst_rate, finance_reviewed_at, acceptance_snapshot)
       VALUES ($1::uuid, true, 'DIALYSIS-HD-SESSION', 2500.00, 0, NOW(), '{"review":"test"}'::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET
         charge_enabled = true,
         service_code = EXCLUDED.service_code,
         unit_price = EXCLUDED.unit_price,
         gst_rate = EXCLUDED.gst_rate,
         finance_reviewed_at = NOW(),
         acceptance_snapshot = EXCLUDED.acceptance_snapshot,
         updated_at = NOW()`,
      TENANT,
    );

    const scheduled = await nurse.post('/api/v1/dialysis/sessions').send({
      dialysis_patient_id: dialysisPatientId,
      session_date: '2026-06-12',
      machine_no: MACHINE_2,
      reuse_count: 0,
    });
    expect(scheduled.status).toBe(200);
    const billableSessionId = scheduled.body.data.id;

    const start = await nurse.post(`/api/v1/dialysis/sessions/${billableSessionId}/start`).send({
      pre_weight_kg: 65.0,
    });
    expect(start.status).toBe(200);

    const qa = await nurse.post('/api/v1/dialysis/machine-qa').send({
      session_id: billableSessionId,
      machine_no: MACHINE_2,
      disinfection_completed: true,
      disinfection_method: 'heat disinfection',
      machine_ready: true,
      status: 'passed',
    });
    expect(qa.status).toBe(200);

    const complete = await nurse.post(`/api/v1/dialysis/sessions/${billableSessionId}/complete`).send({
      post_weight_kg: 63.5,
      actual_uf_l: 1.5,
      urea_pre_mg_dl: 100,
      urea_post_mg_dl: 30,
    });
    expect(complete.status).toBe(200);
    expect(complete.body.data.machine_qa_warnings).toEqual([]);
    expect(complete.body.data.billing_hook).toMatchObject({
      status: 'emitted',
      emitted: true,
      unit_price: 2500,
    });
    const lines = await prisma.$queryRawUnsafe(
      `SELECT bii.source_ref_type, bii.source_ref_id, bii.line_total, bi.status, bi.department
         FROM billing_invoice_items bii
         JOIN billing_invoices bi ON bi.id = bii.invoice_id
        WHERE bii.source_ref_type = 'dialysis_session'
          AND bii.source_ref_id = $1::int`,
      billableSessionId,
    );
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].line_total)).toBe(2500);
    expect(lines[0].status).toBe('DRAFT');
    expect(lines[0].department).toBe('Dialysis');
  });
});
