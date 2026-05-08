// src/services/emr/orderEntryService.js
// CPOE (Computerized Provider Order Entry) service — typed Prisma ORM.
// Batch 56: migrated from `prisma.$queryRawUnsafe` to typed Prisma for the
// `clinical_orders` model. The `order_sets` table (used by applyOrderSet,
// getOrderSets, createOrderSet) lives only in raw migration 023 and is
// not declared in `prisma/schema.prisma` — those three sites stay raw
// (template-tag form, no array-as-spread foot-gun) until the schema gets
// an `order_sets` model.
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default
import { scheduleMedications } from '../clinical/marService.js';


// ===================================================================
// Order Entry (CPOE) Service
// ===================================================================

const VALID_ORDER_TYPES = ['medication', 'investigation', 'nursing', 'diet', 'activity', 'consultation'];
const VALID_PRIORITIES = ['stat', 'urgent', 'routine', 'prn'];

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
    encounter_id,
    patient_uid,
    order_type,
    details,
    ordered_by,
    start_date,
    end_date,
    notes,
  } = data;

  // Clinicians write priority in upper case ("STAT" / "URGENT") — that's
  // the universal medical convention. Lower-case server-side before
  // validation so the universal form doesn't error out.
  // See finding 2026-05-08-emergency-walk-in-doctor-priority-case-sensitive.
  const priority = String(data.priority ?? 'routine').toLowerCase();

  if (!patient_uid || !order_type || !details || !ordered_by) {
    throw AppError.badRequest('patient_uid, order_type, details, and ordered_by are required');
  }

  if (!VALID_ORDER_TYPES.includes(order_type)) {
    throw AppError.badRequest(`Invalid order_type: ${order_type}. Must be one of: ${VALID_ORDER_TYPES.join(', ')}`);
  }

  if (!VALID_PRIORITIES.includes(priority)) {
    throw AppError.badRequest(`Invalid priority: ${data.priority}. Must be one of: ${VALID_PRIORITIES.join(', ')} (case-insensitive)`);
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

  // If there are blockers, reject the order
  if (cdsResult.blockers.length > 0) {
    throw AppError.badRequest(
      `Order blocked by safety checks: ${cdsResult.blockers.join('; ')}`,
      'CDS_BLOCKER'
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

  // `order_sets` is not declared in prisma/schema.prisma (lives only in
  // raw migration 023). Keep the read raw — template-tag form so the
  // single bound id can't trip the array-as-spread foot-gun.
  const setRows = await prisma.$queryRaw`
    SELECT id, name, orders, is_active FROM order_sets WHERE id = ${Number(orderSetId)}
  `;

  if (setRows.length === 0) {
    throw AppError.notFound('Order set not found');
  }

  if (!setRows[0].is_active) {
    throw AppError.badRequest('Order set is inactive');
  }

  const orderTemplates = typeof setRows[0].orders === 'string'
    ? JSON.parse(setRows[0].orders)
    : setRows[0].orders;

  if (!Array.isArray(orderTemplates) || orderTemplates.length === 0) {
    throw AppError.badRequest('Order set has no order templates');
  }

  const createdOrders = [];

  for (const template of orderTemplates) {
    try {
      const result = await createOrder({
        encounter_id: encounterId || null,
        patient_uid: patientUid,
        order_type: template.order_type,
        priority: template.priority || 'routine',
        details: template.details,
        ordered_by: orderedBy,
        start_date: template.start_date || null,
        end_date: template.end_date || null,
        notes: template.notes || `From order set: ${setRows[0].name}`,
      });
      createdOrders.push(result);
    } catch (err) {
      // Log but continue — partial application is acceptable
      logger.warn(`Failed to create order from set template: ${err.message}`);
      createdOrders.push({ error: err.message, template });
    }
  }

  logger.info(`Order set '${setRows[0].name}' (id=${orderSetId}) applied for patient=${patientUid} by=${orderedBy}, ${createdOrders.length} orders`);
  return createdOrders;
}

// ===================================================================
// getOrderSets
// ===================================================================

/**
 * List available order sets, optionally filtered by category.
 * @param {string|null} category
 * @returns {Array} Order sets
 */
export async function getOrderSets(category) {
  // `order_sets` is not in prisma/schema.prisma — see applyOrderSet for
  // context. Use the template-tag form so each branch's binds are typed
  // and we don't repeat the pre-batch-56 array-as-spread bug.
  if (category) {
    return prisma.$queryRaw`
      SELECT id, name, description, category, orders, created_by, is_active, created_at
      FROM order_sets
      WHERE is_active = true AND category = ${category}
      ORDER BY name ASC
    `;
  }
  return prisma.$queryRaw`
    SELECT id, name, description, category, orders, created_by, is_active, created_at
    FROM order_sets
    WHERE is_active = true
    ORDER BY name ASC
  `;
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

  // `order_sets` not in Prisma schema — keep raw, template-tag form.
  const rows = await prisma.$queryRaw`
    INSERT INTO order_sets (name, description, category, orders, created_by, is_active, created_at)
    VALUES (${name}, ${description ?? null}, ${category}, ${JSON.stringify(orders)}::jsonb, ${created_by}, true, NOW())
    RETURNING id, name, description, category, orders, created_by, is_active, created_at
  `;

  logger.info(`Order set created: id=${rows[0].id}, name=${name}, category=${category}, by=${created_by}`);
  return rows[0];
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
