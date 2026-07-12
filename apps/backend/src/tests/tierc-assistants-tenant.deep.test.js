// Two-tenant isolation for the Tier C assistant ENTRY queries (Sol Ultra
// 2026-07-11 #38). Every DB-reading Tier C wrapper used to select PHI by bare
// id / patient_uid; the sweep added `AND tenant_id = $N::uuid` to each entry
// query. These tests prove, against the real schema, that
//   * a caller in tenant A cannot resolve tenant B's admission /
//     prescription / assessment / investigation rows (and vice versa), and
//   * the same rows stay visible in-tenant (the predicate does not
//     over-filter).
//
// runExplainerPipeline (LLM + module registry + persistence) is module-mocked
// so the assertions observe exactly what the entry queries returned.
import { jest } from '@jest/globals';

const runExplainerPipeline = jest.fn(async (args) => ({
  __mock: true,
  module_key: args.moduleKey,
  patient_uid: args.patientUid,
  payload: args.userPromptPayload,
}));
jest.unstable_mockModule('../services/ai/patientExplainersService.js', () => ({
  runExplainerPipeline,
}));

const prisma = (await import('../lib/prisma.js')).default;
const {
  generateMedicalCertificateDraft,
  generateClinicLetterDraft,
  generateRenalDoseCheck,
  generateAdverseDrugEventDetection,
  generateFallRiskPrediction,
  generateAkiRiskAlert,
  generateIntakeOutputSummary,
  generateIcuRoundSummary,
} = await import('../services/ai/tierCAssistantsService.js');

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PATIENT = 'e3838383-8383-4383-8383-aaaaaaaa3801';
const STAMP = String(Date.now() % 100000).padStart(5, '0');

let admA;
let admB;
let rxA;
let rxB;
const createdInvestigations = [];
const createdFallRisks = [];

async function seedAdmission(tenantId, diagnosis) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions (tenant_id, patient_uid, ward, bed_number, status,
                             admitted_at, admitting_diagnosis, updated_at)
     VALUES ($1::uuid, $2::uuid, 'T38 Ward', $3, 'admitted', NOW(), $4, NOW())
     RETURNING id`,
    tenantId, PATIENT, `T38-${STAMP}`, diagnosis,
  );
  return rows[0].id;
}

async function seedPrescription(tenantId, medicationName) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO prescriptions (tenant_id, patient_uid, medication_name, dosage, status)
     VALUES ($1::uuid, $2::uuid, $3, '10mg', 'active')
     RETURNING id`,
    tenantId, PATIENT, medicationName,
  );
  return rows[0].id;
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'tierc-sweep-b', 'TierC Sweep B')
     ON CONFLICT (id) DO NOTHING`, TENANT_B);
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, '9000038${STAMP.slice(-3)}', 'TierC sweep patient', 'PATIENT', true, NOW())
     ON CONFLICT (uid) DO NOTHING`, PATIENT);

  admA = await seedAdmission(TENANT_A, `T38A dx ${STAMP}`);
  admB = await seedAdmission(TENANT_B, `T38B dx ${STAMP}`);
  rxA = await seedPrescription(TENANT_A, `TSWEEP-A-MED-${STAMP}`);
  rxB = await seedPrescription(TENANT_B, `TSWEEP-B-MED-${STAMP}`);

  // Fall-risk assessments exist ONLY in tenant A for this patient.
  const fr = await prisma.$queryRawUnsafe(
    `INSERT INTO fall_risk_assessments (tenant_id, patient_uid, scale, score, risk_level)
     VALUES ($1::uuid, $2::uuid, 'MORSE', 45, 'high')
     RETURNING id`,
    TENANT_A, PATIENT,
  );
  createdFallRisks.push(fr[0].id);

  for (const [tenantId, summary] of [[TENANT_A, '1.4'], [TENANT_B, '9.9']]) {
    const inv = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations (tenant_id, patient_uid, phone, test_name, status,
                                   result_summary, unit, completed_at, updated_at)
       VALUES ($1::uuid, $2::uuid, '9000038${STAMP.slice(-3)}', 'Creatinine', 'COMPLETED',
               $3, 'mg/dL', NOW(), NOW())
       RETURNING id`,
      tenantId, PATIENT, summary,
    );
    createdInvestigations.push(inv[0].id);
  }
});

afterAll(async () => {
  for (const id of createdInvestigations) {
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE id = $1::int`, id).catch(() => {});
  }
  for (const id of createdFallRisks) {
    await prisma.$executeRawUnsafe(`DELETE FROM fall_risk_assessments WHERE id = $1::int`, id).catch(() => {});
  }
  for (const id of [rxA, rxB].filter(Boolean)) {
    await prisma.$executeRawUnsafe(`DELETE FROM prescriptions WHERE id = $1::int`, id).catch(() => {});
  }
  for (const id of [admA, admB].filter(Boolean)) {
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE id = $1::int`, id).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
  await prisma.$disconnect().catch(() => {});
});

beforeEach(() => {
  runExplainerPipeline.mockClear();
});

describe('Tier C admissions-by-id entry queries (Sol Ultra #38)', () => {
  it('medical certificate: tenant A cannot load tenant B admission (and vice versa)', async () => {
    await expect(generateMedicalCertificateDraft({ tenantId: TENANT_A, admissionId: admB }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Admission not found' });
    await expect(generateMedicalCertificateDraft({ tenantId: TENANT_B, admissionId: admA }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Admission not found' });
    expect(runExplainerPipeline).not.toHaveBeenCalled();
  });

  it('medical certificate: in-tenant admission stays visible', async () => {
    const result = await generateMedicalCertificateDraft({ tenantId: TENANT_A, admissionId: admA });
    expect(result.__mock).toBe(true);
    expect(runExplainerPipeline).toHaveBeenCalledTimes(1);
    expect(runExplainerPipeline.mock.calls[0][0].patientUid).toBe(PATIENT);
    expect(runExplainerPipeline.mock.calls[0][0].userPromptPayload.admission.primary_diagnosis)
      .toBe(`T38A dx ${STAMP}`);
  });

  it('clinic letter: cross-tenant admission 404s, in-tenant resolves', async () => {
    await expect(generateClinicLetterDraft({ tenantId: TENANT_B, admissionId: admA }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Admission not found' });
    const result = await generateClinicLetterDraft({ tenantId: TENANT_B, admissionId: admB });
    expect(result.__mock).toBe(true);
    expect(runExplainerPipeline.mock.calls[0][0].userPromptPayload.admission.primary_diagnosis)
      .toBe(`T38B dx ${STAMP}`);
  });

  it('ICU round summary: cross-tenant admission 404s, in-tenant resolves', async () => {
    await expect(generateIcuRoundSummary({ tenantId: TENANT_B, admissionId: admA }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Admission not found' });
    const result = await generateIcuRoundSummary({ tenantId: TENANT_A, admissionId: admA });
    expect(result.__mock).toBe(true);
    expect(runExplainerPipeline.mock.calls[0][0].userPromptPayload.admission.ward).toBe('T38 Ward');
  });

  it('intake/output summary: entry query discriminates tenants before the I/O read', async () => {
    // Cross-tenant: the admission itself is invisible.
    await expect(generateIntakeOutputSummary({ tenantId: TENANT_A, admissionId: admB }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Admission not found' });
    // In-tenant: the admission resolves; the failure moves PAST the entry
    // gate to the (admission-keyed legacy) intake_output read.
    await expect(generateIntakeOutputSummary({ tenantId: TENANT_B, admissionId: admB }))
      .rejects.toMatchObject({
        statusCode: 404,
        message: 'No intake_output rows found for the specified day',
      });
  });
});

describe('Tier C prescriptions-by-id entry query (Sol Ultra #38)', () => {
  it('renal dose check: cross-tenant prescription 404s both directions', async () => {
    await expect(generateRenalDoseCheck({ tenantId: TENANT_A, prescriptionId: rxB }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Prescription not found' });
    await expect(generateRenalDoseCheck({ tenantId: TENANT_B, prescriptionId: rxA }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Prescription not found' });
    expect(runExplainerPipeline).not.toHaveBeenCalled();
  });

  it('renal dose check: in-tenant prescription stays visible', async () => {
    const result = await generateRenalDoseCheck({ tenantId: TENANT_A, prescriptionId: rxA });
    expect(result.__mock).toBe(true);
    expect(runExplainerPipeline.mock.calls[0][0].userPromptPayload.prescription.medication)
      .toBe(`TSWEEP-A-MED-${STAMP}`);
  });
});

describe('Tier C patient_uid list queries (Sol Ultra #38)', () => {
  it('ADE detector: each tenant sees only its own active medications', async () => {
    await generateAdverseDrugEventDetection({
      tenantId: TENANT_A, patientUid: PATIENT, signal: { symptom: 'rash' },
    });
    const medsA = runExplainerPipeline.mock.calls[0][0].userPromptPayload.active_medications
      .map((m) => m.medication_name);
    expect(medsA).toContain(`TSWEEP-A-MED-${STAMP}`);
    expect(medsA).not.toContain(`TSWEEP-B-MED-${STAMP}`);

    runExplainerPipeline.mockClear();
    await generateAdverseDrugEventDetection({
      tenantId: TENANT_B, patientUid: PATIENT, signal: { symptom: 'rash' },
    });
    const medsB = runExplainerPipeline.mock.calls[0][0].userPromptPayload.active_medications
      .map((m) => m.medication_name);
    expect(medsB).toContain(`TSWEEP-B-MED-${STAMP}`);
    expect(medsB).not.toContain(`TSWEEP-A-MED-${STAMP}`);
  });

  it('fall risk: tenant B sees no tenant A assessments; tenant A still does', async () => {
    await expect(generateFallRiskPrediction({ tenantId: TENANT_B, patientUid: PATIENT }))
      .rejects.toMatchObject({ statusCode: 404 });
    const result = await generateFallRiskPrediction({ tenantId: TENANT_A, patientUid: PATIENT });
    expect(result.__mock).toBe(true);
    const scores = runExplainerPipeline.mock.calls[0][0].userPromptPayload.recent_assessments
      .map((a) => a.score);
    expect(scores).toContain(45);
  });

  it('AKI alert: creatinine series and med list are tenant-scoped both directions', async () => {
    await generateAkiRiskAlert({ tenantId: TENANT_A, patientUid: PATIENT });
    const payloadA = runExplainerPipeline.mock.calls[0][0].userPromptPayload;
    expect(payloadA.recent_creatinine.map((c) => c.value)).toContain('1.4');
    expect(payloadA.recent_creatinine.map((c) => c.value)).not.toContain('9.9');
    expect(payloadA.active_medications.map((m) => m.name)).toContain(`TSWEEP-A-MED-${STAMP}`);
    expect(payloadA.active_medications.map((m) => m.name)).not.toContain(`TSWEEP-B-MED-${STAMP}`);

    runExplainerPipeline.mockClear();
    await generateAkiRiskAlert({ tenantId: TENANT_B, patientUid: PATIENT });
    const payloadB = runExplainerPipeline.mock.calls[0][0].userPromptPayload;
    expect(payloadB.recent_creatinine.map((c) => c.value)).toContain('9.9');
    expect(payloadB.recent_creatinine.map((c) => c.value)).not.toContain('1.4');
    expect(payloadB.active_medications.map((m) => m.name)).toContain(`TSWEEP-B-MED-${STAMP}`);
    expect(payloadB.active_medications.map((m) => m.name)).not.toContain(`TSWEEP-A-MED-${STAMP}`);
  });
});
