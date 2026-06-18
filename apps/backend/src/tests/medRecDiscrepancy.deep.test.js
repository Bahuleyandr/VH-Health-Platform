// Clinical-safety fix (platform audit 2026-06-18 §C-2 med-rec) — discrepancy
// engine deep tests.
//
// Proves the C-2 fix end to end against the QA Postgres:
//   1. A dropped home anticoagulant (warfarin) surfaces as an `omitted`
//      discrepancy and BLOCKS completion until a clinician addresses it.
//   2. Brand vs generic of the same ingredient (Eliquis ↔ apixaban) is NOT a
//      false discrepancy — it aligns by ingredient and reads `unchanged`.
//   3. A clean reconciliation (every home med carried forward, no high-alert
//      omission) still completes.
//   4. The existing medication safety screen runs over the merged/kept list
//      and its blockers are surfaced on completion.
//
// Self-isolating: all fixtures are tagged 'MRDTEST%' / a unique phone and torn
// down in beforeAll + afterAll. Calls the service layer directly so the test
// pins the discrepancy engine, not the HTTP/RBAC layer (covered by
// med-rec.deep.test.js).

import 'dotenv/config';
import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import {
  startReconciliation,
  decideItem,
  completeReconciliation,
  getReconciliation,
  classifyHighAlertIngredient,
  normalizeMedicationIngredient,
} from '../services/clinical/medicationReconciliationService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TAG = 'MRDTEST';
const DOCTOR_UID = 'd15c0d15-c0d1-4a5c-8d15-c0d15c0d1501';
const ctx = { tenantId: DEFAULT_TENANT_ID, actorUid: DOCTOR_UID, actorRole: 'DOCTOR' };

function uniquePhone(suffix) {
  return `+9199${String((Date.now() + suffix) % 100000000).padStart(8, '0')}`;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_reconciliations WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE '${TAG}%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE medication_name LIKE '${TAG}%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE patient_id IN (SELECT id FROM users WHERE name LIKE '${TAG}%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_allergies WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE '${TAG}%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name LIKE '${TAG}%'`).catch(() => {});
}

// Seed a patient with a given chronic_medications JSON array, an optional set of
// active e_prescriptions, and an optional set of scheduled MAR rows. Returns the
// patient uid.
async function seedPatient({ name, chronic = [], prescriptions = [], mar = [] }, suffix) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (phone, name, role, is_active, tenant_id, chronic_medications, updated_at)
     VALUES ($1, $2, 'PATIENT', true, $3::uuid, $4::jsonb, NOW())
     RETURNING id, uid`,
    uniquePhone(suffix),
    name,
    DEFAULT_TENANT_ID,
    JSON.stringify(chronic),
  );
  const patientId = Number(rows[0].id);
  const patientUid = rows[0].uid;
  for (const rx of prescriptions) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions (tenant_id, patient_id, status, medications, created_at, updated_at)
       VALUES ($1::uuid, $2, 'active', $3::jsonb, NOW(), NOW())`,
      DEFAULT_TENANT_ID,
      patientId,
      JSON.stringify(rx),
    );
  }
  for (const m of mar) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route, scheduled_time, status)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, NOW() + INTERVAL '2 hours', 'scheduled')`,
      DEFAULT_TENANT_ID,
      patientUid,
      m.medication_name,
      m.dose || null,
      m.route || 'oral',
    );
  }
  return { patientId, patientUid };
}

d('Med-rec discrepancy engine (audit §C-2)', () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  describe('pure ingredient helpers', () => {
    test('normalizeMedicationIngredient maps brand→generic and strips strength/form', () => {
      // Brand and generic of the same drug collapse to one ingredient key.
      expect(normalizeMedicationIngredient(`${TAG} Eliquis 5mg tablet`))
        .toBe(normalizeMedicationIngredient(`${TAG} Apixaban 5mg`));
      // Strength + form are not part of the ingredient identity.
      expect(normalizeMedicationIngredient('Metformin 500mg BD tablet'))
        .toBe(normalizeMedicationIngredient('metformin 1g'));
    });

    test('classifyHighAlertIngredient catches anticoagulant/insulin/AED/opioid/chemo, brand or generic', () => {
      expect(classifyHighAlertIngredient('Warfarin 5mg')).toBe('anticoagulant');
      expect(classifyHighAlertIngredient('Eliquis 5mg')).toBe('anticoagulant'); // brand
      expect(classifyHighAlertIngredient('Insulin Glargine 20u')).toBe('insulin');
      expect(classifyHighAlertIngredient('Lantus')).toBe('insulin'); // brand
      expect(classifyHighAlertIngredient('Levetiracetam 500mg')).toBe('antiepileptic');
      expect(classifyHighAlertIngredient('Morphine 10mg')).toBe('opioid');
      expect(classifyHighAlertIngredient('Cisplatin')).toBe('chemotherapy');
      // Not high-alert.
      expect(classifyHighAlertIngredient('Paracetamol 500mg')).toBeNull();
    });
  });

  test('1+2: dropped home anticoagulant → omitted blocker; brand/generic statin is NOT a false discrepancy', async () => {
    // Home list: warfarin (high-alert anticoagulant) + atorvastatin.
    // Inpatient/active side: only Lipitor (brand of atorvastatin). Warfarin is
    // dropped entirely. The engine must:
    //   - align atorvastatin (home) with Lipitor (active) by INGREDIENT → unchanged
    //   - flag warfarin as omitted (high-alert) → block completion.
    const { patientUid } = await seedPatient({
      name: `${TAG} Anticoag Patient`,
      chronic: [`${TAG} Warfarin 5mg`, `${TAG} Atorvastatin 20mg`],
      prescriptions: [[{ name: `${TAG} Lipitor 20mg`, dose: '20mg', frequency: 'HS' }]],
    }, 1);

    const rec = await startReconciliation(
      { patientUid, recType: 'admission' }, ctx,
    );

    // Warfarin appears as its own home item. Atorvastatin (home) + Lipitor
    // (active) stay as two ROWS (the merge dedupes by raw name), but the
    // ingredient-aligned engine must NOT read either as a real discrepancy —
    // they are the same ingredient on both sides.
    const names = rec.items.map((i) => i.medication_name.toLowerCase());
    expect(names.some((n) => n.includes('warfarin'))).toBe(true);

    // Decide every item with a benign decision so the LEGACY gate (every item
    // decided) is satisfied — this isolates the new omission gate.
    for (const item of rec.items) {
      await decideItem(rec.id, item.id, { decision: 'continue' }, ctx);
    }

    // Re-read to inspect engine-assigned discrepancy_type.
    const afterDecide = await getReconciliation(rec.id, { tenantId: DEFAULT_TENANT_ID });
    const warfarinItem = afterDecide.items.find((i) => /warfarin/i.test(i.medication_name));
    expect(warfarinItem.discrepancy_type).toBe('omitted');
    // Brand/generic of the SAME ingredient on both sides → no false
    // omitted/added/dose_changed. (One row is unchanged, the other duplicate;
    // neither is a real medication discrepancy.)
    const statinItems = afterDecide.items.filter((i) => /atorvastatin|lipitor/i.test(i.medication_name));
    expect(statinItems.length).toBeGreaterThanOrEqual(1);
    for (const s of statinItems) {
      expect(['unchanged', 'duplicate']).toContain(s.discrepancy_type);
      expect(['omitted', 'added', 'dose_changed']).not.toContain(s.discrepancy_type);
    }

    // Completion is BLOCKED: a high-alert omission has no explicit decision
    // ADDRESSING the omission (continue ≠ resolving an omission).
    let blocked = null;
    try {
      await completeReconciliation(rec.id, ctx);
    } catch (err) {
      blocked = err;
    }
    expect(blocked).toBeTruthy();
    expect(blocked.statusCode).toBe(409);
    expect(blocked.code).toBe('MEDREC_UNRESOLVED_DISCREPANCIES');
    const flagged = blocked.details.discrepancies.map((x) => x.medication_name.toLowerCase());
    expect(flagged.some((n) => n.includes('warfarin'))).toBe(true);

    // Clinician addresses the omission explicitly (stop with a reason — a
    // deliberate, documented decision to NOT carry warfarin forward).
    await decideItem(rec.id, warfarinItem.id, {
      decision: 'stop',
      reason: `${TAG} held peri-procedure per anticoagulation plan, bridging documented`,
    }, ctx);

    // Now completion succeeds.
    const done = await completeReconciliation(rec.id, ctx);
    expect(done.status).toBe('completed');
    expect(done.discrepancy_counts).toMatchObject({ omitted: 1, unchanged: expect.any(Number) });
  });

  test('3: a clean reconciliation (all home meds carried forward) still completes', async () => {
    const { patientUid } = await seedPatient({
      name: `${TAG} Clean Patient`,
      chronic: [`${TAG} Metformin 500mg`, `${TAG} Telmisartan 40mg`],
      prescriptions: [[
        { name: `${TAG} Metformin 500mg`, dose: '500mg', frequency: 'BD' },
        { name: `${TAG} Telmisartan 40mg`, dose: '40mg', frequency: 'OD' },
      ]],
    }, 2);

    const rec = await startReconciliation({ patientUid, recType: 'admission' }, ctx);
    for (const item of rec.items) {
      await decideItem(rec.id, item.id, { decision: 'continue' }, ctx);
    }
    const done = await completeReconciliation(rec.id, ctx);
    expect(done.status).toBe('completed');
    // No omissions of anything, let alone high-alert ones.
    expect(done.discrepancy_counts.omitted || 0).toBe(0);
  });

  test('4: medication safety screen runs over the kept list and surfaces blockers', async () => {
    // Patient with a SEVERE penicillin allergy. Home + active both contain
    // amoxicillin (kept, beta-lactam) → validatePrescriptionSafety must flag an
    // ALLERGY_CONFLICT blocker and completion must surface it.
    const { patientId, patientUid } = await seedPatient({
      name: `${TAG} Allergy Patient`,
      chronic: [`${TAG} Amoxicillin 500mg`],
      prescriptions: [[{ name: `${TAG} Amoxicillin 500mg`, dose: '500mg', frequency: 'TDS' }]],
    }, 3);
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (tenant_id, patient_id, patient_uid, allergy_name, severity, is_active, created_at)
       VALUES ($1::uuid, $2::int, $3::uuid, 'Penicillin', 'SEVERE', true, NOW())`,
      DEFAULT_TENANT_ID,
      patientId,
      patientUid,
    );

    const rec = await startReconciliation({ patientUid, recType: 'admission' }, ctx);
    for (const item of rec.items) {
      await decideItem(rec.id, item.id, { decision: 'continue' }, ctx);
    }

    let blocked = null;
    try {
      await completeReconciliation(rec.id, ctx);
    } catch (err) {
      blocked = err;
    }
    expect(blocked).toBeTruthy();
    expect(blocked.code).toBe('MEDREC_SAFETY_BLOCKERS');
    // The safety screen ran over the kept list and surfaced an allergy blocker
    // for the penicillin-class drug. The exact finding code depends on which
    // layer (structured allergy check vs drug-KB cross-sensitivity) fires
    // first; assert the clinically-meaningful contract: an allergy blocker
    // naming the amoxicillin line is present.
    const blockers = blocked.details.blockers;
    const allergyBlockers = blockers.filter((b) => /ALLERGY/i.test(b.type));
    expect(allergyBlockers.length).toBeGreaterThanOrEqual(1);
    expect(
      allergyBlockers.some((b) => /amoxicillin/i.test(`${b.medication || ''} ${b.message || ''}`)),
    ).toBe(true);
  });
});
