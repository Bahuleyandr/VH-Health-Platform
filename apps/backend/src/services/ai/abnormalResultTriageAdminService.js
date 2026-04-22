/**
 * Admin worklist helpers for abnormal result triage drafts.
 *
 * Draft creation stays in clinicalAiWorkflowService so all admission AI modules
 * use one provider/router/defense path. This file only lists and summarizes
 * generated triage drafts for Admin/IT governance panels.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const MODULE_KEY = 'abnormal_result_triage';

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function optionalInt(value, fieldName = 'id') {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

export function summarizeAbnormalTriageDraft(draft = {}) {
  const urgentItems = asArray(draft.urgent_items);
  const watchItems = asArray(draft.watch_items);
  const criticalSafety = asArray(draft.safety_flags).filter((flag) => flag?.severity === 'critical').length;
  const urgencyScore = Math.min(100, urgentItems.length * 35 + watchItems.length * 10 + criticalSafety * 30);
  const urgencyBand = urgencyScore >= 70 || urgentItems.length >= 2
    ? 'critical'
    : urgentItems.length > 0
      ? 'urgent'
      : watchItems.length > 0
        ? 'watch'
        : 'routine';

  return {
    urgency_band: urgencyBand,
    urgency_score: urgencyScore,
    urgent_count: urgentItems.length,
    watch_count: watchItems.length,
    top_urgent: urgentItems.slice(0, 3),
    top_watch: watchItems.slice(0, 3),
    explanation: draft.explanation || 'Rule/CDS output remains authoritative. This worklist only summarizes visible chart signals.',
  };
}

export async function listAbnormalResultTriageDrafts({
  tenantId = null,
  admissionId = null,
  patientUid = null,
  urgencyBand = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeAdmissionId = optionalInt(admissionId, 'admission_id');
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT g.id, g.tenant_id, g.patient_uid, u.name AS patient_name,
              g.admission_id, COALESCE(g.module_key, g.task_type) AS module_key,
              g.provider, g.model, g.status, g.used_ai, g.prompt_version,
              g.safety_flags, g.citations, g.draft, g.total_tokens,
              g.estimated_cost_minor, g.created_at,
              r.id AS review_id, r.decision AS review_status,
              r.reviewer_uid, r.updated_at AS review_updated_at
       FROM clinical_ai_generations g
       LEFT JOIN users u ON u.uid = g.patient_uid
       LEFT JOIN LATERAL (
         SELECT id, decision, reviewer_uid, updated_at
         FROM clinical_ai_reviews
         WHERE generation_id = g.id
         ORDER BY updated_at DESC NULLS LAST, created_at DESC
         LIMIT 1
       ) r ON TRUE
       WHERE g.tenant_id = $1::uuid
         AND COALESCE(g.module_key, g.task_type) = $2
         AND ($3::int IS NULL OR g.admission_id = $3)
         AND ($4::uuid IS NULL OR g.patient_uid = $4::uuid)
       ORDER BY g.created_at DESC
       LIMIT $5`,
      tid,
      MODULE_KEY,
      safeAdmissionId,
      patientUid || null,
      safeLimit
    );
    const drafts = rows.map((row) => {
      const draft = safeJson(row.draft, {});
      const summary = summarizeAbnormalTriageDraft(draft);
      return {
        ...row,
        draft,
        safety_flags: safeJson(row.safety_flags, []),
        citations: safeJson(row.citations, []),
        summary,
      };
    }).filter((row) => !urgencyBand || row.summary.urgency_band === urgencyBand);
    return { drafts, count: drafts.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { drafts: [], count: 0 };
    throw err;
  }
}

export default {
  listAbnormalResultTriageDrafts,
  summarizeAbnormalTriageDraft,
};
