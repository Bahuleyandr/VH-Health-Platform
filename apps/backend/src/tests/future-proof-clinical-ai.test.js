import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'c1111111-1111-4111-8111-111111111a01';
const DOCTOR_UID = 'c1111111-1111-4111-8111-111111111a02';
const ADMIN_UID = 'c1111111-1111-4111-8111-111111111a03';
const ENCOUNTER_ID = 'c1111111-1111-4111-8111-111111111a04';
const IT_UID = 'c1111111-1111-4111-8111-111111111a05';

function authed(role, uid) {
  const token = generateTestToken(role, { uid, id: role === 'PATIENT' ? 7001 : 7002 });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (path) => request(app).put(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    patch: (path) => request(app).patch(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (path) => request(app).delete(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
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
  const itAdminClient = authed('IT_ADMIN', IT_UID);
  const patient = authed('PATIENT', PATIENT_UID);

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE resource = 'clinical_ai' OR action LIKE 'CLINICAL_AI_%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_safety_reviews WHERE module_key LIKE '%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_approvals WHERE reason LIKE '%[test]%' OR payload::text LIKE '%[test]%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_prompts WHERE title LIKE '%[test]%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_break_glass_sessions WHERE reason LIKE '%[test]%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_context_snapshots WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM insurance_claims WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_voice_notes WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_longitudinal_risk WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_translations WHERE source_generation_id IN (SELECT id FROM clinical_ai_generations WHERE patient_uid = $1::uuid)`, PATIENT_UID).catch(() => {});
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
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`, PATIENT_UID, DOCTOR_UID, ADMIN_UID, IT_UID);

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, gender, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, '9000091001', 'Clinical AI Patient', 'PATIENT', 'female', true, '00000000-0000-4000-8000-000000000001', NOW()),
         ($2::uuid, '9000091002', 'Clinical AI Doctor', 'DOCTOR', 'male', true, '00000000-0000-4000-8000-000000000001', NOW()),
         ($3::uuid, '9000091003', 'Clinical AI Admin', 'ADMIN', 'male', true, '00000000-0000-4000-8000-000000000001', NOW()),
         ($4::uuid, '9000091004', 'Clinical AI IT Admin', 'IT_ADMIN', 'female', true, '00000000-0000-4000-8000-000000000001', NOW())`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID, IT_UID
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
    await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE resource = 'clinical_ai' OR action LIKE 'CLINICAL_AI_%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_safety_reviews WHERE module_key LIKE '%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_approvals WHERE reason LIKE '%[test]%' OR payload::text LIKE '%[test]%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_prompts WHERE title LIKE '%[test]%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_break_glass_sessions WHERE reason LIKE '%[test]%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_context_snapshots WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM insurance_claims WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_voice_notes WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_longitudinal_risk WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_translations WHERE source_generation_id IN (SELECT id FROM clinical_ai_generations WHERE patient_uid = $1::uuid)`, PATIENT_UID).catch(() => {});
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
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`, PATIENT_UID, DOCTOR_UID, ADMIN_UID, IT_UID).catch(() => {});
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
    expect(generations.body.data.generations[0]).toHaveProperty('total_tokens');

    const status = await admin.get('/api/v1/admin/clinical-ai/status');
    expectStatus(status, 200, 'clinical AI status');
    expect(status.body.data.modules.some((module) => module.module_key === 'discharge_summary')).toBe(true);
    expect(status.body.data.usage.overall).toHaveProperty('total_tokens');
    expect(status.body.data.guardrails.enabled).toBe(true);
    expect(status.body.data.budget.token_budget).toHaveProperty('used');

    const itStatus = await itAdminClient.get('/api/v1/admin/clinical-ai/status');
    expectStatus(itStatus, 200, 'clinical AI status for IT admin');

    const doctorStatus = await doctor.get('/api/v1/admin/clinical-ai/status');
    expectStatus(doctorStatus, 403, 'clinical AI status denied for doctor');

    const nextRequestLimit = status.body.data.guardrails.request_token_limit === 1200 ? 1400 : 1200;
    const guardrails = await admin.patch('/api/v1/admin/clinical-ai/guardrails').send({
      external_ai_enabled: true,
      daily_token_limit: 1000000,
      request_token_limit: nextRequestLimit,
      fallback_rate_alert_pct: 80,
    });
    expectStatus(guardrails, 200, 'update clinical AI guardrails');
    expect(guardrails.body.data.guardrails.request_token_limit).toBe(nextRequestLimit);
    expect(guardrails.body.data.budget.tripped).toBe(false);

    const aftercareModule = status.body.data.modules.find((module) => module.module_key === 'patient_aftercare_instructions');
    const toggled = await admin.patch('/api/v1/admin/clinical-ai/modules/patient_aftercare_instructions').send({
      enabled: !aftercareModule.enabled,
    });
    expectStatus(toggled, 200, 'toggle clinical AI module');
    expect(toggled.body.data.enabled).toBe(!aftercareModule.enabled);

    const tenantModules = await admin.get('/api/v1/admin/clinical-ai/tenant-modules');
    expectStatus(tenantModules, 200, 'list tenant clinical AI modules');
    expect(tenantModules.body.data.modules.some((module) => module.module_key === 'denial_risk_assist')).toBe(true);

    const tenantOverride = await admin
      .patch('/api/v1/admin/clinical-ai/tenant-modules/denial_risk_assist')
      .send({
        enabled: true,
        provider_override: 'ollama',
        model_override: 'tenant-test-model',
        external_allowed: false,
        max_tokens: 1111,
      });
    expectStatus(tenantOverride, 200, 'update tenant clinical AI module');
    expect(tenantOverride.body.data.enabled).toBe(true);
    expect(tenantOverride.body.data.tenant_override_id).toBeTruthy();
    expect(tenantOverride.body.data.tenant_override_source).toBe('tenant');
    expect(tenantOverride.body.data.model_override).toBe('tenant-test-model');

    const tenantStatus = await admin.get('/api/v1/admin/clinical-ai/status');
    expectStatus(tenantStatus, 200, 'tenant clinical AI status');
    const denialModule = tenantStatus.body.data.modules.find((module) => module.module_key === 'denial_risk_assist');
    expect(denialModule.enabled).toBe(true);
    expect(denialModule.tenant_override_source).toBe('tenant');
    expect(denialModule.max_tokens).toBe(1111);

    const tenantReset = await admin.delete('/api/v1/admin/clinical-ai/tenant-modules/denial_risk_assist');
    expectStatus(tenantReset, 200, 'reset tenant clinical AI module');
    expect(tenantReset.body.data.tenant_override_id).toBeNull();
    expect(tenantReset.body.data.tenant_override_source).toBe('global');

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit');
    expectStatus(audit, 200, 'clinical AI audit logs');
    const auditActions = audit.body.data.logs.map((row) => row.action);
    expect(auditActions).toContain('CLINICAL_AI_GUARDRAILS_UPDATED');
    expect(auditActions).toContain('CLINICAL_AI_MODULE_UPDATED');
    expect(auditActions).toContain('CLINICAL_AI_TENANT_MODULE_UPDATED');
    expect(auditActions).toContain('CLINICAL_AI_TENANT_MODULE_RESET');
    const moduleAudit = audit.body.data.logs.find((row) => row.action === 'CLINICAL_AI_MODULE_UPDATED');
    expect(moduleAudit.metadata.changed_fields).toContain('enabled');
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

  async function enableModule(moduleKey) {
    const res = await admin.patch(`/api/v1/admin/clinical-ai/modules/${moduleKey}`).send({ enabled: true });
    expectStatus(res, 200, `enable module ${moduleKey}`);
    return res.body.data;
  }

  function expectDraftShape(draft, moduleKey) {
    expect(draft.module_key).toBe(moduleKey);
    expect(draft.prompt_version).toBeTruthy();
    expect(Array.isArray(draft.source_citations)).toBe(true);
    expect(Array.isArray(draft.safety_flags)).toBe(true);
    expect(draft.ai_metadata).toBeTruthy();
    expect(draft.ai_metadata).toHaveProperty('provider');
    expect(draft.ai_metadata).toHaveProperty('used_ai');
    expect(draft.generation_id).toBeTruthy();
    expect(['pending', 'accepted', 'rejected', 'needs_revision', 'edited']).toContain(draft.review_status);
  }

  it('generates admission AI drafts for the new modular surfaces and records review placeholders', async () => {
    for (const key of [
      'patient_record_summary',
      'patient_aftercare_instructions',
      'medication_reconciliation',
      'discharge_readiness',
      'referral_letter',
      'abnormal_result_triage',
      'clinical_coding_assist',
      'quality_case_review',
    ]) {
      await enableModule(key);
    }

    const record = await doctor.post(`/api/v1/emr/${admissionId}/ai/patient-record-summary`).send({});
    expectStatus(record, 200, 'patient record summary draft');
    expectDraftShape(record.body.data, 'patient_record_summary');
    expect(record.body.data.requires_signoff).toBe(true);

    const aftercare = await doctor.post(`/api/v1/emr/${admissionId}/aftercare-instructions`).send({});
    expectStatus(aftercare, 200, 'aftercare draft');
    expectDraftShape(aftercare.body.data, 'patient_aftercare_instructions');

    const medRec = await doctor.post(`/api/v1/emr/${admissionId}/medication-reconciliation`).send({});
    expectStatus(medRec, 200, 'medication reconciliation draft');
    expectDraftShape(medRec.body.data, 'medication_reconciliation');

    const readiness = await doctor.get(`/api/v1/emr/${admissionId}/discharge-readiness`);
    expectStatus(readiness, 200, 'discharge readiness draft');
    expectDraftShape(readiness.body.data, 'discharge_readiness');

    const referral = await doctor.post(`/api/v1/emr/${admissionId}/referral-letter`).send({});
    expectStatus(referral, 200, 'referral letter draft');
    expectDraftShape(referral.body.data, 'referral_letter');

    const triage = await doctor.post(`/api/v1/emr/${admissionId}/abnormal-result-triage`).send({});
    expectStatus(triage, 200, 'abnormal result triage draft');
    expectDraftShape(triage.body.data, 'abnormal_result_triage');

    const coding = await doctor.post(`/api/v1/emr/${admissionId}/clinical-coding-assist`).send({});
    expectStatus(coding, 200, 'clinical coding assist draft');
    expectDraftShape(coding.body.data, 'clinical_coding_assist');

    const quality = await doctor.post(`/api/v1/emr/${admissionId}/quality-case-review`).send({});
    expectStatus(quality, 200, 'quality case review draft');
    expectDraftShape(quality.body.data, 'quality_case_review');

    const reviews = await admin.get('/api/v1/admin/clinical-ai/reviews?module_key=patient_record_summary');
    expectStatus(reviews, 200, 'list reviews for patient_record_summary');
    expect(reviews.body.data.reviews.length).toBeGreaterThan(0);
    const targetReview = reviews.body.data.reviews.find((row) => row.generation_id === record.body.data.generation_id);
    expect(targetReview).toBeTruthy();
    expect(targetReview.decision).toBe('pending');

    const decisioned = await admin.patch(`/api/v1/admin/clinical-ai/reviews/${targetReview.id}`).send({
      decision: 'accepted',
      edited_draft: record.body.data.draft,
    });
    expectStatus(decisioned, 200, 'accept review');
    expect(decisioned.body.data.decision).toBe('accepted');
  });

  it('aggregates ward-round-brief and denial-risk drafts', async () => {
    await enableModule('daily_ward_round_brief');
    await enableModule('denial_risk_assist');

    const ward = await doctor.post('/api/v1/emr/ward-round-brief').send({ ward: 'WARD-A', limit: 5 });
    expectStatus(ward, 200, 'ward round brief');
    expectDraftShape(ward.body.data, 'daily_ward_round_brief');
    expect(ward.body.data.draft.ward).toBe('WARD-A');
    expect(Array.isArray(ward.body.data.draft.patients)).toBe(true);

    const claim = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_claims
         (claim_number, patient_uid, insurance_provider, policy_number, claim_amount, status, documents, submitted_at, created_at, updated_at)
       VALUES ($1, $2::uuid, 'VH Insurance [test]', 'POL-VH-[test]', 12000.00, 'submitted', '[]'::jsonb, NOW(), NOW(), NOW())
       RETURNING id, claim_number`,
      `CLM-TEST-${Date.now()}`,
      PATIENT_UID
    );
    const claimId = claim[0].id;

    const denial = await admin.post(`/api/v1/billing/${claimId}/denial-risk`).send({});
    expectStatus(denial, 200, 'denial risk draft');
    expectDraftShape(denial.body.data, 'denial_risk_assist');
    expect(denial.body.data.safety_flags.some((flag) => flag.code === 'DENIAL_RISK_GAP')).toBe(true);
  });

  it('computes an ABDM longitudinal risk score with contributors and recommendations', async () => {
    await enableModule('abdm_longitudinal_risk');

    // First call — compute + persist.
    const scored = await doctor.post(`/api/v1/emr/${admissionId}/longitudinal-risk`).send({});
    expectStatus(scored, 200, 'longitudinal risk score');
    const body = scored.body.data;
    expect(body.module_key).toBe('abdm_longitudinal_risk');
    expect(body.admission_id).toBe(admissionId);
    expect(typeof body.overall_score).toBe('number');
    expect(['low', 'medium', 'high', 'critical']).toContain(body.band);
    expect(body.contributors).toHaveProperty('adherence');
    expect(body.contributors).toHaveProperty('readmission');
    expect(body.contributors).toHaveProperty('comorbidity');
    expect(body.contributors.weights).toMatchObject({
      adherence: 0.4,
      readmission: 0.4,
      comorbidity: 0.2,
    });
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(body.decision_support_only).toBe(true);

    // GET returns the latest snapshot.
    const latest = await doctor.get(`/api/v1/emr/${admissionId}/longitudinal-risk`);
    expectStatus(latest, 200, 'latest risk snapshot');
    expect(latest.body.data.admission_id).toBe(admissionId);
    expect(['low', 'medium', 'high', 'critical']).toContain(latest.body.data.band);

    // Unknown admission → 404 surfaced.
    const missing = await doctor.post('/api/v1/emr/99999999/longitudinal-risk').send({});
    expectStatus(missing, 404, 'missing admission for risk scoring');

    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_longitudinal_risk WHERE admission_id = $1`,
      admissionId
    ).catch(() => {});
  });

  it('refuses to translate unreviewed drafts and produces a translation once accepted', async () => {
    await enableModule('patient_communication_translation');
    await enableModule('patient_aftercare_instructions');

    // Generate an aftercare draft we can translate.
    const aftercare = await doctor.post(`/api/v1/emr/${admissionId}/aftercare-instructions`).send({});
    expectStatus(aftercare, 200, 'aftercare draft');
    const generationId = aftercare.body.data.generation_id;

    // Refuse: generation still in 'draft' status.
    const refused = await doctor.post(`/api/v1/emr/generations/${generationId}/translate`).send({
      target_language: 'hi',
    });
    expectStatus(refused, 403, 'translate before acceptance');

    // Reviewer accepts the draft.
    const reviews = await admin.get(`/api/v1/admin/clinical-ai/reviews?module_key=patient_aftercare_instructions`);
    expectStatus(reviews, 200, 'list aftercare reviews');
    const review = reviews.body.data.reviews.find((row) => row.generation_id === generationId);
    expect(review).toBeTruthy();
    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/reviews/${review.id}`).send({
      decision: 'accepted',
      edited_draft: aftercare.body.data.draft,
    });
    expectStatus(accepted, 200, 'accept aftercare review');

    // Now translate — language must be supported; en is rejected.
    const enFails = await doctor.post(`/api/v1/emr/generations/${generationId}/translate`).send({
      target_language: 'en',
    });
    expectStatus(enFails, 400, 'en translation rejected');

    const translated = await doctor.post(`/api/v1/emr/generations/${generationId}/translate`).send({
      target_language: 'hi',
    });
    expectStatus(translated, 200, 'hindi translation');
    expect(translated.body.data.source_generation_id).toBe(generationId);
    expect(translated.body.data.target_language).toBe('hi');
    expect(['completed', 'needs_review']).toContain(translated.body.data.status);
    expect(Array.isArray(translated.body.data.fidelity_flags)).toBe(true);

    // Idempotent — re-requesting the same language returns the same row.
    const again = await doctor.post(`/api/v1/emr/generations/${generationId}/translate`).send({
      target_language: 'hi',
    });
    expectStatus(again, 200, 'hindi translation idempotent');
    expect(again.body.data.deduplicated).toBe(true);
    expect(again.body.data.translation_id).toBe(translated.body.data.translation_id);

    // List endpoint shows the translation.
    const list = await doctor.get('/api/v1/emr/translations?language=hi');
    expectStatus(list, 200, 'list translations');
    expect(list.body.data.translations.some((row) => row.id === translated.body.data.translation_id)).toBe(true);

    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_translations WHERE source_generation_id = $1`,
      generationId
    ).catch(() => {});
  });

  it('transcribes voice notes with mock STT and generates a SOAP draft into the review queue', async () => {
    const previousProvider = process.env.CLINICAL_AI_STT_PROVIDER;
    process.env.CLINICAL_AI_STT_PROVIDER = 'mock';

    try {
      // Enable the SOAP-from-dictation module as admin.
      const toggled = await admin.patch('/api/v1/admin/clinical-ai/modules/soap_from_dictation').send({
        enabled: true,
      });
      expectStatus(toggled, 200, 'enable soap_from_dictation');

      // Upload a tiny synthetic WAV buffer. Mock STT returns a canned transcript.
      const fakeWav = Buffer.from('RIFFmockWAVEfmt fakeaudio', 'ascii');
      const uploaded = await request(app)
        .post('/api/v1/clinical/voice-note/transcribe')
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${generateTestToken('DOCTOR', { uid: DOCTOR_UID, id: 7002 })}`)
        .field('patient_uid', PATIENT_UID)
        .field('admission_id', String(admissionId))
        .field('language', 'en-IN')
        .attach('audio', fakeWav, { filename: 'dictation.wav', contentType: 'audio/wav' });

      expectStatus(uploaded, 201, 'upload voice note');
      const voiceNoteId = uploaded.body.data.id;
      expect(uploaded.body.data.transcript_status).toBe('completed');
      expect(uploaded.body.data.stt_provider).toBe('mock');
      expect(String(uploaded.body.data.transcript || '')).toMatch(/mock transcript/i);

      // Generate SOAP draft from transcript.
      const generated = await doctor.post(`/api/v1/clinical/voice-note/${voiceNoteId}/generate-soap`).send({});
      expectStatus(generated, 200, 'generate SOAP from voice note');
      const draft = generated.body.data;
      expect(draft.module_key).toBe('soap_from_dictation');
      expect(draft.voice_note_id).toBe(voiceNoteId);
      expect(draft.draft).toHaveProperty('subjective');
      expect(draft.draft).toHaveProperty('plan');
      expect(draft.review_status).toMatch(/pending|failed/);
      expect(draft.source_citations.some((c) => c.source_type === 'clinical_voice_note')).toBe(true);

      // A pending review must exist in the queue for this generation.
      const reviews = await admin.get('/api/v1/admin/clinical-ai/reviews?module_key=soap_from_dictation');
      expectStatus(reviews, 200, 'list SOAP reviews');
      const found = reviews.body.data.reviews.find((row) => row.generation_id === draft.generation_id);
      expect(found).toBeTruthy();

      // Generating again must fail — idempotent per voice-note.
      const regenerated = await doctor.post(`/api/v1/clinical/voice-note/${voiceNoteId}/generate-soap`).send({});
      expectStatus(regenerated, 409, 'regenerate rejected');

      // Clean up so we don't leak rows across tests.
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_voice_notes WHERE id = $1`, voiceNoteId).catch(() => {});
    } finally {
      if (previousProvider === undefined) delete process.env.CLINICAL_AI_STT_PROVIDER;
      else process.env.CLINICAL_AI_STT_PROVIDER = previousProvider;
    }
  });

  it('isolates clinical AI review queue between tenants', async () => {
    const otherTenantId = 'c2222222-2222-4222-8222-222222222001';
    const otherPatientUid = 'c2222222-2222-4222-8222-222222222002';

    // Seed an isolated tenant + a draft review owned by that tenant.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile)
       VALUES ($1::uuid, 'isolation-test', 'Isolation Test Tenant', 'IN', 'DPDP')
       ON CONFLICT (id) DO NOTHING`,
      otherTenantId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, task_type, module_key, provider, model, prompt_version,
          source_hash, status, used_ai, safety_flags, citations, draft,
          prompt_tokens, completion_tokens, total_tokens, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'patient_record_summary', 'patient_record_summary', 'template',
               'seed', 'v1', 'isolation-hash', 'draft', false,
               '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
               0, 0, 0, '{}'::jsonb, NOW(), NOW())`,
      otherTenantId,
      otherPatientUid
    );
    const genRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_ai_generations
       WHERE tenant_id = $1::uuid AND source_hash = 'isolation-hash'`,
      otherTenantId
    );
    const otherGenerationId = genRows[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, 'patient_record_summary', $3::uuid, 'pending', '{}'::jsonb, NOW(), NOW())`,
      otherTenantId,
      otherGenerationId,
      otherPatientUid
    );

    const reviews = await admin.get('/api/v1/admin/clinical-ai/reviews?decision=pending&module_key=patient_record_summary');
    expectStatus(reviews, 200, 'list reviews (default tenant)');
    const defaultTenantIds = reviews.body.data.reviews.map((row) => row.generation_id);
    expect(defaultTenantIds.includes(otherGenerationId)).toBe(false);

    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_reviews WHERE tenant_id = $1::uuid`,
      otherTenantId
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_generations WHERE tenant_id = $1::uuid`,
      otherTenantId
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      otherTenantId
    ).catch(() => {});
  });

  it('supports prompt activation approval, two-person rejection of self-approval, and break-glass lifecycle', async () => {
    const created = await admin.post('/api/v1/admin/clinical-ai/prompts').send({
      module_key: 'patient_record_summary',
      version: `vtest-${Date.now()}`,
      title: 'Patient record summary [test] prompt',
      system_prompt: 'Test-only system prompt.',
      user_prompt_template: 'Test-only user prompt template [test].',
      output_schema: { type: 'object' },
    });
    expectStatus(created, 201, 'create prompt');
    const promptId = created.body.data.id;

    const firstActivate = await admin.patch(`/api/v1/admin/clinical-ai/prompts/${promptId}/activate`).send({});
    expectStatus(firstActivate, 202, 'activate requires approval');
    expect(firstActivate.body.data.approval_required).toBe(true);
    const approvalId = firstActivate.body.data.approval.id;

    const selfApprove = await admin.patch(`/api/v1/admin/clinical-ai/approvals/${approvalId}`).send({
      decision: 'approved',
      reason: 'Self-approval attempt [test]',
    });
    expectStatus(selfApprove, 403, 'self-approval is rejected');

    const otherApprove = await itAdminClient.patch(`/api/v1/admin/clinical-ai/approvals/${approvalId}`).send({
      decision: 'approved',
      reason: 'Second-admin approval [test]',
    });
    expectStatus(otherApprove, 200, 'two-person approval succeeds');
    expect(otherApprove.body.data.status).toBe('approved');

    const activated = await admin.patch(`/api/v1/admin/clinical-ai/prompts/${promptId}/activate`).send({
      approval_id: approvalId,
    });
    expectStatus(activated, 200, 'activate with approval');
    expect(activated.body.data.prompt.active).toBe(true);

    const promptsList = await admin.get('/api/v1/admin/clinical-ai/prompts?module_key=patient_record_summary');
    expectStatus(promptsList, 200, 'list prompts');
    const activeTestPrompt = promptsList.body.data.prompts.find((p) => p.id === promptId);
    expect(activeTestPrompt?.active).toBe(true);

    const glass = await admin.post('/api/v1/admin/clinical-ai/break-glass').send({
      scope: 'clinical_ai',
      reason: 'Emergency governance override [test]',
      expires_in_hours: 1,
    });
    expectStatus(glass, 201, 'start break-glass');
    const sessionId = glass.body.data.id;

    const active = await admin.get('/api/v1/admin/clinical-ai/break-glass');
    expectStatus(active, 200, 'list active break-glass');
    expect(active.body.data.sessions.some((row) => row.id === sessionId)).toBe(true);

    const ended = await admin.patch(`/api/v1/admin/clinical-ai/break-glass/${sessionId}/end`).send({});
    expectStatus(ended, 200, 'end break-glass');
    expect(ended.body.data.status).toBe('ended');

    const afterEnd = await admin.get('/api/v1/admin/clinical-ai/break-glass');
    expectStatus(afterEnd, 200, 'list break-glass after end');
    expect(afterEnd.body.data.sessions.some((row) => row.id === sessionId)).toBe(false);
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
