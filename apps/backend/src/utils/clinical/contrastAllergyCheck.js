// src/utils/clinical/contrastAllergyCheck.js
//
// Contrast/allergy screening for radiology ordering (feature wave 1,
// migration 678). Radiology previously consulted NO allergy store at all —
// `patient_allergies` (and the three sibling stores unified by
// allergySourceService) gated prescriptions but never imaging, so a patient
// with a documented "iodinated contrast — anaphylaxis" allergy could be
// ordered a contrast CT with no warning anywhere.
//
// Deliberately idiomatic with utils/clinical/prescriptionSafetyCheck.js:
//  - allergies come from getUnifiedActiveAllergies (all four stores, deduped,
//    highest severity kept, never throws);
//  - matching is curated case-insensitive substring lists, not an invented
//    ontology — patient_allergies carries free-text `allergy_name` +
//    `severity` only, so token matching against attested agent/class terms is
//    the honest granularity;
//  - findings use the same { warnings, blockers } issue shape, and blocked
//    orders go through the same override-with-reason escape hatch the
//    prescription gate uses.
//
// One deliberate divergence: a documented allergy matching the PLANNED
// contrast class is ALWAYS a blocker, regardless of recorded severity rank.
// A prior reaction to the same contrast class is the dominant predictor of a
// repeat reaction (ACR Manual on Contrast Media), premedication/agent-switch
// decisions belong to the ordering clinician, and unlike multi-drug
// prescriptions there is exactly one agent in play — the acknowledged
// override path is the correct place for "we know, we premedicated".
// Cross-class matches (e.g. gadolinium allergy on an iodinated CT) stay
// warnings: the classes are not meaningfully cross-reactive but the history
// still warrants review.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getUnifiedActiveAllergies } from '../../services/clinical/allergySourceService.js';
import { AppError } from '../AppError.js';

// Agent-name aliases per contrast class — generic names plus the brand names
// seen on Indian formularies (platform is ABDM / India-first), matched
// case-insensitive substring, same approach as PAEDIATRIC_MG_PER_KG /
// ANTITHROMBOTIC_DRUGS in prescriptionSafetyCheck.
const CONTRAST_AGENTS = {
  iodinated: [
    'iohexol', 'omnipaque', 'iopamidol', 'isovue', 'iopamiro',
    'iodixanol', 'visipaque', 'iopromide', 'ultravist', 'ioversol',
    'optiray', 'iomeprol', 'iomeron', 'iobitridol', 'xenetix',
    'diatrizoate', 'gastrografin', 'urografin', 'trazograf',
  ],
  gadolinium: [
    'gadobutrol', 'gadavist', 'gadovist', 'gadoterate', 'dotarem',
    'clariscan', 'gadodiamide', 'omniscan', 'gadopentetate', 'magnevist',
    'gadoteridol', 'prohance', 'gadobenate', 'multihance',
    'gadoxetate', 'primovist', 'eovist',
  ],
  microbubble: [
    'sulfur hexafluoride', 'sulphur hexafluoride', 'lumason', 'sonovue',
    'perflutren', 'definity', 'optison',
  ],
};

// Class-level allergen terms. 'contrast' deliberately appears in every class:
// an allergy recorded as "contrast dye" / "CT contrast" / "contrast media"
// must hit whichever class is planned — that phrasing is exactly how the
// free-text stores (users.allergies, admission intake) record it.
const CONTRAST_CLASS_TERMS = {
  iodinated: ['contrast', 'iodinated', 'iodine', 'iodide', 'radiocontrast'],
  gadolinium: ['contrast', 'gadolinium', 'radiocontrast'],
  microbubble: ['contrast', 'radiocontrast'],
};

// Which contrast class a modality administers by default when the order does
// not name an agent. Mirrors VALID_MODALITIES in radiologyService.
const MODALITY_CONTRAST_CLASS = {
  ct: 'iodinated',
  xray: 'iodinated',
  fluoroscopy: 'iodinated',
  mammography: 'iodinated',
  mri: 'gadolinium',
  ultrasound: 'microbubble',
};

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Resolve the contrast class in play for an order. A named agent wins over
 * the modality default (e.g. gastrografin under fluoroscopy, or an MR
 * arthrogram ordered with an iodinated agent).
 * @returns {'iodinated'|'gadolinium'|'microbubble'|null}
 */
export function resolveContrastAgentClass(modality, contrastAgent) {
  const agent = lower(contrastAgent);
  if (agent) {
    for (const [klass, aliases] of Object.entries(CONTRAST_AGENTS)) {
      if (aliases.some((alias) => agent.includes(alias))) return klass;
    }
    if (agent.includes('gadolin')) return 'gadolinium';
    if (agent.includes('iod')) return 'iodinated';
  }
  return MODALITY_CONTRAST_CLASS[lower(modality)] || null;
}

function allergenMatchesClass(allergen, klass) {
  if (!klass) return false;
  const terms = CONTRAST_CLASS_TERMS[klass] || [];
  if (terms.some((term) => allergen.includes(term))) return true;
  return (CONTRAST_AGENTS[klass] || []).some((alias) => allergen.includes(alias));
}

/**
 * Pure screening core — no DB. Screens an allergy list (allergySourceService
 * shape: [{ allergen, severity, sources }]) against the planned contrast
 * class/agent. Exported for unit tests.
 *
 * @param {Array} allergies
 * @param {object} opts { modality, contrastAgent }
 * @returns {{ safe: boolean, agent_class: string|null, blockers: Array, warnings: Array }}
 */
export function screenContrastAllergies(allergies, { modality, contrastAgent } = {}) {
  const blockers = [];
  const warnings = [];
  const agentClass = resolveContrastAgentClass(modality, contrastAgent);
  const agent = lower(contrastAgent);

  for (const allergy of Array.isArray(allergies) ? allergies : []) {
    const allergen = lower(allergy?.allergen);
    if (!allergen) continue;

    // Direct agent-name match — same bidirectional substring rule the
    // prescription gate uses for medication ↔ allergen.
    const directAgentHit = Boolean(agent) && (allergen.includes(agent) || agent.includes(allergen));
    const plannedClassHit = allergenMatchesClass(allergen, agentClass);

    if (directAgentHit || plannedClassHit) {
      blockers.push({
        type: 'CONTRAST_ALLERGY_CONFLICT',
        medication: contrastAgent || `${agentClass || 'contrast'} contrast media`,
        agent_class: agentClass,
        allergy: allergy.allergen,
        severity: allergy.severity || 'UNKNOWN',
        sources: allergy.sources,
        message: `Patient has a documented allergy to "${allergy.allergen}" — planned ${agentClass || 'contrast'} contrast administration may cause a reaction. Override with reason (premedication/agent change) to proceed.`,
      });
      continue;
    }

    // Cross-class contrast history (e.g. gadolinium allergy, iodinated study).
    const otherClassHit = Object.keys(CONTRAST_CLASS_TERMS)
      .filter((klass) => klass !== agentClass)
      .find((klass) => allergenMatchesClass(allergen, klass));
    if (otherClassHit) {
      warnings.push({
        type: 'CONTRAST_CROSS_CLASS_ALLERGY',
        medication: contrastAgent || `${agentClass || 'contrast'} contrast media`,
        agent_class: agentClass,
        allergy: allergy.allergen,
        severity: allergy.severity || 'UNKNOWN',
        sources: allergy.sources,
        message: `Patient has a documented ${otherClassHit} contrast allergy ("${allergy.allergen}"). The planned ${agentClass || 'contrast'} class is not meaningfully cross-reactive, but review the reaction history before administering contrast.`,
      });
    }
  }

  return { safe: blockers.length === 0, agent_class: agentClass, blockers, warnings };
}

/**
 * Latest renal evidence for a patient by uid — same lab_results feed and
 * thresholds as loadRenalContext in prescriptionSafetyCheck (which is keyed
 * by users.id; radiology orders carry patient_uid, and lab_results is
 * uid-keyed, so this queries directly). Best-effort: any failure degrades to
 * { evidenceFound: false } rather than blocking an order flow.
 */
export async function loadRenalContextByUid(patientUid, { db = prisma } = {}) {
  if (!patientUid) return { evidenceFound: false };
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT test_name, test_code, value_numeric, value_text, unit, received_at
         FROM lab_results
        WHERE patient_uid = $1::uuid
          AND (
                test_name ILIKE '%egfr%' OR test_code ILIKE '%egfr%'
             OR test_name ILIKE '%creatinine%' OR test_code ILIKE '%creat%'
          )
        ORDER BY received_at DESC NULLS LAST
        LIMIT 8`,
      patientUid,
    );
    const egfr = rows
      .filter((r) => /egfr|e-gfr/i.test(`${r.test_name || ''} ${r.test_code || ''}`))
      .map((r) => Number(r.value_numeric ?? r.value_text))
      .find((v) => Number.isFinite(v));
    const creatinine = rows
      .filter((r) => /creatinine|creat/i.test(`${r.test_name || ''} ${r.test_code || ''}`))
      .map((r) => Number(r.value_numeric ?? r.value_text))
      .find((v) => Number.isFinite(v));
    return {
      evidenceFound: rows.length > 0,
      egfr: Number.isFinite(egfr) ? egfr : null,
      creatinine: Number.isFinite(creatinine) ? creatinine : null,
      impaired: (Number.isFinite(egfr) && egfr < 60) || (Number.isFinite(creatinine) && creatinine >= 1.5),
      severe: (Number.isFinite(egfr) && egfr < 30) || (Number.isFinite(creatinine) && creatinine >= 2.5),
    };
  } catch (err) {
    logger.warn('Contrast renal context lookup failed — skipping renal flag', {
      error: err?.message,
    });
    return { evidenceFound: false };
  }
}

/**
 * Pure renal-risk warning derivation — exported for unit tests. Renal risk is
 * advisory (warning), never a blocker: hydration protocols and agent choice
 * are clinical judgement, and eGFR gating hard-stops would block emergency
 * imaging.
 */
export function deriveContrastRenalWarnings(renal, agentClass) {
  const warnings = [];
  if (!renal || !renal.evidenceFound || !renal.impaired) return warnings;
  const risk = agentClass === 'gadolinium'
    ? 'nephrogenic systemic fibrosis risk with some gadolinium agents'
    : 'contrast-induced nephropathy risk';
  warnings.push({
    type: 'CONTRAST_RENAL_RISK',
    agent_class: agentClass,
    severity: renal.severe ? 'HIGH' : 'MODERATE',
    latest_egfr: renal.egfr ?? null,
    latest_creatinine: renal.creatinine ?? null,
    message: `Renal impairment on latest labs (eGFR ${renal.egfr ?? 'n/a'}, creatinine ${renal.creatinine ?? 'n/a'}) — ${risk}. Confirm hydration/agent plan before contrast administration.`,
  });
  return warnings;
}

/**
 * Full contrast safety screen for a radiology order: unified allergy fetch +
 * class/agent matching + renal-risk advisory. Same shape contract as
 * validatePrescriptionSafety: { safe, warnings, blockers } (plus agent_class,
 * renal, screened_at evidence for persistence into
 * radiology_orders.contrast_allergy_screen).
 */
export async function validateRadiologyContrastSafety({ patientUid, modality, contrastAgent } = {}, { db = prisma } = {}) {
  const allergies = await getUnifiedActiveAllergies(db, { patientUid });
  const screen = screenContrastAllergies(allergies, { modality, contrastAgent });
  const renal = await loadRenalContextByUid(patientUid, { db });
  const warnings = [...screen.warnings, ...deriveContrastRenalWarnings(renal, screen.agent_class)];
  return {
    safe: screen.safe,
    agent_class: screen.agent_class,
    blockers: screen.blockers,
    warnings,
    renal,
    screened_at: new Date().toISOString(),
  };
}

/**
 * Gate a blocked contrast order on an acknowledged override — pure, exported
 * for unit tests. Mirrors the prescription CDS gate in
 * ePrescriptionController.createPrescription: a non-empty reason of at least
 * 5 trimmed characters, recorded against a named user.
 *
 * @param {object} screen   result of validateRadiologyContrastSafety
 * @param {object|null} overrideInput { reason, approvedBy? } (accepts
 *   snake_case approved_by; contrast_override_reason handled by callers)
 * @param {string|null} fallbackActorUid used as the overriding user when the
 *   override payload does not name one (the ordering clinician).
 * @returns {{ reason: string, approvedBy: string|null }|null} normalized
 *   override when the screen is blocked and a valid override was supplied;
 *   null when the screen is safe. Throws AppError 409 when blocked without a
 *   valid override.
 */
export function assertContrastOrderAllowed(screen, overrideInput, fallbackActorUid = null) {
  if (!screen || screen.safe) return null;
  const reason = typeof overrideInput?.reason === 'string' ? overrideInput.reason.trim() : '';
  if (reason.length < 5) {
    throw AppError.conflict(
      'Radiology order blocked: patient has a documented contrast-relevant allergy',
      'RADIOLOGY_CONTRAST_ALLERGY_BLOCKED',
      {
        blockers: screen.blockers,
        warnings: screen.warnings,
        requiresOverride: true,
      },
    );
  }
  // The approver is persisted into a uuid column; a non-uuid client value
  // must degrade to the authenticated actor, not 500 on the cast.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const candidate = overrideInput.approvedBy || overrideInput.approved_by || null;
  return {
    reason,
    approvedBy: (typeof candidate === 'string' && UUID_RE.test(candidate.trim()))
      ? candidate.trim()
      : fallbackActorUid || null,
  };
}

export default {
  resolveContrastAgentClass,
  screenContrastAllergies,
  deriveContrastRenalWarnings,
  loadRenalContextByUid,
  validateRadiologyContrastSafety,
  assertContrastOrderAllowed,
};
