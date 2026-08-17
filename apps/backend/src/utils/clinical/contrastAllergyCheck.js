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
import { getUnifiedActiveAllergiesDetailed } from '../../services/clinical/allergySourceService.js';
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

const CONTRAST_STUDY_TEXT_FIELDS = [
  'test_name', 'testName', 'study', 'name', 'test', 'investigation',
  'procedure', 'body_part', 'bodyPart', 'clinical_indication', 'clinicalIndication',
  'reason', 'indication', 'notes', 'contrastStudyTextInputs',
];
const CONTRAST_STUDY_TEXT_PATTERN = /\b(?:cect|ceus|cem)\b|\bce[-\s]?(?:ct|mri)\b|\bcontrast[-\s]+enhanced\b|\bwith(?:\s+and\s+without)?\s+(?:(?:iv|oral)\s+)?contrast\b|\b(?:iv|oral|post|delayed)[-\s]?contrast\b|\bcontrast[-\s]+(?:ct|mri|study|phase)\b/i;

export function hasExplicitContrastStudySignal(data = {}) {
  return CONTRAST_STUDY_TEXT_FIELDS
    .map((field) => data?.[field])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => typeof value === 'string' && value.trim())
    .some((value) => CONTRAST_STUDY_TEXT_PATTERN.test(value));
}

// Modalities whose routine protocols administer contrast often enough that an
// OMITTED contrast_planned cannot be read as "no contrast": CT and MRI
// frequently run contrast phases and fluoroscopy's contrast (barium/
// gastrografin/iodinated) is usually the point of the study. For these, an
// order that does not explicitly negate contrast (contrast_planned: false) is
// treated as contrast-planned and ALWAYS screened — this is what makes the
// gate real for the shipped ordering clients, none of which sent
// contrast_planned at all (adversarial review, PR #875 R9). Plain radiography,
// ultrasound, and mammography stay opt-in (explicit flag or named agent):
// contrast-enhanced variants of those are rare specialist studies, and
// presuming contrast there would mark every plain chest film a contrast study
// and flood medication_safety_reviews with false findings.
export const CONTRAST_PRESUMED_MODALITIES = ['ct', 'mri', 'fluoroscopy'];

/** True when an omitted contrast flag on this modality presumes contrast. */
export function isContrastPresumedModality(modality) {
  return CONTRAST_PRESUMED_MODALITIES.includes(lower(modality));
}

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
    // lookup_failed distinguishes "no renal labs on file" from "the lab feed
    // could not be read" in the persisted screen evidence. Renal risk stays
    // advisory either way — it never blocks emergency imaging.
    return { evidenceFound: false, lookup_failed: true };
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
 *
 * Honest-evidence contract (PR #875 R10): the result records whether the
 * allergy lookup actually COMPLETED —
 *   status: 'completed' — patient resolved, every allergy store answered;
 *           'degraded'  — patient resolved but one or more stores failed;
 *           'failed'    — the patient could not be resolved or the whole
 *                          lookup threw.
 * A degraded/failed screen on a contrast-planned order FAILS CLOSED: it
 * carries a CONTRAST_ALLERGY_SCREEN_INCOMPLETE blocker, so the order is
 * blocked (409) unless the clinician supplies the same acknowledged override
 * used for a positive allergy hit — the dietary allergy_screen idiom
 * (kitchenService fail-closed exclusion). "We could not check" must never
 * persist as "nothing found".
 */
export async function validateRadiologyContrastSafety({ patientUid, modality, contrastAgent } = {}, { db = prisma } = {}) {
  let allergies = [];
  let sourcesFailed = [];
  let patientResolved = false;
  try {
    const detailed = await getUnifiedActiveAllergiesDetailed(db, { patientUid });
    allergies = detailed.allergies || [];
    sourcesFailed = detailed.sourcesFailed || [];
    patientResolved = detailed.patientResolved === true;
  } catch (err) {
    // getUnifiedActiveAllergiesDetailed contractually never throws, but the
    // fail-closed posture must not depend on that holding forever.
    sourcesFailed = ['unified_lookup'];
    logger.warn('Contrast allergy screen: unified allergy lookup failed — failing closed', {
      patient_uid: patientUid, error: err?.message,
    });
  }
  const status = !patientResolved
    ? 'failed'
    : (sourcesFailed.length > 0 ? 'degraded' : 'completed');

  const screen = screenContrastAllergies(allergies, { modality, contrastAgent });
  if (status !== 'completed') {
    screen.blockers.push({
      type: 'CONTRAST_ALLERGY_SCREEN_INCOMPLETE',
      medication: contrastAgent || `${screen.agent_class || 'contrast'} contrast media`,
      agent_class: screen.agent_class,
      screen_status: status,
      sources_failed: sourcesFailed,
      severity: 'UNKNOWN',
      message: status === 'failed'
        ? 'Contrast allergy screen FAILED: the patient\'s allergy record could not be resolved. Verify allergies manually; override with reason to proceed.'
        : `Contrast allergy screen DEGRADED: allergy source(s) ${sourcesFailed.join(', ')} could not be consulted, so a documented allergy may have been missed. Verify allergies manually; override with reason to proceed.`,
    });
  }

  const renal = await loadRenalContextByUid(patientUid, { db });
  const warnings = [...screen.warnings, ...deriveContrastRenalWarnings(renal, screen.agent_class)];
  return {
    safe: screen.blockers.length === 0,
    status,
    sources_failed: sourcesFailed,
    patient_resolved: patientResolved,
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
 * @param {object|null} overrideInput { reason }; caller-selected approver ids
 *   are ignored because approval attribution is an authentication fact.
 * @param {string|null} authenticatedActorUid the authenticated ordering actor.
 * @returns {{ reason: string, approvedBy: string|null }|null} normalized
 *   override when the screen is blocked and a valid override was supplied;
 *   null when the screen is safe. Throws AppError 409 when blocked without a
 *   valid override.
 */
export function assertContrastOrderAllowed(screen, overrideInput, authenticatedActorUid = null) {
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
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const actorUid = typeof authenticatedActorUid === 'string'
    ? authenticatedActorUid.trim()
    : '';
  if (!UUID_RE.test(actorUid)) {
    throw AppError.forbidden(
      'A same-tenant authenticated clinical actor must authorize the contrast override',
      'RADIOLOGY_CONTRAST_OVERRIDE_ACTOR_REQUIRED',
    );
  }
  return {
    reason,
    approvedBy: actorUid,
  };
}

export default {
  CONTRAST_PRESUMED_MODALITIES,
  hasExplicitContrastStudySignal,
  isContrastPresumedModality,
  resolveContrastAgentClass,
  screenContrastAllergies,
  deriveContrastRenalWarnings,
  loadRenalContextByUid,
  validateRadiologyContrastSafety,
  assertContrastOrderAllowed,
};
