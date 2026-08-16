// src/services/emr/orderEntryService.js
// CPOE (Computerized Provider Order Entry) service — typed Prisma ORM.
// Batch 56: migrated from `prisma.$queryRawUnsafe` to typed Prisma for the
// `clinical_orders` model.
//
// Order-set storage lives in `clinical_order_sets` + `clinical_order_set_items`
// (migration 156, seeded chest-pain bundle in 187). The earlier `order_sets`
// shim never existed in production — every `applyOrderSet` / `getOrderSets`
// / `createOrderSet` call 500ed because the table is missing. The three
// helpers now read from the real tables and translate item rows into
// createOrder-shaped payloads while keeping the legacy
// `{ id, name, description, category, orders, is_active }` response shape
// so existing callers (mobile + admin) keep working unchanged. Findings:
//   2026-05-09-emergency-walk-in-doctor-order-sets-500
//   2026-05-10-emergency-walk-in-doctor-chest-pain-orderset-500
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import {
  validatePrescriptionSafety,
  checkAntithromboticInteractions,
} from '../../utils/clinical/prescriptionSafetyCheck.js';
import {
  assertContrastOrderAllowed,
  hasExplicitContrastStudySignal,
  isContrastPresumedModality,
  validateRadiologyContrastSafety,
} from '../../utils/clinical/contrastAllergyCheck.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default
import { queueClinicalAlertFanout } from '../../utils/notifications/clinicalAlertFanout.js';
import { scheduleMedications } from '../clinical/marService.js';
import { recordFirstDrugChartEntry } from '../clinical/drugChartSlaService.js';
import { createWardIndentForClinicalMedicationOrder } from '../ipd/ipdSupportService.js';
import { createInvestigationOrder } from '../investigation/orderService.js';
import { populateAuthorshipCareTeam } from '../security/careTeamPopulationService.js';
import {
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
  recordMedicationSafetyReviews,
} from '../clinical/canonicalClinicalPlatformService.js';
import { safeCanonical } from '../clinical/canonicalOperationalBridgeService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { publishOpChildResourceLinkedFromEncounterTx } from '../appointment/opChildResourceEventService.js';
import { enrichMedicationsWithComposition } from '../pharmacy/compositionIdentityService.js';
import { recordBrandSubstitutionAudit } from '../pharmacy/compositionSubstitutionAudit.js';
import { isContentStudioEnabled } from './orderSetContentStudioSettingsService.js';


// ===================================================================
// Order Entry (CPOE) Service
// ===================================================================

// `ecg`, `radiology`, and `procedure` are first-class types, not aliases
// to `investigation`: collapsing them loses the machine-readable
// differentiation the receiving department's worklist needs — a STAT ECG
// (door-to-balloon clock) must not land in the same bucket as a routine
// blood test. Finding: 2026-05-09-emergency-walk-in-doctor-no-ecg-order-type.
export const VALID_ORDER_TYPES = ['medication', 'investigation', 'nursing', 'diet', 'activity', 'consultation', 'ecg', 'radiology', 'procedure'];
const VALID_PRIORITIES = ['stat', 'urgent', 'routine', 'prn'];

// Structured medication route (migration 229). Maps the free-text
// spellings clinicians actually write onto a canonical value so the MAR
// / pharmacy can group orders by route instead of treating "IV" /
// "i.v." / "Intravenous" as three different things. Keys are lower-cased
// at lookup; values are the canonical forms. Anything not mapped is
// passed through trimmed (still lands in the typed column) — strict
// rejection would regress applyOrderSet, whose seeded payloads carry
// historical free-text routes like "PO chewed".
// Finding 2026-05-08-inpatient-admission-doctor-no-route-or-imaging-typing.
const ROUTE_SYNONYMS = {
  iv: 'IV', 'i.v.': 'IV', intravenous: 'IV',
  po: 'PO', 'p.o.': 'PO', oral: 'PO', 'by mouth': 'PO', 'per oral': 'PO',
  im: 'IM', 'i.m.': 'IM', intramuscular: 'IM',
  sc: 'SC', 'sub-cut': 'SC', subcut: 'SC', subcutaneous: 'SC',
  sl: 'SL', sublingual: 'SL',
  pr: 'PR', rectal: 'PR', 'per rectum': 'PR',
  ng: 'NG', nasogastric: 'NG', 'ng tube': 'NG',
  topical: 'topical', top: 'topical',
  inhaled: 'inhaled', inhalation: 'inhaled', nebulised: 'inhaled', nebulized: 'inhaled', neb: 'inhaled',
  transdermal: 'transdermal', patch: 'transdermal',
};

// Doctor-facing convention is "lab" for blood/pathology work — map the
// colloquial form down to the persisted `investigation` enum so
// clinicians (and any external integration emitting the human label)
// don't 400-loop on a CBC order during an OPD/IPD round. `radiology` is
// now a first-class order_type (see VALID_ORDER_TYPES above), so it is
// no longer aliased away; `imaging` resolves to it. Findings:
//   2026-05-09-walk-in-opd-doctor-lab-order-type-mismatch
//   2026-05-09-emergency-walk-in-doctor-no-ecg-order-type
const ORDER_TYPE_ALIASES = {
  lab: 'investigation',
  laboratory: 'investigation',
  pathology: 'investigation',
  diagnostic: 'investigation',
  imaging: 'radiology',
  med: 'medication',
  medication_order: 'medication',
  consult: 'consultation',
};

// Columns returned by the pre-batch-56 `RETURNING` clauses. Mirrored as
// a Prisma `select` so the public response shape is unchanged. The full
// shape covers every column any state-transition mutator returned —
// individual mutators all returned the union of fields they touched plus
// the base order columns; one shared select keeps the response stable.
const ORDER_RETURNING_SELECT = {
  id: true,
  order_number: true,
  encounter_id: true,
  patient_uid: true,
  order_type: true,
  priority: true,
  details: true,
  route: true,
  status: true,
  ordered_by: true,
  verified_by: true,
  verified_at: true,
  completed_by: true,
  completed_at: true,
  cancelled_by: true,
  cancel_reason: true,
  start_date: true,
  end_date: true,
  notes: true,
  created_at: true,
  updated_at: true,
  tenant_id: true,
};

const CLINICAL_ORDER_PRIORITY_TO_INVESTIGATION = {
  stat: 'STAT',
  urgent: 'URGENT',
  routine: 'NORMAL',
  prn: 'NORMAL',
};

// ── Staff CPOE → radiology worklist bridge (PR #875 follow-up) ─────────────
//
// CPOE `order_type: 'radiology'` orders used to live ONLY in clinical_orders:
// they never reached radiology_orders (the worklist radiologyService.getWorklist
// reads) and never ran the migration-678 contrast/allergy screening gate — the
// exact R9 "inert gate" disconnect recorded in #875's PR body. The bridge has
// two halves, mirroring how medication (CDS pre-check + post-commit MAR) and
// investigation (post-commit lab-worklist materialization) orders already work:
//
//   1. Pre-commit (createOrder / createOrdersBulk Phase 0):
//      runRadiologyContrastGate derives the modality server-side, derives the
//      contrast intent exactly like radiologyService.parseContrastIntent
//      (CT/MRI/fluoro presumed contrast-planned, explicit-negation only), runs
//      validateRadiologyContrastSafety, and applies the same acknowledged
//      override gate (409 RADIOLOGY_CONTRAST_ALLERGY_BLOCKED without one).
//      Fail-closed: a radiology order whose modality cannot be resolved is a
//      400 — an unresolvable modality would silently skip the screen, which is
//      how the gate was inert the first time.
//   2. Post-commit (dispatchOrderIntegrations, awaited like investigations):
//      materializeRadiologyOrderForClinicalOrder creates the radiology_orders
//      worklist row through radiologyService.createOrder — which re-runs the
//      same screen inside its own tenant transaction and persists the screen
//      evidence + safety reviews + canonical events on the radiology detail
//      row. Failure escalates durably via escalateOrderIntegrationFailure
//      (stage 'integration_dispatch'), never silently.
//
// Modality vocabulary mirrors radiologyService (VALID_MODALITIES +
// MODALITY_ALIASES); free-text inference covers the payloads real clients send
// (staff CPOE composer + order sets carry only test_name, e.g. "CT Brain
// Plain", "X-Ray Chest PA" — same conservatism as TEST_TYPE_INFERENCE below).
const RADIOLOGY_MODALITIES = ['xray', 'ct', 'mri', 'ultrasound', 'mammography', 'fluoroscopy'];
const RADIOLOGY_MODALITY_ALIASES = {
  usg: 'ultrasound', us: 'ultrasound', sonography: 'ultrasound',
  'x-ray': 'xray', xr: 'xray',
  mr: 'mri',
  mammo: 'mammography', mg: 'mammography',
  fluoro: 'fluoroscopy',
};
// Ordered: specific modalities before the generic x-ray patterns so
// "CT Chest" never resolves as a chest film. The `ct[_\-\s]` variant matches
// code-style names ("CT_HEAD", "CT-CHEST") whose underscore defeats \b.
const RADIOLOGY_MODALITY_TEXT_PATTERNS = [
  ['ct', /\bct\b|\bct[_-]|\b(?:cect|ncct|hrct)\b|computed\s+tomograph/i],
  ['mri', /\bmri?\b|\bmri[_-]|\b(?:mrcp|mra)\b|magnetic\s+resonance/i],
  ['fluoroscopy', /fluoroscop|\bfluoro\b|barium\s+(?:swallow|meal|enema)|\bhsg\b/i],
  ['mammography', /mammogra|\bmammo\b/i],
  ['ultrasound', /ultrasound|ultrasonograph|sonograph|doppler|\busg?\b|\bus[_-]/i],
  ['xray', /x[\s._-]?ray|\bcxr\b|\baxr\b|\bkub\b|radiograph|\bxr\b|\bxr[_-]|chest\s+film/i],
];

/**
 * Resolve the radiology modality for a CPOE order's details. Explicit fields
 * win (details.modality / imaging_modality / study_type, alias-normalised);
 * otherwise the test-name-ish fields are scanned for modality keywords.
 * Exported for unit tests. Returns one of RADIOLOGY_MODALITIES or null.
 */
export function resolveRadiologyModality(details = {}) {
  const explicit = firstText(details.modality, details.imaging_modality, details.study_type);
  if (explicit) {
    const key = explicit.toLowerCase().replace(/\s+/g, '_');
    if (RADIOLOGY_MODALITIES.includes(key)) return key;
    if (RADIOLOGY_MODALITY_ALIASES[key]) return RADIOLOGY_MODALITY_ALIASES[key];
  }
  const haystack = [
    explicit,
    firstText(details.test_name, details.study, details.name, details.test, details.investigation, details.procedure),
  ].filter(Boolean).join(' ');
  if (!haystack) return null;
  for (const [modality, regex] of RADIOLOGY_MODALITY_TEXT_PATTERNS) {
    if (regex.test(haystack)) return modality;
  }
  return null;
}

/**
 * Derive the radiologyService.createOrder-shaped fields from a CPOE radiology
 * order's details. Pure; exported for unit tests (precedent:
 * buildMarEntryFromOrderDetails).
 */
export function resolveRadiologyOrderFields(details = {}, { notes = null } = {}) {
  const testName = firstText(
    details.test_name, details.study, details.name, details.test,
    details.investigation, details.procedure,
  );
  return {
    modality: resolveRadiologyModality(details),
    bodyPart: firstText(details.body_part, details.bodyPart, details.region, details.area) || testName,
    clinicalIndication: firstText(
      details.reason, details.clinical_indication, details.indication, notes,
    ) || testName,
    testName,
  };
}

// Contrast intent for a CPOE radiology order — DERIVED SERVER-SIDE, the exact
// semantics of radiologyService.parseContrastIntent (PR #875 R9: a gate that
// waits for a client opt-in field is inert): explicit true / named agent →
// planned; explicit false → negated (agent alongside is a 400 contradiction);
// omitted → presumed for CT/MRI/fluoroscopy. Exported for unit tests.
export function deriveCpoeContrastIntent(details = {}, modality = null) {
  const contrastAgent = firstText(details.contrast_agent, details.contrastAgent);
  const rawPlanned = details.contrast_planned ?? details.contrastPlanned;
  if (rawPlanned === false || rawPlanned === 'false') {
    if (contrastAgent || hasExplicitContrastStudySignal(details)) {
      throw AppError.badRequest(
        'contrast_planned cannot be false when the order names a contrast agent or contrast-enhanced study',
        'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION',
      );
    }
    return { contrastPlanned: false, contrastAgent: null, intentSource: 'explicitly_negated' };
  }
  if (rawPlanned === true || rawPlanned === 'true') {
    return { contrastPlanned: true, contrastAgent, intentSource: 'explicit' };
  }
  if (contrastAgent) {
    return { contrastPlanned: true, contrastAgent, intentSource: 'agent_named' };
  }
  if (hasExplicitContrastStudySignal(details)) {
    return { contrastPlanned: true, contrastAgent: null, intentSource: 'study_text' };
  }
  if (isContrastPresumedModality(modality)) {
    return { contrastPlanned: true, contrastAgent: null, intentSource: 'modality_presumed' };
  }
  return { contrastPlanned: false, contrastAgent: null, intentSource: 'modality_not_presumed' };
}

/**
 * Phase-0 contrast/allergy gate for a CPOE radiology order (pre-commit, plain
 * prisma — same boundary as runCDSChecks for medications). Throws:
 *   400 RADIOLOGY_ORDER_MODALITY_REQUIRED   — modality unresolvable (fail-closed)
 *   400 RADIOLOGY_CONTRAST_INTENT_CONTRADICTION
 *   409 RADIOLOGY_CONTRAST_ALLERGY_BLOCKED  — blocked without a valid override
 * On success, stamps the derived canonical modality/body_part (and any
 * normalised override evidence) back into n.details so the persisted order and
 * the post-commit worklist materialization share ONE derivation.
 */
async function runRadiologyContrastGate(n, data = {}) {
  const fields = resolveRadiologyOrderFields(n.details, { notes: n.notes });
  if (!fields.modality) {
    throw AppError.badRequest(
      'Radiology orders must name their modality: set details.modality '
      + `(one of ${RADIOLOGY_MODALITIES.join(', ')}; aliases accepted) or use a test_name that names it `
      + '(e.g. "CT Brain plain"). The modality drives the mandatory contrast/allergy screen and the radiology worklist entry.',
      'RADIOLOGY_ORDER_MODALITY_REQUIRED',
    );
  }
  const intent = deriveCpoeContrastIntent(n.details, fields.modality);
  let screen = null;
  let override = null;
  if (intent.contrastPlanned) {
    screen = await validateRadiologyContrastSafety({
      patientUid: n.patient_uid,
      modality: fields.modality,
      contrastAgent: intent.contrastAgent,
    });
    // Same override resolution radiologyService.createOrder accepts. Only the
    // reason is caller input; attribution is always the authenticated orderer.
    const overrideInput = data?.override?.reason
      ? { reason: data.override.reason, approvedBy: data.override.approvedBy ?? data.override.approved_by }
      : (firstText(n.details?.contrast_override_reason)
        ? { reason: n.details.contrast_override_reason, approvedBy: n.details.contrast_override_by }
        : null);
    override = assertContrastOrderAllowed(screen, overrideInput, n.ordered_by);
    if (override) {
      logger.warn('Radiology contrast allergy override used (CPOE order)', {
        patient_uid: n.patient_uid,
        modality: fields.modality,
        contrast_agent: intent.contrastAgent,
        blockers: screen.blockers.length,
        approved_by: override.approvedBy,
      });
    }
  }
  n.details = {
    ...n.details,
    modality: fields.modality,
    body_part: fields.bodyPart || 'unspecified',
    ...(override
      ? { contrast_override_reason: override.reason, contrast_override_by: override.approvedBy }
      : {}),
  };
  return { fields, intent, screen, override };
}

// Canonical-event payload fragment for a gated radiology order — mirrors the
// contrast payload radiologyService.createOrder emits so both detail rows'
// timeline events describe the screen the same way.
function radiologyGatePayload(gate) {
  if (!gate) return {};
  return {
    modality: gate.fields.modality,
    body_part: gate.fields.bodyPart || 'unspecified',
    contrast_planned: gate.intent.contrastPlanned,
    contrast_agent: gate.intent.contrastAgent,
    contrast_intent_source: gate.intent.intentSource,
    contrast_screen_status: gate.screen ? gate.screen.status : null,
    contrast_allergy_blockers: gate.screen ? gate.screen.blockers.length : 0,
    contrast_allergy_override: Boolean(gate.override),
  };
}

/**
 * Generate `count` sequential unique order numbers: ORD-YYYYMMDD-XXXX.
 * One DB read seeds the base sequence; the rest increment in memory so a
 * batch insert doesn't re-read (and collide) per order.
 */
async function generateOrderNumbers(count) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `ORD-${today}-`;

  // Last order issued today (LIKE 'ORD-YYYYMMDD-%' ORDER BY id DESC LIMIT 1).
  const last = await prisma.clinical_orders.findFirst({
    where: { order_number: { startsWith: prefix } },
    select: { order_number: true },
    orderBy: { id: 'desc' },
  });

  let seq = 1;
  if (last) {
    const lastSeq = parseInt(last.order_number.split('-').pop(), 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  const numbers = [];
  for (let i = 0; i < count; i += 1) {
    numbers.push(`${prefix}${String(seq + i).padStart(4, '0')}`);
  }
  return numbers;
}

/**
 * Generate a unique order number: ORD-YYYYMMDD-XXXX
 */
async function generateOrderNumber() {
  const [number] = await generateOrderNumbers(1);
  return number;
}

/**
 * Run CDS (Clinical Decision Support) safety checks for an order.
 * Returns { safe, warnings, blockers }.
 * @param {string} patientUid
 * @param {string} orderType
 * @param {object} details
 * @param {string|null} [tenantId] threaded to validatePrescriptionSafety so the
 *   gated + guarded composition allergy / same-composition duplicate screen can
 *   run for IPD medication orders when the tenant flag is enabled.
 */
async function runCDSChecks(patientUid, orderType, details, tenantId = null) {
  const result = { safe: true, warnings: [], blockers: [] };

  try {
    if (orderType === 'medication' && details.medication_name) {
      // validatePrescriptionSafety is integer-keyed — its queries join
      // users.id / patient_allergies.patient_id / e_prescriptions.patient_id
      // as ints. CPOE orders only carry the UUID patient_uid, so resolve it
      // to the int users.id first. Passing the UUID straight through made
      // every medication order's safety check fail closed with a generic
      // blocker (`operator does not exist: integer = text`).
      const patientRow = await prisma.users.findUnique({
        where: { uid: patientUid },
        select: { id: true },
      });
      if (!patientRow) {
        result.warnings.push('CDS safety check skipped — patient not found');
        return result;
      }
      const newMedication = {
        name: details.medication_name,
        medication_name: details.medication_name,
        dose: details.dose ?? details.dosage ?? null,
        dosage: details.dosage ?? details.dose ?? null,
        route: details.route ?? null,
        strength: details.strength ?? null,
        concentration: details.concentration ?? null,
        // Carry the catalog_id through — it is the authoritative key the
        // composition safety screen enriches identity from (validate strips any
        // client composition_id and derives it server-side from catalog_id).
        // Without this the gated composition allergy / same-composition
        // duplicate checks could never fire for drug-chart orders. Only the
        // catalog_id is copied; never a client-sent composition_id.
        catalog_id: details.catalog_id ?? details.catalogId ?? null,
      };

      // Check patient-specific hazards for the new drug first. This preserves
      // the existing hard-block behavior for allergies and paediatric dosing.
      // tenantId is threaded so the gated composition allergy / same-composition
      // duplicate screen (which reads this patient's active e-Rx + IPD orders)
      // can run when the per-tenant flag is enabled; omitting it (legacy path)
      // degrades cleanly to the deterministic checks only.
      const safetyResult = await validatePrescriptionSafety(patientRow.id, [
        newMedication,
      ], { tenantId });

      result.warnings = safetyResult.warnings || [];
      result.blockers = safetyResult.blockers || [];

      // Add active inpatient medications to the interaction screen. The
      // prescription checker's OPD duplicate query cannot see CPOE/IPD orders,
      // so without this a new inpatient drug could silently conflict with the
      // patient's current drug chart.
      const activeRows = await prisma.$queryRawUnsafe(
        `SELECT details
           FROM clinical_orders
          WHERE patient_uid = $1::uuid
            AND order_type = 'medication'
            AND COALESCE(status, 'ordered') !~* '(cancelled|canceled|discontinued|stopped|on[\\s_-]?hold|suspended|completed)'
          ORDER BY created_at DESC
          LIMIT 100`,
        patientUid,
      );
      const activeMedicationNames = activeRows
        .map((row) => parseOrderDetails(row.details))
        .map((d) => d.medication_name || d.name || d.medication)
        .filter(Boolean);
      const newName = String(details.medication_name || '').trim().toLowerCase();
      const duplicateActive = activeMedicationNames.some(
        (name) => String(name || '').trim().toLowerCase() === newName,
      );
      if (duplicateActive) {
        result.warnings.push({
          type: 'DUPLICATE_INPATIENT_MEDICATION',
          medication: details.medication_name,
          message: `"${details.medication_name}" is already active on this inpatient drug chart`,
        });
      }

      const interactionResult = checkAntithromboticInteractions([
        ...activeMedicationNames.map((name) => ({ name })),
        newMedication,
      ]);
      const relatedToNewDrug = (issue) => {
        const meds = Array.isArray(issue?.medications) ? issue.medications : [issue?.medication];
        return meds.some((name) => String(name || '').trim().toLowerCase() === newName);
      };
      result.warnings.push(...(interactionResult.warnings || []).filter(relatedToNewDrug));
      result.blockers.push(...(interactionResult.blockers || []).filter(relatedToNewDrug));
      result.safe = result.blockers.length === 0;
    }
  } catch (err) {
    // Fail CLOSED for MEDICATION orders (audit 2026-06-18 §4). Previously a CDS
    // exception was downgraded to a soft warning and the order was created with
    // safety screening silently skipped — a medication could be ordered with no
    // allergy / interaction / dosing check having run. This now mirrors the
    // fail-CLOSED prescription path (prescriptionSafetyCheck.validatePrescriptionSafety):
    // a screening failure pushes a SAFETY_CHECK_ERROR blocker so createOrder /
    // createOrdersBulk reject with CDS_BLOCKER. The override path remains
    // available — callers can pass `override: { reason }` to record an explicit
    // clinician override (manual review cleared the patient) instead of a silent skip.
    // Non-medication order types carry no medication safety screen, so a fault
    // there stays a non-blocking warning.
    logger.error(`CDS check failed for patient=${patientUid}, orderType=${orderType}: ${err.message}`);
    if (orderType === 'medication') {
      result.cdsError = true;
      result.blockers.push({
        type: 'SAFETY_CHECK_ERROR',
        message: 'Automated medication safety check failed — manual review and override required before ordering.',
      });
      result.safe = false;
    } else {
      result.warnings.push('CDS safety check could not be completed');
    }
  }

  return result;
}

// A CDS result is overridable here ONLY when its block came purely from a
// CDS EXCEPTION (the automated screen could not run — `cdsError`) and every
// blocker is the SAFETY_CHECK_ERROR sentinel. Genuine deterministic blockers
// (allergy conflict, paediatric dosing, interaction) are NOT overridable through
// this path — they keep their hard block and their own CDS-modal override flow.
function cdsBlockIsOverridable(cdsResult) {
  if (!cdsResult?.cdsError || !Array.isArray(cdsResult.blockers) || cdsResult.blockers.length === 0) {
    return false;
  }
  return cdsResult.blockers.every((b) => (typeof b === 'object' && b ? b.type : null) === 'SAFETY_CHECK_ERROR');
}

// Resolve a non-empty override reason from the caller payload (data.override.reason
// or data.override_reason). Returns the trimmed reason or null.
function overrideReasonOf(data) {
  const raw = data?.override?.reason ?? data?.override_reason ?? null;
  const reason = typeof raw === 'string' ? raw.trim() : '';
  return reason || null;
}

/**
 * Normalise a medication route to its canonical form. Case-insensitive
 * ("intravenous" → "IV"); returns null when no route was supplied;
 * passes unrecognised values through trimmed so they still land in the
 * typed `route` column.
 */
function normalizeOrderRoute(rawRoute) {
  if (rawRoute === undefined || rawRoute === null || String(rawRoute).trim() === '') {
    return null;
  }
  const trimmed = String(rawRoute).trim();
  return ROUTE_SYNONYMS[trimmed.toLowerCase()] || trimmed;
}

function parseOrderDetails(details) {
  if (!details) return {};
  if (typeof details === 'string') {
    try {
      return JSON.parse(details);
    } catch {
      return { raw: details };
    }
  }
  if (typeof details === 'object' && !Array.isArray(details)) return details;
  return {};
}

function firstText(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

function investigationPriorityFromClinicalOrder(priority) {
  const normalized = String(priority || 'routine').toLowerCase();
  return CLINICAL_ORDER_PRIORITY_TO_INVESTIGATION[normalized] || 'NORMAL';
}

function investigationNotesFromClinicalOrder(order, details) {
  const notes = [
    firstText(details.reason, details.clinical_indication, details.indication, order.notes),
    `clinical_order_id:${order.id}`,
    `clinical_order_number:${order.order_number}`,
  ];
  return notes.filter(Boolean).join('; ');
}

function orderClinicalSummary(order) {
  const details = parseOrderDetails(order.details);
  const name = firstText(
    details.medication_name,
    details.drug_name,
    details.test_name,
    details.investigation,
    details.name,
    details.summary,
  );
  return [
    `${order.order_type || 'clinical'} order`,
    name,
    order.priority ? `(${order.priority})` : null,
  ].filter(Boolean).join(' ');
}

// Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
// a successful order create/verify/complete/cancel/discontinue must persist
// the clinical_orders detail row + one clinical_timeline_events row + one
// clinical_audit_events row (plus any medication_safety_reviews) in the SAME
// transaction. This helper therefore runs on the transaction client (`tx`,
// required) and is NOT swallowed — a failure propagates and aborts the
// transaction so the order detail row / status change rolls back rather than
// leaving the timeline/audit/safety layer out of sync.
// recordCanonicalClinicalEvent still tolerates a genuinely-absent canonical
// table (SQLSTATE 42P01) internally; every other error propagates.
async function recordCanonicalOrderEvent({
  order,
  tx,
  eventType,
  eventStatus = null,
  actorUid = null,
  actorRole = null,
  previousStatus = null,
  payload = {},
  beforeState = null,
  afterState = null,
  safety = null,
  override = null,
} = {}) {
  if (!order?.id) return null;
  const status = eventStatus || order.status || null;
  const stamp = order.updated_at?.toISOString?.()
    || order.created_at?.toISOString?.()
    || Date.now();

  if (safety && order.order_type === 'medication') {
    await recordMedicationSafetyReviews({
      tenantId: order.tenant_id,
      patientUid: order.patient_uid,
      encounterId: order.encounter_id,
      clinicalOrderId: order.id,
      safety,
      // When a CDS-exception blocker was overridden, thread the reason so the
      // safety-review row records status 'overridden' (audit trail) instead of
      // a silent skip. recordMedicationSafetyReviews marks the blocked finding
      // 'overridden' when an override reason is present.
      override: override?.reason ? { reason: override.reason, approvedBy: actorUid || order.ordered_by } : null,
      actorUid: actorUid || order.ordered_by,
    }, { db: tx });
  }

  return recordCanonicalClinicalEvent({
    tenantId: order.tenant_id,
    patientUid: order.patient_uid,
    encounterId: order.encounter_id,
    eventType,
    eventSubtype: order.order_type,
    eventStatus: status,
    sourceTable: 'clinical_orders',
    sourceId: String(order.id),
    resourceType: 'clinical_order',
    resourceId: String(order.id),
    actorUid: actorUid || order.ordered_by || order.verified_by || order.completed_by || order.cancelled_by,
    actorRole,
    summary: orderClinicalSummary(order),
    payload: {
      order_id: order.id,
      order_number: order.order_number,
      order_type: order.order_type,
      priority: order.priority,
      route: order.route,
      previous_status: previousStatus,
      status,
      details: order.details,
      notes: order.notes,
      safety_warnings: safety?.warnings || [],
      ...payload,
    },
    beforeState: beforeState || (previousStatus ? { status: previousStatus } : null),
    afterState: afterState || { status },
    tags: ['clinical_order', order.order_type].filter(Boolean),
    timelineIdempotencyKey: `clinical_orders:${order.id}:${eventType}:${status || 'none'}:${stamp}`,
    auditIdempotencyKey: `clinical_orders:${order.id}:audit:${eventType}:${status || 'none'}:${stamp}`,
  }, { db: tx });
}

/**
 * Normalise + validate a single order payload. Async — does one DB read
 * to resolve `er_visit_id` → the ER visit's `encounter_id` (chip
 * stage-5-1); otherwise no DB writes. The bulk path still validates
 * every item up front (await per item) before opening the transaction.
 * Throws AppError.badRequest / AppError.notFound on any invalid field.
 * @returns {Promise<Object>} normalised order fields ready for prisma.clinical_orders.create
 */
async function normalizeOrderInput(data) {
  const {
    patient_uid,
    ordered_by,
    start_date,
    end_date,
    notes,
    er_visit_id,
  } = data;
  // Both are `let`, not part of the const destructure: `encounter_id` may
  // be re-derived from `er_visit_id` below (chip stage-5-1), and `details`
  // is re-shaped with the structured route (chip stage-5-6).
  let { encounter_id, details } = data;

  // Clinicians write priority in upper case ("STAT" / "URGENT") — that's
  // the universal medical convention. Lower-case server-side before
  // validation so the universal form doesn't error out.
  // See finding 2026-05-08-emergency-walk-in-doctor-priority-case-sensitive.
  const priority = String(data.priority ?? 'routine').toLowerCase();

  // Coerce clinical-vernacular aliases ("lab"/"radiology"/"imaging") to
  // the persisted `investigation` enum value. See ORDER_TYPE_ALIASES.
  const rawOrderType = String(data.order_type ?? '').toLowerCase().trim();
  const order_type = ORDER_TYPE_ALIASES[rawOrderType] || rawOrderType;

  if (!patient_uid || !order_type || !details || !ordered_by) {
    throw AppError.badRequest('patient_uid, order_type, details, and ordered_by are required');
  }

  if (!VALID_ORDER_TYPES.includes(order_type)) {
    throw AppError.badRequest(
      `Invalid order_type: ${data.order_type}. Must be one of: ${VALID_ORDER_TYPES.join(', ')} `
      + `(aliases accepted: lab/laboratory/pathology/diagnostic → investigation, imaging → radiology, med → medication, consult → consultation)`,
    );
  }

  if (!VALID_PRIORITIES.includes(priority)) {
    throw AppError.badRequest(`Invalid priority: ${data.priority}. Must be one of: ${VALID_PRIORITIES.join(', ')} (case-insensitive)`);
  }

  // An ER order attaches to its emergency visit one of two ways: pass the
  // ER encounter UUID directly as `encounter_id`, or pass the ER visit's
  // integer id as `er_visit_id` and let the service resolve the UUID. The
  // latter matches what the doctor actually has on hand (the visit row
  // id) — before this, ER orders without a formal admission had to be
  // filed with `encounter_id: null`, losing visit-level grouping. Finding:
  // 2026-05-09-emergency-walk-in-doctor-er-encounter-id-gap.
  const encounterIdMissing = encounter_id === undefined || encounter_id === null || encounter_id === '';
  const erVisitIdProvided = er_visit_id !== undefined && er_visit_id !== null && er_visit_id !== '';
  if (encounterIdMissing && erVisitIdProvided) {
    const visitId = Number(er_visit_id);
    if (!Number.isInteger(visitId)) {
      throw AppError.badRequest('er_visit_id must be an integer emergency_visits id');
    }
    const visit = await prisma.emergency_visits.findUnique({
      where: { id: visitId },
      select: { encounter_id: true },
    });
    if (!visit) {
      throw AppError.notFound('Emergency visit not found');
    }
    encounter_id = visit.encounter_id;
  }

  // `clinical_orders.encounter_id` is `Uuid?` — silently dropping non-UUID
  // ints makes orders orphaned from their visit (audit + reassessment
  // pivot lost). Reject up-front with a 400 so the caller knows to look
  // up the admission's UUID encounter or pass null. See finding
  // 2026-05-08-emergency-walk-in-doctor-orders-encounter-id-silently-dropped.
  if (encounter_id !== undefined && encounter_id !== null && encounter_id !== '') {
    if (typeof encounter_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(encounter_id)) {
      throw AppError.badRequest(
        'encounter_id must be a UUID. Pass null for OPD visits without an admission, or look up admissions.encounter_id for IPD orders.',
      );
    }
  }

  // Structured medication route (migration 229). Accept it top-level or
  // nested in details; normalise to a canonical form and mirror it back
  // into details.route so the MAR scheduler — which still reads
  // details.route — sees the canonical value.
  const route = normalizeOrderRoute(
    data.route ?? (details && typeof details === 'object' ? details.route : null),
  );
  if (route && details && typeof details === 'object' && !Array.isArray(details)) {
    details = { ...details, route };
  }

  return {
    encounter_id: encounter_id ?? null,
    patient_uid,
    order_type,
    priority,
    details,
    route,
    ordered_by,
    start_date: start_date ?? null,
    end_date: end_date ?? null,
    notes: notes ?? null,
  };
}

// Each blocker from validatePrescriptionSafety is a shaped object —
// joining the array directly renders every blocker as "[object Object]"
// and leaves the prescribing doctor with no actionable detail. Map each
// through its renderable string field. Findings:
//   2026-05-10-inpatient-admission-doctor-medication-orders-cds-blocked
//   2026-05-10-inpatient-admission-doctor-medication-cpoe-blocks-oral-switch-object-object
//   2026-05-10-dynamic-acute-abdomen-doctor-medication-order-paths-blocked
function renderBlocker(b) {
  if (typeof b === 'string') return b;
  if (b && typeof b === 'object') {
    return b.message || b.reason || b.type || JSON.stringify(b);
  }
  return String(b);
}

// Human-readable staff alert copy per post-commit integration stage. The MAR
// copy is the load-bearing one: a medication order that commits with zero
// scheduled doses is invisible on the ward MAR until someone schedules it
// manually.
const ORDER_INTEGRATION_FAILURE_ALERTS = {
  mar_schedule: {
    action: 'mar_scheduling_failed',
    title: 'Medication order has NO scheduled MAR doses',
    body: (order) => `MAR scheduling FAILED for medication order ${order.order_number} — no doses are on the drug chart. Schedule the doses manually and verify the order.`,
  },
  ward_indent: {
    action: 'ward_indent_creation_failed',
    title: 'Ward indent missing for medication order',
    body: (order) => `Ward pharmacy indent creation FAILED for medication order ${order.order_number} — the ward stock request was not raised. Raise the indent manually.`,
  },
  integration_dispatch: {
    action: 'order_integration_dispatch_failed',
    title: 'Order downstream dispatch failed',
    body: (order) => `Downstream integration dispatch FAILED for ${order.order_type} order ${order.order_number} — verify the receiving worklist (MAR / lab / radiology) picked the order up.`,
  },
};

/**
 * Durable escalation for a post-commit integration failure on a COMMITTED
 * clinical order (review 2026-08-09, finding BE-H1). These hooks run after
 * the order transaction committed — the order must stand — so a failure here
 * previously left only a log line: a medication order could commit with zero
 * scheduled MAR doses and no detector. Every swallow in the post-create
 * integration region now escalates durably:
 *
 *   1. a notification_outbox alert fanned out to CONCRETE clinical-staff
 *      recipients (duty-doctor role fan-out via queueClinicalAlertFanout —
 *      the outbox has no topic delivery, so a recipient-less broadcast row
 *      reached nobody; fix R2, audit 2026-08-10) — durable, retried by the
 *      outbox drain, deduplicated per recipient on source_event_key; and
 *   2. a clinical_audit_events row (action_status 'failed', deterministic
 *      idempotency key `clinical_orders:<id>:<stage>_failed`) via the
 *      canonical helpers under the safeCanonical post-commit policy
 *      (42P01 canonical-table-absent -> warn; any other fault -> ERROR log).
 *
 * The two attempts are INDEPENDENT — one failing never skips the other; if
 * both fail, the logger.error trail remains as the last resort. Never
 * throws. Exported for unit tests (precedent: buildMarEntryFromOrderDetails).
 */
export async function escalateOrderIntegrationFailure({ order, stage, err, deps = {} } = {}) {
  const copy = ORDER_INTEGRATION_FAILURE_ALERTS[stage];
  if (!order?.id || !copy) return { alertQueued: false, auditRecorded: false };
  const outbox = deps.notificationOutbox || notificationOutbox;
  const recordAudit = deps.recordClinicalAuditEvent || recordClinicalAuditEvent;
  const runSafeCanonical = deps.safeCanonical || safeCanonical;

  let alertQueued = false;
  try {
    const fanout = await queueClinicalAlertFanout({
      type: 'push',
      tenantId: order.tenant_id || null,
      title: copy.title,
      body: copy.body(order),
      data: {
        source_event_key: `clinical_orders:${order.id}:${stage}_failed:alert`,
        order_id: order.id,
        order_number: order.order_number,
        order_type: order.order_type,
        priority: order.priority,
        patient_uid: order.patient_uid,
        failure_stage: stage,
        error_code: err?.code || null,
      },
      channel: 'clinical_alert',
    }, {
      outbox,
      resolveRecipients: deps.resolveClinicalAlertRecipients,
      strict: true,
    });
    alertQueued = fanout.queued > 0;
  } catch (queueErr) {
    logger.error(
      `Order ${stage} failure alert could NOT be queued for order ${order.order_number}: ${queueErr.message}`,
      { order_id: order.id, stage },
    );
  }

  let auditRecorded = false;
  await runSafeCanonical(`order ${stage} failure audit (order ${order.order_number})`, async () => {
    const row = await recordAudit({
      tenantId: order.tenant_id || null,
      patientUid: order.patient_uid,
      encounterId: order.encounter_id || null,
      action: copy.action,
      actionStatus: 'failed',
      actorUid: order.ordered_by || null,
      resourceType: 'clinical_order',
      resourceTable: 'clinical_orders',
      resourceId: String(order.id),
      metadata: {
        order_number: order.order_number,
        order_type: order.order_type,
        priority: order.priority,
        failure_stage: stage,
        error: err?.message || String(err),
        error_code: err?.code || null,
        alert_queued: alertQueued,
      },
      idempotencyKey: `clinical_orders:${order.id}:${stage}_failed`,
    });
    auditRecorded = !!row;
    return row;
  });

  if (!alertQueued && !auditRecorded) {
    // Last resort — both durable escalation channels failed.
    logger.error(
      `Order ${stage} failure escalation FULLY degraded for order ${order.order_number} — no outbox alert and no audit row persisted`,
      { order_id: order.id, patient_uid: order.patient_uid, stage, error: err?.message },
    );
  }
  return { alertQueued, auditRecorded };
}

/**
 * Post-commit best-effort side effects for a freshly created order: ward
 * indent for IPD medication orders, downstream integration dispatch, and
 * a STAT push. Failures never throw (the committed order must stand), but
 * they are no longer silent: each clinically meaningful swallow escalates
 * durably via escalateOrderIntegrationFailure (outbox alert + failed audit
 * row) — shared by the single-order and bulk paths.
 */
async function dispatchPostCreateSideEffects(order) {
  if (order.order_type === 'medication') {
    await recordFirstDrugChartEntry(order).catch((err) => {
      logger.warn(`Failed to audit first drug chart entry for order ${order.order_number}: ${err.message}`);
    });

    // Persisted-only brand-substitution audit — post-commit, best-effort. When
    // the ordered brand (`details.catalog_id`) differs from the first-selected
    // one (`details.original_catalog_id`), record a server-resolved
    // clinical_audit_events row. recordBrandSubstitutionAudit never throws, but
    // guard anyway so it can never fail a persisted order.
    const details = order.details && typeof order.details === 'object' ? order.details : {};
    if (details.original_catalog_id != null
      && String(details.original_catalog_id) !== String(details.catalog_id)) {
      await recordBrandSubstitutionAudit({
        tenantId: order.tenant_id,
        patientUid: order.patient_uid,
        encounterId: order.encounter_id,
        actorUid: order.ordered_by,
        actorRole: null,
        surface: 'drug_chart',
        resourceTable: 'clinical_orders',
        resourceId: order.id,
        originalCatalogId: details.original_catalog_id,
        finalCatalogId: details.catalog_id,
        reason: details.substitution_reason ?? null,
      }).catch((err) => {
        logger.warn(`Brand-substitution audit failed for order ${order.order_number}: ${err.message}`);
      });
    }
  }

  if (order.order_type === 'medication' && order.encounter_id) {
    await createWardIndentForClinicalMedicationOrder(order).catch(async (err) => {
      // BE-H1: the order committed but the ward stock request was not raised —
      // log loudly AND escalate durably (outbox alert + failed audit row).
      logger.error(`Failed to create ward indent for medication order ${order.order_number}: ${err.message}`);
      await escalateOrderIntegrationFailure({ order, stage: 'ward_indent', err });
    });
  }

  // Dispatch integrations. Investigation materialization is awaited so a
  // freshly-saved order is present on the lab worklist by the time the doctor
  // sees the response. Radiology materialization is already part of the
  // clinical-order transaction; other integrations stay best-effort.
  // BE-H1: a dispatch failure that reaches this catch (the MAR-scheduling
  // failure is escalated by its own inner catch and does not re-throw) is
  // escalated durably — never just a log line.
  const integrationDispatch = dispatchOrderIntegrations(order).catch(async (err) => {
    logger.error(`Order integration dispatch failed for order ${order.order_number}: ${err.message}`);
    await escalateOrderIntegrationFailure({ order, stage: 'integration_dispatch', err });
  });
  if (order.order_type === 'investigation') {
    await integrationDispatch;
  }

  // STAT orders — push notification to relevant staff. Fanned out to concrete
  // duty-doctor recipients (fix R2: the outbox has no topic delivery, so the
  // old recipientId:null broadcast row reached nobody).
  if (order.priority === 'stat') {
    queueClinicalAlertFanout({
      type: 'push',
      tenantId: order.tenant_id || null,
      title: 'STAT Order',
      body: `STAT ${order.order_type} order ${order.order_number} for patient`,
      data: {
        source_event_key: `clinical_orders:${order.id}:stat:alert`,
        order_id: order.id,
        order_number: order.order_number,
        order_type: order.order_type,
        priority: order.priority,
      },
      channel: 'clinical_alert',
    }).catch((err) => {
      logger.warn(`Failed to queue STAT notification for order ${order.order_number}: ${err.message}`);
    });
  }
}

// ===================================================================
// createOrder
// ===================================================================

/**
 * Create a clinical order.
 * @param {Object} data - { encounter_id?, patient_uid, order_type, priority?, details, ordered_by, start_date?, end_date?, notes?, tenantId? }
 * @returns {Object} Created order with CDS check results
 */
export async function createOrder(data) {
  // RLS tenant scope (Batch 3 Wave B-prime): the canonical clinical write
  // below must run with app.current_tenant_id set, else the tenant_isolation
  // policy falls to its permissive branch. Threaded from the caller's
  // req.tenantId; defaults to the single-tenant id (safe today, column
  // default IS the default tenant) so test/legacy callers stay green.
  const { tenantId = null } = data;
  const n = await normalizeOrderInput(data);

  // Server-authoritative composition identity (Phase 2). When a medication
  // order carries a catalog_id, overlay the tenant-scoped server-derived
  // composition identity onto n.details BEFORE the CDS screen so the
  // safety-checked payload and the persisted payload are byte-identical
  // (invariant #7). Enrich strips any client-sent composition_id first, so a
  // forged value is never persisted as fact. Guarded: a failure leaves the
  // original details untouched and the write still succeeds. Always-on when a
  // catalog_id is present — harmless metadata that makes a future flag-flip
  // immediately effective on in-flight orders.
  if (n.order_type === 'medication' && (n.details?.catalog_id ?? n.details?.catalogId) != null) {
    try {
      const [enriched] = await enrichMedicationsWithComposition(tenantId, [n.details]);
      if (enriched) n.details = enriched;
    } catch (err) {
      logger.warn(`composition enrich (order create) failed: ${err.message}`);
    }
  }

  // CPOE → radiology bridge (Phase 0, fail-closed): resolve the modality,
  // derive contrast intent server-side, and run the migration-678
  // contrast/allergy screen BEFORE any row is written. Blocked without an
  // acknowledged override → 409 RADIOLOGY_CONTRAST_ALLERGY_BLOCKED, exactly
  // like ordering through radiologyService directly.
  let radiologyGate = null;
  if (n.order_type === 'radiology') {
    radiologyGate = await runRadiologyContrastGate(n, data);
  }

  // Run CDS safety checks. Blockers reject the order — surface the
  // structured array as `details` so the staff-app CDS modal can show
  // per-blocker context + the override flow.
  const cdsResult = await runCDSChecks(n.patient_uid, n.order_type, n.details, tenantId);
  if (radiologyGate?.screen) {
    // Contrast screen warnings ride the same cds_warnings surface the staff
    // composer already renders; blockers were either absent or overridden.
    cdsResult.warnings.push(...radiologyGate.screen.warnings);
  }
  // Fail-closed CDS-exception override (audit 2026-06-18 §4): when the only
  // block is that the automated medication screen could not run, an explicit
  // override-with-reason lets the order through and is recorded on a
  // medication_safety_reviews row (status 'overridden'). Genuine deterministic
  // blockers are not overridable here.
  const cdsOverrideReason = overrideReasonOf(data);
  const overrideApplied = cdsBlockIsOverridable(cdsResult) && !!cdsOverrideReason;
  if (cdsResult.blockers.length > 0 && !overrideApplied) {
    throw AppError.badRequest(
      `Order blocked by safety checks: ${cdsResult.blockers.map(renderBlocker).join('; ')}`,
      'CDS_BLOCKER',
      { blockers: cdsResult.blockers, warnings: cdsResult.warnings },
    );
  }

  const orderNumber = await generateOrderNumber();

  // Atomic clinical write (canonical timeline invariant): the order detail
  // row + its canonical timeline/audit events (+ medication safety reviews)
  // persist together or not at all. A radiology order also materializes its
  // receiving worklist row here: success must never expose a clinical order
  // that radiology cannot see. Other downstream side effects remain
  // post-commit best-effort.
  // `details` is a Json column — pass the object directly (Prisma serialises).
  // `status` defaults to 'ordered' in the schema; pre-ORM SQL set it
  // explicitly, so we preserve that for clarity.
  const order = await setTenantTx(requireTenantId(tenantId), async (tx) => {
    const row = await tx.clinical_orders.create({
      data: {
        order_number: orderNumber,
        encounter_id: n.encounter_id,
        patient_uid: n.patient_uid,
        order_type: n.order_type,
        priority: n.priority,
        details: n.details,
        route: n.route,
        status: 'ordered',
        ordered_by: n.ordered_by,
        start_date: n.start_date ? new Date(n.start_date) : null,
        end_date: n.end_date ? new Date(n.end_date) : null,
        notes: n.notes,
      },
      select: ORDER_RETURNING_SELECT,
    });

    await recordCanonicalOrderEvent({
      order: row,
      tx,
      eventType: 'order.created',
      eventStatus: row.status,
      actorUid: n.ordered_by,
      afterState: { status: row.status },
      payload: radiologyGatePayload(radiologyGate),
      safety: cdsResult,
      override: overrideApplied ? { reason: cdsOverrideReason } : null,
    });
    if (row.order_type === 'radiology') {
      await materializeRadiologyOrderForClinicalOrder(row, { db: tx });
    }
    await publishOpChildResourceLinkedFromEncounterTx(tx, {
      tenantId: requireTenantId(tenantId),
      encounterId: row.encounter_id,
      patientUid: row.patient_uid,
      resourceType: 'clinical_order',
      resourceId: row.id,
      source: 'clinical_orders.create',
    });
    return row;
  });

  await dispatchPostCreateSideEffects(order);

  // CareTeam ABAC Phase 2 hook #3 (best-effort, post-commit) — materialise the
  // ordering provider onto an active `longitudinal` care team for this patient.
  // Idempotent + self-contained: swallows every error internally and MUST NEVER
  // block or fail the order write.
  await populateAuthorshipCareTeam({
    tenantId: requireTenantId(order.tenant_id || tenantId),
    patientUid: order.patient_uid,
    authorUid: order.ordered_by,
    source: 'clinical_order',
  });

  logger.info(`Order created: ${orderNumber}, type=${n.order_type}, priority=${n.priority}, patient=${n.patient_uid}, by=${n.ordered_by}`);

  return {
    order,
    cds_warnings: cdsResult.warnings,
  };
}

// ===================================================================
// createOrdersBulk
// ===================================================================

/**
 * Create multiple clinical orders atomically. An admission round enters
 * a routine bundle (IV fluids + a few meds + labs + imaging) as one
 * clinical action — firing N single-order POSTs meant N round-trips and
 * no rollback if the Nth failed. This validates + runs CDS for every
 * item up front (Phase 0), inserts all rows in one transaction
 * (Phase 1), then fires per-order side effects post-commit (Phase 1.5).
 * Any validation/CDS failure aborts the whole batch before a row is
 * written; the offending item index is surfaced to the caller.
 * @param {Array<Object>} items - order payloads (same shape as createOrder's `data`)
 * @param {Object} ctx - { ordered_by, tenantId? }
 * @returns {Array<{ order, cds_warnings }>}
 * Finding 2026-05-08-inpatient-admission-doctor-no-batch-ordering.
 */
export async function createOrdersBulk(items, { ordered_by, tenantId = null } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('orders must be a non-empty array');
  }
  if (!ordered_by) {
    throw AppError.badRequest('ordered_by is required');
  }

  // Phase 0 — validate every item + run CDS, all up front. Any failure
  // aborts the batch before a row is written.
  const prepared = [];
  for (let i = 0; i < items.length; i += 1) {
    let normalized;
    try {
      normalized = await normalizeOrderInput({ ...items[i], ordered_by });
    } catch (err) {
      throw AppError.badRequest(`Order #${i + 1}: ${err.message}`, err.code, err.details);
    }
    // Server-authoritative composition identity (Phase 2) — same invariant-#7
    // enrich-before-CDS-then-persist-the-same-object as createOrder, applied to
    // each prepared medication order's details. Guarded per item so one failure
    // never aborts the batch.
    if (normalized.order_type === 'medication'
      && (normalized.details?.catalog_id ?? normalized.details?.catalogId) != null) {
      try {
        const [enriched] = await enrichMedicationsWithComposition(tenantId, [normalized.details]);
        if (enriched) normalized.details = enriched;
      } catch (err) {
        logger.warn(`composition enrich (bulk order create #${i + 1}) failed: ${err.message}`);
      }
    }
    // CPOE → radiology bridge (Phase 0, fail-closed): same per-item gate as
    // createOrder. Any failure (unresolvable modality, contrast contradiction,
    // blocked screen without override) aborts the whole batch before a row is
    // written, with the offending item index surfaced.
    let itemRadiologyGate = null;
    if (normalized.order_type === 'radiology') {
      try {
        itemRadiologyGate = await runRadiologyContrastGate(normalized, items[i]);
      } catch (err) {
        throw new AppError(
          `Order #${i + 1}: ${err.message}`,
          err.statusCode || 400,
          err.code,
          { order_index: i, ...(err.details || {}) },
        );
      }
    }
    const cdsResult = await runCDSChecks(normalized.patient_uid, normalized.order_type, normalized.details, tenantId);
    if (itemRadiologyGate?.screen) {
      cdsResult.warnings.push(...itemRadiologyGate.screen.warnings);
    }
    // Fail-closed CDS-exception override (audit 2026-06-18 §4): same per-item
    // override-with-reason path as createOrder. A genuine blocker (or a missing
    // reason) still aborts the whole batch.
    const itemOverrideReason = overrideReasonOf(items[i]);
    const itemOverrideApplied = cdsBlockIsOverridable(cdsResult) && !!itemOverrideReason;
    if (cdsResult.blockers.length > 0 && !itemOverrideApplied) {
      throw AppError.badRequest(
        `Order #${i + 1} blocked by safety checks: ${cdsResult.blockers.map(renderBlocker).join('; ')}`,
        'CDS_BLOCKER',
        { order_index: i, blockers: cdsResult.blockers, warnings: cdsResult.warnings },
      );
    }
    prepared.push({
      normalized,
      cds_warnings: cdsResult.warnings,
      cds_blockers: itemOverrideApplied ? cdsResult.blockers : [],
      override: itemOverrideApplied ? { reason: itemOverrideReason } : null,
      radiology_gate: itemRadiologyGate,
    });
  }

  // One DB read seeds the whole batch's order numbers.
  const orderNumbers = await generateOrderNumbers(prepared.length);

  // Phase 1 — atomic insert. Every row inserts together with its canonical
  // timeline/audit events (+ medication safety reviews) in ONE transaction
  // (canonical timeline invariant): a canonical-write failure aborts the
  // whole batch rather than leaving a detail row without its timeline/audit
  // row. No SWALLOWED best-effort calls inside the tx — recordCanonicalOrderEvent
  // re-throws (a swallowed Prisma error would silently abort the tx and the
  // next tx.* call would fail with "current transaction is aborted").
  // RLS tenant scope (Batch 3 Wave B-prime): wrap the atomic insert so
  // app.current_tenant_id is set for every clinical_orders + canonical
  // timeline/audit write. tenantId is threaded from the caller's
  // req.tenantId; default keeps single-tenant / test callers green.
  const createdRows = await setTenantTx(requireTenantId(tenantId), async (tx) => {
    const rows = [];
    for (let i = 0; i < prepared.length; i += 1) {
      const n = prepared[i].normalized;
      const row = await tx.clinical_orders.create({
        data: {
          order_number: orderNumbers[i],
          encounter_id: n.encounter_id,
          patient_uid: n.patient_uid,
          order_type: n.order_type,
          priority: n.priority,
          details: n.details,
          route: n.route,
          status: 'ordered',
          ordered_by: n.ordered_by,
          start_date: n.start_date ? new Date(n.start_date) : null,
          end_date: n.end_date ? new Date(n.end_date) : null,
          notes: n.notes,
        },
        select: ORDER_RETURNING_SELECT,
      });

      await recordCanonicalOrderEvent({
        order: row,
        tx,
        eventType: 'order.created',
        eventStatus: row.status,
        actorUid: row.ordered_by,
        payload: {
          bulk_order_count: prepared.length,
          ...radiologyGatePayload(prepared[i].radiology_gate),
        },
        afterState: { status: row.status },
        safety: row.order_type === 'medication'
          ? {
            safe: (prepared[i].cds_blockers || []).length === 0,
            warnings: prepared[i].cds_warnings || [],
            blockers: prepared[i].cds_blockers || [],
          }
          : null,
        override: prepared[i].override,
      });
      if (row.order_type === 'radiology') {
        await materializeRadiologyOrderForClinicalOrder(row, { db: tx });
      }
      await publishOpChildResourceLinkedFromEncounterTx(tx, {
        tenantId: requireTenantId(tenantId),
        encounterId: row.encounter_id,
        patientUid: row.patient_uid,
        resourceType: 'clinical_order',
        resourceId: row.id,
        source: 'clinical_orders.bulk_create',
      });
      rows.push(row);
    }
    return rows;
  });

  // Phase 1.5 — post-commit best-effort side effects per order (MAR schedule,
  // ward indent, lab-worklist materialization, STAT push). Radiology was
  // materialized atomically above. Failure here is
  // logged, never rolls back the committed orders + canonical events.
  for (let i = 0; i < createdRows.length; i += 1) {
    await dispatchPostCreateSideEffects(createdRows[i]);
  }

  // CareTeam ABAC Phase 2 hook #3 (best-effort, post-commit) — materialise the
  // ordering provider onto an active `longitudinal` care team for the patient(s)
  // in this batch. Idempotent (existence-checked team + ON CONFLICT member), so
  // calling once per row is a fast no-op after the first. Never throws.
  for (let i = 0; i < createdRows.length; i += 1) {
    await populateAuthorshipCareTeam({
      tenantId: requireTenantId(createdRows[i].tenant_id || tenantId),
      patientUid: createdRows[i].patient_uid,
      authorUid: createdRows[i].ordered_by,
      source: 'clinical_order',
    });
  }

  logger.info(`Bulk order create: ${createdRows.length} orders, encounter=${createdRows[0]?.encounter_id ?? 'none'}, by=${ordered_by}`);

  return createdRows.map((order, i) => ({ order, cds_warnings: prepared[i].cds_warnings }));
}

/**
 * Dispatch order to downstream systems (pharmacy, lab) based on order type.
 */
// D12 — Build the MAR entry to hand off to marService.scheduleMedications.
// Pre-fix this code only passed `scheduled_time`, never `frequency` or
// `duration_days`, so a "Metformin 500mg BD x 5 days" order created
// ONE MAR row instead of 10 (5 days × 2/day). Ward nurses only saw
// the first dose; subsequent doses had no row to administer or even
// see as pending. Now we forward frequency (and the CPOE-template
// alias keys dosage_frequency / freq / dose_interval) plus
// duration_days (alias `duration`) so marService.expandSchedule can
// fan the order out. Pure + exported so unit tests can lock the
// MAR-entry shape without spinning up the full createOrder flow.
// Finding a5b0d216.
export function buildMarEntryFromOrderDetails(details, { startDate } = {}) {
  const frequency = details.frequency
    ?? details.dosage_frequency
    ?? details.freq
    ?? details.dose_interval
    ?? null;
  const durationDays = (() => {
    const d = details.duration_days ?? details.duration ?? null;
    const n = Number(d);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const startTime = startDate || new Date().toISOString();
  const entry = {
    medication_name: details.medication_name,
    dose: details.dose,
    route: details.route,
    notes: details.prn_reason || null,
  };
  if (frequency) {
    entry.frequency = frequency;
    entry.start_time = startTime;
    if (durationDays != null) entry.duration_days = durationDays;
  } else {
    entry.scheduled_time = startTime;
  }
  return entry;
}

function normalizeDoseTimes(raw) {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [];
  return values
    .map((v) => String(v || '').trim())
    .filter((v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v))
    .filter((v, index, arr) => arr.indexOf(v) === index);
}

function combineDateAndClock(base, clock, dayOffset) {
  const [hour, minute] = clock.split(':').map(Number);
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

export function buildMarEntriesFromOrderDetails(details, { startDate } = {}) {
  const doseTimes = normalizeDoseTimes(details?.dose_times);
  if (!doseTimes.length) {
    return [buildMarEntryFromOrderDetails(details, { startDate })];
  }

  const durationDays = (() => {
    const d = details.duration_days ?? details.duration ?? null;
    const n = Number(d);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 14) : 1;
  })();
  const start = startDate ? new Date(startDate) : new Date();
  const safeStart = Number.isNaN(start.getTime()) ? new Date() : start;
  const notes = [
    details.prn_reason || null,
    details.food_timing ? `food_timing:${details.food_timing}` : null,
    details.instructions || null,
  ].filter(Boolean).join('; ') || null;

  const entries = [];
  for (let day = 0; day < durationDays; day += 1) {
    for (const clock of doseTimes) {
      entries.push({
        medication_name: details.medication_name,
        dose: details.dose,
        route: details.route,
        scheduled_time: combineDateAndClock(safeStart, clock, day),
        notes,
      });
    }
  }
  return entries;
}

async function dispatchOrderIntegrations(order) {
  if (order.order_type === 'medication') {
    // Create MAR entries via existing marService
    try {
      // `details` comes back from typed Prisma as a parsed object, but
      // keep the string-fallback for safety in case any caller passes a
      // pre-stringified payload.
      const details = typeof order.details === 'string' ? JSON.parse(order.details) : order.details;
      const marEntries = buildMarEntriesFromOrderDetails(details, {
        startDate: order.start_date,
      }).map((entry) => ({
        ...entry,
        notes: [
          entry.notes,
          `clinical_order_id:${order.id}`,
          `order_number:${order.order_number}`,
        ].filter(Boolean).join('; '),
      }));
      await scheduleMedications(order.patient_uid, null, marEntries, {
        tenantId: order.tenant_id,
        actorUid: order.ordered_by,
        sourceClinicalOrderId: order.id,
        encounterId: order.encounter_id,
      });
      logger.info(`MAR entries created for medication order ${order.order_number}`);
    } catch (err) {
      // C-L3: expandSchedule now throws MAR_DURATION_EXCEEDS_WINDOW /
      // MAR_SCHEDULE_DOSE_CEILING instead of silently truncating a long
      // duration to 14 days. This hook is post-commit best-effort (the order
      // itself must stand), so the refusal lands here — carry the error code
      // and identifiers so the zero-MAR outcome is unambiguous in the logs.
      logger.error(
        `Failed to create MAR entries for order ${order.order_number}: ${err.message}`,
        { code: err?.code || null, order_id: order.id, patient_uid: order.patient_uid },
      );
      // BE-H1 (review 2026-08-09): a log line is not a detector — a medication
      // order that commits with ZERO scheduled doses simply disappears from the
      // ward MAR. Escalate durably: a notification_outbox alert to clinical
      // staff plus a clinical_audit_events 'failed' row (idempotency key
      // clinical_orders:<id>:mar_schedule_failed), attempted independently so
      // one channel failing never silences the other. Never throws — the
      // committed order must stand.
      await escalateOrderIntegrationFailure({ order, stage: 'mar_schedule', err });
    }
  }

  if (order.order_type === 'investigation') {
    await materializeInvestigationForClinicalOrder(order);
  }

}

/**
 * Materialize a CPOE radiology order onto the radiology worklist inside the
 * caller's clinical-order transaction. radiologyService re-runs the screen on
 * that transaction client and persists its detail/canonical evidence there.
 * Idempotent via the same notes back-reference idiom the lab materializer
 * uses (`clinical_order_id:<id>`). radiologyService is imported dynamically to
 * keep its graph out of this module's static imports (admissionService
 * dietary-recall precedent).
 */
async function materializeRadiologyOrderForClinicalOrder(order, { db = prisma } = {}) {
  const details = parseOrderDetails(order.details);
  const fields = resolveRadiologyOrderFields(details, { notes: order.notes });
  if (!fields.modality) {
    // createOrder gates on a resolvable modality, so this only fires for
    // legacy pre-bridge rows replayed through this hook.
    logger.warn(`Radiology order ${order.order_number} has no resolvable modality; radiology worklist row not created`);
    return null;
  }

  const existing = await db.$queryRawUnsafe(
    `SELECT id
       FROM radiology_orders
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND notes LIKE $3
      ORDER BY id DESC
      LIMIT 1`,
    order.tenant_id,
    order.patient_uid,
    `%clinical_order_id:${order.id};%`,
  );
  if (existing.length) return existing[0];

  const { default: radiologyService } = await import('../radiology/radiologyService.js');
  const payload = {
    patient_uid: order.patient_uid,
    encounter_id: order.encounter_id,
    modality: fields.modality,
    body_part: fields.bodyPart || 'unspecified',
    clinical_indication: fields.clinicalIndication || fields.testName || `${fields.modality} study`,
    priority: order.priority === 'prn' ? 'routine' : order.priority,
    ordered_by: order.ordered_by,
    notes: investigationNotesFromClinicalOrder(order, details),
    // Contrast intent + any acknowledged override travel on the details keys
    // runRadiologyContrastGate stamped at create time, so radiologyService's
    // own screen re-derives the identical intent and records the override.
    ...(details.contrast_planned !== undefined && details.contrast_planned !== null
      ? { contrast_planned: details.contrast_planned }
      : {}),
    ...(details.contrast_agent ? { contrast_agent: details.contrast_agent } : {}),
    ...(details.contrast_override_reason
      ? {
        contrast_override_reason: details.contrast_override_reason,
        contrast_override_by: order.ordered_by,
      }
      : {}),
  };

  const row = await radiologyService.createOrder(payload, {
    tenantId: order.tenant_id,
    ...(db === prisma ? {} : { tx: db }),
  });
  logger.info(
    `Radiology order ${order.order_number} materialized on the radiology worklist as radiology_orders #${row.id}`,
  );
  return row;
}

async function materializeInvestigationForClinicalOrder(order) {
  const details = parseOrderDetails(order.details);
  const testName = firstText(
    details.test_name,
    details.investigation,
    details.test,
    details.name,
    details.panel_name,
    details.panel,
  );
  if (!testName) {
    logger.warn(`Investigation order ${order.order_number} has no test_name; lab worklist row not created`);
    return null;
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM investigations
      WHERE patient_uid = $1::uuid
        AND notes LIKE $2
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    order.patient_uid,
    `%clinical_order_id:${order.id}%`,
  );
  if (existing.length) return existing[0];

  const patient = await prisma.users.findUnique({
    where: { uid: order.patient_uid },
    select: { id: true },
  });
  if (!patient) {
    logger.warn(`Investigation order ${order.order_number} patient ${order.patient_uid} not found; lab worklist row not created`);
    return null;
  }

  let admissionId = null;
  if (order.encounter_id && order.tenant_id) {
    const admissionRows = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND encounter_id = $3::uuid
        ORDER BY id
        LIMIT 2`,
      order.tenant_id,
      order.patient_uid,
      order.encounter_id,
    );
    if (admissionRows.length > 1) {
      throw AppError.conflict(
        'Clinical order encounter resolves to more than one admission',
        'CLINICAL_ORDER_ADMISSION_AMBIGUOUS',
      );
    }
    admissionId = admissionRows[0]?.id ?? null;
  }

  const payload = {
    patient_id: patient.id,
    orderedBy: order.ordered_by,
    test_name: testName,
    test_code: firstText(details.test_code, details.code),
    type: firstText(details.test_type, details.type) || 'LAB',
    priority: investigationPriorityFromClinicalOrder(order.priority),
    notes: investigationNotesFromClinicalOrder(order, details),
    collection_location: firstText(details.collection_location, details.collection_site),
    collection_deadline_at: details.collection_deadline_at ?? null,
    fasting_required: details.fasting_required ?? null,
    fasting_instructions: firstText(details.fasting_instructions),
    admission_id: admissionId,
    tenantId: order.tenant_id,
  };

  try {
    const result = await createInvestigationOrder(payload);
    logger.info(`Investigation order ${order.order_number} materialized as investigation #${result.investigation.id}`);
    return result.investigation;
  } catch (err) {
    if (err?.code !== 'UNKNOWN_TEST_CODE') throw err;
    logger.warn(
      `Investigation order ${order.order_number} carried unknown test_code=${payload.test_code}; ` +
      'creating lab worklist row without catalog code',
    );
    const result = await createInvestigationOrder({ ...payload, test_code: null });
    logger.info(`Investigation order ${order.order_number} materialized as investigation #${result.investigation.id}`);
    return result.investigation;
  }
}

// ===================================================================
// verifyOrder
// ===================================================================

/**
 * Pharmacist/nurse verification of an order.
 * @param {number} orderId
 * @param {string} verifiedBy - UID of verifier
 * @returns {Object} Updated order
 */
export async function verifyOrder(orderId, verifiedBy) {
  if (!verifiedBy) {
    throw AppError.badRequest('verifiedBy is required');
  }

  const existing = await prisma.clinical_orders.findUnique({
    where: { id: Number(orderId) },
    select: ORDER_RETURNING_SELECT,
  });

  if (!existing) {
    throw AppError.notFound('Order not found');
  }

  if (existing.status !== 'ordered') {
    throw AppError.badRequest(`Cannot verify order in status '${existing.status}'. Order must be in 'ordered' status.`);
  }

  // Atomic clinical write (canonical timeline invariant): status change +
  // canonical timeline/audit events persist together or not at all.
  const updated = await setTenantTx(requireTenantId(existing.tenant_id), async (tx) => {
    // M6 (audit 2026-06-22): guard the expected status in the UPDATE itself, not
    // just the pre-check read. A single conditional updateMany serialises on the
    // row lock; count===0 means a concurrent transition already moved the order
    // off 'ordered' → reject, instead of a second verify writing a duplicate
    // canonical event / clobbering the first transition.
    const reserved = await tx.clinical_orders.updateMany({
      where: { id: existing.id, status: 'ordered' },
      data: {
        status: 'verified',
        verified_by: verifiedBy,
        verified_at: new Date(),
      },
    });
    if (reserved.count === 0) {
      throw AppError.conflict(`Order ${existing.order_number} is no longer in 'ordered' status (changed concurrently)`);
    }
    const row = await tx.clinical_orders.findUnique({
      where: { id: existing.id },
      select: ORDER_RETURNING_SELECT,
    });

    await recordCanonicalOrderEvent({
      order: row,
      tx,
      eventType: 'order.verified',
      eventStatus: row.status,
      actorUid: verifiedBy,
      previousStatus: existing.status,
    });
    return row;
  });

  logger.info(`Order ${updated.order_number} verified by ${verifiedBy}`);
  return updated;
}

// ===================================================================
// completeOrder
// ===================================================================

/**
 * Mark an order as completed.
 * @param {number} orderId
 * @param {string} completedBy - UID of completer
 * @returns {Object} Updated order
 */
export async function completeOrder(orderId, completedBy) {
  if (!completedBy) {
    throw AppError.badRequest('completedBy is required');
  }

  const existing = await prisma.clinical_orders.findUnique({
    where: { id: Number(orderId) },
    select: ORDER_RETURNING_SELECT,
  });

  if (!existing) {
    throw AppError.notFound('Order not found');
  }

  const allowedStatuses = ['ordered', 'verified', 'in_progress'];
  if (!allowedStatuses.includes(existing.status)) {
    throw AppError.badRequest(`Cannot complete order in status '${existing.status}'`);
  }

  // Atomic clinical write (canonical timeline invariant): status change +
  // canonical timeline/audit events persist together or not at all.
  const updated = await setTenantTx(requireTenantId(existing.tenant_id), async (tx) => {
    // M6: atomic status guard (see verifyOrder). count===0 → a concurrent
    // transition already left the completable set → reject.
    const reserved = await tx.clinical_orders.updateMany({
      where: { id: existing.id, status: { in: allowedStatuses } },
      data: {
        status: 'completed',
        completed_by: completedBy,
        completed_at: new Date(),
      },
    });
    if (reserved.count === 0) {
      throw AppError.conflict(`Order ${existing.order_number} can no longer be completed (status changed concurrently)`);
    }
    const row = await tx.clinical_orders.findUnique({
      where: { id: existing.id },
      select: ORDER_RETURNING_SELECT,
    });

    await recordCanonicalOrderEvent({
      order: row,
      tx,
      eventType: 'order.completed',
      eventStatus: row.status,
      actorUid: completedBy,
      previousStatus: existing.status,
    });
    return row;
  });

  logger.info(`Order ${updated.order_number} completed by ${completedBy}`);
  return updated;
}

// ===================================================================
// cancelOrder
// ===================================================================

/**
 * Cancel an order with a reason.
 * @param {number} orderId
 * @param {string} cancelledBy - UID
 * @param {string} reason - Cancellation reason
 * @returns {Object} Updated order
 */
export async function cancelOrder(orderId, cancelledBy, reason) {
  if (!cancelledBy || !reason) {
    throw AppError.badRequest('cancelledBy and reason are required');
  }

  const existing = await prisma.clinical_orders.findUnique({
    where: { id: Number(orderId) },
    select: ORDER_RETURNING_SELECT,
  });

  if (!existing) {
    throw AppError.notFound('Order not found');
  }

  if (['completed', 'cancelled', 'discontinued'].includes(existing.status)) {
    throw AppError.badRequest(`Cannot cancel order in status '${existing.status}'`);
  }

  // Atomic clinical write (canonical timeline invariant): status change +
  // canonical timeline/audit events persist together or not at all.
  const updated = await setTenantTx(requireTenantId(existing.tenant_id), async (tx) => {
    // M6: atomic status guard (see verifyOrder). A terminal order (completed/
    // cancelled/discontinued) can't be cancelled; count===0 → reject.
    const reserved = await tx.clinical_orders.updateMany({
      where: { id: existing.id, status: { notIn: ['completed', 'cancelled', 'discontinued'] } },
      data: {
        status: 'cancelled',
        cancelled_by: cancelledBy,
        cancel_reason: reason,
      },
    });
    if (reserved.count === 0) {
      throw AppError.conflict(`Order ${existing.order_number} can no longer be cancelled (status changed concurrently)`);
    }
    const row = await tx.clinical_orders.findUnique({
      where: { id: existing.id },
      select: ORDER_RETURNING_SELECT,
    });

    await recordCanonicalOrderEvent({
      order: row,
      tx,
      eventType: 'order.cancelled',
      eventStatus: row.status,
      actorUid: cancelledBy,
      previousStatus: existing.status,
      payload: { cancel_reason: reason },
    });
    return row;
  });

  logger.info(`Order ${updated.order_number} cancelled by ${cancelledBy}: ${reason}`);
  return updated;
}

// ===================================================================
// discontinueOrder
// ===================================================================

/**
 * Discontinue an ongoing order.
 * @param {number} orderId
 * @param {string} discontinuedBy - UID
 * @param {string} reason - Discontinuation reason
 * @returns {Object} Updated order
 */
export async function discontinueOrder(orderId, discontinuedBy, reason) {
  if (!discontinuedBy || !reason) {
    throw AppError.badRequest('discontinuedBy and reason are required');
  }

  const existing = await prisma.clinical_orders.findUnique({
    where: { id: Number(orderId) },
    select: ORDER_RETURNING_SELECT,
  });

  if (!existing) {
    throw AppError.notFound('Order not found');
  }

  const allowedStatuses = ['ordered', 'verified', 'in_progress'];
  if (!allowedStatuses.includes(existing.status)) {
    throw AppError.badRequest(`Cannot discontinue order in status '${existing.status}'`);
  }

  // Atomic clinical write (canonical timeline invariant): status change +
  // canonical timeline/audit events persist together or not at all.
  const updated = await setTenantTx(requireTenantId(existing.tenant_id), async (tx) => {
    // M6: atomic status guard (see verifyOrder). count===0 → a concurrent
    // transition already left the discontinuable set → reject.
    const reserved = await tx.clinical_orders.updateMany({
      where: { id: existing.id, status: { in: allowedStatuses } },
      data: {
        status: 'discontinued',
        cancelled_by: discontinuedBy,
        cancel_reason: reason,
        end_date: new Date(),
      },
    });
    if (reserved.count === 0) {
      throw AppError.conflict(`Order ${existing.order_number} can no longer be discontinued (status changed concurrently)`);
    }
    const row = await tx.clinical_orders.findUnique({
      where: { id: existing.id },
      select: ORDER_RETURNING_SELECT,
    });

    await recordCanonicalOrderEvent({
      order: row,
      tx,
      eventType: 'order.discontinued',
      eventStatus: row.status,
      actorUid: discontinuedBy,
      previousStatus: existing.status,
      payload: { discontinue_reason: reason },
    });
    return row;
  });

  logger.info(`Order ${updated.order_number} discontinued by ${discontinuedBy}: ${reason}`);
  return updated;
}

// ===================================================================
// getPatientOrders
// ===================================================================

/**
 * List orders for a patient with filters.
 * @param {string} patientUid
 * @param {Object} filters - { order_type?, status?, date_from?, date_to?, page?, limit? }
 * @returns {Object} { orders, pagination }
 */
export async function getPatientOrders(patientUid, filters = {}) {
  const { order_type, status, date_from, date_to } = filters;
  const listQuery = parseListQuery(filters, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'created_at'
  });

  const where = { patient_uid: patientUid };
  if (order_type) where.order_type = order_type;
  if (status) where.status = status;
  if (date_from || date_to) {
    where.created_at = {};
    if (date_from) where.created_at.gte = new Date(date_from);
    if (date_to) where.created_at.lte = new Date(date_to);
  }

  const [total, orders] = await Promise.all([
    prisma.clinical_orders.count({ where }),
    prisma.clinical_orders.findMany({
      where,
      select: ORDER_RETURNING_SELECT,
      orderBy: { created_at: 'desc' },
      take: listQuery.limit,
      skip: listQuery.offset,
    }),
  ]);
  const pagination = buildPagination(total, listQuery.page, listQuery.limit);

  return {
    orders,
    pagination,
  };
}

// ===================================================================
// getEncounterOrders
// ===================================================================

/**
 * Get all orders for an encounter/admission.
 * @param {string} encounterId - UUID
 * @returns {Array} Orders sorted by created_at
 */
export async function getEncounterOrders(encounterId) {
  return prisma.clinical_orders.findMany({
    where: { encounter_id: encounterId },
    select: ORDER_RETURNING_SELECT,
    orderBy: { created_at: 'desc' },
  });
}

// ===================================================================
// applyOrderSet
// ===================================================================

// Map an item.kind from clinical_order_set_items to the createOrder
// order_type enum. `note` and `monitor` are nursing-handover items;
// `vitals` is a nursing observation. `other` keeps the existing
// permissive default. Unmapped kinds fall through to 'nursing'.
const ITEM_KIND_TO_ORDER_TYPE = {
  med: 'medication',
  lab: 'investigation',
  radiology: 'investigation',
  diet: 'diet',
  nursing: 'nursing',
  vitals: 'nursing',
  consult: 'consultation',
  note: 'nursing',
  monitor: 'nursing',
  other: 'nursing',
};

// `clinical_order_set_items.payload` is one JSONB blob per item with
// a kind-specific shape (med: drug/dose/route/frequency, lab:
// test_code/test_name, etc.). createOrder expects a non-empty `details`
// object; we pass payload through and let downstream consumers branch
// on payload shape via order_type. A best-effort priority hint is
// pulled from the payload's `urgency` ('stat'|'routine'|...) field —
// the chest-pain bundle marks ECG/troponin as stat that way.
//
// D56 — Chest-pain order set items for ECG/X-ray/ECHO used to land
// on the lab worklist because the seeded template gave them
// `kind: 'lab'`. Investigations carry their modality on
// `details.test_type` (CARDIOLOGY / RADIOLOGY / PULMONARY /
// ENDOSCOPY), and `listLabWorklist` already EXCLUDES non-LAB types —
// so the simplest fix is to infer the correct `test_type` from the
// payload's test name/code/modality whenever the caller didn't set
// it. Inference is intentionally conservative — if no recognisable
// pattern fires we leave `test_type` alone so the existing default
// ('LAB') still applies.
const TEST_TYPE_INFERENCE = [
  // Cardiology (ECG / EKG / 12-lead / treadmill / echo / cath).
  { regex: /\b(ecg|ekg|electrocardiogram|12.?lead|treadmill|tmt|echo(cardiogram)?|holter|angiograph(y|ic)|cath\s+lab)\b/i, type: 'CARDIOLOGY' },
  // Radiology (x-ray, CT, MRI, US, mammogram, fluoroscopy). The CT
  // pattern matches as a whole word OR followed by a word-boundary
  // (so "CT_HEAD" / "CT-CHEST" / "CT abdomen" all hit).
  { regex: /\b(x.?ray|xray|cxr|chest\s+film|ct[_\-\s]|\bct\b|computed\s+tomograph|mri\b|magnetic\s+resonance|ultrasound|us\b|usg\b|sonograph|mammogram|fluoroscop)/i, type: 'RADIOLOGY' },
  // Pulmonary (PFT / spirometry / DLCO / ABG).
  { regex: /\b(pft|spirometry|dlco|peak\s+flow|abg|arterial\s+blood\s+gas)\b/i, type: 'PULMONARY' },
  // Endoscopy (OGD / colonoscopy / bronchoscopy).
  { regex: /\b(ogd|gastroscop|colonoscop|bronchoscop|cystoscop|endoscop|sigmoidoscop)/i, type: 'ENDOSCOPY' },
];
function inferTestType(payload) {
  const haystack = [
    payload.test_name, payload.test_code, payload.name,
    payload.code, payload.modality, payload.investigation_type,
  ].filter(Boolean).join(' ');
  if (!haystack) return null;
  for (const rule of TEST_TYPE_INFERENCE) {
    if (rule.regex.test(haystack)) return rule.type;
  }
  return null;
}
export function orderRequestFromItem(item, orderSetTitle) {
  const payload = item.payload && typeof item.payload === 'object'
    ? { ...item.payload } : {};
  const priority = typeof payload.urgency === 'string' && VALID_PRIORITIES.includes(payload.urgency.toLowerCase())
    ? payload.urgency.toLowerCase()
    : (payload.prn ? 'prn' : 'routine');
  // Stamp inferred test_type only when caller hasn't already set one,
  // so explicitly-typed items always win.
  const orderType = ITEM_KIND_TO_ORDER_TYPE[item.kind] || 'nursing';
  if (orderType === 'investigation'
      && !payload.test_type
      && !payload.investigation_type) {
    const inferred = inferTestType(payload);
    if (inferred) payload.test_type = inferred;
  }
  return {
    order_type: orderType,
    priority,
    details: payload,
    notes: `From order set: ${orderSetTitle}`,
  };
}

// Hydrate a clinical_order_sets row + its items into the legacy
// `{ id, name, description, category, orders, is_active, created_at,
// created_by }` shape so /emr/order-sets consumers don't have to learn
// the new normalised schema.
function shapeOrderSetForResponse(set, items = []) {
  return {
    id: set.id,
    name: set.title,
    description: set.description ?? null,
    category: set.specialty ?? null,
    orders: items.map((it) => ({
      ...orderRequestFromItem(it, set.title),
      kind: it.kind,
      display_order: it.display_order,
      default_selected: it.default_selected,
      payload: it.payload,
    })),
    created_by: set.created_by ?? null,
    is_active: set.active,
    created_at: set.created_at,
  };
}

/**
 * Apply a predefined order set bundle, creating multiple orders at once.
 * @param {string} patientUid
 * @param {string|null} encounterId
 * @param {number} orderSetId
 * @param {string} orderedBy - UID
 * @param {string|null} [tenantId]
 * @returns {Array} Created orders
 */
export async function applyOrderSet(patientUid, encounterId, orderSetId, orderedBy, tenantId = null) {
  if (!patientUid || !orderSetId || !orderedBy) {
    throw AppError.badRequest('patientUid, orderSetId, and orderedBy are required');
  }

  const scopedTenantId = tenantId ? requireTenantId(tenantId) : null;
  const set = await prisma.clinical_order_sets.findFirst({
    where: {
      id: Number(orderSetId),
      ...(scopedTenantId ? { tenant_id: scopedTenantId } : {}),
    },
    select: {
      id: true,
      code: true,
      title: true,
      active: true,
      family_key: true,
      version: true,
      status: true,
    },
  });

  if (!set) {
    throw AppError.notFound('Order set not found');
  }

  if (!set.active || set.status !== 'approved') {
    throw AppError.badRequest('Order set is not deployed');
  }

  const items = await prisma.clinical_order_set_items.findMany({
    where: {
      order_set_id: set.id,
      ...(scopedTenantId ? { tenant_id: scopedTenantId } : {}),
    },
    orderBy: { display_order: 'asc' },
  });

  if (!items.length) {
    throw AppError.badRequest('Order set has no order templates');
  }

  const createdOrders = [];

  for (const item of items) {
    try {
      const req = orderRequestFromItem(item, set.title);
      const details = {
        ...req.details,
        order_set_family: set.family_key || set.code,
        order_set_version: set.version || 1,
      };
      const result = await createOrder({
        encounter_id: encounterId || null,
        patient_uid: patientUid,
        order_type: req.order_type,
        priority: req.priority,
        details,
        ordered_by: orderedBy,
        start_date: null,
        end_date: null,
        notes: req.notes,
        tenantId: scopedTenantId,
      });
      createdOrders.push(result);
    } catch (err) {
      // Log but continue — partial application is acceptable. Don't
      // surface err.message to the response (per CLAUDE.md security
      // checklist); the caller sees the count of successful orders.
      logger.warn(`Failed to create order from set template (kind=${item.kind}): ${err.message}`);
      createdOrders.push({
        error: 'Order template could not be applied',
        kind: item.kind,
        code: err.code || 'ORDER_SET_ITEM_FAILED',
        statusCode: err.statusCode || 500,
      });
    }
  }

  logger.info(`Order set '${set.title}' (id=${set.id}) applied for patient=${patientUid} by=${orderedBy}, ${createdOrders.length} orders`);
  return createdOrders;
}

// ===================================================================
// getOrderSets
// ===================================================================

/**
 * List available order sets, optionally filtered by category (mapped to
 * `specialty` on `clinical_order_sets`).
 * @param {string|null} category
 * @returns {Array} Order sets
 */
export async function getOrderSets(category) {
  const where = { active: true, status: 'approved' };
  if (category) {
    // The legacy API accepted free-form category strings ('emergency',
    // 'cardiology'); migrate that to substring match against `specialty`
    // so 'emergency' still matches 'critical_care' / 'cardiology' bundles
    // that have ICD-10 codes for ER conditions.
    where.OR = [
      { specialty: category },
      { specialty: { contains: category, mode: 'insensitive' } },
    ];
  }
  const sets = await prisma.clinical_order_sets.findMany({
    where,
    orderBy: { title: 'asc' },
  });
  if (!sets.length) return [];
  const setIds = sets.map((s) => s.id);
  const items = await prisma.clinical_order_set_items.findMany({
    where: { order_set_id: { in: setIds } },
    orderBy: [{ order_set_id: 'asc' }, { display_order: 'asc' }],
  });
  const itemsBySet = new Map();
  for (const it of items) {
    if (!itemsBySet.has(it.order_set_id)) itemsBySet.set(it.order_set_id, []);
    itemsBySet.get(it.order_set_id).push(it);
  }
  return sets.map((s) => shapeOrderSetForResponse(s, itemsBySet.get(s.id) || []));
}

// ===================================================================
// createOrderSet
// ===================================================================

/**
 * Create a new order set template.
 * @param {Object} data - { name, description?, category, orders, created_by, tenantId? }
 * @returns {Object} Created order set
 */
export async function createOrderSet(data) {
  const {
    name, description, category, orders, created_by, tenantId = null,
  } = data;

  if (!name || !category || !orders || !created_by) {
    throw AppError.badRequest('name, category, orders, and created_by are required');
  }

  if (!Array.isArray(orders) || orders.length === 0) {
    throw AppError.badRequest('orders must be a non-empty array of order templates');
  }

  // Validate each order template has required fields
  for (const tmpl of orders) {
    if (!tmpl.order_type || !tmpl.details) {
      throw AppError.badRequest('Each order template must have order_type and details');
    }
    if (!VALID_ORDER_TYPES.includes(tmpl.order_type)) {
      throw AppError.badRequest(`Invalid order_type in template: ${tmpl.order_type}`);
    }
  }

  // Map the legacy `order_type` strings to the new `kind` enum on
  // clinical_order_set_items. Inverse of ITEM_KIND_TO_ORDER_TYPE.
  const orderTypeToKind = {
    medication: 'med',
    investigation: 'lab',
    nursing: 'nursing',
    diet: 'diet',
    activity: 'nursing',
    consultation: 'consult',
  };

  const code = `ORDERSET-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 50)}-${Date.now()}`;

  // RLS tenant scope (Batch 3 Wave B-prime): clinical_order_sets carries a
  // tenant_isolation policy, so the insert must run with app.current_tenant_id
  // set. tenantId is threaded from the caller's req.tenantId; default keeps
  // single-tenant / test callers green.
  const scopedTenantId = requireTenantId(tenantId);
  const studioEnabled = await isContentStudioEnabled(scopedTenantId);
  const initialStatus = studioEnabled ? 'draft' : 'approved';
  const created = await setTenantTx(scopedTenantId, async (tx) => {
    const set = await tx.clinical_order_sets.create({
      data: {
        code: code.slice(0, 60),
        family_key: code.slice(0, 60),
        version: 1,
        status: initialStatus,
        approved_by: studioEnabled ? null : created_by,
        approved_at: studioEnabled ? null : new Date(),
        source: 'authored',
        title: name,
        specialty: category,
        description: description ?? null,
        active: true,
        created_by,
      },
    });
    const itemRows = await Promise.all(orders.map((tmpl, i) => tx.clinical_order_set_items.create({
      data: {
        order_set_id: set.id,
        display_order: i + 1,
        kind: orderTypeToKind[tmpl.order_type] || 'other',
        payload: tmpl.details,
      },
    })));
    return shapeOrderSetForResponse(set, itemRows);
  });

  logger.info(`Order set created: id=${created.id}, name=${name}, category=${category}, by=${created_by}`);
  return created;
}

// Test-only export for unit-testing the per-item routing/inference logic
// without spinning up the full prisma transaction surface.
export const __test_orderRequestFromItem = orderRequestFromItem;

export default {
  createOrder,
  createOrdersBulk,
  verifyOrder,
  completeOrder,
  cancelOrder,
  discontinueOrder,
  getPatientOrders,
  getEncounterOrders,
  applyOrderSet,
  getOrderSets,
  createOrderSet,
};
