import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'c1111111-1111-4111-8111-111111111a01';
const DOCTOR_UID = 'c1111111-1111-4111-8111-111111111a02';
const ADMIN_UID = 'c1111111-1111-4111-8111-111111111a03';
const ENCOUNTER_ID = 'c1111111-1111-4111-8111-111111111a04';

function authed(role, uid) {
  const token = generateTestToken(role, { uid, id: role === 'PATIENT' ? 7001 : 7002 });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (path) => request(app).put(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    patch: (path) => request(app).patch(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function expectStatus(response, expected, label) {
  if (response.statusCode !== expected) {
    throw new Error(`${label} expected ${expected}, received ${response.statusCode}: ${JSON.stringify(response.body)}`);
  }
}

describe('future-proof clinical AI and privacy foundations', () => {
  let admissionId;
  const doctor = authed('DOCTOR', DOCTOR_UID);
  const admin = authed('ADMIN', ADMIN_UID);
  const patient = authed('PATIENT', PATIENT_UID);

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_generations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM downtime_snapshots WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_data_rights_requests WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM nurse_handovers WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM diagnoses WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE uid = $1::uuid OR patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`, PATIENT_UID, DOCTOR_UID, ADMIN_UID);

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, gender, is_active, updated_at)
       VALUES
         ($1::uuid, '9000091001', 'Clinical AI Patient', 'PATIENT', 'female', true, NOW()),
         ($2::uuid, '9000091002', 'Clinical AI Doctor', 'DOCTOR', 'male', true, NOW()),
         ($3::uuid, '9000091003', 'Clinical AI Admin', 'ADMIN', 'male', true, NOW())`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents
         (patient_uid, consent_type, granted, status, granted_at, granted_by)
       VALUES ($1::uuid, 'treatment', true, 'active', NOW(), 'patient')`,
      PATIENT_UID
    );

    const admissions = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, encounter_id, admitting_doctor, attending_doctor, status,
          admission_type, priority, chief_complaint, admitting_diagnosis,
          ward, bed_number, code_status, admitted_at, created_by, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, 'admitted',
               'emergency', 'urgent', 'Fever with breathlessness',
               'Community acquired pneumonia', 'WARD-A', 'A-12',
               'full_code', NOW() - INTERVAL '2 days', $3::uuid, NOW() - INTERVAL '2 days')
       RETURNING id`,
      PATIENT_UID, ENCOUNTER_ID, DOCTOR_UID
    );
    admissionId = admissions[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO diagnoses
         (patient_uid, encounter_id, icd10_code, description, diagnosis_type, status, diagnosed_by, created_at)
       VALUES ($1::uuid, $2::uuid, 'J18.9', 'Pneumonia, unspecified organism', 'primary', 'active', $3::uuid, NOW() - INTERVAL '1 day')`,
      PATIENT_UID, ENCOUNTER_ID, DOCTOR_UID
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_notes
         (encounter_id, patient_uid, author_uid, author_role, note_type, content, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'DOCTOR', 'progress',
               $4::jsonb, NOW() - INTERVAL '12 hours')`,
      ENCOUNTER_ID,
      PATIENT_UID,
      DOCTOR_UID,
      JSON.stringify({ summary: 'Improving fever and cough after IV antibiotics.', current_status: 'Stable', plan: 'Continue antibiotics and monitor oxygen.' })
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_orders
         (order_number, encounter_id, patient_uid, order_type, priority, details, status, ordered_by, created_at)
       VALUES ('ORD-AI-001', $1::uuid, $2::uuid, 'medication', 'routine',
               $3::jsonb, 'ordered', $4::uuid, NOW() - INTERVAL '6 hours')`,
      ENCOUNTER_ID,
      PATIENT_UID,
      JSON.stringify({ medication_name: 'Amoxicillin clavulanate', dose: '625 mg', route: 'oral', frequency: 'twice daily', duration: '5 days' }),
      DOCTOR_UID
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO investigations
         (uid, patient_uid, phone, test_name, status, priority, result_summary,
          requested_by, requested_at, created_at, updated_at)
       VALUES ($1::uuid, $1::uuid, '9000091001', 'Chest X-ray', 'PENDING', 'URGENT',
               'Report pending', $2::uuid, NOW() - INTERVAL '4 hours',
               NOW() - INTERVAL '4 hours', NOW())`,
      PATIENT_UID, DOCTOR_UID
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO vitals_chart
         (patient_uid, heart_rate, systolic_bp, diastolic_bp, temperature, spo2, respiratory_rate, recorded_by, recorded_at)
       VALUES ($1::uuid, 92, 118, 76, 37.4, 95, 20, $2::uuid, NOW() - INTERVAL '2 hours')`,
      PATIENT_UID, DOCTOR_UID
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_generations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM downtime_snapshots WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_data_rights_requests WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM nurse_handovers WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM diagnoses WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE uid = $1::uuid OR patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`, PATIENT_UID, DOCTOR_UID, ADMIN_UID).catch(() => {});
  });

  it('generates, saves, and signs an auditable local-AI discharge draft', async () => {
    const generated = await doctor.post(`/api/v1/emr/${admissionId}/discharge-summary/generate`).send({});
    expectStatus(generated, 200, 'generate discharge summary');
    const summary = generated.body.data.discharge_summary;
    expect(summary.is_draft).toBe(true);
    expect(summary.ai_metadata.provider).toBeTruthy();
    expect(summary.source_citations.length).toBeGreaterThan(0);
    expect(summary.safety_flags.some((flag) => flag.code === 'PENDING_INVESTIGATIONS')).toBe(true);
    expect(summary.draft_generation_id).toBeTruthy();

    const saved = await doctor.put(`/api/v1/emr/${admissionId}/discharge-summary`).send({
      discharge_summary: summary,
    });
    expectStatus(saved, 200, 'save discharge summary');
    expect(saved.body.data.noteId).toBeTruthy();

    const signed = await doctor.post(`/api/v1/emr/${admissionId}/discharge-summary/sign`).send({});
    expectStatus(signed, 200, 'sign discharge summary');
    expect(signed.body.data.signed).toBe(true);

    const generations = await admin.get('/api/v1/admin/clinical-ai/generations');
    expectStatus(generations, 200, 'list AI generations');
    expect(generations.body.data.generations.length).toBeGreaterThan(0);
  });

  it('exposes timeline, handover draft, FHIR everything, and downtime packet', async () => {
    const timeline = await doctor.get(`/api/v1/emr/timeline/${PATIENT_UID}`);
    expectStatus(timeline, 200, 'patient timeline');
    expect(timeline.body.data.some((event) => event.event_type === 'clinical_note')).toBe(true);

    const handover = await doctor.post('/api/v1/clinical/handover/generate').send({ patient_uid: PATIENT_UID });
    expectStatus(handover, 200, 'handover draft');
    expect(handover.body.data.patient_summary).toMatch(/Pneumonia|Recent notes|Problems/i);

    const fhir = await doctor.get(`/api/v1/fhir/Patient/${PATIENT_UID}/$everything`);
    expectStatus(fhir, 200, 'FHIR Patient $everything');
    expect(fhir.body.resourceType).toBe('Bundle');
    expect(fhir.body.entry.some((entry) => entry.resource.resourceType === 'Patient')).toBe(true);

    const downtime = await doctor.post(`/api/v1/emr/downtime-snapshot/${PATIENT_UID}`).send({ hours_to_live: 6 });
    expectStatus(downtime, 201, 'downtime snapshot');
    expect(downtime.body.data.payload.timeline.length).toBeGreaterThan(0);
  });

  it('supports consent center listing and patient data-rights intake', async () => {
    const list = await admin.get('/api/v1/consent');
    expectStatus(list, 200, 'consent list');
    expect(list.body.data.some((row) => row.patient_uid === PATIENT_UID && row.status === 'granted')).toBe(true);

    const requestRes = await patient.post('/api/v1/consent/data-rights/request').send({
      patient_uid: PATIENT_UID,
      request_type: 'export',
      notes: 'Need copy for second opinion',
    });
    expectStatus(requestRes, 201, 'data rights request');
    expect(requestRes.body.data.status).toBe('submitted');

    const rights = await admin.get(`/api/v1/consent/data-rights?patient_uid=${PATIENT_UID}`);
    expectStatus(rights, 200, 'data rights list');
    expect(rights.body.data.length).toBeGreaterThan(0);
  });
});
