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
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default
import { scheduleMedications } from '../clinical/marService.js';
import { createWardIndentForClinicalMedicationOrder } from '../ipd/ipdSupportService.js';


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
};

/**
 * Generate a unique order number: ORD-YYYYMMDD-XXXX
 */
async function generateOrderNumber() {
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

  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/**
 * Run CDS (Clinical Decision Support) safety checks for an order.
 * Returns { safe, warnings, blockers }.
 */
async function runCDSChecks(patientUid, orderType, details) {
  const result = { safe: true, warnings: [], blockers: [] };

  try {
    if (orderType === 'medication' && details.medication_name) {
      // Check drug interactions and allergies via existing prescription safety checker
      const safetyResult = await validatePrescriptionSafety(patientUid, [
        { name: details.medication_name },
      ]);

      result.warnings = safetyResult.warnings || [];
      result.blockers = safetyResult.blockers || [];
      result.safe = safetyResult.safe;
    }
  } catch (err) {
    // CDS check failure should not block order creation — log and continue
    logger.warn(`CDS check failed for patient=${patientUid}, orderType=${orderType}: ${err.message}`);
    result.warnings.push('CDS safety check could not be completed');
  }

  return result;
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
  const {
    patient_uid,
    details,
    ordered_by,
    start_date,
    end_date,
    notes,
    er_visit_id,
  } = data;
  // `encounter_id` may be re-derived from `er_visit_id` below, so it is a
  // `let` rather than part of the const destructure.
  let { encounter_id } = data;

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

  // Run CDS safety checks
  const cdsResult = await runCDSChecks(patient_uid, order_type, details);

  // If there are blockers, reject the order. Each blocker from
  // validatePrescriptionSafety is a shaped object — joining the array
  // directly would render every blocker as the literal "[object Object]"
  // and leave the prescribing doctor with no actionable detail
  // (`message:"Order blocked by safety checks: [object Object]"`). Map
  // each blocker through its renderable string field, and surface the
  // structured array as `details` so the staff-app CDS modal can show
  // per-blocker context + the override flow.
  // Findings:
  //   2026-05-10-inpatient-admission-doctor-medication-orders-cds-blocked
  //   2026-05-10-inpatient-admission-doctor-medication-cpoe-blocks-oral-switch-object-object
  //   2026-05-10-dynamic-acute-abdomen-doctor-medication-order-paths-blocked
  if (cdsResult.blockers.length > 0) {
    const renderedBlockers = cdsResult.blockers.map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object') {
        return b.message || b.reason || b.type || JSON.stringify(b);
      }
      return String(b);
    });
    throw AppError.badRequest(
      `Order blocked by safety checks: ${renderedBlockers.join('; ')}`,
      'CDS_BLOCKER',
      {
        blockers: cdsResult.blockers,
        warnings: cdsResult.warnings,
      },
    );
  }

  const orderNumber = await generateOrderNumber();

  // `details` is a Json column — pass the object directly (Prisma serialises).
  // `status` defaults to 'ordered' in the schema; pre-ORM SQL set it explicitly,
  // so we preserve that for clarity.
  const order = await prisma.clinical_orders.create({
    data: {
      order_number: orderNumber,
      encounter_id: encounter_id ?? null,
      patient_uid,
      order_type,
      priority,
      details,
      status: 'ordered',
      ordered_by,
      start_date: start_date ? new Date(start_date) : null,
      end_date: end_date ? new Date(end_date) : null,
      notes: notes ?? null,
    },
    select: ORDER_RETURNING_SELECT,
  });

  if (order.order_type === 'medication' && order.encounter_id) {
    await createWardIndentForClinicalMedicationOrder(order).catch((err) => {
      logger.error(`Failed to create ward indent for medication order ${order.order_number}: ${err.message}`);
    });
  }

  // Dispatch integrations (fire-and-forget, do not block response)
  dispatchOrderIntegrations(order).catch((err) => {
    logger.error(`Order integration dispatch failed for order ${order.order_number}: ${err.message}`);
  });

  // STAT orders — push notification to relevant staff
  if (priority === 'stat') {
    notificationOutbox.queue({
      type: 'push',
      recipientId: null, // broadcast to relevant staff
      title: 'STAT Order',
      body: `STAT ${order_type} order ${orderNumber} for patient`,
      data: { order_id: order.id, order_number: orderNumber, order_type, priority },
      channel: 'clinical_alert',
    }).catch((err) => {
      logger.warn(`Failed to queue STAT notification for order ${orderNumber}: ${err.message}`);
    });
  }

  logger.info(`Order created: ${orderNumber}, type=${order_type}, priority=${priority}, patient=${patient_uid}, by=${ordered_by}`);

  return {
    order,
    cds_warnings: cdsResult.warnings,
  };
}

/**
 * Dispatch order to downstream systems (pharmacy, lab) based on order type.
 */
async function dispatchOrderIntegrations(order) {
  if (order.order_type === 'medication') {
    // Create MAR entries via existing marService
    try {
      // `details` comes back from typed Prisma as a parsed object, but
      // keep the string-fallback for safety in case any caller passes a
      // pre-stringified payload.
      const details = typeof order.details === 'string' ? JSON.parse(order.details) : order.details;
      await scheduleMedications(order.patient_uid, null, [
        {
          medication_name: details.medication_name,
          dose: details.dose,
          route: details.route,
          scheduled_time: order.start_date || new Date().toISOString(),
          notes: details.prn_reason || null,
        },
      ]);
      logger.info(`MAR entries created for medication order ${order.order_number}`);
    } catch (err) {
      logger.error(`Failed to create MAR entries for order ${order.order_number}: ${err.message}`);
    }
  }

  if (order.order_type === 'investigation') {
    // Log that investigation booking should be created
    // Actual integration depends on investigation routes creating a booking
    logger.info(`Investigation order ${order.order_number} created — awaiting lab booking`);
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
    select: { id: true, status: true },
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
    select: { id: true, status: true },
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
    select: { id: true, status: true },
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
    select: { id: true, status: true },
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
function orderRequestFromItem(item, orderSetTitle) {
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  const priority = typeof payload.urgency === 'string' && VALID_PRIORITIES.includes(payload.urgency.toLowerCase())
    ? payload.urgency.toLowerCase()
    : (payload.prn ? 'prn' : 'routine');
  return {
    order_type: ITEM_KIND_TO_ORDER_TYPE[item.kind] || 'nursing',
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

export default {
  createOrder,
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
