import express from 'express';
import multer from 'multer';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { validateFileContent } from '../../middleware/uploadMiddleware.js';
import { error, success } from '../../utils/responseHelper.js';
import { getClinicalAiRuntimeStatus } from '../../services/ai/localLlmClient.js';
import {
  deleteClinicalAiTenantModule,
  getClinicalAiBudgetStatus,
  getClinicalAiGuardrails,
  getClinicalAiModule,
  getClinicalAiSafetyReviewSummary,
  getClinicalAiTenantModule,
  getClinicalAiUsageSummary,
  listClinicalAiModules,
  listClinicalAiTenantModules,
  updateClinicalAiGuardrails,
  updateClinicalAiModule,
  updateClinicalAiTenantModule,
} from '../../services/ai/clinicalAiModuleService.js';
import {
  activatePrompt,
  createApproval,
  createPrompt,
  decideApproval,
  endBreakGlass,
  generateAdmissionAiDraft,
  getActiveBreakGlass,
  listApprovals,
  listPrompts,
  listReviews,
  startBreakGlass,
  updateReview,
} from '../../services/ai/clinicalAiWorkflowService.js';
import { listAbnormalResultTriageDrafts } from '../../services/ai/abnormalResultTriageAdminService.js';
import { getHealthReport } from '../../middleware/selfHealingMiddleware.js';
import {
  listSelfHealingRuns,
  runSelfHealingScan,
} from '../../services/ai/selfHealingService.js';
import {
  backfillSignedDischargeSummaries,
  getCorpusHealth,
  retrieveRelevant,
} from '../../services/ai/ragService.js';
import { listTranslations } from '../../services/ai/translationService.js';
import {
  concludeExperiment,
  createExperiment,
  getExperimentStats,
  listExperiments,
} from '../../services/ai/promptExperimentService.js';
import {
  deactivateCanaryCase,
  listCanaryCases,
  listCanaryRuns,
  runCanary,
  upsertCanaryCase,
} from '../../services/ai/driftCanaryService.js';
import {
  auditChargeCapture,
  decideChargeCaptureAudit,
  listChargeCaptureAudits,
  predictOtCaseTime,
  scoreNoShowRisk,
} from '../../services/ai/operationalAiService.js';
import {
  listDeteriorationSnapshots,
  scoreDeterioration,
} from '../../services/ai/deteriorationEarlyWarningService.js';
import {
  decidePolypharmacyReview,
  listPolypharmacyReviews,
  reviewPolypharmacy,
} from '../../services/ai/polypharmacyAiService.js';
import {
  decideTrialMatch,
  listTrialMatches,
  matchPatientAgainstTrials,
  upsertTrial,
} from '../../services/ai/trialMatcherService.js';
import {
  listTrialSyncRuns,
  syncTrialsFromPublicRegistry,
} from '../../services/ai/trialCatalogSyncService.js';
import {
  decideImagingFinding,
  getImagingPacsStatus,
  importImagingStudyFromPacs,
  ingestInferenceResult,
  listImagingFindings,
  registerImagingStudy,
} from '../../services/ai/imagingAiService.js';
import {
  acknowledgeEscalation,
  enrollPatient,
  listActiveEnrollments,
  listOpenEscalations,
  resolveEscalation,
} from '../../services/ai/virtualWardService.js';
import {
  decideClinicalDocumentIntake,
  ingestClinicalDocument,
  ingestClinicalDocumentUpload,
  listClinicalDocumentIntakes,
} from '../../services/ai/documentIntelligenceService.js';
import {
  decideChartCompletionAudit,
  generateChartCompletionAudit,
  listChartCompletionAudits,
} from '../../services/ai/chartCompletionAuditorService.js';
import {
  decideClinicalTaskCandidate,
  generateClinicalTaskExtraction,
  listClinicalTaskCandidates,
} from '../../services/ai/clinicalTaskExtractorService.js';
import {
  decideInfectionControlAudit,
  generateInfectionControlAudit,
  listInfectionControlAudits,
} from '../../services/ai/infectionControlSentinelService.js';
import {
  decideAntimicrobialStewardshipReview,
  generateAntimicrobialStewardshipReview,
  listAntimicrobialStewardshipReviews,
} from '../../services/ai/antimicrobialStewardshipService.js';
import {
  decideTeachBackSession,
  generateTeachBackSession,
  listTeachBackSessions,
  submitTeachBackAnswers,
} from '../../services/ai/patientTeachBackService.js';
import {
  decideAppealLetter,
  generateAppealLetter,
  listAppealLetters,
  recordAppealPayerResponse,
  submitAppealLetter,
} from '../../services/ai/appealLetterGeneratorService.js';
import {
  computeAiRoiMetrics,
  getLatestAiRoiSnapshot,
  listAiRoiSnapshots,
  saveAiRoiSnapshot,
} from '../../services/ai/aiRoiDashboardService.js';
import {
  decideNursingAmbientSession,
  generateNursingAmbientSession,
  listNursingAmbientSessions,
} from '../../services/ai/nursingAmbientDocumentationService.js';
import {
  decideFamilyUpdate,
  generateFamilyUpdate,
  listFamilyUpdates,
  markFamilyUpdateSent,
} from '../../services/ai/familyUpdateGeneratorService.js';
import {
  decidePayerVarianceReview,
  evaluateClaimVariance,
  listPayerContracts,
  listPayerVarianceReviews,
  upsertPayerContract,
} from '../../services/ai/payerContractVarianceService.js';
import {
  decideLabAutoverification,
  evaluateInvestigation,
  listLabAutoverifications,
} from '../../services/ai/labAutoverificationService.js';
import {
  decidePediatricDoseCheck,
  evaluatePrescriptionSafety,
  listPediatricDoseChecks,
} from '../../services/ai/pediatricDosingSafetyService.js';
import {
  decideSepsisBundleAudit,
  generateSepsisBundleAudit,
  listSepsisBundleAudits,
} from '../../services/ai/sepsisBundleSentinelService.js';
import {
  decideConsentPhiPolicyAudit,
  listConsentPhiPolicyAudits,
  runConsentPhiPolicyScan,
} from '../../services/ai/consentPhiPolicySentinelService.js';
import {
  discardRoster,
  generateRoster,
  listRosterRuns,
  publishRoster,
} from '../../services/ai/rosterOptimizerService.js';
import {
  decideRcaDraft,
  generateRcaDraft,
  listRcaDrafts,
} from '../../services/ai/rcaDraftService.js';
import {
  generatePriorAuthorization,
  listPriorAuthorizations,
  recordPayerDecision,
  submitPriorAuthorization,
} from '../../services/ai/priorAuthorizationService.js';

const router = express.Router();
const CLINICAL_AI_AUDIT_RESOURCE = 'clinical_ai';
const DOCUMENT_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'text/plain',
  'text/csv',
  'text/rtf',
  'application/json',
  'application/fhir+json',
  'application/hl7-v2+er7',
]);
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
    fields: 12,
    fieldSize: 64 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (!DOCUMENT_UPLOAD_MIME_TYPES.has(mimeType)) {
      cb(new Error(`Document intelligence upload does not support ${mimeType}`));
      return;
    }
    cb(null, true);
  },
});
const CLINICAL_AI_CONTROL_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'IT',
  'IT_ADMIN',
  'IT_STAFF',
  'SYSTEM_ADMIN',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

function requireClinicalAiControl(req, res, next) {
  if (!req.user) {
    return error(res, 'Authentication required', 401, { safe: true });
  }

  const role = normalizeRole(req.user.role);
  if (!CLINICAL_AI_CONTROL_ROLES.has(role)) {
    return error(res, 'Clinical AI controls require Admin or IT privileges', 403, {
      safe: true,
    });
  }

  return next();
}

function uuidOrNull(value) {
  const text = String(value || '').trim();
  return UUID_RE.test(text) ? text : null;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).trim();
  }
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || null;
}

function stableValue(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value;
}

function changedFields(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => (
    stableValue(before?.[key]) !== stableValue(after?.[key])
  ));
}

function pickModuleAuditFields(module = {}) {
  return {
    module_key: module.module_key,
    display_name: module.display_name,
    enabled: module.enabled,
    provider_override: module.provider_override,
    model_override: module.model_override,
    external_allowed: module.external_allowed,
    max_tokens: module.max_tokens,
    temperature: module.temperature,
    settings: module.settings || {},
    tenant_id: module.tenant_id || null,
    tenant_override_id: module.tenant_override_id || null,
    tenant_override_source: module.tenant_override_source || null,
    global_enabled: module.global_enabled,
  };
}

function pickGuardrailAuditFields(guardrails = {}) {
  return {
    enabled: guardrails.enabled,
    external_ai_enabled: guardrails.external_ai_enabled,
    daily_token_limit: guardrails.daily_token_limit,
    daily_cost_limit_minor: guardrails.daily_cost_limit_minor,
    request_token_limit: guardrails.request_token_limit,
    fallback_rate_alert_pct: guardrails.fallback_rate_alert_pct,
    max_fallbacks_per_day: guardrails.max_fallbacks_per_day,
    latency_alert_ms: guardrails.latency_alert_ms,
  };
}

function parseClinicalAiWindowDays(value, fallback = 7) {
  return Math.min(Math.max(parseInt(value, 10) || fallback, 1), 90);
}

async function getClinicalAiAuditRows({ limit = 50, tenantId = null } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  return prisma.$queryRawUnsafe(
    `SELECT id, uid, role, action, resource, resource_id, metadata,
            ip_address, user_agent, created_at
     FROM audit_logs
     WHERE (resource = $1 OR action LIKE 'CLINICAL_AI_%')
       AND ($3::text IS NULL OR COALESCE(metadata->>'tenant_id', $3::text) = $3::text)
     ORDER BY created_at DESC
     LIMIT $2`,
    CLINICAL_AI_AUDIT_RESOURCE,
    safeLimit,
    tenantId
  );
}

function summarizeClinicalAiAuditRows(rows = []) {
  const byAction = new Map();
  const byActorRole = new Map();

  for (const row of rows) {
    const action = String(row.action || 'unknown');
    const role = String(row.metadata?.actor?.role || row.role || 'unknown');
    byAction.set(action, (byAction.get(action) || 0) + 1);
    byActorRole.set(role, (byActorRole.get(role) || 0) + 1);
  }

  return {
    total: rows.length,
    latest_at: rows[0]?.created_at || null,
    by_action: Array.from(byAction, ([action, count]) => ({ action, count }))
      .sort((left, right) => right.count - left.count || left.action.localeCompare(right.action)),
    by_actor_role: Array.from(byActorRole, ([role, count]) => ({ role, count }))
      .sort((left, right) => right.count - left.count || left.role.localeCompare(right.role)),
  };
}

async function logClinicalAiAudit(req, action, resourceId, before, after) {
  const metadata = {
    before,
    after,
    changed_fields: changedFields(before, after),
    tenant_id: req.tenantId || null,
    tenant_region: req.tenant?.region || null,
    actor: {
      uid: req.user?.uid || null,
      id: req.user?.id || null,
      role: req.user?.role || null,
      email: req.user?.email || null,
      phone: req.user?.phone || null,
    },
  };

  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (uid, role, action, resource, resource_id, metadata, ip_address, user_agent, created_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW())`,
      uuidOrNull(req.user?.uid),
      req.user?.role || null,
      action,
      CLINICAL_AI_AUDIT_RESOURCE,
      resourceId,
      JSON.stringify(metadata),
      getClientIp(req),
      String(req.headers['user-agent'] || '').slice(0, 500) || null
    );
  } catch (err) {
    logger.warn('Clinical AI audit write failed', {
      action,
      resourceId,
      error: err?.message,
    });
  }
}

router.use(requireClinicalAiControl);

router.get('/status', async (req, res, next) => {
  try {
    const live = String(req.query.live || '').toLowerCase() === 'true';
    const days = parseClinicalAiWindowDays(req.query.days);
    const status = await getClinicalAiRuntimeStatus({
      live,
      days,
      tenantId: req.tenantId,
      tenantRegion: req.tenant?.region || null,
    });
    return success(res, status, 'Clinical AI status retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/modules', async (_req, res, next) => {
  try {
    const modules = await listClinicalAiModules({ refresh: true });
    return success(res, { modules, count: modules.length }, 'Clinical AI modules retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/tenant-modules', async (req, res, next) => {
  try {
    const modules = await listClinicalAiTenantModules({ tenantId: req.tenantId, refresh: true });
    return success(res, { modules, count: modules.length }, 'Clinical AI tenant modules retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/tenant-modules/:moduleKey', async (req, res, next) => {
  try {
    const updatedBy = req.user?.uid || null;
    const before = pickModuleAuditFields(await getClinicalAiTenantModule(req.params.moduleKey, {
      tenantId: req.tenantId,
      refresh: true,
    }));
    const module = await updateClinicalAiTenantModule(
      req.params.moduleKey,
      req.body || {},
      updatedBy,
      { tenantId: req.tenantId }
    );
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TENANT_MODULE_UPDATED',
      `${req.tenantId}:${module.module_key}`,
      before,
      pickModuleAuditFields(module)
    );
    return success(res, module, 'Clinical AI tenant module updated');
  } catch (err) {
    return next(err);
  }
});

router.delete('/tenant-modules/:moduleKey', async (req, res, next) => {
  try {
    const before = pickModuleAuditFields(await getClinicalAiTenantModule(req.params.moduleKey, {
      tenantId: req.tenantId,
      refresh: true,
    }));
    const module = await deleteClinicalAiTenantModule(req.params.moduleKey, { tenantId: req.tenantId });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TENANT_MODULE_RESET',
      `${req.tenantId}:${module.module_key}`,
      before,
      pickModuleAuditFields(module)
    );
    return success(res, module, 'Clinical AI tenant module reset');
  } catch (err) {
    return next(err);
  }
});

router.patch('/modules/:moduleKey', async (req, res, next) => {
  try {
    const updatedBy = req.user?.uid || null;
    const before = pickModuleAuditFields(await getClinicalAiModule(req.params.moduleKey));
    const module = await updateClinicalAiModule(req.params.moduleKey, req.body || {}, updatedBy);
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_MODULE_UPDATED',
      module.module_key,
      before,
      pickModuleAuditFields(module)
    );
    return success(res, module, 'Clinical AI module updated');
  } catch (err) {
    return next(err);
  }
});

router.get('/prompts', async (req, res, next) => {
  try {
    const prompts = await listPrompts({
      tenantId: req.tenantId,
      moduleKey: req.query.module_key || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, prompts, 'Clinical AI prompts retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/prompts', async (req, res, next) => {
  try {
    const prompt = await createPrompt(req.body || {}, req.user?.uid || null, { tenantId: req.tenantId });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PROMPT_CREATED',
      String(prompt.id),
      null,
      prompt
    );
    return success(res, prompt, 'Clinical AI prompt created', 201);
  } catch (err) {
    return next(err);
  }
});

router.patch('/prompts/:id/activate', async (req, res, next) => {
  try {
    const result = await activatePrompt(
      req.params.id,
      req.user?.uid || null,
      req.body?.approval_id || null,
      { tenantId: req.tenantId }
    );
    await logClinicalAiAudit(
      req,
      result.approval_required
        ? 'CLINICAL_AI_PROMPT_ACTIVATION_REQUESTED'
        : 'CLINICAL_AI_PROMPT_ACTIVATED',
      String(req.params.id),
      null,
      result
    );
    return success(
      res,
      result,
      result.approval_required
        ? 'Clinical AI prompt activation approval required'
        : 'Clinical AI prompt activated',
      result.approval_required ? 202 : 200
    );
  } catch (err) {
    return next(err);
  }
});

router.get('/reviews', async (req, res, next) => {
  try {
    const reviews = await listReviews({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      moduleKey: req.query.module_key || null,
      reviewerRole: req.query.reviewer_role || null,
      limit: req.query.limit,
    });
    return success(res, reviews, 'Clinical AI reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

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
      review
    );
    return success(res, review, 'Clinical AI review updated');
  } catch (err) {
    return next(err);
  }
});

router.get('/approvals', async (req, res, next) => {
  try {
    const approvals = await listApprovals({
      tenantId: req.tenantId,
      status: req.query.status || null,
      moduleKey: req.query.module_key || null,
      limit: req.query.limit,
    });
    return success(res, approvals, 'Clinical AI approvals retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/approvals', async (req, res, next) => {
  try {
    const approval = await createApproval(req.body || {}, req.user?.uid || null, { tenantId: req.tenantId });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_APPROVAL_REQUESTED',
      String(approval.id),
      null,
      approval
    );
    return success(res, approval, 'Clinical AI approval requested', 201);
  } catch (err) {
    return next(err);
  }
});

router.patch('/approvals/:id', async (req, res, next) => {
  try {
    const approval = await decideApproval(
      req.params.id,
      req.body?.decision,
      req.user?.uid || null,
      req.body?.reason || null,
      { tenantId: req.tenantId }
    );
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_APPROVAL_DECIDED',
      String(req.params.id),
      null,
      approval
    );
    return success(res, approval, 'Clinical AI approval updated');
  } catch (err) {
    return next(err);
  }
});

router.post('/break-glass', async (req, res, next) => {
  try {
    const session = await startBreakGlass(req.body || {}, req.user?.uid || null, { tenantId: req.tenantId });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_BREAK_GLASS_STARTED',
      String(session.id),
      null,
      session
    );
    return success(res, session, 'Clinical AI break-glass session started', 201);
  } catch (err) {
    return next(err);
  }
});

router.patch('/break-glass/:id/end', async (req, res, next) => {
  try {
    const session = await endBreakGlass(req.params.id, req.user?.uid || null, { tenantId: req.tenantId });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_BREAK_GLASS_ENDED',
      String(req.params.id),
      null,
      session
    );
    return success(res, session, 'Clinical AI break-glass session ended');
  } catch (err) {
    return next(err);
  }
});

router.get('/break-glass', async (req, res, next) => {
  try {
    const sessions = await getActiveBreakGlass({ tenantId: req.tenantId });
    return success(res, sessions, 'Active Clinical AI break-glass sessions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/usage', async (req, res, next) => {
  try {
    const days = parseClinicalAiWindowDays(req.query.days);
    const usage = await getClinicalAiUsageSummary({ days, tenantId: req.tenantId });
    return success(res, usage, 'Clinical AI usage retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/safety-reviews/summary', async (req, res, next) => {
  try {
    const days = parseClinicalAiWindowDays(req.query.days);
    const summary = await getClinicalAiSafetyReviewSummary({ days, tenantId: req.tenantId });
    return success(res, summary, 'Clinical AI safety review summary retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/governance-report', async (req, res, next) => {
  try {
    const days = parseClinicalAiWindowDays(req.query.days, 30);
    const tenantRegion = req.tenant?.region || null;
    const [
      runtime,
      prompts,
      pendingApprovals,
      recentApprovals,
      reviews,
      breakGlass,
      safetyReviews,
      auditRows,
    ] = await Promise.all([
      getClinicalAiRuntimeStatus({
        live: false,
        days,
        tenantId: req.tenantId,
        tenantRegion,
      }),
      listPrompts({ limit: 500, tenantId: req.tenantId }),
      listApprovals({ status: 'pending', limit: 200, tenantId: req.tenantId }),
      listApprovals({ limit: 200, tenantId: req.tenantId }),
      listReviews({ limit: 200, tenantId: req.tenantId }),
      getActiveBreakGlass({ tenantId: req.tenantId }),
      getClinicalAiSafetyReviewSummary({ days, tenantId: req.tenantId }),
      getClinicalAiAuditRows({ limit: 200, tenantId: req.tenantId }),
    ]);

    const runtimeModules = Array.isArray(runtime.modules) ? runtime.modules : [];
    const runtimeAdapters = Array.isArray(runtime.adapters) ? runtime.adapters : [];
    const enabledModules = runtimeModules.filter((module) => module.enabled);
    const highRiskEnabled = enabledModules.filter((module) => (
      String(module.settings?.risk || '').toLowerCase() === 'high'
    ));
    const externalEnabled = enabledModules.filter((module) => module.external_allowed);

    const summary = {
      module_count: runtimeModules.length,
      enabled_module_count: enabledModules.length,
      high_risk_enabled_count: highRiskEnabled.length,
      external_enabled_module_count: externalEnabled.length,
      pending_approval_count: pendingApprovals.count,
      active_break_glass_count: breakGlass.count,
      safety_review_count: safetyReviews.overall.review_count,
      blocked_safety_review_count: safetyReviews.overall.blocked_count,
      adapter_configured_count: runtimeAdapters.filter((adapter) => adapter.configured).length,
      adapter_blocked_count: runtimeAdapters.filter((adapter) => adapter.status === 'blocked').length,
      total_tokens: runtime.usage?.overall?.total_tokens || 0,
      estimated_cost_minor: runtime.usage?.overall?.estimated_cost_minor || 0,
      audit_event_count: auditRows.length,
    };

    const report = {
      report_version: 'clinical-ai-governance-v1',
      generated_at: new Date().toISOString(),
      generated_by: {
        uid: req.user?.uid || null,
        role: req.user?.role || null,
      },
      tenant: {
        id: req.tenantId,
        region: tenantRegion,
      },
      window_days: days,
      summary,
      runtime: {
        provider_health: runtime.providerHealth,
        adapters: runtimeAdapters,
        guardrails: runtime.guardrails,
        budget: runtime.budget,
      },
      modules: {
        all: runtimeModules,
        enabled: enabledModules.map((module) => module.module_key),
        high_risk_enabled: highRiskEnabled.map((module) => module.module_key),
        external_enabled: externalEnabled.map((module) => module.module_key),
      },
      prompts,
      approvals: {
        pending: pendingApprovals.approvals,
        recent: recentApprovals.approvals,
        pending_count: pendingApprovals.count,
        recent_count: recentApprovals.count,
      },
      reviews,
      safety_reviews: safetyReviews,
      break_glass: breakGlass,
      usage: runtime.usage,
      audit: {
        summary: summarizeClinicalAiAuditRows(auditRows),
        recent: auditRows,
      },
      data_boundaries: {
        external_ai_enabled: Boolean(runtime.guardrails?.external_ai_enabled),
        external_regions: process.env.CLINICAL_AI_EXTERNAL_REGIONS || null,
        decision_support_only: true,
        human_review_required: true,
      },
    };

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_GOVERNANCE_REPORT_EXPORTED',
      'governance-report',
      null,
      {
        window_days: days,
        summary,
      }
    );

    return success(res, report, 'Clinical AI governance report generated');
  } catch (err) {
    return next(err);
  }
});

router.get('/guardrails', async (req, res, next) => {
  try {
    const guardrails = await getClinicalAiGuardrails({ refresh: true });
    const budget = await getClinicalAiBudgetStatus({ days: 1, guardrails, tenantId: req.tenantId });
    return success(res, { guardrails, budget }, 'Clinical AI guardrails retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/guardrails', async (req, res, next) => {
  try {
    const updatedBy = req.user?.uid || null;
    const before = pickGuardrailAuditFields(await getClinicalAiGuardrails({ refresh: true }));
    const guardrails = await updateClinicalAiGuardrails(req.body || {}, updatedBy);
    const budget = await getClinicalAiBudgetStatus({ days: 1, guardrails, tenantId: req.tenantId });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_GUARDRAILS_UPDATED',
      'guardrails',
      before,
      pickGuardrailAuditFields(guardrails)
    );
    return success(res, { guardrails, budget }, 'Clinical AI guardrails updated');
  } catch (err) {
    return next(err);
  }
});

router.get('/audit', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await getClinicalAiAuditRows({ limit, tenantId: req.tenantId });

    return success(res, { logs: rows, count: rows.length }, 'Clinical AI audit logs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/generations', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const conditions = [];
    const params = [];
    let idx = 1;

    // Tenant isolation — admins only see their own tenant's generations.
    conditions.push(`g.tenant_id = $${idx}::uuid`);
    params.push(req.tenantId);
    idx++;

    if (req.query.patient_uid) {
      conditions.push(`g.patient_uid = $${idx}::uuid`);
      params.push(req.query.patient_uid);
      idx++;
    }
    if (req.query.task_type) {
      conditions.push(`g.task_type = $${idx}`);
      params.push(req.query.task_type);
      idx++;
    }
    if (req.query.status) {
      conditions.push(`g.status = $${idx}`);
      params.push(req.query.status);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await prisma.$queryRawUnsafe(
      `SELECT g.id, g.patient_uid, u.name AS patient_name, g.admission_id,
              g.task_type, g.module_key, g.provider, g.model, g.prompt_version, g.source_hash,
              g.status, g.used_ai, g.safety_flags, g.generated_by, g.reviewed_by,
              g.signed_note_id, g.prompt_tokens, g.completion_tokens, g.total_tokens,
              g.estimated_cost_minor, g.latency_ms, g.provider_request_id,
              g.finish_reason, g.metadata, g.created_at, g.updated_at
       FROM clinical_ai_generations g
       LEFT JOIN users u ON u.uid = g.patient_uid
       ${where}
       ORDER BY g.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params,
      limit,
      offset
    );

    return success(res, { generations: rows, count: rows.length }, 'Clinical AI generations retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/self-healing/status', (_req, res) => (
  success(res, getHealthReport(), 'Read-only self-healing status retrieved')
));

router.get('/self-healing/runs', async (req, res, next) => {
  try {
    const result = await listSelfHealingRuns({
      tenantId: req.tenantId,
      limit: req.query.limit,
    });
    return success(res, result, 'Self-healing runs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/self-healing/runs', async (req, res, next) => {
  try {
    const result = await runSelfHealingScan({
      tenantId: req.tenantId,
      startedBy: req.user?.uid || null,
      scope: req.body?.scope || 'routine',
      triggeredVia: 'admin_manual',
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_SELF_HEALING_RUN',
      String(result.run_id || 'inline'),
      null,
      { finding_count: result.findings.length, suggested_count: result.suggested_actions.length }
    );
    return success(res, result, 'Self-healing scan complete', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/safety-flags', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT g.id AS generation_id, g.patient_uid, u.name AS patient_name,
              g.admission_id, g.task_type, g.module_key, g.status,
              flag->>'severity' AS severity,
              flag->>'code' AS code,
              flag->>'message' AS message,
              g.created_at
       FROM clinical_ai_generations g
       LEFT JOIN users u ON u.uid = g.patient_uid
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(g.safety_flags, '[]'::jsonb)) AS flag
       WHERE g.tenant_id = $1::uuid
       ORDER BY
         CASE flag->>'severity'
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           ELSE 4
         END,
         g.created_at DESC
       LIMIT $2`,
      req.tenantId,
      limit
    );

    return success(res, { flags: rows, count: rows.length }, 'Clinical AI safety flags retrieved');
  } catch (err) {
    return next(err);
  }
});

/**
 * RAG corpus health — per-source-type chunk counts + staleness. Returns
 * corpus_available:false if pgvector isn't installed (so the admin UI can
 * show an install hint instead of a misleading zero).
 */
router.get('/corpus', async (req, res, next) => {
  try {
    const health = await getCorpusHealth({ tenantId: req.tenantId });
    return success(res, health, 'Corpus health retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/corpus/reindex', async (req, res, next) => {
  try {
    const result = await backfillSignedDischargeSummaries({
      tenantId: req.tenantId,
      limit: req.body?.limit || 200,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_CORPUS_REINDEX', 'discharge_summary', null, result);
    return success(res, result, 'Corpus reindex complete', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/corpus/test-query', async (req, res, next) => {
  try {
    const result = await retrieveRelevant({
      tenantId: req.tenantId,
      queryText: req.body?.query || '',
      filters: { sourceType: req.body?.source_type || null },
      topK: req.body?.top_k || 5,
      minScore: req.body?.min_score || 0.5,
    });
    return success(res, result, 'Corpus query complete');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Prompt A/B experiments
// ---------------------------------------------------------------------------
router.get('/experiments', async (req, res, next) => {
  try {
    const result = await listExperiments({
      tenantId: req.tenantId,
      moduleKey: req.query.module_key || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Prompt experiments retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/experiments', async (req, res, next) => {
  try {
    const experiment = await createExperiment({
      tenantId: req.tenantId,
      moduleKey: req.body?.module_key,
      name: req.body?.name,
      variantAPromptId: req.body?.variant_a_prompt_id,
      variantBPromptId: req.body?.variant_b_prompt_id,
      trafficSplitA: req.body?.traffic_split_a,
      startedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_EXPERIMENT_CREATED', String(experiment.id), null, experiment);
    return success(res, experiment, 'Experiment created', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/experiments/:id/stats', async (req, res, next) => {
  try {
    const stats = await getExperimentStats({
      tenantId: req.tenantId,
      experimentId: req.params.id,
    });
    return success(res, stats, 'Experiment stats computed');
  } catch (err) {
    return next(err);
  }
});

router.patch('/experiments/:id/conclude', async (req, res, next) => {
  try {
    const experiment = await concludeExperiment({
      tenantId: req.tenantId,
      experimentId: req.params.id,
      winningVariant: req.body?.winning_variant || null,
      concludedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_EXPERIMENT_CONCLUDED', String(experiment.id), null, experiment);
    return success(res, experiment, 'Experiment concluded');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Model drift canary
// ---------------------------------------------------------------------------
router.get('/canary/runs', async (req, res, next) => {
  try {
    const result = await listCanaryRuns({ tenantId: req.tenantId, limit: req.query.limit });
    return success(res, result, 'Canary runs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/canary/runs', async (req, res, next) => {
  try {
    const result = await runCanary({ tenantId: req.tenantId, scope: req.body?.scope || 'manual' });
    await logClinicalAiAudit(req, 'CLINICAL_AI_CANARY_RUN', 'canary', null, {
      total_cases: result.total_cases,
      pass_count: result.pass_count,
      drift_detected: result.drift_detected,
    });
    return success(res, result, 'Canary run complete', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/canary/cases', async (req, res, next) => {
  try {
    const result = await listCanaryCases({
      tenantId: req.tenantId,
      moduleKey: req.query.module_key,
      active: req.query.active,
      limit: req.query.limit,
    });
    return success(res, result, 'Canary cases retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/canary/cases', async (req, res, next) => {
  try {
    const saved = await upsertCanaryCase({
      tenantId: req.tenantId,
      moduleKey: req.body?.module_key,
      label: req.body?.label,
      inputPacket: req.body?.input_packet,
      expectedKeys: req.body?.expected_keys,
      expectedCitationsMin: req.body?.expected_citations_min,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_CANARY_CASE_UPSERTED', String(saved.id), null, saved);
    return success(res, saved, 'Canary case saved', 201);
  } catch (err) {
    return next(err);
  }
});

router.patch('/canary/cases/:id/deactivate', async (req, res, next) => {
  try {
    const saved = await deactivateCanaryCase({ tenantId: req.tenantId, id: req.params.id });
    await logClinicalAiAudit(req, 'CLINICAL_AI_CANARY_CASE_DEACTIVATED', String(saved.id), { active: true }, saved);
    return success(res, saved, 'Canary case deactivated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Document intelligence / OCR intake
// ---------------------------------------------------------------------------
router.post('/documents/intake', async (req, res, next) => {
  try {
    const result = await ingestClinicalDocument({
      req,
      patientUid: req.body?.patient_uid || null,
      admissionId: req.body?.admission_id || null,
      sourceType: req.body?.source_type || 'other',
      title: req.body?.title || null,
      fileName: req.body?.file_name || null,
      mimeType: req.body?.mime_type || null,
      storageKey: req.body?.storage_key || null,
      rawText: req.body?.raw_text || '',
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DOCUMENT_INTELLIGENCE_INGESTED',
      String(result.intake_id || result.generation_id || 'inline'),
      null,
      {
        intake_id: result.intake_id,
        generation_id: result.generation_id,
        extraction_status: result.extraction_status,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Document intelligence intake complete', 201);
  } catch (err) {
    return next(err);
  }
});

router.post(
  '/documents/intake/upload',
  documentUpload.single('file'),
  validateFileContent,
  async (req, res, next) => {
    try {
      if (!req.file) return error(res, 'file is required', 400);
      const result = await ingestClinicalDocumentUpload({
        req,
        file: req.file,
        patientUid: req.body?.patient_uid || null,
        admissionId: req.body?.admission_id || null,
        sourceType: req.body?.source_type || 'other',
        title: req.body?.title || null,
        storageKey: req.body?.storage_key || null,
        rawTextHint: req.body?.raw_text || '',
      });
      await logClinicalAiAudit(
        req,
        'CLINICAL_AI_DOCUMENT_INTELLIGENCE_FILE_UPLOADED',
        String(result.intake_id || result.generation_id || result.ocr?.file_hash || 'inline'),
        null,
        {
          intake_id: result.intake_id,
          generation_id: result.generation_id,
          extraction_status: result.extraction_status,
          ocr_provider: result.ocr?.provider || null,
          ocr_status: result.ocr?.status || null,
          file_name: req.file.originalname,
          mime_type: result.ocr?.mime_type || req.file.mimetype,
          text_char_count: result.ocr?.text_char_count || 0,
          safety_flag_count: result.safety_flags?.length || 0,
        }
      );
      return success(res, result, 'Document intelligence file upload complete', 201);
    } catch (err) {
      return next(err);
    }
  }
);

router.get('/documents/intake', async (req, res, next) => {
  try {
    const result = await listClinicalDocumentIntakes({
      tenantId: req.tenantId,
      sourceType: req.query?.source_type || null,
      status: req.query?.status || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Document intelligence intakes retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/documents/intake/:id', async (req, res, next) => {
  try {
    const result = await decideClinicalDocumentIntake({
      tenantId: req.tenantId,
      intakeId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DOCUMENT_INTELLIGENCE_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Document intake reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Chart completion auditor
// ---------------------------------------------------------------------------
router.post('/chart-completion/audits', async (req, res, next) => {
  try {
    const result = await generateChartCompletionAudit({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_CHART_COMPLETION_AUDIT_GENERATED',
      String(result.audit_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        audit_id: result.audit_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        completion_score: result.draft?.completion_score,
        risk_band: result.draft?.risk_band,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Chart completion audit generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/chart-completion/audits', async (req, res, next) => {
  try {
    const result = await listChartCompletionAudits({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      riskBand: req.query?.risk_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Chart completion audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/chart-completion/audits/:id', async (req, res, next) => {
  try {
    const result = await decideChartCompletionAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_CHART_COMPLETION_AUDIT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Chart completion audit reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Clinical task extractor
// ---------------------------------------------------------------------------
router.post('/tasks/extract', async (req, res, next) => {
  try {
    const result = await generateClinicalTaskExtraction({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TASKS_EXTRACTED',
      String(result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        generation_id: result.generation_id,
        review_id: result.review_id,
        admission_id: req.body?.admission_id,
        task_count: result.task_count,
        safety_flag_count: result.safety_flags?.length || 0,
        no_auto_assign: true,
      }
    );
    return success(res, result, 'Clinical task extraction generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/tasks', async (req, res, next) => {
  try {
    const result = await listClinicalTaskCandidates({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      priority: req.query?.priority || null,
      ownerRole: req.query?.owner_role || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Clinical task candidates retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/tasks/:id', async (req, res, next) => {
  try {
    const result = await decideClinicalTaskCandidate({
      tenantId: req.tenantId,
      taskId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TASK_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Clinical task candidate reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Abnormal result triage worklist
// ---------------------------------------------------------------------------
router.post('/abnormal-results/triage', async (req, res, next) => {
  try {
    const result = await generateAdmissionAiDraft(
      req.body?.admission_id,
      'abnormal_result_triage',
      req.user?.uid || null,
      req
    );
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ABNORMAL_RESULT_TRIAGE_GENERATED',
      String(result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        admission_id: req.body?.admission_id || null,
        generation_id: result.generation_id || null,
        urgent_count: result.draft?.urgent_items?.length || 0,
        watch_count: result.draft?.watch_items?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Abnormal result triage draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/abnormal-results/triage', async (req, res, next) => {
  try {
    const result = await listAbnormalResultTriageDrafts({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      urgencyBand: req.query?.urgency_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Abnormal result triage drafts retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Infection control sentinel
// ---------------------------------------------------------------------------
router.post('/infection-control/audits', async (req, res, next) => {
  try {
    const result = await generateInfectionControlAudit({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_INFECTION_CONTROL_AUDIT_GENERATED',
      String(result.audit_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        audit_id: result.audit_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        risk_score: result.draft?.risk_score,
        risk_band: result.draft?.risk_band,
        signal_count: result.draft?.signals?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Infection-control audit generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/infection-control/audits', async (req, res, next) => {
  try {
    const result = await listInfectionControlAudits({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      riskBand: req.query?.risk_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Infection-control audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/infection-control/audits/:id', async (req, res, next) => {
  try {
    const result = await decideInfectionControlAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_INFECTION_CONTROL_AUDIT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Infection-control audit reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Antimicrobial stewardship assistant
// ---------------------------------------------------------------------------
router.post('/antimicrobial-stewardship/reviews', async (req, res, next) => {
  try {
    const result = await generateAntimicrobialStewardshipReview({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ANTIMICROBIAL_STEWARDSHIP_REVIEW_GENERATED',
      String(result.review_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        review_id: result.review_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        stewardship_score: result.draft?.stewardship_score,
        risk_band: result.draft?.risk_band,
        flag_count: result.draft?.flags?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Antimicrobial stewardship review generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/antimicrobial-stewardship/reviews', async (req, res, next) => {
  try {
    const result = await listAntimicrobialStewardshipReviews({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      riskBand: req.query?.risk_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Antimicrobial stewardship reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/antimicrobial-stewardship/reviews/:id', async (req, res, next) => {
  try {
    const result = await decideAntimicrobialStewardshipReview({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ANTIMICROBIAL_STEWARDSHIP_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Antimicrobial stewardship review updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Patient teach-back / comprehension AI
// ---------------------------------------------------------------------------
router.post('/teach-back/sessions', async (req, res, next) => {
  try {
    const result = await generateTeachBackSession({
      req,
      patientUid: req.body?.patient_uid || null,
      admissionId: req.body?.admission_id || null,
      sourceGenerationId: req.body?.source_generation_id || null,
      language: req.body?.language || 'en',
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TEACH_BACK_SESSION_GENERATED',
      String(result.session_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        session_id: result.session_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        language: result.language,
        comprehension_score: result.draft?.comprehension_score,
        question_count: result.draft?.questions?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Patient teach-back session generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/teach-back/sessions/:id/answers', async (req, res, next) => {
  try {
    const result = await submitTeachBackAnswers({
      req,
      sessionId: req.params.id,
      answers: req.body?.answers || [],
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TEACH_BACK_ANSWERS_SUBMITTED',
      String(result.id),
      null,
      {
        session_id: result.id,
        status: result.status,
        comprehension_score: result.comprehension_score,
        misunderstanding_count: Array.isArray(result.misunderstanding_flags) ? result.misunderstanding_flags.length : 0,
      }
    );
    return success(res, result, 'Patient teach-back answers recorded');
  } catch (err) {
    return next(err);
  }
});

router.get('/teach-back/sessions', async (req, res, next) => {
  try {
    const result = await listTeachBackSessions({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      status: req.query?.status || null,
      decision: req.query?.decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Patient teach-back sessions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/teach-back/sessions/:id', async (req, res, next) => {
  try {
    const result = await decideTeachBackSession({
      tenantId: req.tenantId,
      sessionId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_TEACH_BACK_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Patient teach-back session updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Sepsis bundle sentinel
// ---------------------------------------------------------------------------
router.post('/sepsis-bundle/audits', async (req, res, next) => {
  try {
    const result = await generateSepsisBundleAudit({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_SEPSIS_BUNDLE_AUDIT_GENERATED',
      String(result.audit_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        audit_id: result.audit_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        risk_score: result.draft?.risk_score,
        risk_band: result.draft?.risk_band,
        criterion_count: result.draft?.criteria?.length || 0,
        bundle_gap_count: result.draft?.bundle_gaps?.length || 0,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Sepsis bundle audit generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/sepsis-bundle/audits', async (req, res, next) => {
  try {
    const result = await listSepsisBundleAudits({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      riskBand: req.query?.risk_band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Sepsis bundle audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/sepsis-bundle/audits/:id', async (req, res, next) => {
  try {
    const result = await decideSepsisBundleAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_SEPSIS_BUNDLE_AUDIT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Sepsis bundle audit reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Consent & PHI policy sentinel
// ---------------------------------------------------------------------------
router.post('/privacy-sentinel/scans', async (req, res, next) => {
  try {
    const result = await runConsentPhiPolicyScan({
      req,
      generationId: req.body?.generation_id || null,
      windowDays: req.body?.window_days || 7,
      limit: req.body?.limit || 100,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PRIVACY_SENTINEL_SCAN_COMPLETED',
      String(req.body?.generation_id || req.tenantId || 'tenant'),
      null,
      {
        generation_id: req.body?.generation_id || null,
        window_days: req.body?.window_days || 7,
        summary: result.summary,
      }
    );
    return success(res, result, 'Privacy sentinel scan completed', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/privacy-sentinel/audits', async (req, res, next) => {
  try {
    const result = await listConsentPhiPolicyAudits({
      tenantId: req.tenantId,
      riskBand: req.query?.risk_band || null,
      decision: req.query?.decision || null,
      moduleKey: req.query?.module_key || null,
      patientUid: req.query?.patient_uid || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Privacy sentinel audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/privacy-sentinel/audits/:id', async (req, res, next) => {
  try {
    const result = await decideConsentPhiPolicyAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PRIVACY_SENTINEL_AUDIT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Privacy sentinel audit reviewed');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Staff roster optimizer
// ---------------------------------------------------------------------------
router.post('/roster', async (req, res, next) => {
  try {
    const result = await generateRoster({
      req,
      department: req.body?.department,
      startDate: req.body?.start_date,
      endDate: req.body?.end_date,
      demandOverride: req.body?.demand || null,
      staffOverride: req.body?.staff || null,
      strategy: req.body?.strategy || null,
      solverTimeoutMs: req.body?.solver_timeout_ms || undefined,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_ROSTER_SUGGESTED', String(result.run_id || 'inline'), null, {
      department: result.department,
      total_slots: result.total_slots,
      filled_slots: result.filled_slots,
      gaps: result.coverage_gaps.length,
      optimizer: result.optimizer,
      solver_status: result.solver_status,
    });
    return success(res, result, 'Roster suggested', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/roster', async (req, res, next) => {
  try {
    const result = await listRosterRuns({
      tenantId: req.tenantId,
      department: req.query?.department || null,
      status: req.query?.status || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Roster runs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/roster/:id/publish', async (req, res, next) => {
  try {
    const published = await publishRoster({
      tenantId: req.tenantId,
      runId: req.params.id,
      publishedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_ROSTER_PUBLISHED', String(published.id), null, published);
    return success(res, published, 'Roster published');
  } catch (err) {
    return next(err);
  }
});

router.patch('/roster/:id/discard', async (req, res, next) => {
  try {
    const discarded = await discardRoster({
      tenantId: req.tenantId,
      runId: req.params.id,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_ROSTER_DISCARDED', String(discarded.id), null, discarded);
    return success(res, discarded, 'Roster discarded');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Virtual ward — enrollments + escalations
// ---------------------------------------------------------------------------
router.post('/virtual-ward/enrollments', async (req, res, next) => {
  try {
    const enrollment = await enrollPatient({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      careManagerUid: req.body?.care_manager_uid || null,
      pathway: req.body?.pathway || 'generic_post_discharge',
      startDate: req.body?.start_date || null,
      expectedCheckInCadenceHours: req.body?.expected_check_in_cadence_hours || 24,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_VIRTUAL_WARD_ENROLLED', String(enrollment.id), null, enrollment);
    return success(res, enrollment, 'Patient enrolled in virtual ward', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/virtual-ward/enrollments', async (req, res, next) => {
  try {
    const result = await listActiveEnrollments({ tenantId: req.tenantId, limit: req.query.limit });
    return success(res, result, 'Active enrollments retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/virtual-ward/escalations', async (req, res, next) => {
  try {
    const result = await listOpenEscalations({
      tenantId: req.tenantId,
      severity: req.query.severity || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Open escalations retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/virtual-ward/escalations/:id/acknowledge', async (req, res, next) => {
  try {
    const acked = await acknowledgeEscalation({
      tenantId: req.tenantId,
      escalationId: req.params.id,
      acknowledgedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_VIRTUAL_WARD_ACK', String(acked.id), null, acked);
    return success(res, acked, 'Escalation acknowledged');
  } catch (err) {
    return next(err);
  }
});

router.patch('/virtual-ward/escalations/:id/resolve', async (req, res, next) => {
  try {
    const resolved = await resolveEscalation({
      tenantId: req.tenantId,
      escalationId: req.params.id,
      resolution: req.body?.resolution,
      note: req.body?.note || null,
      resolvedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_VIRTUAL_WARD_RESOLVED', String(resolved.id), null, resolved);
    return success(res, resolved, 'Escalation resolved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Imaging AI — DICOM study register + inference ingestion + review
// ---------------------------------------------------------------------------
router.get('/imaging/pacs/status', async (req, res, next) => {
  try {
    const result = getImagingPacsStatus({ tenantRegion: req.tenant?.region || null });
    return success(res, result, 'Imaging PACS adapter status retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/imaging/studies', async (req, res, next) => {
  try {
    const saved = await registerImagingStudy({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id,
      studyInstanceUid: req.body?.study_instance_uid,
      modality: req.body?.modality,
      bodyPart: req.body?.body_part,
      studyDate: req.body?.study_date,
      seriesCount: req.body?.series_count,
      instanceCount: req.body?.instance_count,
      pacsUrl: req.body?.pacs_url,
      storageKey: req.body?.storage_key,
      sourceSystem: req.body?.source_system,
      orderedBy: req.user?.uid || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_IMAGING_STUDY_REGISTERED', String(saved.id), null, saved);
    return success(res, saved, 'Imaging study registered', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/imaging/studies/import-pacs', async (req, res, next) => {
  try {
    const result = await importImagingStudyFromPacs({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id,
      studyInstanceUid: req.body?.study_instance_uid,
      accessionNumber: req.body?.accession_number,
      provider: req.body?.provider || null,
      orderedBy: req.user?.uid || null,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_IMAGING_PACS_IMPORT', String(result.study?.id || 'inline'), null, {
      imported: result.imported,
      pacs_status: result.pacs_status,
      reason: result.reason || null,
      provider: result.provider,
      api_mode: result.api_mode,
    });
    return success(res, result, result.imported ? 'Imaging study imported from PACS' : 'Imaging PACS import skipped', result.imported ? 201 : 200);
  } catch (err) {
    return next(err);
  }
});

router.post('/imaging/inference', async (req, res, next) => {
  try {
    const result = await ingestInferenceResult({
      req,
      studyInstanceUid: req.body?.study_instance_uid,
      provider: req.body?.provider,
      model: req.body?.model || null,
      modelVersion: req.body?.model_version || null,
      results: req.body?.results || [],
      heatmapUrl: req.body?.heatmap_url || null,
      rawProviderPayload: req.body?.raw_provider_payload || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_IMAGING_INFERENCE_INGESTED', String(result.finding_id || 'inline'), null, {
      severity: result.overall_severity,
      confidence_pct: result.confidence_pct,
    });
    return success(res, result, 'Imaging inference ingested', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/imaging/findings', async (req, res, next) => {
  try {
    const result = await listImagingFindings({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      severity: req.query.severity || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Imaging findings retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/imaging/findings/:id', async (req, res, next) => {
  try {
    const decided = await decideImagingFinding({
      tenantId: req.tenantId,
      findingId: req.params.id,
      decision: req.body?.decision,
      radiologistUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_IMAGING_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'Imaging finding decided');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Batch 5: prior authorization
// ---------------------------------------------------------------------------
router.post('/prior-auth', async (req, res, next) => {
  try {
    const result = await generatePriorAuthorization({
      req,
      admissionId: req.body?.admission_id,
      payerName: req.body?.payer_name,
      policyNumber: req.body?.policy_number || null,
      procedureCode: req.body?.procedure_code,
      procedureDescription: req.body?.procedure_description || null,
      requestedServiceType: req.body?.requested_service_type || 'inpatient_procedure',
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PRIOR_AUTH_GENERATED', String(result.prior_auth_id || 'inline'), null, {
      payer: req.body?.payer_name,
      procedure: req.body?.procedure_code,
    });
    return success(res, result, 'Prior authorization packet generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/prior-auth', async (req, res, next) => {
  try {
    const result = await listPriorAuthorizations({
      tenantId: req.tenantId,
      status: req.query.status || null,
      reviewerDecision: req.query.reviewer_decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Prior auth requests retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/prior-auth/:id/submit', async (req, res, next) => {
  try {
    const submitted = await submitPriorAuthorization({
      tenantId: req.tenantId,
      tenantRegion: req.tenant?.region || null,
      priorAuthId: req.params.id,
      submittedBy: req.user?.uid || null,
      payerReferenceId: req.body?.payer_reference_id || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PRIOR_AUTH_SUBMITTED', String(submitted.id), null, submitted);
    return success(res, submitted, 'Prior auth submitted to payer');
  } catch (err) {
    return next(err);
  }
});

router.patch('/prior-auth/:id/payer-decision', async (req, res, next) => {
  try {
    const decided = await recordPayerDecision({
      tenantId: req.tenantId,
      priorAuthId: req.params.id,
      decision: req.body?.decision,
      reason: req.body?.reason || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PRIOR_AUTH_PAYER_DECISION', String(decided.id), null, decided);
    return success(res, decided, 'Payer decision recorded');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Appeal letter generator for denied claims
// ---------------------------------------------------------------------------
router.post('/appeal-letters', async (req, res, next) => {
  try {
    const result = await generateAppealLetter({
      req,
      claimId: req.body?.claim_id,
      denialReason: req.body?.denial_reason || null,
      denialCode: req.body?.denial_code || null,
      appealType: req.body?.appeal_type || 'first_level',
      admissionId: req.body?.admission_id || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_APPEAL_LETTER_GENERATED',
      String(result.appeal_id || result.generation_id || req.body?.claim_id || 'inline'),
      null,
      {
        appeal_id: result.appeal_id,
        generation_id: result.generation_id,
        claim_id: req.body?.claim_id,
        classification: result.classification?.classification,
        appeal_type: result.draft?.appeal_type,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Appeal letter draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/appeal-letters', async (req, res, next) => {
  try {
    const result = await listAppealLetters({
      tenantId: req.tenantId,
      claimId: req.query?.claim_id || null,
      patientUid: req.query?.patient_uid || null,
      appealStatus: req.query?.appeal_status || null,
      decision: req.query?.decision || null,
      classification: req.query?.classification || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Appeal letters retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/appeal-letters/:id', async (req, res, next) => {
  try {
    const result = await decideAppealLetter({
      tenantId: req.tenantId,
      appealId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_APPEAL_LETTER_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Appeal letter review recorded');
  } catch (err) {
    return next(err);
  }
});

router.post('/appeal-letters/:id/submit', async (req, res, next) => {
  try {
    const result = await submitAppealLetter({
      tenantId: req.tenantId,
      appealId: req.params.id,
      submittedBy: req.user?.uid || null,
      payerReferenceId: req.body?.payer_reference_id || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_APPEAL_LETTER_SUBMITTED', String(result.id), null, result);
    return success(res, result, 'Appeal letter submitted');
  } catch (err) {
    return next(err);
  }
});

router.post('/appeal-letters/:id/payer-response', async (req, res, next) => {
  try {
    const result = await recordAppealPayerResponse({
      tenantId: req.tenantId,
      appealId: req.params.id,
      status: req.body?.status,
      response: req.body?.response || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_APPEAL_LETTER_PAYER_RESPONSE', String(result.id), null, result);
    return success(res, result, 'Appeal letter payer response recorded');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// AI ROI dashboard
// ---------------------------------------------------------------------------
router.get('/roi', async (req, res, next) => {
  try {
    const metrics = await computeAiRoiMetrics({
      tenantId: req.tenantId,
      periodDays: req.query?.period_days,
    });
    return success(res, metrics, 'AI ROI metrics computed');
  } catch (err) {
    return next(err);
  }
});

router.post('/roi/snapshots', async (req, res, next) => {
  try {
    const metrics = await computeAiRoiMetrics({
      tenantId: req.tenantId,
      periodDays: req.body?.period_days,
    });
    const snapshot = await saveAiRoiSnapshot({
      tenantId: req.tenantId,
      metrics,
      moduleKey: req.body?.module_key || 'ALL',
      computedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ROI_SNAPSHOT_RECORDED',
      String(snapshot?.id || 'inline'),
      null,
      {
        snapshot_id: snapshot?.id,
        period_days: metrics.period_days,
        generation_count: metrics.generation_count,
        accepted_count: metrics.accepted_count,
        time_saved_minutes: metrics.time_saved_minutes,
      }
    );
    return success(res, { snapshot, metrics }, 'AI ROI snapshot saved', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/roi/snapshots', async (req, res, next) => {
  try {
    const result = await listAiRoiSnapshots({
      tenantId: req.tenantId,
      moduleKey: req.query?.module_key || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'AI ROI snapshots retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/roi/snapshots/latest', async (req, res, next) => {
  try {
    const snapshot = await getLatestAiRoiSnapshot({
      tenantId: req.tenantId,
      moduleKey: req.query?.module_key || 'ALL',
    });
    return success(res, { snapshot }, 'Latest AI ROI snapshot retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Nursing ambient documentation
// ---------------------------------------------------------------------------
router.post('/nursing-ambient/sessions', async (req, res, next) => {
  try {
    const result = await generateNursingAmbientSession({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      nurseUid: req.body?.nurse_uid || req.user?.uid || null,
      shift: req.body?.shift || 'day',
      recordingStartedAt: req.body?.recording_started_at || null,
      recordingEndedAt: req.body?.recording_ended_at || null,
      durationSeconds: req.body?.duration_seconds || null,
      consentReference: req.body?.consent_reference || null,
      audioStorageKey: req.body?.audio_storage_key || null,
      audioMime: req.body?.audio_mime || null,
      sttProvider: req.body?.stt_provider || 'none',
      sttModel: req.body?.stt_model || null,
      sttLanguage: req.body?.stt_language || null,
      diarizationProvider: req.body?.diarization_provider || null,
      transcriptSegments: req.body?.transcript_segments || [],
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_NURSING_AMBIENT_SESSION_GENERATED',
      String(result.session_id || result.generation_id || req.body?.patient_uid || 'inline'),
      null,
      {
        session_id: result.session_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        shift: result.shift,
        fall_count: result.draft?.falls?.length || 0,
        wound_count: result.draft?.wounds?.length || 0,
      }
    );
    return success(res, result, 'Nursing ambient session generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/nursing-ambient/sessions', async (req, res, next) => {
  try {
    const result = await listNursingAmbientSessions({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      shift: req.query?.shift || null,
      decision: req.query?.decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Nursing ambient sessions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/nursing-ambient/sessions/:id', async (req, res, next) => {
  try {
    const result = await decideNursingAmbientSession({
      tenantId: req.tenantId,
      sessionId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_NURSING_AMBIENT_REVIEWED',
      String(result.id),
      null,
      result
    );
    return success(res, result, 'Nursing ambient session updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Consent-aware family update generator
// ---------------------------------------------------------------------------
router.post('/family-updates', async (req, res, next) => {
  try {
    const result = await generateFamilyUpdate({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      caregiverIdentifier: req.body?.caregiver_identifier || null,
      caregiverRelationship: req.body?.caregiver_relationship || 'other',
      language: req.body?.language || 'en',
      sourceGenerationId: req.body?.source_generation_id || null,
      consentReference: req.body?.consent_reference || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_FAMILY_UPDATE_GENERATED',
      String(result.update_id || result.generation_id || req.body?.patient_uid || 'inline'),
      null,
      {
        update_id: result.update_id,
        generation_id: result.generation_id,
        admission_id: req.body?.admission_id,
        caregiver_relationship: result.caregiver_relationship,
        language: result.language,
        safety_flag_count: result.safety_flags?.length || 0,
      }
    );
    return success(res, result, 'Family update drafted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/family-updates', async (req, res, next) => {
  try {
    const result = await listFamilyUpdates({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      updateStatus: req.query?.update_status || null,
      decision: req.query?.decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Family updates retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/family-updates/:id', async (req, res, next) => {
  try {
    const result = await decideFamilyUpdate({
      tenantId: req.tenantId,
      updateId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_FAMILY_UPDATE_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Family update review recorded');
  } catch (err) {
    return next(err);
  }
});

router.post('/family-updates/:id/sent', async (req, res, next) => {
  try {
    const result = await markFamilyUpdateSent({
      tenantId: req.tenantId,
      updateId: req.params.id,
      sentBy: req.user?.uid || null,
      deliveryChannel: req.body?.delivery_channel || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_FAMILY_UPDATE_SENT', String(result.id), null, result);
    return success(res, result, 'Family update marked as sent');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Payer contract variance / underpayment AI
// ---------------------------------------------------------------------------
router.post('/payer-contracts', async (req, res, next) => {
  try {
    const result = await upsertPayerContract({
      tenantId: req.tenantId,
      payerName: req.body?.payer_name,
      payerCode: req.body?.payer_code || null,
      procedureCode: req.body?.procedure_code,
      procedureDescription: req.body?.procedure_description || null,
      expectedRateMinor: req.body?.expected_rate_minor,
      currencyCode: req.body?.currency_code || 'INR',
      tolerancePct: req.body?.tolerance_pct,
      effectiveStartDate: req.body?.effective_start_date || null,
      effectiveEndDate: req.body?.effective_end_date || null,
      contractReference: req.body?.contract_reference || null,
      notes: req.body?.notes || null,
      active: req.body?.active !== undefined ? Boolean(req.body.active) : true,
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PAYER_CONTRACT_UPSERTED',
      String(result?.id || req.body?.procedure_code || 'inline'),
      null,
      result
    );
    return success(res, result, 'Payer contract upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/payer-contracts', async (req, res, next) => {
  try {
    const result = await listPayerContracts({
      tenantId: req.tenantId,
      payerName: req.query?.payer_name || null,
      procedureCode: req.query?.procedure_code || null,
      active: req.query?.active === undefined ? null : req.query.active !== 'false',
      limit: req.query?.limit,
    });
    return success(res, result, 'Payer contracts retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/payer-variance/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateClaimVariance({
      req,
      claimId: req.body?.claim_id,
      procedureCode: req.body?.procedure_code || null,
      tolerancePctOverride: req.body?.tolerance_pct,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PAYER_VARIANCE_EVALUATED',
      String(result.review_id || result.generation_id || req.body?.claim_id || 'inline'),
      null,
      {
        review_id: result.review_id,
        generation_id: result.generation_id,
        claim_id: req.body?.claim_id,
        variance_category: result.draft?.variance_category,
        variance_band: result.draft?.variance_band,
      }
    );
    return success(res, result, 'Payer variance evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/payer-variance/reviews', async (req, res, next) => {
  try {
    const result = await listPayerVarianceReviews({
      tenantId: req.tenantId,
      claimId: req.query?.claim_id || null,
      decision: req.query?.decision || null,
      category: req.query?.category || null,
      band: req.query?.band || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Payer variance reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/payer-variance/reviews/:id', async (req, res, next) => {
  try {
    const result = await decidePayerVarianceReview({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PAYER_VARIANCE_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Payer variance review updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Lab autoverification / delta check
// ---------------------------------------------------------------------------
router.post('/lab-autoverifications/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateInvestigation({
      req,
      investigationId: req.body?.investigation_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_LAB_AUTOVERIFICATION_EVALUATED',
      String(result.review_id || result.generation_id || req.body?.investigation_id || 'inline'),
      null,
      {
        review_id: result.review_id,
        generation_id: result.generation_id,
        investigation_id: req.body?.investigation_id,
        decision: result.decision,
        critical_band: result.critical_band,
      }
    );
    return success(res, result, 'Lab autoverification evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/lab-autoverifications', async (req, res, next) => {
  try {
    const result = await listLabAutoverifications({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      criticalBand: req.query?.critical_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Lab autoverifications retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/lab-autoverifications/:id', async (req, res, next) => {
  try {
    const result = await decideLabAutoverification({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_LAB_AUTOVERIFICATION_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Lab autoverification review updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Pediatric dosing safety AI
// ---------------------------------------------------------------------------
router.post('/pediatric-dose-checks/evaluate', async (req, res, next) => {
  try {
    const result = await evaluatePrescriptionSafety({
      req,
      prescriptionId: req.body?.prescription_id || null,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      medicationName: req.body?.medication_name,
      prescribedDoseMg: req.body?.prescribed_dose_mg,
      prescribedRoute: req.body?.prescribed_route || null,
      prescribedFrequency: req.body?.prescribed_frequency || null,
      ageDaysOverride: req.body?.age_days_override || null,
      weightKgOverride: req.body?.weight_kg_override || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PEDIATRIC_DOSE_EVALUATED',
      String(result.check_id || result.generation_id || req.body?.patient_uid || 'inline'),
      null,
      {
        check_id: result.check_id,
        generation_id: result.generation_id,
        patient_uid: req.body?.patient_uid,
        safety_band: result.safety_band,
        medication_name: req.body?.medication_name,
      }
    );
    return success(res, result, 'Pediatric dose evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/pediatric-dose-checks', async (req, res, next) => {
  try {
    const result = await listPediatricDoseChecks({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      admissionId: req.query?.admission_id || null,
      safetyBand: req.query?.safety_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Pediatric dose checks retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/pediatric-dose-checks/:id', async (req, res, next) => {
  try {
    const result = await decidePediatricDoseCheck({
      tenantId: req.tenantId,
      checkId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PEDIATRIC_DOSE_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Pediatric dose check updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Batch 4: clinical trials + RCA drafts
// ---------------------------------------------------------------------------
router.post('/trials/catalog', async (req, res, next) => {
  try {
    const trial = await upsertTrial({
      tenantId: req.tenantId,
      nctId: req.body?.nct_id,
      title: req.body?.title,
      phase: req.body?.phase || null,
      conditions: req.body?.conditions || [],
      eligibilitySummary: req.body?.eligibility_summary,
      ageMin: req.body?.age_min ?? null,
      ageMax: req.body?.age_max ?? null,
      gender: req.body?.gender || null,
      location: req.body?.location || null,
      status: req.body?.status || 'recruiting',
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_TRIAL_UPSERTED', String(trial.id), null, trial);
    return success(res, trial, 'Trial upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/trials/sync', async (req, res, next) => {
  try {
    const result = await syncTrialsFromPublicRegistry({
      tenantId: req.tenantId,
      conditions: Array.isArray(req.body?.conditions) ? req.body.conditions : null,
      location: req.body?.location || null,
      maxResults: req.body?.max_results,
      requestedBy: req.user?.uid || null,
      tenantRegion: req.tenant?.region || 'IN',
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_TRIAL_CATALOG_SYNCED', String(result.run_id || 'inline'), null, {
      fetched: result.fetched_count,
      upserted: result.upserted_count,
      status: result.status,
    });
    return success(res, result, 'Trial catalog sync complete', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/trials/sync', async (req, res, next) => {
  try {
    const result = await listTrialSyncRuns({ tenantId: req.tenantId, limit: req.query.limit });
    return success(res, result, 'Trial sync runs retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/trials/match/:patientUid', async (req, res, next) => {
  try {
    const result = await matchPatientAgainstTrials({
      tenantId: req.tenantId,
      patientUid: req.params.patientUid,
      admissionId: req.body?.admission_id || null,
      minScore: req.body?.min_score,
      limit: req.body?.limit,
    });
    return success(res, result, 'Trial match complete');
  } catch (err) {
    return next(err);
  }
});

router.get('/trials/matches', async (req, res, next) => {
  try {
    const result = await listTrialMatches({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Trial matches retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/trials/matches/:id', async (req, res, next) => {
  try {
    const decided = await decideTrialMatch({
      tenantId: req.tenantId,
      matchId: req.params.id,
      decision: req.body?.decision,
      decidedBy: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_TRIAL_MATCH_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'Trial match decided');
  } catch (err) {
    return next(err);
  }
});

router.post('/rca/:admissionId', async (req, res, next) => {
  try {
    const draft = await generateRcaDraft({
      req,
      admissionId: req.params.admissionId,
      caseType: req.body?.case_type || 'mortality',
    });
    return success(res, draft, 'RCA draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/rca', async (req, res, next) => {
  try {
    const result = await listRcaDrafts({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'RCA drafts retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/rca/:id', async (req, res, next) => {
  try {
    const decided = await decideRcaDraft({
      tenantId: req.tenantId,
      rcaId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_RCA_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'RCA draft decided');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Clinical safety AI (Batch 3): deterioration EW + polypharmacy review
// ---------------------------------------------------------------------------
router.get('/safety/deterioration', async (req, res, next) => {
  try {
    const result = await listDeteriorationSnapshots({
      tenantId: req.tenantId,
      band: req.query.band || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Deterioration snapshots retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/safety/deterioration/:patientUid', async (req, res, next) => {
  try {
    const result = await scoreDeterioration({
      tenantId: req.tenantId,
      patientUid: req.params.patientUid,
      admissionId: req.body?.admission_id || null,
    });
    return success(res, result, 'Deterioration score computed');
  } catch (err) {
    return next(err);
  }
});

router.get('/safety/polypharmacy', async (req, res, next) => {
  try {
    const result = await listPolypharmacyReviews({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Polypharmacy reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/safety/polypharmacy/:id', async (req, res, next) => {
  try {
    const decided = await decidePolypharmacyReview({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      reviewerNote: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_POLYPHARMACY_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'Polypharmacy review decided');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Operational AI (Batch 2): no-show, OT case-time, charge capture
// ---------------------------------------------------------------------------
router.post('/operational/no-show/:appointmentId', async (req, res, next) => {
  try {
    const result = await scoreNoShowRisk({
      tenantId: req.tenantId,
      appointmentId: req.params.appointmentId,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_NO_SHOW_RISK_SCORED',
      String(req.params.appointmentId),
      null,
      {
        appointment_id: result.appointment_id,
        risk_score: result.risk_score,
        band: result.band,
      }
    );
    return success(res, result, 'No-show risk scored');
  } catch (err) {
    return next(err);
  }
});

router.post('/operational/ot/:scheduleId', async (req, res, next) => {
  try {
    const result = await predictOtCaseTime({
      tenantId: req.tenantId,
      scheduleId: req.params.scheduleId,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_OT_CASE_TIME_PREDICTED',
      String(req.params.scheduleId),
      null,
      {
        ot_schedule_id: result.ot_schedule_id,
        predicted_minutes: result.predicted_minutes,
        confidence_pct: result.confidence_pct,
      }
    );
    return success(res, result, 'OT case-time predicted');
  } catch (err) {
    return next(err);
  }
});

router.post('/operational/charge-capture/:admissionId', async (req, res, next) => {
  try {
    const result = await auditChargeCapture({
      tenantId: req.tenantId,
      admissionId: req.params.admissionId,
    });
    return success(res, result, 'Charge capture audit complete');
  } catch (err) {
    return next(err);
  }
});

router.get('/operational/charge-capture', async (req, res, next) => {
  try {
    const result = await listChargeCaptureAudits({
      tenantId: req.tenantId,
      decision: req.query.decision || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Charge capture audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/operational/charge-capture/:id', async (req, res, next) => {
  try {
    const decided = await decideChargeCaptureAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_CHARGE_CAPTURE_DECIDED', String(decided.id), null, decided);
    return success(res, decided, 'Charge capture audit decided');
  } catch (err) {
    return next(err);
  }
});

/**
 * M4 — tenant-scoped translation list for admin dashboard.
 */
router.get('/translations', async (req, res, next) => {
  try {
    const result = await listTranslations({
      tenantId: req.tenantId,
      targetLanguage: req.query?.language || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Clinical AI translations retrieved');
  } catch (err) {
    return next(err);
  }
});

/**
 * M5 — recent longitudinal risk snapshots for the admin overview. Returns
 * the most recent snapshot per admission, banded. Used to triage which
 * patients need care-manager attention.
 */
router.get('/longitudinal-risk', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const band = req.query.band ? String(req.query.band).toLowerCase() : null;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (r.admission_id)
              r.id, r.admission_id, r.patient_uid, u.name AS patient_name,
              r.overall_score, r.band, r.adherence_score, r.adherence_source,
              r.readmission_score, r.comorbidity_score, r.abdm_enrichment,
              r.recommendations, r.created_at
       FROM clinical_longitudinal_risk r
       LEFT JOIN users u ON u.uid = r.patient_uid
       WHERE r.tenant_id = $1::uuid
         AND ($2::text IS NULL OR r.band = $2)
       ORDER BY r.admission_id, r.created_at DESC`,
      req.tenantId,
      band
    ).catch(() => []);
    const bandOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = rows
      .sort((a, b) => (bandOrder[a.band] ?? 4) - (bandOrder[b.band] ?? 4))
      .slice(0, limit);
    return success(res, { snapshots: sorted, count: sorted.length }, 'Longitudinal risk overview retrieved');
  } catch (err) {
    return next(err);
  }
});

/**
 * Dead-letter list — generations that failed defenses (status='failed').
 * Always tenant-scoped. Platform admins use this to triage PHI leaks and
 * schema violations that blocked drafts from reaching the review queue.
 */
router.get('/dead-letter', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT g.id, g.patient_uid, u.name AS patient_name, g.admission_id,
              g.task_type, g.module_key, g.provider, g.model, g.status,
              g.safety_flags, g.metadata, g.created_at
       FROM clinical_ai_generations g
       LEFT JOIN users u ON u.uid = g.patient_uid
       WHERE g.tenant_id = $1::uuid
         AND g.status = 'failed'
       ORDER BY g.created_at DESC
       LIMIT $2`,
      req.tenantId,
      limit
    );
    return success(res, { generations: rows, count: rows.length }, 'Clinical AI dead-letter queue retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
