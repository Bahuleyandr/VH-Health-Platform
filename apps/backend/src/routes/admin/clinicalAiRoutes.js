import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { error, success } from '../../utils/responseHelper.js';
import { getClinicalAiRuntimeStatus } from '../../services/ai/localLlmClient.js';
import {
  getClinicalAiBudgetStatus,
  getClinicalAiGuardrails,
  getClinicalAiModule,
  getClinicalAiUsageSummary,
  listClinicalAiModules,
  updateClinicalAiGuardrails,
  updateClinicalAiModule,
} from '../../services/ai/clinicalAiModuleService.js';
import {
  activatePrompt,
  createApproval,
  createPrompt,
  decideApproval,
  endBreakGlass,
  getActiveBreakGlass,
  listApprovals,
  listPrompts,
  listReviews,
  startBreakGlass,
  updateReview,
} from '../../services/ai/clinicalAiWorkflowService.js';
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
  listCanaryRuns,
  runCanary,
  upsertCanaryCase,
} from '../../services/ai/driftCanaryService.js';

const router = express.Router();
const CLINICAL_AI_AUDIT_RESOURCE = 'clinical_ai';
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

async function logClinicalAiAudit(req, action, resourceId, before, after) {
  const metadata = {
    before,
    after,
    changed_fields: changedFields(before, after),
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
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const status = await getClinicalAiRuntimeStatus({ live, days, tenantId: req.tenantId });
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
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const usage = await getClinicalAiUsageSummary({ days, tenantId: req.tenantId });
    return success(res, usage, 'Clinical AI usage retrieved');
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
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, role, action, resource, resource_id, metadata,
              ip_address, user_agent, created_at
       FROM audit_logs
       WHERE resource = $1 OR action LIKE 'CLINICAL_AI_%'
       ORDER BY created_at DESC
       LIMIT $2`,
      CLINICAL_AI_AUDIT_RESOURCE,
      limit
    );

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
