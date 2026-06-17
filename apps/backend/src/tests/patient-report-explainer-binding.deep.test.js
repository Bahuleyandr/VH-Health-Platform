// generatePatientReportExplanation — caller-asserted patient binding (#7a).
//
// Finding (#7a): the free-text report explainer route persisted a
// caller-supplied patient_uid / admission_id with FORMAT validation only — no
// existence/tenant check. An authenticated staff actor could therefore label a
// clinical-AI generation + review row with an arbitrary, cross-tenant, or
// non-existent patient (which, if the review were accepted, would surface on
// THAT patient's published-AI app feed via getPublishedAiOutputForPatient).
//
// Fix: generatePatientReportExplanation now resolves the asserted binding
// against the tenant before persisting and rejects when it doesn't resolve.
// These cases reject BEFORE the pipeline (no module load, no LLM, no persist),
// so the test needs no seed and no cleanup.
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). Self-skips when unconfigured.

import { generatePatientReportExplanation } from '../services/ai/patientExplainersService.js';

const prisma = (await import('../lib/prisma.js')).default;

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = 'c7a70000-0000-4000-8000-00000000c7a1';
// Well-formed but never-seeded identifiers.
const BOGUS_PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const BOGUS_ADMISSION_ID = 987654321;

const REQ = { tenantId: TENANT, user: { uid: ACTOR_UID, role: 'DOCTOR' } };
const BASE = {
  tenantId: TENANT,
  reportType: 'consultation',
  reportText: 'Patient seen for a 2-week cough; chest clear; supportive care advised and review in 5 days.',
  generatedBy: ACTOR_UID,
};

d('generatePatientReportExplanation — asserted patient binding (#7a)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('REJECTS a patient_uid that does not exist in the tenant', async () => {
    await expect(generatePatientReportExplanation({
      ...BASE,
      patientUid: BOGUS_PATIENT_UID,
      req: REQ,
    })).rejects.toMatchObject({ code: 'EXPLAINER_PATIENT_NOT_FOUND' });
  });

  test('REJECTS an admission_id that does not exist in the tenant', async () => {
    await expect(generatePatientReportExplanation({
      ...BASE,
      admissionId: BOGUS_ADMISSION_ID,
      req: REQ,
    })).rejects.toMatchObject({ code: 'EXPLAINER_ADMISSION_NOT_FOUND' });
  });
});
