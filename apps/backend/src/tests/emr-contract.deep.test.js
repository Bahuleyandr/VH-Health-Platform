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
const PATIENT_UID = 'e3000002-0001-4e30-8e30-e30000020001';
const DOCTOR_UID = 'e3000002-0002-4e30-8e30-e30000020002';
const ADMIN_UID = 'e3000002-0003-4e30-8e30-e30000020003';

function client() {
  const t = generateTestToken('ADMIN', { uid: ADMIN_UID, id: 990778, deviceType: 'desktop' });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return {
    get: (p) => h(request(app).get(p)),
    post: (p) => h(request(app).post(p)),
    put: (p) => h(request(app).put(p)),
    patch: (p) => h(request(app).patch(p)),
    del: (p) => h(request(app).delete(p)),
  };
}
const A = client();

// Validate status exactly + the full envelope body against its committed schema.
function check(res, status, schema) {
  expect(res.statusCode).toBe(status);
  assertData(schema, res.body);
}

async function clean() {
  for (const sql of [
    `DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`,
    `DELETE FROM intake_output WHERE patient_uid = $1::uuid`,
    `DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`,
    `DELETE FROM news2_scores WHERE patient_uid = $1::uuid`,
    `DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`,
    `DELETE FROM diagnoses WHERE patient_uid = $1::uuid`,
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`,
    `DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`,
    `DELETE FROM discharge_consults WHERE patient_uid = $1::uuid`,
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
    `DELETE FROM patient_consents WHERE patient_uid = $1::uuid`,
  ]) await prisma.$executeRawUnsafe(sql, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number = 'EMRC-BED-1'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = 'EMRC-WARD'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid)`,
    PATIENT_UID, DOCTOR_UID, ADMIN_UID).catch(() => {});
}

describe('EMR contract — clinical lifecycle (live assertResponse)', () => {
  let admissionId; let encounterId; let bedId; let noteId; let dxId; let orderId;

  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at) VALUES
        ($1::uuid,'9300000021','EMRC Patient','PATIENT',true,NOW()),
        ($2::uuid,'9300000022','EMRC Doctor','DOCTOR',true,NOW()),
        ($3::uuid,'9300000023','EMRC Admin','ADMIN',true,NOW())`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents (patient_uid, consent_type, granted, status)
       VALUES ($1::uuid,'treatment',true,'active')`, PATIENT_UID);
    const w = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ('EMRC-WARD', 1, 1) RETURNING id`);
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, status) VALUES ($1,'EMRC-WARD','EMRC-BED-1','available') RETURNING id`,
      w[0].id);
    bedId = b[0].id;
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
    check(await A.get(`/api/v1/emr/timeline/${PATIENT_UID}`), 200, 'EmrTimelineResponse');
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
    check(await A.put(`/api/v1/emr/orders/${orderId}/verify`).send({}), 200, 'EmrClinicalOrderResponse');
    check(await A.put(`/api/v1/emr/orders/${orderId}/complete`).send({}), 200, 'EmrClinicalOrderResponse');
    check(await A.get('/api/v1/emr/order-sets'), 200, 'EmrOrderSetListResponse');
  }, 120000);
});
