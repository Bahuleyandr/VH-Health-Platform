// Roadmap C3 — FHIR R4 write interactions + problem-list Conditions +
// OperationOutcome error contract.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199915${String(Date.now() % 10000).padStart(4, '0')}`;
let patientUid;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_code_bindings WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'C3TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_problems WHERE title LIKE 'C3TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_allergies WHERE allergy_name LIKE 'C3TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM vitals_chart WHERE notes LIKE '%FHIR Observation create%'
       AND patient_uid IN (SELECT uid FROM users WHERE name = 'C3TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_consents WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'C3TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'C3TEST Patient'`).catch(() => {});
}

d('FHIR R4 server — write interactions (roadmap C3)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'C3TEST Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      PHONE,
    );
    patientUid = p[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('CapabilityStatement declares the create interactions', async () => {
    const res = await authClient('DOCTOR').get('/api/v1/fhir/metadata');
    expect(res.status).toBe(200);
    const resources = res.body.rest[0].resource;
    const byType = Object.fromEntries(resources.map((r) => [r.type, r]));
    for (const type of ['Observation', 'Condition', 'AllergyIntolerance']) {
      expect(byType[type].interaction.map((i) => i.code)).toContain('create');
    }
    expect(byType.Condition.searchParam.map((p) => p.name)).toContain('category');
  });

  test('POST /Observation maps a BP panel + writes one vitals row', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/fhir/Observation')
      .send({
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }], text: 'BP panel' },
        subject: { reference: `Patient/${patientUid}` },
        effectiveDateTime: new Date().toISOString(),
        component: [
          { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 138, unit: 'mmHg' } },
          { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 86, unit: 'mmHg' } },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.resourceType).toBe('Observation');
    expect(res.headers.location).toMatch(/^Observation\/vitals-\d+$/);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT systolic_bp, diastolic_bp FROM vitals_chart
        WHERE patient_uid = $1::uuid ORDER BY recorded_at DESC LIMIT 1`,
      patientUid,
    );
    expect(Number(rows[0].systolic_bp)).toBe(138);
    expect(Number(rows[0].diastolic_bp)).toBe(86);
  });

  test('POST /Observation with non-vital codes is a 400 OperationOutcome', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/fhir/Observation')
      .send({
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '718-7' }] },
        subject: { reference: `Patient/${patientUid}` },
        valueQuantity: { value: 11.2 },
      });
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].code).toBe('invalid');
  });

  test('POST /Condition lands on the longitudinal problem list and is searchable by category', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/fhir/Condition')
      .send({
        resourceType: 'Condition',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
        code: {
          coding: [
            { system: 'http://hl7.org/fhir/sid/icd-10', code: 'C3T.1', display: 'C3TEST Hypothyroidism' },
            {
              system: 'http://id.who.int/icd/release/11/mms',
              code: '5A00',
              display: 'C3TEST Iodine-deficiency-related hypothyroidism',
            },
          ],
          text: 'C3TEST Hypothyroidism',
        },
        subject: { reference: `Patient/${patientUid}` },
        onsetDateTime: '2024-01-15',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^p-/);
    expect(res.body.category[0].coding[0].code).toBe('problem-list-item');
    expect(res.body.code.coding).toEqual(expect.arrayContaining([
      expect.objectContaining({
        system: 'http://id.who.int/icd/release/11/mms',
        code: '5A00',
      }),
    ]));

    const problems = await prisma.$queryRawUnsafe(
      `SELECT id, title, icd10_code, status FROM patient_problems WHERE patient_uid = $1::uuid`,
      patientUid,
    );
    expect(problems.some((p) => p.icd10_code === 'C3T.1' && p.status === 'active')).toBe(true);
    const createdProblem = problems.find((p) => p.icd10_code === 'C3T.1');
    const bindings = await prisma.$queryRawUnsafe(
      `SELECT system_key, code, display FROM clinical_code_bindings
        WHERE resource_type = 'patient_problem' AND resource_id = $1`,
      String(createdProblem.id),
    );
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ system_key: 'ICD11', code: '5A00' }),
    ]));

    // Duplicate active coded problem → 409 OperationOutcome.
    const dup = await authClient('DOCTOR')
      .post('/api/v1/fhir/Condition')
      .send({
        resourceType: 'Condition',
        clinicalStatus: { coding: [{ code: 'active' }] },
        code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'C3T.1' }], text: 'C3TEST again' },
        subject: { reference: `Patient/${patientUid}` },
      });
    expect(dup.status).toBe(409);
    expect(dup.body.resourceType).toBe('OperationOutcome');

    const search = await authClient('DOCTOR')
      .get('/api/v1/fhir/Condition')
      .query({ patient: patientUid, category: 'problem-list-item' });
    expect(search.status).toBe(200);
    const found = search.body.entry.map((e) => e.resource).find((r) => r.code?.text === 'C3TEST Hypothyroidism');
    expect(found).toBeDefined();
    expect(found.category[0].coding[0].code).toBe('problem-list-item');
    expect(found.code.coding).toEqual(expect.arrayContaining([
      expect.objectContaining({ system: 'http://id.who.int/icd/release/11/mms', code: '5A00' }),
    ]));
  });

  test('POST /AllergyIntolerance writes the canonical allergy store', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/fhir/AllergyIntolerance')
      .send({
        resourceType: 'AllergyIntolerance',
        code: { text: 'C3TEST Penicillin' },
        patient: { reference: `Patient/${patientUid}` },
        criticality: 'high',
        reaction: [{ severity: 'severe', manifestation: [{ text: 'anaphylaxis' }] }],
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^pa-/);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT allergy_name, severity, is_active FROM patient_allergies WHERE allergy_name = 'C3TEST Penicillin'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe('SEVERE');
    expect(rows[0].is_active).toBe(true);
  });

  test('$everything carries the problem-list Condition', async () => {
    // Audit 2026-06-18 §3 finding #3: $everything is a disclosure-EXPORT and now
    // requires an active data_sharing consent (requireConsent gate in
    // fhirRoutes.js). Grant it so this export proceeds. The patient + the DOCTOR
    // token both resolve to DEFAULT_TENANT_ID.
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents
         (patient_uid, consent_type, granted, status, granted_at,
          data_categories, version, source, tenant_id, created_at, updated_at)
       VALUES ($1::uuid, 'data_sharing', true, 'active', NOW(),
          '[]'::jsonb, 'v1', 'test', '00000000-0000-4000-8000-000000000001'::uuid, NOW(), NOW())`,
      patientUid,
    );
    const res = await authClient('DOCTOR').get(`/api/v1/fhir/Patient/${patientUid}/$everything`);
    expect(res.status).toBe(200);
    const conditions = res.body.entry
      .map((e) => e.resource)
      .filter((r) => r.resourceType === 'Condition');
    expect(conditions.some((c) => c.id?.startsWith('p-') && c.code?.text === 'C3TEST Hypothyroidism')).toBe(true);
  });

  test('writes are role-gated with an OperationOutcome', async () => {
    const res = await authClient('NURSING_STAFF')
      .post('/api/v1/fhir/Condition')
      .send({
        resourceType: 'Condition',
        clinicalStatus: { coding: [{ code: 'active' }] },
        code: { text: 'C3TEST Nope' },
        subject: { reference: `Patient/${patientUid}` },
      });
    expect([403, 401]).toContain(res.status);
    if (res.status === 403 && res.body.resourceType) {
      expect(res.body.resourceType).toBe('OperationOutcome');
    }
  });
});
