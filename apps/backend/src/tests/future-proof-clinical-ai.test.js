import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'c1111111-1111-4111-8111-111111111a01';
const DOCTOR_UID = 'c1111111-1111-4111-8111-111111111a02';
const ADMIN_UID = 'c1111111-1111-4111-8111-111111111a03';
const ENCOUNTER_ID = 'c1111111-1111-4111-8111-111111111a04';
const IT_UID = 'c1111111-1111-4111-8111-111111111a05';
const CULTURE_INVESTIGATION_UID = 'c1111111-1111-4111-8111-111111111a06';

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
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_document_intake WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_antimicrobial_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_teach_back_sessions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_appeal_letters WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_task_candidates WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
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
      `INSERT INTO investigations
         (uid, patient_uid, phone, test_name, status, priority, result_summary,
          requested_by, requested_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, '9000091001', 'Blood culture', 'PENDING', 'URGENT',
               'Report pending', $3::uuid, NOW() - INTERVAL '3 hours',
               NOW() - INTERVAL '3 hours', NOW())`,
      CULTURE_INVESTIGATION_UID, PATIENT_UID, DOCTOR_UID
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
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_document_intake WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_antimicrobial_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_teach_back_sessions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_appeal_letters WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_task_candidates WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
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
    expect(status.body.data.adapters.some((adapter) => adapter.key === 'prior_auth_payer')).toBe(true);

    const safetyReviews = await admin.get('/api/v1/admin/clinical-ai/safety-reviews/summary');
    expectStatus(safetyReviews, 200, 'clinical AI safety review summary');
    expect(safetyReviews.body.data.overall).toHaveProperty('review_count');
    expect(Array.isArray(safetyReviews.body.data.by_module)).toBe(true);
    expect(Array.isArray(safetyReviews.body.data.recent_findings)).toBe(true);

    const governanceReport = await admin.get('/api/v1/admin/clinical-ai/governance-report?days=30');
    expectStatus(governanceReport, 200, 'clinical AI governance report');
    expect(governanceReport.body.data.report_version).toBe('clinical-ai-governance-v1');
    expect(governanceReport.body.data.summary).toHaveProperty('module_count');
    expect(governanceReport.body.data.summary).toHaveProperty('adapter_configured_count');
    expect(governanceReport.body.data.runtime.adapters.some((adapter) => adapter.key === 'prior_auth_payer')).toBe(true);
    expect(Array.isArray(governanceReport.body.data.modules.all)).toBe(true);
    expect(governanceReport.body.data.prompts).toHaveProperty('count');
    expect(governanceReport.body.data.audit.summary).toHaveProperty('total');
    expect(governanceReport.body.data.data_boundaries.decision_support_only).toBe(true);

    const itStatus = await itAdminClient.get('/api/v1/admin/clinical-ai/status');
    expectStatus(itStatus, 200, 'clinical AI status for IT admin');

    const doctorStatus = await doctor.get('/api/v1/admin/clinical-ai/status');
    expectStatus(doctorStatus, 403, 'clinical AI status denied for doctor');

    const doctorReport = await doctor.get('/api/v1/admin/clinical-ai/governance-report');
    expectStatus(doctorReport, 403, 'clinical AI governance report denied for doctor');

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

    const tenantOverrideCleared = await admin
      .patch('/api/v1/admin/clinical-ai/tenant-modules/denial_risk_assist')
      .send({
        provider_override: null,
        model_override: null,
        external_allowed: null,
        max_tokens: null,
        temperature: null,
      });
    expectStatus(tenantOverrideCleared, 200, 'clear tenant clinical AI module overrides');
    expect(tenantOverrideCleared.body.data.tenant_override_id).toBeTruthy();
    expect(tenantOverrideCleared.body.data.tenant_overrides.provider_override).toBeNull();
    expect(tenantOverrideCleared.body.data.tenant_overrides.model_override).toBeNull();
    expect(tenantOverrideCleared.body.data.tenant_overrides.external_allowed).toBeNull();

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
    expect(auditActions).toContain('CLINICAL_AI_GOVERNANCE_REPORT_EXPORTED');
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

  it('supports admin-only native document upload OCR intake and review', async () => {
    await enableModule('document_intelligence_ocr');

    const textFile = Buffer.from(`
      Patient Name: Clinical AI Patient
      MRN: VH-OCR-001
      Diagnosis: Community acquired pneumonia
      Tab Azithromycin 500 mg OD for 3 days
      CBC: WBC 14000, Hb 12 g
      Follow-up after 7 days
    `, 'utf8');

    const denied = await doctor
      .post('/api/v1/admin/clinical-ai/documents/intake/upload')
      .field('source_type', 'external_discharge_summary')
      .attach('file', textFile, { filename: 'outside-discharge.txt', contentType: 'text/plain' });
    expectStatus(denied, 403, 'doctor denied document OCR upload');

    const uploaded = await admin
      .post('/api/v1/admin/clinical-ai/documents/intake/upload')
      .field('patient_uid', PATIENT_UID)
      .field('admission_id', String(admissionId))
      .field('source_type', 'external_discharge_summary')
      .field('title', 'Outside discharge summary [test]')
      .attach('file', textFile, { filename: 'outside-discharge.txt', contentType: 'text/plain' });
    expectStatus(uploaded, 201, 'admin document OCR upload');
    expect(uploaded.body.data.module_key).toBe('document_intelligence_ocr');
    expect(uploaded.body.data.extraction_status).toBe('completed');
    expect(uploaded.body.data.ocr.provider).toBe('native_text');
    expect(uploaded.body.data.ocr.text_char_count).toBeGreaterThan(50);
    expect(uploaded.body.data.source_citations.length).toBeGreaterThan(0);
    expect(uploaded.body.data.intake.extracted_fields.medications[0].text).toMatch(/Azithromycin/i);
    expect(uploaded.body.data.intake.metadata.ocr_status).toBe('completed');

    const intakeId = uploaded.body.data.intake_id;
    const listed = await admin.get('/api/v1/admin/clinical-ai/documents/intake?decision=pending&source_type=external_discharge_summary');
    expectStatus(listed, 200, 'list document OCR intakes');
    expect(listed.body.data.documents.some((row) => row.id === intakeId && row.metadata.ocr_provider === 'native_text')).toBe(true);

    const reviewed = await admin.patch(`/api/v1/admin/clinical-ai/documents/intake/${intakeId}`).send({
      decision: 'accepted',
      note: 'Test OCR review accepted',
    });
    expectStatus(reviewed, 200, 'accept document OCR intake');
    expect(reviewed.body.data.reviewer_decision).toBe('accepted');

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit');
    expectStatus(audit, 200, 'document OCR audit logs');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_DOCUMENT_INTELLIGENCE_FILE_UPLOADED');
    expect(actions).toContain('CLINICAL_AI_DOCUMENT_INTELLIGENCE_REVIEWED');
  });

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

    const safetyReviews = await admin.get('/api/v1/admin/clinical-ai/safety-reviews/summary');
    expectStatus(safetyReviews, 200, 'clinical AI safety review summary with modular draft');
    expect(safetyReviews.body.data.overall.review_count).toBeGreaterThan(0);
    expect(safetyReviews.body.data.by_module.some((row) => row.module_key === 'patient_record_summary')).toBe(true);

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

  it('extracts clinical task candidates into an auditable review queue', async () => {
    await enableModule('clinical_task_extractor');

    const denied = await doctor.get('/api/v1/admin/clinical-ai/tasks');
    expectStatus(denied, 403, 'clinical task queue denied for doctor');

    const extracted = await admin.post('/api/v1/admin/clinical-ai/tasks/extract').send({
      admission_id: admissionId,
    });
    expectStatus(extracted, 201, 'clinical task extraction');
    const body = extracted.body.data;
    expect(body.module_key).toBe('clinical_task_extractor');
    expect(body.no_auto_assign).toBe(true);
    expect(body.requires_signoff).toBe(true);
    expect(body.generation_id).toBeTruthy();
    expect(Array.isArray(body.safety_flags)).toBe(true);
    expect(Array.isArray(body.source_citations)).toBe(true);
    expect(body.tasks.length).toBeGreaterThan(0);
    expect(body.tasks[0].reviewer_decision).toBe('pending');
    expect(body.tasks[0].source_citations.length).toBeGreaterThan(0);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/tasks?decision=pending&admission_id=${admissionId}`);
    expectStatus(listed, 200, 'list clinical task candidates');
    expect(listed.body.data.tasks.length).toBeGreaterThan(0);

    const taskId = listed.body.data.tasks[0].id;
    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/tasks/${taskId}`).send({
      decision: 'accepted',
      note: 'Reviewed by admin [test]',
    });
    expectStatus(accepted, 200, 'accept clinical task candidate');
    expect(accepted.body.data.reviewer_decision).toBe('accepted');

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=100');
    expectStatus(audit, 200, 'clinical task audit logs');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_TASKS_EXTRACTED');
    expect(actions).toContain('CLINICAL_AI_TASK_REVIEWED');
  });

  it('generates antimicrobial stewardship reviews into an auditable queue', async () => {
    await enableModule('antimicrobial_stewardship');

    const denied = await doctor.get('/api/v1/admin/clinical-ai/antimicrobial-stewardship/reviews');
    expectStatus(denied, 403, 'antimicrobial stewardship queue denied for doctor');

    const generated = await admin.post('/api/v1/admin/clinical-ai/antimicrobial-stewardship/reviews').send({
      admission_id: admissionId,
    });
    expectStatus(generated, 201, 'antimicrobial stewardship review');
    const body = generated.body.data;
    expect(body.module_key).toBe('antimicrobial_stewardship');
    expect(body.requires_signoff).toBe(true);
    expect(body.rules_authoritative).toBe(true);
    expect(body.generation_id).toBeTruthy();
    expect(body.review_id).toBeTruthy();
    expect(typeof body.draft.stewardship_score).toBe('number');
    expect(['low', 'medium', 'high', 'critical']).toContain(body.draft.risk_band);
    expect(Array.isArray(body.draft.antibiotic_summary)).toBe(true);
    expect(Array.isArray(body.draft.culture_summary)).toBe(true);
    expect(Array.isArray(body.draft.flags)).toBe(true);
    expect(body.draft.flags.map((flag) => flag.code)).toContain('PENDING_CULTURE_REVIEW');
    expect(Array.isArray(body.source_citations)).toBe(true);
    expect(body.source_citations.length).toBeGreaterThan(0);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/antimicrobial-stewardship/reviews?decision=pending&admission_id=${admissionId}`);
    expectStatus(listed, 200, 'list antimicrobial stewardship reviews');
    expect(listed.body.data.reviews.length).toBeGreaterThan(0);

    const reviewId = listed.body.data.reviews[0].id;
    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/antimicrobial-stewardship/reviews/${reviewId}`).send({
      decision: 'accepted',
      note: 'Reviewed by admin [test]',
    });
    expectStatus(accepted, 200, 'accept antimicrobial stewardship review');
    expect(accepted.body.data.reviewer_decision).toBe('accepted');

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=120');
    expectStatus(audit, 200, 'antimicrobial stewardship audit logs');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_ANTIMICROBIAL_STEWARDSHIP_REVIEW_GENERATED');
    expect(actions).toContain('CLINICAL_AI_ANTIMICROBIAL_STEWARDSHIP_REVIEWED');
  });

  it('generates a patient teach-back comprehension session and records answers', async () => {
    await enableModule('patient_teach_back_comprehension');

    const patientDenied = await patient.get('/api/v1/admin/clinical-ai/teach-back/sessions');
    expectStatus(patientDenied, 403, 'patient denied admin teach-back queue');

    const generated = await admin.post('/api/v1/admin/clinical-ai/teach-back/sessions').send({
      admission_id: admissionId,
      language: 'en',
    });
    expectStatus(generated, 201, 'admin generates teach-back session');
    const sessionBody = generated.body.data;
    expect(sessionBody.module_key).toBe('patient_teach_back_comprehension');
    expect(sessionBody.requires_signoff).toBe(true);
    expect(sessionBody.rules_authoritative).toBe(true);
    expect(sessionBody.session_id).toBeTruthy();
    expect(sessionBody.generation_id).toBeTruthy();
    expect(sessionBody.language).toBe('en');
    expect(Array.isArray(sessionBody.draft.questions)).toBe(true);
    expect(sessionBody.draft.questions.length).toBeGreaterThan(0);
    expect(sessionBody.draft.questions.every((q) => q.id && q.prompt && q.category)).toBe(true);
    const categories = new Set(sessionBody.draft.questions.map((q) => q.category));
    expect(categories.has('emergency_escalation')).toBe(true);
    expect(Array.isArray(sessionBody.source_citations)).toBe(true);
    expect(Array.isArray(sessionBody.safety_flags)).toBe(true);

    const clinicalGenerated = await doctor.post(`/api/v1/emr/${admissionId}/ai/teach-back`).send({ language: 'hi' });
    expectStatus(clinicalGenerated, 201, 'doctor generates teach-back via EMR route');
    expect(clinicalGenerated.body.data.language).toBe('hi');
    expect(clinicalGenerated.body.data.session_id).toBeTruthy();

    const adminListed = await admin.get(`/api/v1/admin/clinical-ai/teach-back/sessions?admission_id=${admissionId}`);
    expectStatus(adminListed, 200, 'admin list teach-back sessions');
    expect(adminListed.body.data.sessions.length).toBeGreaterThan(0);

    const sessionId = sessionBody.session_id;
    const uncertainAnswers = sessionBody.draft.questions.map((q) => ({
      question_id: q.id,
      answer: "I don't know",
    }));
    const answered = await doctor
      .post(`/api/v1/emr/teach-back/${sessionId}/answers`)
      .send({ answers: uncertainAnswers });
    expectStatus(answered, 200, 'submit uncertain answers via EMR route');
    expect(answered.body.data.status).toBe('needs_clinician_review');
    expect(Array.isArray(answered.body.data.misunderstanding_flags)).toBe(true);
    expect(answered.body.data.misunderstanding_flags.length).toBeGreaterThan(0);
    expect(answered.body.data.comprehension_score).toBe(0);

    const correctAnswers = sessionBody.draft.questions.map((q) => {
      if (q.category === 'emergency_escalation') return { question_id: q.id, answer: '108 ambulance' };
      return { question_id: q.id, answer: q.expected || 'yes' };
    });
    const correctSubmission = await admin
      .post(`/api/v1/admin/clinical-ai/teach-back/sessions/${sessionId}/answers`)
      .send({ answers: correctAnswers });
    expectStatus(correctSubmission, 200, 'admin resubmits correct answers');
    expect(correctSubmission.body.data.comprehension_score).toBeGreaterThan(0);

    const decided = await admin.patch(`/api/v1/admin/clinical-ai/teach-back/sessions/${sessionId}`).send({
      decision: 'accepted',
      note: 'Reviewed by admin [test]',
    });
    expectStatus(decided, 200, 'accept teach-back session');
    expect(decided.body.data.reviewer_decision).toBe('accepted');

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=200');
    expectStatus(audit, 200, 'teach-back audit logs');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_TEACH_BACK_SESSION_GENERATED');
    expect(actions).toContain('CLINICAL_AI_TEACH_BACK_ANSWERS_SUBMITTED');
    expect(actions).toContain('CLINICAL_AI_TEACH_BACK_REVIEWED');
  });

  it('blocks teach-back generation when module is disabled', async () => {
    await admin.patch('/api/v1/admin/clinical-ai/modules/patient_teach_back_comprehension').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/teach-back/sessions').send({
      admission_id: admissionId,
      language: 'en',
    });
    expect(blocked.statusCode).toBe(403);
    const blockedClinical = await doctor.post(`/api/v1/emr/${admissionId}/ai/teach-back`).send({ language: 'en' });
    expect(blockedClinical.statusCode).toBe(403);
  });

  it('drafts, reviews, submits, and records payer response for an appeal letter', async () => {
    await enableModule('appeal_letter_generator');

    const claim = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_claims
         (claim_number, patient_uid, insurance_provider, policy_number, claim_amount,
          status, rejection_reason, documents, submitted_at, created_at, updated_at)
       VALUES ($1, $2::uuid, 'Acme Health [test]', 'POL-APPEAL-[test]', 15800.00,
               'denied', 'Services not medically necessary per plan guidelines',
               '[]'::jsonb, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days', NOW())
       RETURNING id, claim_number`,
      `CLM-APPEAL-TEST-${Date.now()}`,
      PATIENT_UID
    );
    const claimId = claim[0].id;

    const denied = await doctor.get('/api/v1/admin/clinical-ai/appeal-letters');
    expectStatus(denied, 403, 'appeal queue denied for doctor');

    const generated = await admin.post('/api/v1/admin/clinical-ai/appeal-letters').send({
      claim_id: claimId,
      admission_id: admissionId,
      denial_reason: 'Not medically necessary — bronchoscopy disallowed',
      denial_code: 'MN-01',
      appeal_type: 'first_level',
    });
    expectStatus(generated, 201, 'appeal letter drafted');
    const body = generated.body.data;
    expect(body.module_key).toBe('appeal_letter_generator');
    expect(body.appeal_id).toBeTruthy();
    expect(body.generation_id).toBeTruthy();
    expect(body.classification.classification).toBe('medical_necessity');
    expect(body.draft.cover_letter).toContain('Acme Health');
    expect(body.draft.medical_necessity.length).toBeGreaterThan(30);
    expect(body.draft.appeal_type).toBe('first_level');
    expect(Array.isArray(body.source_citations)).toBe(true);
    expect(body.source_citations.length).toBeGreaterThan(0);
    expect(body.appeal_status).toBe('draft');
    expect(body.rules_authoritative).toBe(true);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/appeal-letters?claim_id=${claimId}`);
    expectStatus(listed, 200, 'list appeal letters');
    expect(listed.body.data.appeals.length).toBeGreaterThan(0);

    const appealId = body.appeal_id;

    const premature = await admin.post(`/api/v1/admin/clinical-ai/appeal-letters/${appealId}/submit`).send({});
    expect(premature.statusCode).toBeGreaterThanOrEqual(400);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/appeal-letters/${appealId}`).send({
      decision: 'accepted',
      note: 'Reviewed by admin [test]',
    });
    expectStatus(accepted, 200, 'accept appeal review');
    expect(accepted.body.data.reviewer_decision).toBe('accepted');
    expect(accepted.body.data.appeal_status).toBe('ready_for_submission');

    const submitted = await admin.post(`/api/v1/admin/clinical-ai/appeal-letters/${appealId}/submit`).send({
      payer_reference_id: 'PAYER-REF-TEST-1',
    });
    expectStatus(submitted, 200, 'submit appeal to payer');
    expect(submitted.body.data.appeal_status).toBe('submitted');
    expect(submitted.body.data.payer_reference_id).toBe('PAYER-REF-TEST-1');

    const payerApproval = await admin
      .post(`/api/v1/admin/clinical-ai/appeal-letters/${appealId}/payer-response`)
      .send({ status: 'approved', response: { amount: 15800 } });
    expectStatus(payerApproval, 200, 'record payer approval');
    expect(payerApproval.body.data.appeal_status).toBe('approved');

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=250');
    expectStatus(audit, 200, 'appeal audit logs');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_APPEAL_LETTER_GENERATED');
    expect(actions).toContain('CLINICAL_AI_APPEAL_LETTER_REVIEWED');
    expect(actions).toContain('CLINICAL_AI_APPEAL_LETTER_SUBMITTED');
    expect(actions).toContain('CLINICAL_AI_APPEAL_LETTER_PAYER_RESPONSE');
  });

  it('blocks appeal letter generation when module is disabled', async () => {
    await admin.patch('/api/v1/admin/clinical-ai/modules/appeal_letter_generator').send({ enabled: false });
    const claim = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_claims
         (claim_number, patient_uid, insurance_provider, policy_number, claim_amount,
          status, rejection_reason, documents, submitted_at, created_at, updated_at)
       VALUES ($1, $2::uuid, 'Acme Health [test]', 'POL-DIS-[test]', 1000.00,
               'denied', 'Prior auth missing', '[]'::jsonb, NOW(), NOW(), NOW())
       RETURNING id`,
      `CLM-DIS-${Date.now()}`,
      PATIENT_UID
    );
    const blocked = await admin.post('/api/v1/admin/clinical-ai/appeal-letters').send({
      claim_id: claim[0].id,
      appeal_type: 'first_level',
    });
    expect(blocked.statusCode).toBe(403);
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
