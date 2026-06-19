/**
 * Dataset Labeling and Review Studio.
 *
 * Generic labeling queue for AI eval/training datasets across task types
 * (imaging, clinical coding, denial reasons, deterioration outcomes,
 * triage outcomes, discharge disposition, etc.). Stores labeling tasks
 * (one row per input item) and annotations (one row per labeler). Rules
 * are authoritative: inter-rater agreement (match / partial / disagree /
 * pending), confidence band (high / medium / low), task status, and
 * consensus label are all derived from the annotations. A task becomes
 * ready_to_use only when >= 2 accepted annotations agree; conflicts go to
 * adjudicator review. Review-only — the eval lead approves, and the
 * module never auto-publishes an item into a dataset.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';

const MODULE_KEY = 'dataset_labeling_studio';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the dataset labeling and review studio. Rules are authoritative. Return JSON only and never auto-publish an item into a dataset.',
  user_prompt_template:
    'Given a labeling task and its annotations, summarize the reviewer-facing state. Do not override the rule-based agreement, status, or consensus label.',
};

// ---------- Constants (exported) ----------------------------------------

export const TASK_STATUSES = new Set([
  'pending',
  'in_progress',
  'ready_to_use',
  'conflict',
  'rejected',
  'archived',
]);

export const STATUS_PRIORITY = [
  'unknown',
  'pending',
  'in_progress',
  'ready_to_use',
  'conflict',
  'rejected',
  'archived',
];

export const CONFIDENCE_BANDS = new Set(['high', 'medium', 'low', 'unknown']);
export const AGREEMENT_BANDS = new Set(['match', 'partial', 'disagree', 'pending', 'unknown']);
export const DIFFICULTIES = new Set(['easy', 'standard', 'hard', 'edge', 'unknown']);
export const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
export const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'Eval lead review required — decision support only; items are never auto-published into a dataset.';

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(
    String(err?.message || '')
  );
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Returns a stable stringifiable form of a label for comparison.
 *   - nullish → ''
 *   - primitive → String(value)
 *   - object → serialized with keys sorted recursively
 */
export function normalizeLabel(label) {
  if (label === null || label === undefined) return '';
  if (typeof label !== 'object') return String(label);
  if (Array.isArray(label)) {
    return `[${label.map((item) => normalizeLabel(item)).join(',')}]`;
  }
  const keys = Object.keys(label).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${normalizeLabel(label[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Strict equality of label form: labelsEqual(a, b) iff normalizeLabel(a) === normalizeLabel(b).
 */
export function labelsEqual(a, b) {
  return normalizeLabel(a) === normalizeLabel(b);
}

/**
 * Partial-match check for two labels with the same keys. Returns:
 *   - false when one is primitive and the other is object
 *   - false for primitives (covered by labelsEqual instead)
 *   - true for objects when >= 50% of keys match exactly
 *     (string values compared case-insensitively)
 */
export function labelsPartialMatch(a, b) {
  const aIsObj = a !== null && typeof a === 'object' && !Array.isArray(a);
  const bIsObj = b !== null && typeof b === 'object' && !Array.isArray(b);
  if (aIsObj !== bIsObj) return false;
  if (!aIsObj) return false; // primitives: use labelsEqual
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  const union = new Set([...keysA, ...keysB]);
  if (!union.size) return false;
  const sharedKeys = keysA.filter((k) => Object.prototype.hasOwnProperty.call(b, k));
  if (!sharedKeys.length) return false;
  let matches = 0;
  for (const key of sharedKeys) {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string' && typeof bv === 'string') {
      if (av.toLowerCase() === bv.toLowerCase()) matches += 1;
    } else if (labelsEqual(av, bv)) {
      matches += 1;
    }
  }
  // >= 50% of keys match exactly (using the larger key set as denominator).
  const denominator = Math.max(keysA.length, keysB.length);
  if (denominator === 0) return false;
  return matches / denominator >= 0.5;
}

/**
 * Compute inter-rater agreement over the accepted annotations.
 *
 *   accepted count 0      → 'pending'
 *   accepted count 1      → 'pending' (need >= 2)
 *   all pairs equal       → 'match'
 *   >= 50% pairs equal OR
 *   any pair partial-match → 'partial'
 *   else                   → 'disagree'
 */
export function computeAgreement(annotations) {
  const accepted = asArray(annotations).filter((a) => a && a.reviewer_decision === 'accepted');
  if (accepted.length === 0) return 'pending';
  if (accepted.length === 1) return 'pending';
  const labels = accepted.map((a) => a.label);
  let totalPairs = 0;
  let equalPairs = 0;
  let anyPartial = false;
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      totalPairs += 1;
      if (labelsEqual(labels[i], labels[j])) {
        equalPairs += 1;
      } else if (labelsPartialMatch(labels[i], labels[j])) {
        anyPartial = true;
      }
    }
  }
  if (totalPairs === 0) return 'pending';
  if (equalPairs === totalPairs) return 'match';
  if (equalPairs / totalPairs >= 0.5 || anyPartial) return 'partial';
  return 'disagree';
}

/**
 * Confidence band derived from agreement + accepted count + avg confidence.
 *   match + acceptedCount >= requiredLabelers + avgConfidence >= 0.8 → 'high'
 *   match + acceptedCount >= requiredLabelers                         → 'medium'
 *   partial                                                            → 'medium'
 *   disagree                                                           → 'low'
 *   else                                                               → 'unknown'
 */
export function computeConfidenceBand({
  agreement,
  acceptedCount,
  requiredLabelers,
  averageConfidence,
} = {}) {
  const req = toNumber(requiredLabelers, 2);
  const count = toNumber(acceptedCount, 0);
  const avg = toNullableNumber(averageConfidence);
  if (agreement === 'match' && count >= req && avg !== null && avg >= 0.8) return 'high';
  if (agreement === 'match' && count >= req) return 'medium';
  if (agreement === 'partial') return 'medium';
  if (agreement === 'disagree') return 'low';
  return 'unknown';
}

/**
 * Task status derived from agreement + counts + any rejected flag.
 *   anyRejected AND acceptedCount === 0                   → 'rejected'
 *   acceptedCount === 0                                   → 'pending'
 *   acceptedCount < requiredLabelers AND agreement !==
 *     'disagree'                                          → 'in_progress'
 *   agreement === 'disagree'                              → 'conflict'
 *   agreement === 'match' AND acceptedCount >=
 *     requiredLabelers                                    → 'ready_to_use'
 *   else                                                  → 'in_progress'
 */
export function computeTaskStatus({
  agreement,
  acceptedCount,
  requiredLabelers,
  anyRejected,
} = {}) {
  const req = toNumber(requiredLabelers, 2);
  const count = toNumber(acceptedCount, 0);
  if (anyRejected && count === 0) return 'rejected';
  if (count === 0) return 'pending';
  if (count < req && agreement !== 'disagree') return 'in_progress';
  if (agreement === 'disagree') return 'conflict';
  if (agreement === 'match' && count >= req) return 'ready_to_use';
  return 'in_progress';
}

/**
 * Returns the most-frequent accepted label (by normalizeLabel) when the
 * agreement is 'match' or 'partial'; else null. If tie, returns the one
 * with the highest confidence_score.
 */
export function computeConsensusLabel({ annotations } = {}) {
  const accepted = asArray(annotations).filter((a) => a && a.reviewer_decision === 'accepted');
  if (accepted.length < 2) return null;
  const buckets = new Map();
  for (const a of accepted) {
    const key = normalizeLabel(a.label);
    const existing = buckets.get(key);
    const conf = toNullableNumber(a.confidence_score);
    if (!existing) {
      buckets.set(key, { label: a.label, count: 1, bestConf: conf === null ? -Infinity : conf });
    } else {
      existing.count += 1;
      if (conf !== null && conf > existing.bestConf) {
        existing.bestConf = conf;
        existing.label = a.label;
      }
    }
  }
  let winner = null;
  for (const entry of buckets.values()) {
    if (!winner) {
      winner = entry;
      continue;
    }
    if (entry.count > winner.count) {
      winner = entry;
    } else if (entry.count === winner.count && entry.bestConf > winner.bestConf) {
      winner = entry;
    }
  }
  // Return a consensus only when a single bucket has a strict majority.
  // This covers 'match' (all in one bucket), 'partial' (majority in one
  // bucket), and even 'disagree' cases where a clear plurality exists
  // (e.g. 2-of-3). Returns null on ties.
  if (!winner) return null;
  const tied = Array.from(buckets.values()).filter((e) => e.count === winner.count).length;
  if (tied > 1) return null;
  return winner.label;
}

/**
 * Classify the task's difficulty from agreement + counts.
 *   disagree AND acceptedCount >= requiredLabelers → 'hard'
 *   partial                                         → 'standard'
 *   match AND acceptedCount >= requiredLabelers    → 'easy'
 *   else                                            → 'unknown'
 */
export function classifyDifficulty({ acceptedCount, agreement, requiredLabelers } = {}) {
  const req = toNumber(requiredLabelers, 2);
  const count = toNumber(acceptedCount, 0);
  if (agreement === 'disagree' && count >= req) return 'hard';
  if (agreement === 'partial') return 'standard';
  if (agreement === 'match' && count >= req) return 'easy';
  return 'unknown';
}

/**
 * Compose agreement / status / confidence_band / consensus_label /
 * difficulty from an annotation array plus the required_labelers count.
 */
export function aggregateAnnotations({ annotations = [], requiredLabelers = 2 } = {}) {
  const list = asArray(annotations);
  const accepted = list.filter((a) => a && a.reviewer_decision === 'accepted');
  const rejected = list.filter((a) => a && a.reviewer_decision === 'rejected');
  const pending = list.filter((a) => a && a.reviewer_decision === 'pending');
  const acceptedCount = accepted.length;
  const rejectedCount = rejected.length;
  const pendingCount = pending.length;

  const agreement = computeAgreement(list);
  const anyRejected = rejectedCount > 0;

  // Average confidence over accepted annotations only.
  let confSum = 0;
  let confN = 0;
  for (const a of accepted) {
    const c = toNullableNumber(a.confidence_score);
    if (c !== null) {
      confSum += c;
      confN += 1;
    }
  }
  const averageConfidence = confN > 0 ? confSum / confN : null;

  const confidenceBand = computeConfidenceBand({
    agreement,
    acceptedCount,
    requiredLabelers,
    averageConfidence,
  });
  const status = computeTaskStatus({
    agreement,
    acceptedCount,
    requiredLabelers,
    anyRejected,
  });
  const consensusLabel = computeConsensusLabel({ annotations: list });
  const difficulty = classifyDifficulty({
    acceptedCount,
    agreement,
    requiredLabelers,
  });

  return {
    accepted_count: acceptedCount,
    rejected_count: rejectedCount,
    pending_count: pendingCount,
    agreement,
    status,
    confidence_band: confidenceBand,
    consensus_label: consensusLabel,
    difficulty,
  };
}

/**
 * Reviewer-facing action lines. Always ends with the eval-lead disclaimer.
 */
export function buildLabelingActions({ status, agreement, signals = [] } = {}) {
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const text = cleanText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    actions.push(text);
  };

  switch (status) {
    case 'conflict':
      push('Route the task to an adjudicator — annotations disagree and cannot be reconciled automatically.');
      push('Share the conflicting labels with the adjudicator and request a tie-breaking annotation.');
      break;
    case 'ready_to_use':
      push('Task is ready to use — eval lead should confirm before the item is promoted into the dataset.');
      break;
    case 'in_progress':
      push('Assign additional labelers to reach the required quorum before the task can be closed.');
      break;
    case 'pending':
      push('No annotations yet — assign the task to the labeling queue.');
      break;
    case 'rejected':
      push('All annotations have been rejected — remove the item from the queue or revise the input.');
      break;
    case 'archived':
      push('Task is archived — no further labeling action required.');
      break;
    default:
      push('Review the task manually.');
      break;
  }

  if (agreement === 'partial') {
    push('Consider a tie-breaking annotation to resolve partial agreement before marking ready_to_use.');
  } else if (agreement === 'disagree') {
    push('Annotations disagree — escalate to an adjudicator for a final label.');
  }

  for (const signal of asArray(signals)) {
    const code = signal?.code;
    if (!code) continue;
    if (code === 'LOW_CONFIDENCE') {
      push('Labeler reported low confidence — consider reassigning to a more experienced reviewer.');
    } else if (code === 'NO_LABELER_UID') {
      push('Annotation is missing a labeler identity — record the labeler before accepting.');
    } else if (code === 'NEW_ANNOTATION') {
      push('New annotation received — recompute agreement and confidence band.');
    }
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-sentence summary for a labeling task row.
 */
export function summarizeLabelingTask({
  datasetKey,
  itemKey,
  status,
  agreement,
  acceptedCount,
  requiredLabelers,
} = {}) {
  const ds = cleanText(datasetKey) || 'dataset';
  const item = cleanText(itemKey) || 'item';
  const st = TASK_STATUSES.has(status) ? status : 'unknown';
  const ag = AGREEMENT_BANDS.has(agreement) ? agreement : 'unknown';
  const count = toNumber(acceptedCount, 0);
  const req = toNumber(requiredLabelers, 2);
  return `${ds} / ${item}: ${st} — ${ag} (${count}/${req} accepted annotations).`;
}

// ---------- DB helpers --------------------------------------------------

async function getActivePrompt(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT version, system_prompt, user_prompt_template
       FROM clinical_ai_prompts
       WHERE tenant_id = $1::uuid
         AND module_key = $2
       ORDER BY active DESC, activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      tenantId,
      MODULE_KEY
    );
    return (rows && rows[0]) || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

function normalizeTaskRow(row) {
  if (!row) return row;
  return {
    ...row,
    required_labelers: row.required_labelers !== null && row.required_labelers !== undefined
      ? toNumber(row.required_labelers, 2)
      : 2,
  };
}

function normalizeAnnotationRow(row) {
  if (!row) return row;
  return {
    ...row,
    task_id: row.task_id !== null && row.task_id !== undefined
      ? toNumber(row.task_id, null)
      : null,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
    confidence_score: row.confidence_score !== null && row.confidence_score !== undefined
      ? toNumber(row.confidence_score, null)
      : null,
  };
}

async function loadTask(tenantId, taskId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, dataset_key, task_type, item_key, input_ref_type,
              input_ref_id, required_labelers, difficulty, status, confidence_band,
              agreement, consensus_label, metadata, created_at, updated_at
       FROM clinical_ai_labeling_tasks
       WHERE id = $1
         AND tenant_id = $2::uuid
       LIMIT 1`,
      taskId,
      tenantId
    );
    return normalizeTaskRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

async function loadAnnotationsForTask(tenantId, taskId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, task_id, labeler_uid, generation_id, label,
              reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
              confidence_score, signals, source_citations, safety_flags,
              metadata, created_at, updated_at
       FROM clinical_ai_labeling_annotations
       WHERE tenant_id = $1::uuid
         AND task_id = $2
       ORDER BY created_at ASC`,
      tenantId,
      taskId
    );
    return asArray(rows).map(normalizeAnnotationRow);
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function updateTaskAggregate({ tenantId, taskId, aggregate, requiredLabelers }) {
  const safeAgreement = AGREEMENT_BANDS.has(aggregate.agreement) ? aggregate.agreement : 'pending';
  const safeStatus = TASK_STATUSES.has(aggregate.status) ? aggregate.status : 'pending';
  const safeBand = CONFIDENCE_BANDS.has(aggregate.confidence_band) ? aggregate.confidence_band : 'unknown';
  const safeDifficulty = DIFFICULTIES.has(aggregate.difficulty) ? aggregate.difficulty : 'unknown';
  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE clinical_ai_labeling_tasks
       SET agreement = $3,
           status = $4,
           confidence_band = $5,
           consensus_label = $6::jsonb,
           difficulty = $7,
           required_labelers = COALESCE($8, required_labelers),
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2::uuid
       RETURNING id, tenant_id, dataset_key, task_type, item_key, input_ref_type,
                 input_ref_id, required_labelers, difficulty, status, confidence_band,
                 agreement, consensus_label, metadata, created_at, updated_at`,
      taskId,
      tenantId,
      safeAgreement,
      safeStatus,
      safeBand,
      JSON.stringify(aggregate.consensus_label || null),
      safeDifficulty,
      requiredLabelers === null || requiredLabelers === undefined
        ? null
        : toNumber(requiredLabelers, null)
    );
    return normalizeTaskRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  prompt,
  metadata,
}) {
  const hasCritical = asArray(safetyFlags).some((flag) => flag?.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, NULL, NULL, $2, $2, 'template', NULL,
               $3, $4, $5, FALSE, $6::jsonb, $7::jsonb, $8::jsonb,
               $9::uuid, 0, 0, 0, 0, $10::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      MODULE_KEY,
      prompt?.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      JSON.stringify(safetyFlags || []),
      JSON.stringify(citations || []),
      JSON.stringify(draft || {}),
      requestedBy,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Dataset labeling studio generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, module, taskId }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, NULL, NULL, 'pending', $4::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'AI_EVAL_LEAD', 'DATA_LABELER', 'DOCTOR'],
        source: 'dataset_labeling_studio',
        task_id: taskId || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Dataset labeling studio review placeholder failed', { error: err.message });
    }
    return null;
  }
}

// ---------- Public API --------------------------------------------------

/**
 * Upsert a labeling task on (tenant_id, dataset_key, item_key).
 * Does NOT overwrite status, agreement, confidence_band, or consensus_label.
 */
export async function createLabelingTask({
  tenantId = null,
  datasetKey,
  taskType,
  itemKey,
  inputRefType = null,
  inputRefId = null,
  requiredLabelers = 2,
  difficulty = 'standard',
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const ds = cleanText(datasetKey);
  if (!ds) throw AppError.badRequest('dataset_key is required');
  const tt = cleanText(taskType);
  if (!tt) throw AppError.badRequest('task_type is required');
  const item = cleanText(itemKey);
  if (!item) throw AppError.badRequest('item_key is required');

  const req = Number.parseInt(requiredLabelers, 10);
  if (!Number.isFinite(req) || req < 1) {
    throw AppError.badRequest('required_labelers must be >= 1');
  }
  const safeDifficulty = DIFFICULTIES.has(cleanText(difficulty).toLowerCase())
    ? cleanText(difficulty).toLowerCase()
    : 'standard';

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_labeling_tasks
         (tenant_id, dataset_key, task_type, item_key, input_ref_type, input_ref_id,
          required_labelers, difficulty, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, dataset_key, item_key)
       DO UPDATE SET
         task_type = EXCLUDED.task_type,
         input_ref_type = EXCLUDED.input_ref_type,
         input_ref_id = EXCLUDED.input_ref_id,
         required_labelers = EXCLUDED.required_labelers,
         difficulty = EXCLUDED.difficulty,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, dataset_key, task_type, item_key, input_ref_type,
                 input_ref_id, required_labelers, difficulty, status, confidence_band,
                 agreement, consensus_label, metadata, created_at, updated_at`,
      tid,
      ds,
      tt,
      item,
      inputRefType ? cleanText(inputRefType) : null,
      inputRefId ? cleanText(inputRefId) : null,
      req,
      safeDifficulty,
      JSON.stringify(metadata || {})
    );
    return normalizeTaskRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * List labeling tasks for the tenant. Ordered with conflicts first.
 */
export async function listLabelingTasks({
  tenantId = null,
  datasetKey = null,
  taskType = null,
  status = null,
  agreement = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedDataset = datasetKey ? cleanText(datasetKey) : null;
  const normalizedTaskType = taskType ? cleanText(taskType) : null;
  const normalizedStatus = status && TASK_STATUSES.has(cleanText(status).toLowerCase())
    ? cleanText(status).toLowerCase()
    : null;
  const normalizedAgreement = agreement && AGREEMENT_BANDS.has(cleanText(agreement).toLowerCase())
    ? cleanText(agreement).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, dataset_key, task_type, item_key, input_ref_type,
              input_ref_id, required_labelers, difficulty, status, confidence_band,
              agreement, consensus_label, metadata, created_at, updated_at
       FROM clinical_ai_labeling_tasks
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR dataset_key = $2)
         AND ($3::text IS NULL OR task_type = $3)
         AND ($4::text IS NULL OR status = $4)
         AND ($5::text IS NULL OR agreement = $5)
       ORDER BY
         CASE status
           WHEN 'conflict' THEN 0
           WHEN 'pending' THEN 1
           WHEN 'in_progress' THEN 2
           WHEN 'ready_to_use' THEN 3
           WHEN 'rejected' THEN 4
           WHEN 'archived' THEN 5
           ELSE 6
         END,
         created_at DESC
       LIMIT $6`,
      tid,
      normalizedDataset,
      normalizedTaskType,
      normalizedStatus,
      normalizedAgreement,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeTaskRow);
    return { tasks: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { tasks: [], count: 0 };
    throw err;
  }
}

/**
 * Submit a single labeler's annotation against a labeling task. Records
 * the annotation in 'pending' reviewer state, persists the
 * clinical_ai_generation, and creates a clinical review placeholder.
 */
export async function submitAnnotation({
  req = null,
  taskId,
  label,
  labelerUid = null,
  confidenceScore = null,
  metadata = {},
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const safeTaskId = optionalInt(taskId, 'task_id');
  const task = await loadTask(tenantId, safeTaskId);
  if (!task) throw AppError.notFound('Labeling task not found');

  const confidence = toNullableNumber(confidenceScore);

  const signals = [
    { code: 'NEW_ANNOTATION', detail: `task_id=${safeTaskId}` },
  ];

  const safetyFlags = [];
  if (confidence !== null && confidence < 0.5) {
    safetyFlags.push({
      severity: 'medium',
      code: 'LOW_CONFIDENCE',
      message: `Labeler reported confidence ${confidence} (< 0.5).`,
    });
  }
  if (!labelerUid) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_LABELER_UID',
      message: 'Annotation is missing a labeler identity.',
    });
  }

  const citations = [
    {
      source_type: 'labeling_task',
      source_id: String(task.id),
      label: `Labeling task — ${task.dataset_key} / ${task.item_key}`,
      timestamp: task.updated_at || task.created_at || null,
    },
  ];

  const draft = {
    module_key: MODULE_KEY,
    task_id: safeTaskId,
    dataset_key: task.dataset_key,
    task_type: task.task_type,
    item_key: task.item_key,
    labeler_uid: labelerUid || null,
    label,
    confidence_score: confidence,
    signals,
    source_citations: citations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        task: { id: task.id, dataset_key: task.dataset_key, item_key: task.item_key },
      },
      citations,
    }),
  ];
  draft.safety_flags = combinedFlags;

  const prompt = await getActivePrompt(tenantId);

  let annotationRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_labeling_annotations
         (tenant_id, task_id, labeler_uid, generation_id, label, reviewer_decision,
          confidence_score, signals, source_citations, safety_flags, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, NULL, $4::jsonb, 'pending', $5, $6::jsonb,
               $7::jsonb, $8::jsonb, $9::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, task_id, labeler_uid, generation_id, label,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 confidence_score, signals, source_citations, safety_flags,
                 metadata, created_at, updated_at`,
      tenantId,
      safeTaskId,
      labelerUid || null,
      JSON.stringify(label === undefined ? {} : label),
      confidence,
      JSON.stringify(signals),
      JSON.stringify(citations),
      JSON.stringify(combinedFlags),
      JSON.stringify(metadata || {})
    );
    annotationRow = normalizeAnnotationRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        annotation_id: null,
        task_id: safeTaskId,
        generation_id: null,
        clinical_review_id: null,
        annotation: null,
        signals,
        safety_flags: combinedFlags,
        module_key: MODULE_KEY,
        prompt_version: prompt?.version || 'v1',
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_labeling_annotations_unavailable',
        ai_metadata: { provider: 'template', model: null, used_ai: false, usage: {} },
        rules_authoritative: true,
        decision_support_only: true,
      };
    }
    throw err;
  }

  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      task_id: safeTaskId,
      annotation_id: annotationRow?.id || null,
      label: normalizeLabel(label),
      labeler_uid: labelerUid || null,
    }),
    draft,
    citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    prompt,
    metadata: {
      task_id: safeTaskId,
      annotation_id: annotationRow?.id || null,
      dataset_key: task.dataset_key,
      task_type: task.task_type,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  // Link generation on the annotation row (best-effort).
  if (annotationRow && generation?.id) {
    try {
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ai_labeling_annotations
         SET generation_id = $1,
             updated_at = NOW()
         WHERE id = $2
           AND tenant_id = $3::uuid`,
        generation.id,
        annotationRow.id,
        tenantId
      );
      annotationRow.generation_id = generation.id;
    } catch (err) {
      if (!isMissingSchemaError(err)) {
        logger.warn('Dataset labeling studio annotation generation link failed', {
          error: err.message,
        });
      }
    }
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    module,
    taskId: safeTaskId,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.labeling_annotation_submitted',
      aggregateType: 'clinical_ai_labeling_annotation',
      aggregateId: annotationRow?.id || null,
      payload: {
        tenant_id: tenantId,
        annotation_id: annotationRow?.id || null,
        task_id: safeTaskId,
        generation_id: generation?.id || null,
        labeler_uid: labelerUid || null,
        dataset_key: task.dataset_key,
        task_type: task.task_type,
      },
    });
  } catch (err) {
    logger.warn('Dataset labeling studio event publish failed', { error: err?.message });
  }

  return {
    annotation_id: annotationRow?.id || null,
    task_id: safeTaskId,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    annotation: annotationRow,
    signals,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || annotationRow?.reviewer_decision || 'pending',
    ai_metadata: {
      provider: 'template',
      model: null,
      used_ai: false,
      usage: {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

/**
 * Apply a reviewer decision to an annotation and re-aggregate the owning
 * task. Returns { annotation, task } after the update.
 */
export async function decideAnnotation({
  tenantId = null,
  annotationId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const safeAnnotationId = optionalInt(annotationId, 'annotation_id');

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_labeling_annotations
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, task_id, labeler_uid, generation_id, label,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               confidence_score, signals, source_citations, safety_flags,
               metadata, created_at, updated_at`,
    safeAnnotationId,
    normalized,
    reviewerUid || null,
    note ? cleanText(note) : null,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Labeling annotation not found');
  const annotation = normalizeAnnotationRow(rows[0]);

  // Re-aggregate the task.
  const task = await loadTask(tid, annotation.task_id);
  if (!task) {
    return { annotation, task: null };
  }
  const annotations = await loadAnnotationsForTask(tid, annotation.task_id);
  const aggregate = aggregateAnnotations({
    annotations,
    requiredLabelers: toNumber(task.required_labelers, 2),
  });
  const updatedTask = await updateTaskAggregate({
    tenantId: tid,
    taskId: annotation.task_id,
    aggregate,
    requiredLabelers: toNumber(task.required_labelers, 2),
  });
  return { annotation, task: updatedTask };
}

/**
 * List annotations for the tenant. Filter by task, labeler, decision.
 */
export async function listAnnotations({
  tenantId = null,
  taskId = null,
  labelerUid = null,
  reviewerDecision = null,
  limit = 100,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const safeTaskId = taskId ? optionalInt(taskId, 'task_id') : null;
  const normalizedDecision = reviewerDecision
    && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, task_id, labeler_uid, generation_id, label,
              reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
              confidence_score, signals, source_citations, safety_flags,
              metadata, created_at, updated_at
       FROM clinical_ai_labeling_annotations
       WHERE tenant_id = $1::uuid
         AND ($2::int IS NULL OR task_id = $2)
         AND ($3::uuid IS NULL OR labeler_uid = $3::uuid)
         AND ($4::text IS NULL OR reviewer_decision = $4)
       ORDER BY created_at DESC
       LIMIT $5`,
      tid,
      safeTaskId,
      labelerUid || null,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeAnnotationRow);
    return { annotations: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { annotations: [], count: 0 };
    throw err;
  }
}

/**
 * Load a task, its annotations (oldest first), and the derived aggregate.
 */
export async function getTaskWithAnnotations({ tenantId = null, taskId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeTaskId = optionalInt(taskId, 'task_id');
  const task = await loadTask(tid, safeTaskId);
  if (!task) throw AppError.notFound('Labeling task not found');
  const annotations = await loadAnnotationsForTask(tid, safeTaskId);
  const aggregate = aggregateAnnotations({
    annotations,
    requiredLabelers: toNumber(task.required_labelers, 2),
  });
  return { task, annotations, aggregate };
}

export default {
  TASK_STATUSES,
  STATUS_PRIORITY,
  CONFIDENCE_BANDS,
  AGREEMENT_BANDS,
  DIFFICULTIES,
  DECISIONS,
  FINAL_DECISIONS,
  normalizeLabel,
  labelsEqual,
  labelsPartialMatch,
  computeAgreement,
  computeConfidenceBand,
  computeTaskStatus,
  computeConsensusLabel,
  classifyDifficulty,
  aggregateAnnotations,
  buildLabelingActions,
  summarizeLabelingTask,
  createLabelingTask,
  listLabelingTasks,
  submitAnnotation,
  decideAnnotation,
  listAnnotations,
  getTaskWithAnnotations,
};
