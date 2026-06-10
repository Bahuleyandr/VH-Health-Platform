// Deep integration tests for diagnosis + ICD-10 service.
// Exercises addDiagnosis, status update, problem list, encounter diagnoses, history, and ICD-10 search.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PATIENT_UID = 'a3333333-3333-4333-8333-333333333a01';
const DOCTOR_UID = 'a3333333-3333-4333-8333-333333333a02';
const PATIENT_PHONE = '9000030001';
const TEST_ICD_CODE = 'TESTDX1';
const ER_ENCOUNTER_UID = 'a3333333-3333-4333-8333-333333333e01';
const API_KEY = process.env.API_KEY || 'test-api-key';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function doctorAs(uid = DOCTOR_UID) {
  const token = generateTestToken('DOCTOR', { uid, id: 990301 });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function clearCareTeam() {
  await prisma.$executeRawUnsafe(`DELETE FROM care_team_members WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM care_teams WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
}

describe('EMR diagnosis + ICD-10 — deep integration', () => {
  const doctor = doctorAs();

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_code_bindings WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE source_table = 'diagnoses' AND patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM diagnoses WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM icd10_codes WHERE code = $1`, TEST_ICD_CODE);
    await clearCareTeam();
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID);

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Diagnosis Test Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000030002', 'Diagnosis Test Doctor', 'DOCTOR', true, NOW())`,
      DOCTOR_UID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO icd10_codes (code, description, category)
       VALUES ($1, 'Unit Test Diagnosis', 'Test Category')`,
      TEST_ICD_CODE);

    const careTeam = await prisma.$queryRawUnsafe(
      `INSERT INTO care_teams
         (tenant_id, patient_uid, team_kind, display_name, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'longitudinal', 'Diagnosis test care team', 'active', $3::uuid, NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO care_team_members
         (tenant_id, care_team_id, patient_uid, staff_uid, staff_role, member_name,
          relationship_kind, break_glass_allowed, created_by, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 'DOCTOR', 'Diagnosis Test Doctor',
               'attending_doctor', true, $4::uuid, NOW())`,
      TENANT_ID,
      careTeam[0].id,
      PATIENT_UID,
      DOCTOR_UID,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_code_bindings WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE source_table = 'diagnoses' AND patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM diagnoses WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM emergency_visits WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM icd10_codes WHERE code = $1`, TEST_ICD_CODE).catch(() => {});
    await clearCareTeam();
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('validation', () => {
    it('rejects diagnosis without required fields', async () => {
      const res = await doctor.post('/api/v1/emr/diagnosis').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid diagnosis_type', async () => {
      const res = await doctor.post('/api/v1/emr/diagnosis').send({
        patient_uid: PATIENT_UID,
        description: 'test',
        diagnosis_type: 'bogus',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid severity', async () => {
      const res = await doctor.post('/api/v1/emr/diagnosis').send({
        patient_uid: PATIENT_UID,
        description: 'test',
        severity: 'catastrophic',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects status update without status field', async () => {
      const res = await doctor.put('/api/v1/emr/diagnosis/1/status').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects ICD-10 search with short query', async () => {
      const res = await doctor.get('/api/v1/emr/icd10/search?q=a');
      expect(res.statusCode).toBe(400);
    });
  });

  describe('addDiagnosis', () => {
    let primaryDxId;

    it('creates a diagnosis with ICD-10 lookup populating description', async () => {
      const res = await doctor.post('/api/v1/emr/diagnosis').send({
        patient_uid: PATIENT_UID,
        icd10_code: TEST_ICD_CODE.toLowerCase(), // lowercase — service should upper-case
        description: 'Initial diagnosis',
        diagnosis_type: 'primary',
        status: 'active',
        severity: 'moderate',
        onset_date: '2026-04-01',
        codings: [{
          system: 'ICD11',
          code: 'BA00',
          display: 'Essential hypertension',
          release_id: '2026-01',
          linearization_uri: 'http://id.who.int/icd/release/11/2026-01/mms/123',
          foundation_uri: 'http://id.who.int/icd/entity/123',
        }],
      });
      expect(res.statusCode).toBe(201);
      const dx = res.body.data;
      expect(dx.id).toBeDefined();
      expect(dx.icd10_code).toBe(TEST_ICD_CODE); // upper-cased
      expect(dx.icd10_description).toBe('Unit Test Diagnosis'); // looked up
      expect(dx.diagnosis_type).toBe('primary');
      expect(dx.status).toBe('active');
      expect(dx.codings).toEqual(expect.arrayContaining([
        expect.objectContaining({ system_key: 'ICD10', code: TEST_ICD_CODE }),
        expect.objectContaining({ system_key: 'ICD11', code: 'BA00', display: 'Essential hypertension' }),
      ]));
      primaryDxId = dx.id;

      // Verify row in DB
      const row = await prisma.$queryRawUnsafe(
        `SELECT icd10_code, diagnosis_type, severity FROM diagnoses WHERE id = $1`, primaryDxId);
      expect(row[0].icd10_code).toBe(TEST_ICD_CODE);
      expect(row[0].severity).toBe('moderate');

      const bindings = await prisma.$queryRawUnsafe(
        `SELECT system_key, code, display, release_id, linearization_uri, foundation_uri
           FROM clinical_code_bindings
          WHERE resource_type = 'diagnosis' AND resource_id = $1
          ORDER BY system_key`,
        String(primaryDxId),
      );
      expect(bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ system_key: 'ICD10', code: TEST_ICD_CODE }),
        expect.objectContaining({
          system_key: 'ICD11',
          code: 'BA00',
          display: 'Essential hypertension',
          release_id: '2026-01',
          linearization_uri: 'http://id.who.int/icd/release/11/2026-01/mms/123',
          foundation_uri: 'http://id.who.int/icd/entity/123',
        }),
      ]));

      const events = await prisma.$queryRawUnsafe(
        `SELECT payload FROM clinical_timeline_events
          WHERE source_table = 'diagnoses' AND source_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        String(primaryDxId),
      );
      expect(events[0]?.payload?.codings).toEqual(expect.arrayContaining([
        expect.objectContaining({ system_key: 'ICD11', code: 'BA00' }),
      ]));
    });

    it('creates a secondary diagnosis without ICD-10 code', async () => {
      const res = await doctor.post('/api/v1/emr/diagnosis').send({
        patient_uid: PATIENT_UID,
        description: 'Comorbid condition',
        diagnosis_type: 'secondary',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.icd10_code).toBeNull();
      expect(res.body.data.diagnosis_type).toBe('secondary');
    });

    it('creates a chronic diagnosis that appears in problem list', async () => {
      const res = await doctor.post('/api/v1/emr/diagnosis').send({
        patient_uid: PATIENT_UID,
        description: 'Hypertension',
        diagnosis_type: 'secondary',
        status: 'chronic',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.status).toBe('chronic');
    });

    it('creates a diagnosis against an emergency visit encounter_id', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO emergency_visits
           (tenant_id, visit_number, patient_uid, encounter_id, arrival_mode,
            chief_complaint, status, created_by, updated_at)
         VALUES
           ('00000000-0000-4000-8000-000000000001'::uuid,
            'ER-DX-DEEP-001', $1::uuid, $2::uuid, 'walk_in',
            'Severe abdominal pain', 'in_treatment', $3::uuid, NOW())
         ON CONFLICT (encounter_id) DO NOTHING`,
        PATIENT_UID,
        ER_ENCOUNTER_UID,
        DOCTOR_UID,
      );

      const res = await doctor.post('/api/v1/emr/diagnosis').send({
        patient_uid: PATIENT_UID,
        encounter_id: ER_ENCOUNTER_UID,
        description: 'Emergency appendicitis rule-out',
        diagnosis_type: 'secondary',
        status: 'active',
      });

      expect(res.statusCode).toBe(201);
      expect(res.body.data.encounter_id).toBe(ER_ENCOUNTER_UID);
    });

    describe('updateDiagnosisStatus', () => {
      it('rejects invalid status value', async () => {
        const res = await doctor.put(`/api/v1/emr/diagnosis/${primaryDxId}/status`).send({
          status: 'bogus',
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 404 for unknown diagnosis id', async () => {
        const res = await doctor.put('/api/v1/emr/diagnosis/99999999/status').send({
          status: 'resolved',
        });
        expect(res.statusCode).toBe(404);
      });

      it('resolves a diagnosis and sets resolved_date', async () => {
        const res = await doctor.put(`/api/v1/emr/diagnosis/${primaryDxId}/status`).send({
          status: 'resolved',
          resolved_date: '2026-04-14',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.data.status).toBe('resolved');
        expect(res.body.data.resolved_date).toBeTruthy();
      });
    });
  });

  describe('getActiveProblemList', () => {
    it('returns active + chronic diagnoses but not resolved ones', async () => {
      const res = await doctor.get(`/api/v1/emr/diagnosis/patient/${PATIENT_UID}`);
      expect(res.statusCode).toBe(200);
      const items = res.body.data;
      expect(Array.isArray(items)).toBe(true);
      for (const d of items) {
        expect(['active', 'chronic']).toContain(d.status);
      }
      expect(items.find((d) => d.description === 'Hypertension')).toBeDefined();
      expect(items.find((d) => d.description === 'Initial diagnosis')).toBeUndefined(); // resolved
    });
  });

  describe('getPatientDiagnosisHistory', () => {
    it('returns every diagnosis regardless of status', async () => {
      const res = await doctor.get(`/api/v1/emr/diagnosis/patient/${PATIENT_UID}/history`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(3);
      const statuses = res.body.data.map((d) => d.status);
      expect(statuses).toContain('resolved');
      expect(statuses).toContain('chronic');
    });
  });

  describe('searchICD10', () => {
    it('finds the test ICD code by code prefix', async () => {
      const res = await doctor.get(`/api/v1/emr/icd10/search?q=${TEST_ICD_CODE.slice(0, 4)}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.find((r) => r.code === TEST_ICD_CODE)).toBeDefined();
    });

    it('finds the test ICD code by description text', async () => {
      const res = await doctor.get('/api/v1/emr/icd10/search?q=Unit+Test');
      expect(res.statusCode).toBe(200);
      expect(res.body.data.find((r) => r.code === TEST_ICD_CODE)).toBeDefined();
    });
  });
});
