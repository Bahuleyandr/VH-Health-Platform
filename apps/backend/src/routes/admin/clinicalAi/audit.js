import prisma from '../../../lib/prisma.js';
import { rawQuery } from '../../../lib/rawSql.js';
import logger from '../../../logging/logger.js';
import { getClientIp, uuidOrNull } from './shared.js';

const CLINICAL_AI_AUDIT_RESOURCE = 'clinical_ai';

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

export function pickModuleAuditFields(module = {}) {
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

export function pickGuardrailAuditFields(guardrails = {}) {
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

export async function getClinicalAiAuditRows({ limit = 50, tenantId = null } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  return rawQuery(
    prisma,
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

export function summarizeClinicalAiAuditRows(rows = []) {
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

export async function logClinicalAiAudit(req, action, resourceId, before, after) {
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
    await rawQuery(
      prisma,
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
