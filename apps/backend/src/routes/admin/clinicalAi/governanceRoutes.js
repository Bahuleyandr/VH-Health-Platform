import express from 'express';
import { setTenant } from '../../../lib/prisma.js';
import { rawQuery } from '../../../lib/rawSql.js';
import { getHealthReport } from '../../../middleware/selfHealingMiddleware.js';
import { success } from '../../../utils/responseHelper.js';
import { AppError } from '../../../utils/AppError.js';
import { getClinicalAiRuntimeStatus } from '../../../services/ai/localLlmClient.js';
import { drugKbStatus } from '../../../services/clinical/drugKnowledgeBaseService.js';
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
} from '../../../services/ai/clinicalAiModuleService.js';
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
} from '../../../services/ai/clinicalAiWorkflowService.js';
import {
  listSelfHealingRuns,
  runSelfHealingScan,
} from '../../../services/ai/selfHealingService.js';
import {
  backfillSignedDischargeSummaries,
  getCorpusHealth,
  retrieveRelevant,
} from '../../../services/ai/ragService.js';
import {
  concludeExperiment,
  createExperiment,
  getExperimentStats,
  listExperiments,
} from '../../../services/ai/promptExperimentService.js';
import {
  deactivateCanaryCase,
  listCanaryCases,
  listCanaryRuns,
  runCanary,
  upsertCanaryCase,
} from '../../../services/ai/driftCanaryService.js';
import {
  assemblePilotEvidencePack,
  createPilotSignoff,
  decidePilotSignoff,
  getPilotStageGate,
  listPilotSignoffs,
} from '../../../services/ai/pilotEvidencePackService.js';
import { assembleReadinessPack } from '../../../services/ai/regulatoryReadinessService.js';
import { normalizeRole, parseClinicalAiWindowDays } from './shared.js';
import {
  getClinicalAiAuditRows,
  logClinicalAiAudit,
  pickGuardrailAuditFields,
  pickModuleAuditFields,
  summarizeClinicalAiAuditRows,
} from './audit.js';

const router = express.Router();

function isMissingClinicalAiSchema(err) {
  return /does not exist|column .* does not exist|relation .* does not exist|invalid_schema_name/i.test(
    String(err?.message || '')
  );
}

function clinicalAiSchemaUnavailable(err) {
  if (!isMissingClinicalAiSchema(err)) return err;
  return AppError.internal(
    'Clinical AI governance schema is unavailable; refusing unsafe fallback',
    'CLINICAL_AI_SCHEMA_UNAVAILABLE'
  );
}

router.get('/status', async (req, res, next) => {
  try {
    const live = String(req.query.live || '').toLowerCase() === 'true';
    const days = parseClinicalAiWindowDays(req.query.days);
    const [status, drugKb] = await Promise.all([
      getClinicalAiRuntimeStatus({
        live,
        days,
        tenantId: req.tenantId,
        tenantRegion: req.tenant?.region || null,
      }),
      drugKbStatus(),
    ]);
    return success(res, { ...status, drug_kb_status: drugKb }, 'Clinical AI status retrieved');
  } catch (err) {
    return next(clinicalAiSchemaUnavailable(err));
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
    if (module?.approval_required) {
      await logClinicalAiAudit(
        req,
        'CLINICAL_AI_TENANT_MODULE_CHANGE_APPROVAL_REQUIRED',
        `${req.tenantId}:${req.params.moduleKey}`,
        before,
        module
      );
      return success(res, module, 'Clinical AI tenant module change approval required', 202);
    }
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
    const module = await updateClinicalAiModule(
      req.params.moduleKey,
      { ...(req.body || {}), tenantId: req.tenantId },
      updatedBy
    );
    if (module?.approval_required) {
      await logClinicalAiAudit(
        req,
        'CLINICAL_AI_MODULE_CHANGE_APPROVAL_REQUIRED',
        req.params.moduleKey,
        before,
        module
      );
      return success(res, module, 'Clinical AI module change approval required', 202);
    }
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
      { tenantId: req.tenantId, allowReviewRoleOverride: true }
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
    // RLS POC — wraps the read in a tenant-scoped transaction (setTenant
    // sets `app.current_tenant_id` via set_config(..., true)). The explicit
    // `tenant_id = $1::uuid` above remains as belt-and-braces filtering; the
    // RLS policy from migration 075 is the defense-in-depth layer.
    const rows = await setTenant(req.tenantId, (tx) =>
      rawQuery(
        tx,
        `SELECT g.id, g.patient_uid, u.name AS patient_name, g.admission_id,
                g.task_type, g.module_key, g.provider, g.model, g.prompt_version, g.source_hash,
                g.status, g.used_ai, g.safety_flags, g.generated_by, g.reviewed_by,
                g.signed_note_id, g.prompt_tokens, g.completion_tokens, g.total_tokens,
                g.estimated_cost_minor, g.latency_ms, g.provider_request_id,
                g.finish_reason,
                COALESCE(
                  g.metadata->>'generation_mode',
                  CASE WHEN g.used_ai THEN 'ai' ELSE 'template_fallback' END
                ) AS generation_mode,
                COALESCE(
                  g.metadata->>'fallback_reason',
                  CASE WHEN g.used_ai THEN NULL ELSE 'template_or_rule_output' END
                ) AS fallback_reason,
                g.metadata->>'readiness_reason' AS readiness_reason,
                COALESCE(
                  g.metadata->>'provider_status',
                  CASE WHEN g.used_ai THEN 'used' ELSE 'template_fallback' END
                ) AS provider_status,
                g.metadata, g.created_at, g.updated_at
         FROM clinical_ai_generations g
         LEFT JOIN users u ON u.uid = g.patient_uid
         ${where}
         ORDER BY g.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        ...params, limit, offset,
      ),
    );

    return success(res, { generations: rows, count: rows.length }, 'Clinical AI generations retrieved');
  } catch (err) {
    return next(clinicalAiSchemaUnavailable(err));
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
    // RLS POC — transactionally scopes the lateral join to the caller's tenant.
    const rows = await setTenant(req.tenantId, (tx) =>
      rawQuery(
        tx,
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
        req.tenantId, limit,
      ),
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
      sliceAttributes: req.body?.slice_attributes,
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
// Regulatory readiness pack (S5)
// ---------------------------------------------------------------------------
router.post('/readiness-pack', async (req, res, next) => {
  try {
    const moduleKey = req.body?.module_key;
    if (!moduleKey) {
      return next(new Error('module_key is required'));
    }
    const pack = await assembleReadinessPack({
      tenantId: req.tenantId,
      moduleKey,
      fromVersion: req.body?.from_version || null,
      toVersion: req.body?.to_version || null,
      generatedBy: {
        uid: req.user?.uid || null,
        role: req.user?.role || null,
      },
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_READINESS_PACK_EXPORTED',
      moduleKey,
      null,
      {
        module_key: moduleKey,
        from_version: req.body?.from_version || null,
        to_version: req.body?.to_version || null,
        row_counts: pack.summary?.row_counts,
        bias_signal_counts: pack.summary?.bias_signal_counts,
      },
    );
    return success(res, pack, 'Regulatory readiness pack assembled', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/pilot-evidence-pack', async (req, res, next) => {
  try {
    const pack = await assemblePilotEvidencePack({
      tenantId: req.tenantId,
      moduleKeys: req.body?.module_keys ?? req.body?.module_key,
      pilotStage: req.body?.pilot_stage,
      windowDays: req.body?.window_days,
      from: req.body?.from,
      to: req.body?.to,
      minReviewedPerModule: req.body?.min_reviewed_per_module,
      generatedBy: {
        uid: req.user?.uid || null,
        role: req.user?.role || null,
      },
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PILOT_EVIDENCE_PACK_EXPORTED',
      pack.pilot_stage,
      null,
      {
        pilot_stage: pack.pilot_stage,
        module_keys: pack.module_keys,
        window_days: pack.evidence_window?.window_days,
        pilot_ready: pack.summary?.pilot_ready,
        blocker_count: pack.summary?.blockers?.length || 0,
        row_counts: pack.summary?.row_counts,
        skipped_sections: pack.summary?.skipped_sections,
      },
    );
    return success(res, pack, 'Clinical AI pilot evidence pack assembled', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/pilot-signoffs/gate', async (req, res, next) => {
  try {
    const gate = await getPilotStageGate({
      tenantId: req.tenantId,
      pilotStage: req.query.pilot_stage,
      moduleKeys: req.query.module_keys ?? req.query.module_key,
    });
    return success(res, gate, 'Clinical AI pilot signoff gate retrieved');
  } catch (err) {
    return next(clinicalAiSchemaUnavailable(err));
  }
});

router.get('/pilot-signoffs', async (req, res, next) => {
  try {
    const result = await listPilotSignoffs({
      tenantId: req.tenantId,
      pilotStage: req.query.pilot_stage,
      moduleKeys: req.query.module_keys ?? req.query.module_key,
      limit: req.query.limit,
    });
    return success(res, result, 'Clinical AI pilot signoffs retrieved');
  } catch (err) {
    return next(clinicalAiSchemaUnavailable(err));
  }
});

router.post('/pilot-signoffs', async (req, res, next) => {
  try {
    const result = await createPilotSignoff(
      {
        ...(req.body || {}),
        module_keys: req.body?.module_keys ?? req.body?.module_key,
        generatedBy: {
          uid: req.user?.uid || null,
          role: req.user?.role || null,
        },
      },
      req.user?.uid || null,
      { tenantId: req.tenantId },
    );
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PILOT_SIGNOFF_REQUESTED',
      String(result.signoff?.id || 'pilot-signoff'),
      null,
      {
        pilot_stage: result.signoff?.pilot_stage,
        module_keys: result.signoff?.module_keys,
        pack_hash: result.signoff?.pack_hash,
        pilot_ready: result.signoff?.pilot_ready,
        blocker_count: result.signoff?.blocker_count,
        skipped_sections: result.signoff?.skipped_sections,
      },
    );
    return success(res, result, 'Clinical AI pilot signoff requested', 201);
  } catch (err) {
    return next(clinicalAiSchemaUnavailable(err));
  }
});

router.patch('/pilot-signoffs/:id', async (req, res, next) => {
  try {
    const signoff = await decidePilotSignoff(
      req.params.id,
      req.body?.decision,
      req.user?.uid || null,
      req.body?.reason || null,
      { tenantId: req.tenantId },
    );
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PILOT_SIGNOFF_DECIDED',
      String(signoff.id),
      null,
      {
        decision: signoff.status,
        pilot_stage: signoff.pilot_stage,
        module_keys: signoff.module_keys,
        pack_hash: signoff.pack_hash,
        stage_expansion_allowed: signoff.stage_expansion_allowed,
        blocking_reason: signoff.blocking_reason,
      },
    );
    return success(res, signoff, 'Clinical AI pilot signoff updated');
  } catch (err) {
    return next(clinicalAiSchemaUnavailable(err));
  }
});

export default router;
