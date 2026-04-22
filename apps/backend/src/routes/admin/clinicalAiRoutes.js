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
    const status = await getClinicalAiRuntimeStatus({ live, days });
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

router.get('/usage', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const usage = await getClinicalAiUsageSummary({ days });
    return success(res, usage, 'Clinical AI usage retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/guardrails', async (_req, res, next) => {
  try {
    const guardrails = await getClinicalAiGuardrails({ refresh: true });
    const budget = await getClinicalAiBudgetStatus({ days: 1, guardrails });
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
    const budget = await getClinicalAiBudgetStatus({ days: 1, guardrails });
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
       ORDER BY
         CASE flag->>'severity'
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           ELSE 4
         END,
         g.created_at DESC
       LIMIT $1`,
      limit
    );

    return success(res, { flags: rows, count: rows.length }, 'Clinical AI safety flags retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
