import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { recordTimelineEvent } from '../services/clinical/canonicalClinicalPlatformService.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'c1111111-1111-4111-8111-111111111a01';
const DOCTOR_UID = 'c1111111-1111-4111-8111-111111111a02';
const ADMIN_UID = 'c1111111-1111-4111-8111-111111111a03';
const ENCOUNTER_ID = 'c1111111-1111-4111-8111-111111111a04';
const IT_UID = 'c1111111-1111-4111-8111-111111111a05';
const CULTURE_INVESTIGATION_UID = 'c1111111-1111-4111-8111-111111111a06';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const LONG_CLINICAL_AI_TEST_TIMEOUT_MS = 60000;
const DEFAULT_EVAL_MODEL = 'llama3.1:8b';
const acceptedEvalSeeds = new Set();

jest.setTimeout(LONG_CLINICAL_AI_TEST_TIMEOUT_MS);

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

function normalizeEvalProvider(value) {
  const provider = String(value || 'template').toLowerCase().trim();
  const aliases = {
    local: 'ollama',
    'llama-local': 'ollama',
    llama: 'ollama',
    openai_compatible: 'openai-compatible',
    openai_compat: 'openai-compatible',
    compatible: 'openai-compatible',
    chatgpt: 'openai',
    claude: 'anthropic',
  };
  return aliases[provider] || provider;
}

function evalGateProviderModel(data = {}) {
  return {
    provider: normalizeEvalProvider(data.provider_override || process.env.CLINICAL_AI_PROVIDER || process.env.AI_PROVIDER || 'template'),
    model: String(data.model_override || process.env.CLINICAL_AI_MODEL || process.env.AI_SUMMARIZE_MODEL || DEFAULT_EVAL_MODEL).trim(),
  };
}

async function seedAcceptedEvalGate(moduleKey, data = {}) {
  const { provider, model } = evalGateProviderModel(data);
  const seedKey = `${moduleKey}:${provider}:${model}`;
  if (acceptedEvalSeeds.has(seedKey)) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_ai_model_eval_runs
       (tenant_id, model_key, version, suite, sample_count, pass_count, fail_count,
        accuracy, f1_score, avg_latency_ms, fallback_rate_pct, safety_flag_rate_pct,
        drift_score, recommendation, severity, signals, summary, recommended_actions,
        source_citations, safety_flags, reviewer_decision, reviewed_by, reviewed_at,
        metadata, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, 'test-governance-gate', 10, 10, 0,
             1.0, 1.0, 100, 0, 0,
             0, 'no_action', 'low', '[]'::jsonb, $4, '[]'::jsonb,
             '[]'::jsonb, '[]'::jsonb, 'accepted', $5::uuid, NOW(),
             $6::jsonb, NOW(), NOW())`,
    TENANT_ID,
    moduleKey,
    model,
    `Accepted eval gate seed for ${moduleKey} [test]`,
    IT_UID,
    JSON.stringify({
      module_key: moduleKey,
      provider,
      model,
      test_seed: true,
    })
  );
  acceptedEvalSeeds.add(seedKey);
}

describe('future-proof clinical AI and privacy foundations', () => {
  let admissionId;
  let consentReference;
  const doctor = authed('DOCTOR', DOCTOR_UID);
  const admin = authed('ADMIN', ADMIN_UID);
  const itAdminClient = authed('IT_ADMIN', IT_UID);
  const patient = authed('PATIENT', PATIENT_UID);

  async function approveIfRequired(response, retryWithApproval, label) {
    if (response.statusCode !== 202) {
      expectStatus(response, 200, label);
      return response;
    }

    expect(response.body.data.approval_required).toBe(true);
    const approvalId = response.body.data.approval?.id;
    expect(approvalId).toBeTruthy();

    const approved = await itAdminClient
      .patch(`/api/v1/admin/clinical-ai/approvals/${approvalId}`)
      .send({ decision: 'approved', reason: `${label} approved by second test approver` });
    expectStatus(approved, 200, `${label} approval decision`);

    const retried = await retryWithApproval(approvalId);
    expectStatus(retried, 200, label);
    return retried;
  }

  async function patchGlobalModule(moduleKey, data, label) {
    await seedAcceptedEvalGate(moduleKey, data);
    const first = await admin.patch(`/api/v1/admin/clinical-ai/modules/${moduleKey}`).send(data);
    return approveIfRequired(
      first,
      (approvalId) => admin
        .patch(`/api/v1/admin/clinical-ai/modules/${moduleKey}`)
        .send({ ...data, approval_id: approvalId }),
      label
    );
  }

  async function patchTenantModule(moduleKey, data, label) {
    await seedAcceptedEvalGate(moduleKey, data);
    const first = await admin.patch(`/api/v1/admin/clinical-ai/tenant-modules/${moduleKey}`).send(data);
    return approveIfRequired(
      first,
      (approvalId) => admin
        .patch(`/api/v1/admin/clinical-ai/tenant-modules/${moduleKey}`)
        .send({ ...data, approval_id: approvalId }),
      label
    );
  }

  beforeAll(async () => {
    acceptedEvalSeeds.clear();
    await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE resource = 'clinical_ai' OR action LIKE 'CLINICAL_AI_%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_document_intake WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_antimicrobial_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_teach_back_sessions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_appeal_letters WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_roi_snapshots WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_nursing_ambient_sessions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_family_updates WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_payer_variance_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_payer_contracts WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND payer_name LIKE '%[test]%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_lab_autoverifications WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_pediatric_dose_checks WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_staff_burnout_reviews WHERE staff_uid IN ($1::uuid, $2::uuid)`, DOCTOR_UID, IT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_ed_triage_predictions WHERE patient_uid = $1::uuid OR admission_id IS NOT NULL`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_ventilator_bundle_audits WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_blood_bank_forecast_reviews WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_blood_bank_inventory_snapshots WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_obstetric_risk_assessments WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_bed_turnover_predictions WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_biomed_maintenance_predictions WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_biomed_devices WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND device_code LIKE 'TEST-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_security_anomalies WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_pgx_advisories WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_patient_genotypes WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_radiology_report_reviews WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_radiology_worklist_priorities WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_ot_block_suggestions WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_inventory_alerts WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_synthetic_cases WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_training_modules WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_model_eval_runs WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_model_registry WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND model_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_procurement_opportunities WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_explainability_reports WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_agent_health_reports WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_agent_registry WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND agent_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_command_center_snapshots WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_labeling_annotations WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_labeling_tasks WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND dataset_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_policy_diffs WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND policy_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_patient_timeline_snapshots WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_pathway_bundle_audits WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_kg_health_reports WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_kg_edges WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_kg_nodes WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND source = 'test'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_acuity_staffing_forecasts WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_federation_rounds WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_federation_sites WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND site_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_voice_ivr_sessions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_task_candidates WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_safety_reviews WHERE module_key LIKE '%'`).catch(() => {});
    // Drop any leftover per-tenant module overrides for the test tenant. A stale
    // `clinical_ai_tenant_modules` row with `enabled = false` shadows the global
    // enable that `enableModule()` performs, so the module-draft routes would 403
    // ("module is disabled") even though the global module is on. The tenant-override
    // sub-test (denial_risk_assist) creates and resets its own row, so wiping this
    // table keeps the suite self-contained and deterministic across QA-DB reuse.
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_tenant_modules WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
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

    const consentRows = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_consents
         (patient_uid, consent_type, granted, status, granted_at, granted_by)
       VALUES ($1::uuid, 'treatment', true, 'active', NOW(), 'patient')
       RETURNING id`,
      PATIENT_UID
    );
    consentReference = String(consentRows[0].id);

    // Audit 2026-06-18 §3 finding #3: the FHIR $everything export (exercised
    // below) now requires an active data_sharing consent (requireConsent gate in
    // fhirRoutes.js). Grant it alongside the treatment consent.
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents
         (patient_uid, consent_type, granted, status, granted_at, granted_by)
       VALUES ($1::uuid, 'data_sharing', true, 'active', NOW(), 'patient')`,
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
    await recordTimelineEvent({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      encounterId: ENCOUNTER_ID,
      eventType: 'note.created',
      eventSubtype: 'progress',
      eventStatus: 'active',
      sourceTable: 'clinical_notes',
      sourceId: 'future-proof-progress-note',
      resourceType: 'clinical_notes',
      resourceId: 'future-proof-progress-note',
      actorUid: DOCTOR_UID,
      actorRole: 'DOCTOR',
      occurredAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      summary: 'Improving fever and cough after IV antibiotics.',
      payload: {
        title: 'Clinical progress note',
        summary: 'Improving fever and cough after IV antibiotics.',
        current_status: 'Stable',
        plan: 'Continue antibiotics and monitor oxygen.',
      },
      tags: ['test', 'clinical_note'],
      idempotencyKey: `test:${PATIENT_UID}:future-proof-progress-note`,
    });

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
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_document_intake WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_antimicrobial_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_teach_back_sessions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_appeal_letters WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_roi_snapshots WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_nursing_ambient_sessions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_family_updates WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_payer_variance_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_payer_contracts WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND payer_name LIKE '%[test]%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_lab_autoverifications WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_pediatric_dose_checks WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_staff_burnout_reviews WHERE staff_uid IN ($1::uuid, $2::uuid)`, DOCTOR_UID, IT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_ed_triage_predictions WHERE patient_uid = $1::uuid OR admission_id IS NOT NULL`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_ventilator_bundle_audits WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_blood_bank_forecast_reviews WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_blood_bank_inventory_snapshots WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_obstetric_risk_assessments WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_bed_turnover_predictions WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_biomed_maintenance_predictions WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_biomed_devices WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND device_code LIKE 'TEST-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_security_anomalies WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_pgx_advisories WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_patient_genotypes WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_radiology_report_reviews WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_radiology_worklist_priorities WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_ot_block_suggestions WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_inventory_alerts WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_synthetic_cases WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_training_modules WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_model_eval_runs WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_model_registry WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND model_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_procurement_opportunities WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_explainability_reports WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_agent_health_reports WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_agent_registry WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND agent_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_command_center_snapshots WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_labeling_annotations WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_labeling_tasks WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND dataset_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_policy_diffs WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND policy_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_patient_timeline_snapshots WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_pathway_bundle_audits WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_kg_health_reports WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_kg_edges WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_kg_nodes WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND source = 'test'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_acuity_staffing_forecasts WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_federation_rounds WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_federation_sites WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid AND site_key LIKE 'test-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_voice_ivr_sessions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_task_candidates WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_safety_reviews WHERE module_key LIKE '%'`).catch(() => {});
    // Drop any leftover per-tenant module overrides for the test tenant. A stale
    // `clinical_ai_tenant_modules` row with `enabled = false` shadows the global
    // enable that `enableModule()` performs, so the module-draft routes would 403
    // ("module is disabled") even though the global module is on. The tenant-override
    // sub-test (denial_risk_assist) creates and resets its own row, so wiping this
    // table keeps the suite self-contained and deterministic across QA-DB reuse.
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_tenant_modules WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid`).catch(() => {});
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
    const toggled = await patchGlobalModule(
      'patient_aftercare_instructions',
      { enabled: !aftercareModule.enabled },
      'toggle clinical AI module'
    );
    expectStatus(toggled, 200, 'toggle clinical AI module');
    expect(toggled.body.data.enabled).toBe(!aftercareModule.enabled);

    const tenantModules = await admin.get('/api/v1/admin/clinical-ai/tenant-modules');
    expectStatus(tenantModules, 200, 'list tenant clinical AI modules');
    expect(tenantModules.body.data.modules.some((module) => module.module_key === 'denial_risk_assist')).toBe(true);

    const tenantOverride = await patchTenantModule(
      'denial_risk_assist',
      {
        enabled: true,
        provider_override: 'ollama',
        model_override: 'tenant-test-model',
        external_allowed: false,
        max_tokens: 1111,
      },
      'update tenant clinical AI module'
    );
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

    const tenantOverrideCleared = await patchTenantModule(
      'denial_risk_assist',
      {
        provider_override: null,
        model_override: null,
        external_allowed: null,
        max_tokens: null,
        temperature: null,
      },
      'clear tenant clinical AI module overrides'
    );
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
  }, LONG_CLINICAL_AI_TEST_TIMEOUT_MS);

  it('exposes timeline, handover draft, FHIR everything, and downtime packet', async () => {
    const timeline = await doctor.get(`/api/v1/emr/timeline/${PATIENT_UID}`);
    expectStatus(timeline, 200, 'patient timeline');
    const timelineEvents = Array.isArray(timeline.body.data)
      ? timeline.body.data
      : timeline.body.data?.events || [];
    expect(timelineEvents.some((event) =>
      event.event_type === 'clinical_note' ||
      String(event.event_type || '').startsWith('note.') ||
      event.resource_type === 'clinical_notes'
    )).toBe(true);

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
    const res = await patchGlobalModule(moduleKey, { enabled: true }, `enable module ${moduleKey}`);
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

  it('returns a deterministic discharge readiness checklist when Clinical AI readiness is disabled', async () => {
    const disabled = await admin.patch('/api/v1/admin/clinical-ai/modules/discharge_readiness').send({ enabled: false });
    expectStatus(disabled, 200, 'disable discharge readiness AI module');

    const readiness = await doctor.get(`/api/v1/emr/${admissionId}/discharge-readiness`);
    expectStatus(readiness, 200, 'rules discharge readiness checklist');

    const body = readiness.body.data;
    expect(body.module_key).toBe('discharge_readiness');
    expect(body.rules_authoritative).toBe(true);
    expect(body.ai_metadata.used_ai).toBe(false);
    expect(body.ai_metadata.provider).toBe('rules');
    expect(body.ai_metadata.fallback_reason).toBe('clinical_ai_module_disabled');
    expect(body.generation_id).toBeNull();
    expect(body.draft.ready).toBe(false);

    const blockerTypes = body.draft.blockers.map((blocker) => blocker.type);
    expect(blockerTypes).toEqual(expect.arrayContaining([
      'NOT_MARKED_FOR_DISCHARGE',
      'DRUGS_NOT_DISPENSED',
      'NO_INVOICE',
      'PENDING_RESULTS',
      'FOLLOWUP_NOT_BOOKED',
    ]));
    expect(body.draft.checklist.marked_for_discharge).toBe(false);
    expect(body.draft.checklist.finalized_invoice_exists).toBe(false);
    expect(Array.isArray(body.source_citations)).toBe(true);
    expect(body.source_citations[0].source_type).toBe('admission_readiness_rules');
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
      reviewer_note: 'Reviewed patient summary draft before acceptance [test]',
    });
    expectStatus(decisioned, 200, 'accept review');
    expect(decisioned.body.data.decision).toBe('accepted');
  }, LONG_CLINICAL_AI_TEST_TIMEOUT_MS);

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

  it('ingests payer contracts, classifies variance, escalates, and gates by module', async () => {
    await enableModule('payer_contract_variance');

    const contract = await admin.post('/api/v1/admin/clinical-ai/payer-contracts').send({
      payer_name: 'Contract Payer [test]',
      procedure_code: 'CPT-77001',
      procedure_description: 'Test bronchoscopy service',
      expected_rate_minor: 1500000,
      tolerance_pct: 2,
      effective_start_date: '2026-01-01',
      contract_reference: 'CTRACT-TEST-1',
    });
    expectStatus(contract, 201, 'upsert payer contract');
    expect(contract.body.data.payer_name).toBe('Contract Payer [test]');
    expect(contract.body.data.expected_rate_minor).toBe(1500000);

    const claim = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_claims
         (claim_number, patient_uid, insurance_provider, policy_number, claim_amount,
          approved_amount, status, documents, submitted_at, created_at, updated_at)
       VALUES ($1, $2::uuid, 'Contract Payer [test]', 'POL-VAR-[test]', 16000.00,
               12000.00, 'approved', '[]'::jsonb,
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days', NOW())
       RETURNING id`,
      `CLM-VAR-${Date.now()}`,
      PATIENT_UID
    );
    const claimId = claim[0].id;

    const evaluated = await admin.post('/api/v1/admin/clinical-ai/payer-variance/evaluate').send({
      claim_id: claimId,
      procedure_code: 'CPT-77001',
    });
    expectStatus(evaluated, 201, 'evaluate claim variance');
    const body = evaluated.body.data;
    expect(body.module_key).toBe('payer_contract_variance');
    expect(body.review_id).toBeTruthy();
    expect(body.draft.variance_category).toBe('underpayment');
    expect(['investigate', 'escalate']).toContain(body.draft.variance_band);
    expect(body.draft.expected_amount_minor).toBe(1500000);
    expect(body.draft.paid_amount_minor).toBe(1200000);
    expect(body.draft.variance_minor).toBeLessThan(0);
    expect(Array.isArray(body.draft.suggested_actions)).toBe(true);
    expect(body.draft.suggested_actions.length).toBeGreaterThan(0);
    expect(body.source_citations.length).toBeGreaterThan(0);

    const escalated = await admin.patch(`/api/v1/admin/clinical-ai/payer-variance/reviews/${body.review_id}`).send({
      decision: 'escalated',
      note: 'Escalated for billing leadership [test]',
    });
    expectStatus(escalated, 200, 'escalate payer variance review');
    expect(escalated.body.data.reviewer_decision).toBe('escalated');

    // Missing-contract path
    const strayClaim = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_claims
         (claim_number, patient_uid, insurance_provider, policy_number, claim_amount,
          approved_amount, status, documents, submitted_at, created_at, updated_at)
       VALUES ($1, $2::uuid, 'Unknown Payer [test]', 'POL-NO-[test]', 5000.00,
               4800.00, 'approved', '[]'::jsonb, NOW(), NOW(), NOW())
       RETURNING id`,
      `CLM-NOCTR-${Date.now()}`,
      PATIENT_UID
    );
    const missing = await admin.post('/api/v1/admin/clinical-ai/payer-variance/evaluate').send({
      claim_id: strayClaim[0].id,
    });
    expectStatus(missing, 201, 'missing_contract evaluation');
    expect(missing.body.data.draft.variance_category).toBe('missing_contract');

    // Disabled-module gating
    await admin.patch('/api/v1/admin/clinical-ai/modules/payer_contract_variance').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/payer-variance/evaluate').send({
      claim_id: strayClaim[0].id,
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('predicts bed turnover + cleaning level and gates by module', async () => {
    await enableModule('housekeeping_bed_turnover');

    // Critical: C. diff discharge from ED-adjacent bed at peak demand
    const critical = await admin.post('/api/v1/admin/clinical-ai/bed-turnover/evaluate').send({
      ward: 'ED-OBS',
      room_number: 'E-05',
      prior_diagnoses: ['Clostridium difficile colitis'],
      bed_demand: 'critical',
      staffing_load: 'high',
      has_private_bathroom: true,
      is_ed_doorway: true,
      discharge_time: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    });
    expectStatus(critical, 201, 'critical bed turnover');
    expect(critical.body.data.module_key).toBe('housekeeping_bed_turnover');
    expect(critical.body.data.draft.required_cleaning_level).toBe('deep_clean');
    expect(critical.body.data.draft.priority_band).toBe('critical');
    expect(critical.body.data.draft.predicted_turnover_minutes).toBeGreaterThan(60);

    // Normal low-priority turnover
    const low = await admin.post('/api/v1/admin/clinical-ai/bed-turnover/evaluate').send({
      ward: 'GENERAL',
      bed_demand: 'normal',
      prior_diagnoses: ['Viral URI'],
      staffing_load: 'normal',
    });
    expectStatus(low, 201, 'low bed turnover');
    expect(low.body.data.draft.required_cleaning_level).toBe('standard');

    const listed = await admin.get('/api/v1/admin/clinical-ai/bed-turnover/predictions?priority_band=critical');
    expectStatus(listed, 200, 'list bed turnover predictions');
    expect(listed.body.data.predictions.length).toBeGreaterThan(0);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/bed-turnover/predictions/${critical.body.data.prediction_id}`).send({
      decision: 'accepted',
      note: 'Dispatched housekeeping [test]',
    });
    expectStatus(accepted, 200, 'accept bed turnover');

    await admin.patch('/api/v1/admin/clinical-ai/modules/housekeeping_bed_turnover').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/bed-turnover/evaluate').send({ ward: 'X' });
    expect(blocked.statusCode).toBe(403);
  });

  it('predicts biomedical device maintenance risk and gates by module', async () => {
    await enableModule('biomed_device_maintenance');

    const device = await admin.post('/api/v1/admin/clinical-ai/biomed-devices').send({
      device_code: 'TEST-VENT-001',
      device_type: 'ventilator',
      manufacturer: 'Hamilton',
      model: 'C3',
      location: 'ICU-Bay-1',
      installed_at: '2021-01-15',
      warranty_expires_on: '2026-01-15',
      last_preventive_maintenance_at: new Date(Date.now() - 400 * 86400 * 1000).toISOString(),
      usage_hours: 1800,
      fault_events_last_90d: 5,
      mean_time_between_failures_hours: 300,
      status: 'in_service',
    });
    expectStatus(device, 201, 'upsert biomed device');
    expect(device.body.data.device_code).toBe('TEST-VENT-001');

    const evaluated = await admin.post('/api/v1/admin/clinical-ai/biomed-devices/evaluate').send({
      device_code: 'TEST-VENT-001',
    });
    expectStatus(evaluated, 201, 'evaluate device maintenance');
    expect(evaluated.body.data.module_key).toBe('biomed_device_maintenance');
    expect(['high', 'critical']).toContain(evaluated.body.data.draft.risk_band);

    const listed = await admin.get('/api/v1/admin/clinical-ai/biomed-devices/predictions');
    expectStatus(listed, 200, 'list maintenance predictions');
    expect(listed.body.data.predictions.length).toBeGreaterThan(0);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/biomed-devices/predictions/${evaluated.body.data.prediction_id}`).send({
      decision: 'accepted',
      note: 'Scheduled service [test]',
    });
    expectStatus(accepted, 200, 'accept maintenance prediction');

    await admin.patch('/api/v1/admin/clinical-ai/modules/biomed_device_maintenance').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/biomed-devices/evaluate').send({ device_code: 'TEST-VENT-001' });
    expect(blocked.statusCode).toBe(403);
  });

  it('detects cybersecurity anomalies and gates by module', async () => {
    await enableModule('cybersecurity_anomaly_detector');

    // Impossible travel login anomaly
    const nowMs = Date.now();
    const result = await admin.post('/api/v1/admin/clinical-ai/security-anomalies/record').send({
      subject_type: 'user_login',
      subject_id: ADMIN_UID,
      inputs: {
        recentLogins: [
          { timestamp: new Date(nowMs - 2 * 60 * 1000).toISOString(), ip: '1.1.1.1', country: 'US', city: 'New York', lat: 40.71, lng: -74.00 },
          { timestamp: new Date(nowMs).toISOString(), ip: '2.2.2.2', country: 'IN', city: 'Mumbai', lat: 19.07, lng: 72.87 },
        ],
      },
      context: { user_agent: 'test-agent', hour_of_day: 3 },
    });
    expectStatus(result, 201, 'record impossible-travel anomaly');
    expect(result.body.data.module_key).toBe('cybersecurity_anomaly_detector');
    // Single high-severity signal (IMPOSSIBLE_TRAVEL = +25) lands in medium band (>=20)
    expect(['medium', 'high', 'critical']).toContain(result.body.data.draft.severity);
    expect(['impossible_login', 'brute_force', 'lateral_movement']).toContain(result.body.data.draft.anomaly_category);

    const listed = await admin.get('/api/v1/admin/clinical-ai/security-anomalies?severity=high');
    expectStatus(listed, 200, 'list security anomalies');
    // not asserting length — anomalies may be categorized differently

    const resolved = await admin.patch(`/api/v1/admin/clinical-ai/security-anomalies/${result.body.data.anomaly_id}`).send({
      decision: 'investigating',
      note: 'Security officer paged [test]',
    });
    expectStatus(resolved, 200, 'investigating security anomaly');
    expect(resolved.body.data.reviewer_decision).toBe('investigating');

    await admin.patch('/api/v1/admin/clinical-ai/modules/cybersecurity_anomaly_detector').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/security-anomalies/record').send({
      subject_type: 'user_login',
      subject_id: ADMIN_UID,
      inputs: {},
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('evaluates PGx advisories against patient genotypes and gates by module', async () => {
    await enableModule('pharmacogenomics_support');

    // Seed a CYP2D6 ultra-rapid metabolizer genotype
    const genotype = await admin.post('/api/v1/admin/clinical-ai/pgx/genotypes').send({
      patient_uid: PATIENT_UID,
      gene: 'CYP2D6',
      phenotype: 'ultra_rapid_metabolizer',
      genotype_detail: '*1/*1xN',
      source: 'lab_report',
      tested_at: '2025-06-01',
      verified: true,
    });
    expectStatus(genotype, 201, 'upsert genotype');

    // Codeine + ultra-rapid → contraindicated
    const advisory = await admin.post('/api/v1/admin/clinical-ai/pgx/advisories/evaluate').send({
      patient_uid: PATIENT_UID,
      medication_name: 'Codeine',
    });
    expectStatus(advisory, 201, 'PGx advisory for codeine');
    expect(advisory.body.data.module_key).toBe('pharmacogenomics_support');
    expect(advisory.body.data.draft.advisory_category).toBe('contraindicated');
    expect(advisory.body.data.draft.severity).toBe('critical');

    // Paracetamol has no PGx consideration → no_action
    const noAction = await admin.post('/api/v1/admin/clinical-ai/pgx/advisories/evaluate').send({
      patient_uid: PATIENT_UID,
      medication_name: 'Paracetamol',
    });
    expectStatus(noAction, 201, 'PGx no-action for paracetamol');
    expect(noAction.body.data.draft.advisory_category).toBe('no_action');

    const listed = await admin.get(`/api/v1/admin/clinical-ai/pgx/advisories?patient_uid=${PATIENT_UID}`);
    expectStatus(listed, 200, 'list PGx advisories');
    expect(listed.body.data.advisories.length).toBeGreaterThanOrEqual(2);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/pgx/advisories/${advisory.body.data.advisory_id}`).send({
      decision: 'accepted',
      note: 'Switched to paracetamol + NSAIDs [test]',
    });
    expectStatus(accepted, 200, 'accept PGx advisory');

    await admin.patch('/api/v1/admin/clinical-ai/modules/pharmacogenomics_support').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/pgx/advisories/evaluate').send({
      patient_uid: PATIENT_UID,
      medication_name: 'Codeine',
    });
    expect(blocked.statusCode).toBe(403);
  }, LONG_CLINICAL_AI_TEST_TIMEOUT_MS);

  it('evaluates radiology report QA discrepancies and gates by module', async () => {
    await enableModule('radiology_report_qa');

    const reportText = [
      'FINDINGS: Left knee shows mild joint effusion. No fracture identified.',
      'IMPRESSION: Left knee effusion.',
    ].join('\n');

    const evaluated = await admin.post('/api/v1/admin/clinical-ai/radiology/report-qa/evaluate').send({
      patient_uid: PATIENT_UID,
      study_id: 'STUDY-RPTQA-001',
      accession_number: 'ACC-RPTQA-001',
      modality: 'XR',
      body_part: 'knee',
      indication: 'Right knee pain after fall; evaluate for fracture',
      report_text: reportText,
      report_status: 'draft',
      priors_available: false,
      is_critical: false,
    });
    expectStatus(evaluated, 201, 'radiology report QA evaluation');
    expect(evaluated.body.data.module_key).toBe('radiology_report_qa');
    expect(Array.isArray(evaluated.body.data.discrepancies)).toBe(true);
    expect(evaluated.body.data.overall_severity).toBe('critical');
    expect(
      evaluated.body.data.discrepancies.some((d) => d.code === 'LATERALITY_MISMATCH')
    ).toBe(true);

    const listed = await admin.get('/api/v1/admin/clinical-ai/radiology/report-qa');
    expectStatus(listed, 200, 'list radiology report QA');
    expect(listed.body.data.reviews.length).toBeGreaterThanOrEqual(1);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/radiology/report-qa/${evaluated.body.data.review_id}`)
      .send({ decision: 'accepted', note: 'Laterality corrected [test]' });
    expectStatus(decided, 200, 'decide radiology report QA');

    await admin.patch('/api/v1/admin/clinical-ai/modules/radiology_report_qa').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/radiology/report-qa/evaluate').send({
      study_id: 'STUDY-RPTQA-002',
      report_text: 'Placeholder report text.',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('prioritizes the radiology worklist and gates by module', async () => {
    await enableModule('radiology_worklist_prioritizer');

    const statStudy = await admin.post('/api/v1/admin/clinical-ai/radiology/worklist/evaluate').send({
      patient_uid: PATIENT_UID,
      study_id: 'STUDY-WORK-001',
      modality: 'CT',
      body_part: 'head',
      indication: 'Code stroke — acute hemiparesis, possible intracranial bleed',
      location: 'ED',
      wait_minutes: 30,
      fragility: { ageYears: 78, criticalVitalsFlag: true, oxygenSupport: false, immunocompromised: false },
      context_tags: ['code_stroke'],
      priors_available: false,
      is_stat_override: false,
    });
    expectStatus(statStudy, 201, 'stat radiology worklist priority');
    expect(statStudy.body.data.module_key).toBe('radiology_worklist_prioritizer');
    expect(statStudy.body.data.priority_tier).toBe('stat');
    expect(statStudy.body.data.priority_score).toBeGreaterThanOrEqual(120);

    const routineStudy = await admin.post('/api/v1/admin/clinical-ai/radiology/worklist/evaluate').send({
      study_id: 'STUDY-WORK-002',
      modality: 'XR',
      body_part: 'chest',
      indication: 'Routine follow-up imaging',
      location: 'outpatient',
      wait_minutes: 20,
      fragility: {},
      context_tags: ['routine'],
      priors_available: true,
      is_stat_override: false,
    });
    expectStatus(routineStudy, 201, 'routine radiology worklist priority');
    expect(['routine', 'deferrable']).toContain(routineStudy.body.data.priority_tier);

    const listed = await admin.get('/api/v1/admin/clinical-ai/radiology/worklist');
    expectStatus(listed, 200, 'list radiology worklist priorities');
    expect(listed.body.data.priorities.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/radiology/worklist/${statStudy.body.data.priority_id}`)
      .send({ decision: 'accepted', note: 'Reading immediately [test]' });
    expectStatus(decided, 200, 'decide radiology worklist priority');

    await admin.patch('/api/v1/admin/clinical-ai/modules/radiology_worklist_prioritizer').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/radiology/worklist/evaluate').send({
      study_id: 'STUDY-WORK-003',
      modality: 'XR',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('evaluates OT block scheduling recommendations and gates by module', async () => {
    await enableModule('ot_block_scheduling');

    const reallocate = await admin.post('/api/v1/admin/clinical-ai/ot/blocks/evaluate').send({
      surgeon_uid: DOCTOR_UID,
      surgeon_name: 'Dr. Test Surgeon',
      service_line: 'general_surgery',
      block_label: 'Mon-AM-OR1',
      or_room: 'OR-1',
      window_start: '2026-01-06',
      window_end: '2026-03-30',
      allocated_minutes: 500,
      scheduled_minutes: 200,
      actual_minutes: 180,
      prime_allocated_minutes: 200,
      prime_used_minutes: 50,
      overrun_count: 0,
      addon_count: 0,
      total_cases: 4,
      avg_turnover_minutes: 25,
    });
    expectStatus(reallocate, 201, 'OT block reallocate evaluation');
    expect(reallocate.body.data.module_key).toBe('ot_block_scheduling');
    expect(reallocate.body.data.recommendation).toBe('reallocate');
    expect(reallocate.body.data.severity).toBe('high');

    const listed = await admin.get('/api/v1/admin/clinical-ai/ot/blocks');
    expectStatus(listed, 200, 'list OT block suggestions');
    expect(listed.body.data.suggestions.length).toBeGreaterThanOrEqual(1);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/ot/blocks/${reallocate.body.data.suggestion_id}`)
      .send({ decision: 'accepted', note: 'Planning reallocation [test]' });
    expectStatus(decided, 200, 'decide OT block suggestion');

    await admin.patch('/api/v1/admin/clinical-ai/modules/ot_block_scheduling').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/ot/blocks/evaluate').send({
      block_label: 'Tue-AM-OR2',
      allocated_minutes: 400,
      scheduled_minutes: 300,
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('classifies non-pharmacy inventory alerts and gates by module', async () => {
    await enableModule('inventory_intelligence');

    const stockout = await admin.post('/api/v1/admin/clinical-ai/inventory/evaluate').send({
      item_sku: 'PPE-MASK-N95',
      item_name: 'N95 Respirator Mask',
      category: 'ppe',
      ward: 'WARD-A',
      current_stock: 0,
      reorder_point: 200,
      max_stock: 2000,
      avg_daily_usage: 120,
      baseline_daily_usage: 110,
      next_expiry_date: '2027-12-31',
      today: '2026-04-23',
    });
    expectStatus(stockout, 201, 'inventory stockout evaluation');
    expect(stockout.body.data.module_key).toBe('inventory_intelligence');
    expect(stockout.body.data.alert_category).toBe('stockout_risk');
    expect(stockout.body.data.severity).toBe('critical');

    const healthy = await admin.post('/api/v1/admin/clinical-ai/inventory/evaluate').send({
      item_sku: 'LINEN-SHEET-STD',
      item_name: 'Standard Bed Sheet',
      category: 'linens',
      ward: 'WARD-A',
      current_stock: 150,
      reorder_point: 50,
      max_stock: 300,
      avg_daily_usage: 10,
      baseline_daily_usage: 10,
      next_expiry_date: null,
      today: '2026-04-23',
    });
    expectStatus(healthy, 201, 'inventory healthy evaluation');
    expect(healthy.body.data.alert_category).toBe('healthy');

    const listed = await admin.get('/api/v1/admin/clinical-ai/inventory/alerts');
    expectStatus(listed, 200, 'list inventory alerts');
    expect(listed.body.data.alerts.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/inventory/alerts/${stockout.body.data.alert_id}`)
      .send({ decision: 'accepted', note: 'Reorder placed with supply chain [test]' });
    expectStatus(decided, 200, 'decide inventory alert');

    await admin.patch('/api/v1/admin/clinical-ai/modules/inventory_intelligence').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/inventory/evaluate').send({
      item_sku: 'TEST-SKU',
      item_name: 'Test Item',
      current_stock: 10,
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('generates deterministic synthetic clinical cases and gates by module', async () => {
    await enableModule('synthetic_case_generator');

    const first = await admin.post('/api/v1/admin/clinical-ai/synthetic-cases/generate').send({
      pathway: 'sepsis',
      complexity: 'edge',
      seed: 'integration-seed-1',
      intended_use: 'canary',
    });
    expectStatus(first, 201, 'synthetic case generate');
    expect(first.body.data.module_key).toBe('synthetic_case_generator');
    expect(first.body.data.pathway).toBe('sepsis');
    expect(first.body.data.complexity).toBe('edge');
    expect(first.body.data.synthetic).toBe(true);
    expect(Array.isArray(first.body.data.edge_flags)).toBe(true);

    const listed = await admin.get('/api/v1/admin/clinical-ai/synthetic-cases?pathway=sepsis');
    expectStatus(listed, 200, 'list synthetic cases');
    expect(listed.body.data.cases.length).toBeGreaterThanOrEqual(1);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/synthetic-cases/${first.body.data.case_id}`)
      .send({ decision: 'accepted', note: 'Accepted into canary suite [test]' });
    expectStatus(decided, 200, 'decide synthetic case');

    await admin.patch('/api/v1/admin/clinical-ai/modules/synthetic_case_generator').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/synthetic-cases/generate').send({
      pathway: 'pneumonia',
      complexity: 'standard',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('builds training modules from incidents, scrubs PHI, and gates by module', async () => {
    await enableModule('training_simulation_coach');

    const sim = await admin.post('/api/v1/admin/clinical-ai/training/modules/generate').send({
      title: 'Sim — code stroke delayed diagnosis [test]',
      case_type: 'delayed_diagnosis',
      incident_category: 'stroke',
      severity: 'critical',
      summary: 'Patient MRN: VH-00042 arrived with stroke symptoms. Phone 9876543210 on file.',
    });
    expectStatus(sim, 201, 'training module generate');
    expect(sim.body.data.module_key).toBe('training_simulation_coach');
    expect(sim.body.data.case_type).toBe('delayed_diagnosis');
    expect(sim.body.data.format).toBe('sim_lab');
    // delayed_diagnosis base=25 + critical severity +30 = 55 → 'high' band (40-59).
    expect(sim.body.data.risk_band).toBe('high');
    expect(Array.isArray(sim.body.data.phi_findings)).toBe(true);
    expect(sim.body.data.phi_findings).toEqual(expect.arrayContaining(['MRN_DETECTED', 'PHONE_DETECTED']));

    const listed = await admin.get('/api/v1/admin/clinical-ai/training/modules');
    expectStatus(listed, 200, 'list training modules');
    expect(listed.body.data.modules.length).toBeGreaterThanOrEqual(1);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/training/modules/${sim.body.data.module_id}`)
      .send({ decision: 'accepted', note: 'Ready to run [test]' });
    expectStatus(decided, 200, 'decide training module');

    await admin.patch('/api/v1/admin/clinical-ai/modules/training_simulation_coach').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/training/modules/generate').send({
      title: 'Blocked [test]',
      case_type: 'near_miss',
      severity: 'low',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('records model eval runs and classifies recommendations, gated by module', async () => {
    await enableModule('model_registry_workbench');

    const registered = await admin.post('/api/v1/admin/clinical-ai/model-registry').send({
      model_key: 'test-clinical-summarizer',
      version: 'v1.0',
      provider: 'local-llm',
      purpose: 'Discharge summary drafting',
      owner: 'test-team',
    });
    expectStatus(registered, 201, 'model registry upsert');
    expect(registered.body.data.model_key).toBe('test-clinical-summarizer');

    const quarantine = await admin.post('/api/v1/admin/clinical-ai/model-registry/eval-runs').send({
      model_key: 'test-clinical-summarizer',
      version: 'v1.0',
      suite: 'canary-discharge-v1',
      sample_count: 100,
      pass_count: 92,
      fail_count: 8,
      accuracy: 0.9,
      f1_score: 0.9,
      avg_latency_ms: 5200,
      fallback_rate_pct: 1,
      safety_flag_rate_pct: 0.2,
      drift_score: 0.02,
    });
    expectStatus(quarantine, 201, 'quarantine eval run');
    expect(quarantine.body.data.module_key).toBe('model_registry_workbench');
    expect(quarantine.body.data.recommendation).toBe('quarantine');
    expect(quarantine.body.data.severity).toBe('critical');

    const promote = await admin.post('/api/v1/admin/clinical-ai/model-registry/eval-runs').send({
      model_key: 'test-clinical-summarizer',
      version: 'v1.0',
      suite: 'canary-discharge-v1',
      sample_count: 100,
      pass_count: 96,
      fail_count: 4,
      accuracy: 0.96,
      f1_score: 0.95,
      avg_latency_ms: 500,
      fallback_rate_pct: 0.5,
      safety_flag_rate_pct: 0.1,
      drift_score: 0.02,
      baseline_metrics: { accuracy: 0.9, f1_score: 0.89 },
    });
    expectStatus(promote, 201, 'promote eval run');
    expect(promote.body.data.recommendation).toBe('promote');

    const listed = await admin.get('/api/v1/admin/clinical-ai/model-registry/eval-runs?model_key=test-clinical-summarizer');
    expectStatus(listed, 200, 'list eval runs');
    expect(listed.body.data.runs.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/model-registry/eval-runs/${promote.body.data.run_id}`)
      .send({ decision: 'accepted', note: 'Promotion approved [test]' });
    expectStatus(decided, 200, 'decide eval run');

    await admin.patch('/api/v1/admin/clinical-ai/modules/model_registry_workbench').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/model-registry/eval-runs').send({
      model_key: 'test-clinical-summarizer',
      version: 'v1.0',
      suite: 'canary-discharge-v1',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('classifies procurement opportunities and gates by module', async () => {
    await enableModule('procurement_negotiation_assistant');

    const priceAnomaly = await admin.post('/api/v1/admin/clinical-ai/procurement/evaluate').send({
      item_sku: 'TEST-GAUZE-001',
      item_name: 'Sterile gauze rolls',
      category: 'consumables',
      vendor_name: 'Acme Medical',
      current_unit_price: 140,
      historical_avg_price: 100,
      historical_min_price: 95,
      quoted_alternative_price: null,
      annual_volume: 5000,
      vendor_count_for_category: 2,
      contract_tenure_months: 12,
      contract_end_date: null,
      today: '2026-04-23',
    });
    expectStatus(priceAnomaly, 201, 'procurement price anomaly');
    expect(priceAnomaly.body.data.module_key).toBe('procurement_negotiation_assistant');
    expect(priceAnomaly.body.data.opportunity_category).toBe('price_anomaly');

    const healthy = await admin.post('/api/v1/admin/clinical-ai/procurement/evaluate').send({
      item_sku: 'TEST-LINEN-001',
      item_name: 'Standard bed sheets',
      category: 'linens',
      vendor_name: 'Linen Co',
      current_unit_price: 100,
      historical_avg_price: 100,
      annual_volume: 1000,
      vendor_count_for_category: 3,
      contract_tenure_months: 24,
      contract_end_date: null,
      today: '2026-04-23',
    });
    expectStatus(healthy, 201, 'procurement healthy');
    expect(healthy.body.data.opportunity_category).toBe('no_action');

    const listed = await admin.get('/api/v1/admin/clinical-ai/procurement/opportunities');
    expectStatus(listed, 200, 'list procurement opportunities');
    expect(listed.body.data.opportunities.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/procurement/opportunities/${priceAnomaly.body.data.opportunity_id}`)
      .send({ decision: 'accepted', note: 'Re-bid queued [test]' });
    expectStatus(decided, 200, 'decide procurement opportunity');

    await admin.patch('/api/v1/admin/clinical-ai/modules/procurement_negotiation_assistant').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/procurement/evaluate').send({
      item_sku: 'TEST-OTHER',
      item_name: 'Other item',
      current_unit_price: 50,
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('evaluates AI draft explainability, detects PHI leakage, and gates by module', async () => {
    await enableModule('ai_explainability_dashboard');

    const trusted = await admin.post('/api/v1/admin/clinical-ai/explainability/evaluate').send({
      module_key: 'discharge_summary',
      draft_text: 'Patient had pneumonia. Started antibiotics. Scheduled follow-up.',
      citations: [
        { source_type: 'diagnosis', source_id: 'dx:1', label: 'Community acquired pneumonia' },
        { source_type: 'order', source_id: 'ord:1', label: 'Started antibiotics for pneumonia' },
      ],
      context_text: 'Patient admitted with pneumonia, prescribed antibiotics.',
    });
    expectStatus(trusted, 201, 'explainability trusted draft');
    expect(trusted.body.data.module_key).toBe('ai_explainability_dashboard');
    expect(['trusted', 'review']).toContain(trusted.body.data.trust_band);
    expect(trusted.body.data.phi_leakage_count).toBe(0);

    const phiLeak = await admin.post('/api/v1/admin/clinical-ai/explainability/evaluate').send({
      module_key: 'discharge_summary',
      draft_text: 'Please contact patient at 9876543210 for follow-up.',
      citations: [],
      context_text: '',
    });
    expectStatus(phiLeak, 201, 'explainability PHI leak');
    expect(phiLeak.body.data.trust_band).toBe('reject');
    expect(phiLeak.body.data.phi_leakage_count).toBeGreaterThan(0);

    const listed = await admin.get('/api/v1/admin/clinical-ai/explainability/reports');
    expectStatus(listed, 200, 'list explainability reports');
    expect(listed.body.data.reports.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/explainability/reports/${trusted.body.data.report_id}`)
      .send({ decision: 'accepted', note: 'Green-lit [test]' });
    expectStatus(decided, 200, 'decide explainability report');

    await admin.patch('/api/v1/admin/clinical-ai/modules/ai_explainability_dashboard').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/explainability/evaluate').send({
      draft_text: 'Blocked draft',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('records AI agent health, classifies lifecycle recommendation, and gates by module', async () => {
    await enableModule('ai_agent_lifecycle_manager');

    const registered = await admin.post('/api/v1/admin/clinical-ai/agent-registry').send({
      agent_key: 'test-translation-agent',
      display_name: 'Translation Agent',
      owner: 'test-team',
      purpose: 'Patient-facing translations',
      scopes: ['read_patient_summary', 'write_draft'],
      permitted_actions: ['generate_translation'],
      expiry_date: '2027-01-01',
    });
    expectStatus(registered, 201, 'agent registry upsert');
    expect(registered.body.data.agent_key).toBe('test-translation-agent');

    const healthy = await admin.post('/api/v1/admin/clinical-ai/agent-registry/health-reports').send({
      agent_key: 'test-translation-agent',
      invocation_count: 1000,
      success_count: 995,
      error_count: 5,
      avg_latency_ms: 400,
      permission_mismatch_count: 0,
      last_seen_at: '2026-04-23T10:00:00Z',
      today: '2026-04-23',
    });
    expectStatus(healthy, 201, 'agent health healthy');
    expect(healthy.body.data.module_key).toBe('ai_agent_lifecycle_manager');
    expect(healthy.body.data.recommendation).toBe('no_action');

    const quarantine = await admin.post('/api/v1/admin/clinical-ai/agent-registry/health-reports').send({
      agent_key: 'test-translation-agent',
      invocation_count: 100,
      success_count: 80,
      error_count: 20,
      avg_latency_ms: 500,
      permission_mismatch_count: 10,
      last_seen_at: '2026-04-23T10:00:00Z',
      today: '2026-04-23',
    });
    expectStatus(quarantine, 201, 'agent health quarantine');
    expect(quarantine.body.data.recommendation).toBe('quarantine');
    expect(quarantine.body.data.severity).toBe('critical');

    const listed = await admin.get('/api/v1/admin/clinical-ai/agent-registry/health-reports?agent_key=test-translation-agent');
    expectStatus(listed, 200, 'list agent health reports');
    expect(listed.body.data.reports.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/agent-registry/health-reports/${quarantine.body.data.report_id}`)
      .send({ decision: 'accepted', note: 'Quarantine confirmed [test]' });
    expectStatus(decided, 200, 'decide agent health report');

    await admin.patch('/api/v1/admin/clinical-ai/modules/ai_agent_lifecycle_manager').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/agent-registry/health-reports').send({
      agent_key: 'test-translation-agent',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('generates hospital command center snapshots and gates by module', async () => {
    await enableModule('hospital_command_center');

    const crisis = await admin.post('/api/v1/admin/clinical-ai/command-center/evaluate').send({
      bed: { occupancyPct: 99, dischargeReadyWaitMinutes: 240, admissionQueueCount: 20 },
      ed: { waitMinutes: 300, boardingCount: 25, lwbsPct: 6 },
      ot: { utilizationPct: 115, overrunCount: 7, addonPressure: 'excessive' },
      housekeeping: { pendingTurnovers: 20, avgTurnoverMinutes: 60 },
      radiology: { pendingStudies: 50, statWaitMinutes: 90 },
      pharmacy: { dispenseBacklogMinutes: 90, criticalMedsLate: 5 },
    });
    expectStatus(crisis, 201, 'command center crisis');
    expect(crisis.body.data.module_key).toBe('hospital_command_center');
    expect(crisis.body.data.command_status).toBe('crisis');
    expect(crisis.body.data.overall_score).toBeGreaterThan(0);

    const normal = await admin.post('/api/v1/admin/clinical-ai/command-center/evaluate').send({
      bed: { occupancyPct: 70, dischargeReadyWaitMinutes: 30, admissionQueueCount: 1 },
      ed: { waitMinutes: 20, boardingCount: 1, lwbsPct: 0 },
      ot: { utilizationPct: 80, overrunCount: 1, addonPressure: 'low' },
      housekeeping: { pendingTurnovers: 2, avgTurnoverMinutes: 20 },
      radiology: { pendingStudies: 5, statWaitMinutes: 5 },
      pharmacy: { dispenseBacklogMinutes: 5, criticalMedsLate: 0 },
    });
    expectStatus(normal, 201, 'command center normal');
    expect(normal.body.data.command_status).toBe('normal');

    const listed = await admin.get('/api/v1/admin/clinical-ai/command-center/snapshots');
    expectStatus(listed, 200, 'list command center snapshots');
    expect(listed.body.data.snapshots.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/command-center/snapshots/${crisis.body.data.snapshot_id}`)
      .send({ decision: 'accepted', note: 'Escalated to duty officer [test]' });
    expectStatus(decided, 200, 'decide command center snapshot');

    await admin.patch('/api/v1/admin/clinical-ai/modules/hospital_command_center').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/command-center/evaluate').send({ bed: {} });
    expect(blocked.statusCode).toBe(403);
  });

  it('manages a labeling task + annotations and gates by module', async () => {
    await enableModule('dataset_labeling_studio');

    const task = await admin.post('/api/v1/admin/clinical-ai/labeling/tasks').send({
      dataset_key: 'test-coding-v1',
      task_type: 'clinical_coding',
      item_key: 'encounter-00042',
      input_ref_type: 'encounter',
      input_ref_id: 'enc:42',
      required_labelers: 2,
      difficulty: 'standard',
    });
    expectStatus(task, 201, 'labeling task create');
    expect(task.body.data.dataset_key).toBe('test-coding-v1');
    const taskId = task.body.data.id;

    const a1 = await admin.post('/api/v1/admin/clinical-ai/labeling/annotations').send({
      task_id: taskId,
      label: { code: 'J18.9', description: 'Pneumonia' },
      labeler_uid: ADMIN_UID,
      confidence_score: 0.9,
    });
    expectStatus(a1, 201, 'annotation 1 submit');
    expect(a1.body.data.module_key).toBe('dataset_labeling_studio');

    const a2 = await admin.post('/api/v1/admin/clinical-ai/labeling/annotations').send({
      task_id: taskId,
      label: { code: 'J18.9', description: 'Pneumonia' },
      labeler_uid: DOCTOR_UID,
      confidence_score: 0.85,
    });
    expectStatus(a2, 201, 'annotation 2 submit');

    const d1 = await admin
      .patch(`/api/v1/admin/clinical-ai/labeling/annotations/${a1.body.data.annotation_id}`)
      .send({ decision: 'accepted' });
    expectStatus(d1, 200, 'decide annotation 1');

    const d2 = await admin
      .patch(`/api/v1/admin/clinical-ai/labeling/annotations/${a2.body.data.annotation_id}`)
      .send({ decision: 'accepted' });
    expectStatus(d2, 200, 'decide annotation 2');
    // After two accepted matching annotations, task should be ready_to_use.
    expect(d2.body.data.task.status).toBe('ready_to_use');
    expect(d2.body.data.task.agreement).toBe('match');

    const detail = await admin.get(`/api/v1/admin/clinical-ai/labeling/tasks/${taskId}`);
    expectStatus(detail, 200, 'task with annotations');
    expect(detail.body.data.annotations.length).toBe(2);

    const listed = await admin.get('/api/v1/admin/clinical-ai/labeling/tasks?dataset_key=test-coding-v1');
    expectStatus(listed, 200, 'list labeling tasks');
    expect(listed.body.data.tasks.length).toBeGreaterThanOrEqual(1);

    await admin.patch('/api/v1/admin/clinical-ai/modules/dataset_labeling_studio').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/labeling/annotations').send({
      task_id: taskId,
      label: { code: 'X' },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('classifies policy/regulation diffs by impact and severity, and gates by module', async () => {
    await enableModule('policy_regulation_watcher');
    const billingPolicyRef = 'test-billing-policy-v1';
    const privacyPolicyRef = 'test-privacy-policy-v2';

    const billingDiff = await admin.post('/api/v1/admin/clinical-ai/policy-diffs/evaluate').send({
      policy_key: billingPolicyRef,
      policy_title: 'Billing claim denial policy [test]',
      previous_text: 'SECTION 1\nOriginal billing claim rules.',
      current_text: 'SECTION 1\nUpdated billing claim rules with new denial codes and appeal process.',
    });
    expectStatus(billingDiff, 201, 'policy diff billing');
    expect(billingDiff.body.data.module_key).toBe('policy_regulation_watcher');
    expect(['billing', 'mixed']).toContain(billingDiff.body.data.impact_area);

    const privacyDiff = await admin.post('/api/v1/admin/clinical-ai/policy-diffs/evaluate').send({
      policy_key: privacyPolicyRef,
      policy_title: 'PHI disclosure policy [test]',
      previous_text: 'SECTION 1\nBaseline policy language.',
      current_text: 'SECTION 1\nExpanded PHI disclosure, HIPAA rules, privacy breach reporting, GDPR retention, confidentiality, and deidentified data handling requirements.',
    });
    expectStatus(privacyDiff, 201, 'policy diff privacy');
    expect(privacyDiff.body.data.severity).toBe('critical');

    const listed = await admin.get('/api/v1/admin/clinical-ai/policy-diffs');
    expectStatus(listed, 200, 'list policy diffs');
    expect(listed.body.data.diffs.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/policy-diffs/${privacyDiff.body.data.diff_id}`)
      .send({ decision: 'accepted', note: 'Legal sign-off obtained [test]' });
    expectStatus(decided, 200, 'decide policy diff');

    await admin.patch('/api/v1/admin/clinical-ai/modules/policy_regulation_watcher').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/policy-diffs/evaluate').send({
      policy_key: 'test-blocked',
      previous_text: '',
      current_text: '',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('generates multimodal patient timeline snapshots and gates by module', async () => {
    await enableModule('multimodal_patient_timeline');

    const snap = await admin.post('/api/v1/admin/clinical-ai/patient-timeline/generate').send({
      patient_uid: PATIENT_UID,
      window_start: '2026-04-23T08:00:00Z',
      window_end: '2026-04-23T18:00:00Z',
      events: [
        { kind: 'vital', occurred_at: '2026-04-23T10:00:00Z', payload: { spo2: 80, hr: 140 } },
        { kind: 'lab', occurred_at: '2026-04-23T11:00:00Z', payload: { name: 'K', value: 7.2, abnormal_flag: 'critical_high' } },
        { kind: 'note', occurred_at: '2026-04-23T12:00:00Z', payload: { text: 'Stable under oxygen support' } },
      ],
    });
    expectStatus(snap, 201, 'timeline snapshot');
    expect(snap.body.data.module_key).toBe('multimodal_patient_timeline');
    expect(snap.body.data.event_count).toBe(3);
    expect(snap.body.data.overall_severity).toBe('critical');
    expect(snap.body.data.critical_count).toBeGreaterThanOrEqual(2);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/patient-timeline/snapshots?patient_uid=${PATIENT_UID}`);
    expectStatus(listed, 200, 'list timeline snapshots');
    expect(listed.body.data.snapshots.length).toBeGreaterThanOrEqual(1);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/patient-timeline/snapshots/${snap.body.data.snapshot_id}`)
      .send({ decision: 'accepted', note: 'Reviewed [test]' });
    expectStatus(decided, 200, 'decide timeline snapshot');

    await admin.patch('/api/v1/admin/clinical-ai/modules/multimodal_patient_timeline').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/patient-timeline/generate').send({
      patient_uid: PATIENT_UID,
      events: [],
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('evaluates generic pathway bundle compliance (ACS MONA) and gates by module', async () => {
    await enableModule('pathway_bundle_compliance');

    const acs = await admin.post('/api/v1/admin/clinical-ai/pathway-bundles/evaluate').send({
      patient_uid: PATIENT_UID,
      pathway_key: 'acs_mona',
      t0_reference: '2026-04-23T10:00:00Z',
      context: { pci_candidate: false, beta_blocker_contraindicated: false },
      actions: [
        { item_key: 'aspirin', occurred_at: '2026-04-23T10:05:00Z' },
        { item_key: 'ecg_12_lead', occurred_at: '2026-04-23T10:08:00Z' },
        { item_key: 'troponin_hs_ordered', occurred_at: '2026-04-23T10:20:00Z' },
      ],
    });
    expectStatus(acs, 201, 'pathway bundle ACS evaluation');
    expect(acs.body.data.module_key).toBe('pathway_bundle_compliance');
    expect(acs.body.data.pathway_key).toBe('acs_mona');
    expect(acs.body.data.compliance_pct).toBeGreaterThanOrEqual(0);
    expect(['no_action', 'catch_up', 'escalate', 'review_pathway', 'critical_miss']).toContain(acs.body.data.recommendation);

    const strokeMiss = await admin.post('/api/v1/admin/clinical-ai/pathway-bundles/evaluate').send({
      patient_uid: PATIENT_UID,
      pathway_key: 'stroke_gwg',
      t0_reference: '2026-04-23T08:00:00Z',
      context: { tpa_candidate: true },
      actions: [],
    });
    expectStatus(strokeMiss, 201, 'pathway bundle stroke missed');
    expect(strokeMiss.body.data.recommendation).toBe('critical_miss');
    expect(strokeMiss.body.data.severity).toBe('critical');

    const listed = await admin.get(`/api/v1/admin/clinical-ai/pathway-bundles?patient_uid=${PATIENT_UID}`);
    expectStatus(listed, 200, 'list pathway bundle audits');
    expect(listed.body.data.audits.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/pathway-bundles/${strokeMiss.body.data.audit_id}`)
      .send({ decision: 'accepted', note: 'Escalated to stroke team [test]' });
    expectStatus(decided, 200, 'decide pathway bundle audit');

    await admin.patch('/api/v1/admin/clinical-ai/modules/pathway_bundle_compliance').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/pathway-bundles/evaluate').send({
      patient_uid: PATIENT_UID,
      pathway_key: 'acs_mona',
      t0_reference: '2026-04-23T10:00:00Z',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('manages clinical knowledge graph nodes/edges, evaluates health, and gates by module', async () => {
    await enableModule('clinical_knowledge_graph');

    const patientNode = await admin.post('/api/v1/admin/clinical-ai/knowledge-graph/nodes').send({
      node_type: 'patient',
      node_key: 'test-patient-1',
      display_name: 'Test patient',
      source: 'test',
    });
    expectStatus(patientNode, 201, 'kg upsert patient node');

    const diagNode = await admin.post('/api/v1/admin/clinical-ai/knowledge-graph/nodes').send({
      node_type: 'diagnosis',
      node_key: 'J18.9',
      display_name: 'Pneumonia',
      source: 'test',
      attributes: { context: 'admission' },
    });
    expectStatus(diagNode, 201, 'kg upsert diagnosis node');

    const edge = await admin.post('/api/v1/admin/clinical-ai/knowledge-graph/edges').send({
      edge_type: 'has_diagnosis',
      from_node_id: patientNode.body.data.id,
      to_node_id: diagNode.body.data.id,
      source: 'test',
    });
    expectStatus(edge, 201, 'kg upsert has_diagnosis edge');

    const nodesList = await admin.get('/api/v1/admin/clinical-ai/knowledge-graph/nodes?source=test');
    expectStatus(nodesList, 200, 'list kg nodes');
    expect(nodesList.body.data.nodes.length).toBeGreaterThanOrEqual(2);

    const edgesList = await admin.get('/api/v1/admin/clinical-ai/knowledge-graph/edges?edge_type=has_diagnosis');
    expectStatus(edgesList, 200, 'list kg edges');
    expect(edgesList.body.data.edges.length).toBeGreaterThanOrEqual(1);

    const health = await admin.post('/api/v1/admin/clinical-ai/knowledge-graph/health/evaluate').send({
      staleness_days: 365,
    });
    expectStatus(health, 201, 'kg health evaluate');
    expect(health.body.data.module_key).toBe('clinical_knowledge_graph');
    expect(['healthy', 'watch', 'degraded', 'critical', 'unknown']).toContain(health.body.data.overall_health);

    const reports = await admin.get('/api/v1/admin/clinical-ai/knowledge-graph/health/reports');
    expectStatus(reports, 200, 'list kg health reports');
    expect(reports.body.data.reports.length).toBeGreaterThanOrEqual(1);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/knowledge-graph/health/reports/${health.body.data.report_id}`)
      .send({ decision: 'accepted', note: 'Reviewed graph health [test]' });
    expectStatus(decided, 200, 'decide kg health report');

    await admin.patch('/api/v1/admin/clinical-ai/modules/clinical_knowledge_graph').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/knowledge-graph/health/evaluate').send({});
    expect(blocked.statusCode).toBe(403);
  });

  it('computes acuity-based staffing forecast and gates by module', async () => {
    await enableModule('acuity_staffing_forecast');

    const crisis = await admin.post('/api/v1/admin/clinical-ai/acuity-staffing/evaluate').send({
      unit: 'ICU-1',
      shift_label: 'night',
      census: { critical: 6, high: 0, moderate: 0, low: 0 },
      current_staff: { nurse: 1, nursing_assistant: 0 },
      predicted_admissions: 2,
      predicted_discharges: 0,
    });
    expectStatus(crisis, 201, 'acuity staffing crisis');
    expect(crisis.body.data.module_key).toBe('acuity_staffing_forecast');
    expect(crisis.body.data.recommendation).toBe('emergency_acuity');
    expect(crisis.body.data.severity).toBe('critical');

    const balanced = await admin.post('/api/v1/admin/clinical-ai/acuity-staffing/evaluate').send({
      unit: 'WARD-A',
      census: { critical: 0, high: 0, moderate: 10, low: 0 },
      current_staff: { nurse: 2, nursing_assistant: 1 },
    });
    expectStatus(balanced, 201, 'acuity staffing balanced');
    expect(['hold_staffing', 'call_in', 'float_staff']).toContain(balanced.body.data.recommendation);

    const listed = await admin.get('/api/v1/admin/clinical-ai/acuity-staffing/forecasts');
    expectStatus(listed, 200, 'list acuity staffing forecasts');
    expect(listed.body.data.forecasts.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/acuity-staffing/forecasts/${crisis.body.data.forecast_id}`)
      .send({ decision: 'accepted', note: 'Float pool paged [test]' });
    expectStatus(decided, 200, 'decide acuity staffing forecast');

    await admin.patch('/api/v1/admin/clinical-ai/modules/acuity_staffing_forecast').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/acuity-staffing/evaluate').send({
      unit: 'ICU-1',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('records federated learning rounds, classifies readiness, and gates by module', async () => {
    await enableModule('federated_learning_coordinator');

    const site = await admin.post('/api/v1/admin/clinical-ai/federation/sites').send({
      site_key: 'test-site-mumbai',
      display_name: 'Test Mumbai Site',
      region: 'IN',
      contact: 'ops@test-mumbai.org',
      dp_epsilon_budget: 10,
      min_cohort_size: 100,
      accepted_aggregation_methods: ['fed_avg', 'differential_fed_avg'],
    });
    expectStatus(site, 201, 'federation site upsert');
    expect(site.body.data.site_key).toBe('test-site-mumbai');

    const ready = await admin.post('/api/v1/admin/clinical-ai/federation/rounds').send({
      round_key: 'round-2026-04-23-1',
      model_key: 'test-readmission-model',
      aggregation_method: 'differential_fed_avg',
      participant_site_count: 5,
      min_participants: 3,
      total_dp_epsilon_spent: 2,
      total_dp_epsilon_budget: 10,
      cohort_total_size: 1000,
      cohort_min_site_size: 200,
      site_min_floor: 100,
      data_drift_score: 0.05,
    });
    expectStatus(ready, 201, 'federation round ready');
    expect(ready.body.data.module_key).toBe('federated_learning_coordinator');
    expect(ready.body.data.recommendation).toBe('ready');

    const abort = await admin.post('/api/v1/admin/clinical-ai/federation/rounds').send({
      round_key: 'round-2026-04-23-2',
      model_key: 'test-readmission-model',
      aggregation_method: 'fed_avg',
      participant_site_count: 5,
      min_participants: 3,
      total_dp_epsilon_spent: 12,
      total_dp_epsilon_budget: 10,
      cohort_total_size: 1000,
      cohort_min_site_size: 200,
      site_min_floor: 100,
      data_drift_score: 0.05,
    });
    expectStatus(abort, 201, 'federation round abort');
    expect(abort.body.data.recommendation).toBe('abort');
    expect(abort.body.data.severity).toBe('critical');

    const listed = await admin.get('/api/v1/admin/clinical-ai/federation/rounds');
    expectStatus(listed, 200, 'list federation rounds');
    expect(listed.body.data.rounds.length).toBeGreaterThanOrEqual(2);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/federation/rounds/${abort.body.data.round_id}`)
      .send({ decision: 'accepted', note: 'Abort confirmed [test]' });
    expectStatus(decided, 200, 'decide federation round');

    await admin.patch('/api/v1/admin/clinical-ai/modules/federated_learning_coordinator').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/federation/rounds').send({
      round_key: 'x', model_key: 'y',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('classifies voice/IVR sessions with consent + PHI + urgent checks, and gates by module', async () => {
    await enableModule('voice_patient_assistant_ivr');

    const allow = await admin.post('/api/v1/admin/clinical-ai/voice-ivr/evaluate').send({
      patient_uid: PATIENT_UID,
      intent: 'meds',
      channel: 'ivr',
      language: 'en',
      script_key: 'meds_reminder_v1',
      consent_ref: consentReference,
      consent_fresh: true,
      transcript_text: 'Can you remind me about my medication schedule?',
      candidate_response: 'Please take your evening tablet at 9pm.',
    });
    expectStatus(allow, 201, 'voice IVR allow');
    expect(allow.body.data.module_key).toBe('voice_patient_assistant_ivr');
    expect(allow.body.data.recommendation).toBe('allow');
    expect(allow.body.data.draft.consent_reference_verified).toBe(true);

    const invalidConsent = await admin.post('/api/v1/admin/clinical-ai/voice-ivr/evaluate').send({
      patient_uid: PATIENT_UID,
      intent: 'meds',
      channel: 'ivr',
      language: 'en',
      script_key: 'meds_reminder_v1',
      consent_ref: 'consent:test:1',
      consent_fresh: true,
      transcript_text: 'Routine medication reminder.',
      candidate_response: 'Please take your evening tablet at 9pm.',
    });
    expectStatus(invalidConsent, 201, 'voice IVR invalid consent blocks visibly');
    expect(invalidConsent.body.data.recommendation).toBe('block');
    expect(invalidConsent.body.data.draft.consent_reference_verified).toBe(false);
    expect(invalidConsent.body.data.safety_flags.some((flag) => flag.code === 'CLINICAL_AI_VOICE_IVR_CONSENT_REFERENCE_INVALID')).toBe(true);

    const escalate = await admin.post('/api/v1/admin/clinical-ai/voice-ivr/evaluate').send({
      patient_uid: PATIENT_UID,
      intent: 'aftercare',
      channel: 'ivr',
      language: 'en',
      script_key: 'aftercare_v1',
      consent_ref: consentReference,
      consent_fresh: true,
      transcript_text: 'I have severe chest pain and difficulty breathing',
      candidate_response: 'Take rest and continue medications.',
    });
    expectStatus(escalate, 201, 'voice IVR escalate');
    expect(escalate.body.data.recommendation).toBe('escalate_to_clinician');
    expect(escalate.body.data.severity).toBe('high');

    const block = await admin.post('/api/v1/admin/clinical-ai/voice-ivr/evaluate').send({
      patient_uid: PATIENT_UID,
      intent: 'reminder',
      channel: 'ivr',
      language: 'en',
      script_key: 'reminder_v1',
      consent_ref: null,
      consent_fresh: false,
      transcript_text: 'ok',
      candidate_response: 'ok',
    });
    expectStatus(block, 201, 'voice IVR block consent missing');
    expect(block.body.data.recommendation).toBe('block');

    const listed = await admin.get(`/api/v1/admin/clinical-ai/voice-ivr/sessions?patient_uid=${PATIENT_UID}`);
    expectStatus(listed, 200, 'list voice IVR sessions');
    expect(listed.body.data.sessions.length).toBeGreaterThanOrEqual(4);

    const decided = await admin
      .patch(`/api/v1/admin/clinical-ai/voice-ivr/sessions/${escalate.body.data.session_id}`)
      .send({ decision: 'accepted', note: 'Paged on-call clinician [test]' });
    expectStatus(decided, 200, 'decide voice IVR session');

    await admin.patch('/api/v1/admin/clinical-ai/modules/voice_patient_assistant_ivr').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/voice-ivr/evaluate').send({
      patient_uid: PATIENT_UID,
      intent: 'meds',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('audits ICU ventilator bundle + SBT readiness and gates by module', async () => {
    await enableModule('icu_ventilator_sedation_bundle');

    // Seed ventilator-related notes/orders (overlay existing admission)
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_notes
         (encounter_id, patient_uid, author_uid, author_role, note_type, content, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'NURSE', 'icu_flowsheet',
               $4::jsonb, NOW() - INTERVAL '2 hours')`,
      ENCOUNTER_ID, PATIENT_UID, DOCTOR_UID,
      JSON.stringify({
        summary: 'Patient intubated and on mechanical ventilation. Head of bed elevated 30 degrees. Oral care with chlorhexidine performed. SAT done. RASS -2. CAM-ICU negative. FiO2 40%, PEEP 6.',
      })
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_orders
         (order_number, encounter_id, patient_uid, order_type, priority, details, status, ordered_by, created_at)
       VALUES ('ORD-ICU-VENT', $1::uuid, $2::uuid, 'medication', 'routine',
               $3::jsonb, 'active', $4::uuid, NOW() - INTERVAL '4 hours')`,
      ENCOUNTER_ID, PATIENT_UID,
      JSON.stringify({ medication_name: 'Enoxaparin', dose: '40 mg', route: 'sc', frequency: 'daily' }),
      DOCTOR_UID
    );

    const audited = await admin.post('/api/v1/admin/clinical-ai/icu-ventilator-bundle/audits').send({
      admission_id: admissionId,
    });
    expectStatus(audited, 201, 'ICU ventilator audit');
    expect(audited.body.data.module_key).toBe('icu_ventilator_sedation_bundle');
    expect(audited.body.data.audit_id).toBeTruthy();
    expect(typeof audited.body.data.draft.compliance_score).toBe('number');
    expect(['low', 'moderate', 'high', 'critical']).toContain(audited.body.data.draft.risk_band);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/icu-ventilator-bundle/audits?admission_id=${admissionId}`);
    expectStatus(listed, 200, 'list ICU audits');
    expect(listed.body.data.audits.length).toBeGreaterThan(0);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/icu-ventilator-bundle/audits/${audited.body.data.audit_id}`).send({
      decision: 'accepted',
      note: 'Reviewed by ICU team [test]',
    });
    expectStatus(accepted, 200, 'accept ICU audit');

    await admin.patch('/api/v1/admin/clinical-ai/modules/icu_ventilator_sedation_bundle').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/icu-ventilator-bundle/audits').send({
      admission_id: admissionId,
    });
    expect(blocked.statusCode).toBe(403);
  }, LONG_CLINICAL_AI_TEST_TIMEOUT_MS);

  it('forecasts blood bank demand + stockout risk and gates by module', async () => {
    await enableModule('blood_bank_demand_forecast');

    // Seed inventory
    const inventoryItems = [
      { blood_group: 'O-', component: 'packed_red_cells', units_available: 8, minimum_stock_level: 4 },
      { blood_group: 'O+', component: 'packed_red_cells', units_available: 2, minimum_stock_level: 4 },
      { blood_group: 'AB+', component: 'ffp', units_available: 5, minimum_stock_level: 2 },
      { blood_group: 'O+', component: 'platelets', units_available: 3, minimum_stock_level: 2 },
    ];
    for (const item of inventoryItems) {
      const result = await admin.post('/api/v1/admin/clinical-ai/blood-bank/inventory').send(item);
      expectStatus(result, 201, `upsert inventory ${item.blood_group}/${item.component}`);
    }

    const inventoryList = await admin.get('/api/v1/admin/clinical-ai/blood-bank/inventory');
    expectStatus(inventoryList, 200, 'list blood bank inventory');
    expect(inventoryList.body.data.inventory.length).toBe(4);

    const forecast = await admin.post('/api/v1/admin/clinical-ai/blood-bank/forecast').send({
      forecast_window_hours: 24,
    });
    expectStatus(forecast, 201, 'blood bank forecast');
    expect(forecast.body.data.module_key).toBe('blood_bank_demand_forecast');
    expect(forecast.body.data.review_id).toBeTruthy();
    expect(Array.isArray(forecast.body.data.draft.stockout_risks)).toBe(true);
    expect(Array.isArray(forecast.body.data.draft.predicted_demand)).toBe(true);
    expect(forecast.body.data.draft.mtp_readiness).toBeDefined();

    const listed = await admin.get('/api/v1/admin/clinical-ai/blood-bank/forecasts');
    expectStatus(listed, 200, 'list blood bank forecasts');
    expect(listed.body.data.forecasts.length).toBeGreaterThan(0);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/blood-bank/forecasts/${forecast.body.data.review_id}`).send({
      decision: 'accepted',
      note: 'Reviewed by blood bank [test]',
    });
    expectStatus(accepted, 200, 'accept forecast');

    await admin.patch('/api/v1/admin/clinical-ai/modules/blood_bank_demand_forecast').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/blood-bank/forecast').send({ forecast_window_hours: 24 });
    expect(blocked.statusCode).toBe(403);
  }, LONG_CLINICAL_AI_TEST_TIMEOUT_MS);

  it('evaluates obstetric risk with preeclampsia + PPH signals and gates by module', async () => {
    await enableModule('obstetric_risk_assistant');

    // Severe preeclampsia: SBP 170, DBP 115 at 28 weeks
    const severe = await admin.post('/api/v1/admin/clinical-ai/obstetric-risk/evaluate').send({
      patient_uid: PATIENT_UID,
      gestational_age_weeks: 28,
      gravida: 2,
      parity: 1,
      age_years: 32,
      prior_conditions: ['chronic hypertension'],
      current_conditions: [],
      vitals: { systolic_bp: 170, diastolic_bp: 115, heart_rate: 92 },
      labs: { urine_protein: '3+' },
      symptoms: ['headache', 'proteinuria'],
    });
    expectStatus(severe, 201, 'severe preeclampsia assessment');
    expect(severe.body.data.module_key).toBe('obstetric_risk_assistant');
    expect(severe.body.data.assessment_id).toBeTruthy();
    expect(severe.body.data.draft.risk_band).toBe('critical');
    expect(severe.body.data.draft.red_flag_signals.some((flag) => flag.code === 'SEVERE_PREECLAMPSIA')).toBe(true);

    // Low-risk routine ANC at 12 weeks
    const routine = await admin.post('/api/v1/admin/clinical-ai/obstetric-risk/evaluate').send({
      patient_uid: PATIENT_UID,
      gestational_age_weeks: 12,
      gravida: 1,
      parity: 0,
      age_years: 26,
      vitals: { systolic_bp: 110, diastolic_bp: 70, heart_rate: 78 },
      symptoms: [],
    });
    expectStatus(routine, 201, 'routine obstetric assessment');
    expect(['low', 'moderate']).toContain(routine.body.data.draft.risk_band);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/obstetric-risk/assessments?patient_uid=${PATIENT_UID}`);
    expectStatus(listed, 200, 'list obstetric assessments');
    expect(listed.body.data.assessments.length).toBeGreaterThanOrEqual(2);

    const escalated = await admin.patch(`/api/v1/admin/clinical-ai/obstetric-risk/assessments/${severe.body.data.assessment_id}`).send({
      decision: 'escalated',
      note: 'Admit for MgSO4 + BP control [test]',
    });
    expectStatus(escalated, 200, 'escalate obstetric assessment');

    await admin.patch('/api/v1/admin/clinical-ai/modules/obstetric_risk_assistant').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/obstetric-risk/evaluate').send({
      patient_uid: PATIENT_UID,
      gestational_age_weeks: 20,
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('predicts ED triage level + boarding risk and gates by module', async () => {
    await enableModule('ed_triage_boarding_predictor');

    // Critical arrival — SpO2 85, hypotension
    const critical = await admin.post('/api/v1/admin/clinical-ai/ed-triage/evaluate').send({
      chief_complaint: 'Severe shortness of breath, cyanosis',
      arrival_mode: 'ambulance',
      age_years: 72,
      vitals: { spo2: 82, systolic_bp: 85, heart_rate: 140, respiratory_rate: 32 },
      pain_score: 9,
    });
    expectStatus(critical, 201, 'critical ED triage evaluation');
    expect(critical.body.data.module_key).toBe('ed_triage_boarding_predictor');
    expect(critical.body.data.draft.triage_level).toBe(1);
    expect(['icu', 'admission']).toContain(critical.body.data.draft.predicted_disposition);
    expect(critical.body.data.safety_flags.length).toBeGreaterThan(0);

    // Low-acuity walk-in
    const mild = await admin.post('/api/v1/admin/clinical-ai/ed-triage/evaluate').send({
      chief_complaint: 'Mild cough for two days, requesting medication refill',
      arrival_mode: 'walk_in',
      age_years: 28,
      vitals: { spo2: 99, systolic_bp: 120, heart_rate: 72, respiratory_rate: 16, temperature: 36.8 },
      pain_score: 1,
    });
    expectStatus(mild, 201, 'mild ED triage evaluation');
    expect(mild.body.data.draft.triage_level).toBeGreaterThanOrEqual(4);

    const listed = await admin.get('/api/v1/admin/clinical-ai/ed-triage/predictions?triage_level=1');
    expectStatus(listed, 200, 'list ED predictions');
    expect(listed.body.data.predictions.length).toBeGreaterThan(0);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/ed-triage/predictions/${critical.body.data.prediction_id}`).send({
      decision: 'accepted',
      note: 'Reviewed by charge nurse [test]',
    });
    expectStatus(accepted, 200, 'accept ED triage');
    expect(accepted.body.data.reviewer_decision).toBe('accepted');

    // Disabled-module gating
    await admin.patch('/api/v1/admin/clinical-ai/modules/ed_triage_boarding_predictor').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/ed-triage/evaluate').send({
      chief_complaint: 'test',
    });
    expect(blocked.statusCode).toBe(403);

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=500');
    expectStatus(audit, 200, 'ED triage audit');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_ED_TRIAGE_PREDICTED');
    expect(actions).toContain('CLINICAL_AI_ED_TRIAGE_REVIEWED');
  });

  it('classifies staff burnout risk with workload metrics and gates by module', async () => {
    await enableModule('staff_burnout_workload_risk');

    const denied = await doctor.get('/api/v1/admin/clinical-ai/staff-burnout/reviews');
    expectStatus(denied, 403, 'doctor denied staff burnout admin list');

    // Evaluate without shift data → should return insufficient_data (NO_SHIFT_DATA signal)
    const evaluated = await admin.post('/api/v1/admin/clinical-ai/staff-burnout/evaluate').send({
      staff_uid: DOCTOR_UID,
      window_days: 30,
    });
    expectStatus(evaluated, 201, 'evaluate staff burnout');
    const body = evaluated.body.data;
    expect(body.module_key).toBe('staff_burnout_workload_risk');
    expect(body.review_id).toBeTruthy();
    expect(body.draft.risk_band).toBeTruthy();
    expect(typeof body.draft.risk_score).toBe('number');
    expect(Array.isArray(body.draft.contributing_signals)).toBe(true);
    expect(Array.isArray(body.draft.recommended_actions)).toBe(true);
    expect(body.safety_flags.some((flag) => flag.code === 'STAFF_PRIVACY_NOTICE')).toBe(true);
    // Privacy reminder must always be present (as either a safety flag or a recommended action)
    expect(
      body.draft.recommended_actions.some((line) => /(workload risk signal only|performance or disciplinary)/i.test(line))
      || body.safety_flags.some((flag) => /(workload risk signal only|performance or disciplinary)/i.test(flag.message || ''))
    ).toBe(true);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/staff-burnout/reviews?staff_uid=${DOCTOR_UID}`);
    expectStatus(listed, 200, 'list staff burnout reviews');
    expect(listed.body.data.reviews.length).toBeGreaterThan(0);

    const reviewed = await admin.patch(`/api/v1/admin/clinical-ai/staff-burnout/reviews/${body.review_id}`).send({
      decision: 'accepted',
      note: 'Reviewed by HR [test]',
    });
    expectStatus(reviewed, 200, 'accept staff burnout review');
    expect(reviewed.body.data.reviewer_decision).toBe('accepted');

    // Disabled-module gating
    await admin.patch('/api/v1/admin/clinical-ai/modules/staff_burnout_workload_risk').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/staff-burnout/evaluate').send({
      staff_uid: DOCTOR_UID,
      window_days: 30,
    });
    expect(blocked.statusCode).toBe(403);

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=500');
    expectStatus(audit, 200, 'staff burnout audit');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_STAFF_BURNOUT_EVALUATED');
    expect(actions).toContain('CLINICAL_AI_STAFF_BURNOUT_REVIEWED');
  });

  it('classifies pediatric dose safety across safe / caution / unsafe and gates by module', async () => {
    await enableModule('pediatric_dosing_safety');

    // Safe amoxicillin dose for a 3y toddler (~15 kg): 90 mg/kg/day = 1350 mg
    const safe = await admin.post('/api/v1/admin/clinical-ai/pediatric-dose-checks/evaluate').send({
      patient_uid: PATIENT_UID,
      medication_name: 'Amoxicillin',
      prescribed_dose_mg: 500,
      prescribed_route: 'oral',
      prescribed_frequency: 'TID',
      age_days_override: 1100,
      weight_kg_override: 15,
    });
    expectStatus(safe, 201, 'safe pediatric dose');
    expect(safe.body.data.safety_band).toBe('safe');
    expect(safe.body.data.check_id).toBeTruthy();
    expect(safe.body.data.calculated_max_dose_mg).toBeGreaterThan(500);

    // Unsafe: 2000 mg in a 15 kg toddler exceeds 1350 mg max
    const unsafe = await admin.post('/api/v1/admin/clinical-ai/pediatric-dose-checks/evaluate').send({
      patient_uid: PATIENT_UID,
      medication_name: 'Amoxicillin',
      prescribed_dose_mg: 2000,
      prescribed_route: 'oral',
      age_days_override: 1100,
      weight_kg_override: 15,
    });
    expectStatus(unsafe, 201, 'unsafe pediatric dose');
    expect(unsafe.body.data.safety_band).toBe('unsafe');
    expect(unsafe.body.data.safety_flags.some((flag) => flag.code === 'PEDIATRIC_DOSE_UNSAFE')).toBe(true);

    // Missing data: no weight override + no patient vitals row means calculation impossible
    const missing = await admin.post('/api/v1/admin/clinical-ai/pediatric-dose-checks/evaluate').send({
      patient_uid: PATIENT_UID,
      medication_name: 'Amoxicillin',
      prescribed_dose_mg: 400,
      age_days_override: 1100,
      // no weight override
    });
    expectStatus(missing, 201, 'missing data pediatric dose');
    expect(missing.body.data.safety_band).toBe('missing_data');

    const listed = await admin.get(`/api/v1/admin/clinical-ai/pediatric-dose-checks?patient_uid=${PATIENT_UID}`);
    expectStatus(listed, 200, 'list pediatric dose checks');
    expect(listed.body.data.checks.length).toBeGreaterThanOrEqual(3);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/pediatric-dose-checks/${unsafe.body.data.check_id}`).send({
      decision: 'rejected',
      note: 'Dose reduced by doctor [test]',
    });
    expectStatus(accepted, 200, 'reject unsafe pediatric dose');
    expect(accepted.body.data.reviewer_decision).toBe('rejected');

    // Disabled-module gating
    await admin.patch('/api/v1/admin/clinical-ai/modules/pediatric_dosing_safety').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/pediatric-dose-checks/evaluate').send({
      patient_uid: PATIENT_UID,
      medication_name: 'Amoxicillin',
      prescribed_dose_mg: 500,
      age_days_override: 1100,
      weight_kg_override: 15,
    });
    expect(blocked.statusCode).toBe(403);

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=500');
    expectStatus(audit, 200, 'pediatric dose audit');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_PEDIATRIC_DOSE_EVALUATED');
    expect(actions).toContain('CLINICAL_AI_PEDIATRIC_DOSE_REVIEWED');
  });

  it('evaluates lab autoverification with critical band + delta, and gates by module', async () => {
    await enableModule('lab_autoverification_delta');

    // Seed a prior potassium result so delta is computed
    await prisma.$executeRawUnsafe(
      `INSERT INTO investigations
         (uid, patient_uid, phone, test_name, status, priority, result_summary,
          structured_results, requested_by, requested_at, completed_at,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, '9000091001', 'Serum Potassium', 'COMPLETED', 'ROUTINE',
               'K 4.1 mmol/L (normal)',
               '{"value": 4.1, "units": "mmol/L"}'::jsonb,
               $2::uuid, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days',
               NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')`,
      PATIENT_UID, DOCTOR_UID
    );

    // Current potassium at a critical_high value
    const current = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (uid, patient_uid, phone, test_name, status, priority, result_summary,
          structured_results, requested_by, requested_at, completed_at,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, '9000091001', 'Serum Potassium', 'COMPLETED', 'URGENT',
               'K 7.2 mmol/L (critical high)',
               '{"value": 7.2, "units": "mmol/L"}'::jsonb,
               $2::uuid, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes',
               NOW() - INTERVAL '1 hour', NOW())
       RETURNING id`,
      PATIENT_UID, DOCTOR_UID
    );
    const investigationId = current[0].id;

    const deniedList = await doctor.get('/api/v1/admin/clinical-ai/lab-autoverifications');
    expectStatus(deniedList, 403, 'doctor denied lab autoverification admin list');

    const evaluated = await admin.post('/api/v1/admin/clinical-ai/lab-autoverifications/evaluate').send({
      investigation_id: investigationId,
    });
    expectStatus(evaluated, 201, 'evaluate lab autoverification');
    const body = evaluated.body.data;
    expect(body.module_key).toBe('lab_autoverification_delta');
    expect(body.review_id).toBeTruthy();
    expect(body.critical_band).toBe('critical_high');
    expect(body.decision).toBe('critical');
    expect(Array.isArray(body.draft.suggested_actions)).toBe(true);
    expect(body.draft.suggested_actions.length).toBeGreaterThan(0);
    expect(body.source_citations.length).toBeGreaterThan(0);
    expect(body.safety_flags.some((flag) => flag.code === 'LAB_CRITICAL_VALUE')).toBe(true);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/lab-autoverifications?critical_band=critical_high`);
    expectStatus(listed, 200, 'list lab autoverifications');
    expect(listed.body.data.autoverifications.length).toBeGreaterThan(0);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/lab-autoverifications/${body.review_id}`).send({
      decision: 'accepted',
      note: 'Reviewed by lab [test]',
    });
    expectStatus(accepted, 200, 'accept lab autoverification');
    expect(accepted.body.data.reviewer_decision).toBe('accepted');

    // Disabled-module gating
    await admin.patch('/api/v1/admin/clinical-ai/modules/lab_autoverification_delta').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/lab-autoverifications/evaluate').send({
      investigation_id: investigationId,
    });
    expect(blocked.statusCode).toBe(403);

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=400');
    expectStatus(audit, 200, 'lab autoverification audit logs');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_LAB_AUTOVERIFICATION_EVALUATED');
    expect(actions).toContain('CLINICAL_AI_LAB_AUTOVERIFICATION_REVIEWED');
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

  it('generates, flags, and reviews nursing ambient shift documentation', async () => {
    await enableModule('nursing_ambient_documentation');

    const transcript = [
      { speaker: 'nurse', text: 'Starting my day shift rounds on bed A-12.', start_seconds: 0, end_seconds: 5 },
      { speaker: 'nurse', text: 'Wound dressing on right hip changed, no signs of infection.', start_seconds: 5, end_seconds: 12 },
      { speaker: 'nurse', text: 'JP drain emptied 40 ml of serosanguinous fluid.', start_seconds: 12, end_seconds: 20 },
      { speaker: 'nurse', text: 'IV line on left forearm flushed with saline and patent.', start_seconds: 20, end_seconds: 28 },
      { speaker: 'nurse', text: 'Intake 500 ml in oral fluids; urine output 300 ml out clear.', start_seconds: 28, end_seconds: 38 },
      { speaker: 'nurse', text: 'Patient ambulated to the bathroom with walker assistance.', start_seconds: 38, end_seconds: 46 },
      { speaker: 'nurse', text: 'Patient fell while trying to stand; complains of bruised arm.', start_seconds: 46, end_seconds: 58 },
      { speaker: 'patient', text: 'I felt very dizzy when I stood up.', start_seconds: 58, end_seconds: 63 },
      { speaker: 'nurse', text: 'Handover to next shift: monitor fall risk and antibiotics.', start_seconds: 63, end_seconds: 72 },
    ];

    const deniedListing = await doctor.get('/api/v1/admin/clinical-ai/nursing-ambient/sessions');
    expectStatus(deniedListing, 403, 'doctor denied nursing ambient admin list');

    const blockedConsent = await admin.post('/api/v1/admin/clinical-ai/nursing-ambient/sessions').send({
      patient_uid: PATIENT_UID,
      admission_id: admissionId,
      shift: 'day',
      recording_started_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      recording_ended_at: new Date().toISOString(),
      consent_reference: 'nursing-consent-test',
      transcript_segments: transcript,
    });
    expectStatus(blockedConsent, 400, 'block nursing ambient invalid consent reference');
    expect(blockedConsent.body.code).toBe('CLINICAL_AI_NURSING_AMBIENT_CONSENT_REFERENCE_INVALID');

    const generated = await admin.post('/api/v1/admin/clinical-ai/nursing-ambient/sessions').send({
      patient_uid: PATIENT_UID,
      admission_id: admissionId,
      shift: 'day',
      recording_started_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      recording_ended_at: new Date().toISOString(),
      consent_reference: consentReference,
      transcript_segments: transcript,
    });
    expectStatus(generated, 201, 'generate nursing ambient session');
    const body = generated.body.data;
    expect(body.module_key).toBe('nursing_ambient_documentation');
    expect(body.session_id).toBeTruthy();
    expect(body.generation_id).toBeTruthy();
    expect(body.shift).toBe('day');
    expect(body.draft.wounds.length).toBeGreaterThan(0);
    expect(body.draft.drains.length).toBeGreaterThan(0);
    expect(body.draft.iv_lines.length).toBeGreaterThan(0);
    expect(body.draft.falls.length).toBeGreaterThan(0);
    expect(body.draft.handover_notes.length).toBeGreaterThan(0);
    expect(body.draft.intake_output.total_intake_ml).toBe(500);
    expect(body.draft.intake_output.total_output_ml).toBe(300);
    expect(body.draft.intake_output.balance_ml).toBe(200);
    expect(body.safety_flags.some((flag) => flag.code === 'NURSING_FALL_DETECTED' || flag.code === 'NURSING_FALL_WITH_INJURY')).toBe(true);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/nursing-ambient/sessions?admission_id=${admissionId}`);
    expectStatus(listed, 200, 'list nursing ambient sessions');
    expect(listed.body.data.sessions.length).toBeGreaterThan(0);

    const sessionId = body.session_id;
    const edited = await admin.patch(`/api/v1/admin/clinical-ai/nursing-ambient/sessions/${sessionId}`).send({
      decision: 'edited',
      note: 'Reviewed and edited by admin [test]',
    });
    expectStatus(edited, 200, 'edit nursing ambient session');
    expect(edited.body.data.reviewer_decision).toBe('edited');

    const viaDoctor = await doctor.post(`/api/v1/emr/${admissionId}/ai/nursing-ambient`).send({
      patient_uid: PATIENT_UID,
      shift: 'night',
      consent_reference: consentReference,
      transcript_segments: [
        { speaker: 'nurse', text: 'Quiet night; patient slept well.', start_seconds: 0, end_seconds: 5 },
      ],
    });
    expectStatus(viaDoctor, 201, 'doctor EMR-route nursing ambient generation');
    expect(viaDoctor.body.data.shift).toBe('night');

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=300');
    expectStatus(audit, 200, 'nursing ambient audit logs');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_NURSING_AMBIENT_SESSION_GENERATED');
    expect(actions).toContain('CLINICAL_AI_NURSING_AMBIENT_REVIEWED');
  });

  it('drafts, scrubs, reviews, and sends a consent-aware family update', async () => {
    await enableModule('consent_aware_family_update');

    const generated = await admin.post('/api/v1/admin/clinical-ai/family-updates').send({
      patient_uid: PATIENT_UID,
      admission_id: admissionId,
      caregiver_identifier: 'Spouse (9000091001)',
      caregiver_relationship: 'spouse',
      language: 'en',
    });
    expectStatus(generated, 201, 'generate family update');
    const body = generated.body.data;
    expect(body.module_key).toBe('consent_aware_family_update');
    expect(body.update_id).toBeTruthy();
    expect(body.generation_id).toBeTruthy();
    expect(body.language).toBe('en');
    expect(body.caregiver_relationship).toBe('spouse');
    expect(body.draft.plain_language_summary).toBeTruthy();
    expect(body.draft.current_status).toBeTruthy();
    expect(body.draft.next_steps).toBeTruthy();
    expect(body.draft.when_to_worry).toBeTruthy();
    expect(Array.isArray(body.draft.questions_you_may_have)).toBe(true);
    expect(body.consent_scope.length).toBeGreaterThan(0);
    expect(Array.isArray(body.source_citations)).toBe(true);
    expect(Array.isArray(body.safety_flags)).toBe(true);
    const draftCorpus = [
      body.draft.plain_language_summary,
      body.draft.current_status,
      body.draft.next_steps,
      body.draft.when_to_worry,
    ].join(' ');
    expect(draftCorpus).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g)\b/i);

    const listed = await admin.get(`/api/v1/admin/clinical-ai/family-updates?admission_id=${admissionId}`);
    expectStatus(listed, 200, 'list family updates');
    expect(listed.body.data.updates.length).toBeGreaterThan(0);

    const updateId = body.update_id;

    const prematureSend = await admin.post(`/api/v1/admin/clinical-ai/family-updates/${updateId}/sent`).send({});
    expect(prematureSend.statusCode).toBeGreaterThanOrEqual(400);

    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/family-updates/${updateId}`).send({
      decision: 'accepted',
      note: 'Reviewed by admin [test]',
    });
    expectStatus(accepted, 200, 'accept family update');
    expect(accepted.body.data.reviewer_decision).toBe('accepted');
    expect(accepted.body.data.update_status).toBe('ready_to_send');

    const sent = await admin.post(`/api/v1/admin/clinical-ai/family-updates/${updateId}/sent`).send({
      delivery_channel: 'sms',
    });
    expectStatus(sent, 200, 'mark family update sent');
    expect(sent.body.data.update_status).toBe('sent');
    expect(sent.body.data.delivery_channel).toBe('sms');

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=300');
    expectStatus(audit, 200, 'family update audit logs');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_FAMILY_UPDATE_GENERATED');
    expect(actions).toContain('CLINICAL_AI_FAMILY_UPDATE_REVIEWED');
    expect(actions).toContain('CLINICAL_AI_FAMILY_UPDATE_SENT');
  });

  it('blocks family update generation when module is disabled', async () => {
    await admin.patch('/api/v1/admin/clinical-ai/modules/consent_aware_family_update').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/family-updates').send({
      patient_uid: PATIENT_UID,
      admission_id: admissionId,
      caregiver_relationship: 'spouse',
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('blocks nursing ambient generation when module is disabled', async () => {
    await admin.patch('/api/v1/admin/clinical-ai/modules/nursing_ambient_documentation').send({ enabled: false });
    const blocked = await admin.post('/api/v1/admin/clinical-ai/nursing-ambient/sessions').send({
      patient_uid: PATIENT_UID,
      admission_id: admissionId,
      transcript_segments: [],
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('computes and snapshots AI ROI metrics across modules', async () => {
    const denied = await doctor.get('/api/v1/admin/clinical-ai/roi');
    expectStatus(denied, 403, 'ROI denied for doctor');

    const live = await admin.get('/api/v1/admin/clinical-ai/roi?period_days=30');
    expectStatus(live, 200, 'compute live ROI metrics');
    const metrics = live.body.data;
    expect(metrics.period_days).toBe(30);
    expect(metrics.read_only).toBe(true);
    expect(metrics.decision_support_only).toBe(true);
    expect(Array.isArray(metrics.by_module)).toBe(true);
    expect(typeof metrics.generation_count).toBe('number');
    expect(typeof metrics.acceptance_rate_pct).toBe('number');
    expect(typeof metrics.time_saved_minutes).toBe('number');
    expect(typeof metrics.cost_per_useful_draft_minor).toBe('number');
    expect(Array.isArray(metrics.highlights)).toBe(true);

    const saved = await admin.post('/api/v1/admin/clinical-ai/roi/snapshots').send({ period_days: 30 });
    expectStatus(saved, 201, 'save ROI snapshot');
    expect(saved.body.data.snapshot).toBeTruthy();
    expect(saved.body.data.snapshot.module_key).toBe('ALL');
    expect(saved.body.data.snapshot.period_days).toBe(30);
    expect(typeof saved.body.data.snapshot.generation_count).toBe('number');

    const history = await admin.get('/api/v1/admin/clinical-ai/roi/snapshots?limit=10');
    expectStatus(history, 200, 'list ROI snapshots');
    expect(history.body.data.snapshots.length).toBeGreaterThan(0);

    const latest = await admin.get('/api/v1/admin/clinical-ai/roi/snapshots/latest?module_key=ALL');
    expectStatus(latest, 200, 'latest ROI snapshot');
    expect(latest.body.data.snapshot).toBeTruthy();
    expect(latest.body.data.snapshot.module_key).toBe('ALL');

    const audit = await admin.get('/api/v1/admin/clinical-ai/audit?limit=250');
    expectStatus(audit, 200, 'ROI audit logs');
    const actions = audit.body.data.logs.map((row) => row.action);
    expect(actions).toContain('CLINICAL_AI_ROI_SNAPSHOT_RECORDED');
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
      reviewer_note: 'Reviewed aftercare draft before translation [test]',
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

  it('still translates a generation whose status was flipped to signed by the discharge sign workflow', async () => {
    await enableModule('patient_communication_translation');
    await enableModule('patient_aftercare_instructions');

    // Generate + accept an aftercare draft, then simulate the discharge
    // sign workflow flipping the generation status from 'accepted' to
    // 'signed' (see services/emr/dischargeSummaryGenerator.js#signDischargeSummary).
    // Translation must still be allowed — a signed generation is past
    // the reviewer-acceptance gate, so blocking it is a UX regression.
    // Finding: 2026-05-10-surgical-day-care-discharge-tamil-translation-blocked-after-sign.
    const aftercare = await doctor.post(`/api/v1/emr/${admissionId}/aftercare-instructions`).send({});
    expectStatus(aftercare, 200, 'signed-source aftercare draft');
    const generationId = aftercare.body.data.generation_id;

    const reviews = await admin.get(`/api/v1/admin/clinical-ai/reviews?module_key=patient_aftercare_instructions`);
    expectStatus(reviews, 200, 'list signed-source reviews');
    const review = reviews.body.data.reviews.find((row) => row.generation_id === generationId);
    expect(review).toBeTruthy();
    const accepted = await admin.patch(`/api/v1/admin/clinical-ai/reviews/${review.id}`).send({
      decision: 'accepted',
      edited_draft: aftercare.body.data.draft,
      reviewer_note: 'Reviewed signed aftercare draft before translation [test]',
    });
    expectStatus(accepted, 200, 'accept signed-source review');

    await prisma.$executeRawUnsafe(
      `UPDATE clinical_ai_generations SET status = 'signed', updated_at = NOW() WHERE id = $1`,
      generationId
    );

    const translated = await doctor.post(`/api/v1/emr/generations/${generationId}/translate`).send({
      target_language: 'ta',
    });
    expectStatus(translated, 200, 'tamil translation of signed generation');
    expect(translated.body.data.target_language).toBe('ta');

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
      const toggled = await patchGlobalModule(
        'soap_from_dictation',
        { enabled: true },
        'enable soap_from_dictation'
      );
      expectStatus(toggled, 200, 'enable soap_from_dictation');

      const config = await doctor.get('/api/v1/clinical/voice-note/config');
      expectStatus(config, 200, 'voice note config');
      expect(config.body.data.voice_note).toEqual(expect.objectContaining({
        module_key: 'soap_from_dictation',
        audio_capture_allowed: true,
        human_review_required: true,
        patient_dispatch_allowed: false,
      }));

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
