/**
 * Tenant pilot evidence pack exporter.
 *
 * Regulatory readiness packs prove one module for a regulator. This pack
 * proves one tenant pilot stage across real workflow rows: modules enabled,
 * generations labelled, risky modules eval-gated, reviews human-signed, and
 * audit trails present. It intentionally omits draft bodies and full reviewer
 * notes so the artifact is governance evidence, not another PHI bundle.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const PACK_VERSION = 'clinical-ai-pilot-evidence-pack-v1';
const SIGNOFF_APPROVAL_TYPE = 'pilot_evidence_pack_signoff';
const SIGNOFF_PAYLOAD_KIND = 'clinical_ai_pilot_signoff';
const DEFAULT_PILOT_STAGE = 'stage_1_clinical_review';
const DEFAULT_PILOT_MODULES = [
  'medication_reconciliation',
  'patient_aftercare_instructions',
];
const ROW_LIMIT = 1_000;
const MAX_MODULES = 24;
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 90;
const DEFAULT_SIGNOFF_EXPIRES_DAYS = 30;
const FINAL_REVIEW_DECISIONS = new Set(['accepted', 'signed', 'approved', 'edited']);
const RISKY_REVIEW_GATE_POLICIES = new Set(['two_person_for_enablement', 'critical_module_change']);
const PILOT_SIGNOFF_DECISIONS = new Set(['approved', 'hold', 'rejected']);

const SIGNOFF_SELECT = `id, tenant_id, approval_type, module_key, status, requested_by, approved_by,
        rejected_by, reason, payload, expires_at, decided_at, created_at, updated_at`;

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

async function safeQuery(label, fn) {
  try {
    return { rows: await fn(), skipped_reason: null };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return { rows: [], skipped_reason: 'schema_unavailable' };
    }
    logger.warn(`Pilot evidence pack query failed: ${label}`, { error: err.message });
    return { rows: [], skipped_reason: 'query_failed', error: err.message };
  }
}

function clampInt(value, { min = 1, max = 100, fallback = 1 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeModuleKeys(value) {
  const raw = Array.isArray(value)
    ? value
    : cleanText(value).split(',').map((item) => item.trim()).filter(Boolean);
  const moduleKeys = raw.length ? raw : DEFAULT_PILOT_MODULES;
  const unique = [...new Set(moduleKeys.map(cleanText).filter(Boolean))];
  if (unique.length === 0) {
    throw AppError.badRequest('At least one module_key is required', 'CLINICAL_AI_PILOT_MODULES_REQUIRED');
  }
  if (unique.length > MAX_MODULES) {
    throw AppError.badRequest(`At most ${MAX_MODULES} module_keys can be exported at once`, 'CLINICAL_AI_PILOT_MODULE_LIMIT');
  }
  return unique;
}

function normalizeOptionalModuleKeys(value) {
  if (Array.isArray(value)) {
    const cleaned = value.map(cleanText).filter(Boolean);
    return cleaned.length ? normalizeModuleKeys(cleaned) : null;
  }
  const cleaned = cleanText(value);
  return cleaned ? normalizeModuleKeys(cleaned) : null;
}

function effectiveModuleSettings(row = {}) {
  return {
    ...(row.settings || {}),
    ...(row.tenant_settings || {}),
  };
}

function resolveWindow(options = {}) {
  const windowDays = clampInt(options.windowDays ?? options.window_days, {
    min: 1,
    max: MAX_WINDOW_DAYS,
    fallback: DEFAULT_WINDOW_DAYS,
  });
  const to = options.to ? new Date(options.to) : new Date();
  if (Number.isNaN(to.getTime())) {
    throw AppError.badRequest('to must be a valid timestamp', 'CLINICAL_AI_PILOT_WINDOW_INVALID');
  }
  const from = options.from
    ? new Date(options.from)
    : new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || from > to) {
    throw AppError.badRequest('from must be a valid timestamp before to', 'CLINICAL_AI_PILOT_WINDOW_INVALID');
  }
  return { from, to, windowDays };
}

function resolveSignoffExpiry(value) {
  if (!value) {
    return new Date(Date.now() + DEFAULT_SIGNOFF_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  }
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime())) {
    throw AppError.badRequest('expires_at must be a valid timestamp', 'CLINICAL_AI_PILOT_SIGNOFF_EXPIRY_INVALID');
  }
  return expiresAt;
}

function rowCounts(sections) {
  return Object.fromEntries(
    Object.entries(sections).map(([key, value]) => [
      key,
      value === null ? 0 : Array.isArray(value) ? value.length : 1,
    ]),
  );
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function severityCountsFromFlags(rows = []) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const row of rows) {
    const flags = Array.isArray(row.safety_flags) ? row.safety_flags : [];
    for (const flag of flags) {
      const severity = cleanText(flag?.severity).toLowerCase();
      if (severity in counts) counts[severity] += 1;
    }
  }
  return counts;
}

function isRiskyModule(row = {}) {
  const settings = effectiveModuleSettings(row);
  const risk = cleanText(settings.risk).toLowerCase();
  const approvalPolicy = cleanText(settings.approvalPolicy || settings.approval_policy).toLowerCase();
  return ['high', 'critical'].includes(risk) || RISKY_REVIEW_GATE_POLICIES.has(approvalPolicy);
}

function summarizeModules(requestedModuleKeys, moduleRows, generationRows, reviewRows, safetyRows, evalRows, minReviewedPerModule) {
  const byModule = new Map(moduleRows.map((row) => [row.module_key, row]));
  const generationCounts = countBy(generationRows, (row) => row.module_key);
  const aiCounts = countBy(generationRows.filter((row) => row.used_ai === true), (row) => row.module_key);
  const fallbackCounts = countBy(generationRows.filter((row) => {
    const mode = cleanText(row.generation_mode).toLowerCase();
    return mode.includes('fallback') || mode === 'schema_unavailable' || mode === 'blocked';
  }), (row) => row.module_key);
  const finalReviews = reviewRows.filter((row) => FINAL_REVIEW_DECISIONS.has(cleanText(row.decision).toLowerCase()));
  const reviewedCounts = countBy(finalReviews, (row) => row.module_key);
  const missingNoteCounts = countBy(finalReviews.filter((row) => !row.reviewer_note_present), (row) => row.module_key);
  const pendingCounts = countBy(reviewRows.filter((row) => cleanText(row.decision).toLowerCase() === 'pending'), (row) => row.module_key);
  const acceptedCounts = countBy(reviewRows.filter((row) => ['accepted', 'signed', 'approved'].includes(cleanText(row.decision).toLowerCase())), (row) => row.module_key);
  const editedCounts = countBy(reviewRows.filter((row) => cleanText(row.decision).toLowerCase() === 'edited'), (row) => row.module_key);
  const rejectedCounts = countBy(reviewRows.filter((row) => cleanText(row.decision).toLowerCase() === 'rejected'), (row) => row.module_key);
  const safetyBlockedCounts = countBy(safetyRows.filter((row) => ['blocked', 'reject', 'failed'].includes(cleanText(row.status).toLowerCase())), (row) => row.module_key);
  const acceptedEvalCounts = countBy(evalRows.filter((row) => (
    cleanText(row.reviewer_decision).toLowerCase() === 'accepted' ||
    cleanText(row.recommendation).toLowerCase() === 'no_action'
  )), (row) => row.model_key || row.module_key);

  return requestedModuleKeys.map((moduleKey) => {
    const moduleRow = byModule.get(moduleKey) || null;
    const settings = moduleRow ? effectiveModuleSettings(moduleRow) : {};
    const finalReviewCount = reviewedCounts[moduleKey] || 0;
    return {
      module_key: moduleKey,
      registered: Boolean(moduleRow),
      effective_enabled: moduleRow ? moduleRow.effective_enabled === true : false,
      risk: settings.risk || null,
      approval_policy: settings.approvalPolicy || settings.approval_policy || null,
      risky: moduleRow ? isRiskyModule(moduleRow) : false,
      generation_count: generationCounts[moduleKey] || 0,
      ai_generation_count: aiCounts[moduleKey] || 0,
      fallback_or_blocked_count: fallbackCounts[moduleKey] || 0,
      accepted_count: acceptedCounts[moduleKey] || 0,
      edited_count: editedCounts[moduleKey] || 0,
      rejected_count: rejectedCounts[moduleKey] || 0,
      pending_count: pendingCounts[moduleKey] || 0,
      final_review_count: finalReviewCount,
      min_reviewed_required: minReviewedPerModule,
      final_review_requirement_met: finalReviewCount >= minReviewedPerModule,
      final_reviews_missing_note_count: missingNoteCounts[moduleKey] || 0,
      safety_blocked_count: safetyBlockedCounts[moduleKey] || 0,
      accepted_eval_count: acceptedEvalCounts[moduleKey] || 0,
    };
  });
}

function summarizeReviews(rows = []) {
  const countsByDecision = countBy(rows, (row) => cleanText(row.decision).toLowerCase() || 'unknown');
  const finalRows = rows.filter((row) => FINAL_REVIEW_DECISIONS.has(cleanText(row.decision).toLowerCase()));
  const missingNotes = finalRows.filter((row) => !row.reviewer_note_present);
  return {
    total: rows.length,
    by_decision: countsByDecision,
    final_review_count: finalRows.length,
    final_reviews_missing_note_count: missingNotes.length,
  };
}

function summarizeSafetyReviews(rows = [], generationRows = []) {
  const safetyReviewByStatus = countBy(rows, (row) => cleanText(row.status).toLowerCase() || 'unknown');
  return {
    total: rows.length,
    by_status: safetyReviewByStatus,
    generation_flag_counts: severityCountsFromFlags(generationRows),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashPack(pack) {
  return crypto.createHash('sha256').update(stableJson(pack)).digest('hex');
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') return value;
  return {};
}

function skippedSectionCount(skippedSections = {}) {
  return Object.keys(skippedSections || {}).length;
}

function isExpiredDate(value) {
  if (!value) return false;
  const expiresAt = new Date(value);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();
}

function buildSignoffPayload(pack, data = {}) {
  const summary = pack.summary || {};
  const payload = {
    kind: SIGNOFF_PAYLOAD_KIND,
    pack_version: pack.pack_version,
    pilot_stage: pack.pilot_stage,
    module_keys: pack.module_keys,
    evidence_window: pack.evidence_window,
    min_reviewed_per_module: pack.min_reviewed_per_module,
    decision_support_only: true,
    human_review_required: true,
    pilot_ready: Boolean(summary.pilot_ready),
    blocker_count: Array.isArray(summary.blockers) ? summary.blockers.length : 0,
    blockers: summary.blockers || [],
    skipped_sections: summary.skipped_sections || {},
    row_counts: summary.row_counts || {},
    module_summary: summary.module_summary || [],
    generation_counts: summary.generation_counts || {},
    review_counts: summary.review_counts || {},
    safety_counts: summary.safety_counts || {},
    eval_counts: summary.eval_counts || {},
    audit_counts: summary.audit_counts || {},
    requested_reason: cleanText(data.reason) || null,
    requested_at: new Date().toISOString(),
    pack_snapshot: pack,
  };
  payload.pack_hash = hashPack(payload.pack_snapshot);
  return payload;
}

function signoffBlockingReason(summary = null) {
  if (!summary) return 'SIGNOFF_REQUIRED';
  if (summary.status === 'pending') return 'SIGNOFF_PENDING';
  if (summary.status === 'hold') return 'SIGNOFF_ON_HOLD';
  if (summary.status === 'rejected') return 'SIGNOFF_REJECTED';
  if (summary.expired) return 'SIGNOFF_EXPIRED';
  if (summary.skipped_section_count > 0) return 'PILOT_SCHEMA_UNAVAILABLE';
  if (!summary.pilot_ready || summary.blocker_count > 0) return 'PILOT_EVIDENCE_BLOCKED';
  if (summary.status !== 'approved') return 'SIGNOFF_REQUIRED';
  return null;
}

function summarizeSignoffRow(row) {
  if (!row) return null;
  const payload = parsePayload(row.payload);
  const blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
  const skippedSections = payload.skipped_sections || {};
  const expired = isExpiredDate(row.expires_at);
  const stageExpansionAllowed = (
    row.status === 'approved' &&
    !expired &&
    payload.pilot_ready === true &&
    blockers.length === 0 &&
    skippedSectionCount(skippedSections) === 0
  );
  const summary = {
    id: row.id,
    tenant_id: row.tenant_id,
    approval_type: row.approval_type,
    status: row.status,
    pilot_stage: payload.pilot_stage || null,
    module_keys: Array.isArray(payload.module_keys) ? payload.module_keys : [],
    requested_by: row.requested_by || null,
    approved_by: row.approved_by || null,
    rejected_by: row.rejected_by || null,
    reason: row.reason || null,
    pack_hash: payload.pack_hash || null,
    pack_version: payload.pack_version || null,
    evidence_window: payload.evidence_window || null,
    min_reviewed_per_module: payload.min_reviewed_per_module || null,
    pilot_ready: payload.pilot_ready === true,
    blocker_count: blockers.length,
    blockers,
    skipped_sections: skippedSections,
    skipped_section_count: skippedSectionCount(skippedSections),
    row_counts: payload.row_counts || {},
    module_summary: payload.module_summary || [],
    generation_counts: payload.generation_counts || {},
    review_counts: payload.review_counts || {},
    safety_counts: payload.safety_counts || {},
    eval_counts: payload.eval_counts || {},
    audit_counts: payload.audit_counts || {},
    pack_snapshot_present: Boolean(payload.pack_snapshot),
    stage_expansion_allowed: stageExpansionAllowed,
    expired,
    expires_at: row.expires_at || null,
    decided_at: row.decided_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
  return {
    ...summary,
    blocking_reason: stageExpansionAllowed ? null : signoffBlockingReason(summary),
  };
}

function assertSignoffApprovable(signoff) {
  if (!signoff) return;
  if (signoff.expired) {
    throw AppError.conflict(
      'Pilot signoff evidence has expired; create a fresh evidence-pack signoff',
      'CLINICAL_AI_PILOT_SIGNOFF_EXPIRED',
      { expires_at: signoff.expires_at },
    );
  }
  if (signoff.skipped_section_count > 0) {
    throw AppError.forbidden(
      'Pilot signoff cannot be approved while evidence schema sections are unavailable',
      'CLINICAL_AI_PILOT_SCHEMA_UNAVAILABLE',
      { skipped_sections: signoff.skipped_sections },
    );
  }
  if (!signoff.pilot_ready || signoff.blocker_count > 0) {
    throw AppError.forbidden(
      'Pilot signoff cannot be approved until evidence blockers are cleared',
      'CLINICAL_AI_PILOT_EVIDENCE_BLOCKED',
      { blockers: signoff.blockers },
    );
  }
}

function buildBlockers(moduleSummary, reviewSummary, sections, skippedSections) {
  const blockers = [];
  for (const [section, reason] of Object.entries(skippedSections || {})) {
    blockers.push({
      code: 'EVIDENCE_SECTION_UNAVAILABLE',
      section,
      reason,
    });
  }
  if (!sections?.tenant) {
    blockers.push({ code: 'TENANT_NOT_FOUND' });
  }
  if (!sections?.guardrails) {
    blockers.push({ code: 'CLINICAL_AI_GUARDRAILS_UNAVAILABLE' });
  }
  if ((sections?.audit_events || []).length < 1) {
    blockers.push({ code: 'NO_CLINICAL_AI_AUDIT_TRAIL' });
  }
  for (const module of moduleSummary) {
    if (!module.registered) {
      blockers.push({ code: 'MODULE_NOT_REGISTERED', module_key: module.module_key });
      continue;
    }
    if (!module.effective_enabled) {
      blockers.push({ code: 'MODULE_NOT_ENABLED_FOR_TENANT', module_key: module.module_key });
    }
    if (module.generation_count < 1) {
      blockers.push({ code: 'NO_REAL_WORKFLOW_GENERATION', module_key: module.module_key });
    }
    if (!module.final_review_requirement_met) {
      blockers.push({
        code: 'INSUFFICIENT_HUMAN_REVIEW',
        module_key: module.module_key,
        required: module.min_reviewed_required,
        actual: module.final_review_count,
      });
    }
    if (module.final_reviews_missing_note_count > 0) {
      blockers.push({
        code: 'FINAL_REVIEW_WITHOUT_REVIEWER_NOTE',
        module_key: module.module_key,
        count: module.final_reviews_missing_note_count,
      });
    }
    if (module.safety_blocked_count > 0) {
      blockers.push({
        code: 'SAFETY_REVIEW_BLOCKED',
        module_key: module.module_key,
        count: module.safety_blocked_count,
      });
    }
    if (module.risky && module.accepted_eval_count < 1) {
      blockers.push({
        code: 'RISKY_MODULE_MISSING_ACCEPTED_EVAL',
        module_key: module.module_key,
      });
    }
  }
  if (reviewSummary.final_reviews_missing_note_count > 0) {
    blockers.push({
      code: 'HUMAN_REVIEW_NOTE_GATE_VIOLATION',
      count: reviewSummary.final_reviews_missing_note_count,
    });
  }
  return blockers;
}

export async function assemblePilotEvidencePack(options = {}) {
  const tid = resolveTenantId(options);
  const moduleKeys = normalizeModuleKeys(
    options.moduleKeys ?? options.module_keys ?? options.moduleKey ?? options.module_key,
  );
  const { from, to, windowDays } = resolveWindow(options);
  const minReviewedPerModule = clampInt(
    options.minReviewedPerModule ?? options.min_reviewed_per_module,
    { min: 1, max: 20, fallback: 1 },
  );
  const stage = cleanText(options.pilotStage ?? options.pilot_stage) || DEFAULT_PILOT_STAGE;

  const [
    tenant,
    guardrails,
    modules,
    generations,
    reviews,
    safetyReviews,
    approvals,
    evalRuns,
    auditEvents,
  ] = await Promise.all([
    safeQuery('tenant', () => prisma.$queryRawUnsafe(
      `SELECT id, slug, name, region, compliance_profile, status
       FROM tenants
       WHERE id = $1::uuid
       LIMIT 1`,
      tid,
    )),
    safeQuery('guardrails', () => prisma.$queryRawUnsafe(
      `SELECT id, enabled, external_ai_enabled, daily_token_limit, daily_cost_limit_minor,
              request_token_limit, fallback_rate_alert_pct, max_fallbacks_per_day,
              latency_alert_ms, updated_at
       FROM clinical_ai_guardrails
       WHERE id = 1
       LIMIT 1`,
    )),
    safeQuery('modules', () => prisma.$queryRawUnsafe(
      `SELECT m.module_key, m.display_name, m.enabled AS global_enabled,
              m.external_allowed AS global_external_allowed,
              COALESCE(tm.enabled, m.enabled) AS effective_enabled,
              COALESCE(tm.external_allowed, m.external_allowed) AS effective_external_allowed,
              m.settings,
              tm.settings AS tenant_settings,
              tm.updated_at AS tenant_updated_at
       FROM clinical_ai_modules m
       LEFT JOIN clinical_ai_tenant_modules tm
         ON tm.tenant_id = $1::uuid
        AND tm.module_key = m.module_key
       WHERE m.module_key = ANY($2::text[])
       ORDER BY m.module_key`,
      tid,
      moduleKeys,
    )),
    safeQuery('generations', () => prisma.$queryRawUnsafe(
      `SELECT id, module_key, admission_id, task_type, provider, model, status,
              used_ai, total_tokens, latency_ms, created_at, updated_at,
              COALESCE(metadata->>'generation_mode', CASE WHEN used_ai THEN 'ai' ELSE 'template_fallback' END) AS generation_mode,
              metadata->>'fallback_reason' AS fallback_reason,
              metadata->>'readiness_reason' AS readiness_reason,
              metadata->>'provider_status' AS provider_status,
              safety_flags
       FROM clinical_ai_generations
       WHERE tenant_id = $1::uuid
         AND module_key = ANY($2::text[])
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz
       ORDER BY created_at DESC
       LIMIT $5`,
      tid,
      moduleKeys,
      from,
      to,
      ROW_LIMIT,
    )),
    safeQuery('reviews', () => prisma.$queryRawUnsafe(
      `SELECT id, generation_id, module_key, admission_id, reviewer_uid, reviewer_role,
              decision, rejection_reason IS NOT NULL AS rejection_reason_present,
              reviewer_note IS NOT NULL AND btrim(reviewer_note) <> '' AS reviewer_note_present,
              char_length(COALESCE(reviewer_note, '')) AS reviewer_note_chars,
              CASE
                WHEN reviewer_note IS NULL OR btrim(reviewer_note) = '' THEN 0
                ELSE array_length(regexp_split_to_array(btrim(reviewer_note), '\\s+'), 1)
              END AS reviewer_note_words,
              created_at, updated_at
       FROM clinical_ai_reviews
       WHERE tenant_id = $1::uuid
         AND module_key = ANY($2::text[])
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz
       ORDER BY created_at DESC
       LIMIT $5`,
      tid,
      moduleKeys,
      from,
      to,
      ROW_LIMIT,
    )),
    safeQuery('safety_reviews', () => prisma.$queryRawUnsafe(
      `SELECT id, generation_id, module_key, status, citation_coverage_pct, created_at
       FROM clinical_ai_safety_reviews
       WHERE tenant_id = $1::uuid
         AND module_key = ANY($2::text[])
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz
       ORDER BY created_at DESC
       LIMIT $5`,
      tid,
      moduleKeys,
      from,
      to,
      ROW_LIMIT,
    )),
    safeQuery('approvals', () => prisma.$queryRawUnsafe(
      `SELECT id, approval_type, module_key, status, requested_by, approved_by,
              rejected_by, reason IS NOT NULL AS reason_present, decided_at,
              created_at, updated_at
       FROM clinical_ai_approvals
       WHERE tenant_id = $1::uuid
         AND module_key = ANY($2::text[])
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz
       ORDER BY created_at DESC
       LIMIT $5`,
      tid,
      moduleKeys,
      from,
      to,
      ROW_LIMIT,
    )),
    safeQuery('eval_runs', () => prisma.$queryRawUnsafe(
      `SELECT id, model_key, version, suite, sample_count, pass_count, fail_count,
              recommendation, severity, reviewer_decision, reviewed_by, reviewed_at,
              reviewer_note IS NOT NULL AND btrim(reviewer_note) <> '' AS reviewer_note_present,
              created_at, updated_at
       FROM clinical_ai_model_eval_runs
       WHERE tenant_id = $1::uuid
         AND model_key = ANY($2::text[])
         AND created_at >= $3::timestamptz
         AND created_at <= $4::timestamptz
       ORDER BY created_at DESC
       LIMIT $5`,
      tid,
      moduleKeys,
      from,
      to,
      ROW_LIMIT,
    )),
    safeQuery('audit_events', () => prisma.$queryRawUnsafe(
      `SELECT id, uid, role, action, resource_id, metadata, created_at
       FROM audit_logs
       WHERE (resource = 'clinical_ai' OR action LIKE 'CLINICAL_AI_%')
         AND COALESCE(metadata->>'tenant_id', $1::text) = $1::text
         AND created_at >= ($2::timestamptz AT TIME ZONE current_setting('TimeZone'))
         AND created_at <= ($3::timestamptz AT TIME ZONE current_setting('TimeZone'))
       ORDER BY created_at DESC
       LIMIT 250`,
      tid,
      from,
      to,
    )),
  ]);

  const sections = {
    tenant: tenant.rows[0] || null,
    guardrails: guardrails.rows[0] || null,
    modules: modules.rows,
    generations: generations.rows,
    reviews: reviews.rows,
    safety_reviews: safetyReviews.rows,
    approvals: approvals.rows,
    eval_runs: evalRuns.rows,
    audit_events: auditEvents.rows,
  };

  const skippedSections = {};
  for (const [name, result] of Object.entries({
    tenant,
    guardrails,
    modules,
    generations,
    reviews,
    safety_reviews: safetyReviews,
    approvals,
    eval_runs: evalRuns,
    audit_events: auditEvents,
  })) {
    if (result.skipped_reason) skippedSections[name] = result.skipped_reason;
  }

  const moduleSummary = summarizeModules(
    moduleKeys,
    modules.rows,
    generations.rows,
    reviews.rows,
    safetyReviews.rows,
    evalRuns.rows,
    minReviewedPerModule,
  );
  const reviewSummary = summarizeReviews(reviews.rows);
  const safetySummary = summarizeSafetyReviews(safetyReviews.rows, generations.rows);
  const blockers = buildBlockers(moduleSummary, reviewSummary, sections, skippedSections);

  return {
    pack_version: PACK_VERSION,
    generated_at: new Date().toISOString(),
    generated_by: options.generatedBy || null,
    tenant_id: tid,
    pilot_stage: stage,
    module_keys: moduleKeys,
    evidence_window: {
      from: from.toISOString(),
      to: to.toISOString(),
      window_days: windowDays,
    },
    decision_support_only: true,
    human_review_required: true,
    min_reviewed_per_module: minReviewedPerModule,
    summary: {
      pilot_ready: blockers.length === 0,
      blockers,
      row_counts: rowCounts(sections),
      skipped_sections: skippedSections,
      module_summary: moduleSummary,
      generation_counts: {
        total: generations.rows.length,
        by_mode: countBy(generations.rows, (row) => cleanText(row.generation_mode).toLowerCase() || 'unknown'),
        by_status: countBy(generations.rows, (row) => cleanText(row.status).toLowerCase() || 'unknown'),
      },
      review_counts: reviewSummary,
      safety_counts: safetySummary,
      eval_counts: {
        total: evalRuns.rows.length,
        accepted: evalRuns.rows.filter((row) => (
          cleanText(row.reviewer_decision).toLowerCase() === 'accepted' ||
          cleanText(row.recommendation).toLowerCase() === 'no_action'
        )).length,
      },
      approval_counts: {
        total: approvals.rows.length,
        by_status: countBy(approvals.rows, (row) => cleanText(row.status).toLowerCase() || 'unknown'),
      },
      audit_counts: {
        total: auditEvents.rows.length,
        by_action: countBy(auditEvents.rows, (row) => cleanText(row.action) || 'unknown'),
      },
    },
    sections,
  };
}

export async function listPilotSignoffs(options = {}) {
  const tid = resolveTenantId(options);
  const stage = cleanText(options.pilotStage ?? options.pilot_stage) || null;
  const moduleKeys = normalizeOptionalModuleKeys(
    options.moduleKeys ?? options.module_keys ?? options.moduleKey ?? options.module_key,
  );
  const limit = clampInt(options.limit, { min: 1, max: 100, fallback: 20 });

  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SIGNOFF_SELECT}
     FROM clinical_ai_approvals
     WHERE tenant_id = $1::uuid
       AND approval_type = $2
       AND ($3::text IS NULL OR payload->>'pilot_stage' = $3)
       AND (
         $4::text[] IS NULL OR (
           (payload->'module_keys') @> to_jsonb($4::text[])
           AND to_jsonb($4::text[]) @> (payload->'module_keys')
         )
       )
     ORDER BY created_at DESC
     LIMIT $5`,
    tid,
    SIGNOFF_APPROVAL_TYPE,
    stage,
    moduleKeys,
    limit,
  );

  const signoffs = rows.map(summarizeSignoffRow);
  return { signoffs, count: signoffs.length };
}

export async function getPilotStageGate(options = {}) {
  const tid = resolveTenantId(options);
  const stage = cleanText(options.pilotStage ?? options.pilot_stage) || DEFAULT_PILOT_STAGE;
  const moduleKeys = normalizeModuleKeys(
    options.moduleKeys ?? options.module_keys ?? options.moduleKey ?? options.module_key,
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SIGNOFF_SELECT}
     FROM clinical_ai_approvals
     WHERE tenant_id = $1::uuid
       AND approval_type = $2
       AND payload->>'pilot_stage' = $3
       AND (payload->'module_keys') @> to_jsonb($4::text[])
       AND to_jsonb($4::text[]) @> (payload->'module_keys')
     ORDER BY created_at DESC
     LIMIT 20`,
    tid,
    SIGNOFF_APPROVAL_TYPE,
    stage,
    moduleKeys,
  );

  const signoffs = rows.map(summarizeSignoffRow);
  const latestSignoff = signoffs[0] || null;
  const allowed = latestSignoff?.stage_expansion_allowed === true;
  return {
    tenant_id: tid,
    pilot_stage: stage,
    module_keys: moduleKeys,
    stage_expansion_allowed: allowed,
    blocking_reason: allowed ? null : signoffBlockingReason(latestSignoff),
    latest_signoff: latestSignoff,
    recent_signoffs: signoffs,
  };
}

export async function createPilotSignoff(data = {}, requestedBy = null, options = {}) {
  const tid = resolveTenantId(options);
  const pack = await assemblePilotEvidencePack({
    tenantId: tid,
    moduleKeys: data.moduleKeys ?? data.module_keys ?? data.moduleKey ?? data.module_key,
    pilotStage: data.pilotStage ?? data.pilot_stage,
    windowDays: data.windowDays ?? data.window_days,
    from: data.from,
    to: data.to,
    minReviewedPerModule: data.minReviewedPerModule ?? data.min_reviewed_per_module,
    generatedBy: data.generatedBy || data.generated_by || null,
  });
  const payload = buildSignoffPayload(pack, data);
  const reason = cleanText(data.reason) || `Clinical AI pilot signoff requested for ${pack.pilot_stage}`;
  const expiresAt = resolveSignoffExpiry(data.expiresAt ?? data.expires_at);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_approvals
       (tenant_id, approval_type, module_key, status, requested_by, reason, payload, expires_at, created_at, updated_at)
     VALUES ($1::uuid, $2, NULL, 'pending', $3::uuid, $4, $5::jsonb, $6::timestamptz, NOW(), NOW())
     RETURNING ${SIGNOFF_SELECT}`,
    tid,
    SIGNOFF_APPROVAL_TYPE,
    requestedBy,
    reason,
    JSON.stringify(payload),
    expiresAt,
  );

  return {
    signoff: summarizeSignoffRow(rows[0]),
    evidence_pack: pack,
  };
}

async function getPilotSignoffById(signoffId, options = {}) {
  const tid = resolveTenantId(options);
  const id = Number.parseInt(signoffId, 10);
  if (!Number.isFinite(id)) {
    throw AppError.badRequest('Pilot signoff id must be numeric', 'CLINICAL_AI_PILOT_SIGNOFF_ID_INVALID');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SIGNOFF_SELECT}
     FROM clinical_ai_approvals
     WHERE id = $1
       AND tenant_id = $2::uuid
       AND approval_type = $3
     LIMIT 1`,
    id,
    tid,
    SIGNOFF_APPROVAL_TYPE,
  );
  return rows[0] || null;
}

export async function decidePilotSignoff(signoffId, decision, actorUid = null, reason = null, options = {}) {
  const tid = resolveTenantId(options);
  const normalized = cleanText(decision).toLowerCase();
  if (!PILOT_SIGNOFF_DECISIONS.has(normalized)) {
    throw AppError.badRequest(
      'decision must be approved, hold, or rejected',
      'CLINICAL_AI_PILOT_SIGNOFF_DECISION_INVALID',
    );
  }
  const note = cleanText(reason);
  if (note.length < 8) {
    throw AppError.badRequest(
      'A reviewer note is required for pilot signoff decisions',
      'CLINICAL_AI_PILOT_SIGNOFF_REASON_REQUIRED',
    );
  }

  const existing = await getPilotSignoffById(signoffId, { tenantId: tid });
  if (!existing) {
    throw AppError.notFound('Clinical AI pilot signoff not found', 'CLINICAL_AI_PILOT_SIGNOFF_NOT_FOUND');
  }
  if (existing.status !== 'pending') {
    throw AppError.conflict(
      'Clinical AI pilot signoff was already decided',
      'CLINICAL_AI_PILOT_SIGNOFF_ALREADY_DECIDED',
    );
  }

  const current = summarizeSignoffRow(existing);
  if (normalized === 'approved') {
    assertSignoffApprovable(current);
  }

  const payload = parsePayload(existing.payload);
  const decidedAt = new Date().toISOString();
  const decisionRecord = {
    status: normalized,
    decided_by: actorUid,
    decided_at: decidedAt,
    reason: note,
    blocking_reason: normalized === 'approved' ? null : signoffBlockingReason(current),
  };
  const updatedPayload = {
    ...payload,
    decision: decisionRecord,
    decisions: [
      ...(Array.isArray(payload.decisions) ? payload.decisions : []),
      decisionRecord,
    ],
  };

  const rows = await prisma.$queryRawUnsafe(
    // $2 (the decision) is compared against string literals AND assigned to the
    // varchar `status` column, so Postgres deduces conflicting types for it
    // ("text versus character varying", 42P08) unless every use is cast to one
    // type. Cast `$2::text` at all three usages — mirrors decideApproval() in
    // clinicalAiWorkflowService.js, which was already fixed the same way.
    `UPDATE clinical_ai_approvals
     SET status = $2::text,
         approved_by = CASE WHEN $2::text = 'approved' THEN $3::uuid ELSE approved_by END,
         rejected_by = CASE WHEN $2::text IN ('hold', 'rejected') THEN $3::uuid ELSE rejected_by END,
         reason = $4,
         payload = $5::jsonb,
         decided_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $6::uuid
       AND approval_type = $7
     RETURNING ${SIGNOFF_SELECT}`,
    Number.parseInt(signoffId, 10),
    normalized,
    actorUid,
    note,
    JSON.stringify(updatedPayload),
    tid,
    SIGNOFF_APPROVAL_TYPE,
  );

  return summarizeSignoffRow(rows[0]);
}

export const __testing__ = {
  PACK_VERSION,
  SIGNOFF_APPROVAL_TYPE,
  DEFAULT_PILOT_MODULES,
  normalizeModuleKeys,
  buildSignoffPayload,
  summarizeSignoffRow,
  effectiveModuleSettings,
  summarizeModules,
  summarizeReviews,
  buildBlockers,
};

export default {
  assemblePilotEvidencePack,
  createPilotSignoff,
  decidePilotSignoff,
  getPilotStageGate,
  listPilotSignoffs,
};
