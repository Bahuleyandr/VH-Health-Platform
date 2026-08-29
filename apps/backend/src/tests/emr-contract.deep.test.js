// Live OpenAPI contract test for the EMR clinical surface (/api/v1/emr/*).
// Drives a real clinical lifecycle (admit -> vitals -> note -> order ->
// diagnosis -> discharge prep) with an ADMIN desktop token over a seeded
// PATIENT + active treatment-consent + admission fixture, and validates each
// response body against its committed OpenAPI envelope schema (assertData).
//
// Coverage note: the MAR sub-domain (/api/v1/emr/mar/*) is intentionally NOT
// exercised here. Those routes are an ALIAS mount of the canonical
// /api/v1/clinical/mar/* router with a runtime `req.url = /mar${...}` rewrite
// (app.js ~835-858). The spec generator walks mount(/emr/mar)+route(/mar/...)
// and emits DOUBLE-segment paths (/emr/mar/mar/...) that never serve (404) —
// a pre-existing generator/alias-mount artifact, unrelated to response typing.
// The MAR schemas remain statically validated by the contract gate.
import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { assertData } from './helpers/assertSchema.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_RECORD_SUMMARY_MODULE = 'patient_record_summary';
const PATIENT_UID = 'e3000002-0001-4e30-8e30-e30000020001';
const DOCTOR_UID = 'e3000002-0002-4e30-8e30-e30000020002';
const ADMIN_UID = 'e3000002-0003-4e30-8e30-e30000020003';
const NURSE_UID = 'e3000002-0004-4e30-8e30-e30000020004';
const PHARMACIST_UID = 'e3000002-0005-4e30-8e30-e30000020005';
const ICU_INCHARGE_UID = 'e3000002-0006-4e30-8e30-e30000020006';
const MEDICATION_CATALOG_NAME = `EMRC Paracetamol ${process.pid}`;
const MEDICATION_COMPOSITION_KEY = `emrc_paracetamol_${process.pid}`;

function client(role, claims) {
  const t = generateTestToken(role, claims);
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return {
    get: (p) => h(request(app).get(p)),
    post: (p) => h(request(app).post(p)),
    put: (p) => h(request(app).put(p)),
    patch: (p) => h(request(app).patch(p)),
    del: (p) => h(request(app).delete(p)),
  };
}
const A = client('ADMIN', { uid: ADMIN_UID, id: 990778, deviceType: 'desktop' });
// The unified clinical timeline (patient.timeline.view) is relationship-gated:
// it requires the requester to have an active care-team / admission / etc.
// relationship with the patient (accessDecisionService), which an ADMIN does
// not. The attending doctor does (findAdmissionRelationship matches the
// admission this test creates), so timeline reads go through the doctor — the
// realistic caller for a comprehensive clinical view.
const D = client('DOCTOR', { uid: DOCTOR_UID, id: 990779, deviceType: 'desktop' });
const N = client('IP_STAFF_NURSE', { uid: NURSE_UID, id: 990780, deviceType: 'desktop' });
const P = client('PHARMACIST', { uid: PHARMACIST_UID, id: 990781, deviceType: 'desktop' });
const P_AS_LEAD = client('PHARMACY_INCHARGE', {
  uid: PHARMACIST_UID,
  id: 990781,
  deviceType: 'desktop',
});
const I = client('ICU_INCHARGE', { uid: ICU_INCHARGE_UID, id: 990782, deviceType: 'desktop' });

// Validate status exactly + the full envelope body against its committed schema.
function check(res, status, schema) {
  expect(res.statusCode).toBe(status);
  assertData(schema, res.body);
}

async function clean() {
  for (const sql of [
    `DELETE FROM task_comments WHERE task_id IN
       (SELECT id FROM tasks WHERE patient_uid = $1::uuid)`,
    `DELETE FROM notification_outbox WHERE tenant_id = '${TENANT_ID}'::uuid
       AND payload->>'patient_uid' = $1::text`,
    `DELETE FROM tasks WHERE patient_uid = $1::uuid`,
    `DELETE FROM workflow_sla_instances WHERE patient_uid = $1::uuid`,
    `DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`,
    `DELETE FROM intake_output WHERE patient_uid = $1::uuid`,
    `DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`,
    `DELETE FROM news2_scores WHERE patient_uid = $1::uuid`,
    `DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`,
    `DELETE FROM diagnoses WHERE patient_uid = $1::uuid`,
    `DELETE FROM ward_indent_financial_events WHERE ward_indent_id IN
       (SELECT id FROM ward_indents WHERE patient_uid = $1::uuid)`,
    `DELETE FROM ward_indent_events WHERE ward_indent_id IN
       (SELECT id FROM ward_indents WHERE patient_uid = $1::uuid)`,
    `DELETE FROM ward_indent_items WHERE ward_indent_id IN
       (SELECT id FROM ward_indents WHERE patient_uid = $1::uuid)`,
    `DELETE FROM ward_indents WHERE patient_uid = $1::uuid`,
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`,
    `DELETE FROM investigation_files WHERE investigation_id IN
       (SELECT id FROM investigations WHERE patient_uid = $1::uuid)`,
    `DELETE FROM investigations WHERE patient_uid = $1::uuid`,
    `DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`,
    `DELETE FROM discharge_consults WHERE patient_uid = $1::uuid`,
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
    `DELETE FROM patient_consents WHERE patient_uid = $1::uuid`,
  ]) await prisma.$executeRawUnsafe(sql, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number = 'EMRC-BED-1'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = 'EMRC-WARD'`).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_catalog WHERE tenant_id = $1::uuid AND name = $2::text`,
    TENANT_ID,
    MEDICATION_CATALOG_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM drug_compositions WHERE composition_key = $1`,
    MEDICATION_COMPOSITION_KEY,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid)`,
    PATIENT_UID, DOCTOR_UID, ADMIN_UID, NURSE_UID, PHARMACIST_UID, ICU_INCHARGE_UID,
  ).catch(() => {});
  // Delete, do not set enabled=false: a false override poisons the shared QA DB
  // by beating the module defaults for later suites.
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_tenant_modules
     WHERE tenant_id = $1::uuid AND module_key = $2`,
    TENANT_ID, PATIENT_RECORD_SUMMARY_MODULE).catch(() => {});
}

async function enablePatientRecordSummaryModule() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_ai_tenant_modules
       (tenant_id, module_key, enabled, settings, created_at, updated_at)
     VALUES ($1::uuid, $2, true, '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, module_key)
     DO UPDATE SET enabled = true, updated_at = NOW()`,
    TENANT_ID, PATIENT_RECORD_SUMMARY_MODULE);
}

describe('EMR contract — clinical lifecycle (live assertResponse)', () => {
  let admissionId; let encounterId; let bedId; let noteId; let dxId; let orderId; let catalogId;

  beforeAll(async () => {
    await clean();
    await enablePatientRecordSummaryModule();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at) VALUES
        ($1::uuid,'9300000021','EMRC Patient','PATIENT',true,NOW()),
        ($2::uuid,'9300000022','EMRC Doctor','DOCTOR',true,NOW()),
        ($3::uuid,'9300000023','EMRC Admin','ADMIN',true,NOW()),
        ($4::uuid,'9300000024','EMRC Nurse','IP_STAFF_NURSE',true,NOW()),
        ($5::uuid,'9300000025','EMRC Pharmacist','PHARMACIST',true,NOW()),
        ($6::uuid,'9300000026','EMRC ICU Incharge','ICU_INCHARGE',true,NOW())`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID, NURSE_UID, PHARMACIST_UID, ICU_INCHARGE_UID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents (patient_uid, consent_type, granted, status)
       VALUES ($1::uuid,'treatment',true,'active')`, PATIENT_UID);
    const w = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ('EMRC-WARD', 1, 1) RETURNING id`);
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, status) VALUES ($1,'EMRC-WARD','EMRC-BED-1','available') RETURNING id`,
      w[0].id);
    const compositionId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ($1, 'Paracetamol', ARRAY['paracetamol']::text[], 'curated')
       RETURNING id`,
      MEDICATION_COMPOSITION_KEY,
    ))[0].id);
    bedId = b[0].id;
    catalogId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, category, requires_prescription, is_active,
          stock_quantity, unit_price, price, generic_name, composition_id,
          composition_confidence, composition_source, strength, strength_key,
          strength_components, form, form_key, route, release_key, updated_at)
       VALUES ($1::uuid, $2::text, 'medication', TRUE, TRUE,
               100, 2.50, 2.50, 'paracetamol', $3::int,
               'high', 'curated', '500 mg', '500mg', $4::jsonb,
               'tablet', 'tablet', 'oral', 'ir', NOW())
       RETURNING id`,
      TENANT_ID,
      MEDICATION_CATALOG_NAME,
      compositionId,
      JSON.stringify([{ ingredient: 'paracetamol', value: 500, unit: 'mg' }]),
    ))[0].id);
  }, 60000);

  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);

  it('admission-mgmt: admit + list/detail/stats/options/board/lookup/config/translations/hub', async () => {
    const admit = await A.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_UID, admitting_doctor: DOCTOR_UID, attending_doctor: DOCTOR_UID,
      ward: 'EMRC-WARD', bed_id: bedId, chief_complaint: 'chest pain', admitting_diagnosis: 'ACS rule-out',
      admission_type: 'emergency', priority: 'urgent', code_status: 'full_code',
    });
    check(admit, 201, 'EmrAdmitResponse');
    admissionId = admit.body.data.admission.id;
    encounterId = admit.body.data.admission.encounter_id;
    expect(admissionId).toBeDefined();
    expect(encounterId).toBeDefined();

    check(await A.get('/api/v1/emr/admissions?limit=5'), 200, 'EmrAdmissionListResponse');
    check(await A.get(`/api/v1/emr/admission/${admissionId}`), 200, 'EmrAdmissionDetailResponse');
    check(await A.get('/api/v1/emr/admissions/stats'), 200, 'EmrAdmissionStatsResponse');
    check(await A.get(`/api/v1/emr/admissions/patient/${PATIENT_UID}`), 200, 'EmrAdmissionHistoryResponse');
    check(await A.get('/api/v1/emr/bed-options'), 200, 'EmrBedOptionsResponse');
    check(await A.get('/api/v1/emr/ward-options'), 200, 'EmrWardOptionsResponse');
    check(await A.get('/api/v1/emr/command-board'), 200, 'EmrCommandBoardResponse');
    check(await A.get('/api/v1/emr/lookup?phone=9300000021'), 200, 'EmrAdmissionLookupResponse');
    check(await A.get('/api/v1/emr/clinical-ai/config'), 200, 'EmrClinicalAiConfigResponse');
    check(await A.get('/api/v1/emr/translations'), 200, 'EmrTranslationsListResponse');
    check(await A.get('/api/v1/emr/discharge-hub'), 200, 'EmrDischargeHubListResponse');
  }, 120000);

  it('admission-detail: mutations + case-sheet + discharge views + AI summary', async () => {
    check(await A.put(`/api/v1/emr/${admissionId}/attending-doctor`).send({ doctor_uid: DOCTOR_UID }),
      200, 'EmrAdmissionMutationResponse');
    check(await A.put(`/api/v1/emr/${admissionId}/code-status`).send({ code_status: 'dnr' }),
      200, 'EmrAdmissionMutationResponse');
    check(await A.put(`/api/v1/emr/${admissionId}/next-review`).send({ next_review_at: new Date(Date.now() + 86400000).toISOString() }),
      200, 'EmrAdmissionMutationResponse');
    check(await A.get(`/api/v1/emr/${admissionId}/case-sheet`), 200, 'EmrCaseSheetResponse');
    check(await A.put(`/api/v1/emr/${admissionId}/case-sheet`).send({ case_sheet: { history: 'lifecycle hx' } }),
      200, 'EmrCaseSheetSaveResponse');
    check(await A.get(`/api/v1/emr/${admissionId}/discharge-readiness`), 200, 'EmrDischargeReadinessResponse');
    check(await A.get(`/api/v1/emr/${admissionId}/discharge-hub`), 200, 'EmrDischargeHubResponse');
    check(await A.get(`/api/v1/emr/${admissionId}/discharge-summary`), 200, 'EmrDischargeSummaryResponse');
    check(await A.put(`/api/v1/emr/${admissionId}/discharge-summary`).send({ discharge_summary: { notes: 'lifecycle' } }),
      200, 'EmrDischargeSummarySaveResponse');
    // AI op: returns a graceful draft envelope even without a configured LLM.
    check(await A.post(`/api/v1/emr/${admissionId}/ai/patient-record-summary`).send({}),
      200, 'EmrAiDraftResponse');
  }, 120000);

  it('observations: vitals + I/O + CDS + ICD-10 + timeline', async () => {
    check(await A.post('/api/v1/emr/vitals').send({
      patient_uid: PATIENT_UID, encounter_id: encounterId, heart_rate: 88, systolic_bp: 120,
      diastolic_bp: 80, spo2: 98, respiratory_rate: 16, temperature: 37, consciousness: 'A',
    }), 201, 'EmrVitalsRecordResponse');
    check(await A.get(`/api/v1/emr/vitals/${PATIENT_UID}/latest`), 200, 'EmrVitalLatestResponse');
    check(await A.get(`/api/v1/emr/vitals/${PATIENT_UID}/chart`), 200, 'EmrVitalChartResponse');
    check(await A.get(`/api/v1/emr/vitals/${PATIENT_UID}/trend?vital=heart_rate`), 200, 'EmrVitalsTrendResponse');
    check(await A.post('/api/v1/emr/io').send({
      patient_uid: PATIENT_UID, encounter_id: encounterId, io_type: 'intake', category: 'oral', amount_ml: 200,
    }), 201, 'EmrIORecordResponse');
    const today = (await prisma.$queryRawUnsafe(`SELECT current_date::text AS d`))[0].d;
    check(await A.get(`/api/v1/emr/io/${PATIENT_UID}/balance?date=${today}`), 200, 'EmrIOBalanceResponse');
    check(await A.get(`/api/v1/emr/io/${PATIENT_UID}/chart`), 200, 'EmrIOChartResponse');
    check(await A.get('/api/v1/emr/cds/protocols'), 200, 'EmrCdsProtocolListResponse');
    check(await A.get(`/api/v1/emr/cds/alerts/${PATIENT_UID}`), 200, 'EmrCdsAlertListResponse');
    check(await A.get('/api/v1/emr/icd10/search?q=hypertension'), 200, 'EmrIcd10SearchResponse');
    check(await D.get(`/api/v1/emr/timeline/${PATIENT_UID}`), 200, 'EmrTimelineResponse');
  }, 120000);

  it('notes-diagnosis: note CRUD/draft/sign + diagnosis create/list/status', async () => {
    const note = await A.post('/api/v1/emr/notes').send({
      patient_uid: PATIENT_UID, encounter_id: encounterId, note_type: 'progress', content: 'lifecycle progress note',
    });
    check(note, 201, 'EmrClinicalNoteResponse');
    noteId = note.body.data.id;
    check(await A.get(`/api/v1/emr/notes/${noteId}`), 200, 'EmrClinicalNoteDetailResponse');
    check(await A.get(`/api/v1/emr/notes/patient/${PATIENT_UID}`), 200, 'EmrClinicalNoteListResponse');
    check(await A.put('/api/v1/emr/notes/draft').send({ patient_uid: PATIENT_UID, note_type: 'progress', content: { summary: 'd' } }),
      200, 'EmrNoteDraftUpsertResponse');
    check(await A.get(`/api/v1/emr/notes/draft?patient_uid=${PATIENT_UID}&note_type=progress`), 200, 'EmrNoteDraftResponse');
    check(await A.del(`/api/v1/emr/notes/draft?patient_uid=${PATIENT_UID}&note_type=progress`), 200, 'EmrNoteDraftDeleteResponse');
    check(await A.post(`/api/v1/emr/notes/${noteId}/sign`).send({}), 200, 'EmrClinicalNoteResponse');

    const dx = await A.post('/api/v1/emr/diagnosis').send({
      patient_uid: PATIENT_UID, encounter_id: encounterId, description: 'Essential hypertension',
      icd10_code: 'I10', diagnosis_type: 'primary', status: 'active',
    });
    check(dx, 201, 'EmrDiagnosisResponse');
    dxId = dx.body.data.id;
    check(await A.get(`/api/v1/emr/diagnosis/patient/${PATIENT_UID}`), 200, 'EmrDiagnosisListResponse');
    check(await A.put(`/api/v1/emr/diagnosis/${dxId}/status`).send({ status: 'resolved' }), 200, 'EmrDiagnosisResponse');
  }, 120000);

  it('orders: create + list + verify + complete + order-sets', async () => {
    const ord = await A.post('/api/v1/emr/orders').set('Idempotency-Key', `emr-contract-order-cbc-${Date.now()}`).send({
      patient_uid: PATIENT_UID, encounter_id: encounterId, order_type: 'investigation',
      priority: 'routine', details: { test_name: 'CBC' },
    });
    check(ord, 201, 'EmrClinicalOrderCreateResponse');
    orderId = ord.body.data.order?.id ?? ord.body.data.id;
    expect(orderId).toBeDefined();
    check(await A.get(`/api/v1/emr/orders/patient/${PATIENT_UID}`), 200, 'EmrClinicalOrderListResponse');
    expect((await D.put(`/api/v1/emr/orders/${orderId}/verify`)
      .set('Idempotency-Key', `emr-contract-doctor-verify-${orderId}`)
      .send({})).statusCode).toBe(403);
    expect((await P.put(`/api/v1/emr/orders/${orderId}/verify`)
      .set('Idempotency-Key', `emr-contract-pharmacy-non-med-${orderId}`)
      .send({})).statusCode).toBe(403);
    expect((await N.put(`/api/v1/emr/orders/${orderId}/verify`).send({})).statusCode).toBe(400);
    check(await N.put(`/api/v1/emr/orders/${orderId}/verify`)
      .set('Idempotency-Key', `emr-contract-order-verify-${orderId}`)
      .send({}), 200, 'EmrClinicalOrderResponse');
    check(await A.put(`/api/v1/emr/orders/${orderId}/complete`)
      .set('Idempotency-Key', `emr-contract-order-complete-${orderId}`)
      .send({}), 200, 'EmrClinicalOrderResponse');

    const medication = await D.post('/api/v1/emr/orders')
      .set('Idempotency-Key', `emr-contract-medication-${Date.now()}`)
      .send({
        patient_uid: PATIENT_UID,
        encounter_id: encounterId,
        order_type: 'medication',
        priority: 'routine',
        details: {
          medication_name: MEDICATION_CATALOG_NAME,
          dose: '500mg',
          route: 'oral',
          frequency: 'TDS',
          catalog_id: catalogId,
          quantity_requested: 6,
          unit: 'tablet',
        },
      });
    check(medication, 201, 'EmrClinicalOrderCreateResponse');
    const medicationOrderId = medication.body.data.order?.id ?? medication.body.data.id;
    const pharmacistVerifyKey = `emr-contract-pharmacist-verify-${medicationOrderId}`;
    check(await P.put(`/api/v1/emr/orders/${medicationOrderId}/verify`)
      .set('Idempotency-Key', pharmacistVerifyKey)
      .send({}), 200, 'EmrClinicalOrderResponse');
    expect((await P.put(`/api/v1/emr/orders/${medicationOrderId}/verify`)
      .set('Idempotency-Key', pharmacistVerifyKey)
      .send({ changed: true })).statusCode).toBe(422);
    expect((await P_AS_LEAD.put(`/api/v1/emr/orders/${medicationOrderId}/verify`)
      .set('Idempotency-Key', pharmacistVerifyKey)
      .send({})).statusCode).toBe(422);

    const nursing = await A.post('/api/v1/emr/orders')
      .set('Idempotency-Key', `emr-contract-nursing-${Date.now()}`)
      .send({
        patient_uid: PATIENT_UID,
        encounter_id: encounterId,
        order_type: 'nursing',
        priority: 'routine',
        details: { instruction: 'Reposition every two hours' },
      });
    check(nursing, 201, 'EmrClinicalOrderCreateResponse');
    const nursingOrderId = nursing.body.data.order?.id ?? nursing.body.data.id;
    check(await I.put(`/api/v1/emr/orders/${nursingOrderId}/verify`)
      .set('Idempotency-Key', `emr-contract-icu-incharge-verify-${nursingOrderId}`)
      .send({}), 200, 'EmrClinicalOrderResponse');

    await prisma.admissions.update({
      where: { id: admissionId },
      data: { status: 'discharged' },
    });
    expect((await P.put(`/api/v1/emr/orders/${medicationOrderId}/verify`)
      .set('Idempotency-Key', pharmacistVerifyKey)
      .send({})).statusCode).toBe(403);
    check(await A.get('/api/v1/emr/order-sets'), 200, 'EmrOrderSetListResponse');
  }, 120000);
});
