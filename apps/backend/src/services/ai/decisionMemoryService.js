/**
 * Clinical AI decision memory.
 *
 * Implements the cross-run memory pattern adapted from
 * TauricResearch/TradingAgents — a per-ticker decision log that is read
 * back into subsequent runs for the same ticker — for the healthcare
 * setting:
 *
 *   * Same-patient retrieval injects the chain of prior accepted / edited
 *     / rejected drafts on this patient under this module, so the LLM can
 *     see "the last time you drafted a discharge summary for this person,
 *     the doctor edited the medication block to add an inhaler. Do not
 *     drop it again."
 *   * Cross-patient retrieval injects module-level lessons that match the
 *     current context shape (primary diagnosis class, age band, etc.) and
 *     have been marked PHI-safe — for example "for COPD readmissions in
 *     this tenant, reviewers consistently rejected aftercare drafts that
 *     omitted rescue inhaler technique."
 *
 * Authoritative source of decisions remains clinical_ai_reviews. This
 * service writes a projection optimised for retrieval into
 * clinical_ai_decision_memory; the projection is best-effort — when the
 * write fails, the underlying review still stands. The retrieval path
 * degrades gracefully if the projection table is unavailable (older DBs,
 * RLS misconfig, etc.) by returning an empty list.
 *
 * Review-only contract: nothing in this module changes a draft, a review,
 * or a generation. It only writes and reads its own projection table.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';

// ---------- helpers ------------------------------------------------------

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(
    String(err?.message || '')
  );
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInt(value, { min = 1, max = 50, fallback = 5 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

// ---------- context signature -------------------------------------------

/**
 * Compute a small JSON object describing the "shape" of a clinical case
 * so two cases with similar shapes can be retrieved against each other
 * cross-patient. The signature is intentionally coarse (not unique to one
 * patient) so it works as a retrieval bucket, not an identity.
 *
 * Inputs:
 *   - context: the clinical context payload produced by
 *     collectAdmissionClinicalContext (or any object with patient/admission
 *     and the usual diagnoses/notes/etc. arrays).
 *   - moduleKey: the module the signature is computed for. Some modules
 *     care about specific keys (e.g. medication_reconciliation cares
 *     about polypharmacy band; obstetric_risk_assistant cares about
 *     gestational age band).
 */
export function extractContextSignature(context = {}, moduleKey = null) {
  const admission = context.admission || {};
  const patient = context.patient || {};
  const diagnoses = asArray(context.diagnoses);
  const medications = asArray(context.medications);

  const ageBand = bandAge(patient.birthday);
  const lengthOfStayBand = bandLengthOfStay(admission.admitted_at, admission.discharged_at);

  const primaryDx = topDiagnosis(diagnoses, admission);
  const dxClass = classifyDiagnosis(primaryDx);

  const polypharmacyBand = bandPolypharmacy(medications);

  const signature = {
    module_key: moduleKey || null,
    primary_dx_class: dxClass,
    age_band: ageBand,
    length_of_stay_band: lengthOfStayBand,
    polypharmacy_band: polypharmacyBand,
    care_setting: cleanText(admission.ward).toLowerCase().split(/\s+/)[0] || null,
  };

  // Drop nulls so jsonb @> retrieval predicates stay tight.
  for (const key of Object.keys(signature)) {
    if (signature[key] === null || signature[key] === undefined || signature[key] === '') {
      delete signature[key];
    }
  }
  return signature;
}

function bandAge(birthday) {
  if (!birthday) return null;
  const date = new Date(birthday);
  if (Number.isNaN(date.getTime())) return null;
  const years = Math.floor((Date.now() - date.getTime()) / (365.25 * 24 * 3600 * 1000));
  if (years < 0) return null;
  if (years < 1) return 'infant';
  if (years < 12) return 'pediatric';
  if (years < 18) return 'adolescent';
  if (years < 40) return 'young_adult';
  if (years < 65) return 'middle_aged';
  if (years < 80) return 'older_adult';
  return 'very_old';
}

function bandLengthOfStay(admittedAt, dischargedAt) {
  if (!admittedAt) return null;
  const start = new Date(admittedAt);
  const end = dischargedAt ? new Date(dischargedAt) : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const days = Math.max(0, (end.getTime() - start.getTime()) / (24 * 3600 * 1000));
  if (days < 1) return 'same_day';
  if (days < 3) return 'short_stay';
  if (days < 7) return 'standard';
  if (days < 21) return 'extended';
  return 'prolonged';
}

function bandPolypharmacy(medications) {
  const count = asArray(medications).length;
  if (count === 0) return null;
  if (count <= 2) return 'low';
  if (count <= 5) return 'moderate';
  if (count <= 10) return 'high';
  return 'very_high';
}

function topDiagnosis(diagnoses, admission) {
  const candidates = [
    ...diagnoses.map((d) => d?.payload?.description || d?.payload?.diagnosis || d?.summary),
    admission.admitting_diagnosis,
    admission.chief_complaint,
  ];
  return cleanText(candidates.find((value) => Boolean(value)) || '');
}

// Coarse, deliberately-imperfect bucketing of free-text diagnoses into
// retrieval classes. Tenants that want sharper buckets should plug in
// ICD-10 or SNOMED mapping at this seam — the call site is small.
const DX_PATTERNS = [
  { class: 'respiratory_infection', re: /(pneumonia|bronchit|covid|influenza|rsv)/i },
  { class: 'copd_asthma', re: /(copd|asthma|aecopd)/i },
  { class: 'heart_failure', re: /(heart failure|chf|hfref|hfpef|cardiac failure)/i },
  { class: 'acute_coronary', re: /(stemi|nstemi|angina|myocardial)/i },
  { class: 'sepsis', re: /(sepsis|septic|bacteremia)/i },
  { class: 'gi_bleed', re: /(gi bleed|melena|hematemesis|upper gi|lower gi)/i },
  { class: 'stroke', re: /(stroke|cva|tia|infarct)/i },
  { class: 'diabetes_complication', re: /(dka|hhs|diabetic ketoacid|hyperosmolar|hypoglyc)/i },
  { class: 'aki_ckd', re: /(aki|acute kidney|ckd|chronic kidney|renal failure)/i },
  { class: 'obstetric', re: /(pregnan|antenatal|postpartum|labour|labor|preeclampsia|eclampsia|pph)/i },
  { class: 'oncology', re: /(cancer|carcinoma|malignan|lymphoma|leukemia|metasta)/i },
  { class: 'trauma', re: /(trauma|fracture|laceration|head injury|polytrauma)/i },
  { class: 'surgical_postop', re: /(post-op|postop|s\/p surgery|laparotomy|laparoscop)/i },
  { class: 'mental_health', re: /(depress|psychos|suicid|self.harm|bipolar|schizophren)/i },
  { class: 'pain_chronic', re: /(chronic pain|low back pain|fibromyalgia)/i },
];

export function classifyDiagnosis(text) {
  const t = cleanText(text).toLowerCase();
  if (!t) return 'unspecified';
  for (const entry of DX_PATTERNS) {
    if (entry.re.test(t)) return entry.class;
  }
  return 'other';
}

// ---------- summarisation -----------------------------------------------

const KEYS_TO_SUMMARISE = [
  'discharge_diagnosis',
  'admission_diagnosis',
  'primary_diagnosis',
  'risk_band',
  'risk_score',
  'compliance_score',
  'recommendation',
  'recommended_actions',
  'continue',
  'stop',
  'change',
  'safety_flags',
  'follow_up',
  'urgent_items',
];

/**
 * Build a short PHI-light summary of an AI draft. We intentionally do not
 * include patient identifiers, free-text narrative, or anything that
 * would survive de-duplication review across tenants — the goal is to
 * surface "what kind of recommendation was made", not a copy of the draft.
 */
export function summariseDraft(draft) {
  if (!draft || typeof draft !== 'object') return '';
  const parts = [];
  for (const key of KEYS_TO_SUMMARISE) {
    if (!(key in draft)) continue;
    const value = draft[key];
    if (Array.isArray(value)) {
      parts.push(`${key}=[${value.length} items]`);
    } else if (value && typeof value === 'object') {
      parts.push(`${key}={${Object.keys(value).length} keys}`);
    } else if (value !== null && value !== undefined && String(value).trim()) {
      const text = cleanText(value);
      parts.push(`${key}=${text.slice(0, 80)}`);
    }
  }
  return parts.slice(0, 6).join('; ').slice(0, 240);
}

/**
 * Diff two AI drafts and return a short structured summary of what the
 * reviewer changed. Walks the top-level keys; for arrays/objects, reports
 * which sub-keys grew, shrank, or changed. The summary is plain text and
 * is safe to embed in subsequent prompts.
 *
 * NOT a full structural diff — deep changes inside an array of objects
 * are summarised as "field X array changed". Reviewers can still read the
 * full edited_draft from clinical_ai_reviews if they need the exact diff.
 */
export function buildEditDiffSummary(originalDraft, editedDraft) {
  if (!originalDraft || !editedDraft) return '';
  if (typeof originalDraft !== 'object' || typeof editedDraft !== 'object') return '';

  const allKeys = new Set([...Object.keys(originalDraft), ...Object.keys(editedDraft)]);
  const diffs = [];

  for (const key of allKeys) {
    const before = originalDraft[key];
    const after = editedDraft[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;

    if (before === undefined) {
      diffs.push(`added ${key}`);
      continue;
    }
    if (after === undefined) {
      diffs.push(`removed ${key}`);
      continue;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      const delta = after.length - before.length;
      if (delta > 0) diffs.push(`${key} +${delta} items`);
      else if (delta < 0) diffs.push(`${key} ${delta} items`);
      else diffs.push(`${key} array reordered/edited`);
      continue;
    }
    if (before && after && typeof before === 'object' && typeof after === 'object') {
      diffs.push(`${key} object changed`);
      continue;
    }
    const beforeText = cleanText(before).slice(0, 40);
    const afterText = cleanText(after).slice(0, 40);
    diffs.push(`${key}: "${beforeText}" -> "${afterText}"`);
  }

  return diffs.slice(0, 8).join('; ').slice(0, 320);
}

// ---------- write path ---------------------------------------------------

const FINAL_DECISIONS = new Set(['accepted', 'rejected', 'edited', 'needs_revision', 'deferred']);

export async function recordDecision({
  tenantId = null,
  moduleKey,
  patientUid = null,
  admissionId = null,
  generationId = null,
  reviewId = null,
  decision,
  originalDraft = null,
  editedDraft = null,
  rejectionReason = null,
  contextSignature = null,
  reviewerRole = null,
  reviewerUid = null,
  crossPatientSafe = null,
  lesson = null,
} = {}) {
  const normalizedDecision = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalizedDecision)) {
    // Don't record pending or unknown — they're not supervision signal.
    return null;
  }
  if (!moduleKey) return null;

  const tid = resolveTenantId({ tenantId });
  const draftSummary = summariseDraft(editedDraft || originalDraft) || null;
  const editDiffSummary = normalizedDecision === 'edited'
    ? buildEditDiffSummary(originalDraft, editedDraft) || null
    : null;
  const rejectionText = normalizedDecision === 'rejected'
    ? cleanText(rejectionReason).slice(0, 1000) || null
    : null;
  const safe = crossPatientSafe === null
    // Be conservative: rejected/edited entries may carry residual PHI in
    // their summaries unless the caller explicitly says otherwise.
    ? normalizedDecision === 'accepted'
    : Boolean(crossPatientSafe);

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_decision_memory
         (tenant_id, module_key, patient_uid, admission_id, generation_id, review_id,
          decision, draft_summary, edit_diff_summary, rejection_reason, lesson,
          context_signature, reviewer_role, reviewer_uid, cross_patient_safe, created_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6,
               $7, $8, $9, $10, $11,
               $12::jsonb, $13, $14::uuid, $15, NOW())
       RETURNING id, created_at`,
      tid,
      moduleKey,
      patientUid,
      admissionId,
      generationId,
      reviewId,
      normalizedDecision,
      draftSummary,
      editDiffSummary,
      rejectionText,
      lesson ? cleanText(lesson).slice(0, 1000) : null,
      JSON.stringify(contextSignature || {}),
      reviewerRole || null,
      reviewerUid,
      safe
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) {
      // Schema not migrated yet — degrade silently. The underlying review
      // still stands; we just don't get the retrieval projection until
      // 108_clinical_ai_decision_memory.sql is applied.
      return null;
    }
    logger.warn('Decision memory recordDecision failed', {
      moduleKey,
      decision: normalizedDecision,
      error: err.message,
    });
    return null;
  }
}

// ---------- read path ---------------------------------------------------

/**
 * Retrieve up to `limit` prior decisions relevant to the current draft.
 *
 * Strategy:
 *   1. Same patient + same module: most recent N entries, regardless of
 *      cross_patient_safe flag (they belong to this patient anyway).
 *   2. Cross-patient + same module + signature overlap: most recent M
 *      entries where context_signature shares at least one key/value with
 *      the current signature, AND cross_patient_safe = true.
 *
 * The two lists are concatenated, deduplicated by id, and trimmed to
 * `limit`. Same-patient entries always win on ties.
 */
export async function retrieveRelevantDecisions({
  tenantId = null,
  moduleKey,
  patientUid = null,
  contextSignature = null,
  limit = 5,
} = {}) {
  if (!moduleKey) return { entries: [], source: 'no_module' };
  const tid = resolveTenantId({ tenantId });
  const cap = clampInt(limit, { min: 1, max: 20, fallback: 5 });

  try {
    const samePatient = patientUid
      ? await prisma.$queryRawUnsafe(
          `SELECT id, decision, draft_summary, edit_diff_summary, rejection_reason,
                  lesson, context_signature, reviewer_role, created_at
           FROM clinical_ai_decision_memory
           WHERE tenant_id = $1::uuid
             AND module_key = $2
             AND patient_uid = $3::uuid
           ORDER BY created_at DESC
           LIMIT $4`,
          tid,
          moduleKey,
          patientUid,
          cap
        )
      : [];

    // Cross-patient: signature overlap. Build a JSONB containment query
    // against any single key/value pair from the current signature.
    let crossPatient = [];
    const sigEntries = Object.entries(contextSignature || {}).filter(
      ([, value]) => value !== null && value !== undefined && value !== ''
    );
    if (sigEntries.length) {
      // OR across {key:value} containment predicates. Bound parameters
      // are passed as individual JSONB literals so the planner can use
      // the GIN index on context_signature.
      const containmentSql = sigEntries
        .map((_, idx) => `context_signature @> $${idx + 4}::jsonb`)
        .join(' OR ');
      const params = [
        tid,
        moduleKey,
        cap,
        ...sigEntries.map(([key, value]) => JSON.stringify({ [key]: value })),
      ];
      crossPatient = await prisma.$queryRawUnsafe(
        `SELECT id, decision, draft_summary, edit_diff_summary, rejection_reason,
                lesson, context_signature, reviewer_role, created_at
         FROM clinical_ai_decision_memory
         WHERE tenant_id = $1::uuid
           AND module_key = $2
           AND cross_patient_safe = true
           ${patientUid ? 'AND (patient_uid IS NULL OR patient_uid <> $' + (params.length + 1) + '::uuid)' : ''}
           AND (${containmentSql})
         ORDER BY created_at DESC
         LIMIT $3`,
        ...(patientUid ? [...params, patientUid] : params)
      );
    }

    const seen = new Set();
    const entries = [];
    for (const row of [...samePatient, ...crossPatient]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      entries.push({
        id: row.id,
        scope: samePatient.find((r) => r.id === row.id) ? 'same_patient' : 'cross_patient',
        decision: row.decision,
        draft_summary: row.draft_summary,
        edit_diff_summary: row.edit_diff_summary,
        rejection_reason: row.rejection_reason,
        lesson: row.lesson,
        context_signature: row.context_signature,
        reviewer_role: row.reviewer_role,
        created_at: row.created_at,
      });
      if (entries.length >= cap) break;
    }

    return { entries, source: entries.length ? 'memory' : 'memory_empty' };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return { entries: [], source: 'memory_unavailable' };
    }
    logger.warn('Decision memory retrieveRelevantDecisions failed', {
      moduleKey,
      error: err.message,
    });
    return { entries: [], source: 'memory_error' };
  }
}

export default {
  buildEditDiffSummary,
  classifyDiagnosis,
  extractContextSignature,
  recordDecision,
  retrieveRelevantDecisions,
  summariseDraft,
};
