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
import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { MAR_SCHEDULE_LIMITS } from '../../config/pharmacyConfig.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isDoctor } from '../../utils/roleHelpers.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { hashRequestBody, isValidIdempotencyKey } from '../idempotency/idempotencyService.js';
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
import {
  expandSchedule,
  scheduleMedications,
  terminallyProjectMedicationOrderDosesTx,
} from '../clinical/marService.js';
import { recordFirstDrugChartEntry } from '../clinical/drugChartSlaService.js';
import { canonicalMedicationRoute } from '../clinical/medicationRoute.js';
import { createWardIndentForClinicalMedicationOrder } from '../ipd/ipdSupportService.js';
import {
  bindMedicationOrderCatalogAuthority,
  loadMedicationCatalogAuthorityTx,
  lockMedicationOrderWardIndentTx,
  terminallyProjectMedicationOrderWardIndentTx
} from '../ipd/wardIndentWorkflowService.js';
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
import { recordBrandSubstitutionAudit } from '../pharmacy/compositionSubstitutionAudit.js';
import { isContentStudioEnabled } from './orderSetContentStudioSettingsService.js';
import { persistClinicalAlertFailureWithCanonical } from '../clinical/clinicalAlertDeliveryObligationService.js';


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

export function canTerminalMedicationOrderRole(role) {
  return isDoctor(String(role || '').trim().toUpperCase());
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_COMMAND_KEY_PATTERN = /^[A-Za-z0-9_\-:.]+$/;

function normalizeClinicalOrderCreateCommand(options, {
  actorUid,
  operation,
} = {}) {
  const supplied = [
    options?.commandKey,
    options?.requestFingerprint,
    options?.httpIdempotencyClaimId,
  ].some((value) => value != null);
  if (!supplied) return null;
  const claimId = Number(options.httpIdempotencyClaimId);
  const commandKey = String(options.commandKey || '');
  const requestFingerprint = String(options.requestFingerprint || '');
  if (
    !Number.isSafeInteger(claimId)
    || claimId < 1
    || commandKey.length < 1
    || commandKey.length > 200
    || commandKey !== commandKey.trim()
    || !TERMINAL_COMMAND_KEY_PATTERN.test(commandKey)
    || !SHA256_PATTERN.test(requestFingerprint)
  ) {
    throw AppError.badRequest(
      'Clinical-order create idempotency identity is invalid',
      'CLINICAL_ORDER_CREATE_IDEMPOTENCY_INVALID',
    );
  }
  const normalizedOperation =
    operation === 'apply_set' ? 'apply_set' : operation === 'bulk' ? 'bulk' : 'single';
  return {
    actorUid: String(actorUid),
    claimId,
    commandKey,
    operation: normalizedOperation,
    requestFingerprint,
    requestId: options.requestId ? String(options.requestId) : null,
    requestPath:
      normalizedOperation === 'apply_set'
        ? '/api/v1/emr/orders/apply-set'
        : normalizedOperation === 'bulk'
          ? '/api/v1/emr/orders/bulk'
          : '/api/v1/emr/orders'
  };
}

async function finaliseClinicalOrderCreateHttpReceiptTx(tx, {
  tenantId,
  command,
  responseData,
}) {
  if (!command) return null;
  const message =
    command.operation === 'single'
      ? 'Order created'
      : command.operation === 'apply_set'
        ? 'Order set applied'
        : `${responseData.length} orders created`;
  const responseBody = {
    success: true,
    message,
    data: responseData,
    ...(command.requestId ? { requestId: command.requestId } : {}),
  };
  const rows = await tx.$queryRawUnsafe(
    `UPDATE idempotency_keys
        SET status = 'complete',
            response_status = 201,
            response_body = $6::jsonb,
            updated_at = NOW()
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND user_uid = $3::uuid
        AND request_key = $4::text
        AND request_body_hash = $5::char(64)
        AND request_method = 'POST'
        AND request_path = $7::text
        AND status = 'in_flight'
      RETURNING id`,
    command.claimId,
    tenantId,
    command.actorUid,
    command.commandKey,
    command.requestFingerprint,
    JSON.stringify(responseBody),
    command.requestPath,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Clinical-order create idempotency claim changed before commit',
      'CLINICAL_ORDER_CREATE_IDEMPOTENCY_CHANGED',
    );
  }
  return rows[0];
}

async function lockMedicationCdsScopesTx(tx, tenantId, orders) {
  const patientUids = [...new Set(
    orders
      .filter((order) => order.order_type === 'medication')
      .map((order) => String(order.patient_uid)),
  )].sort();
  for (const patientUid of patientUids) {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(
                hashtextextended($1::text, 0)
              )::text AS lock_acquired`,
      `clinical-order-medication-cds:${tenantId}:${patientUid}`,
    );
  }
}

function normalizeClinicalOrderTerminalCommand(options, {
  orderId,
  actorUid,
  action,
} = {}) {
  const supplied = [
    options?.commandKey,
    options?.requestFingerprint,
    options?.httpIdempotencyClaimId,
  ].some((value) => value != null);
  if (!supplied) return null;
  const claimId = Number(options.httpIdempotencyClaimId);
  const commandKey = String(options.commandKey || '');
  const requestFingerprint = String(options.requestFingerprint || '');
  if (
    !Number.isSafeInteger(claimId)
    || claimId < 1
    || commandKey.length < 1
    || commandKey.length > 200
    || commandKey !== commandKey.trim()
    || !TERMINAL_COMMAND_KEY_PATTERN.test(commandKey)
    || !SHA256_PATTERN.test(requestFingerprint)
  ) {
    throw AppError.badRequest(
      'Clinical-order terminal idempotency identity is invalid',
      'CLINICAL_ORDER_TERMINAL_IDEMPOTENCY_INVALID',
    );
  }
  return {
    action,
    actorUid: String(actorUid),
    claimId,
    commandKey,
    requestFingerprint,
    requestId: options.requestId ? String(options.requestId) : null,
    requestPath: `/api/v1/emr/orders/${Number(orderId)}/terminal`,
  };
}

async function finaliseClinicalOrderTerminalHttpReceiptTx(tx, {
  tenantId,
  command,
  responseData,
}) {
  if (!command) return null;
  const messages = {
    completed: 'Order completed',
    cancelled: 'Order cancelled',
    discontinued: 'Order discontinued',
  };
  const responseBody = {
    success: true,
    message: messages[command.action],
    data: responseData,
    ...(command.requestId ? { requestId: command.requestId } : {}),
  };
  const rows = await tx.$queryRawUnsafe(
    `UPDATE idempotency_keys
        SET status = 'complete',
            response_status = 200,
            response_body = $6::jsonb,
            updated_at = NOW()
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND user_uid = $3::uuid
        AND request_key = $4::text
        AND request_body_hash = $5::char(64)
        AND request_method = 'PUT'
        AND request_path = $7::text
        AND status = 'in_flight'
      RETURNING id`,
    command.claimId,
    tenantId,
    command.actorUid,
    command.commandKey,
    command.requestFingerprint,
    JSON.stringify(responseBody),
    command.requestPath,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Clinical-order terminal idempotency claim changed before commit',
      'CLINICAL_ORDER_TERMINAL_IDEMPOTENCY_CHANGED',
    );
  }
  return rows[0];
}

async function lockTerminalOrderAndAuthorizeTx(tx, {
  tenantId,
  orderId,
  actorUid,
  allowedStatuses = null,
  disallowedStatuses = [],
  action,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, status, order_type, verified_by::text, verified_at
       FROM clinical_orders
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    Number(orderId),
  );
  const current = rows[0];
  if (!current) throw AppError.notFound('Order not found');
  const currentStatus = String(current.status || '').toLowerCase();
  if (
    (allowedStatuses && !allowedStatuses.includes(currentStatus))
    || disallowedStatuses.includes(currentStatus)
  ) {
    throw AppError.conflict(
      `Order can no longer be ${action} (status changed concurrently)`,
      'CLINICAL_ORDER_TERMINAL_STATE_CONFLICT',
      { clinical_order_id: Number(orderId), status: current.status || null },
    );
  }
  if (current.order_type !== 'medication') return current;
  if (
    action === 'completed'
    && (
      !['verified', 'in_progress'].includes(currentStatus)
      || !current.verified_by
      || !current.verified_at
    )
  ) {
    throw AppError.conflict(
      'A medication order must be explicitly verified before completion; cancel a never-verified order',
      'MEDICATION_ORDER_COMPLETION_VERIFICATION_REQUIRED',
      { clinical_order_id: Number(orderId), status: current.status || null },
    );
  }
  const actorRows = await tx.$queryRawUnsafe(
    `SELECT role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND COALESCE(is_deleted, FALSE) = FALSE
        AND deleted_at IS NULL
        AND LOWER(COALESCE(status, 'active')) = 'active'
      LIMIT 1
      FOR SHARE`,
    tenantId,
    actorUid,
  );
  if (!canTerminalMedicationOrderRole(actorRows[0]?.role)) {
    throw AppError.forbidden(
      'Only an active prescriber may complete, cancel, or discontinue a medication order',
      'MEDICATION_ORDER_TERMINAL_PRESCRIBER_REQUIRED',
    );
  }
  return current;
}

async function loadActiveClinicalActorTx(tx, { tenantId, actorUid, errorCode, errorMessage }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid::text, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND COALESCE(is_deleted, FALSE) = FALSE
        AND deleted_at IS NULL
        AND LOWER(COALESCE(status, 'active')) = 'active'
      LIMIT 1
      FOR SHARE`,
    tenantId,
    actorUid
  );
  if (!rows[0]) throw AppError.forbidden(errorMessage, errorCode);
  return rows[0];
}

const NURSING_ORDER_VERIFY_ROLES = new Set([
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'ICU_NURSE',
  'ICU_INCHARGE',
]);

const PHARMACY_MEDICATION_ORDER_VERIFY_ROLES = new Set([
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
  'PHARMACIST',
]);

export function canVerifyMedicationOrderRole(role) {
  const normalizedRole = String(role || '').trim().toUpperCase();
  return NURSING_ORDER_VERIFY_ROLES.has(normalizedRole)
    || PHARMACY_MEDICATION_ORDER_VERIFY_ROLES.has(normalizedRole);
}

export function canVerifyClinicalOrderType(role, orderType) {
  const normalizedRole = String(role || '').trim().toUpperCase();
  const normalizedType = String(orderType || '').trim().toLowerCase();
  if (!VALID_ORDER_TYPES.includes(normalizedType)) return false;
  if (NURSING_ORDER_VERIFY_ROLES.has(normalizedRole)) return true;
  return normalizedType === 'medication'
    && PHARMACY_MEDICATION_ORDER_VERIFY_ROLES.has(normalizedRole);
}

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

function radiologyContrastStudyTextInputs(details = {}, { notes = null } = {}) {
  const values = [
    details.test_name, details.testName, details.study, details.name,
    details.test, details.investigation, details.procedure,
    details.body_part, details.bodyPart,
    details.reason, details.clinical_indication, details.clinicalIndication,
    details.indication, details.notes, notes,
  ];
  return [...new Set(values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
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

const CPOE_CONTRAST_INTENT_CONTRACT = 'cpoe_radiology_contrast_v1';
const CPOE_CONTRAST_INTENT_SOURCES = new Set([
  'explicit',
  'agent_named',
  'study_text',
  'modality_presumed',
  'explicitly_negated',
  'modality_not_presumed',
]);

function persistedCpoeContrastIntent(details = {}, modality = null) {
  const persisted = details.contrast_intent;
  if (persisted == null) return deriveCpoeContrastIntent(details, modality);
  if (
    typeof persisted !== 'object'
    || Array.isArray(persisted)
    || persisted.contract !== CPOE_CONTRAST_INTENT_CONTRACT
    || typeof persisted.planned !== 'boolean'
    || !CPOE_CONTRAST_INTENT_SOURCES.has(persisted.source)
  ) {
    throw AppError.conflict(
      'Persisted radiology contrast intent is invalid',
      'RADIOLOGY_CONTRAST_INTENT_INVALID',
    );
  }
  const agent = firstText(persisted.agent);
  const compatible = deriveCpoeContrastIntent({
    ...details,
    contrast_planned: persisted.planned,
    contrast_agent: agent,
  }, modality);
  if (
    compatible.contrastPlanned !== persisted.planned
    || compatible.contrastAgent !== agent
  ) {
    throw AppError.conflict(
      'Persisted radiology contrast intent contradicts the clinical order details',
      'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION',
    );
  }
  return {
    contrastPlanned: persisted.planned,
    contrastAgent: agent,
    intentSource: persisted.source,
  };
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
  // Screening and worklist materialization must consume the same effective
  // indication. Staff sends it as details.reason, while other callers may use
  // clinical_indication/indication or the top-level notes fallback. Promote
  // that normalized value into the existing narrowly matched study-text field
  // before deriving and persist it with the resulting intent contract.
  const intentDetails = {
    ...n.details,
    clinical_indication: fields.clinicalIndication,
  };
  const intent = deriveCpoeContrastIntent({
    ...intentDetails,
    contrastStudyTextInputs: radiologyContrastStudyTextInputs(n.details, { notes: n.notes }),
  }, fields.modality);
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
    ...intentDetails,
    modality: fields.modality,
    body_part: fields.bodyPart || 'unspecified',
    contrast_planned: intent.contrastPlanned,
    contrast_agent: intent.contrastAgent,
    contrast_intent_source: intent.intentSource,
    contrast_intent: {
      contract: CPOE_CONTRAST_INTENT_CONTRACT,
      planned: intent.contrastPlanned,
      agent: intent.contrastAgent,
      source: intent.intentSource,
    },
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
async function generateOrderNumbers(count, db = prisma) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `ORD-${today}-`;

  // Last order issued today (LIKE 'ORD-YYYYMMDD-%' ORDER BY id DESC LIMIT 1).
  const last = await db.clinical_orders.findFirst({
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

async function generateOrderNumbersTx(tx, count) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(
              hashtextextended($1::text, 0)
            )::text AS lock_acquired`,
    `clinical-order-number:${today}`,
  );
  return generateOrderNumbers(count, tx);
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
async function runCDSChecks(patientUid, orderType, details, tenantId = null, db = prisma) {
  const result = { safe: true, warnings: [], blockers: [] };

  try {
    if (orderType === 'medication' && details.medication_name) {
      // validatePrescriptionSafety is integer-keyed — its queries join
      // users.id / patient_allergies.patient_id / e_prescriptions.patient_id
      // as ints. CPOE orders only carry the UUID patient_uid, so resolve it
      // to the int users.id first. Passing the UUID straight through made
      // every medication order's safety check fail closed with a generic
      // blocker (`operator does not exist: integer = text`).
      const patientRow = await db.users.findUnique({
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
      ], { tenantId, db });

      result.warnings = safetyResult.warnings || [];
      result.blockers = safetyResult.blockers || [];

      // Add active inpatient medications to the interaction screen. The
      // prescription checker's OPD duplicate query cannot see CPOE/IPD orders,
      // so without this a new inpatient drug could silently conflict with the
      // patient's current drug chart.
      const activeRows = await db.$queryRawUnsafe(
        `SELECT details
           FROM clinical_orders
          WHERE patient_uid = $1::uuid
            AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
            AND order_type = 'medication'
            AND COALESCE(status, 'ordered') !~* '(cancelled|canceled|discontinued|stopped|on[\\s_-]?hold|suspended|completed)'
          ORDER BY created_at DESC
          LIMIT 100`,
        patientUid,
        tenantId,
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
  metadata = {},
  timelineIdempotencyKey = null,
  auditIdempotencyKey = null,
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
    metadata,
    tags: ['clinical_order', order.order_type].filter(Boolean),
    timelineIdempotencyKey: timelineIdempotencyKey
      || `clinical_orders:${order.id}:${eventType}:${status || 'none'}:${stamp}`,
    auditIdempotencyKey: auditIdempotencyKey
      || `clinical_orders:${order.id}:audit:${eventType}:${status || 'none'}:${stamp}`,
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
const MEDICATION_WARD_SUPPLY_UNITS = [
  'tablet',
  'capsule',
  'ampoule',
  'vial',
  'bag',
  'prefilled syringe',
  'cartridge',
  'mL',
  'dose',
  'patch',
  'actuation',
  'spray',
  'application',
  'bottle',
  'tube',
  'sachet',
  'suppository',
  'drop',
  'kit',
  'each',
];
function canonicalMedicationWardSupplyUnit(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  return MEDICATION_WARD_SUPPLY_UNITS.find(
    (unit) => unit.toLowerCase() === value.toLowerCase(),
  ) || null;
}

function parseMedicationWardSupplyQuantity(raw) {
  const value = String(raw ?? '').trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 && quantity <= 99999999.99
    ? quantity
    : null;
}

function parseMedicationCatalogId(raw) {
  const catalogId = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^[1-9]\d*$/.test(raw.trim())
      ? Number(raw.trim())
      : null;
  return Number.isSafeInteger(catalogId) && catalogId > 0 && catalogId <= 2147483647
    ? catalogId
    : null;
}

export function normalizeMedicationWardSupplyDetails(rawDetails) {
  if (!rawDetails || typeof rawDetails !== 'object' || Array.isArray(rawDetails)) {
    throw AppError.badRequest(
      'Medication order details must be an object',
      'CLINICAL_ORDER_MEDICATION_DETAILS_INVALID',
    );
  }
  const details = { ...rawDetails };
  const dose = firstText(details.dose, details.dosage);
  if (!dose) {
    throw AppError.badRequest(
      'MAR-bound medication orders require an explicit dose',
      'CLINICAL_ORDER_MEDICATION_DOSE_REQUIRED'
    );
  }
  const route = firstText(details.route);
  if (!route) {
    throw AppError.badRequest(
      'MAR-bound medication orders require an explicit route',
      'CLINICAL_ORDER_MEDICATION_ROUTE_REQUIRED'
    );
  }
  details.dose = dose;
  details.route = route;
  delete details.dosage;
  const rawCatalogId = details.catalog_id ?? details.catalogId;
  const catalogId = parseMedicationCatalogId(rawCatalogId);
  if (catalogId == null) {
    throw AppError.badRequest(
      'Inpatient medication orders require an authoritative formulary catalog',
      'CLINICAL_ORDER_MEDICATION_CATALOG_REQUIRED',
    );
  }
  if (details.quantity_requested == null || String(details.quantity_requested).trim() === '') {
    throw AppError.badRequest(
      'Inpatient medication orders require an explicit total ward-supply quantity',
      'CLINICAL_ORDER_MEDICATION_SUPPLY_QUANTITY_REQUIRED',
    );
  }
  const quantityRequested = parseMedicationWardSupplyQuantity(details.quantity_requested);
  if (quantityRequested == null) {
    throw AppError.badRequest(
      'Ward-supply quantity must be positive, no greater than 99999999.99, and have at most two decimal places',
      'CLINICAL_ORDER_MEDICATION_SUPPLY_QUANTITY_INVALID',
    );
  }
  if (details.unit == null || String(details.unit).trim() === '') {
    throw AppError.badRequest(
      'Inpatient medication orders require an explicitly selected ward-supply unit',
      'CLINICAL_ORDER_MEDICATION_SUPPLY_UNIT_REQUIRED',
    );
  }
  const unit = canonicalMedicationWardSupplyUnit(details.unit);
  if (!unit) {
    throw AppError.badRequest(
      'Ward-supply unit is not an allowed medication dispensing unit',
      'CLINICAL_ORDER_MEDICATION_SUPPLY_UNIT_INVALID',
      { allowed_units: MEDICATION_WARD_SUPPLY_UNITS },
    );
  }
  delete details.catalogId;
  details.catalog_id = catalogId;
  details.quantity_requested = quantityRequested;
  details.unit = unit;
  return details;
}

async function assertMedicationCatalogAuthorityTx(tx, tenantId, orders) {
  const catalogIds = [...new Set(orders
    .filter((order) => order.order_type === 'medication')
    .map((order) => order.details?.catalog_id ?? order.details?.catalogId)
    .filter((catalogId) => catalogId != null))];
  if (!catalogIds.length) return new Map();
  const catalogById = await loadMedicationCatalogAuthorityTx(tx, {
    tenantId,
    catalogIds,
    lock: true,
    unavailableCode: 'CLINICAL_ORDER_MEDICATION_CATALOG_UNAVAILABLE',
    classificationCode: 'CLINICAL_ORDER_MEDICATION_CATALOG_CLASSIFICATION_MISMATCH',
  });
  for (const order of orders.filter((item) => (
    item.order_type === 'medication'
    && (item.details?.catalog_id ?? item.details?.catalogId) != null
  ))) {
    const catalogId = Number(order.details?.catalog_id);
    const catalog = catalogById.get(catalogId);
    order.details = bindMedicationOrderCatalogAuthority(order.details, catalog, {
      phase: order.details?.catalog_authority ? 'revalidate' : 'create',
    });
    order.route = canonicalMedicationRoute(order.details.route);
  }
  return catalogById;
}

async function assertClinicalOrderCreationContextTx(tx, tenantId, orders) {
  const patientUids = [...new Set(orders.map((order) => String(order.patient_uid)))].sort();
  const patientRows = await tx.$queryRawUnsafe(
    `SELECT uid::text
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = ANY($2::uuid[])
        AND role = 'PATIENT'
      ORDER BY uid
      FOR SHARE`,
    tenantId,
    patientUids,
  );
  const knownPatients = new Set(patientRows.map((row) => String(row.uid)));
  const missingPatient = patientUids.find((patientUid) => !knownPatients.has(patientUid));
  if (missingPatient) {
    throw AppError.notFound('Patient not found', 'CLINICAL_ORDER_PATIENT_NOT_FOUND');
  }

  const medicationActors = [...new Set(
    orders
      .filter((order) => order.order_type === 'medication')
      .map((order) => String(order.ordered_by)),
  )].sort();
  if (medicationActors.length) {
    const actorRows = await tx.$queryRawUnsafe(
      `SELECT uid::text, role
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = ANY($2::uuid[])
          AND is_active = TRUE
          AND COALESCE(is_deleted, FALSE) = FALSE
          AND deleted_at IS NULL
          AND LOWER(COALESCE(status, 'active')) = 'active'
        ORDER BY uid
        FOR SHARE`,
      tenantId,
      medicationActors,
    );
    const actorByUid = new Map(actorRows.map((row) => [String(row.uid), row]));
    for (const actorUid of medicationActors) {
      if (!canTerminalMedicationOrderRole(actorByUid.get(actorUid)?.role)) {
        throw AppError.forbidden(
          'Medication orders require an active same-tenant prescriber',
          'CLINICAL_ORDER_MEDICATION_ACTIVE_PRESCRIBER_REQUIRED',
          { ordered_by: actorUid },
        );
      }
    }
  }

  const erVisitIds = [...new Set(
    orders.map((order) => order.er_visit_id).filter((id) => id != null).map(Number),
  )].sort((left, right) => left - right);
  const erRows = erVisitIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT id, patient_uid::text, encounter_id::text, status
         FROM emergency_visits
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::int[])
        ORDER BY id
        FOR SHARE`,
      tenantId,
      erVisitIds,
    )
    : [];
  const erById = new Map(erRows.map((row) => [Number(row.id), row]));
  for (const order of orders) {
    if (order.er_visit_id == null) continue;
    const visit = erById.get(Number(order.er_visit_id));
    if (!visit) {
      throw AppError.notFound('Emergency visit not found', 'CLINICAL_ORDER_ER_VISIT_NOT_FOUND');
    }
    if (!visit.patient_uid || String(visit.patient_uid) !== String(order.patient_uid)) {
      throw AppError.conflict(
        'Emergency visit does not belong to the order patient',
        'CLINICAL_ORDER_ER_VISIT_PATIENT_MISMATCH',
      );
    }
    if (!visit.encounter_id) {
      throw AppError.conflict(
        'Emergency visit has no canonical encounter',
        'CLINICAL_ORDER_ER_VISIT_ENCOUNTER_REQUIRED',
      );
    }
    if (order.encounter_id && String(order.encounter_id) !== String(visit.encounter_id)) {
      throw AppError.conflict(
        'Emergency visit and caller encounter_id do not identify the same encounter',
        'CLINICAL_ORDER_ER_VISIT_ENCOUNTER_MISMATCH',
      );
    }
    order.encounter_id = String(visit.encounter_id);
  }

  const encounterIds = [
    ...new Set(
      orders
        .map(order => order.encounter_id)
        .filter(Boolean)
        .map(String)
    )
  ].sort();
  if (orders.some(order => order.order_type === 'medication' && !order.encounter_id)) {
    throw AppError.conflict(
      'MAR-bound medication orders require an active inpatient admission with ward supply custody; use the outpatient prescription workflow for ER-only or OP medication',
      'CLINICAL_ORDER_MEDICATION_WARD_SUPPLY_CONTEXT_REQUIRED'
    );
  }
  if (!encounterIds.length) return;
  const admissionRows = await tx.$queryRawUnsafe(
    `SELECT admission.id, admission.patient_uid::text,
              admission.encounter_id::text, admission.status,
              admission.bed_id, bed.ward_id
         FROM admissions admission
         LEFT JOIN beds bed
           ON bed.tenant_id = admission.tenant_id
          AND bed.id = admission.bed_id
        WHERE admission.tenant_id = $1::uuid
          AND admission.encounter_id = ANY($2::uuid[])
        ORDER BY admission.encounter_id
        FOR SHARE OF admission`,
    tenantId,
    encounterIds
  );
  const encounterErRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid::text, encounter_id::text, status
         FROM emergency_visits
        WHERE tenant_id = $1::uuid
          AND encounter_id = ANY($2::uuid[])
        ORDER BY encounter_id
        FOR SHARE`,
      tenantId,
      encounterIds,
    );
  const patientEncounterRows = await tx.$queryRawUnsafe(
      `SELECT id::text, patient_uid::text, encounter_type, status, admission_id
         FROM patient_encounters
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::uuid[])
        ORDER BY id
        FOR SHARE`,
      tenantId,
      encounterIds,
    );
  const admissionsByEncounter = new Map(
    admissionRows.map((row) => [String(row.encounter_id), row]),
  );
  const erByEncounter = new Map(
    encounterErRows.map((row) => [String(row.encounter_id), row]),
  );
  const patientEncounterById = new Map(
    patientEncounterRows.map((row) => [String(row.id), row]),
  );
  const patientEncounterAdmissionIds = [...new Set(
    patientEncounterRows.map((row) => row.admission_id).filter((id) => id != null).map(Number),
  )].sort((left, right) => left - right);
  const linkedAdmissionRows = patientEncounterAdmissionIds.length
    ? await tx.$queryRawUnsafe(
        `SELECT admission.id, admission.patient_uid::text, admission.status,
              admission.bed_id, bed.ward_id
         FROM admissions admission
         LEFT JOIN beds bed
           ON bed.tenant_id = admission.tenant_id
          AND bed.id = admission.bed_id
        WHERE admission.tenant_id = $1::uuid
          AND admission.id = ANY($2::int[])
        ORDER BY admission.id
        FOR SHARE OF admission`,
        tenantId,
        patientEncounterAdmissionIds
      )
    : [];
  const linkedAdmissionById = new Map(
    linkedAdmissionRows.map((row) => [Number(row.id), row]),
  );
  for (const order of orders.filter((item) => item.encounter_id)) {
    const encounterId = String(order.encounter_id);
    const admission = admissionsByEncounter.get(encounterId);
    const emergencyVisit = order.er_visit_id == null
      ? erByEncounter.get(encounterId)
      : erById.get(Number(order.er_visit_id));
    const patientEncounter = patientEncounterById.get(encounterId);
    if (!admission && !emergencyVisit && !patientEncounter) {
      throw AppError.notFound(
        'Encounter not found in the current tenant',
        'CLINICAL_ORDER_ENCOUNTER_NOT_FOUND',
      );
    }
    const contexts = [admission, emergencyVisit, patientEncounter].filter(Boolean);
    if (contexts.some((context) => String(context.patient_uid) !== String(order.patient_uid))) {
      throw AppError.conflict(
        'Encounter does not belong to the order patient',
        'CLINICAL_ORDER_ENCOUNTER_PATIENT_MISMATCH',
      );
    }
    if (order.order_type !== 'medication') continue;
    const inpatientAdmission = admission
      || (patientEncounter?.admission_id == null
        ? null
        : linkedAdmissionById.get(Number(patientEncounter.admission_id)));
    const inpatientAdmissionActive = Boolean(
      inpatientAdmission
      && ['admitted', 'transferred'].includes(
        String(inpatientAdmission.status || '').trim().toLowerCase(),
      )
    );
    const inpatientContext = Boolean(
      admission
      || patientEncounter?.admission_id != null
      || ['ip', 'inpatient', 'admission'].includes(
        String(patientEncounter?.encounter_type || '').trim().toLowerCase(),
      )
    );
    if (!inpatientContext || !inpatientAdmission) {
      throw AppError.conflict(
        'MAR-bound medication orders require an active inpatient admission with ward supply custody; use the outpatient prescription workflow for ER-only or OP medication',
        'CLINICAL_ORDER_MEDICATION_WARD_SUPPLY_CONTEXT_REQUIRED'
      );
    }
    if (
      inpatientAdmission
      && !inpatientAdmissionActive
    ) {
      throw AppError.conflict(
        'Inpatient medication orders require an active admitted or transferred admission',
        'CLINICAL_ORDER_MEDICATION_ADMISSION_INACTIVE',
        { admission_id: Number(inpatientAdmission.id), status: inpatientAdmission.status || null },
      );
    }
    if (inpatientAdmission.ward_id == null) {
      throw AppError.conflict(
        'MAR-bound medication orders require an admission with an authoritative ward assignment',
        'CLINICAL_ORDER_MEDICATION_WARD_REQUIRED',
        { admission_id: Number(inpatientAdmission.id), encounter_id: encounterId }
      );
    }
  }
}

export async function prepareClinicalOrdersAuthorityTx(tx, tenantId, orders) {
  await assertClinicalOrderCreationContextTx(tx, tenantId, orders);
  await assertMedicationCatalogAuthorityTx(tx, tenantId, orders);
  return orders;
}

export async function normalizeOrderInput(data) {
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
  const { encounter_id } = data;
  let { details } = data;

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
  const erVisitIdProvided = er_visit_id !== undefined && er_visit_id !== null && er_visit_id !== '';
  let normalizedErVisitId = null;
  if (erVisitIdProvided) {
    normalizedErVisitId = Number(er_visit_id);
    if (!Number.isSafeInteger(normalizedErVisitId) || normalizedErVisitId <= 0) {
      throw AppError.badRequest('er_visit_id must be a positive integer emergency_visits id');
    }
  }

  if (
    order_type === 'medication'
    && (encounter_id == null || encounter_id === '')
    && normalizedErVisitId == null
  ) {
    throw AppError.badRequest(
      'Medication CPOE orders require an active encounter or emergency visit; use the outpatient prescription workflow for non-MAR medication orders',
      'CLINICAL_ORDER_MEDICATION_ENCOUNTER_REQUIRED',
    );
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
  const route = canonicalMedicationRoute(
    data.route ?? (details && typeof details === 'object' ? details.route : null)
  );
  if (route && details && typeof details === 'object' && !Array.isArray(details)) {
    details = { ...details, route };
  }

  if (order_type === 'medication' && details && typeof details === 'object' && !Array.isArray(details)) {
    const rawCatalogId = details.catalog_id ?? details.catalogId;
    const suppliedMedicationName = firstText(
      details.medication_name,
      details.drug_name,
      details.name,
      details.medication,
    );
    if (!suppliedMedicationName && (rawCatalogId == null || rawCatalogId === '')) {
      throw AppError.badRequest(
        'Medication name is required when no authoritative formulary catalog is selected',
        'CLINICAL_ORDER_MEDICATION_NAME_REQUIRED',
      );
    }
    if (suppliedMedicationName) {
      details = { ...details, medication_name: suppliedMedicationName };
    }
    if (rawCatalogId != null && rawCatalogId !== '') {
      const catalogId = parseMedicationCatalogId(rawCatalogId);
      if (catalogId == null) {
        throw AppError.badRequest(
          'Medication catalog_id must be a positive formulary catalog integer',
          'CLINICAL_ORDER_MEDICATION_CATALOG_INVALID',
        );
      }
      details = { ...details, catalog_id: catalogId };
      delete details.catalogId;
    }
  }

  // Every medication accepted by CPOE is MAR-bound and therefore carries an
  // active encounter plus authoritative formulary and ward-supply evidence.
  if (order_type === 'medication') {
    details = normalizeMedicationWardSupplyDetails(details);
  }

  return {
    encounter_id: encounter_id ?? null,
    er_visit_id: normalizedErVisitId,
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
    body: (order) => `MAR scheduling FAILED for medication order ${order.order_number} — no doses are on the drug chart. Open the order and use Repair MAR; if the schedule definition is invalid, discontinue it and place a corrected CPOE order.`,
  },
  mar_carryover: {
    action: 'mar_carryover_failed',
    title: 'ER medication did not carry into the ICU MAR',
    body: (order) => `ER-to-ICU MAR carryover FAILED for medication order ${order.order_number}. Open the order and use Repair MAR; if the schedule definition is invalid, discontinue it and place a corrected CPOE order.`,
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
 * For MAR failures, a failed alert fan-out stores its exact recovery intent
 * in the same transaction as the failed clinical audit event. Other stages
 * retain the existing independent alert/audit attempts. Never throws.
 */
export async function escalateOrderIntegrationFailure({ order, stage, err, deps = {} } = {}) {
  const copy = ORDER_INTEGRATION_FAILURE_ALERTS[stage];
  if (!order?.id || !copy) return { alertQueued: false, auditRecorded: false };
  const outbox = deps.notificationOutbox || notificationOutbox;
  const recordAudit = deps.recordClinicalAuditEvent || recordClinicalAuditEvent;
  const runSafeCanonical = deps.safeCanonical || safeCanonical;
  const queueAlert = deps.queueClinicalAlertFanout || queueClinicalAlertFanout;
  const persistFailure = deps.persistClinicalAlertFailureWithCanonical
    || persistClinicalAlertFailureWithCanonical;
  const sourceEventKey = `clinical_orders:${order.id}:${stage}_failed:alert`;
  const alertIntent = {
    type: 'push',
    tenantId: order.tenant_id || null,
    title: copy.title,
    body: copy.body(order),
    sourceEventKey,
    templateVersion: 'clinical-alert-order-integration-failure.v1',
    data: {
      source_event_key: sourceEventKey,
      order_id: order.id,
      order_number: order.order_number,
      order_type: order.order_type,
      priority: order.priority,
      patient_uid: order.patient_uid,
      failure_stage: stage,
      error_code: err?.code || null,
      ...(stage === 'mar_schedule' || stage === 'mar_carryover'
        ? {
          recovery_endpoint: `/api/v1/emr/orders/${order.id}/retry-mar-scheduling`,
          deep_link: `/emr/orders/${order.patient_uid}?mar_recovery_order=${order.id}`,
          requires_doctor_authority: true,
        }
        : {}),
    },
    channel: 'push',
  };

  let alertQueued = false;
  try {
    const fanout = await queueAlert(alertIntent, {
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

  const auditInput = {
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
  };

  let auditRecorded = false;
  if (!alertQueued && (stage === 'mar_schedule' || stage === 'mar_carryover')) {
    try {
      const persisted = await persistFailure({
        tenantId: order.tenant_id,
        obligation: {
          sourceTable: 'clinical_orders',
          sourceId: String(order.id),
          failureKind: stage === 'mar_schedule'
            ? 'order_mar_schedule'
            : 'order_mar_carryover',
          patientUid: order.patient_uid,
          encounterId: order.encounter_id || null,
          originActorUid: order.ordered_by || null,
          failureCode: err?.code || `ORDER_${stage.toUpperCase()}_FAILED`,
          notificationIntent: alertIntent,
        },
        recordCanonical: async (tx, obligation) => recordAudit({
          ...auditInput,
          metadata: {
            ...auditInput.metadata,
            alert_recovery_obligation_id: Number(obligation.id),
          },
        }, { db: tx, strict: true }),
      });
      auditRecorded = Boolean(persisted?.canonical);
    } catch (persistErr) {
      logger.error(
        `Order ${stage} failure evidence and alert obligation could NOT be persisted for order ${order.order_number}: ${persistErr.message}`,
        { order_id: order.id, stage, error_code: persistErr?.code || null },
      );
    }
  } else {
    await runSafeCanonical(`order ${stage} failure audit (order ${order.order_number})`, async () => {
      const row = await recordAudit(auditInput);
      auditRecorded = !!row;
      return row;
    });
  }

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

  let medicationWardSupplyReady = order.order_type !== 'medication';
  if (order.order_type === 'medication') {
    await createWardIndentForClinicalMedicationOrder(order)
      .then(indent => {
        if (!indent?.id) {
          throw AppError.conflict(
            'Medication order ward-supply context could not be materialized',
            'WARD_INDENT_CLINICAL_ORDER_CONTEXT_UNAVAILABLE'
          );
        }
        medicationWardSupplyReady = true;
      })
      .catch(async err => {
        // BE-H1: the order committed but the ward stock request was not raised —
        // log loudly AND escalate durably (outbox alert + failed audit row).
        logger.error(
          `Failed to create ward indent for medication order ${order.order_number}: ${err.message}`
        );
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
  const integrationDispatch = dispatchOrderIntegrations(order, {
    medicationWardSupplyReady
  }).catch(async err => {
    logger.error(
      `Order integration dispatch failed for order ${order.order_number}: ${err.message}`
    );
    await escalateOrderIntegrationFailure({ order, stage: 'integration_dispatch', err });
  });
  if (order.order_type === 'investigation' || order.order_type === 'medication') {
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
  const { tenantId = null, httpCommand = null } = data;
  const n = await normalizeOrderInput(data);
  const command = normalizeClinicalOrderCreateCommand(httpCommand, {
    actorUid: n.ordered_by,
    operation: 'single',
  });

  // CPOE → radiology bridge (Phase 0, fail-closed): resolve the modality,
  // derive contrast intent server-side, and run the migration-678
  // contrast/allergy screen BEFORE any row is written. Blocked without an
  // acknowledged override → 409 RADIOLOGY_CONTRAST_ALLERGY_BLOCKED, exactly
  // like ordering through radiologyService directly.
  let radiologyGate = null;
  if (n.order_type === 'radiology') {
    radiologyGate = await runRadiologyContrastGate(n, data);
  }

  const cdsOverrideReason = overrideReasonOf(data);
  let cdsResult = null;
  let overrideApplied = false;

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
    await lockMedicationCdsScopesTx(tx, requireTenantId(tenantId), [n]);
    const [orderNumber] = await generateOrderNumbersTx(tx, 1);
    await prepareClinicalOrdersAuthorityTx(tx, requireTenantId(tenantId), [n]);
    cdsResult = await runCDSChecks(
      n.patient_uid,
      n.order_type,
      n.details,
      tenantId,
      tx,
    );
    if (radiologyGate?.screen) {
      cdsResult.warnings.push(...radiologyGate.screen.warnings);
    }
    overrideApplied = cdsBlockIsOverridable(cdsResult) && !!cdsOverrideReason;
    if (cdsResult.blockers.length > 0 && !overrideApplied) {
      throw AppError.badRequest(
        `Order blocked by safety checks: ${cdsResult.blockers.map(renderBlocker).join('; ')}`,
        'CDS_BLOCKER',
        { blockers: cdsResult.blockers, warnings: cdsResult.warnings },
      );
    }
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
    await finaliseClinicalOrderCreateHttpReceiptTx(tx, {
      tenantId: requireTenantId(tenantId),
      command,
      responseData: { order: row, cds_warnings: cdsResult.warnings },
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

  logger.info(`Order created: ${order.order_number}, type=${n.order_type}, priority=${n.priority}, patient=${n.patient_uid}, by=${n.ordered_by}`);

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
export async function createOrdersBulk(
  items,
  {
    ordered_by,
    tenantId = null,
    httpCommand = null,
    operation = 'bulk',
    transactionGuard = null
  } = {}
) {
  if (!Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('orders must be a non-empty array');
  }
  if (!ordered_by) {
    throw AppError.badRequest('ordered_by is required');
  }
  const command = normalizeClinicalOrderCreateCommand(httpCommand, {
    actorUid: ordered_by,
    operation
  });

  // Phase 0 validates deterministic request shape and radiology authority.
  // Patient/context/catalog authority and CDS run under one serialized write
  // transaction below so concurrent medication batches cannot both screen an
  // old snapshot and commit incompatible orders.
  const prepared = [];
  for (let i = 0; i < items.length; i += 1) {
    let normalized;
    try {
      normalized = await normalizeOrderInput({ ...items[i], ordered_by });
    } catch (err) {
      throw AppError.badRequest(`Order #${i + 1}: ${err.message}`, err.code, err.details);
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
    const itemOverrideReason = overrideReasonOf(items[i]);
    prepared.push({
      normalized,
      cds_warnings: [],
      cds_blockers: [],
      override: null,
      override_reason: itemOverrideReason,
      radiology_gate: itemRadiologyGate,
    });
  }

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
  const createdRows = await setTenantTx(requireTenantId(tenantId), async tx => {
    if (typeof transactionGuard === 'function') await transactionGuard(tx);
    await lockMedicationCdsScopesTx(
      tx,
      requireTenantId(tenantId),
      prepared.map((item) => item.normalized),
    );
    const orderNumbers = await generateOrderNumbersTx(tx, prepared.length);
    await prepareClinicalOrdersAuthorityTx(
      tx,
      requireTenantId(tenantId),
      prepared.map((item) => item.normalized),
    );
    const rows = [];
    for (let i = 0; i < prepared.length; i += 1) {
      const n = prepared[i].normalized;
      const cdsResult = await runCDSChecks(
        n.patient_uid,
        n.order_type,
        n.details,
        tenantId,
        tx,
      );
      if (prepared[i].radiology_gate?.screen) {
        cdsResult.warnings.push(...prepared[i].radiology_gate.screen.warnings);
      }
      const itemOverrideApplied = cdsBlockIsOverridable(cdsResult)
        && !!prepared[i].override_reason;
      if (cdsResult.blockers.length > 0 && !itemOverrideApplied) {
        throw AppError.badRequest(
          `Order #${i + 1} blocked by safety checks: ${cdsResult.blockers.map(renderBlocker).join('; ')}`,
          'CDS_BLOCKER',
          { order_index: i, blockers: cdsResult.blockers, warnings: cdsResult.warnings },
        );
      }
      prepared[i].cds_warnings = cdsResult.warnings;
      prepared[i].cds_blockers = itemOverrideApplied ? cdsResult.blockers : [];
      prepared[i].override = itemOverrideApplied
        ? { reason: prepared[i].override_reason }
        : null;
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
    await finaliseClinicalOrderCreateHttpReceiptTx(tx, {
      tenantId: requireTenantId(tenantId),
      command,
      responseData: rows.map((order, index) => ({
        order,
        cds_warnings: prepared[index].cds_warnings,
      })),
    });
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
  const supplyQuantityPerDose = details.supply_quantity_per_dose
    ?? details.dispense_units_per_dose
    ?? details.units_per_dose
    ?? null;
  if (supplyQuantityPerDose != null) {
    entry.supply_quantity_per_dose = supplyQuantityPerDose;
  }
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
    if (d == null || d === '') return 1;
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw AppError.badRequest('duration_days must be a positive integer');
    }
    if (n > MAR_SCHEDULE_LIMITS.maxScheduleDays) {
      throw AppError.badRequest(
        `duration_days ${n} exceeds the ${MAR_SCHEDULE_LIMITS.maxScheduleDays}-day MAR scheduling window`,
        'MAR_DURATION_EXCEEDS_WINDOW',
        { requested_days: n, max_schedule_days: MAR_SCHEDULE_LIMITS.maxScheduleDays },
      );
    }
    return n;
  })();
  const totalDoses = durationDays * doseTimes.length;
  if (totalDoses > MAR_SCHEDULE_LIMITS.maxTotalDoses) {
    throw AppError.badRequest(
      `Explicit dose times would create ${totalDoses} MAR doses (ceiling ${MAR_SCHEDULE_LIMITS.maxTotalDoses})`,
      'MAR_SCHEDULE_DOSE_CEILING',
      { requested_days: durationDays, total_doses: totalDoses,
        max_total_doses: MAR_SCHEDULE_LIMITS.maxTotalDoses },
    );
  }
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
        ...(details.supply_quantity_per_dose != null
          ? { supply_quantity_per_dose: details.supply_quantity_per_dose }
          : {}),
      });
    }
  }
  return entries;
}

const ACTIVE_MAR_ORDER_STATUSES = new Set(['ordered', 'verified', 'in_progress']);

function normalizedMedicationOrderDetails(rawDetails) {
  const details = typeof rawDetails === 'string'
    ? JSON.parse(rawDetails)
    : { ...(rawDetails || {}) };
  return {
    ...details,
    medication_name: details.medication_name || details.drug_name || null,
    dose: details.dose || details.dosage || null,
    route: details.route || null,
    supply_quantity_per_dose: details.supply_quantity_per_dose
      ?? details.dispense_units_per_dose
      ?? details.units_per_dose
      ?? null,
  };
}

function expectedMedicationOrderMarDoseCount(order) {
  try {
    const details = normalizedMedicationOrderDetails(order.details);
    if (['medication_name', 'dose', 'route'].some((field) => !String(details[field] || '').trim())) {
      return null;
    }
    const entries = buildMarEntriesFromOrderDetails(details, {
      startDate: order.start_date,
    });
    let count = 0;
    for (const entry of entries) {
      if (entry.scheduled_time) {
        count += 1;
        continue;
      }
      const expanded = expandSchedule(
        entry.frequency,
        entry.start_time,
        entry.duration_days,
      );
      if (!expanded) return null;
      count += expanded.length;
    }
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}

/**
 * Materialize the exact MAR schedule owned by one committed medication order.
 * This is the single governed entry point used by initial CPOE dispatch,
 * ER-to-ICU continuation, and explicit recovery. scheduleMedications is
 * idempotent on the clinical dose slot and enforces order/supply identity, so
 * a retry fills missing rows without duplicating an existing schedule.
 */
export async function scheduleMedicationOrderOnMar(order, {
  actorUid = null,
  actorRole = null,
  db = null,
} = {}) {
  if (!order?.id || order.order_type !== 'medication') {
    throw AppError.badRequest(
      'A committed medication clinical order is required',
      'MAR_SCHEDULE_MEDICATION_ORDER_REQUIRED',
    );
  }
  if (!ACTIVE_MAR_ORDER_STATUSES.has(String(order.status || '').toLowerCase())) {
    throw AppError.conflict(
      `Medication order ${order.order_number || order.id} is not active`,
      'MAR_SCHEDULE_ORDER_INACTIVE',
      { order_id: Number(order.id), status: order.status || null },
    );
  }
  const details = normalizedMedicationOrderDetails(order.details);
  const missingFields = ['medication_name', 'dose', 'route']
    .filter((field) => !String(details[field] || '').trim());
  if (missingFields.length > 0) {
    throw AppError.conflict(
      `Medication order ${order.order_number || order.id} cannot be charted until its medication, dose, and route are corrected`,
      'MAR_SCHEDULE_ORDER_DETAILS_INVALID',
      { order_id: Number(order.id), missing_fields: missingFields },
    );
  }

  const marEntries = buildMarEntriesFromOrderDetails(details, {
    startDate: order.start_date,
  }).map((entry) => ({
    ...entry,
    clinical_order_id: Number(order.id),
    notes: [
      entry.notes,
      `clinical_order_id:${order.id}`,
      `order_number:${order.order_number}`,
    ].filter(Boolean).join('; '),
  }));

  return scheduleMedications(order.patient_uid, null, marEntries, {
    tenantId: requireTenantId(order.tenant_id),
    actorUid: actorUid || order.ordered_by || null,
    actorRole,
    sourceClinicalOrderId: Number(order.id),
    encounterId: order.encounter_id || null,
    db,
  });
}

/**
 * Doctor-authorized recovery for a committed medication order whose MAR
 * integration did not finish. The HTTP route supplies an Idempotency-Key;
 * this service also relies on MAR slot identity, then appends one canonical
 * recovery receipt so an operational alert has an exact reconciliation fact.
 */
export async function retryMedicationOrderMarScheduling({ tenantId, orderId, actorUid } = {}) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest('A positive clinical order id is required');
  }
  const tid = String(requireTenantId(tenantId)).trim().toLowerCase();
  const order = await prisma.clinical_orders.findFirst({
    where: { id, tenant_id: tid },
    select: ORDER_RETURNING_SELECT,
  });
  if (!order) throw AppError.notFound('Clinical order not found');
  if (order.order_type !== 'medication') {
    throw AppError.conflict(
      'Only medication orders own a MAR schedule',
      'MAR_SCHEDULE_MEDICATION_ORDER_REQUIRED',
    );
  }

  return setTenantTx(tid, async (tx) => {
    const locked = await tx.$queryRawUnsafe(
      `SELECT id
         FROM clinical_orders
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        FOR UPDATE`,
      tid,
      id,
    );
    if (!locked[0]) throw AppError.notFound('Clinical order not found');
    const activeActor = await loadActiveClinicalActorTx(tx, {
      tenantId: tid,
      actorUid,
      errorCode: 'MAR_RECOVERY_ACTIVE_PRESCRIBER_REQUIRED',
      errorMessage: 'MAR recovery requires an active same-tenant prescriber'
    });
    if (!canTerminalMedicationOrderRole(activeActor.role)) {
      throw AppError.forbidden(
        'MAR recovery requires an active same-tenant prescriber',
        'MAR_RECOVERY_ACTIVE_PRESCRIBER_REQUIRED'
      );
    }
    const authoritativeActorRole = String(activeActor.role).trim().toUpperCase();
    const currentOrder = await tx.clinical_orders.findFirst({
      where: { id, tenant_id: tid },
      select: ORDER_RETURNING_SELECT,
    });
    const scheduled = await scheduleMedicationOrderOnMar(currentOrder, {
      actorUid,
      actorRole: authoritativeActorRole,
      db: tx
    });
    const scheduledDoseIds = scheduled.map(row => Number(row.id));
    const canonical = await recordCanonicalClinicalEvent(
      {
        tenantId: tid,
        patientUid: currentOrder.patient_uid,
        encounterId: currentOrder.encounter_id || null,
        eventType: 'mar.scheduling_recovered',
        eventStatus: 'completed',
        action: 'mar_scheduling_recovered',
        actionStatus: 'success',
        sourceTable: 'clinical_orders',
        sourceId: String(currentOrder.id),
        resourceType: 'clinical_order',
        resourceTable: 'clinical_orders',
        resourceId: String(currentOrder.id),
        actorUid,
        actorRole: authoritativeActorRole,
        summary: `MAR schedule reconciled for medication order ${currentOrder.order_number}`,
        payload: {
          order_id: Number(currentOrder.id),
          order_number: currentOrder.order_number,
          scheduled_dose_count: scheduledDoseIds.length,
          scheduled_dose_ids: scheduledDoseIds,
          resolved_failure_keys: [
            `clinical_orders:${currentOrder.id}:mar_schedule_failed`,
            `clinical_orders:${currentOrder.id}:mar_carryover_failed`
          ]
        },
        metadata: {
          order_number: currentOrder.order_number,
          scheduled_dose_count: scheduledDoseIds.length,
          scheduled_dose_ids: scheduledDoseIds
        },
        timelineIdempotencyKey: `clinical_orders:${currentOrder.id}:mar_scheduling_recovered`,
        auditIdempotencyKey: `clinical_orders:${currentOrder.id}:mar_scheduling_recovered`
      },
      { db: tx, strict: true }
    );

    return {
      order_id: Number(currentOrder.id),
      order_number: currentOrder.order_number,
      patient_uid: currentOrder.patient_uid,
      status: 'scheduled',
      scheduled_dose_count: scheduledDoseIds.length,
      scheduled_dose_ids: scheduledDoseIds,
      recovery_timeline_event_id: canonical.timeline?.id || null,
      recovery_audit_event_id: canonical.audit?.id || null,
    };
  });
}

async function dispatchOrderIntegrations(order, { medicationWardSupplyReady = true } = {}) {
  if (order.order_type === 'medication') {
    if (!medicationWardSupplyReady) {
      logger.error(
        `MAR scheduling withheld for medication order ${order.order_number}: ward-supply custody was not materialized`,
        { code: 'MAR_SCHEDULE_WARD_SUPPLY_REQUIRED', order_id: order.id }
      );
      return;
    }
    // Create MAR entries via existing marService
    try {
      await scheduleMedicationOrderOnMar(order, { actorUid: order.ordered_by });
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

  const contrastIntent = persistedCpoeContrastIntent(details, fields.modality);

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
    // The pre-commit CPOE gate persists one authoritative derived intent.
    // Carry it into materialization instead of re-deriving from modality/text,
    // which can otherwise downgrade contrast-enhanced non-presumed modalities.
    contrast_planned: contrastIntent.contrastPlanned,
    ...(contrastIntent.contrastAgent ? { contrast_agent: contrastIntent.contrastAgent } : {}),
    ...(details.contrast_override_reason
      ? {
        contrast_override_reason: details.contrast_override_reason,
        contrast_override_by: order.ordered_by,
      }
      : {}),
  };

  const row = await radiologyService.createOrder(payload, {
    tenantId: order.tenant_id,
    contrastIntent,
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

const ORDER_VERIFICATION_EVENT = 'order.verified';
const ORDER_VERIFICATION_STATUS = 'verified';

function verificationSha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalVerificationJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalVerificationJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalVerificationJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function orderVerificationResponseSnapshot(order) {
  return JSON.parse(JSON.stringify(order, (_key, value) => (
    typeof value === 'bigint' ? value.toString() : value
  )));
}

function orderVerificationResponseDigest(snapshot) {
  return verificationSha256(canonicalVerificationJson(snapshot));
}

function orderVerificationCommandIdentity({
  tenantId,
  orderId,
  actorUid,
  actorRole,
  commandKey,
  requestBodySha256,
}) {
  if (!isValidIdempotencyKey(commandKey)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'CLINICAL_ORDER_VERIFY_IDEMPOTENCY_KEY_INVALID',
    );
  }
  if (!/^[0-9a-f]{64}$/.test(String(requestBodySha256 || ''))) {
    throw AppError.badRequest(
      'Clinical-order verification request fingerprint is invalid',
      'CLINICAL_ORDER_VERIFY_REQUEST_FINGERPRINT_INVALID',
    );
  }
  const normalizedRole = String(actorRole || '').trim().toUpperCase();
  const commandDigest = verificationSha256(`${tenantId}\n${commandKey}`);
  const requestFingerprint = verificationSha256(JSON.stringify({
    action: ORDER_VERIFICATION_EVENT,
    tenant_id: tenantId,
    clinical_order_id: orderId,
    actor_uid: String(actorUid).toLowerCase(),
    actor_role: normalizedRole,
    request_body_sha256: requestBodySha256,
  }));
  return {
    actorRole: normalizedRole,
    auditIdempotencyKey: `clinical_orders:verify:${commandDigest}:audit`,
    requestBodySha256,
    requestFingerprint,
    timelineIdempotencyKey: `clinical_orders:verify:${commandDigest}:timeline`,
  };
}

function orderVerificationReceiptConflict() {
  return AppError.conflict(
    'Idempotency-Key is already bound to a different clinical-order verification command',
    'CLINICAL_ORDER_VERIFY_IDEMPOTENCY_CONFLICT',
  );
}

function assertOrderVerificationReceiptMatches(receipt, {
  tenantId,
  orderId,
  actorUid,
  identity,
}) {
  const timeline = receipt?.timeline;
  const audit = receipt?.audit;
  const actor = String(actorUid).toLowerCase();
  const resourceId = String(orderId);
  const timelineSnapshot = timeline?.payload?.verification_response;
  const auditSnapshot = audit?.metadata?.verification_response;
  const timelineSnapshotDigest = timelineSnapshot && typeof timelineSnapshot === 'object'
    ? orderVerificationResponseDigest(timelineSnapshot)
    : null;
  const auditSnapshotDigest = auditSnapshot && typeof auditSnapshot === 'object'
    ? orderVerificationResponseDigest(auditSnapshot)
    : null;
  const snapshotIsVerifiedResponse = Boolean(
    timelineSnapshot
    && !Array.isArray(timelineSnapshot)
    && Number(timelineSnapshot.id) === orderId
    && String(timelineSnapshot.tenant_id || '').toLowerCase() === tenantId
    && String(timelineSnapshot.patient_uid || '').toLowerCase()
      === String(timeline?.patient_uid || '').toLowerCase()
    && String(timelineSnapshot.encounter_id || '').toLowerCase()
      === String(timeline?.encounter_id || '').toLowerCase()
    && timelineSnapshot.status === ORDER_VERIFICATION_STATUS
    && String(timelineSnapshot.verified_by || '').toLowerCase() === actor
    && Number.isFinite(Date.parse(String(timelineSnapshot.verified_at || '')))
  );
  if (
    !timeline
    || !audit
    || String(timeline.tenant_id).toLowerCase() !== tenantId
    || String(audit.tenant_id).toLowerCase() !== tenantId
    || String(timeline.patient_uid || '').toLowerCase()
      !== String(audit.patient_uid || '').toLowerCase()
    || String(timeline.encounter_id || '').toLowerCase()
      !== String(audit.encounter_id || '').toLowerCase()
    || timeline.event_type !== ORDER_VERIFICATION_EVENT
    || timeline.event_status !== ORDER_VERIFICATION_STATUS
    || timeline.source_table !== 'clinical_orders'
    || String(timeline.source_id) !== resourceId
    || timeline.resource_type !== 'clinical_order'
    || String(timeline.resource_id) !== resourceId
    || String(timeline.actor_uid).toLowerCase() !== actor
    || String(timeline.actor_role).trim().toUpperCase() !== identity.actorRole
    || timeline.payload?.verification_command_fingerprint !== identity.requestFingerprint
    || timeline.payload?.request_body_sha256 !== identity.requestBodySha256
    || timeline.payload?.verification_response_sha256 !== timelineSnapshotDigest
    || audit.action !== ORDER_VERIFICATION_EVENT
    || audit.action_status !== 'success'
    || audit.resource_table !== 'clinical_orders'
    || String(audit.resource_id) !== resourceId
    || String(audit.actor_uid).toLowerCase() !== actor
    || String(audit.actor_role).trim().toUpperCase() !== identity.actorRole
    || audit.metadata?.verification_command_fingerprint !== identity.requestFingerprint
    || audit.metadata?.request_body_sha256 !== identity.requestBodySha256
    || audit.metadata?.verification_response_sha256 !== auditSnapshotDigest
    || timelineSnapshotDigest !== auditSnapshotDigest
    || !snapshotIsVerifiedResponse
  ) {
    throw orderVerificationReceiptConflict();
  }
  return timelineSnapshot;
}

async function findOrderVerificationReceiptTx(tx, identity) {
  const timelineRows = await tx.$queryRawUnsafe(
    `SELECT tenant_id::text, patient_uid::text, encounter_id::text,
            event_type, event_status, source_table, source_id,
            resource_type, resource_id, actor_uid::text, actor_role, payload
       FROM clinical_timeline_events
      WHERE idempotency_key = $1
      LIMIT 1`,
    identity.timelineIdempotencyKey,
  );
  const auditRows = await tx.$queryRawUnsafe(
    `SELECT tenant_id::text, patient_uid::text, encounter_id::text,
            action, action_status, resource_table, resource_id,
            actor_uid::text, actor_role, metadata
       FROM clinical_audit_events
      WHERE idempotency_key = $1
      LIMIT 1`,
    identity.auditIdempotencyKey,
  );
  if (!timelineRows[0] && !auditRows[0]) return null;
  return { timeline: timelineRows[0] || null, audit: auditRows[0] || null };
}

/**
 * Pharmacist/nurse verification of an order.
 * @param {number} orderId
 * @param {string} verifiedBy - UID of verifier
 * @param {Object} options - tenant, actor role, and durable command identity
 * @returns {Object} Updated order
 */
export async function verifyOrder(orderId, verifiedBy, {
  tenantId,
  actorRole,
  idempotencyKey,
  requestBodySha256 = hashRequestBody({}),
} = {}) {
  if (!verifiedBy) {
    throw AppError.badRequest('verifiedBy is required');
  }
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest('orderId must be a positive integer');
  }
  if (!canVerifyMedicationOrderRole(actorRole)) {
    throw AppError.forbidden(
      'Only inpatient nursing and pharmacy staff can verify clinical orders',
      'CLINICAL_ORDER_VERIFY_ROLE_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const identity = orderVerificationCommandIdentity({
    tenantId: tid,
    orderId: id,
    actorUid: verifiedBy,
    actorRole,
    commandKey: idempotencyKey,
    requestBodySha256,
  });

  // Atomic clinical write (canonical timeline invariant): status change +
  // canonical timeline/audit events persist together or not at all.
  const result = await setTenantTx(tid, async (tx) => {
    const existing = await tx.clinical_orders.findFirst({
      where: { id, tenant_id: tid },
      select: ORDER_RETURNING_SELECT,
    });
    if (!existing) throw AppError.notFound('Order not found');
    const activeActor = await loadActiveClinicalActorTx(tx, {
      tenantId: tid,
      actorUid: verifiedBy,
      errorCode: 'CLINICAL_ORDER_VERIFY_ACTIVE_ACTOR_REQUIRED',
      errorMessage:
        'Order verification requires an active same-tenant inpatient nurse or pharmacist'
    });
    const authoritativeActorRole = String(activeActor.role || '')
      .trim()
      .toUpperCase();
    if (authoritativeActorRole !== identity.actorRole) {
      throw AppError.forbidden(
        'Verifier authority changed after authentication; sign in again',
        'CLINICAL_ORDER_VERIFY_ACTOR_ROLE_CHANGED'
      );
    }
    if (!canVerifyClinicalOrderType(authoritativeActorRole, existing.order_type)) {
      throw AppError.forbidden(
        'Pharmacy staff can verify medication orders only; other clinical orders require inpatient nursing verification',
        'CLINICAL_ORDER_VERIFY_ORDER_TYPE_FORBIDDEN',
      );
    }

    const existingReceipt = await findOrderVerificationReceiptTx(tx, identity);
    if (existingReceipt) {
      const replayOrder = assertOrderVerificationReceiptMatches(existingReceipt, {
        tenantId: tid,
        orderId: id,
        actorUid: verifiedBy,
        identity,
      });
      return {
        order: replayOrder,
        replayed: true,
      };
    }

    if (existing.status !== 'ordered') {
      throw AppError.badRequest(`Cannot verify order in status '${existing.status}'. Order must be in 'ordered' status.`);
    }

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
      const concurrentReceipt = await findOrderVerificationReceiptTx(tx, identity);
      if (concurrentReceipt) {
        const replayOrder = assertOrderVerificationReceiptMatches(concurrentReceipt, {
          tenantId: tid,
          orderId: id,
          actorUid: verifiedBy,
          identity,
        });
        return {
          order: replayOrder,
          replayed: true,
        };
      }
      throw AppError.conflict(`Order ${existing.order_number} is no longer in 'ordered' status (changed concurrently)`);
    }
    const row = await tx.clinical_orders.findUnique({
      where: { id: existing.id },
      select: ORDER_RETURNING_SELECT,
    });
    const responseSnapshot = orderVerificationResponseSnapshot(row);
    const responseSnapshotDigest = orderVerificationResponseDigest(responseSnapshot);

    const canonical = await recordCanonicalOrderEvent({
      order: row,
      tx,
      eventType: ORDER_VERIFICATION_EVENT,
      eventStatus: row.status,
      actorUid: verifiedBy,
      actorRole: identity.actorRole,
      previousStatus: existing.status,
      payload: {
        verification_command_fingerprint: identity.requestFingerprint,
        request_body_sha256: identity.requestBodySha256,
        verification_response: responseSnapshot,
        verification_response_sha256: responseSnapshotDigest,
      },
      metadata: {
        verification_command_fingerprint: identity.requestFingerprint,
        request_body_sha256: identity.requestBodySha256,
        verification_response: responseSnapshot,
        verification_response_sha256: responseSnapshotDigest,
      },
      timelineIdempotencyKey: identity.timelineIdempotencyKey,
      auditIdempotencyKey: identity.auditIdempotencyKey,
    });
    const canonicalOrder = assertOrderVerificationReceiptMatches(canonical, {
      tenantId: tid,
      orderId: id,
      actorUid: verifiedBy,
      identity,
    });
    return { order: canonicalOrder, replayed: false };
  });

  logger.info(`Order ${result.order.order_number} verified by ${verifiedBy}`, {
    replayed: result.replayed,
  });
  return result.order;
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
export async function completeOrder(orderId, completedBy, options = {}) {
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

  const command = normalizeClinicalOrderTerminalCommand(options, {
    orderId: existing.id,
    actorUid: completedBy,
    action: 'completed',
  });

  const allowedStatuses = existing.order_type === 'medication'
    ? ['verified', 'in_progress']
    : ['ordered', 'verified', 'in_progress'];
  if (!allowedStatuses.includes(existing.status)) {
    if (existing.order_type === 'medication' && existing.status === 'ordered') {
      throw AppError.conflict(
        'A medication order must be explicitly verified before completion; cancel a never-verified order',
        'MEDICATION_ORDER_COMPLETION_VERIFICATION_REQUIRED',
        { clinical_order_id: existing.id, status: existing.status },
      );
    }
    throw AppError.badRequest(`Cannot complete order in status '${existing.status}'`);
  }
  if (existing.order_type === 'medication' && (!existing.verified_by || !existing.verified_at)) {
    throw AppError.conflict(
      'Medication-order verification evidence is missing; completion is not allowed',
      'MEDICATION_ORDER_COMPLETION_VERIFICATION_REQUIRED',
      { clinical_order_id: existing.id, status: existing.status },
    );
  }

  // Atomic clinical write (canonical timeline invariant): status change +
  // canonical timeline/audit events persist together or not at all.
  const updated = await setTenantTx(requireTenantId(existing.tenant_id), async tx => {
    const lockedWardIndent =
      existing.order_type === 'medication'
        ? await lockMedicationOrderWardIndentTx(tx, {
            tenantId: existing.tenant_id,
            clinicalOrderId: existing.id
          })
        : null;
    const terminalPrevious = await lockTerminalOrderAndAuthorizeTx(tx, {
      tenantId: existing.tenant_id,
      orderId: existing.id,
      actorUid: completedBy,
      allowedStatuses,
      action: 'completed',
    });
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

    const marTerminalProjection =
      row.order_type === 'medication'
        ? await terminallyProjectMedicationOrderDosesTx(tx, {
            tenantId: row.tenant_id,
            order: row,
            actorUid: completedBy,
            terminalStatus: row.status,
            reason: 'Medication order course completed by prescriber'
          })
        : [];
    const wardIndentTerminalProjection =
      row.order_type === 'medication'
        ? await terminallyProjectMedicationOrderWardIndentTx(tx, {
            tenantId: row.tenant_id,
            order: row,
            actorUid: completedBy,
            terminalStatus: row.status,
            reason: 'Medication order course completed by prescriber',
            lockedIndent: lockedWardIndent
          })
        : null;
    const responseRow = wardIndentTerminalProjection
      ? { ...row, ward_indent_terminal_projection: wardIndentTerminalProjection }
      : row;

    await recordCanonicalOrderEvent({
      order: row,
      tx,
      eventType: 'order.completed',
      eventStatus: row.status,
      actorUid: completedBy,
      previousStatus: terminalPrevious.status,
      payload: {
        mar_terminal_projection: marTerminalProjection,
        ward_indent_terminal_projection: wardIndentTerminalProjection
      }
    });
    await finaliseClinicalOrderTerminalHttpReceiptTx(tx, {
      tenantId: row.tenant_id,
      command,
      responseData: responseRow
    });
    return responseRow;
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
export async function cancelOrder(orderId, cancelledBy, reason, options = {}) {
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

  const command = normalizeClinicalOrderTerminalCommand(options, {
    orderId: existing.id,
    actorUid: cancelledBy,
    action: 'cancelled',
  });

  if (['completed', 'cancelled', 'discontinued'].includes(existing.status)) {
    throw AppError.badRequest(`Cannot cancel order in status '${existing.status}'`);
  }

  // Atomic clinical write (canonical timeline invariant): status change +
  // canonical timeline/audit events persist together or not at all.
  const updated = await setTenantTx(requireTenantId(existing.tenant_id), async tx => {
    const lockedWardIndent =
      existing.order_type === 'medication'
        ? await lockMedicationOrderWardIndentTx(tx, {
            tenantId: existing.tenant_id,
            clinicalOrderId: existing.id
          })
        : null;
    const terminalPrevious = await lockTerminalOrderAndAuthorizeTx(tx, {
      tenantId: existing.tenant_id,
      orderId: existing.id,
      actorUid: cancelledBy,
      disallowedStatuses: ['completed', 'cancelled', 'discontinued'],
      action: 'cancelled',
    });
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

    const marTerminalProjection =
      row.order_type === 'medication'
        ? await terminallyProjectMedicationOrderDosesTx(tx, {
            tenantId: row.tenant_id,
            order: row,
            actorUid: cancelledBy,
            terminalStatus: row.status,
            reason
          })
        : [];
    const wardIndentTerminalProjection =
      row.order_type === 'medication'
        ? await terminallyProjectMedicationOrderWardIndentTx(tx, {
            tenantId: row.tenant_id,
            order: row,
            actorUid: cancelledBy,
            terminalStatus: row.status,
            reason,
            lockedIndent: lockedWardIndent
          })
        : null;
    const responseRow = wardIndentTerminalProjection
      ? { ...row, ward_indent_terminal_projection: wardIndentTerminalProjection }
      : row;

    await recordCanonicalOrderEvent({
      order: row,
      tx,
      eventType: 'order.cancelled',
      eventStatus: row.status,
      actorUid: cancelledBy,
      previousStatus: terminalPrevious.status,
      payload: {
        cancel_reason: reason,
        mar_terminal_projection: marTerminalProjection,
        ward_indent_terminal_projection: wardIndentTerminalProjection
      }
    });
    await finaliseClinicalOrderTerminalHttpReceiptTx(tx, {
      tenantId: row.tenant_id,
      command,
      responseData: responseRow
    });
    return responseRow;
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
export async function discontinueOrder(orderId, discontinuedBy, reason, options = {}) {
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

  const command = normalizeClinicalOrderTerminalCommand(options, {
    orderId: existing.id,
    actorUid: discontinuedBy,
    action: 'discontinued',
  });

  const allowedStatuses = ['ordered', 'verified', 'in_progress'];
  if (!allowedStatuses.includes(existing.status)) {
    throw AppError.badRequest(`Cannot discontinue order in status '${existing.status}'`);
  }

  // Atomic clinical write (canonical timeline invariant): status change +
  // canonical timeline/audit events persist together or not at all.
  const updated = await setTenantTx(requireTenantId(existing.tenant_id), async tx => {
    const lockedWardIndent =
      existing.order_type === 'medication'
        ? await lockMedicationOrderWardIndentTx(tx, {
            tenantId: existing.tenant_id,
            clinicalOrderId: existing.id
          })
        : null;
    const terminalPrevious = await lockTerminalOrderAndAuthorizeTx(tx, {
      tenantId: existing.tenant_id,
      orderId: existing.id,
      actorUid: discontinuedBy,
      allowedStatuses,
      action: 'discontinued',
    });
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

    const marTerminalProjection =
      row.order_type === 'medication'
        ? await terminallyProjectMedicationOrderDosesTx(tx, {
            tenantId: row.tenant_id,
            order: row,
            actorUid: discontinuedBy,
            terminalStatus: row.status,
            reason
          })
        : [];
    const wardIndentTerminalProjection =
      row.order_type === 'medication'
        ? await terminallyProjectMedicationOrderWardIndentTx(tx, {
            tenantId: row.tenant_id,
            order: row,
            actorUid: discontinuedBy,
            terminalStatus: row.status,
            reason,
            lockedIndent: lockedWardIndent
          })
        : null;
    const responseRow = wardIndentTerminalProjection
      ? { ...row, ward_indent_terminal_projection: wardIndentTerminalProjection }
      : row;

    await recordCanonicalOrderEvent({
      order: row,
      tx,
      eventType: 'order.discontinued',
      eventStatus: row.status,
      actorUid: discontinuedBy,
      previousStatus: terminalPrevious.status,
      payload: {
        discontinue_reason: reason,
        mar_terminal_projection: marTerminalProjection,
        ward_indent_terminal_projection: wardIndentTerminalProjection
      }
    });
    await finaliseClinicalOrderTerminalHttpReceiptTx(tx, {
      tenantId: row.tenant_id,
      command,
      responseData: responseRow
    });
    return responseRow;
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
  const { order_type, status, date_from, date_to, tenantId } = filters;
  const tid = requireTenantId(tenantId);
  const listQuery = parseListQuery(filters, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'created_at'
  });

  const where = { tenant_id: tid, patient_uid: patientUid };
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
  const medicationOrderIds = orders
    .filter((order) => order.order_type === 'medication')
    .map((order) => Number(order.id));
  const marCounts = medicationOrderIds.length > 0
    ? await prisma.medication_administrations.groupBy({
      by: ['clinical_order_id'],
      where: {
        tenant_id: tid,
        clinical_order_id: { in: medicationOrderIds },
        status: { not: 'cancelled' },
      },
      _count: { _all: true },
    })
    : [];
  const marCountByOrder = new Map(
    marCounts.map((row) => [Number(row.clinical_order_id), Number(row._count._all)]),
  );
  const shapedOrders = orders.map((order) => {
    if (order.order_type !== 'medication') return order;
    const count = marCountByOrder.get(Number(order.id)) || 0;
    const expectedCount = expectedMedicationOrderMarDoseCount(order);
    const isComplete = expectedCount != null && count === expectedCount;
    const isActive = ACTIVE_MAR_ORDER_STATUSES.has(String(order.status || '').toLowerCase());
    return {
      ...order,
      mar_schedule_status: isComplete
        ? 'scheduled'
        : isActive ? 'action_required' : 'not_applicable',
      mar_scheduled_dose_count: count,
      mar_expected_dose_count: expectedCount,
      mar_recovery_endpoint: isActive && !isComplete
        ? `/api/v1/emr/orders/${order.id}/retry-mar-scheduling`
        : null,
    };
  });
  const pagination = buildPagination(total, listQuery.page, listQuery.limit);

  return {
    orders: shapedOrders,
    pagination,
  };
}

// ===================================================================
// getEncounterOrders
// ===================================================================

/**
 * Get one bounded page of orders for an encounter/admission.
 * @param {string} encounterId - UUID
 * @returns {Object} Orders sorted by created_at plus pagination metadata
 */
export async function getEncounterOrders(encounterId, filters = {}) {
  const listQuery = parseListQuery(filters, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'created_at',
  });
  const where = {
    tenant_id: requireTenantId(filters.tenantId),
    encounter_id: encounterId,
  };
  const [orders, total] = await Promise.all([
    prisma.clinical_orders.findMany({
      where,
      select: ORDER_RETURNING_SELECT,
      orderBy: { created_at: 'desc' },
      take: listQuery.limit,
      skip: listQuery.offset,
    }),
    prisma.clinical_orders.count({ where }),
  ]);
  return {
    orders,
    pagination: buildPagination(total, listQuery.page, listQuery.limit),
  };
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

function orderSetApplicationSnapshot(set, items) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        set: {
          id: Number(set.id),
          code: set.code,
          title: set.title,
          active: set.active === true,
          family_key: set.family_key,
          version: Number(set.version),
          status: set.status
        },
        items: items.map(item => ({
          id: Number(item.id),
          kind: item.kind,
          payload: item.payload,
          display_order: Number(item.display_order),
          default_selected: item.default_selected === true
        }))
      }),
      'utf8'
    )
    .digest('hex');
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
export async function applyOrderSet(
  patientUid,
  encounterId,
  orderSetId,
  orderedBy,
  tenantId = null,
  { httpCommand = null } = {}
) {
  if (!patientUid || !orderSetId || !orderedBy) {
    throw AppError.badRequest('patientUid, orderSetId, and orderedBy are required');
  }

  const scopedTenantId = requireTenantId(tenantId);
  const set = await prisma.clinical_order_sets.findFirst({
    where: {
      id: Number(orderSetId),
      tenant_id: scopedTenantId
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
      tenant_id: scopedTenantId
    },
    orderBy: [{ display_order: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      kind: true,
      payload: true,
      display_order: true,
      default_selected: true
    }
  });

  if (!items.length) {
    throw AppError.badRequest('Order set has no order templates');
  }
  const expectedSnapshot = orderSetApplicationSnapshot(set, items);

  const requests = items.map(item => {
    const request = orderRequestFromItem(item, set.title);
    return {
      encounter_id: encounterId || null,
      patient_uid: patientUid,
      order_type: request.order_type,
      priority: request.priority,
      details: {
        ...request.details,
        order_set_family: set.family_key || set.code,
        order_set_version: set.version || 1
      },
      start_date: null,
      end_date: null,
      notes: request.notes
    };
  });

  const createdOrders = await createOrdersBulk(requests, {
    ordered_by: orderedBy,
    tenantId: scopedTenantId,
    httpCommand,
    operation: 'apply_set',
    transactionGuard: async tx => {
      const lockedSets = await tx.$queryRawUnsafe(
        `SELECT id, code, title, active, family_key, version, status
           FROM clinical_order_sets
          WHERE tenant_id = $1::uuid
            AND id = $2::int
          LIMIT 1
          FOR SHARE`,
        scopedTenantId,
        Number(set.id)
      );
      const lockedItems = await tx.$queryRawUnsafe(
        `SELECT id, kind, payload, display_order, default_selected
           FROM clinical_order_set_items
          WHERE tenant_id = $1::uuid
            AND order_set_id = $2::int
          ORDER BY display_order, id
          FOR SHARE`,
        scopedTenantId,
        Number(set.id)
      );
      const lockedSet = lockedSets[0];
      if (
        !lockedSet ||
        lockedSet.active !== true ||
        lockedSet.status !== 'approved' ||
        lockedItems.length === 0 ||
        orderSetApplicationSnapshot(lockedSet, lockedItems) !== expectedSnapshot
      ) {
        throw AppError.conflict(
          'Order set changed before the atomic application committed; refresh and retry',
          'CLINICAL_ORDER_SET_SNAPSHOT_CHANGED'
        );
      }
    }
  });

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
