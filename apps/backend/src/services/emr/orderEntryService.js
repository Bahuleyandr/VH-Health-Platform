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
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import {
  validatePrescriptionSafety,
  checkAntithromboticInteractions,
} from '../../utils/clinical/prescriptionSafetyCheck.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default
import { scheduleMedications } from '../clinical/marService.js';
import { recordFirstDrugChartEntry } from '../clinical/drugChartSlaService.js';
import { createWardIndentForClinicalMedicationOrder } from '../ipd/ipdSupportService.js';
import { createInvestigationOrder } from '../investigation/orderService.js';
import {
  recordCanonicalClinicalEvent,
  recordMedicationSafetyReviews,
} from '../clinical/canonicalClinicalPlatformService.js';


// ===================================================================
// Order Entry (CPOE) Service
// ===================================================================

// `ecg`, `radiology`, and `procedure` are first-class types, not aliases
// to `investigation`: collapsing them loses the machine-readable
// differentiation the receiving department's worklist needs — a STAT ECG
// (door-to-balloon clock) must not land in the same bucket as a routine
// blood test. Finding: 2026-05-09-emergency-walk-in-doctor-no-ecg-order-type.
const VALID_ORDER_TYPES = ['medication', 'investigation', 'nursing', 'diet', 'activity', 'consultation', 'ecg', 'radiology', 'procedure'];
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
 */
async function runCDSChecks(patientUid, orderType, details) {
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
      };

      // Check patient-specific hazards for the new drug first. This preserves
      // the existing hard-block behavior for allergies and paediatric dosing.
      const safetyResult = await validatePrescriptionSafety(patientRow.id, [
        newMedication,
      ]);

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
    // CDS check failure should not block order creation — log and continue
    logger.warn(`CDS check failed for patient=${patientUid}, orderType=${orderType}: ${err.message}`);
    result.warnings.push('CDS safety check could not be completed');
  }

  return result;
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

async function recordCanonicalOrderEvent({
  order,
  eventType,
  eventStatus = null,
  actorUid = null,
  actorRole = null,
  previousStatus = null,
  payload = {},
  beforeState = null,
  afterState = null,
  safety = null,
} = {}) {
  if (!order?.id) return null;
  const status = eventStatus || order.status || null;
  const stamp = order.updated_at?.toISOString?.()
    || order.created_at?.toISOString?.()
    || Date.now();

  try {
    if (safety && order.order_type === 'medication') {
      await recordMedicationSafetyReviews({
        tenantId: order.tenant_id,
        patientUid: order.patient_uid,
        encounterId: order.encounter_id,
        clinicalOrderId: order.id,
        safety,
        actorUid: actorUid || order.ordered_by,
      });
    }

    return await recordCanonicalClinicalEvent({
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
    });
  } catch (err) {
    logger.warn(`Canonical clinical order event skipped for order ${order.id}`, {
      error: err?.message || String(err),
    });
    return null;
  }
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

/**
 * Post-commit best-effort side effects for a freshly created order: ward
 * indent for IPD medication orders, downstream integration dispatch, and
 * a STAT push. All failures are logged, never thrown — shared by the
 * single-order and bulk paths.
 */
async function dispatchPostCreateSideEffects(order) {
  if (order.order_type === 'medication') {
    await recordFirstDrugChartEntry(order).catch((err) => {
      logger.warn(`Failed to audit first drug chart entry for order ${order.order_number}: ${err.message}`);
    });
  }

  if (order.order_type === 'medication' && order.encounter_id) {
    await createWardIndentForClinicalMedicationOrder(order).catch((err) => {
      logger.error(`Failed to create ward indent for medication order ${order.order_number}: ${err.message}`);
    });
  }

  // Dispatch integrations. Investigation materialization is awaited so
  // a freshly-saved lab order is present on the lab worklist by the time
  // the doctor sees the create response; other integrations stay best-effort.
  const integrationDispatch = dispatchOrderIntegrations(order).catch((err) => {
    logger.error(`Order integration dispatch failed for order ${order.order_number}: ${err.message}`);
  });
  if (order.order_type === 'investigation') {
    await integrationDispatch;
  }

  // STAT orders — push notification to relevant staff
  if (order.priority === 'stat') {
    notificationOutbox.queue({
      type: 'push',
      recipientId: null, // broadcast to relevant staff
      title: 'STAT Order',
      body: `STAT ${order.order_type} order ${order.order_number} for patient`,
      data: {
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
 * @param {Object} data - { encounter_id?, patient_uid, order_type, priority?, details, ordered_by, start_date?, end_date?, notes? }
 * @returns {Object} Created order with CDS check results
 */
export async function createOrder(data) {
  const n = await normalizeOrderInput(data);

  // Run CDS safety checks. Blockers reject the order — surface the
  // structured array as `details` so the staff-app CDS modal can show
  // per-blocker context + the override flow.
  const cdsResult = await runCDSChecks(n.patient_uid, n.order_type, n.details);
  if (cdsResult.blockers.length > 0) {
    throw AppError.badRequest(
      `Order blocked by safety checks: ${cdsResult.blockers.map(renderBlocker).join('; ')}`,
      'CDS_BLOCKER',
      { blockers: cdsResult.blockers, warnings: cdsResult.warnings },
    );
  }

  const orderNumber = await generateOrderNumber();

  // `details` is a Json column — pass the object directly (Prisma serialises).
  // `status` defaults to 'ordered' in the schema; pre-ORM SQL set it explicitly,
  // so we preserve that for clarity.
  const order = await prisma.clinical_orders.create({
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

  await dispatchPostCreateSideEffects(order);
  await recordCanonicalOrderEvent({
    order,
    eventType: 'order.created',
    eventStatus: order.status,
    actorUid: n.ordered_by,
    afterState: { status: order.status },
    safety: cdsResult,
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
 * @param {Object} ctx - { ordered_by }
 * @returns {Array<{ order, cds_warnings }>}
 * Finding 2026-05-08-inpatient-admission-doctor-no-batch-ordering.
 */
export async function createOrdersBulk(items, { ordered_by } = {}) {
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
    const cdsResult = await runCDSChecks(normalized.patient_uid, normalized.order_type, normalized.details);
    if (cdsResult.blockers.length > 0) {
      throw AppError.badRequest(
        `Order #${i + 1} blocked by safety checks: ${cdsResult.blockers.map(renderBlocker).join('; ')}`,
        'CDS_BLOCKER',
        { order_index: i, blockers: cdsResult.blockers, warnings: cdsResult.warnings },
      );
    }
    prepared.push({ normalized, cds_warnings: cdsResult.warnings });
  }

  // One DB read seeds the whole batch's order numbers.
  const orderNumbers = await generateOrderNumbers(prepared.length);

  // Phase 1 — atomic insert. Every row or none; no best-effort calls
  // inside the transaction (a swallowed Prisma error would abort the tx).
  const createdRows = await prisma.$transaction(async (tx) => {
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
      rows.push(row);
    }
    return rows;
  });

  // Phase 1.5 — post-commit best-effort side effects per order.
  for (let i = 0; i < createdRows.length; i += 1) {
    const order = createdRows[i];
    await dispatchPostCreateSideEffects(order);
    await recordCanonicalOrderEvent({
      order,
      eventType: 'order.created',
      eventStatus: order.status,
      actorUid: order.ordered_by,
      payload: { bulk_order_count: createdRows.length },
      afterState: { status: order.status },
      safety: order.order_type === 'medication'
        ? { safe: true, warnings: prepared[i].cds_warnings || [], blockers: [] }
        : null,
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
      logger.error(`Failed to create MAR entries for order ${order.order_number}: ${err.message}`);
    }
  }

  if (order.order_type === 'investigation') {
    await materializeInvestigationForClinicalOrder(order);
  }
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

  const updated = await prisma.clinical_orders.update({
    where: { id: existing.id },
    data: {
      status: 'verified',
      verified_by: verifiedBy,
      verified_at: new Date(),
    },
    select: ORDER_RETURNING_SELECT,
  });

  await recordCanonicalOrderEvent({
    order: updated,
    eventType: 'order.verified',
    eventStatus: updated.status,
    actorUid: verifiedBy,
    previousStatus: existing.status,
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

  const updated = await prisma.clinical_orders.update({
    where: { id: existing.id },
    data: {
      status: 'completed',
      completed_by: completedBy,
      completed_at: new Date(),
    },
    select: ORDER_RETURNING_SELECT,
  });

  await recordCanonicalOrderEvent({
    order: updated,
    eventType: 'order.completed',
    eventStatus: updated.status,
    actorUid: completedBy,
    previousStatus: existing.status,
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

  const updated = await prisma.clinical_orders.update({
    where: { id: existing.id },
    data: {
      status: 'cancelled',
      cancelled_by: cancelledBy,
      cancel_reason: reason,
    },
    select: ORDER_RETURNING_SELECT,
  });

  await recordCanonicalOrderEvent({
    order: updated,
    eventType: 'order.cancelled',
    eventStatus: updated.status,
    actorUid: cancelledBy,
    previousStatus: existing.status,
    payload: { cancel_reason: reason },
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

  const updated = await prisma.clinical_orders.update({
    where: { id: existing.id },
    data: {
      status: 'discontinued',
      cancelled_by: discontinuedBy,
      cancel_reason: reason,
      end_date: new Date(),
    },
    select: ORDER_RETURNING_SELECT,
  });

  await recordCanonicalOrderEvent({
    order: updated,
    eventType: 'order.discontinued',
    eventStatus: updated.status,
    actorUid: discontinuedBy,
    previousStatus: existing.status,
    payload: { discontinue_reason: reason },
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
function orderRequestFromItem(item, orderSetTitle) {
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
 * @returns {Array} Created orders
 */
export async function applyOrderSet(patientUid, encounterId, orderSetId, orderedBy) {
  if (!patientUid || !orderSetId || !orderedBy) {
    throw AppError.badRequest('patientUid, orderSetId, and orderedBy are required');
  }

  const set = await prisma.clinical_order_sets.findUnique({
    where: { id: Number(orderSetId) },
    select: { id: true, title: true, active: true },
  });

  if (!set) {
    throw AppError.notFound('Order set not found');
  }

  if (!set.active) {
    throw AppError.badRequest('Order set is inactive');
  }

  const items = await prisma.clinical_order_set_items.findMany({
    where: { order_set_id: set.id },
    orderBy: { display_order: 'asc' },
  });

  if (!items.length) {
    throw AppError.badRequest('Order set has no order templates');
  }

  const createdOrders = [];

  for (const item of items) {
    try {
      const req = orderRequestFromItem(item, set.title);
      const result = await createOrder({
        encounter_id: encounterId || null,
        patient_uid: patientUid,
        order_type: req.order_type,
        priority: req.priority,
        details: req.details,
        ordered_by: orderedBy,
        start_date: null,
        end_date: null,
        notes: req.notes,
      });
      createdOrders.push(result);
    } catch (err) {
      // Log but continue — partial application is acceptable. Don't
      // surface err.message to the response (per CLAUDE.md security
      // checklist); the caller sees the count of successful orders.
      logger.warn(`Failed to create order from set template (kind=${item.kind}): ${err.message}`);
      createdOrders.push({ error: 'Order template could not be applied', kind: item.kind });
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
  const where = { active: true };
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
 * @param {Object} data - { name, description?, category, orders, created_by }
 * @returns {Object} Created order set
 */
export async function createOrderSet(data) {
  const { name, description, category, orders, created_by } = data;

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

  const created = await prisma.$transaction(async (tx) => {
    const set = await tx.clinical_order_sets.create({
      data: {
        code: code.slice(0, 60),
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
