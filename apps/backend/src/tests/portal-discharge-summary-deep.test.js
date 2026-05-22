// Deep regression test for finding
// 2026-05-21-inpatient-admission-patient-8db55849 (H13), sub-issue (c):
// once a discharge summary is SIGNED it must be readable by the patient
// on the patient-facing portal surface.
//
// The staff EMR surface (/api/v1/discharge-summaries/*, mounted with
// requireRole ADMIN/SUPER_ADMIN/DOCTOR/NURSING_STAFF) is NOT patient-
// reachable — that is the surface the original finding's repro hit. The
// patient reads through /api/v1/portal/discharge-summaries, which queries
// the same `discharge_summaries` table that dischargeService.sign()
// writes to, filtered to signed/delivered status and scoped to the
// authenticated patient_uid from the JWT.
//
// This test drives the real write→read contract end-to-end:
//   1. dischargeService.createDraft + .sign produces a signed row.
//   2. GET /portal/discharge-summaries returns it to its patient.
//   3. GET /portal/discharge-summaries/:id returns it with sections.
//   4. An UNSIGNED draft for the same patient is NOT returned (list+detail).
//   5. Another patient's signed summary is NOT returned (IDOR).
// It guards the surface so a future change to the table, status filter,
// or ownership scope can't silently re-disconnect the patient from their
// signed discharge summary.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import * as discharge from '../services/discharge/dischargeService.js';
import { API_KEY, generateTestToken } from './testClient.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd1d1d1d1-1111-4111-8111-aaaaaaaa0001';
const OTHER_UID = 'd2d2d2d2-2222-4222-8222-bbbbbbbb0002';
const DOCTOR_UID = 'd3d3d3d3-3333-4333-8333-cccccccc0003';

// A bespoke template so the summary carries the required clinical
// sections with real content (so dischargeService.sign()'s completeness
// gate from H13(a) passes) plus a section we can assert renders on the
// patient detail read.
const TEMPLATE_CODE = `DISCH_PORTAL_TEST_${Date.now() % 100000}`;

describe('GET /portal/discharge-summaries — signed summary reaches the patient', () => {
  let patientId;
  let signedSummaryId;
  let draftSummaryId;
  let otherSignedSummaryId;
  let patientToken;
  let otherToken;

  beforeAll(async () => {
    const [patientRows, otherRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2, 'Discharge Portal Patient', 'PATIENT', true, NOW())
         ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        PATIENT_UID,
        `9111${Date.now() % 1000000}`.slice(0, 10),
      ),
      prisma.$queryRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2, 'Other Portal Patient', 'PATIENT', true, NOW())
         ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        OTHER_UID,
        `9222${Date.now() % 1000000}`.slice(0, 10),
      ),
    ]);
    patientId = patientRows[0].id;
    const otherId = otherRows[0].id;

    // Template with the required-for-sign clinical sections populated so
    // the H13(a) completeness gate is satisfied at sign time.
    await prisma.$executeRawUnsafe(
      `INSERT INTO discharge_summary_templates
         (code, display_name, specialty, sections, active, tenant_id)
       VALUES ($1, 'Discharge portal test template', 'general_medicine',
               $2::jsonb, true, $3::uuid)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      TEMPLATE_CODE,
      JSON.stringify([
        { section_key: 'diagnosis', section_title: 'Diagnosis', display_order: 1, default_body: 'Acute gastroenteritis, resolved.' },
        { section_key: 'discharge_medications', section_title: 'Discharge Medications', display_order: 2, default_body: 'ORS sachets PRN x5 days.' },
        { section_key: 'follow_up', section_title: 'Follow-up Plan', display_order: 3, default_body: 'OPD review in 1 week.' },
      ]),
      TENANT_ID,
    );

    // 1. Signed summary for our patient — created + signed through the
    //    real service so we exercise the exact write path.
    const signedDraft = await discharge.createDraft({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      patient_name: 'Discharge Portal Patient',
      age_years: 41,
      sex: 'F',
      primary_diagnosis: 'Acute gastroenteritis',
      template_code: TEMPLATE_CODE,
      created_by: DOCTOR_UID,
    });
    signedSummaryId = signedDraft.id;
    await discharge.sign({
      tenantId: TENANT_ID,
      id: signedSummaryId,
      signed_by: DOCTOR_UID,
      signed_by_name: 'Dr. Test Physician',
      signed_by_reg: 'TN/12345',
    });

    // 2. UNSIGNED draft for the SAME patient — must never surface.
    const draft = await discharge.createDraft({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      patient_name: 'Discharge Portal Patient',
      age_years: 41,
      sex: 'F',
      primary_diagnosis: 'Observation — draft only',
      template_code: TEMPLATE_CODE,
      created_by: DOCTOR_UID,
    });
    draftSummaryId = draft.id;

    // 3. Signed summary for ANOTHER patient — IDOR guard.
    const otherDraft = await discharge.createDraft({
      tenantId: TENANT_ID,
      patient_uid: OTHER_UID,
      patient_name: 'Other Portal Patient',
      age_years: 55,
      sex: 'M',
      primary_diagnosis: 'Unrelated admission',
      template_code: TEMPLATE_CODE,
      created_by: DOCTOR_UID,
    });
    otherSignedSummaryId = otherDraft.id;
    await discharge.sign({
      tenantId: TENANT_ID,
      id: otherSignedSummaryId,
      signed_by: DOCTOR_UID,
      signed_by_name: 'Dr. Test Physician',
      signed_by_reg: 'TN/12345',
    });

    patientToken = generateTestToken('PATIENT', { uid: PATIENT_UID, id: patientId });
    otherToken = generateTestToken('PATIENT', { uid: OTHER_UID, id: otherId });
  });

  afterAll(async () => {
    const ids = [signedSummaryId, draftSummaryId, otherSignedSummaryId].filter(Boolean);
    for (const id of ids) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM discharge_summary_sections WHERE discharge_summary_id = $1::int`, id)
        .catch(() => {});
      await prisma
        .$executeRawUnsafe(`DELETE FROM discharge_summaries WHERE id = $1::int`, id)
        .catch(() => {});
    }
    // sign() materialises an e_prescriptions row from the meds section.
    await prisma
      .$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, OTHER_UID)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM discharge_summary_templates WHERE code = $1 AND tenant_id = $2::uuid`, TEMPLATE_CODE, TENANT_ID)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, OTHER_UID)
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('lists the patient\'s signed discharge summary and excludes their unsigned draft', async () => {
    const res = await request(app)
      .get('/api/v1/portal/discharge-summaries')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const list = res.body.data;
    expect(Array.isArray(list)).toBe(true);

    const signed = list.find((s) => s.id === signedSummaryId);
    expect(signed).toBeTruthy();
    expect(signed.status).toBe('signed');
    expect(signed.signed_at).toBeTruthy();

    // The unsigned draft for the same patient must NOT surface.
    expect(list.find((s) => s.id === draftSummaryId)).toBeFalsy();
    // Another patient's summary must never appear in this patient's list.
    expect(list.find((s) => s.id === otherSignedSummaryId)).toBeFalsy();
  });

  it('returns the signed summary detail with its sections', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/discharge-summaries/${signedSummaryId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const summary = res.body.data;
    expect(summary.id).toBe(signedSummaryId);
    expect(summary.status).toBe('signed');
    expect(Array.isArray(summary.sections)).toBe(true);
    const diagnosis = summary.sections.find((sec) => sec.section_key === 'diagnosis');
    expect(diagnosis).toBeTruthy();
    expect(String(diagnosis.body)).toContain('gastroenteritis');
  });

  it('does NOT return an unsigned draft on the detail read', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/discharge-summaries/${draftSummaryId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(404);
  });

  it('does NOT return another patient\'s signed summary (IDOR)', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/discharge-summaries/${signedSummaryId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.statusCode).toBe(404);
  });

  it('does NOT list another patient\'s signed summary for the other patient either', async () => {
    const res = await request(app)
      .get('/api/v1/portal/discharge-summaries')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.statusCode).toBe(200);
    const list = res.body.data;
    // Other patient sees their own signed summary, never ours.
    expect(list.find((s) => s.id === signedSummaryId)).toBeFalsy();
    expect(list.find((s) => s.id === otherSignedSummaryId)).toBeTruthy();
  });
});
