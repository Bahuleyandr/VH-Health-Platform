// src/services/emr/orderEntryService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default
import { scheduleMedications } from '../clinical/marService.js';


// ===================================================================
// Order Entry (CPOE) Service
// ===================================================================

const VALID_ORDER_TYPES = ['medication', 'investigation', 'nursing', 'diet', 'activity', 'consultation'];
const VALID_PRIORITIES = ['stat', 'urgent', 'routine', 'prn'];

/**
 * Generate a unique order number: ORD-YYYYMMDD-XXXX
 */
async function generateOrderNumber() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `ORD-${today}-`;

  const { rows } = await prisma.$queryRawUnsafe(
    `SELECT order_number FROM clinical_orders
     WHERE order_number LIKE $1
     ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );

  let seq = 1;
  if (rows.length > 0) {
    const lastSeq = parseInt(rows[0].order_number.split('-').pop(), 10);
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
    priority = 'routine',
    details,
    ordered_by,
    start_date,
    end_date,
    notes,
  } = data;

  if (!patient_uid || !order_type || !details || !ordered_by) {
    throw AppError.badRequest('patient_uid, order_type, details, and ordered_by are required');
  }

  if (!VALID_ORDER_TYPES.includes(order_type)) {
    throw AppError.badRequest(`Invalid order_type: ${order_type}. Must be one of: ${VALID_ORDER_TYPES.join(', ')}`);
  }

  if (!VALID_PRIORITIES.includes(priority)) {
    throw AppError.badRequest(`Invalid priority: ${priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
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

  const { rows } = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_orders
       (order_number, encounter_id, patient_uid, order_type, priority, details, status,
        ordered_by, start_date, end_date, notes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'ordered', $7, $8, $9, $10, NOW())
     RETURNING id, order_number, encounter_id, patient_uid, order_type, priority, details,
               status, ordered_by, start_date, end_date, notes, created_at`,
    [
      orderNumber,
      encounter_id || null,
      patient_uid,
      order_type,
      priority,
      JSON.stringify(details),
      ordered_by,
      start_date || null,
      end_date || null,
      notes || null,
    ]
  );

  const order = rows[0];

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

  const { rows: existing } = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM clinical_orders WHERE id = $1`,
    [orderId]
  );

  if (existing.length === 0) {
    throw AppError.notFound('Order not found');
  }

  if (existing[0].status !== 'ordered') {
    throw AppError.badRequest(`Cannot verify order in status '${existing[0].status}'. Order must be in 'ordered' status.`);
  }

  const { rows } = await prisma.$queryRawUnsafe(
    `UPDATE clinical_orders
     SET status = 'verified', verified_by = $2, verified_at = NOW()
     WHERE id = $1
     RETURNING id, order_number, encounter_id, patient_uid, order_type, priority, details,
               status, ordered_by, verified_by, verified_at, start_date, end_date, notes, created_at`,
    [orderId, verifiedBy]
  );

  logger.info(`Order ${rows[0].order_number} verified by ${verifiedBy}`);
  return rows[0];
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

  const { rows: existing } = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM clinical_orders WHERE id = $1`,
    [orderId]
  );

  if (existing.length === 0) {
    throw AppError.notFound('Order not found');
  }

  const allowedStatuses = ['ordered', 'verified', 'in_progress'];
  if (!allowedStatuses.includes(existing[0].status)) {
    throw AppError.badRequest(`Cannot complete order in status '${existing[0].status}'`);
  }

  const { rows } = await prisma.$queryRawUnsafe(
    `UPDATE clinical_orders
     SET status = 'completed', completed_by = $2, completed_at = NOW()
     WHERE id = $1
     RETURNING id, order_number, encounter_id, patient_uid, order_type, priority, details,
               status, ordered_by, verified_by, verified_at, completed_by, completed_at,
               start_date, end_date, notes, created_at`,
    [orderId, completedBy]
  );

  logger.info(`Order ${rows[0].order_number} completed by ${completedBy}`);
  return rows[0];
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

  const { rows: existing } = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM clinical_orders WHERE id = $1`,
    [orderId]
  );

  if (existing.length === 0) {
    throw AppError.notFound('Order not found');
  }

  if (['completed', 'cancelled', 'discontinued'].includes(existing[0].status)) {
    throw AppError.badRequest(`Cannot cancel order in status '${existing[0].status}'`);
  }

  const { rows } = await prisma.$queryRawUnsafe(
    `UPDATE clinical_orders
     SET status = 'cancelled', cancelled_by = $2, cancel_reason = $3
     WHERE id = $1
     RETURNING id, order_number, encounter_id, patient_uid, order_type, priority, details,
               status, ordered_by, cancelled_by, cancel_reason, start_date, end_date, notes, created_at`,
    [orderId, cancelledBy, reason]
  );

  logger.info(`Order ${rows[0].order_number} cancelled by ${cancelledBy}: ${reason}`);
  return rows[0];
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

  const { rows: existing } = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM clinical_orders WHERE id = $1`,
    [orderId]
  );

  if (existing.length === 0) {
    throw AppError.notFound('Order not found');
  }

  const allowedStatuses = ['ordered', 'verified', 'in_progress'];
  if (!allowedStatuses.includes(existing[0].status)) {
    throw AppError.badRequest(`Cannot discontinue order in status '${existing[0].status}'`);
  }

  const { rows } = await prisma.$queryRawUnsafe(
    `UPDATE clinical_orders
     SET status = 'discontinued', cancelled_by = $2, cancel_reason = $3, end_date = NOW()
     WHERE id = $1
     RETURNING id, order_number, encounter_id, patient_uid, order_type, priority, details,
               status, ordered_by, cancelled_by, cancel_reason, start_date, end_date, notes, created_at`,
    [orderId, discontinuedBy, reason]
  );

  logger.info(`Order ${rows[0].order_number} discontinued by ${discontinuedBy}: ${reason}`);
  return rows[0];
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
  const { order_type, status, date_from, date_to, page = 1, limit = 20 } = filters;

  const conditions = ['co.patient_uid = $1'];
  const params = [patientUid];
  let paramIdx = 2;

  if (order_type) {
    conditions.push(`co.order_type = $${paramIdx}`);
    params.push(order_type);
    paramIdx++;
  }

  if (status) {
    conditions.push(`co.status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }

  if (date_from) {
    conditions.push(`co.created_at >= $${paramIdx}`);
    params.push(date_from);
    paramIdx++;
  }

  if (date_to) {
    conditions.push(`co.created_at <= $${paramIdx}`);
    params.push(date_to);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10)), 100);
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * safeLimit;

  const { rows: countRows } = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS total FROM clinical_orders co WHERE ${whereClause}`,
    params
  );
  const total = parseInt(countRows[0].total, 10);

  const { rows } = await prisma.$queryRawUnsafe(
    `SELECT co.id, co.order_number, co.encounter_id, co.patient_uid, co.order_type,
            co.priority, co.details, co.status, co.ordered_by, co.verified_by, co.verified_at,
            co.completed_by, co.completed_at, co.cancelled_by, co.cancel_reason,
            co.start_date, co.end_date, co.notes, co.created_at
     FROM clinical_orders co
     WHERE ${whereClause}
     ORDER BY co.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, safeLimit, offset]
  );

  return {
    orders: rows,
    pagination: {
      page: parseInt(page, 10),
      limit: safeLimit,
      total,
      total_pages: Math.ceil(total / safeLimit),
    },
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
  const { rows } = await prisma.$queryRawUnsafe(
    `SELECT id, order_number, encounter_id, patient_uid, order_type, priority, details,
            status, ordered_by, verified_by, verified_at, completed_by, completed_at,
            cancelled_by, cancel_reason, start_date, end_date, notes, created_at
     FROM clinical_orders
     WHERE encounter_id = $1
     ORDER BY created_at DESC`,
    [encounterId]
  );
  return rows;
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

  const { rows: setRows } = await prisma.$queryRawUnsafe(
    `SELECT id, name, orders, is_active FROM order_sets WHERE id = $1`,
    [orderSetId]
  );

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
  const conditions = ['is_active = true'];
  const params = [];
  let paramIdx = 1;

  if (category) {
    conditions.push(`category = $${paramIdx}`);
    params.push(category);
    paramIdx++;
  }

  const { rows } = await prisma.$queryRawUnsafe(
    `SELECT id, name, description, category, orders, created_by, is_active, created_at
     FROM order_sets
     WHERE ${conditions.join(' AND ')}
     ORDER BY name ASC`,
    params
  );

  return rows;
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

  const { rows } = await prisma.$queryRawUnsafe(
    `INSERT INTO order_sets (name, description, category, orders, created_by, is_active, created_at)
     VALUES ($1, $2, $3, $4, $5, true, NOW())
     RETURNING id, name, description, category, orders, created_by, is_active, created_at`,
    [name, description || null, category, JSON.stringify(orders), created_by]
  );

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
