/**
 * Pediatric Dosing Safety AI.
 *
 * Evaluates pediatric prescription doses against hardcoded weight + age
 * based reference limits. Computes per-kg and absolute caps, derives a
 * safety band (safe / caution / unsafe / missing_data), and proposes
 * reviewer actions. Rules are authoritative; the AI layer only supplies
 * a short narrative. The service never writes, cancels, holds, or
 * modifies a prescription order — clinician/pharmacist signoff is
 * required before any action.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'pediatric_dosing_safety';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You support pediatric dose safety review. Rules are authoritative. Return JSON only and never hold, cancel, or modify a prescription order.',
  user_prompt_template: 'Summarize the pediatric dose safety evaluation. Do not invent per-kg limits or override the rules. Defer to the supplied reference.',
};

const AGE_BANDS = ['neonate', 'infant', 'toddler', 'child', 'adolescent', 'adult', 'unknown'];
const AGE_BAND_ORDER = {
  neonate: 0,
  infant: 1,
  toddler: 2,
  child: 3,
  adolescent: 4,
  adult: 5,
  unknown: 6,
};
const SAFETY_BANDS = new Set(['safe', 'caution', 'unsafe', 'missing_data', 'unknown']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const UNSAFE_MARGIN = 1.1;
const CAUTION_MARGIN = 0.95;

// Pediatric dose reference table. mg/kg values are conservative per-day (unless
// noted as per-dose). Hard caps are the absolute ceiling regardless of weight.
// min_age_band is the youngest band for which this reference is considered
// safe to apply directly; younger patients trigger an additional caution.
export const PEDIATRIC_DOSE_REFERENCES = [
  {
    pattern: /amoxicillin[-\s]*clavulan/i,
    display: 'Amoxicillin-clavulanate',
    max_per_kg_mg: 90,
    absolute_max_mg: 2000,
    min_age_band: 'infant',
    notes: 'Dosing expressed as amoxicillin component; avoid in neonates without specialist guidance.',
  },
  {
    pattern: /amoxicillin/i,
    display: 'Amoxicillin',
    max_per_kg_mg: 90,
    absolute_max_mg: 4000,
    min_age_band: 'neonate',
    notes: 'Higher mg/kg values (80-90) reserved for otitis media or severe infection.',
  },
  {
    pattern: /ceftriaxone/i,
    display: 'Ceftriaxone',
    max_per_kg_mg: 100,
    absolute_max_mg: 4000,
    min_age_band: 'infant',
    notes: 'Avoid concurrent calcium-containing IV solutions in neonates.',
  },
  {
    pattern: /cefuroxime/i,
    display: 'Cefuroxime',
    max_per_kg_mg: 30,
    absolute_max_mg: 1500,
    min_age_band: 'infant',
    notes: 'Oral suspension; higher mg/kg for severe infections.',
  },
  {
    pattern: /cephalexin|cefalexin/i,
    display: 'Cephalexin',
    max_per_kg_mg: 100,
    absolute_max_mg: 4000,
    min_age_band: 'infant',
    notes: 'Divided q6-q8h.',
  },
  {
    pattern: /azithromycin/i,
    display: 'Azithromycin',
    max_per_kg_mg: 12,
    absolute_max_mg: 500,
    min_age_band: 'infant',
    notes: 'Typical 5-day course 10 mg/kg on day 1 then 5 mg/kg daily.',
  },
  {
    pattern: /paracetamol|acetaminophen/i,
    display: 'Paracetamol (acetaminophen)',
    max_per_kg_mg: 75,
    absolute_max_mg: 4000,
    min_age_band: 'neonate',
    notes: 'Per-dose 15 mg/kg; daily max 75 mg/kg or 4 g, whichever is lower.',
  },
  {
    pattern: /ibuprofen/i,
    display: 'Ibuprofen',
    max_per_kg_mg: 40,
    absolute_max_mg: 2400,
    min_age_band: 'infant',
    notes: 'Avoid under 6 months. Per-dose 10 mg/kg q6-q8h.',
  },
  {
    pattern: /ondansetron/i,
    display: 'Ondansetron',
    max_per_kg_mg: 0.6,
    absolute_max_mg: 16,
    min_age_band: 'infant',
    notes: 'Per-dose 0.15 mg/kg, typical three doses per day, max 16 mg per dose.',
  },
  {
    pattern: /metronidazole/i,
    display: 'Metronidazole',
    max_per_kg_mg: 30,
    absolute_max_mg: 1500,
    min_age_band: 'neonate',
    notes: 'Adjust neonatal interval by postmenstrual age.',
  },
  {
    pattern: /vancomycin/i,
    display: 'Vancomycin',
    max_per_kg_mg: 60,
    absolute_max_mg: 4000,
    min_age_band: 'neonate',
    notes: 'Therapeutic drug monitoring required; renal-adjusted dosing.',
  },
  {
    pattern: /gentamicin/i,
    display: 'Gentamicin',
    max_per_kg_mg: 7.5,
    absolute_max_mg: 360,
    min_age_band: 'neonate',
    notes: 'Trough monitoring mandatory; renal risk.',
  },
  {
    pattern: /salbutamol|albuterol/i,
    display: 'Salbutamol (albuterol)',
    max_per_kg_mg: 0.6,
    absolute_max_mg: 32,
    min_age_band: 'infant',
    notes: 'Oral dosing; inhaled route has separate weight-independent limits.',
  },
];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return cleanText(value).toLowerCase();
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

function uniqueCitations(citations) {
  const seen = new Set();
  return asArray(citations).filter((citation) => {
    if (!citation) return false;
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function roundTo(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

export function classifyPediatricAgeBand(ageDays) {
  const n = toNullableNumber(ageDays);
  if (n === null || n < 0) return 'unknown';
  if (n <= 28) return 'neonate';
  if (n <= 365) return 'infant';
  if (n <= 1095) return 'toddler';
  if (n <= 4380) return 'child';
  if (n <= 6570) return 'adolescent';
  return 'adult';
}

export function calculateMaxDose({ weightKg = null, maxPerKgMg = null, absoluteMaxMg = null } = {}) {
  const w = toNullableNumber(weightKg);
  const perKg = toNullableNumber(maxPerKgMg);
  const abs = toNullableNumber(absoluteMaxMg);
  if (w === null && perKg === null && abs === null) return null;
  if (w === null && perKg !== null) return null;
  if (perKg === null && abs === null) return null;
  if (w === null && abs !== null && perKg === null) {
    return roundTo(abs, 2);
  }
  if (perKg !== null && abs !== null && w !== null) {
    return roundTo(Math.min(w * perKg, abs), 2);
  }
  if (perKg !== null && w !== null) {
    return roundTo(w * perKg, 2);
  }
  if (abs !== null) {
    return roundTo(abs, 2);
  }
  return null;
}

export function lookupPediatricReference(medicationName) {
  const name = cleanText(medicationName);
  if (!name) return null;
  for (const reference of PEDIATRIC_DOSE_REFERENCES) {
    if (reference.pattern.test(name)) return reference;
  }
  return null;
}

export function evaluateDoseSafety({
  prescribedDoseMg = null,
  calculatedMaxDoseMg = null,
  ageBand = 'unknown',
  ageDays = null,
  weightKg = null,
  medicationName = null,
  reference = null,
} = {}) {
  const prescribed = toNullableNumber(prescribedDoseMg);
  const maxDose = toNullableNumber(calculatedMaxDoseMg);
  const weight = toNullableNumber(weightKg);
  const age = toNullableNumber(ageDays);
  const displayName = cleanText(reference?.display || medicationName || 'medication');

  if (weight === null || age === null || prescribed === null || !reference) {
    const missing = [];
    if (weight === null) missing.push('weight_kg');
    if (age === null) missing.push('age_days');
    if (prescribed === null) missing.push('prescribed_dose_mg');
    if (!reference) missing.push('reference_entry');
    return {
      safety_band: 'missing_data',
      variance_pct: null,
      rationale: `Cannot evaluate pediatric dose safety — missing: ${missing.join(', ') || 'required inputs'}.`,
      suggested_actions: [
        'Confirm current weight and date of birth in the chart.',
        'Verify the prescribed dose in mg and resubmit for pediatric dose safety review.',
      ],
    };
  }

  let variancePct = null;
  if (maxDose !== null && maxDose > 0) {
    variancePct = roundTo(((prescribed / maxDose) - 1) * 100, 2);
  }

  if (ageBand === 'adult') {
    return {
      safety_band: 'safe',
      variance_pct: variancePct,
      rationale: `Patient age band is adult (${age} days); pediatric dose safety rules do not apply. Review with standard adult dosing references.`,
      suggested_actions: ['No pediatric-specific action; verify adult dosing separately.'],
    };
  }

  const tooYoung = reference.min_age_band
    && AGE_BAND_ORDER[ageBand] !== undefined
    && AGE_BAND_ORDER[reference.min_age_band] !== undefined
    && AGE_BAND_ORDER[ageBand] < AGE_BAND_ORDER[reference.min_age_band];

  let safetyBand = 'safe';
  let rationale = '';

  if (maxDose === null || maxDose <= 0) {
    safetyBand = 'caution';
    rationale = `Reference limits for ${displayName} could not produce a weight-based ceiling; verify dose manually.`;
  } else if (prescribed > maxDose * UNSAFE_MARGIN) {
    safetyBand = 'unsafe';
    rationale = `Prescribed dose ${prescribed} mg exceeds the calculated maximum ${maxDose} mg for ${displayName} by more than ${Math.round((UNSAFE_MARGIN - 1) * 100)}% (variance ${variancePct}%).`;
  } else if (prescribed > maxDose * CAUTION_MARGIN) {
    safetyBand = 'caution';
    rationale = `Prescribed dose ${prescribed} mg is within ${Math.round((1 - CAUTION_MARGIN) * 100)}% of the calculated maximum ${maxDose} mg for ${displayName} (variance ${variancePct}%).`;
  } else {
    rationale = `Prescribed dose ${prescribed} mg is within the calculated maximum ${maxDose} mg for ${displayName} (variance ${variancePct}%).`;
  }

  if (tooYoung) {
    if (safetyBand === 'safe') safetyBand = 'caution';
    rationale = `${rationale} Patient age band (${ageBand}) is younger than the reference minimum (${reference.min_age_band}); confirm pediatric specialist guidance before administration.`;
  }

  let suggestedActions;
  if (safetyBand === 'unsafe') {
    suggestedActions = [
      'Hold order; consult pediatric pharmacist; recalculate using weight.',
      'Confirm weight and date of birth are current in the chart.',
      'Document clinical rationale if deliberately exceeding the per-kg maximum.',
    ];
  } else if (safetyBand === 'caution') {
    suggestedActions = [
      'Verify dose and frequency; confirm weight is current.',
      'Cross-check with pediatric reference for this indication before administration.',
    ];
  } else {
    suggestedActions = ['No immediate action required.'];
  }

  return {
    safety_band: safetyBand,
    variance_pct: variancePct,
    rationale,
    suggested_actions: suggestedActions,
  };
}

async function loadPatientContext(patientUid) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT u.uid,
              u.name,
              u.birthday,
              CASE WHEN u.birthday IS NULL THEN NULL
                   ELSE EXTRACT(DAY FROM (NOW() - u.birthday::timestamp))::int
              END AS age_days,
              (
                SELECT v.weight
                FROM patient_vitals v
                WHERE v.patient_uid = u.uid
                  AND v.weight IS NOT NULL
                ORDER BY v.recorded_at DESC
                LIMIT 1
              ) AS weight_kg
       FROM users u
       WHERE u.uid = $1::uuid
       LIMIT 1`,
      patientUid
    );
    const row = rows[0];
    if (!row) return { uid: patientUid, name: null, age_days: null, weight_kg: null };
    return {
      uid: row.uid,
      name: row.name || null,
      birthday: row.birthday || null,
      age_days: row.age_days !== null && row.age_days !== undefined ? toNumber(row.age_days, null) : null,
      weight_kg: row.weight_kg !== null && row.weight_kg !== undefined ? toNumber(row.weight_kg, null) : null,
    };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return { uid: patientUid, name: null, age_days: null, weight_kg: null };
    }
    logger.warn('Pediatric dose safety: patient context load failed', { error: err.message });
    return { uid: patientUid, name: null, age_days: null, weight_kg: null };
  }
}

async function loadPrescription(prescriptionId) {
  if (!prescriptionId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, medication_name, dosage, frequency, route, status, issued_at
       FROM prescriptions
       WHERE id = $1
       LIMIT 1`,
      prescriptionId
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.warn('Pediatric dose safety: prescription load failed', { error: err.message });
    return null;
  }
}

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
    return rows[0] || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  admissionId = null,
  patientUid = null,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  prompt,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7, $8, $9, $10,
               $11::jsonb, $12::jsonb, $13::jsonb, $14::uuid, $15, $16, $17,
               $18, $19, $20, $21, $22::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      patientUid,
      admissionId,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      requestedBy,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? usage.estimated_cost_minor ?? 0,
      usage.latency_ms || aiResult?.latencyMs || null,
      usage.provider_request_id || aiResult?.requestId || null,
      usage.finish_reason || aiResult?.finishReason || null,
      JSON.stringify(metadata || {})
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Pediatric dose safety: generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, admissionId, patientUid, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      admissionId,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['DOCTOR', 'PHARMACIST', 'PHARMACY_STAFF', 'ADMIN'],
        source: 'pediatric_dosing_safety',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Pediatric dose safety: review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function buildSafetyFlags({ evaluation, citations }) {
  const flags = [];
  if (evaluation.safety_band === 'unsafe') {
    flags.push({
      severity: 'critical',
      code: 'PEDIATRIC_DOSE_UNSAFE',
      message: 'Prescribed dose exceeds the calculated pediatric maximum; clinician/pharmacist review required.',
    });
  }
  if (evaluation.safety_band === 'caution') {
    flags.push({
      severity: 'high',
      code: 'PEDIATRIC_DOSE_CAUTION',
      message: 'Prescribed dose is close to or above pediatric limits; verify before administration.',
    });
  }
  if (evaluation.safety_band === 'missing_data') {
    flags.push({
      severity: 'medium',
      code: 'PEDIATRIC_DOSE_MISSING_DATA',
      message: 'Required inputs (weight, age, prescribed dose, or reference) are missing; cannot evaluate dose safety.',
    });
  }
  if (!citations || !citations.length) {
    flags.push({
      severity: 'medium',
      code: 'PEDIATRIC_DOSE_NO_CITATIONS',
      message: 'Pediatric dose evaluation has no source citations.',
    });
  }
  return flags;
}

function buildNarrativePrompt({ prompt, draft, patient, reference }) {
  return `${prompt.user_prompt_template}\n\n${JSON.stringify({
    rules_authoritative: true,
    decision_support_only: true,
    patient: {
      uid: patient?.uid || null,
      age_days: patient?.age_days ?? null,
      age_band: draft.age_band,
      weight_kg: patient?.weight_kg ?? null,
    },
    prescription: {
      medication_name: draft.medication_name,
      prescribed_dose_mg: draft.prescribed_dose_mg,
      prescribed_route: draft.prescribed_route,
      prescribed_frequency: draft.prescribed_frequency,
    },
    reference: reference ? {
      display: reference.display,
      max_per_kg_mg: reference.max_per_kg_mg,
      absolute_max_mg: reference.absolute_max_mg,
      min_age_band: reference.min_age_band,
      notes: reference.notes,
    } : null,
    rule_based_evaluation: {
      safety_band: draft.safety_band,
      calculated_max_dose_mg: draft.calculated_max_dose_mg,
      variance_pct: draft.variance_pct,
      rationale: draft.rationale,
      suggested_actions: draft.suggested_actions,
    },
  })}`;
}

function normalizeAiDraft(parsed, fallbackDraft) {
  if (!parsed || typeof parsed !== 'object') return fallbackDraft;
  return {
    ...fallbackDraft,
    // Narrative is decorative only; do NOT let AI override safety_band or numeric fields.
    summary: cleanText(parsed.summary) || fallbackDraft.summary,
    rationale: cleanText(parsed.rationale) || fallbackDraft.rationale,
    source_citations: uniqueCitations([
      ...asArray(fallbackDraft.source_citations),
      ...asArray(parsed.source_citations),
    ]),
  };
}

export async function evaluatePrescriptionSafety({
  req = null,
  prescriptionId = null,
  patientUid,
  admissionId = null,
  medicationName,
  prescribedDoseMg,
  prescribedRoute = null,
  prescribedFrequency = null,
  ageDaysOverride = null,
  weightKgOverride = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  if (!patientUid || !cleanText(patientUid)) {
    throw AppError.badRequest('patient_uid is required');
  }
  const cleanedMedication = cleanText(medicationName);
  if (!cleanedMedication) {
    throw AppError.badRequest('medication_name is required');
  }
  const prescribedDose = toNullableNumber(prescribedDoseMg);
  if (prescribedDose === null || prescribedDose <= 0) {
    throw AppError.badRequest('prescribed_dose_mg must be a positive number');
  }
  const safePrescriptionId = prescriptionId ? optionalInt(prescriptionId, 'prescription_id') : null;
  const safeAdmissionId = admissionId ? optionalInt(admissionId, 'admission_id') : null;

  const prescription = await loadPrescription(safePrescriptionId);
  const patient = await loadPatientContext(patientUid);

  const ageDays = ageDaysOverride !== null && ageDaysOverride !== undefined
    ? toNullableNumber(ageDaysOverride)
    : patient.age_days;
  const weightKg = weightKgOverride !== null && weightKgOverride !== undefined
    ? toNullableNumber(weightKgOverride)
    : patient.weight_kg;

  const ageBand = classifyPediatricAgeBand(ageDays);
  const reference = lookupPediatricReference(cleanedMedication);
  const calculatedMaxDoseMg = reference
    ? calculateMaxDose({
      weightKg,
      maxPerKgMg: reference.max_per_kg_mg,
      absoluteMaxMg: reference.absolute_max_mg,
    })
    : null;

  const evaluation = evaluateDoseSafety({
    prescribedDoseMg: prescribedDose,
    calculatedMaxDoseMg,
    ageBand,
    ageDays,
    weightKg,
    medicationName: cleanedMedication,
    reference,
  });

  const citations = [];
  citations.push({
    source_type: 'patient',
    source_id: String(patientUid),
    label: patient.name ? `Patient ${patient.name}` : 'Patient record',
    timestamp: null,
  });
  if (safePrescriptionId) {
    citations.push({
      source_type: 'prescription',
      source_id: String(safePrescriptionId),
      label: prescription?.medication_name
        ? `Prescription — ${prescription.medication_name}`
        : 'Prescription order',
      timestamp: prescription?.issued_at || null,
    });
  }
  if (reference) {
    citations.push({
      source_type: 'pediatric_dose_reference',
      source_id: reference.display.toLowerCase().replace(/\s+/g, '_'),
      label: `Pediatric reference — ${reference.display}`,
      timestamp: null,
    });
  }
  const uniqueCits = uniqueCitations(citations);

  const fallbackDraft = {
    module_key: MODULE_KEY,
    patient_uid: patientUid,
    admission_id: safeAdmissionId,
    prescription_id: safePrescriptionId,
    medication_name: cleanedMedication,
    prescribed_dose_mg: prescribedDose,
    prescribed_route: prescribedRoute ? cleanText(prescribedRoute) : null,
    prescribed_frequency: prescribedFrequency ? cleanText(prescribedFrequency) : null,
    age_days: ageDays,
    age_band: ageBand,
    weight_kg: weightKg,
    reference: reference ? {
      display: reference.display,
      max_per_kg_mg: reference.max_per_kg_mg,
      absolute_max_mg: reference.absolute_max_mg,
      min_age_band: reference.min_age_band,
      notes: reference.notes,
    } : null,
    max_dose_per_kg_mg: reference?.max_per_kg_mg ?? null,
    absolute_max_dose_mg: reference?.absolute_max_mg ?? null,
    calculated_max_dose_mg: calculatedMaxDoseMg,
    variance_pct: evaluation.variance_pct,
    safety_band: evaluation.safety_band,
    rationale: evaluation.rationale,
    suggested_actions: evaluation.suggested_actions,
    summary: `${cleanedMedication}: ${evaluation.safety_band} (${
      calculatedMaxDoseMg !== null ? `max ${calculatedMaxDoseMg} mg` : 'no calculated max'
    }).`,
    source_citations: uniqueCits,
    safety_flags: [],
    rules_authoritative: true,
    decision_support_only: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = { usedAi: false, provider: 'template', model: null, text: '', usage: {} };
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: buildNarrativePrompt({ prompt, draft: fallbackDraft, patient, reference }),
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
  } catch (err) {
    logger.warn('Pediatric dose safety: AI narrative failed (non-fatal)', { error: err.message });
  }
  const parsed = safeJsonParse(aiResult?.text, {});
  const draft = normalizeAiDraft(parsed, fallbackDraft);

  const safetyFlags = [
    ...buildSafetyFlags({ evaluation, citations: uniqueCits }),
    ...asArray(draft.safety_flags),
    ...runOutputDefenses({
      draft,
      module,
      context: {
        patient: { uid: patient.uid, age_days: patient.age_days, weight_kg: patient.weight_kg },
        prescription: {
          id: safePrescriptionId,
          medication_name: cleanedMedication,
        },
        reference: reference || null,
      },
      citations: uniqueCits,
    }),
  ];
  draft.safety_flags = safetyFlags;

  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      patient_uid: patientUid,
      prescription_id: safePrescriptionId,
      medication: normalizedText(cleanedMedication),
      prescribed_dose_mg: prescribedDose,
      age_days: ageDays,
      weight_kg: weightKg,
      reference_key: reference?.display || null,
    }),
    draft,
    citations: uniqueCits,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      admission_id: safeAdmissionId,
      tenant_region: req?.tenant?.region || null,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  const safeBand = SAFETY_BANDS.has(draft.safety_band) ? draft.safety_band : 'unknown';
  const safeAgeBand = AGE_BANDS.includes(draft.age_band) ? draft.age_band : 'unknown';

  let checkRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_pediatric_dose_checks
         (tenant_id, prescription_id, patient_uid, admission_id, generation_id,
          age_days, weight_kg, age_band, medication_name,
          prescribed_dose_mg, prescribed_route, prescribed_frequency,
          max_dose_per_kg_mg, absolute_max_dose_mg, calculated_max_dose_mg,
          variance_pct, safety_band, rationale, suggested_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21::jsonb,
               'pending', $22::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, prescription_id, patient_uid, admission_id,
                 generation_id, age_days, weight_kg, age_band, medication_name,
                 prescribed_dose_mg, prescribed_route, prescribed_frequency,
                 max_dose_per_kg_mg, absolute_max_dose_mg, calculated_max_dose_mg,
                 variance_pct, safety_band, rationale, suggested_actions,
                 source_citations, safety_flags, reviewer_decision, reviewed_by,
                 reviewed_at, reviewer_note, metadata, created_at, updated_at`,
      tenantId,
      safePrescriptionId,
      patientUid,
      safeAdmissionId,
      generation?.id || null,
      ageDays,
      weightKg,
      safeAgeBand,
      cleanedMedication,
      prescribedDose,
      prescribedRoute ? cleanText(prescribedRoute) : null,
      prescribedFrequency ? cleanText(prescribedFrequency) : null,
      reference?.max_per_kg_mg ?? null,
      reference?.absolute_max_mg ?? null,
      calculatedMaxDoseMg,
      evaluation.variance_pct,
      safeBand,
      evaluation.rationale,
      JSON.stringify(evaluation.suggested_actions || []),
      JSON.stringify(uniqueCits),
      JSON.stringify(safetyFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult?.usedAi),
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    checkRow = rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return {
      check_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: uniqueCits,
      safety_flags: safetyFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_pediatric_dose_checks_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    admissionId: safeAdmissionId,
    patientUid,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.pediatric_dose_evaluated',
    aggregateType: 'clinical_ai_pediatric_dose_check',
    aggregateId: checkRow?.id || generation?.id || safePrescriptionId,
    patientUid,
    payload: {
      tenant_id: tenantId,
      prescription_id: safePrescriptionId,
      check_id: checkRow?.id || null,
      generation_id: generation?.id || null,
      medication_name: cleanedMedication,
      safety_band: safeBand,
      age_band: safeAgeBand,
      variance_pct: evaluation.variance_pct,
    },
  });

  return {
    check_id: checkRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    check: checkRow,
    source_citations: uniqueCits,
    safety_flags: safetyFlags,
    safety_band: safeBand,
    calculated_max_dose_mg: calculatedMaxDoseMg,
    variance_pct: evaluation.variance_pct,
    age_band: safeAgeBand,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || checkRow?.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listPediatricDoseChecks({
  tenantId = null,
  patientUid = null,
  admissionId = null,
  safetyBand = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const normalizedBand = safetyBand && SAFETY_BANDS.has(cleanText(safetyBand).toLowerCase())
    ? cleanText(safetyBand).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT c.id, c.tenant_id, c.prescription_id, c.patient_uid,
              u.name AS patient_name, c.admission_id, c.generation_id,
              c.age_days, c.weight_kg, c.age_band, c.medication_name,
              c.prescribed_dose_mg, c.prescribed_route, c.prescribed_frequency,
              c.max_dose_per_kg_mg, c.absolute_max_dose_mg, c.calculated_max_dose_mg,
              c.variance_pct, c.safety_band, c.rationale, c.suggested_actions,
              c.source_citations, c.safety_flags, c.reviewer_decision,
              c.reviewed_by, c.reviewed_at, c.reviewer_note, c.metadata,
              c.created_at, c.updated_at
       FROM clinical_ai_pediatric_dose_checks c
       LEFT JOIN users u ON u.uid = c.patient_uid
       WHERE c.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR c.patient_uid = $2::uuid)
         AND ($3::int IS NULL OR c.admission_id = $3)
         AND ($4::text IS NULL OR c.safety_band = $4)
         AND ($5::text IS NULL OR c.reviewer_decision = $5)
       ORDER BY
         CASE c.safety_band
           WHEN 'unsafe' THEN 0
           WHEN 'caution' THEN 1
           WHEN 'missing_data' THEN 2
           WHEN 'safe' THEN 3
           ELSE 4
         END,
         c.created_at DESC
       LIMIT $6`,
      tid,
      patientUid || null,
      aid,
      normalizedBand,
      normalizedDecision,
      safeLimit
    );
    const normalized = rows.map((row) => ({
      ...row,
      age_days: row.age_days !== null && row.age_days !== undefined ? toNumber(row.age_days, null) : null,
      weight_kg: row.weight_kg !== null && row.weight_kg !== undefined ? toNumber(row.weight_kg, null) : null,
      prescribed_dose_mg: row.prescribed_dose_mg !== null && row.prescribed_dose_mg !== undefined
        ? toNumber(row.prescribed_dose_mg, null)
        : null,
      max_dose_per_kg_mg: row.max_dose_per_kg_mg !== null && row.max_dose_per_kg_mg !== undefined
        ? toNumber(row.max_dose_per_kg_mg, null)
        : null,
      absolute_max_dose_mg: row.absolute_max_dose_mg !== null && row.absolute_max_dose_mg !== undefined
        ? toNumber(row.absolute_max_dose_mg, null)
        : null,
      calculated_max_dose_mg: row.calculated_max_dose_mg !== null && row.calculated_max_dose_mg !== undefined
        ? toNumber(row.calculated_max_dose_mg, null)
        : null,
      variance_pct: row.variance_pct !== null && row.variance_pct !== undefined
        ? toNumber(row.variance_pct, null)
        : null,
    }));
    return { checks: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { checks: [], count: 0 };
    throw err;
  }
}

export async function decidePediatricDoseCheck({
  tenantId = null,
  checkId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_pediatric_dose_checks
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, prescription_id, patient_uid, admission_id, generation_id,
               medication_name, safety_band, calculated_max_dose_mg,
               variance_pct, reviewer_decision, reviewed_by, reviewed_at,
               reviewer_note`,
    optionalInt(checkId, 'check_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Pediatric dose check not found');
  const row = rows[0];
  return {
    ...row,
    calculated_max_dose_mg: row.calculated_max_dose_mg !== null && row.calculated_max_dose_mg !== undefined
      ? toNumber(row.calculated_max_dose_mg, null)
      : null,
    variance_pct: row.variance_pct !== null && row.variance_pct !== undefined
      ? toNumber(row.variance_pct, null)
      : null,
  };
}

export default {
  PEDIATRIC_DOSE_REFERENCES,
  calculateMaxDose,
  classifyPediatricAgeBand,
  decidePediatricDoseCheck,
  evaluateDoseSafety,
  evaluatePrescriptionSafety,
  listPediatricDoseChecks,
  lookupPediatricReference,
};
