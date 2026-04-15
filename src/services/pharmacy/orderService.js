// src/services/pharmacy/orderService.js
// Legacy pharmacy order service — kept for phone-based patient flows.
// Canonical schema: pharmacy_orders (patient_id int, priority, prescribed_by, dispensed_by,
// confirmation_notes, items_list jsonb, etc.). See also controllers/pharmacy/pharmacyOrderController.js
// for the richer delivery-tracking flow.

import { ORDER_STATUS, ORDER_STATUS_TRANSITIONS } from '../../config/pharmacyConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const ORDER_SELECT = `id, uid, phone, patient_id, patient_name, patient_phone, order_note,
    status, priority, file_key, prescription_url, prescription_photo_key,
    total_amount, payment_status, prescribed_by, dispensed_by,
    confirmation_notes, items_list, token_number, ordered_at, updated_at`;

export const createOrder = async (orderData) => {
  const { phone, order_note, file_key, urgent, requestedBy, requestedByRole } = orderData;
  const priority = urgent ? 'urgent' : 'normal';

  // Resolve phone → patient_id (users.id) if available
  const users = await prisma.$queryRaw`SELECT id, name FROM users WHERE phone = ${phone} LIMIT 1`;
  const patientId = users[0]?.id ?? null;
  const patientName = users[0]?.name ?? null;

  // `prescribed_by` is uuid. Only set it if the requester has a uuid (not "system").
  const prescribedBy = /^[0-9a-f-]{36}$/i.test(String(requestedBy || '')) ? requestedBy : null;

  const order = await prisma.$queryRaw`
    INSERT INTO pharmacy_orders (
      phone, patient_id, patient_name, order_note, file_key,
      priority, status, prescribed_by, ordered_at, updated_at
    ) VALUES (
      ${phone}, ${patientId}, ${patientName}, ${order_note},
      ${file_key ?? null}, ${priority}, ${ORDER_STATUS.PENDING},
      ${prescribedBy}::uuid, NOW(), NOW()
    )
    RETURNING id, uid, phone, patient_id, patient_name, order_note, file_key,
      priority, status, prescribed_by, ordered_at, updated_at
  `;

  logger.info(`Pharmacy order created: ${order[0].id} for ${phone}`);
  return { ...order[0], requestedBy, requestedByRole };
};

export const getOrdersByPhone = async (phone, filters) => {
  const { status, limit, offset } = filters;
  const safeLimit = Math.max(1, parseInt(limit) || 50);
  const safeOffset = Math.max(0, parseInt(offset) || 0);

  let rows;
  if (status) {
    rows = await prisma.$queryRaw`
      SELECT id, uid, phone, patient_id, patient_name, order_note, file_key,
        priority, status, confirmation_notes, prescribed_by, dispensed_by,
        ordered_at, updated_at
      FROM pharmacy_orders
      WHERE phone = ${phone} AND status = ${status}
      ORDER BY ordered_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;
  } else {
    rows = await prisma.$queryRaw`
      SELECT id, uid, phone, patient_id, patient_name, order_note, file_key,
        priority, status, confirmation_notes, prescribed_by, dispensed_by,
        ordered_at, updated_at
      FROM pharmacy_orders
      WHERE phone = ${phone}
      ORDER BY ordered_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;
  }

  return { orders: rows, filters: { status, limit: safeLimit, offset: safeOffset } };
};

export const getOrdersByUID = async (uid, filters) => {
  const users = await prisma.$queryRaw`SELECT phone FROM users WHERE uid = ${uid}::uuid`;
  if (users.length === 0) return { orders: [], filters };
  return getOrdersByPhone(users[0].phone, filters);
};

export const updateOrderStatus = async (orderId, status, notes, updatedBy, updatedByRole) => {
  const validStatuses = Object.values(ORDER_STATUS);
  if (!validStatuses.includes(status)) throw new Error('INVALID_STATUS');

  return prisma.$transaction(async (tx) => {
    const current = await tx.$queryRaw`
      SELECT id, status FROM pharmacy_orders WHERE id = ${parseInt(orderId)} FOR UPDATE
    `;

    if (current.length === 0) return null;

    const currentStatus = current[0].status;
    const allowed = ORDER_STATUS_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(status)) throw new Error('INVALID_TRANSITION');

    // `dispensed_by` is uuid; only set when a uuid is supplied.
    const dispensedByUuid = /^[0-9a-f-]{36}$/i.test(String(updatedBy || '')) ? updatedBy : null;

    const updated = await tx.$queryRaw`
      UPDATE pharmacy_orders
      SET status             = ${status},
          confirmation_notes = COALESCE(${notes ?? null}, confirmation_notes),
          dispensed_by       = COALESCE(${dispensedByUuid}::uuid, dispensed_by),
          updated_at         = NOW()
      WHERE id = ${parseInt(orderId)}
      RETURNING id, uid, phone, patient_id, patient_name, order_note, file_key,
        priority, status, confirmation_notes, prescribed_by, dispensed_by,
        ordered_at, updated_at
    `;

    // History trail — changed_by is int (users.id). Accept only numeric updatedBy here.
    const changedByInt = Number.isFinite(Number(updatedBy)) ? parseInt(updatedBy) : null;
    await tx.$queryRaw`
      INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role, notes)
      VALUES (${parseInt(orderId)}, ${currentStatus}, ${status}, ${changedByInt}, ${updatedByRole ?? null}, ${notes ?? null})
    `;

    logger.info(`Order ${orderId} status updated from ${currentStatus} to ${status} by ${updatedBy}`);
    return { order: updated[0], previousStatus: currentStatus, updatedBy, updatedByRole };
  });
};

export const getAllOrders = async (filters) => {
  const { status, limit, offset, urgent_only } = filters;
  const safeLimit = Math.max(1, parseInt(limit) || 100);
  const safeOffset = Math.max(0, parseInt(offset) || 0);

  let rows;
  if (status && urgent_only) {
    rows = await prisma.$queryRaw`
      SELECT po.id, po.uid, po.phone, po.patient_id, po.patient_name, po.order_note,
        po.file_key, po.priority, po.status, po.confirmation_notes, po.prescribed_by,
        po.dispensed_by, po.ordered_at, po.updated_at,
        TO_CHAR(po.ordered_at, 'DD-MM-YYYY HH24:MI') AS ordered_at_formatted,
        u.name AS lookup_patient_name
      FROM pharmacy_orders po
      LEFT JOIN users u ON po.phone = u.phone
      WHERE po.status = ${status} AND po.priority = 'urgent'
      ORDER BY po.ordered_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;
  } else if (status) {
    rows = await prisma.$queryRaw`
      SELECT po.id, po.uid, po.phone, po.patient_id, po.patient_name, po.order_note,
        po.file_key, po.priority, po.status, po.confirmation_notes, po.prescribed_by,
        po.dispensed_by, po.ordered_at, po.updated_at,
        TO_CHAR(po.ordered_at, 'DD-MM-YYYY HH24:MI') AS ordered_at_formatted,
        u.name AS lookup_patient_name
      FROM pharmacy_orders po
      LEFT JOIN users u ON po.phone = u.phone
      WHERE po.status = ${status}
      ORDER BY po.ordered_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;
  } else if (urgent_only) {
    rows = await prisma.$queryRaw`
      SELECT po.id, po.uid, po.phone, po.patient_id, po.patient_name, po.order_note,
        po.file_key, po.priority, po.status, po.confirmation_notes, po.prescribed_by,
        po.dispensed_by, po.ordered_at, po.updated_at,
        TO_CHAR(po.ordered_at, 'DD-MM-YYYY HH24:MI') AS ordered_at_formatted,
        u.name AS lookup_patient_name
      FROM pharmacy_orders po
      LEFT JOIN users u ON po.phone = u.phone
      WHERE po.priority = 'urgent'
      ORDER BY po.ordered_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;
  } else {
    rows = await prisma.$queryRaw`
      SELECT po.id, po.uid, po.phone, po.patient_id, po.patient_name, po.order_note,
        po.file_key, po.priority, po.status, po.confirmation_notes, po.prescribed_by,
        po.dispensed_by, po.ordered_at, po.updated_at,
        TO_CHAR(po.ordered_at, 'DD-MM-YYYY HH24:MI') AS ordered_at_formatted,
        u.name AS lookup_patient_name
      FROM pharmacy_orders po
      LEFT JOIN users u ON po.phone = u.phone
      ORDER BY po.ordered_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;
  }

  return { orders: rows, count: rows.length, filters };
};
