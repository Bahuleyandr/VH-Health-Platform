// Roadmap B2 — drug knowledge base deep round-trip.
//
// Exercises the starter dataset (migration 277) through the /api/v1/drug-kb
// surface and the full validatePrescriptionSafety integration: interactions,
// allergy cross-sensitivity, drug–disease against the B7 problem list, dose
// ceilings, and IV compatibility.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { __resetDrugKbCache } from '../services/clinical/drugKnowledgeBaseService.js';
import { validatePrescriptionSafety } from '../utils/clinical/prescriptionSafetyCheck.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199906${String(Date.now() % 10000).padStart(5, '0')}`;
let patientId;
let patientUid;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_problems WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B2TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_allergies WHERE allergy_name = 'B2TEST-Penicillin'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'B2TEST Patient'`).catch(() => {});
}

d('Drug knowledge base — deep round-trip (roadmap B2)', () => {
  beforeAll(async () => {
    await cleanup();
    __resetDrugKbCache();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, birthday, gender, updated_at)
       VALUES ($1, 'B2TEST Patient', 'PATIENT', true, '1980-03-03', 'male', NOW()) RETURNING id, uid`,
      PHONE,
    );
    patientId = Number(p[0].id);
    patientUid = p[0].uid;

    // Structured allergy (penicillin class) + active CKD problem (B7 feed).
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (patient_id, patient_uid, allergy_name, severity, is_active)
       VALUES ($1, $2::uuid, 'B2TEST-Penicillin', 'MILD', true)`,
      patientId, patientUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_problems (patient_uid, patient_id, title, icd10_code, status)
       VALUES ($1::uuid, $2, 'B2TEST Chronic kidney disease stage 5', 'N18.5', 'active')`,
      patientUid, patientId,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('status reports starter source and counts', async () => {
    const res = await authClient('DOCTOR').get('/api/v1/drug-kb/status');
    expect(res.status).toBe(200);
    expect(res.body.data.kb_available).toBe(true);
    const starter = res.body.data.sources.find((s) => s.source_key === 'vh_starter_set');
    expect(starter).toBeDefined();
    expect(starter.is_starter).toBe(true);
    expect(res.body.data.counts.interactions).toBeGreaterThanOrEqual(25);
    expect(res.body.data.counts.monographs).toBeGreaterThanOrEqual(60);
  });

  test('check: contraindicated interaction (PDE5 + nitrate)', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/drug-kb/check')
      .send({
        medications: [
          { name: 'Tab Sildenafil 50mg', dose: '50mg', frequency: 'OD' },
          { name: 'GTN (nitroglycerin) spray', dose: '0.4mg', frequency: 'SOS' },
        ],
      });
    expect(res.status).toBe(200);
    const interaction = res.body.data.findings.find((f) => f.check === 'interaction');
    expect(interaction).toBeDefined();
    expect(interaction.severity).toBe('contraindicated');
    expect(interaction.drug_keys.sort()).toEqual(['nitroglycerin', 'sildenafil']);
  });

  test('check: allergy cross-sensitivity — same class blocks, cross-class warns', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/drug-kb/check')
      .send({
        medications: [
          { name: 'Cap Amoxicillin 500mg' },
          { name: 'Inj Ceftriaxone 1g' },
        ],
        allergies: [{ allergen: 'penicillin' }],
      });
    expect(res.status).toBe(200);
    const findings = res.body.data.findings.filter((f) => f.check === 'allergy_cross_sensitivity');
    const sameClass = findings.find((f) => f.medications[0].includes('Amoxicillin'));
    const crossClass = findings.find((f) => f.medications[0].includes('Ceftriaxone'));
    expect(sameClass).toBeDefined();
    expect(sameClass.severity).toBe('high');
    expect(crossClass).toBeDefined();
    expect(crossClass.severity).toBe('moderate');
  });

  test('check: drug–disease caution from problem list codes', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/drug-kb/check')
      .send({
        medications: [{ name: 'Tab Ibuprofen 400mg', dose: '400mg', frequency: 'TDS' }],
        problems: [{ icd10_code: 'N18.5', title: 'CKD stage 5' }],
      });
    expect(res.status).toBe(200);
    const disease = res.body.data.findings.find((f) => f.check === 'condition_caution');
    expect(disease).toBeDefined();
    expect(disease.severity).toBe('contraindicated');
    expect(disease.problem_code).toBe('N18.5');
  });

  test('check: adult dose ceiling and IV incompatibility', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/drug-kb/check')
      .send({
        medications: [
          { name: 'Tab Paracetamol', dose: '1500 mg', frequency: 'QID' },
          { name: 'Inj Ceftriaxone 1g', route: 'iv' },
          { name: 'Ringer Lactate 500ml', route: 'iv' },
        ],
        patient: { age_years: 40 },
      });
    expect(res.status).toBe(200);
    const dose = res.body.data.findings.filter((f) => f.check === 'dose_range');
    expect(dose.length).toBeGreaterThanOrEqual(1); // 1500mg single > 1000 and 6g/day > 4g
    const iv = res.body.data.findings.find((f) => f.check === 'iv_compatibility');
    expect(iv).toBeDefined();
    expect(iv.severity).toBe('major');
  });

  test('check rejects empty medication list', async () => {
    const res = await authClient('DOCTOR').post('/api/v1/drug-kb/check').send({ medications: [] });
    expect(res.status).toBe(400);
  });

  test('validatePrescriptionSafety integrates KB findings with correct blocker/warning split', async () => {
    __resetDrugKbCache();
    const result = await validatePrescriptionSafety(patientId, [
      { name: 'Inj Ceftriaxone 1g', dose: '1g', frequency: 'OD' },
      { name: 'Tab Ibuprofen 400mg', dose: '400mg', frequency: 'TDS' },
      { name: 'Tab Sildenafil 50mg', dose: '50mg', frequency: 'OD' },
      { name: 'Sorbitrate (isosorbide) 10mg', dose: '10mg', frequency: 'BD' },
    ]);

    expect(result.safe).toBe(false);

    // Contraindicated PDE5+nitrate interaction → blocker.
    const interactionBlocker = result.blockers.find((b) => b.type === 'DRUG_INTERACTION_KB');
    expect(interactionBlocker).toBeDefined();
    expect(interactionBlocker.severity).toBe('CONTRAINDICATED');

    // Ibuprofen × active CKD problem (N18.5) → blocker.
    const diseaseBlocker = result.blockers.find((b) => b.type === 'DRUG_DISEASE_KB');
    expect(diseaseBlocker).toBeDefined();
    expect(diseaseBlocker.message).toMatch(/N18\.5/);

    // Penicillin allergy ↔ cephalosporin cross-class (moderate) → warning.
    const xreact = result.warnings.find((w) => w.type === 'ALLERGY_CROSS_SENSITIVITY_KB');
    expect(xreact).toBeDefined();
    expect(xreact.medication).toMatch(/Ceftriaxone/);

    // Legacy floor checks still present (renal NSAID warning fires too).
    const legacyRenal = result.warnings.find((w) => w.type === 'RENAL_EVIDENCE_MISSING' || w.type === 'RENAL_MEDICATION_REVIEW');
    expect(legacyRenal).toBeDefined();
  });

  test('patient role blocked at mount', async () => {
    const res = await authClient('PATIENT').get('/api/v1/drug-kb/status');
    expect(res.status).toBe(403);
  });
});
