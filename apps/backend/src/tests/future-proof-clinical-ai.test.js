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
      `INSERT INTO users (uid, phone, name, role, gender, is_active, updated_at)
       VALUES
         ($1::uuid, '9000091001', 'Clinical AI Patient', 'PATIENT', 'female', true, NOW()),
         ($2::uuid, '9000091002', 'Clinical AI Doctor', 'DOCTOR', 'male', true, NOW()),
         ($3::uuid, '9000091003', 'Clinical AI Admin', 'ADMIN', 'male', true, NOW()),
         ($4::uuid, '9000091004', 'Clinical AI IT Admin', 'IT_ADMIN', 'female', true, NOW())`,
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

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit');
    expectStatus(audit, 200, 'clinical AI audit logs');
    const auditActions = audit.body.data.logs.map((row) => row.action);
    expect(auditActions).toContain('CLINICAL_AI_GUARDRAILS_UPDATED');
    expect(auditActions).toContain('CLINICAL_AI_MODULE_UPDATED');
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
