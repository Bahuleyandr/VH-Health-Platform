// Roadmap B6 — three-point medication reconciliation deep round-trip.
//
// Seeds a patient with home meds (users.chronic_medications) + an active
// prescription + a scheduled MAR row, then walks: start (items prefilled,
// dedupe across sources) → decide each (validation rules) → complete
// (blocked while undecided; discharge produces the take-home list) with
// canonical timeline/audit assertions and RBAC checks.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199909${String(Date.now() % 10000).padStart(5, '0')}`;
const DOCTOR_UID = 'b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b601';
let patientId;
let patientUid;
let doctorId;
let doctor;
let recId;
let items;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B6TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_reconciliations WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B6TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE medication_name LIKE 'B6TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE patient_id IN (SELECT id FROM users WHERE name = 'B6TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'B6TEST Patient'`).catch(() => {});
}

d('Medication reconciliation — deep round-trip (roadmap B6)', () => {
  beforeAll(async () => {
    await cleanup();
    const doc = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'B6TEST Doctor', 'DOCTOR', true, $3::uuid, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET phone = EXCLUDED.phone,
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             is_active = EXCLUDED.is_active,
             tenant_id = EXCLUDED.tenant_id,
             updated_at = NOW()
       RETURNING id, uid`,
      DOCTOR_UID,
      `+9199908${String(Date.now() % 10000).padStart(5, '0')}`,
      DEFAULT_TENANT_ID,
    );
    doctorId = Number(doc[0].id);
    doctor = authClient('DOCTOR', { uid: DOCTOR_UID, id: doctorId, phone: '9990800001' });

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, tenant_id, chronic_medications, updated_at)
       VALUES ($1, 'B6TEST Patient', 'PATIENT', true, $2::uuid,
               '["B6TEST Metformin 500mg", "B6TEST Telmisartan 40mg"]'::jsonb, NOW())
       RETURNING id, uid`,
      PHONE,
      DEFAULT_TENANT_ID,
    );
    patientId = Number(p[0].id);
    patientUid = p[0].uid;

    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions (tenant_id, patient_id, status, medications, created_at, updated_at)
       VALUES ($1::uuid, $2, 'active',
               '[{"name":"B6TEST Atorvastatin 20mg","dose":"20mg","frequency":"HS"}]'::jsonb, NOW(), NOW())`,
      DEFAULT_TENANT_ID,
      patientId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route, scheduled_time, status)
       VALUES
         ($1::uuid, $2::uuid, 'B6TEST Metformin 500mg', '500mg', 'oral',
          NOW() + INTERVAL '2 hours', 'scheduled'),
         -- M7: a currently-running med (already administered, no future scheduled
         -- dose). Must appear in the reconciliation snapshot, not read as omitted.
         ($1::uuid, $2::uuid, 'B6TEST Aspirin 75mg', '75mg', 'oral',
          NOW() - INTERVAL '4 hours', 'administered')`,
      DEFAULT_TENANT_ID,
      patientUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, admitting_doctor, attending_doctor,
          admitted_at, ward, bed_number, created_by, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'admitted', $3::uuid, $3::uuid,
          NOW(), 'B6TEST Ward', 'B6T-01', $3::uuid, NOW(), NOW())`,
      DEFAULT_TENANT_ID,
      patientUid,
      DOCTOR_UID,
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

    const res = await doctor
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
    // M7: the running (administered) Aspirin must be surfaced for reconciliation,
    // not silently dropped as an omission (the snapshot previously excluded
    // 'administered' MAR rows).
    expect(names.some((n) => n.includes('aspirin'))).toBe(true);
    expect(items.every((i) => i.decision === null)).toBe(true);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'medication_reconciliations' AND source_id = $1`,
      String(recId),
    );
    expect(timeline.map((t) => t.event_type)).toContain('medrec.started');
  });

  test('double-start is a 409 with the open rec id', async () => {
    const res = await doctor
      .post('/api/v1/med-rec/start')
      .send({ patient_uid: patientUid, rec_type: 'admission' });
    expect(res.status).toBe(409);
    expect(res.body.details.reconciliation_id).toBe(recId);
  });

  test('decision validation: stop/change need reasons; change needs instructions', async () => {
    const metformin = items.find((i) => i.medication_name.toLowerCase().includes('metformin'));
    const noReason = await doctor
      .patch(`/api/v1/med-rec/${recId}/items/${metformin.id}`)
      .send({ decision: 'stop' });
    expect(noReason.status).toBe(400);

    const noInstructions = await doctor
      .patch(`/api/v1/med-rec/${recId}/items/${metformin.id}`)
      .send({ decision: 'change', reason: 'B6TEST renal dose adjustment' });
    expect(noInstructions.status).toBe(400);

    const ok = await doctor
      .patch(`/api/v1/med-rec/${recId}/items/${metformin.id}`)
      .send({
        decision: 'change',
        reason: 'B6TEST renal dose adjustment',
        new_instructions: 'Metformin 500mg OD (was BD) — eGFR 42',
        changed_frequency: 'OD',
        safety_rationale: 'B6TEST eGFR 42 — reduce frequency to avoid lactic acidosis risk',
      });
    expect(ok.status).toBe(200);
    expect(ok.body.data.item.decision).toBe('change');
    // B4.3: structured change detail persisted alongside free-text instructions.
    expect(ok.body.data.item.changed_frequency).toBe('OD');
    expect(ok.body.data.item.change_detail).toMatchObject({ frequency: { to: 'OD' } });
    // B4.3 / brief: a stop/change with a safety rationale wires a
    // medication_safety_reviews row and links it back onto the item.
    expect(ok.body.data.item.safety_review_id).toBeTruthy();
  });

  test('safety review row is written atomically and linked to the item (B4.3)', async () => {
    const metformin = items.find((i) => i.medication_name.toLowerCase().includes('metformin'));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT mri.safety_review_id, mri.changed_frequency,
              msr.id AS review_id, msr.review_type, msr.severity, msr.message,
              msr.medication_name, msr.patient_uid
         FROM medication_reconciliation_items mri
         JOIN medication_safety_reviews msr ON msr.id = mri.safety_review_id
        WHERE mri.id = $1::int`,
      metformin.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].review_id).toBe(rows[0].safety_review_id);
    expect(rows[0].review_type).toBe('med_rec_change');
    expect(rows[0].patient_uid).toBe(patientUid);
    expect(String(rows[0].message)).toContain('B6TEST eGFR 42');

    // Atomicity: the per-item decision also wrote a clinical_audit_event in the
    // same transaction, flagged as carrying a safety review.
    const audit = await prisma.$queryRawUnsafe(
      `SELECT metadata FROM clinical_audit_events
        WHERE resource_table = 'medication_reconciliation_items'
          AND resource_id = $1
          AND action = 'medrec.item_decided'
        ORDER BY occurred_at DESC LIMIT 1`,
      String(metformin.id),
    );
    expect(audit.length).toBe(1);
    expect(audit[0].metadata?.safety_review_recorded).toBe(true);
  });

  test('structured change detail without instructions is accepted; mismatched fields rejected', async () => {
    // Start a fresh transfer rec to exercise validation paths cleanly.
    const start = await doctor
      .post('/api/v1/med-rec/start')
      .send({ patient_uid: patientUid, rec_type: 'transfer', transfer_context: 'B6TEST ICU→ward' });
    expect(start.status).toBe(201);
    const rec = start.body.data.reconciliation;
    const first = rec.items[0];

    // change with ONLY structured detail (no new_instructions) → allowed.
    const structuredOnly = await doctor
      .patch(`/api/v1/med-rec/${rec.id}/items/${first.id}`)
      .send({ decision: 'change', reason: 'B6TEST route switch', changed_route: 'IV' });
    expect(structuredOnly.status).toBe(200);
    expect(structuredOnly.body.data.item.changed_route).toBe('IV');
    expect(structuredOnly.body.data.item.safety_review_id).toBeFalsy(); // no safety rationale → no review

    // structured change fields on a non-change decision → 400.
    const second = rec.items[1] || rec.items[0];
    const wrongDecision = await doctor
      .patch(`/api/v1/med-rec/${rec.id}/items/${second.id}`)
      .send({ decision: 'continue', changed_dose: '10mg' });
    expect(wrongDecision.status).toBe(400);

    // change with neither structured detail nor instructions → 400.
    const noDetail = await doctor
      .patch(`/api/v1/med-rec/${rec.id}/items/${second.id}`)
      .send({ decision: 'change', reason: 'B6TEST missing detail' });
    expect(noDetail.status).toBe(400);

    // Clean up this rec so it does not perturb later list-count assertions.
    await prisma.$executeRawUnsafe(
      `DELETE FROM medication_reconciliations WHERE id = $1::uuid`, rec.id,
    ).catch(() => {});
  });

  test('complete is blocked while items are undecided', async () => {
    const res = await doctor.post(`/api/v1/med-rec/${recId}/complete`);
    expect(res.status).toBe(409);
    expect(res.body.details.undecided.length).toBeGreaterThanOrEqual(1);
  });

  test('decide the rest, complete, and the timeline shows medrec.completed', async () => {
    for (const item of items) {
      if (item.medication_name.toLowerCase().includes('metformin')) continue; // already decided
      const res = await doctor
        .patch(`/api/v1/med-rec/${recId}/items/${item.id}`)
        .send({ decision: 'continue' });
      expect(res.status).toBe(200);
    }
    const complete = await doctor.post(`/api/v1/med-rec/${recId}/complete`);
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
    const start = await doctor
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
    const res = await doctor
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
