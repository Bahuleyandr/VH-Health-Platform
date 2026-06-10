// Roadmap D6 — research/registry capture deep round-trip.
//
// Registry → versioned CRF (with vitals + demographics bindings) → publish
// → enroll (pseudonymous subject code + canonical timeline event) → capture
// with autofill provenance → submit → verify → de-identified export →
// withdraw. Conflict + gating paths included.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TEST_NAME = 'D6TEST Subject';
const REG_CODE = `D6T${String(Date.now()).slice(-6)}`;

let patientUid;
let registryId;
let formId;
let enrollmentId;
let responseId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM research_registries WHERE code LIKE 'D6T%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM vitals_chart WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  // clinical_audit_events is append-only — the C4 hash chain must never
  // have holes, so test cleanup deliberately leaves audit rows in place.
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, TEST_NAME).catch(() => {});
}

d('Research/registry capture — deep round-trip (roadmap D6)', () => {
  const doctor = authClient('DOCTOR');
  const admin = authClient('ADMIN');

  beforeAll(async () => {
    await cleanup();
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, gender, birthday, is_active, updated_at)
       VALUES ($1, $2, 'PATIENT', 'female', '1980-03-15', true, NOW()) RETURNING uid`,
      `+9198822${String(Date.now() % 10000).padStart(4, '0')}`,
      TEST_NAME,
    );
    patientUid = u[0].uid;
    await prisma.$queryRawUnsafe(
      `INSERT INTO vitals_chart (patient_uid, weight_kg, height_cm, recorded_at)
       VALUES ($1::uuid, 72.5, 164, NOW())`,
      patientUid,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('creates a registry (doctor) and rejects duplicate codes', async () => {
    const res = await doctor.post('/api/v1/research/registries').send({
      code: REG_CODE,
      title: 'D6 hypertension outcomes registry',
      kind: 'registry',
    });
    expect(res.status).toBe(201);
    registryId = res.body.data.registry.id;

    const dup = await doctor.post('/api/v1/research/registries').send({
      code: REG_CODE, title: 'duplicate',
    });
    expect(dup.status).toBe(409);
  });

  test('nurse cannot create registries; doctor can create + publish a CRF with bindings', async () => {
    const nurse = authClient('NURSE');
    const denied = await nurse.post('/api/v1/research/registries').send({
      code: `${REG_CODE}X`, title: 'nope',
    });
    expect(denied.status).toBe(403);

    const res = await doctor.post(`/api/v1/research/registries/${registryId}/forms`).send({
      name: 'Baseline assessment',
      fields: [
        { key: 'weight_kg', label: 'Weight (kg)', type: 'number', required: true, min: 1, max: 400, unit: 'kg', binding: { source: 'vitals_latest', column: 'weight_kg' } },
        { key: 'age_years', label: 'Age (years)', type: 'number', required: true, binding: { source: 'demographics', column: 'age_years' } },
        { key: 'gender', label: 'Gender', type: 'text', binding: { source: 'demographics', column: 'gender' } },
        { key: 'on_treatment', label: 'On antihypertensives', type: 'boolean', required: true },
        { key: 'nyha_class', label: 'NYHA class', type: 'select', options: ['I', 'II', 'III', 'IV'] },
      ],
    });
    expect(res.status).toBe(201);
    formId = res.body.data.form.id;
    expect(res.body.data.form.version).toBe(1);

    const pub = await doctor.post(`/api/v1/research/forms/${formId}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.form.status).toBe('published');
  });

  test('rejects invalid field schemas', async () => {
    const res = await doctor.post(`/api/v1/research/registries/${registryId}/forms`).send({
      name: 'Bad form',
      fields: [{ key: 'BadKey', label: 'x', type: 'text' }],
    });
    expect(res.status).toBe(400);

    const res2 = await doctor.post(`/api/v1/research/registries/${registryId}/forms`).send({
      name: 'Bad binding',
      fields: [{ key: 'sneaky', label: 'x', type: 'number', binding: { source: 'vitals_latest', column: 'pin_hash' } }],
    });
    expect(res2.status).toBe(400);
  });

  test('enrolls the patient with a generated subject code + timeline event', async () => {
    const res = await doctor.post(`/api/v1/research/registries/${registryId}/enrollments`).send({
      patient_uid: patientUid,
      consent_ref: 'CONSENT-D6-001',
    });
    expect(res.status).toBe(201);
    enrollmentId = res.body.data.enrollment.id;
    expect(res.body.data.enrollment.subject_code).toBe(`${REG_CODE}-${String(enrollmentId).padStart(4, '0')}`);

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'research.enrolled'`,
      patientUid,
    );
    expect(events.length).toBe(1);
    const audits = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
       WHERE patient_uid = $1::uuid AND action = 'research.enrolled'`,
      patientUid,
    );
    expect(audits.length).toBe(1);
  });

  test('blocks a second live enrollment for the same patient', async () => {
    const res = await doctor.post(`/api/v1/research/registries/${registryId}/enrollments`).send({
      patient_uid: patientUid,
    });
    expect(res.status).toBe(409);
  });

  test('captures a draft with autofill provenance from vitals + demographics', async () => {
    const res = await doctor.put(`/api/v1/research/forms/${formId}/responses`).send({
      enrollment_id: enrollmentId,
      visit_label: 'baseline',
      data: { on_treatment: true, nyha_class: 'II' },
    });
    expect(res.status).toBe(200);
    const { response } = res.body.data;
    responseId = response.id;

    expect(response.data.weight_kg).toBe(72.5);
    expect(response.data.gender).toBe('female');
    expect(response.data.age_years).toBeGreaterThan(40);
    expect(response.autofilled.weight_kg.source).toBe('vitals_latest');
    expect(response.autofilled.weight_kg.detail).toContain('vitals_chart.weight_kg');
    expect(response.autofilled.age_years.source).toBe('demographics');
    expect(response.missing_required).toEqual([]);
  });

  test('rejects out-of-range and bad-option values', async () => {
    const res = await doctor.put(`/api/v1/research/forms/${formId}/responses`).send({
      enrollment_id: enrollmentId,
      visit_label: 'month-1',
      data: { weight_kg: 4000, on_treatment: true, nyha_class: 'IX' },
      autofill: false,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('above maximum');
  });

  test('submits then verifies the response; draft edits are blocked after submit', async () => {
    const submit = await doctor.post(`/api/v1/research/responses/${responseId}/submit`).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.response.status).toBe('submitted');

    const editAfter = await doctor.put(`/api/v1/research/forms/${formId}/responses`).send({
      enrollment_id: enrollmentId,
      visit_label: 'baseline',
      data: { on_treatment: false },
    });
    expect(editAfter.status).toBe(400);

    const verify = await doctor.post(`/api/v1/research/responses/${responseId}/verify`).send({});
    expect(verify.status).toBe(200);
    expect(verify.body.data.response.status).toBe('verified');

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'research.crf_submitted'`,
      patientUid,
    );
    expect(events.length).toBe(1);
  });

  test('exports de-identified CSV by default; PHI export is role-gated', async () => {
    const res = await doctor.get(`/api/v1/research/registries/${registryId}/export?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const csv = res.text;
    expect(csv).toContain(`${REG_CODE}-${String(enrollmentId).padStart(4, '0')}`);
    expect(csv).toContain('weight_kg');
    expect(csv).toContain('72.5');
    expect(csv).not.toContain(patientUid);
    expect(csv).not.toContain(TEST_NAME);

    const deniedPhi = await doctor.get(`/api/v1/research/registries/${registryId}/export?include_phi=true`);
    expect(deniedPhi.status).toBe(403);

    const adminPhi = await admin.get(`/api/v1/research/registries/${registryId}/export?include_phi=true`);
    expect(adminPhi.status).toBe(200);
    expect(adminPhi.text).toContain(patientUid);
  });

  test('withdraws the enrollment with a reason (and only with a reason)', async () => {
    const noReason = await doctor.post(`/api/v1/research/enrollments/${enrollmentId}/withdraw`).send({});
    expect(noReason.status).toBe(400);

    const res = await doctor.post(`/api/v1/research/enrollments/${enrollmentId}/withdraw`).send({
      reason: 'Subject relocated',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.enrollment.status).toBe('withdrawn');

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'research.withdrawn'`,
      patientUid,
    );
    expect(events.length).toBe(1);
  });
});
