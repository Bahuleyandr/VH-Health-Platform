/**
 * AI Outcome Scoreboard (G3 outcome instrumentation).
 *
 * Per-module evidence layer computed ONLY from existing generation / review /
 * safety tables — no new AI modules, no new writes. This is the scoreboard
 * NABH assessors, DPDP reviewers, and the hospital board read to decide
 * module enables/disables and stage promotions:
 *
 *   - acceptance rate        clinical_ai_reviews.decision buckets
 *   - edit distance          edited_draft vs original draft (word-level
 *                            Levenshtein, capped; see EDIT_DISTANCE_* consts)
 *   - override rate          flagged-by-safety-reviewer drafts the human
 *                            reviewer accepted anyway, plus deterministic
 *                            medication_safety_reviews blocker overrides
 *   - time-to-sign vs base   clinical_notes signed with ai_generation_id
 *                            vs notes of the same note_type without one
 *   - safety-flag precision  flagged drafts the human reviewer also
 *                            rejected/edited vs accepted unchanged
 *
 * Read-only. Rates are null (not 0) when there is no data to rate —
 * "no evidence yet" must never read as "0% acceptance".
 */

import { prismaReadOnly } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

// Reviewer-decision buckets (inlined in the SQL below) follow exactly how
// updateReview() treats them (REVIEW_STATUS_BY_DECISION in
// clinicalAiWorkflowService.js): accepted-like = accepted/signed/approved,
// edited-like = edited/revision_requested, plus rejected / needs_revision /
// pending. Safety statuses come from runSafetyReview():
// passed / needs_review / blocked.

// Edit-distance cost controls: word-level Levenshtein is O(n*m); cap the
// token window per draft and the number of edited reviews sampled per
// computation so an admin dashboard read stays cheap.
export const EDIT_DISTANCE_MAX_TOKENS = 800;
export const EDIT_DISTANCE_MAX_SAMPLES = 400;

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function clampDays(value, { min = 1, max = 365, fallback = 90 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function toFiniteNumber(value, fallback = 0) {
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Percentage with an honest empty state: returns null (not 0) when the
 * denominator is 0 — a module with no decided reviews has no acceptance
 * rate, not a 0% acceptance rate.
 */
export function pct(numerator, denominator) {
  const d = toFiniteNumber(denominator);
  if (d <= 0) return null;
  return round1((toFiniteNumber(numerator) / d) * 100);
}

export function median(values) {
  const list = asArray(values)
    .map((v) => toFiniteNumber(v, NaN))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? round1(list[mid]) : round1((list[mid - 1] + list[mid]) / 2);
}

/**
 * Deterministic flatten of a draft JSON payload into comparable text.
 * Object keys are walked in sorted order so two structurally-equal drafts
 * always produce the same text regardless of key insertion order.
 */
export function draftToComparableText(value) {
  const parts = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if (text) parts.push(text);
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node).sort()) walk(node[key]);
    }
  };
  walk(value);
  return parts.join('\n');
}

export function tokenizeForDiff(text, maxTokens = EDIT_DISTANCE_MAX_TOKENS) {
  const tokens = String(text || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.length > maxTokens ? tokens.slice(0, maxTokens) : tokens;
}

/**
 * Normalized word-level Levenshtein distance between two texts, as a
 * percentage of the longer token sequence. 0 = identical, 100 = nothing
 * in common (or one side empty). Two-row DP over Int32Array keeps a
 * capped pair under ~1ms.
 */
export function normalizedWordEditDistance(originalText, editedText, { maxTokens = EDIT_DISTANCE_MAX_TOKENS } = {}) {
  const a = tokenizeForDiff(originalText, maxTokens);
  const b = tokenizeForDiff(editedText, maxTokens);
  if (!a.length && !b.length) return 0;
  if (!a.length || !b.length) return 100;

  let prev = new Int32Array(b.length + 1);
  let curr = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + substitution);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const distance = prev[b.length];
  return round1((distance / Math.max(a.length, b.length)) * 100);
}

function emptyModuleRow(moduleKey) {
  return {
    module_key: moduleKey,
    display_name: null,
    enabled: false,
    generations: { total: 0, ai_generated: 0, fallback: 0 },
    reviews: {
      total: 0,
      decided: 0,
      pending: 0,
      accepted: 0,
      edited: 0,
      rejected: 0,
      needs_revision: 0,
      acceptance_rate_pct: null,
      used_rate_pct: null,
      avg_review_latency_minutes: null,
    },
    edits: { sample_count: 0, mean_edit_distance_pct: null, median_edit_distance_pct: null },
    safety: {
      flagged_total: 0,
      flagged_decided: 0,
      flagged_confirmed: 0,
      flagged_overridden: 0,
      flag_precision_pct: null,
      flag_override_rate_pct: null,
      missed_reject_count: 0,
    },
    time_to_sign: [],
  };
}

/**
 * Pure assembly of the scoreboard payload from raw query rows. Exported so
 * unit tests can exercise every rate/edge without a database.
 */
export function aggregateOutcomeScoreboard({
  registry = [],
  generations = [],
  reviews = [],
  editPairs = [],
  safety = [],
  aiTimeToSign = [],
  baselineTimeToSign = [],
  medicationSafety = [],
} = {}) {
  const modules = new Map();
  const rowFor = (moduleKey) => {
    if (!modules.has(moduleKey)) modules.set(moduleKey, emptyModuleRow(moduleKey));
    return modules.get(moduleKey);
  };

  const registryByKey = new Map();
  for (const reg of asArray(registry)) {
    if (!reg?.module_key) continue;
    registryByKey.set(reg.module_key, reg);
    // Enabled modules appear on the scoreboard even with zero activity —
    // "live but unused" is itself a governance signal.
    if (reg.enabled === true) rowFor(reg.module_key);
  }

  for (const row of asArray(generations)) {
    if (!row?.module_key) continue;
    const entry = rowFor(row.module_key);
    entry.generations.total = toFiniteNumber(row.generation_count);
    entry.generations.ai_generated = toFiniteNumber(row.ai_generation_count);
    entry.generations.fallback = toFiniteNumber(row.fallback_count);
  }

  for (const row of asArray(reviews)) {
    if (!row?.module_key) continue;
    const entry = rowFor(row.module_key);
    const accepted = toFiniteNumber(row.accepted_count);
    const edited = toFiniteNumber(row.edited_count);
    const rejected = toFiniteNumber(row.rejected_count);
    const needsRevision = toFiniteNumber(row.needs_revision_count);
    const pending = toFiniteNumber(row.pending_count);
    const decided = accepted + edited + rejected + needsRevision;
    entry.reviews.total = toFiniteNumber(row.review_count);
    entry.reviews.decided = decided;
    entry.reviews.pending = pending;
    entry.reviews.accepted = accepted;
    entry.reviews.edited = edited;
    entry.reviews.rejected = rejected;
    entry.reviews.needs_revision = needsRevision;
    entry.reviews.acceptance_rate_pct = pct(accepted, decided);
    entry.reviews.used_rate_pct = pct(accepted + edited, decided);
    const latency = toFiniteNumber(row.avg_review_latency_minutes, NaN);
    entry.reviews.avg_review_latency_minutes = Number.isFinite(latency) ? round1(latency) : null;
  }

  const editDistancesByModule = new Map();
  const allEditDistances = [];
  for (const pair of asArray(editPairs)) {
    if (!pair?.module_key) continue;
    const distance = normalizedWordEditDistance(
      draftToComparableText(pair.draft),
      draftToComparableText(pair.edited_draft)
    );
    if (!editDistancesByModule.has(pair.module_key)) editDistancesByModule.set(pair.module_key, []);
    editDistancesByModule.get(pair.module_key).push(distance);
    allEditDistances.push(distance);
  }
  for (const [moduleKey, distances] of editDistancesByModule) {
    const entry = rowFor(moduleKey);
    entry.edits.sample_count = distances.length;
    entry.edits.mean_edit_distance_pct = round1(distances.reduce((sum, d) => sum + d, 0) / distances.length);
    entry.edits.median_edit_distance_pct = median(distances);
  }

  for (const row of asArray(safety)) {
    if (!row?.module_key) continue;
    const entry = rowFor(row.module_key);
    const flaggedTotal = toFiniteNumber(row.flagged_total);
    const flaggedDecided = toFiniteNumber(row.flagged_decided);
    const flaggedConfirmed = toFiniteNumber(row.flagged_confirmed);
    const flaggedOverridden = toFiniteNumber(row.flagged_overridden);
    entry.safety.flagged_total = flaggedTotal;
    entry.safety.flagged_decided = flaggedDecided;
    entry.safety.flagged_confirmed = flaggedConfirmed;
    entry.safety.flagged_overridden = flaggedOverridden;
    entry.safety.flag_precision_pct = pct(flaggedConfirmed, flaggedDecided);
    entry.safety.flag_override_rate_pct = pct(flaggedOverridden, flaggedDecided);
    entry.safety.missed_reject_count = toFiniteNumber(row.missed_reject_count);
  }

  const baselineByNoteType = new Map();
  for (const row of asArray(baselineTimeToSign)) {
    if (!row?.note_type) continue;
    baselineByNoteType.set(row.note_type, {
      signed_count: toFiniteNumber(row.signed_count),
      median_minutes: Number.isFinite(toFiniteNumber(row.median_minutes, NaN)) ? round1(toFiniteNumber(row.median_minutes)) : null,
      avg_minutes: Number.isFinite(toFiniteNumber(row.avg_minutes, NaN)) ? round1(toFiniteNumber(row.avg_minutes)) : null,
    });
  }
  for (const row of asArray(aiTimeToSign)) {
    if (!row?.module_key || !row?.note_type) continue;
    const entry = rowFor(row.module_key);
    const baseline = baselineByNoteType.get(row.note_type) || null;
    const aiMedian = Number.isFinite(toFiniteNumber(row.median_minutes, NaN)) ? round1(toFiniteNumber(row.median_minutes)) : null;
    entry.time_to_sign.push({
      note_type: row.note_type,
      ai_signed_count: toFiniteNumber(row.signed_count),
      ai_median_minutes: aiMedian,
      ai_avg_minutes: Number.isFinite(toFiniteNumber(row.avg_minutes, NaN)) ? round1(toFiniteNumber(row.avg_minutes)) : null,
      baseline_signed_count: baseline ? baseline.signed_count : 0,
      baseline_median_minutes: baseline ? baseline.median_minutes : null,
      baseline_avg_minutes: baseline ? baseline.avg_minutes : null,
      median_delta_minutes:
        aiMedian !== null && baseline?.median_minutes !== null && baseline?.median_minutes !== undefined
          ? round1(aiMedian - baseline.median_minutes)
          : null,
    });
  }

  // Attach registry info to every row that has one.
  for (const [moduleKey, entry] of modules) {
    const reg = registryByKey.get(moduleKey);
    if (reg) {
      entry.display_name = reg.display_name || null;
      entry.enabled = reg.enabled === true;
    }
  }

  const moduleRows = Array.from(modules.values()).sort(
    (a, b) =>
      b.generations.total + b.reviews.total - (a.generations.total + a.reviews.total) ||
      a.module_key.localeCompare(b.module_key)
  );

  const totals = {
    modules_with_activity: moduleRows.filter((row) => row.generations.total + row.reviews.total > 0).length,
    generations: { total: 0, ai_generated: 0, fallback: 0 },
    reviews: { total: 0, decided: 0, pending: 0, accepted: 0, edited: 0, rejected: 0, needs_revision: 0 },
    edits: { sample_count: allEditDistances.length, mean_edit_distance_pct: null, median_edit_distance_pct: null },
    safety: { flagged_total: 0, flagged_decided: 0, flagged_confirmed: 0, flagged_overridden: 0, missed_reject_count: 0 },
    time_to_sign: { ai_signed_count: 0, baseline_signed_count: 0, ai_avg_minutes: null, baseline_avg_minutes: null },
  };
  for (const row of moduleRows) {
    totals.generations.total += row.generations.total;
    totals.generations.ai_generated += row.generations.ai_generated;
    totals.generations.fallback += row.generations.fallback;
    totals.reviews.total += row.reviews.total;
    totals.reviews.decided += row.reviews.decided;
    totals.reviews.pending += row.reviews.pending;
    totals.reviews.accepted += row.reviews.accepted;
    totals.reviews.edited += row.reviews.edited;
    totals.reviews.rejected += row.reviews.rejected;
    totals.reviews.needs_revision += row.reviews.needs_revision;
    totals.safety.flagged_total += row.safety.flagged_total;
    totals.safety.flagged_decided += row.safety.flagged_decided;
    totals.safety.flagged_confirmed += row.safety.flagged_confirmed;
    totals.safety.flagged_overridden += row.safety.flagged_overridden;
    totals.safety.missed_reject_count += row.safety.missed_reject_count;
  }
  totals.reviews.acceptance_rate_pct = pct(totals.reviews.accepted, totals.reviews.decided);
  totals.reviews.used_rate_pct = pct(totals.reviews.accepted + totals.reviews.edited, totals.reviews.decided);
  totals.safety.flag_precision_pct = pct(totals.safety.flagged_confirmed, totals.safety.flagged_decided);
  totals.safety.flag_override_rate_pct = pct(totals.safety.flagged_overridden, totals.safety.flagged_decided);
  if (allEditDistances.length) {
    totals.edits.mean_edit_distance_pct = round1(allEditDistances.reduce((sum, d) => sum + d, 0) / allEditDistances.length);
    totals.edits.median_edit_distance_pct = median(allEditDistances);
  }
  // Weighted (by signed count) averages across note types; medians are not
  // poolable across groups, so totals only carry averages.
  let aiWeighted = 0;
  let baseWeighted = 0;
  const countedBaselines = new Set();
  for (const row of moduleRows) {
    for (const tts of row.time_to_sign) {
      totals.time_to_sign.ai_signed_count += tts.ai_signed_count;
      if (tts.ai_avg_minutes !== null) aiWeighted += tts.ai_avg_minutes * tts.ai_signed_count;
      if (!countedBaselines.has(tts.note_type)) {
        countedBaselines.add(tts.note_type);
        totals.time_to_sign.baseline_signed_count += tts.baseline_signed_count;
        if (tts.baseline_avg_minutes !== null) baseWeighted += tts.baseline_avg_minutes * tts.baseline_signed_count;
      }
    }
  }
  if (totals.time_to_sign.ai_signed_count > 0) {
    totals.time_to_sign.ai_avg_minutes = round1(aiWeighted / totals.time_to_sign.ai_signed_count);
  }
  if (totals.time_to_sign.baseline_signed_count > 0) {
    totals.time_to_sign.baseline_avg_minutes = round1(baseWeighted / totals.time_to_sign.baseline_signed_count);
  }

  const medsByType = asArray(medicationSafety).map((row) => {
    const blockerCount = toFiniteNumber(row.blocker_count);
    const overriddenCount = toFiniteNumber(row.overridden_count);
    return {
      review_type: row.review_type,
      finding_count: toFiniteNumber(row.finding_count),
      critical_count: toFiniteNumber(row.critical_count),
      blocker_count: blockerCount,
      overridden_count: overriddenCount,
      override_rate_pct: pct(overriddenCount, blockerCount),
    };
  });
  const medsTotals = medsByType.reduce(
    (acc, row) => {
      acc.finding_count += row.finding_count;
      acc.critical_count += row.critical_count;
      acc.blocker_count += row.blocker_count;
      acc.overridden_count += row.overridden_count;
      return acc;
    },
    { finding_count: 0, critical_count: 0, blocker_count: 0, overridden_count: 0 }
  );

  return {
    modules: moduleRows,
    totals,
    medication_safety: {
      ...medsTotals,
      override_rate_pct: pct(medsTotals.overridden_count, medsTotals.blocker_count),
      by_type: medsByType,
    },
  };
}

async function safeQuery(label, sql, ...params) {
  try {
    return await prismaReadOnly.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    logger.error('AI outcome scoreboard query failed', { label, error: err.message });
    throw err;
  }
}

function queryRegistry(tenantId) {
  return safeQuery(
    'registry',
    `SELECT m.module_key, m.display_name,
            COALESCE(tm.enabled, m.enabled) AS enabled
     FROM clinical_ai_modules m
     LEFT JOIN clinical_ai_tenant_modules tm
       ON tm.module_key = m.module_key AND tm.tenant_id = $1::uuid`,
    tenantId
  );
}

function queryGenerations(tenantId, periodDays) {
  return safeQuery(
    'generations',
    `SELECT COALESCE(module_key, task_type) AS module_key,
            COUNT(*)::int AS generation_count,
            COUNT(*) FILTER (WHERE used_ai)::int AS ai_generation_count,
            COUNT(*) FILTER (WHERE NOT used_ai)::int AS fallback_count
     FROM clinical_ai_generations
     WHERE tenant_id = $1::uuid
       AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
     GROUP BY COALESCE(module_key, task_type)`,
    tenantId,
    periodDays
  );
}

function queryReviews(tenantId, periodDays) {
  return safeQuery(
    'reviews',
    `SELECT module_key,
            COUNT(*)::int AS review_count,
            COUNT(*) FILTER (WHERE decision IN ('accepted', 'signed', 'approved'))::int AS accepted_count,
            COUNT(*) FILTER (WHERE decision IN ('edited', 'revision_requested'))::int AS edited_count,
            COUNT(*) FILTER (WHERE decision = 'rejected')::int AS rejected_count,
            COUNT(*) FILTER (WHERE decision = 'needs_revision')::int AS needs_revision_count,
            COUNT(*) FILTER (WHERE decision = 'pending')::int AS pending_count,
            (AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60.0)
               FILTER (WHERE decision <> 'pending'))::float8 AS avg_review_latency_minutes
     FROM clinical_ai_reviews
     WHERE tenant_id = $1::uuid
       AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
     GROUP BY module_key`,
    tenantId,
    periodDays
  );
}

function queryEditPairs(tenantId, periodDays) {
  return safeQuery(
    'edit_pairs',
    `SELECT r.module_key, r.edited_draft, g.draft
     FROM clinical_ai_reviews r
     JOIN clinical_ai_generations g
       ON g.id = r.generation_id AND g.tenant_id = r.tenant_id
     WHERE r.tenant_id = $1::uuid
       AND r.created_at >= NOW() - ($2::int * INTERVAL '1 day')
       AND r.edited_draft IS NOT NULL
     ORDER BY r.created_at DESC
     LIMIT $3::int`,
    tenantId,
    periodDays,
    EDIT_DISTANCE_MAX_SAMPLES
  );
}

function querySafety(tenantId, periodDays) {
  // Latest human decision per flagged generation; precision counts a flag as
  // confirmed when the human also rejected/edited/sent back the draft, and
  // overridden when the human accepted it unchanged despite the flag.
  return safeQuery(
    'safety',
    `SELECT s.module_key,
            COUNT(*) FILTER (WHERE s.status IN ('needs_review', 'blocked'))::int AS flagged_total,
            COUNT(*) FILTER (WHERE s.status IN ('needs_review', 'blocked')
                               AND r.decision IS NOT NULL AND r.decision <> 'pending')::int AS flagged_decided,
            COUNT(*) FILTER (WHERE s.status IN ('needs_review', 'blocked')
                               AND r.decision IN ('rejected', 'needs_revision', 'edited', 'revision_requested'))::int AS flagged_confirmed,
            COUNT(*) FILTER (WHERE s.status IN ('needs_review', 'blocked')
                               AND r.decision IN ('accepted', 'signed', 'approved'))::int AS flagged_overridden,
            COUNT(*) FILTER (WHERE s.status = 'passed' AND r.decision = 'rejected')::int AS missed_reject_count
     FROM clinical_ai_safety_reviews s
     LEFT JOIN LATERAL (
       SELECT r.decision
       FROM clinical_ai_reviews r
       WHERE r.generation_id = s.generation_id
         AND r.tenant_id = s.tenant_id
       ORDER BY r.updated_at DESC
       LIMIT 1
     ) r ON TRUE
     WHERE s.tenant_id = $1::uuid
       AND s.created_at >= NOW() - ($2::int * INTERVAL '1 day')
     GROUP BY s.module_key`,
    tenantId,
    periodDays
  );
}

function queryAiTimeToSign(tenantId, periodDays) {
  return safeQuery(
    'ai_time_to_sign',
    `SELECT COALESCE(g.module_key, g.task_type) AS module_key,
            n.note_type,
            COUNT(*)::int AS signed_count,
            (percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (n.signed_at - n.created_at)) / 60.0))::float8 AS median_minutes,
            (AVG(EXTRACT(EPOCH FROM (n.signed_at - n.created_at)) / 60.0))::float8 AS avg_minutes
     FROM clinical_notes n
     JOIN clinical_ai_generations g
       ON g.id = n.ai_generation_id AND g.tenant_id = n.tenant_id
     WHERE n.tenant_id = $1::uuid
       AND n.is_signed = true
       AND n.signed_at IS NOT NULL
       AND n.signed_at >= n.created_at
       AND n.signed_at >= NOW() - ($2::int * INTERVAL '1 day')
     GROUP BY COALESCE(g.module_key, g.task_type), n.note_type`,
    tenantId,
    periodDays
  );
}

function queryBaselineTimeToSign(tenantId, periodDays) {
  return safeQuery(
    'baseline_time_to_sign',
    `SELECT n.note_type,
            COUNT(*)::int AS signed_count,
            (percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (n.signed_at - n.created_at)) / 60.0))::float8 AS median_minutes,
            (AVG(EXTRACT(EPOCH FROM (n.signed_at - n.created_at)) / 60.0))::float8 AS avg_minutes
     FROM clinical_notes n
     WHERE n.tenant_id = $1::uuid
       AND n.ai_generation_id IS NULL
       AND n.is_signed = true
       AND n.signed_at IS NOT NULL
       AND n.signed_at >= n.created_at
       AND n.signed_at >= NOW() - ($2::int * INTERVAL '1 day')
     GROUP BY n.note_type`,
    tenantId,
    periodDays
  );
}

function queryMedicationSafety(tenantId, periodDays) {
  return safeQuery(
    'medication_safety',
    `SELECT review_type,
            COUNT(*)::int AS finding_count,
            COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical_count,
            COUNT(*) FILTER (WHERE override_required)::int AS blocker_count,
            COUNT(*) FILTER (WHERE override_required AND overridden_by IS NOT NULL)::int AS overridden_count
     FROM medication_safety_reviews
     WHERE tenant_id = $1::uuid
       AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
     GROUP BY review_type
     ORDER BY finding_count DESC`,
    tenantId,
    periodDays
  );
}

export const SCOREBOARD_DEFINITIONS = Object.freeze({
  acceptance_rate_pct: 'Reviews decided accepted/signed/approved as a share of all decided reviews (pending excluded).',
  used_rate_pct: 'Decided reviews whose draft reached care (accepted or edited) as a share of all decided reviews.',
  mean_edit_distance_pct: `Word-level Levenshtein distance between original and edited drafts, normalized by the longer draft; capped at ${EDIT_DISTANCE_MAX_TOKENS} tokens per draft over the latest ${EDIT_DISTANCE_MAX_SAMPLES} edited reviews in the window.`,
  flag_precision_pct: 'Safety-flagged drafts the human reviewer also rejected/edited/sent back, as a share of flagged drafts with a human decision.',
  flag_override_rate_pct: 'Safety-flagged drafts the human reviewer accepted unchanged, as a share of flagged drafts with a human decision.',
  missed_reject_count: 'Drafts the safety reviewer passed but the human reviewer rejected (false-negative proxy).',
  time_to_sign: 'Minutes from note creation to clinician signature for notes carrying ai_generation_id, against same-note-type notes without one, in the same window.',
  medication_safety_override_rate_pct: 'Deterministic medication-safety blockers (override_required) that were overridden, as a share of all blockers in the window.',
  null_rates: 'Rates are null when there is no data to rate; null means "no evidence yet", never 0%.',
});

/**
 * Compute the live per-module outcome scoreboard for a tenant.
 *
 * @param {object} options
 * @param {string|null} options.tenantId   tenant scope (defaults to the default tenant)
 * @param {number}      options.periodDays lookback window, clamped 1..365 (default 90)
 * @param {string|null} options.moduleKey  optional single-module filter
 */
export async function computeAiOutcomeScoreboard({ tenantId = null, periodDays = 90, moduleKey = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const days = clampDays(periodDays);
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60 * 1000);
  const moduleFilter = cleanText(moduleKey) || null;

  const [registry, generations, reviews, editPairs, safety, aiTimeToSign, baselineTimeToSign, medicationSafety] =
    await Promise.all([
      queryRegistry(tid),
      queryGenerations(tid, days),
      queryReviews(tid, days),
      queryEditPairs(tid, days),
      querySafety(tid, days),
      queryAiTimeToSign(tid, days),
      queryBaselineTimeToSign(tid, days),
      queryMedicationSafety(tid, days),
    ]);

  const aggregated = aggregateOutcomeScoreboard({
    registry,
    generations,
    reviews,
    editPairs,
    safety,
    aiTimeToSign,
    baselineTimeToSign,
    medicationSafety,
  });

  const modules = moduleFilter
    ? aggregated.modules.filter((row) => row.module_key === moduleFilter)
    : aggregated.modules;

  return {
    tenant_id: tid,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    period_days: days,
    module_key: moduleFilter || 'ALL',
    modules,
    totals: aggregated.totals,
    medication_safety: aggregated.medication_safety,
    definitions: SCOREBOARD_DEFINITIONS,
    computed_at: new Date().toISOString(),
    decision_support_only: true,
    read_only: true,
  };
}

export default {
  EDIT_DISTANCE_MAX_SAMPLES,
  EDIT_DISTANCE_MAX_TOKENS,
  SCOREBOARD_DEFINITIONS,
  aggregateOutcomeScoreboard,
  computeAiOutcomeScoreboard,
  draftToComparableText,
  median,
  normalizedWordEditDistance,
  pct,
  tokenizeForDiff,
  toFiniteNumber,
};
