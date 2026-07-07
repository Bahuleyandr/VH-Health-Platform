/**
 * Clinical-use routes — the point-of-care surface.
 *
 * Mounted at /api/v1/clinical-ai/clinical/*. Gated by
 * requireClinicalAiUse (clinical roles + ADMIN/SUPER_ADMIN; see
 * CLINICAL_AI_USER_ROLES_LIST in shared.js).
 *
 * This is what the apps/staff Flutter app + Flutter web build will
 * call. It deliberately DOES NOT expose governance, model registry,
 * audit, or break-glass — those stay on /api/v1/clinical-ai/control/*
 * (alias of the existing /api/v1/admin/clinical-ai/*).
 *
 * Phase 0 of the clinical-AI rollout plan
 * (docs/CLINICAL_AI_ROLLOUT_PLAN.md). The endpoints below are the
 * minimum-viable clinician surface; later phases will expand it as
 * Flutter screens are built (Phase 2).
 *
 * Endpoints exposed:
 *
 *   POST /admission-ai-draft
 *     Generate a draft for one of the ADMISSION_MODULES against an
 *     admission. Mirrors the existing admin endpoint but the audit
 *     event records the clinician role and the route family.
 *
 *   POST /discharge-compose
 *   GET  /discharge-compose
 *   GET  /discharge-compose/:runId
 *   POST /discharge-compose/:runId/resume
 *     Same shapes as /api/v1/admin/clinical-ai/discharge-compose/*
 *     (see dischargeComposeRoutes.js). Reused service functions; no
 *     business-logic divergence between control + clinical paths.
 *
 *   GET  /reviews
 *     List reviews where the caller's role is in the module's
 *     reviewRoles. Differs from /control/reviews which lists ALL
 *     reviews tenant-wide for governance.
 *
 *   PATCH /reviews/:id
 *     Sign / edit / reject a review. updateReview() in the workflow
 *     service does the per-module reviewRoles check internally — a
 *     DOCTOR can't sign off on a review that requires PHARMACY_STAFF.
 */

import express from 'express';
import { success, error } from '../../../utils/responseHelper.js';
import prisma from '../../../lib/prisma.js';
import { AppError } from '../../../utils/AppError.js';
import { phiAccessLogger, patientAccessGuard, patientAccessGuardForResource } from '../../../middleware/phiAccessMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../../services/security/accessDecisionService.js';
import { logClinicalAiAudit } from './audit.js';
import { requireClinicalAiUse, normalizeRole } from './shared.js';
import { generateAdmissionAiDraft, listReviews, updateReview } from '../../../services/ai/clinicalAiWorkflowService.js';
import {
  composeDischargePackage,
  getComposeGraph,
  DISCHARGE_COMPOSE_WORKFLOW_KEY,
} from '../../../services/ai/dischargeComposeService.js';
import {
  generateInvoicePatientExplanation,
  generateLabPatientExplanation,
  generatePatientReportExplanation,
  generatePrescriptionPatientExplanation,
  generateRadiologyPatientExplanation,
} from '../../../services/ai/patientExplainersService.js';
import {
  generateOpDifferentialRedFlags,
  generateOpFollowUpPlan,
  generateOpInvestigationReview,
  generateOpPrescriptionSafetyReview,
  generateOpReferralDraft,
  generateOpVisitPrep,
  listOpdAiModules,
} from '../../../services/ai/opdClinicalAssistService.js';
import { getDefaultCheckpointStore } from '../../../services/ai/workflowCheckpointStore.js';
import { resumeWorkflow } from '../../../services/ai/workflowGraphRunner.js';
import { normalizeRole as normalizePlatformRole } from '../../../utils/roles.js';
import biomedCmmsRoutes from './biomedCmmsRoutes.js';

const router = express.Router();

// Defense-in-depth: outer guard is requireRole(...CLINICAL_AI_USER_ROLES)
// at the app.js mount; this is the inner guard. Both must pass.
router.use(requireClinicalAiUse);
router.use('/biomed-cmms', biomedCmmsRoutes);

// Intra-tenant IDOR guards for the patient-explainer + discharge-compose
// entrypoints. Each resolves the patient owning the cited source row
// (tenant-scoped) and enforces the actor's care relationship before any PHI
// is read/generated. Run care-team-mode-governed (per-tenant, default
// 'shadow') to mirror exactly how the underlying PHI families are guarded in
// app.js — a tenant flipped to 'enforce' returns a real 403 for an
// out-of-relationship id; shadow logs the would-be denial. The hard
// cross-tenant guarantee is the tenant_id predicate added to each source
// SELECT (patientExplainersService.js / dischargeComposeService.js).
const guardComposeAdmission = patientAccessGuardForResource('ADMISSION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW,
  resourceType: 'admission',
  idSelector: (req) => req.body?.admission_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});
const guardLabExplainer = patientAccessGuardForResource('INVESTIGATION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_INVESTIGATION_VIEW,
  resourceType: 'investigation',
  idSelector: (req) => req.body?.investigation_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});
const guardRadiologyExplainer = patientAccessGuardForResource('RADIOLOGY', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW,
  resourceType: 'radiology_order',
  idSelector: (req) => req.body?.radiology_order_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});
const guardPrescriptionExplainer = patientAccessGuardForResource('PRESCRIPTION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW,
  resourceType: 'prescription',
  idSelector: (req) => req.body?.prescription_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});
const guardInvoiceExplainer = patientAccessGuardForResource('PRESCRIPTION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW,
  resourceType: 'invoice',
  idSelector: (req) => req.body?.invoice_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});

// CAN-010: OP AI assist endpoints accept caller-supplied patient/appointment/
// investigation ids — guard the care relationship (governed; shadow→enforce).
const guardOpPatient = patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true });
const guardOpAppointment = patientAccessGuardForResource('APPOINTMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW,
  resourceType: 'appointment',
  idSelector: (req) => req.body?.appointment_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});

function clampInt(value, { min = 1, max = 100, fallback = 25 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function auditAndReturnOpAi(req, res, eventType, result, message, statusCode = 201) {
  return Promise.resolve(
    logClinicalAiAudit(req, eventType, String(result?.generation_id || result?.review_id || 'inline'), null, {
      module_key: result?.module_key,
      generation_id: result?.generation_id || null,
      review_id: result?.review_id || null,
      review_status: result?.review_status || result?.reviewer_decision || null,
      provider: result?.provider,
      used_ai: result?.used_ai,
      safety_flag_count: Array.isArray(result?.safety_flags) ? result.safety_flags.length : 0,
      route_family: 'clinical',
      care_setting: 'opd',
      patient_facing: false,
      decision_support_only: true,
    }),
  ).then(() => success(res, result, message, statusCode));
}

const OP_AI_ASSIST_ROLES = new Set([
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'SENIOR_DOCTOR',
  'RESIDENT',
  'CMO',
  'MEDICAL_SUPERINTENDENT',
]);

function normalizedRequestRoles(req) {
  return [
    normalizePlatformRole(req.user?.role) || normalizeRole(req.user?.role),
    normalizePlatformRole(req.user?.rawRole) || normalizeRole(req.user?.rawRole),
  ].filter(Boolean);
}

function requireOpAiDoctorUse(req, res, next) {
  if (!req.user) {
    return error(res, 'Authentication required', 401, { safe: true });
  }
  if (!normalizedRequestRoles(req).some((role) => OP_AI_ASSIST_ROLES.has(role))) {
    return error(res, 'OP AI Assist is doctor-facing and requires a doctor role', 403, {
      code: 'OP_AI_DOCTOR_ROLE_REQUIRED',
      safe: true,
    });
  }
  return next();
}

// ---------------------------------------------------------------------------
// POST /admission-ai-draft — generate a draft for an admission + module
// CAN-009: guard the admission's patient relationship (mirrors discharge
// compose) before any PHI-rich context is gathered.
// ---------------------------------------------------------------------------
router.post('/admission-ai-draft', guardComposeAdmission, async (req, res, next) => {
  try {
    const admissionId = req.body?.admission_id;
    const moduleKey = req.body?.module_key;
    if (!admissionId) {
      return error(res, 'admission_id is required', 400, { code: 'ADMISSION_ID_REQUIRED' });
    }
    if (!moduleKey) {
      return error(res, 'module_key is required', 400, { code: 'MODULE_KEY_REQUIRED' });
    }

    const result = await generateAdmissionAiDraft(
      admissionId,
      moduleKey,
      req.user?.uid || null,
      req
    );

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ADMISSION_DRAFT_GENERATED',
      String(result.generation_id || admissionId),
      null,
      {
        admission_id: admissionId,
        module_key: moduleKey,
        generation_id: result.generation_id || null,
        review_id: result.review_id || null,
        safety_flag_count: result.safety_flags?.length || 0,
        route_family: 'clinical',
      }
    );
    return success(res, result, 'Admission AI draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /ehr-query — answer a clinician free-text question over a patient record
//
// Grounded + cited, differentiating the CURRENT ADMISSION from PRIOR HISTORY.
// The asking clinician is the human-in-the-loop, so there is NO review queue:
// the service returns a live answer and writes one audit row. Module-gated
// (clinician_ehr_query) — a disabled module surfaces as a 403
// (EHR_QUERY_MODULE_DISABLED) from the service layer. PHI access is logged
// twice over: the mount-level phiAccessLogger('CLINICAL_AI') and the
// route-level phiAccessLogger('EHR_QUERY') (which reads patient_uid from the
// body) record the patient the clinician queried.
// ---------------------------------------------------------------------------
router.post(
  '/ehr-query',
  // Direct patient guard (#2): the route takes a caller-asserted patient_uid and
  // answerEhrQuery loads that patient's full timeline + admission packet —
  // without this, any clinical-role caller could read ANY patient's chart by
  // asserting the uid. patientAccessGuard resolves patient_uid from the body;
  // care-team-mode-governed (shadow today, 403 at GO_LIVE). The hard
  // tenant-scoping is threaded into the service loads.
  patientAccessGuard('PATIENT_RECORD', {
    policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
    careTeamModeGoverned: true,
  }),
  phiAccessLogger('EHR_QUERY'),
  async (req, res, next) => {
  try {
    const patientUid = req.body?.patient_uid;
    const question = req.body?.question;
    if (!patientUid) {
      return error(res, 'patient_uid is required', 400, { code: 'EHR_QUERY_PATIENT_REQUIRED' });
    }
    if (!question) {
      return error(res, 'question is required', 400, { code: 'EHR_QUERY_QUESTION_REQUIRED' });
    }

    // Lazy import: clinicianEhrQueryService transitively pulls `prismaReadOnly`
    // (and the EMR timeline / local-LLM clients) into the module graph. Importing
    // it at file top forces every app-boot / route-load test that mocks
    // `../../lib/prisma.js` to also export `prismaReadOnly`, breaking suites that
    // don't (e.g. clinicalUseExplainerRoutes.test.js). Deferring the import to
    // call time keeps the router's static module graph free of that dependency.
    const { answerEhrQuery } = await import('../../../services/ai/clinicianEhrQueryService.js');
    const result = await answerEhrQuery({
      patientUid,
      question,
      scope: req.body?.scope || 'both',
      admissionId: req.body?.admission_id ?? null,
      dateFrom: req.body?.date_from ?? null,
      dateTo: req.body?.date_to ?? null,
      req,
    });

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_EHR_QUERY_ANSWERED',
      String(result.window?.current_admission_id || patientUid),
      null,
      {
        module_key: 'clinician_ehr_query',
        scope: result.scope,
        current_admission_id: result.window?.current_admission_id || null,
        event_count: result.window?.event_count || 0,
        citation_count: Array.isArray(result.citations) ? result.citations.length : 0,
        safety_flag_count: Array.isArray(result.safety_flags) ? result.safety_flags.length : 0,
        used_ai: result.used_ai,
        route_family: 'clinical',
        patient_facing: false,
        decision_support_only: true,
      }
    );
    return success(res, result, 'EHR query answered');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /discharge-compose — start a fresh compose (clinician)
// ---------------------------------------------------------------------------
router.post('/discharge-compose', guardComposeAdmission, async (req, res, next) => {
  try {
    const admissionId = req.body?.admission_id;
    if (!admissionId) {
      return error(res, 'admission_id is required', 400, { code: 'ADMISSION_ID_REQUIRED' });
    }

    const result = await composeDischargePackage(admissionId, req.user?.uid || null, req);

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DISCHARGE_COMPOSE_GENERATED',
      String(result.compose_generation_id || result.run_id || admissionId),
      null,
      {
        admission_id: admissionId,
        compose_generation_id: result.compose_generation_id || null,
        compose_children: result.compose_children || null,
        overall_safety_band: result.overall_safety_band || null,
        status: result.status || 'completed',
        run_id: result.run_id || null,
        route_family: 'clinical',
      }
    );

    const statusCode = result.status === 'paused' ? 202 : 201;
    return success(res, result, 'Discharge compose dispatched', statusCode);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /discharge-compose — list recent compose runs (top-level only)
// ---------------------------------------------------------------------------
router.get('/discharge-compose', async (req, res, next) => {
  try {
    const limit = clampInt(req.query?.limit, { min: 1, max: 100, fallback: 25 });
    const status = req.query?.status ? String(req.query.status).slice(0, 40) : null;

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, workflow_key, module_key, patient_uid, admission_id,
              status, current_node, pause_reason, started_at, paused_at,
              completed_at, failed_at, metadata
       FROM clinical_ai_workflow_runs
       WHERE tenant_id = $1::uuid
         AND workflow_key = $2
         AND parent_run_id IS NULL
         AND ($3::text IS NULL OR status = $3)
       ORDER BY started_at DESC
       LIMIT $4`,
      req.tenantId,
      DISCHARGE_COMPOSE_WORKFLOW_KEY,
      status,
      limit
    );

    return success(res, { runs: rows, count: rows.length }, 'Discharge compose runs retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /discharge-compose/:runId — fetch run + children tree
// ---------------------------------------------------------------------------
router.get('/discharge-compose/:runId', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run || run.tenant_id !== req.tenantId || run.workflow_key !== DISCHARGE_COMPOSE_WORKFLOW_KEY) {
      throw AppError.notFound('Compose run not found');
    }
    const children = await store.listChildren(runId);
    return success(res, { run, children, child_count: children.length }, 'Discharge compose run retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /discharge-compose/:runId/resume — resume a paused run (clinician)
// ---------------------------------------------------------------------------
router.post('/discharge-compose/:runId/resume', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run || run.tenant_id !== req.tenantId || run.workflow_key !== DISCHARGE_COMPOSE_WORKFLOW_KEY) {
      throw AppError.notFound('Compose run not found');
    }

    const outcome = await resumeWorkflow({ runId, store, graph: getComposeGraph() });

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DISCHARGE_COMPOSE_RESUMED',
      String(runId),
      { status_before: run.status, pause_reason: run.pause_reason },
      { status_after: outcome.status, pause_reason: outcome.pauseReason || null, route_family: 'clinical' }
    );

    const statusCode = outcome.status === 'paused' ? 202 : 200;
    return success(res, outcome, 'Discharge compose resumed', statusCode);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /reviews — caller's review queue
//
// Filtered to reviews whose module's reviewRoles[] contains the caller's
// role. (listReviews already supports filtering by reviewer_role; we
// just pass the caller's role automatically here, which differs from
// /control/reviews where governance can pass any reviewer_role.)
// ---------------------------------------------------------------------------
router.get('/reviews', async (req, res, next) => {
  try {
    const callerRole = normalizeRole(req.user?.role);
    const reviews = await listReviews({
      tenantId: req.tenantId,
      decision: req.query?.decision || null,
      moduleKey: req.query?.module_key || null,
      reviewerRole: callerRole, // forced — clinicians see only their own queue
      limit: req.query?.limit,
    });
    return success(res, reviews, 'Clinical AI reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /reviews/:id — sign / edit / reject (per-module reviewRoles enforced
// in updateReview)
// ---------------------------------------------------------------------------
router.patch('/reviews/:id', async (req, res, next) => {
  try {
    const review = await updateReview(
      req.params.id,
      req.body || {},
      req.user?.uid || null,
      normalizeRole(req.user?.role),
      { tenantId: req.tenantId }
    );
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_REVIEW_UPDATED',
      String(req.params.id),
      null,
      { ...review, route_family: 'clinical' }
    );
    return success(res, review, 'Clinical AI review updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// OP doctor-facing AI assist endpoints.
//
// These services are clinical decision-support only and are never patient
// facing. Each module is defined in clinicalAiModuleService.js and is
// toggleable from the Admin Clinical AI module controls. Disabled modules
// return 403 from the service layer.
// ---------------------------------------------------------------------------

router.get('/op/services', requireOpAiDoctorUse, async (req, res, next) => {
  try {
    const result = await listOpdAiModules({ tenantId: req.tenantId });
    return success(res, result, 'OP AI services retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/op/visit-prep', requireOpAiDoctorUse, guardOpAppointment, async (req, res, next) => {
  try {
    const result = await generateOpVisitPrep({
      tenantId: req.tenantId,
      appointmentId: req.body?.appointment_id,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnOpAi(req, res, 'CLINICAL_AI_OP_VISIT_PREP_GENERATED', result, 'OP visit prep drafted');
  } catch (err) {
    return next(err);
  }
});

router.post('/op/prescription-safety', requireOpAiDoctorUse, guardOpPatient, async (req, res, next) => {
  try {
    const result = await generateOpPrescriptionSafetyReview({
      patientId: req.body?.patient_id || null,
      patientUid: req.body?.patient_uid || null,
      medications: req.body?.medications,
      admissionId: req.body?.admission_id || null,
      req,
    });
    return auditAndReturnOpAi(req, res, 'CLINICAL_AI_OP_PRESCRIPTION_SAFETY_REVIEWED', result, 'Prescription safety review drafted');
  } catch (err) {
    return next(err);
  }
});

router.post('/op/investigation-review', requireOpAiDoctorUse, guardOpPatient, guardLabExplainer, async (req, res, next) => {
  try {
    const result = await generateOpInvestigationReview({
      tenantId: req.tenantId,
      investigationId: req.body?.investigation_id || null,
      patientUid: req.body?.patient_uid || null,
      resultText: req.body?.result_text || null,
      clinicalQuestion: req.body?.clinical_question || null,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnOpAi(req, res, 'CLINICAL_AI_OP_INVESTIGATION_REVIEW_GENERATED', result, 'Investigation review drafted');
  } catch (err) {
    return next(err);
  }
});

router.post('/op/differential-red-flags', requireOpAiDoctorUse, guardOpPatient, async (req, res, next) => {
  try {
    const result = await generateOpDifferentialRedFlags({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid || null,
      chiefComplaint: req.body?.chief_complaint,
      ageYears: req.body?.age_years || null,
      sex: req.body?.sex || null,
      vitals: req.body?.vitals || null,
      examNotes: req.body?.exam_notes || null,
      knownDiagnoses: req.body?.known_diagnoses || [],
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnOpAi(req, res, 'CLINICAL_AI_OP_DIFFERENTIAL_RED_FLAGS_GENERATED', result, 'Differential and red-flag checklist drafted');
  } catch (err) {
    return next(err);
  }
});

router.post('/op/follow-up-plan', requireOpAiDoctorUse, guardOpPatient, async (req, res, next) => {
  try {
    const result = await generateOpFollowUpPlan({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid || null,
      diagnosis: req.body?.diagnosis,
      treatmentPlan: req.body?.treatment_plan,
      monitoringContext: req.body?.monitoring_context || null,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnOpAi(req, res, 'CLINICAL_AI_OP_FOLLOW_UP_PLAN_GENERATED', result, 'Follow-up plan drafted');
  } catch (err) {
    return next(err);
  }
});

router.post('/op/referral-draft', requireOpAiDoctorUse, guardOpPatient, async (req, res, next) => {
  try {
    const result = await generateOpReferralDraft({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid || null,
      referralReason: req.body?.referral_reason,
      clinicalSummary: req.body?.clinical_summary,
      targetSpecialty: req.body?.target_specialty || null,
      currentTreatment: req.body?.current_treatment || null,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnOpAi(req, res, 'CLINICAL_AI_OP_REFERRAL_DRAFT_GENERATED', result, 'Referral draft generated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Patient-facing explainer endpoints (clinical plane).
//
// Mirrors the admin-plane endpoints in patientExplainersRoutes.js so
// clinicians on apps/staff (Flutter) can drive AI Assist directly from
// the clinical_notes_screen / EMR detail surfaces, without needing
// ADMIN/SUPER_ADMIN. Per-module reviewRoles + sign-off requirements
// stay identical — the draft still lands in clinical_ai_reviews with
// requires_signoff=true, and the same updateReview gate enforces who
// can finalize.
//
// Audit events carry route_family='clinical' so governance dashboards
// can distinguish point-of-care drafts from admin-portal drafts.
// ---------------------------------------------------------------------------

function auditAndReturnExplainer(req, res, eventType, result, message) {
  return Promise.resolve(
    logClinicalAiAudit(req, eventType, String(result?.generation_id || 'inline'), null, {
      module_key: result?.module_key,
      generation_id: result?.generation_id,
      review_status: result?.review_status,
      provider: result?.provider,
      used_ai: result?.used_ai,
      safety_flag_count: Array.isArray(result?.safety_flags) ? result.safety_flags.length : 0,
      route_family: 'clinical',
    }),
  ).then(() => success(res, result, message, 201));
}

router.post('/lab-patient-explanations', guardLabExplainer, async (req, res, next) => {
  try {
    const result = await generateLabPatientExplanation({
      tenantId: req.tenantId,
      investigationId: req.body?.investigation_id,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnExplainer(req, res, 'CLINICAL_AI_LAB_PATIENT_EXPLANATION_GENERATED', result, 'Lab patient explanation drafted');
  } catch (err) { return next(err); }
});

router.post('/radiology-patient-explanations', guardRadiologyExplainer, async (req, res, next) => {
  try {
    const result = await generateRadiologyPatientExplanation({
      tenantId: req.tenantId,
      radiologyOrderId: req.body?.radiology_order_id,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnExplainer(req, res, 'CLINICAL_AI_RADIOLOGY_PATIENT_EXPLANATION_GENERATED', result, 'Radiology patient explanation drafted');
  } catch (err) { return next(err); }
});

router.post(
  '/patient-report-explanations',
  // Parity with the admin-plane guard (#2/#7a): the report explainer takes a
  // caller-asserted patient_uid; the shared generatePatientReportExplanation
  // service additionally tenant-scopes + existence-checks it (load-bearing).
  patientAccessGuard('PATIENT_RECORD', {
    policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
    careTeamModeGoverned: true,
  }),
  async (req, res, next) => {
  try {
    const result = await generatePatientReportExplanation({
      tenantId: req.tenantId,
      reportType: req.body?.report_type,
      reportText: req.body?.report_text,
      patientUid: req.body?.patient_uid || null,
      admissionId: req.body?.admission_id || null,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnExplainer(req, res, 'CLINICAL_AI_PATIENT_REPORT_EXPLANATION_GENERATED', result, 'Patient report explanation drafted');
  } catch (err) { return next(err); }
});

router.post('/prescription-patient-explanations', guardPrescriptionExplainer, async (req, res, next) => {
  try {
    const result = await generatePrescriptionPatientExplanation({
      tenantId: req.tenantId,
      prescriptionId: req.body?.prescription_id,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnExplainer(req, res, 'CLINICAL_AI_PRESCRIPTION_PATIENT_EXPLANATION_GENERATED', result, 'Prescription patient explanation drafted');
  } catch (err) { return next(err); }
});

router.post('/invoice-patient-explanations', guardInvoiceExplainer, async (req, res, next) => {
  try {
    const result = await generateInvoicePatientExplanation({
      tenantId: req.tenantId,
      invoiceId: req.body?.invoice_id,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturnExplainer(req, res, 'CLINICAL_AI_INVOICE_PATIENT_EXPLANATION_GENERATED', result, 'Invoice patient explanation drafted');
  } catch (err) { return next(err); }
});

export default router;
