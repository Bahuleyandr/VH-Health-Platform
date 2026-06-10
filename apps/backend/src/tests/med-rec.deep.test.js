// Roadmap B6 — three-point medication reconciliation deep round-trip.
//
// Seeds a patient with home meds (users.chronic_medications) + an active
// prescription + a scheduled MAR row, then walks: start (items prefilled,
// dedupe across sources) → decide each (validation rules) → complete
// (blocked while undecided; discharge produces the take-home list) with
// canonical timeline/audit assertions and RBAC checks.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199909${String(Date.now() % 10000).padStart(5, '0')}`;
let patientId;
let patientUid;
let recId;
let items;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_reconciliations WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B6TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE medication_name LIKE 'B6TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE patient_id IN (SELECT id FROM users WHERE name = 'B6TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'B6TEST Patient'`).catch(() => {});
}

d('Medication reconciliation — deep round-trip (roadmap B6)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, chronic_medications, updated_at)
       VALUES ($1, 'B6TEST Patient', 'PATIENT', true,
               '["B6TEST Metformin 500mg", "B6TEST Telmisartan 40mg"]'::jsonb, NOW())
       RETURNING id, uid`,
      PHONE,
    );
    patientId = Number(p[0].id);
    patientUid = p[0].uid;

    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions (patient_id, status, medications, created_at, updated_at)
       VALUES ($1, 'active',
               '[{"name":"B6TEST Atorvastatin 20mg","dose":"20mg","frequency":"HS"}]'::jsonb, NOW(), NOW())`,
      patientId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status)
       VALUES ($1::uuid, 'B6TEST Metformin 500mg', '500mg', 'oral', NOW() + INTERVAL '2 hours', 'scheduled')`,
      patientUid,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('start admission rec: items prefilled from all sources, deduped; nurse blocked', async () => {
    const nurse = await authClient('NURSING_STAFF')
      .post('/api/v1/med-rec/start')
      .send({ patient_uid: patientUid, rec_type: 'admission' });
    expect(nurse.status).toBe(403);

    const res = await authClient('DOCTOR')
      .post('/api/v1/med-rec/start')
      .send({ patient_uid: patientUid, rec_type: 'admission' });
    expect(res.status).toBe(201);
    const rec = res.body.data.reconciliation;
    recId = rec.id;
    items = rec.items;
    expect(rec.rec_type).toBe('admission');
    expect(rec.status).toBe('in_progress');
    // Metformin appears in BOTH home meds and the MAR → deduped to one item
    // with home-source priority for an admission rec.
    const names = items.map((i) => i.medication_name.toLowerCase());
    expect(names.filter((n) => n.includes('metformin'))).toHaveLength(1);
    expect(items.find((i) => i.medication_name.toLowerCase().includes('metformin')).source).toBe('home');
    expect(names.some((n) => n.includes('telmisartan'))).toBe(true);
    expect(names.some((n) => n.includes('atorvastatin'))).toBe(true);
    expect(items.every((i) => i.decision === null)).toBe(true);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'medication_reconciliations' AND source_id = $1`,
      String(recId),
    );
    expect(timeline.map((t) => t.event_type)).toContain('medrec.started');
  });

  test('double-start is a 409 with the open rec id', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/med-rec/start')
      .send({ patient_uid: patientUid, rec_type: 'admission' });
    expect(res.status).toBe(409);
    expect(res.body.details.reconciliation_id).toBe(recId);
  });

  test('decision validation: stop/change need reasons; change needs instructions', async () => {
    const metformin = items.find((i) => i.medication_name.toLowerCase().includes('metformin'));
    const noReason = await authClient('DOCTOR')
      .patch(`/api/v1/med-rec/${recId}/items/${metformin.id}`)
      .send({ decision: 'stop' });
    expect(noReason.status).toBe(400);

    const noInstructions = await authClient('DOCTOR')
      .patch(`/api/v1/med-rec/${recId}/items/${metformin.id}`)
      .send({ decision: 'change', reason: 'B6TEST renal dose adjustment' });
    expect(noInstructions.status).toBe(400);

    const ok = await authClient('DOCTOR')
      .patch(`/api/v1/med-rec/${recId}/items/${metformin.id}`)
      .send({
        decision: 'change',
        reason: 'B6TEST renal dose adjustment',
        new_instructions: 'Metformin 500mg OD (was BD) — eGFR 42',
      });
    expect(ok.status).toBe(200);
    expect(ok.body.data.item.decision).toBe('change');
  });

  test('complete is blocked while items are undecided', async () => {
    const res = await authClient('DOCTOR').post(`/api/v1/med-rec/${recId}/complete`);
    expect(res.status).toBe(409);
    expect(res.body.details.undecided.length).toBeGreaterThanOrEqual(1);
  });

  test('decide the rest, complete, and the timeline shows medrec.completed', async () => {
    for (const item of items) {
      if (item.medication_name.toLowerCase().includes('metformin')) continue; // already decided
      const res = await authClient('DOCTOR')
        .patch(`/api/v1/med-rec/${recId}/items/${item.id}`)
        .send({ decision: 'continue' });
      expect(res.status).toBe(200);
    }
    const complete = await authClient('DOCTOR').post(`/api/v1/med-rec/${recId}/complete`);
    expect(complete.status).toBe(200);
    expect(complete.body.data.reconciliation.status).toBe('completed');
    expect(complete.body.data.reconciliation.decision_counts).toMatchObject({ change: 1 });

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'medication_reconciliations' AND source_id = $1`,
      String(recId),
    );
    expect(timeline.map((t) => t.event_type)).toEqual(
      expect.arrayContaining(['medrec.started', 'medrec.completed']),
    );

    const audits = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
        WHERE resource_table = 'medication_reconciliation_items'
          AND metadata->>'reconciliation_id' = $1`,
      String(recId),
    );
    expect(audits.length).toBeGreaterThanOrEqual(items.length);
  });

  test('discharge rec produces a take-home list from continue/change/new', async () => {
    const start = await authClient('DOCTOR')
      .post('/api/v1/med-rec/start')
      .send({ patient_uid: patientUid, rec_type: 'discharge' });
    expect(start.status).toBe(201);
    const rec = start.body.data.reconciliation;

    for (const [index, item] of rec.items.entries()) {
      const decision = index === 0
        ? { decision: 'stop', reason: 'B6TEST not needed post-op' }
        : { decision: 'continue' };
      const res = await authClient('PHARMACY_STAFF')
        .patch(`/api/v1/med-rec/${rec.id}/items/${item.id}`)
        .send(decision);
      expect(res.status).toBe(200);
    }
    const complete = await authClient('PHARMACY_STAFF').post(`/api/v1/med-rec/${rec.id}/complete`);
    expect(complete.status).toBe(200);
    const takeHome = complete.body.data.reconciliation.take_home_list;
    expect(Array.isArray(takeHome)).toBe(true);
    expect(takeHome).toHaveLength(rec.items.length - 1); // stopped drug excluded
    expect(complete.body.data.reconciliation.metadata.take_home_list).toBeDefined();
  });

  test('decisions are frozen after completion', async () => {
    const res = await authClient('DOCTOR')
      .patch(`/api/v1/med-rec/${recId}/items/${items[0].id}`)
      .send({ decision: 'continue' });
    expect(res.status).toBe(409);
  });

  test('patient list endpoint reports counts', async () => {
    const res = await authClient('NURSING_STAFF').get(`/api/v1/med-rec/patient/${patientUid}`);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBeGreaterThanOrEqual(2);
    const completed = res.body.data.reconciliations.filter((r) => r.status === 'completed');
    expect(completed.length).toBeGreaterThanOrEqual(2);
    expect(Number(completed[0].undecided_count)).toBe(0);
  });
});
