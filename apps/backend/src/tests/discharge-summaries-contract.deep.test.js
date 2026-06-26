// Live OpenAPI contract deep-test for the discharge-summaries surface.
//
// Drives the FULL happy-path lifecycle over HTTP via supertest and asserts
// every successful response against the committed 200 $ref schemas in
// src/docs/openapi.json (via assertResponse). This is the runtime contract
// gate for the discharge slice — it proves the live payloads actually match
// the typed schemas the admin/codegen consumers rely on, not just that the
// spec lints.
//
// Lifecycle walk (status draft → ready_for_signoff → signed → delivered):
//   GET  /templates
//   POST /                         (create draft)
//   GET  /{id}
//   PATCH /{id}/sections/{key}     (fill each required section)
//   PATCH /{id}/sections/{key}/translation
//   POST /{id}/ready
//   POST /{id}/sign
//   POST /{id}/deliver
//   GET  /pending
//   GET  /patient/{patientUid}
// That set covers all 10 /api/v1/discharge-summaries/* operations.
//
// Modelled on appointment-deep.test.js (auth bootstrap + assertResponse) and
// discharge-summary-autofill-deep.test.js (fixture inserts + cleanup).

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { assertResponse } from './helpers/assertSchema.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

// Unique prefixes so this suite never collides with other discharge tests.
const PATIENT_UID = 'dc01dc01-0001-4dc0-8dc0-dc01dc010001';
const ADMIN_UID = 'dc01dc01-0002-4dc0-8dc0-dc01dc010002';
const PATIENT_PHONE = '9009010001';
const TEMPLATE_CODE = 'DISCH_CONTRACT_DEEP_TEST';

// ADMIN bound to the default tenant: ADMIN passes BOTH requireStaffOrAdmin
// (isStaff includes ADMIN) and requireDoctorOrAdmin (isAdmin), so a single
// token drives the whole lifecycle including /sign.
function mkAdmin() {
  const token = generateTestToken('ADMIN', { uid: ADMIN_UID, id: 990001, phone: '9009010002' });
  const auth = (p) => `Bearer ${token}`;
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', auth()),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', auth()),
    patch: (p) => request(app).patch(p).set('x-api-key', API_KEY).set('Authorization', auth()),
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_summary_sections
      WHERE discharge_summary_id IN (
        SELECT id FROM discharge_summaries WHERE patient_uid = $1::uuid
      )`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_summaries WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_summary_templates WHERE tenant_id = $1::uuid AND code = $2`,
    DEFAULT_TENANT_ID, TEMPLATE_CODE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID, ADMIN_UID,
  ).catch(() => {});
}

describe('Discharge summaries — live OpenAPI contract deep test', () => {
  let admin;
  let dischargeId;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Discharge Contract Patient', 'PATIENT', true, NOW()),
              ($3::uuid, $4, 'Discharge Contract Admin', 'ADMIN', true, NOW())`,
      PATIENT_UID, PATIENT_PHONE, ADMIN_UID, '9009010002',
    );
    // Template with the two required-sign sections (diagnosis +
    // discharge_medications) so the /ready and /sign completeness gate can be
    // satisfied by filling them with real bodies. No admission is created, so
    // both sections materialise blank (template default null) and must be
    // PATCHed before /ready.
    await prisma.$executeRawUnsafe(
      `INSERT INTO discharge_summary_templates
         (code, display_name, specialty, sections, active, tenant_id)
       VALUES ($1, 'Discharge contract deep test template', 'general_medicine', $2::jsonb, true, $3::uuid)`,
      TEMPLATE_CODE,
      JSON.stringify([
        { section_key: 'diagnosis', section_title: 'Diagnosis', display_order: 1 },
        { section_key: 'discharge_medications', section_title: 'Discharge Medications', display_order: 2 },
      ]),
      DEFAULT_TENANT_ID,
    );

    admin = mkAdmin();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60000);

  it('drives the full lifecycle and validates every payload against the committed schema', async () => {
    // 1) GET /templates → DischargeTemplateListResponse
    const templates = await admin.get('/api/v1/discharge-summaries/templates?specialty=general_medicine');
    expect(templates.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/discharge-summaries/templates', templates.body);
    const tpl = templates.body.data.find((t) => t.code === TEMPLATE_CODE);
    expect(tpl).toBeDefined();
    expect(tpl.active).toBe(true);

    // 2) POST / (create draft) → DischargeSummaryResponse, status 'draft'
    const created = await admin.post('/api/v1/discharge-summaries').send({
      patient_uid: PATIENT_UID,
      template_code: TEMPLATE_CODE,
    });
    expect(created.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/discharge-summaries', created.body);
    expect(created.body.data.status).toBe('draft');
    expect(created.body.data.patient_uid).toBe(PATIENT_UID);
    expect(created.body.data.tenant_id).toBe(DEFAULT_TENANT_ID);
    expect(Array.isArray(created.body.data.sections)).toBe(true);
    dischargeId = created.body.data.id;
    expect(dischargeId).toBeDefined();

    const sectionKeys = created.body.data.sections.map((s) => s.section_key);
    expect(sectionKeys).toEqual(expect.arrayContaining(['diagnosis', 'discharge_medications']));

    // 3) GET /{id} → DischargeSummaryResponse
    const fetched = await admin.get(`/api/v1/discharge-summaries/${dischargeId}`);
    expect(fetched.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/discharge-summaries/{id}', fetched.body);
    expect(fetched.body.data.id).toBe(dischargeId);
    expect(fetched.body.data.status).toBe('draft');

    // 4) PATCH /{id}/sections/{key} — fill BOTH required sections with real
    //    (non-blank, non-placeholder) bodies so the completeness gate passes.
    const fillDiagnosis = await admin
      .patch(`/api/v1/discharge-summaries/${dischargeId}/sections/diagnosis`)
      .send({ body: 'Acute gastroenteritis with dehydration, resolved.' });
    expect(fillDiagnosis.statusCode).toBe(200);
    assertResponse('PATCH', '/api/v1/discharge-summaries/{id}/sections/{key}', fillDiagnosis.body);
    const dx = fillDiagnosis.body.data.sections.find((s) => s.section_key === 'diagnosis');
    expect(dx.body).toContain('Acute gastroenteritis');
    expect(dx.edited_by).toBe(ADMIN_UID);

    const fillMeds = await admin
      .patch(`/api/v1/discharge-summaries/${dischargeId}/sections/discharge_medications`)
      .send({ body: 'ORS Sachet 1 sachet oral TDS 3 days\nParacetamol 500mg PO SOS' });
    expect(fillMeds.statusCode).toBe(200);
    assertResponse('PATCH', '/api/v1/discharge-summaries/{id}/sections/{key}', fillMeds.body);
    const meds = fillMeds.body.data.sections.find((s) => s.section_key === 'discharge_medications');
    expect(meds.body).toContain('ORS Sachet');

    // 5) PATCH /{id}/sections/{key}/translation — add a Tamil translation entry.
    const translate = await admin
      .patch(`/api/v1/discharge-summaries/${dischargeId}/sections/diagnosis/translation`)
      .send({ language: 'ta', body: 'கடுமையான வயிற்றுப்போக்கு, குணமடைந்தது.' });
    expect(translate.statusCode).toBe(200);
    assertResponse('PATCH', '/api/v1/discharge-summaries/{id}/sections/{key}/translation', translate.body);
    const dxAfterTranslate = translate.body.data.sections.find((s) => s.section_key === 'diagnosis');
    expect(dxAfterTranslate.body_translations).toBeDefined();
    expect(dxAfterTranslate.body_translations.ta).toContain('குணமடைந்தது');

    // 6) POST /{id}/ready → status flips to 'ready_for_signoff'
    const ready = await admin.post(`/api/v1/discharge-summaries/${dischargeId}/ready`).send({});
    expect(ready.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/discharge-summaries/{id}/ready', ready.body);
    expect(ready.body.data.status).toBe('ready_for_signoff');

    // 7) POST /{id}/sign → status 'signed' + signed_at present.
    //    signed_by_name must be supplied in the body (the test token carries
    //    no `name`, and the route falls back to req.user?.name otherwise).
    const sign = await admin.post(`/api/v1/discharge-summaries/${dischargeId}/sign`).send({
      signed_by_name: 'Dr. Discharge Contract',
      signed_by_reg: 'TN-MED-99999',
    });
    expect(sign.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/discharge-summaries/{id}/sign', sign.body);
    expect(sign.body.data.status).toBe('signed');
    expect(sign.body.data.signed_at).toBeTruthy();
    expect(sign.body.data.signed_by_name).toBe('Dr. Discharge Contract');

    // 8) POST /{id}/deliver → status 'delivered' + delivery_method 'printed'.
    const deliver = await admin.post(`/api/v1/discharge-summaries/${dischargeId}/deliver`).send({
      delivery_method: 'printed',
    });
    expect(deliver.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/discharge-summaries/{id}/deliver', deliver.body);
    expect(deliver.body.data.status).toBe('delivered');
    expect(deliver.body.data.delivery_method).toBe('printed');
    expect(deliver.body.data.delivered_at).toBeTruthy();

    // Verify the lifecycle is REAL at the DB layer too.
    const row = await prisma.$queryRawUnsafe(
      `SELECT status, delivery_method, signed_at, delivered_at
         FROM discharge_summaries WHERE id = $1::int`,
      Number(dischargeId),
    );
    expect(row[0].status).toBe('delivered');
    expect(row[0].delivery_method).toBe('printed');
    expect(row[0].signed_at).toBeTruthy();
    expect(row[0].delivered_at).toBeTruthy();
  });

  it('lists pending drafts and validates GET /pending against the schema', async () => {
    // Seed a fresh draft so /pending has a draft/ready_for_signoff row to
    // return (the lifecycle summary above is now 'delivered' and excluded).
    const draft = await admin.post('/api/v1/discharge-summaries').send({
      patient_uid: PATIENT_UID,
      template_code: TEMPLATE_CODE,
    });
    expect(draft.statusCode).toBe(200);
    const draftId = draft.body.data.id;

    const pending = await admin.get('/api/v1/discharge-summaries/pending?limit=50');
    expect(pending.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/discharge-summaries/pending', pending.body);
    expect(Array.isArray(pending.body.data)).toBe(true);
    const mine = pending.body.data.find((d) => d.id === draftId);
    expect(mine).toBeDefined();
    expect(mine.status).toBe('draft');
    expect(mine.patient_uid).toBe(PATIENT_UID);
  });

  it('lists a patient\'s discharge summaries and validates GET /patient/{patientUid}', async () => {
    const list = await admin.get(`/api/v1/discharge-summaries/patient/${PATIENT_UID}?limit=50`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/discharge-summaries/patient/{patientUid}', list.body);
    expect(Array.isArray(list.body.data)).toBe(true);
    // The delivered lifecycle summary from test 1 must appear here.
    const delivered = list.body.data.find((d) => d.status === 'delivered');
    expect(delivered).toBeDefined();
    expect(delivered.delivery_method).toBe('printed');
  });
});
