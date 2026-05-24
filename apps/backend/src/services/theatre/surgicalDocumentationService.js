/**
 * Surgical / OR clinical documentation CRUD (Tier B PR1).
 *
 * Manages the seven new tables added in migration 116:
 *   - preop_checklists
 *   - intraop_notes
 *   - postop_notes
 *   - anesthesia_records
 *   - surgical_implants
 *   - surgical_safety_checklists (WHO 3-phase)
 *   - postop_complication_alerts
 *
 * Each document type has create / list / get / update plus one
 * domain-specific helper (e.g. finalize for notes, addPhase for safety
 * checklist, recordRemoval for implants, acknowledge for alerts).
 *
 * Decision-support only: AI surgical modules write candidate drafts to
 * clinical_ai_generations. A surgeon converts a draft to a finalized
 * intraop_note / postop_note via finalizeNote — never auto-published.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;
const SMALL_MAX = 80;

export const PREOP_STATUSES = ['in_progress', 'complete', 'incomplete_with_override'];
export const NOTE_STATUSES = ['draft', 'finalized', 'amended'];
export const RECOVERY_PHASES = ['pacu', 'phase1', 'phase2', 'ward', 'hdu', 'icu', 'discharged'];
export const ASA_GRADES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'IE', 'IIE', 'IIIE', 'IVE', 'VE'];
export const ANESTHESIA_TECHNIQUES = [
  'general', 'regional_spinal', 'regional_epidural', 'regional_block',
  'mac', 'local', 'combined',
];
export const AIRWAY_KINDS = [
  'mask', 'lma', 'ett_oral', 'ett_nasal', 'tracheostomy', 'awake_fiberoptic', 'none',
];
export const IMPLANT_STATUSES = ['planned', 'in_situ', 'removed', 'replaced', 'recalled'];
export const IMPLANT_SIDES = ['left', 'right', 'bilateral', 'midline', 'n/a'];
export const SAFETY_PHASES = ['sign_in', 'time_out', 'sign_out'];
export const SAFETY_STATUSES = ['in_progress', 'complete', 'incomplete_with_override'];
export const COMPLICATION_TYPES = [
  'anastomotic_leak', 'deep_ssi', 'superficial_ssi', 'wound_dehiscence',
  'return_to_theatre', 'reintubation', 'dvt', 'pe', 'mi', 'cva',
  'aki', 'sepsis', 'hemorrhage', 'ileus', 'organ_injury', 'other',
];
export const COMPLICATION_SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const COMPLICATION_STATUSES = ['open', 'acknowledged', 'resolved', 'false_positive'];
export const CLAVIEN_DINDO_GRADES = ['I', 'II', 'IIIa', 'IIIb', 'IVa', 'IVb', 'V'];
export const DETECTION_SOURCES = [
  'manual', 'ai_alert', 'lab_trigger', 'vitals_trigger', 'imaging', 'nursing',
];
export const COMPLICATION_OUTCOMES = [
  'resolved', 'stable', 'worsening', 'fatal', 'transferred', 'unknown',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeJsonArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON array`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeNumeric(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined) return null;
  const candidate = typeof value === 'string' ? value.trim() : value;
  if (candidate === '') return null;
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be a number`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

async function ensureScheduleVisible(tenantId, otScheduleId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM ot_schedules WHERE id = $1 LIMIT 1`,
    otScheduleId,
  );
  if (!rows[0]) throw AppError.notFound('ot_schedule not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// 1. preop_checklists
// ---------------------------------------------------------------------------

const PREOP_RETURNING = `id, tenant_id, ot_schedule_id, patient_uid,
  consent_signed, consent_signed_at, consent_witness,
  npo_status_confirmed, npo_since,
  site_marked, site_marked_by,
  allergies_reviewed, allergies_summary,
  blood_arranged, blood_units,
  imaging_available, required_imaging,
  preop_labs_reviewed, preop_labs_summary,
  blood_glucose_mg_dl, blood_glucose_checked_at,
  eye_drops_given, eye_drops_given_at, eye_drops_notes,
  antibiotic_prophylaxis, antibiotic_given_at,
  patient_identity_verified, procedure_verified, anesthesia_consent,
  special_equipment, pending_items, ai_review_summary,
  status, completed_by, completed_at, override_reason,
  metadata, created_at, updated_at`;

export async function upsertPreopChecklist({
  tenantId = null,
  otScheduleId,
  patientUid = null,
  consentSigned = undefined,
  consentSignedAt = undefined,
  consentWitness = undefined,
  npoStatusConfirmed = undefined,
  npoSince = undefined,
  siteMarked = undefined,
  siteMarkedBy = undefined,
  allergiesReviewed = undefined,
  allergiesSummary = undefined,
  bloodArranged = undefined,
  bloodUnits = undefined,
  imagingAvailable = undefined,
  requiredImaging = undefined,
  preopLabsReviewed = undefined,
  preopLabsSummary = undefined,
  bloodGlucoseMgDl = undefined,
  bloodGlucoseCheckedAt = undefined,
  eyeDropsGiven = undefined,
  eyeDropsGivenAt = undefined,
  eyeDropsNotes = undefined,
  antibioticProphylaxis = undefined,
  antibioticGivenAt = undefined,
  patientIdentityVerified = undefined,
  procedureVerified = undefined,
  anesthesiaConsent = undefined,
  specialEquipment = undefined,
  pendingItems = undefined,
  aiReviewSummary = undefined,
  status = undefined,
  completedBy = undefined,
  overrideReason = undefined,
  metadata = undefined,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  await ensureScheduleVisible(tid, scheduleId);
  const uid = maybeUuid(patientUid, 'patient_uid');

  const cols = [];
  const placeholders = [];
  const params = [];
  function add(col, value, cast = '') {
    params.push(value);
    cols.push(col);
    placeholders.push(`$${params.length}${cast}`);
  }
  add('tenant_id', tid, '::uuid');
  add('ot_schedule_id', scheduleId);
  add('patient_uid', uid, uid ? '::uuid' : '');
  add('consent_signed', normalizeBoolean(consentSigned, false));
  add('consent_signed_at', normalizeTimestamp(consentSignedAt, 'consent_signed_at'), '::timestamptz');
  add('consent_witness', safeText(consentWitness, SHORT_MAX));
  add('npo_status_confirmed', normalizeBoolean(npoStatusConfirmed, false));
  add('npo_since', normalizeTimestamp(npoSince, 'npo_since'), '::timestamptz');
  add('site_marked', normalizeBoolean(siteMarked, false));
  add('site_marked_by', maybeUuid(siteMarkedBy, 'site_marked_by'), '::uuid');
  add('allergies_reviewed', normalizeBoolean(allergiesReviewed, false));
  add('allergies_summary', safeText(allergiesSummary));
  add('blood_arranged', normalizeBoolean(bloodArranged, false));
  add('blood_units', normalizeInt(bloodUnits, 'blood_units', { min: 0, max: 100 }));
  add('imaging_available', normalizeBoolean(imagingAvailable, false));
  add('required_imaging', safeText(requiredImaging));
  add('preop_labs_reviewed', normalizeBoolean(preopLabsReviewed, false));
  add('preop_labs_summary', safeText(preopLabsSummary));
  add('blood_glucose_mg_dl', normalizeNumeric(bloodGlucoseMgDl, 'blood_glucose_mg_dl', { min: 0, max: 1000 }), '::numeric');
  add('blood_glucose_checked_at', normalizeTimestamp(bloodGlucoseCheckedAt, 'blood_glucose_checked_at'), '::timestamptz');
  add('eye_drops_given', normalizeBoolean(eyeDropsGiven, false));
  add('eye_drops_given_at', normalizeTimestamp(eyeDropsGivenAt, 'eye_drops_given_at'), '::timestamptz');
  add('eye_drops_notes', safeText(eyeDropsNotes));
  add('antibiotic_prophylaxis', safeText(antibioticProphylaxis, SHORT_MAX));
  add('antibiotic_given_at', normalizeTimestamp(antibioticGivenAt, 'antibiotic_given_at'), '::timestamptz');
  add('patient_identity_verified', normalizeBoolean(patientIdentityVerified, false));
  add('procedure_verified', normalizeBoolean(procedureVerified, false));
  add('anesthesia_consent', normalizeBoolean(anesthesiaConsent, false));
  add('special_equipment', safeText(specialEquipment));
  add('pending_items', JSON.stringify(normalizeJsonArray(pendingItems, 'pending_items')), '::jsonb');
  add('ai_review_summary', safeText(aiReviewSummary));
  const normalizedStatus = normalizeEnum(status, PREOP_STATUSES, 'status') || 'in_progress';
  add('status', normalizedStatus);
  add('completed_by', maybeUuid(completedBy, 'completed_by'), '::uuid');
  add('completed_at', normalizedStatus === 'complete' ? new Date().toISOString() : null, '::timestamptz');
  add('override_reason', safeText(overrideReason));
  add('metadata', JSON.stringify(normalizeJsonObject(metadata, 'metadata')), '::jsonb');

  const updateClauses = cols.slice(2).map((col) =>
    `${col} = EXCLUDED.${col}`).join(', ');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO preop_checklists (${cols.join(', ')})
       VALUES (${placeholders.join(', ')})
       ON CONFLICT (tenant_id, ot_schedule_id) DO UPDATE SET
         ${updateClauses}, updated_at = NOW()
       RETURNING ${PREOP_RETURNING}`,
      ...params,
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid ot_schedule_id or tenant_id');
    throw err;
  }
}

export async function getPreopChecklist({ tenantId = null, otScheduleId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${PREOP_RETURNING} FROM preop_checklists
       WHERE tenant_id = $1::uuid AND ot_schedule_id = $2 LIMIT 1`,
      tid, scheduleId,
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function listPreopChecklists({
  tenantId = null,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, PREOP_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${PREOP_RETURNING} FROM preop_checklists
       WHERE ${filters.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { checklists: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { checklists: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 2. intraop_notes
// ---------------------------------------------------------------------------

const INTRAOP_RETURNING = `id, tenant_id, ot_schedule_id, patient_uid,
  surgeon, primary_assistant, scrub_nurse, circulator,
  procedure_performed, procedure_codes, incision_type, position,
  findings, technique, specimens,
  estimated_blood_loss_ml, fluids_input, fluids_output,
  complications,
  sponge_count_correct, sharp_count_correct, instrument_count_correct,
  count_discrepancy_notes, drains_placed, closure_method,
  start_time, end_time,
  status, finalized_by, finalized_at, ai_assist_generation_id,
  metadata, created_at, updated_at`;

export async function createIntraopNote({
  tenantId = null,
  otScheduleId,
  patientUid = null,
  surgeon = null,
  primaryAssistant = null,
  scrubNurse = null,
  circulator = null,
  procedurePerformed = null,
  procedureCodes = null,
  incisionType = null,
  position = null,
  findings = null,
  technique = null,
  specimens = null,
  estimatedBloodLossMl = null,
  fluidsInput = null,
  fluidsOutput = null,
  complications = null,
  spongeCountCorrect = null,
  sharpCountCorrect = null,
  instrumentCountCorrect = null,
  countDiscrepancyNotes = null,
  drainsPlaced = null,
  closureMethod = null,
  startTime = null,
  endTime = null,
  status = 'draft',
  aiAssistGenerationId = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  await ensureScheduleVisible(tid, scheduleId);
  const codeArray = procedureCodes ? normalizeJsonArray(procedureCodes, 'procedure_codes')
    .map((c) => safeText(c, SMALL_MAX)).filter(Boolean) : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO intraop_notes
         (tenant_id, ot_schedule_id, patient_uid,
          surgeon, primary_assistant, scrub_nurse, circulator,
          procedure_performed, procedure_codes, incision_type, position,
          findings, technique, specimens,
          estimated_blood_loss_ml, fluids_input, fluids_output,
          complications,
          sponge_count_correct, sharp_count_correct, instrument_count_correct,
          count_discrepancy_notes, drains_placed, closure_method,
          start_time, end_time,
          status, ai_assist_generation_id, metadata)
       VALUES ($1::uuid, $2, $3::uuid,
         $4::uuid, $5::uuid, $6::uuid, $7::uuid,
         $8, $9::text[], $10, $11,
         $12, $13, $14::jsonb,
         $15, $16::jsonb, $17::jsonb,
         $18,
         $19, $20, $21,
         $22, $23::jsonb, $24,
         $25::timestamptz, $26::timestamptz,
         $27, $28, $29::jsonb)
       RETURNING ${INTRAOP_RETURNING}`,
      tid, scheduleId, maybeUuid(patientUid, 'patient_uid'),
      maybeUuid(surgeon, 'surgeon'),
      maybeUuid(primaryAssistant, 'primary_assistant'),
      maybeUuid(scrubNurse, 'scrub_nurse'),
      maybeUuid(circulator, 'circulator'),
      safeText(procedurePerformed, 500),
      codeArray,
      safeText(incisionType, 160),
      safeText(position, 120),
      safeText(findings),
      safeText(technique),
      JSON.stringify(specimens ? normalizeJsonArray(specimens, 'specimens') : []),
      normalizeInt(estimatedBloodLossMl, 'estimated_blood_loss_ml', { min: 0, max: 100000 }),
      JSON.stringify(normalizeJsonObject(fluidsInput, 'fluids_input')),
      JSON.stringify(normalizeJsonObject(fluidsOutput, 'fluids_output')),
      safeText(complications),
      normalizeBoolean(spongeCountCorrect),
      normalizeBoolean(sharpCountCorrect),
      normalizeBoolean(instrumentCountCorrect),
      safeText(countDiscrepancyNotes),
      JSON.stringify(drainsPlaced ? normalizeJsonArray(drainsPlaced, 'drains_placed') : []),
      safeText(closureMethod, SHORT_MAX),
      normalizeTimestamp(startTime, 'start_time'),
      normalizeTimestamp(endTime, 'end_time'),
      normalizeEnum(status, NOTE_STATUSES, 'status') || 'draft',
      aiAssistGenerationId ? normalizeId(aiAssistGenerationId, 'ai_assist_generation_id') : null,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listIntraopNotes({
  tenantId = null,
  otScheduleId = null,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (otScheduleId) {
    params.push(normalizeId(otScheduleId, 'ot_schedule_id'));
    filters.push(`ot_schedule_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, NOTE_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${INTRAOP_RETURNING} FROM intraop_notes
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { notes: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { notes: [], count: 0 };
    throw err;
  }
}

export async function finalizeIntraopNote({
  tenantId = null, id, finalizedBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const noteId = normalizeId(id, 'intraop_note id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE intraop_notes
     SET status = 'finalized',
         finalized_by = $1::uuid,
         finalized_at = NOW(),
         updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid AND status IN ('draft', 'amended')
     RETURNING ${INTRAOP_RETURNING}`,
    maybeUuid(finalizedBy, 'finalized_by'), noteId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Intraop note not found or already finalized');
  return rows[0];
}

// ---------------------------------------------------------------------------
// 3. postop_notes
// ---------------------------------------------------------------------------

const POSTOP_RETURNING = `id, tenant_id, ot_schedule_id, patient_uid,
  authored_by, pod_number, recovery_phase,
  vitals, pain_score, pain_management_plan,
  drain_status, wound_status, diet_advanced_to,
  ambulation, bowel_function, urine_output_ml,
  complications_noted, pending_orders, follow_up_actions,
  disposition, handover_notes,
  status, finalized_by, finalized_at, ai_assist_generation_id,
  metadata, created_at, updated_at`;

export async function createPostopNote({
  tenantId = null,
  otScheduleId,
  patientUid = null,
  authoredBy = null,
  podNumber = null,
  recoveryPhase = null,
  vitals = null,
  painScore = null,
  painManagementPlan = null,
  drainStatus = null,
  woundStatus = null,
  dietAdvancedTo = null,
  ambulation = null,
  bowelFunction = null,
  urineOutputMl = null,
  complicationsNoted = null,
  pendingOrders = null,
  followUpActions = null,
  disposition = null,
  handoverNotes = null,
  status = 'draft',
  finalizedBy = null,
  aiAssistGenerationId = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  await ensureScheduleVisible(tid, scheduleId);
  const cleanStatus = normalizeEnum(status, NOTE_STATUSES, 'status') || 'draft';
  // Wave-2 fix: if a postop note is created already finalized, stamp the
  // signature columns. Without this the note shows status=finalized with
  // NULL finalized_by/at — invisible signature. Finding:
  // 2026-05-09-surgical-day-care-ot-staff-anesthesia-finalized-by-null.
  const finalizerUid = cleanStatus === 'finalized'
    ? (maybeUuid(finalizedBy, 'finalized_by') || maybeUuid(authoredBy, 'authored_by'))
    : null;
  if (cleanStatus === 'finalized' && !finalizerUid) {
    throw AppError.badRequest(
      'finalized_by (or authored_by) is required to create a finalized postop note',
      'POSTOP_FINALIZER_REQUIRED',
    );
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO postop_notes
         (tenant_id, ot_schedule_id, patient_uid,
          authored_by, pod_number, recovery_phase,
          vitals, pain_score, pain_management_plan,
          drain_status, wound_status, diet_advanced_to,
          ambulation, bowel_function, urine_output_ml,
          complications_noted, pending_orders, follow_up_actions,
          disposition, handover_notes, status, finalized_by, finalized_at,
          ai_assist_generation_id, metadata)
       VALUES ($1::uuid, $2, $3::uuid,
         $4::uuid, $5, $6,
         $7::jsonb, $8, $9,
         $10::jsonb, $11, $12,
         $13, $14, $15,
         $16, $17::jsonb, $18::jsonb,
         $19, $20, $21, $22::uuid,
         CASE WHEN $21 = 'finalized' THEN NOW() ELSE NULL END,
         $23, $24::jsonb)
       RETURNING ${POSTOP_RETURNING}`,
      tid, scheduleId, maybeUuid(patientUid, 'patient_uid'),
      maybeUuid(authoredBy, 'authored_by'),
      normalizeInt(podNumber, 'pod_number', { min: 0, max: 365 }),
      normalizeEnum(recoveryPhase, RECOVERY_PHASES, 'recovery_phase'),
      JSON.stringify(normalizeJsonObject(vitals, 'vitals')),
      normalizeInt(painScore, 'pain_score', { min: 0, max: 10 }),
      safeText(painManagementPlan),
      JSON.stringify(drainStatus ? normalizeJsonArray(drainStatus, 'drain_status') : []),
      safeText(woundStatus, 160),
      safeText(dietAdvancedTo, 120),
      safeText(ambulation, 120),
      safeText(bowelFunction, 120),
      normalizeInt(urineOutputMl, 'urine_output_ml', { min: 0, max: 100000 }),
      safeText(complicationsNoted),
      JSON.stringify(pendingOrders ? normalizeJsonArray(pendingOrders, 'pending_orders') : []),
      JSON.stringify(followUpActions ? normalizeJsonArray(followUpActions, 'follow_up_actions') : []),
      safeText(disposition, 160),
      safeText(handoverNotes),
      cleanStatus,
      finalizerUid,
      aiAssistGenerationId ? normalizeId(aiAssistGenerationId, 'ai_assist_generation_id') : null,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listPostopNotes({
  tenantId = null,
  otScheduleId = null,
  recoveryPhase = null,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (otScheduleId) {
    params.push(normalizeId(otScheduleId, 'ot_schedule_id'));
    filters.push(`ot_schedule_id = $${params.length}`);
  }
  if (recoveryPhase) {
    params.push(normalizeEnum(recoveryPhase, RECOVERY_PHASES, 'recovery_phase'));
    filters.push(`recovery_phase = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, NOTE_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${POSTOP_RETURNING} FROM postop_notes
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { notes: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { notes: [], count: 0 };
    throw err;
  }
}

export async function finalizePostopNote({
  tenantId = null, id, finalizedBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const noteId = normalizeId(id, 'postop_note id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE postop_notes
     SET status = 'finalized',
         finalized_by = $1::uuid,
         finalized_at = NOW(),
         updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid AND status IN ('draft', 'amended')
     RETURNING ${POSTOP_RETURNING}`,
    maybeUuid(finalizedBy, 'finalized_by'), noteId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Postop note not found or already finalized');
  return rows[0];
}

// ---------------------------------------------------------------------------
// 4. anesthesia_records
// ---------------------------------------------------------------------------

const ANESTHESIA_RETURNING = `id, tenant_id, ot_schedule_id, patient_uid,
  anesthetist, assistant, preop_assessment_complete,
  asa_grade, airway_assessment, preop_meds_held,
  technique, airway_managed, intubation_grade, agents_used,
  fluids_in_ml, blood_products_in, urine_output_ml, blood_loss_ml,
  events, complications, recovery_destination, pain_plan, ponv_prophylaxis,
  status, finalized_by, finalized_at, ai_precheck_generation_id,
  metadata, created_at, updated_at`;

export async function upsertAnesthesiaRecord({
  tenantId = null,
  otScheduleId,
  patientUid = null,
  anesthetist = null,
  assistant = null,
  preopAssessmentComplete = undefined,
  asaGrade = null,
  airwayAssessment = null,
  preopMedsHeld = null,
  technique = null,
  airwayManaged = null,
  intubationGrade = null,
  agentsUsed = null,
  fluidsInMl = null,
  bloodProductsIn = null,
  urineOutputMl = null,
  bloodLossMl = null,
  events = null,
  complications = null,
  recoveryDestination = null,
  painPlan = null,
  ponvProphylaxis = null,
  status = 'draft',
  finalizedBy = null,
  aiPrecheckGenerationId = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  await ensureScheduleVisible(tid, scheduleId);
  const cleanStatus = normalizeEnum(status, NOTE_STATUSES, 'status') || 'draft';
  // Wave-2 fix: stamp finalized_by / finalized_at whenever the upsert lands
  // on status='finalized'. Without this stamp the signature is invisible
  // even after the route reports the record as signed. Finding:
  // 2026-05-09-surgical-day-care-ot-staff-anesthesia-finalized-by-null.
  const finalizerUid = cleanStatus === 'finalized'
    ? (maybeUuid(finalizedBy, 'finalized_by') || maybeUuid(anesthetist, 'anesthetist'))
    : null;
  if (cleanStatus === 'finalized' && !finalizerUid) {
    throw AppError.badRequest(
      'finalized_by (or anesthetist) is required to finalize an anaesthesia record',
      'ANAESTHESIA_FINALIZER_REQUIRED',
    );
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO anesthesia_records
         (tenant_id, ot_schedule_id, patient_uid,
          anesthetist, assistant, preop_assessment_complete,
          asa_grade, airway_assessment, preop_meds_held,
          technique, airway_managed, intubation_grade, agents_used,
          fluids_in_ml, blood_products_in, urine_output_ml, blood_loss_ml,
          events, complications, recovery_destination, pain_plan, ponv_prophylaxis,
          status, finalized_by, finalized_at, ai_precheck_generation_id, metadata)
       VALUES ($1::uuid, $2, $3::uuid,
         $4::uuid, $5::uuid, $6,
         $7, $8::jsonb, $9::jsonb,
         $10, $11, $12, $13::jsonb,
         $14, $15::jsonb, $16, $17,
         $18::jsonb, $19, $20, $21, $22,
         $23, $24::uuid,
         CASE WHEN $23 = 'finalized' THEN NOW() ELSE NULL END,
         $25, $26::jsonb)
       ON CONFLICT (tenant_id, ot_schedule_id) DO UPDATE SET
         patient_uid = EXCLUDED.patient_uid,
         anesthetist = EXCLUDED.anesthetist,
         assistant = EXCLUDED.assistant,
         preop_assessment_complete = EXCLUDED.preop_assessment_complete,
         asa_grade = EXCLUDED.asa_grade,
         airway_assessment = EXCLUDED.airway_assessment,
         preop_meds_held = EXCLUDED.preop_meds_held,
         technique = EXCLUDED.technique,
         airway_managed = EXCLUDED.airway_managed,
         intubation_grade = EXCLUDED.intubation_grade,
         agents_used = EXCLUDED.agents_used,
         fluids_in_ml = EXCLUDED.fluids_in_ml,
         blood_products_in = EXCLUDED.blood_products_in,
         urine_output_ml = EXCLUDED.urine_output_ml,
         blood_loss_ml = EXCLUDED.blood_loss_ml,
         events = EXCLUDED.events,
         complications = EXCLUDED.complications,
         recovery_destination = EXCLUDED.recovery_destination,
         pain_plan = EXCLUDED.pain_plan,
         ponv_prophylaxis = EXCLUDED.ponv_prophylaxis,
         status = EXCLUDED.status,
         finalized_by = CASE
           WHEN EXCLUDED.status = 'finalized' THEN COALESCE(EXCLUDED.finalized_by, anesthesia_records.finalized_by)
           ELSE anesthesia_records.finalized_by
         END,
         finalized_at = CASE
           WHEN EXCLUDED.status = 'finalized' AND anesthesia_records.finalized_at IS NULL THEN NOW()
           ELSE anesthesia_records.finalized_at
         END,
         ai_precheck_generation_id = EXCLUDED.ai_precheck_generation_id,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING ${ANESTHESIA_RETURNING}`,
      tid, scheduleId, maybeUuid(patientUid, 'patient_uid'),
      maybeUuid(anesthetist, 'anesthetist'),
      maybeUuid(assistant, 'assistant'),
      normalizeBoolean(preopAssessmentComplete, false),
      normalizeEnum(asaGrade, ASA_GRADES, 'asa_grade'),
      JSON.stringify(normalizeJsonObject(airwayAssessment, 'airway_assessment')),
      JSON.stringify(preopMedsHeld ? normalizeJsonArray(preopMedsHeld, 'preop_meds_held') : []),
      normalizeEnum(technique, ANESTHESIA_TECHNIQUES, 'technique'),
      normalizeEnum(airwayManaged, AIRWAY_KINDS, 'airway_managed'),
      safeText(intubationGrade, 8),
      JSON.stringify(agentsUsed ? normalizeJsonArray(agentsUsed, 'agents_used') : []),
      normalizeInt(fluidsInMl, 'fluids_in_ml', { min: 0, max: 100000 }),
      JSON.stringify(bloodProductsIn ? normalizeJsonArray(bloodProductsIn, 'blood_products_in') : []),
      normalizeInt(urineOutputMl, 'urine_output_ml', { min: 0, max: 100000 }),
      normalizeInt(bloodLossMl, 'blood_loss_ml', { min: 0, max: 100000 }),
      JSON.stringify(events ? normalizeJsonArray(events, 'events') : []),
      safeText(complications),
      safeText(recoveryDestination, 40),
      safeText(painPlan),
      safeText(ponvProphylaxis),
      cleanStatus,
      finalizerUid,
      aiPrecheckGenerationId ? normalizeId(aiPrecheckGenerationId, 'ai_precheck_generation_id') : null,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function finalizeAnesthesiaRecord({
  tenantId = null, otScheduleId, finalizedBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  const finalizerUid = maybeUuid(finalizedBy, 'finalized_by');
  if (!finalizerUid) {
    throw AppError.badRequest(
      'finalized_by is required to finalize an anaesthesia record',
      'ANAESTHESIA_FINALIZER_REQUIRED',
    );
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE anesthesia_records
     SET status = 'finalized',
         finalized_by = $1::uuid,
         finalized_at = NOW(),
         updated_at = NOW()
     WHERE ot_schedule_id = $2 AND tenant_id = $3::uuid AND status IN ('draft', 'amended')
     RETURNING ${ANESTHESIA_RETURNING}`,
    finalizerUid, scheduleId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Anaesthesia record not found or already finalized');
  return rows[0];
}

export async function getAnesthesiaRecord({ tenantId = null, otScheduleId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${ANESTHESIA_RETURNING} FROM anesthesia_records
       WHERE tenant_id = $1::uuid AND ot_schedule_id = $2 LIMIT 1`,
      tid, scheduleId,
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 5. surgical_implants
// ---------------------------------------------------------------------------

const IMPLANT_RETURNING = `id, tenant_id, ot_schedule_id, patient_uid,
  implant_type, manufacturer, brand_name, product_name,
  reference_number, lot_number, serial_number, udi, gudid_di,
  size, side, expiry_date, sterilization_lot,
  implanted_by, implanted_at, removal_date, removal_reason,
  status, recall_reference, notes,
  metadata, created_at, updated_at`;

export async function recordImplant({
  tenantId = null,
  otScheduleId,
  patientUid = null,
  implantType,
  manufacturer = null,
  brandName = null,
  productName = null,
  referenceNumber = null,
  lotNumber = null,
  serialNumber = null,
  udi = null,
  gudidDi = null,
  size = null,
  side = null,
  expiryDate = null,
  sterilizationLot = null,
  implantedBy = null,
  implantedAt = null,
  status = 'in_situ',
  recallReference = null,
  notes = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  await ensureScheduleVisible(tid, scheduleId);
  const cleanType = safeText(implantType, 160);
  if (!cleanType) throw AppError.badRequest('implant_type is required');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO surgical_implants
         (tenant_id, ot_schedule_id, patient_uid,
          implant_type, manufacturer, brand_name, product_name,
          reference_number, lot_number, serial_number, udi, gudid_di,
          size, side, expiry_date, sterilization_lot,
          implanted_by, implanted_at,
          status, recall_reference, notes, metadata)
       VALUES ($1::uuid, $2, $3::uuid,
         $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15::date, $16,
         $17::uuid, $18::timestamptz,
         $19, $20, $21, $22::jsonb)
       RETURNING ${IMPLANT_RETURNING}`,
      tid, scheduleId, maybeUuid(patientUid, 'patient_uid'),
      cleanType,
      safeText(manufacturer, SHORT_MAX),
      safeText(brandName, SHORT_MAX),
      safeText(productName, SHORT_MAX),
      safeText(referenceNumber, 120),
      safeText(lotNumber, 120),
      safeText(serialNumber, 160),
      safeText(udi, SHORT_MAX),
      safeText(gudidDi, 120),
      safeText(size, SMALL_MAX),
      normalizeEnum(side, IMPLANT_SIDES, 'side'),
      expiryDate ? String(expiryDate).slice(0, 10) : null,
      safeText(sterilizationLot, 120),
      maybeUuid(implantedBy, 'implanted_by'),
      normalizeTimestamp(implantedAt, 'implanted_at'),
      normalizeEnum(status, IMPLANT_STATUSES, 'status') || 'in_situ',
      safeText(recallReference, SHORT_MAX),
      safeText(notes),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listImplants({
  tenantId = null,
  otScheduleId = null,
  patientUid = null,
  status = null,
  manufacturer = null,
  lotNumber = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (otScheduleId) {
    params.push(normalizeId(otScheduleId, 'ot_schedule_id'));
    filters.push(`ot_schedule_id = $${params.length}`);
  }
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (status) {
    params.push(normalizeEnum(status, IMPLANT_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (manufacturer) {
    params.push(safeText(manufacturer, SHORT_MAX));
    filters.push(`manufacturer = $${params.length}`);
  }
  if (lotNumber) {
    params.push(safeText(lotNumber, 120));
    filters.push(`lot_number = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${IMPLANT_RETURNING} FROM surgical_implants
       WHERE ${filters.join(' AND ')}
       ORDER BY implanted_at DESC NULLS LAST, created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { implants: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { implants: [], count: 0 };
    throw err;
  }
}

export async function recordImplantRemoval({
  tenantId = null,
  id,
  removalDate = null,
  removalReason = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const implantId = normalizeId(id, 'implant id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE surgical_implants
     SET status = 'removed',
         removal_date = COALESCE($1::timestamptz, NOW()),
         removal_reason = $2,
         updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4::uuid AND status IN ('in_situ', 'replaced')
     RETURNING ${IMPLANT_RETURNING}`,
    normalizeTimestamp(removalDate, 'removal_date'),
    safeText(removalReason),
    implantId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Implant not found or not in_situ');
  return rows[0];
}

// ---------------------------------------------------------------------------
// 6. surgical_safety_checklists (WHO 3-phase)
// ---------------------------------------------------------------------------

const SAFETY_RETURNING = `id, tenant_id, ot_schedule_id, patient_uid,
  phase, performed_by, performed_at,
  items, all_items_confirmed, outstanding_items,
  status, override_reason, override_authorized_by, notes,
  metadata, created_at, updated_at`;

// Normalize a surgical laterality/side token to left|right|bilateral|null.
function normalizeSurgicalSide(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (['left', 'l', 'os', 'lt'].includes(s)) return 'left';
  if (['right', 'r', 'od', 'rt'].includes(s)) return 'right';
  if (['bilateral', 'both', 'ou', 'b/l'].includes(s)) return 'bilateral';
  return null;
}

// Detect a documented surgical-site/side mismatch in a WHO time-out's
// metadata (scheduled vs marked). Returns { scheduled, marked } on a real
// mismatch, else null. Bilateral or unknown sides never count as a mismatch.
// Pure + exported for unit testing.
// Finding 2026-05-22-surgical-day-care-ot-staff-e410248f.
export function detectSiteSideMismatch(metadata) {
  const md = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const scheduled = normalizeSurgicalSide(md.scheduled_side ?? md.scheduled_laterality ?? md.scheduled_eye);
  const marked = normalizeSurgicalSide(
    md.marked_side ?? md.marked_laterality ?? md.marked_eye ?? md.site_marked_side,
  );
  if (!scheduled || !marked || scheduled === 'bilateral' || marked === 'bilateral') return null;
  return scheduled === marked ? null : { scheduled, marked };
}

export async function upsertSafetyChecklistPhase({
  tenantId = null,
  otScheduleId,
  patientUid = null,
  phase,
  performedBy = null,
  performedAt = null,
  items = null,
  allItemsConfirmed = undefined,
  outstandingItems = null,
  status = undefined,
  overrideReason = null,
  overrideAuthorizedBy = null,
  notes = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  await ensureScheduleVisible(tid, scheduleId);
  const cleanPhase = normalizeEnum(phase, SAFETY_PHASES, 'phase', { required: true });
  const itemsArr = normalizeJsonArray(items, 'items');
  const outstandingArr = normalizeJsonArray(outstandingItems, 'outstanding_items');
  const allConfirmed = normalizeBoolean(allItemsConfirmed, outstandingArr.length === 0);
  const inferredStatus = allConfirmed
    ? 'complete'
    : (overrideReason ? 'incomplete_with_override' : 'in_progress');
  const cleanStatus = normalizeEnum(status, SAFETY_STATUSES, 'status') || inferredStatus;

  // WHO time-out is the wrong-site safety gate. A time-out whose read-aloud
  // checklist documents a side mismatch (scheduled vs marked) must NOT save as
  // a passing 'complete' without an explicit clinical override — otherwise the
  // documented wrong-site case satisfies the incision-start gate and proceeds.
  // Finding 2026-05-22-surgical-day-care-ot-staff-e410248f.
  if (cleanPhase === 'time_out' && cleanStatus === 'complete') {
    const mismatch = detectSiteSideMismatch(metadata);
    const overridden = Boolean(safeText(overrideReason)) && Boolean(overrideAuthorizedBy);
    if (mismatch && !overridden) {
      throw AppError.badRequest(
        `WHO time-out documents a surgical-site mismatch (scheduled ${mismatch.scheduled}, marked ${mismatch.marked}); `
        + 'complete it only with an explicit clinical override (override_reason + override_authorized_by).',
        'SURGICAL_SITE_SIDE_MISMATCH',
        mismatch,
      );
    }
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO surgical_safety_checklists
         (tenant_id, ot_schedule_id, patient_uid,
          phase, performed_by, performed_at,
          items, all_items_confirmed, outstanding_items,
          status, override_reason, override_authorized_by, notes, metadata)
       VALUES ($1::uuid, $2, $3::uuid,
         $4, $5::uuid, COALESCE($6::timestamptz, NOW()),
         $7::jsonb, $8, $9::jsonb,
         $10, $11, $12::uuid, $13, $14::jsonb)
       ON CONFLICT (tenant_id, ot_schedule_id, phase) DO UPDATE SET
         patient_uid = EXCLUDED.patient_uid,
         performed_by = EXCLUDED.performed_by,
         performed_at = COALESCE(EXCLUDED.performed_at, surgical_safety_checklists.performed_at, NOW()),
         items = EXCLUDED.items,
         all_items_confirmed = EXCLUDED.all_items_confirmed,
         outstanding_items = EXCLUDED.outstanding_items,
         status = EXCLUDED.status,
         override_reason = EXCLUDED.override_reason,
         override_authorized_by = EXCLUDED.override_authorized_by,
         notes = EXCLUDED.notes,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING ${SAFETY_RETURNING}`,
      tid, scheduleId, maybeUuid(patientUid, 'patient_uid'),
      cleanPhase,
      maybeUuid(performedBy, 'performed_by'),
      normalizeTimestamp(performedAt, 'performed_at'),
      JSON.stringify(itemsArr),
      allConfirmed,
      JSON.stringify(outstandingArr),
      cleanStatus,
      safeText(overrideReason),
      maybeUuid(overrideAuthorizedBy, 'override_authorized_by'),
      safeText(notes),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listSafetyChecklist({ tenantId = null, otScheduleId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${SAFETY_RETURNING} FROM surgical_safety_checklists
       WHERE tenant_id = $1::uuid AND ot_schedule_id = $2
       ORDER BY CASE phase WHEN 'sign_in' THEN 0 WHEN 'time_out' THEN 1 ELSE 2 END`,
      tid, scheduleId,
    );
    return { phases: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { phases: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 7. postop_complication_alerts
// ---------------------------------------------------------------------------

const COMPLICATION_RETURNING = `id, tenant_id, ot_schedule_id, patient_uid,
  complication_type, severity, detected_at, detected_by, detection_source,
  description, clavien_dindo_grade, intervention, intervention_at, outcome,
  ai_alert_generation_id, acknowledged_by, acknowledged_at, status,
  metadata, created_at, updated_at`;

export async function recordComplicationAlert({
  tenantId = null,
  otScheduleId,
  patientUid = null,
  complicationType,
  severity = 'medium',
  detectedAt = null,
  detectedBy = null,
  detectionSource = null,
  description = null,
  clavienDindoGrade = null,
  intervention = null,
  interventionAt = null,
  outcome = null,
  aiAlertGenerationId = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  await ensureScheduleVisible(tid, scheduleId);
  const cleanType = normalizeEnum(complicationType, COMPLICATION_TYPES, 'complication_type', { required: true });

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO postop_complication_alerts
         (tenant_id, ot_schedule_id, patient_uid,
          complication_type, severity, detected_at, detected_by, detection_source,
          description, clavien_dindo_grade, intervention, intervention_at, outcome,
          ai_alert_generation_id, status, metadata)
       VALUES ($1::uuid, $2, $3::uuid,
         $4, $5, COALESCE($6::timestamptz, NOW()), $7::uuid, $8,
         $9, $10, $11, $12::timestamptz, $13,
         $14, 'open', $15::jsonb)
       RETURNING ${COMPLICATION_RETURNING}`,
      tid, scheduleId, maybeUuid(patientUid, 'patient_uid'),
      cleanType,
      normalizeEnum(severity, COMPLICATION_SEVERITIES, 'severity') || 'medium',
      normalizeTimestamp(detectedAt, 'detected_at'),
      maybeUuid(detectedBy, 'detected_by'),
      normalizeEnum(detectionSource, DETECTION_SOURCES, 'detection_source'),
      safeText(description),
      normalizeEnum(clavienDindoGrade, CLAVIEN_DINDO_GRADES, 'clavien_dindo_grade'),
      safeText(intervention),
      normalizeTimestamp(interventionAt, 'intervention_at'),
      normalizeEnum(outcome, COMPLICATION_OUTCOMES, 'outcome'),
      aiAlertGenerationId ? normalizeId(aiAlertGenerationId, 'ai_alert_generation_id') : null,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listComplicationAlerts({
  tenantId = null,
  otScheduleId = null,
  patientUid = null,
  status = null,
  severity = null,
  complicationType = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (otScheduleId) {
    params.push(normalizeId(otScheduleId, 'ot_schedule_id'));
    filters.push(`ot_schedule_id = $${params.length}`);
  }
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (status) {
    params.push(normalizeEnum(status, COMPLICATION_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (severity) {
    params.push(normalizeEnum(severity, COMPLICATION_SEVERITIES, 'severity'));
    filters.push(`severity = $${params.length}`);
  }
  if (complicationType) {
    params.push(normalizeEnum(complicationType, COMPLICATION_TYPES, 'complication_type'));
    filters.push(`complication_type = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${COMPLICATION_RETURNING} FROM postop_complication_alerts
       WHERE ${filters.join(' AND ')}
       ORDER BY detected_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { alerts: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { alerts: [], count: 0 };
    throw err;
  }
}

export async function acknowledgeComplicationAlert({
  tenantId = null,
  id,
  acknowledgedBy,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const alertId = normalizeId(id, 'complication alert id');
  const ackedBy = maybeUuid(acknowledgedBy, 'acknowledged_by');
  if (!ackedBy) throw AppError.badRequest('acknowledged_by is required');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE postop_complication_alerts
     SET status = 'acknowledged',
         acknowledged_by = $1::uuid,
         acknowledged_at = NOW(),
         updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid AND status = 'open'
     RETURNING ${COMPLICATION_RETURNING}`,
    ackedBy, alertId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Alert not found or not open');
  return rows[0];
}

export async function resolveComplicationAlert({
  tenantId = null,
  id,
  outcome = null,
  intervention = null,
  interventionAt = null,
  clavienDindoGrade = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const alertId = normalizeId(id, 'complication alert id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE postop_complication_alerts
     SET status = 'resolved',
         outcome = COALESCE($1, outcome),
         intervention = COALESCE($2, intervention),
         intervention_at = COALESCE($3::timestamptz, intervention_at),
         clavien_dindo_grade = COALESCE($4, clavien_dindo_grade),
         updated_at = NOW()
     WHERE id = $5 AND tenant_id = $6::uuid AND status IN ('open', 'acknowledged')
     RETURNING ${COMPLICATION_RETURNING}`,
    normalizeEnum(outcome, COMPLICATION_OUTCOMES, 'outcome'),
    safeText(intervention),
    normalizeTimestamp(interventionAt, 'intervention_at'),
    normalizeEnum(clavienDindoGrade, CLAVIEN_DINDO_GRADES, 'clavien_dindo_grade'),
    alertId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Alert not found or already resolved');
  return rows[0];
}

export const __testing__ = {
  PREOP_STATUSES,
  NOTE_STATUSES,
  SAFETY_PHASES,
  SAFETY_STATUSES,
  IMPLANT_STATUSES,
  COMPLICATION_TYPES,
  COMPLICATION_SEVERITIES,
};

export default {
  upsertPreopChecklist,
  getPreopChecklist,
  listPreopChecklists,
  createIntraopNote,
  listIntraopNotes,
  finalizeIntraopNote,
  createPostopNote,
  listPostopNotes,
  finalizePostopNote,
  upsertAnesthesiaRecord,
  finalizeAnesthesiaRecord,
  getAnesthesiaRecord,
  recordImplant,
  listImplants,
  recordImplantRemoval,
  upsertSafetyChecklistPhase,
  listSafetyChecklist,
  recordComplicationAlert,
  listComplicationAlerts,
  acknowledgeComplicationAlert,
  resolveComplicationAlert,
};
