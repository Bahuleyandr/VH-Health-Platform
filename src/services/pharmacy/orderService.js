// src/services/pharmacy/orderService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';
import { ORDER_STATUS } from '../../config/pharmacyConfig.js';
import logger from '../../logging/logger.js';

export const createOrder = async (orderData) => {
  const { phone, order_note, file_key, prescription_id, urgent, requestedBy, requestedByRole } = orderData;

  const order = await prisma.$queryRaw`
    INSERT INTO pharmacy_orders (
      phone, order_note, file_key, prescription_id, urgent,
      status, requested_by, requested_by_role, ordered_at
    ) VALUES (
      ${phone}, ${order_note}, ${file_key ?? null},
      ${prescription_id ?? null}, ${urgent ?? false},
      ${ORDER_STATUS.PENDING}, ${requestedBy ?? null}, ${requestedByRole ?? null}, NOW()
    )
    RETURNING id, phone, order_note, file_key, prescription_id, urgent,
      status, requested_by, requested_by_role, ordered_at
  `;

  logger.info(`Pharmacy order created: ${order[0].id} for ${phone}`);
  return { ...order[0], requestedBy, requestedByRole };
};

export const getOrdersByPhone = async (phone, filters) => {
  const { status, limit, offset } = filters;

  let rows;
  if (status) {
    rows = await prisma.$queryRaw`
      SELECT id, phone, order_note, file_key, prescription_id, urgent, status,
             notes, requested_by, requested_by_role, updated_by, updated_by_role,
             ordered_at, updated_at
      FROM pharmacy_orders
      WHERE phone = ${phone} AND status = ${status}
      ORDER BY ordered_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `;
  } else {
    rows = await prisma.$queryRaw`
      SELECT id, phone, order_note, file_key, prescription_id, urgent, status,
             notes, requested_by, requested_by_role, updated_by, updated_by_role,
             ordered_at, updated_at
      FROM pharmacy_orders
      WHERE phone = ${phone}
      ORDER BY ordered_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `;
  }

  return { orders: rows, filters: { status, limit, offset } };
};

export const getOrdersByUID = async (uid, filters) => {
  const users = await prisma.$queryRaw`SELECT phone FROM users WHERE uid = ${uid}::uuid`;
  if (users.length === 0) return { orders: [], filters };
  return getOrdersByPhone(users[0].phone, filters);
};

const VALID_TRANSITIONS = {
  'PENDING':    ['CONFIRMED', 'CANCELLED'],
  'CONFIRMED':  ['PREPARING', 'CANCELLED'],
  'PREPARING':  ['READY', 'DISPATCHED', 'CANCELLED'],
  'READY':      ['DISPATCHED', 'CANCELLED'],
  'DISPATCHED': ['DELIVERED', 'CANCELLED'],
  'DELIVERED':  [],
  'CANCELLED':  [],
};

export const updateOrderStatus = async (orderId, status, notes, updatedBy, updatedByRole) => {
  const validStatuses = Object.values(ORDER_STATUS);
  if (!validStatuses.includes(status)) throw new Error('INVALID_STATUS');

  // Use interactive transaction for SELECT FOR UPDATE + conditional update
  return prisma.$transaction(async (tx) => {
    const current = await tx.$queryRaw`
      SELECT id, status FROM pharmacy_orders WHERE id = ${parseInt(orderId)} FOR UPDATE
    `;

    if (current.length === 0) return null;

    const currentStatus = current[0].status;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(status)) throw new Error('INVALID_TRANSITION');

    const updated = await tx.$queryRaw`
      UPDATE pharmacy_orders
      SET status           = ${status},
          notes            = ${notes ?? null},
          updated_by       = ${updatedBy ?? null},
          updated_by_role  = ${updatedByRole ?? null},
          updated_at       = NOW()
      WHERE id = ${parseInt(orderId)}
      RETURNING id, phone, order_note, file_key, prescription_id, urgent, status,
        notes, requested_by, requested_by_role, updated_by, updated_by_role,
        ordered_at, updated_at
    `;

    logger.info(`Order ${orderId} status updated from ${currentStatus} to ${status} by ${updatedBy}`);
    return { order: updated[0], previousStatus: currentStatus, updatedBy, updatedByRole };
  });
};

export const getAllOrders = async (filters) => {
  const { status, limit, offset, urgent_only } = filters;

  let rows;
  if (status && urgent_only) {
    rows = await prisma.$queryRaw`
      SELECT po.id, po.phone, po.order_note, po.file_key, po.prescription_id,
             po.urgent, po.status, po.notes, po.requested_by, po.requested_by_role,
             po.updated_by, po.updated_by_role, po.ordered_at, po.updated_at,
             TO_CHAR(po.ordered_at, 'DD-MM-YYYY HH24:MI') AS ordered_at_formatted,
             u.name AS patient_name
      FROM pharmacy_orders po
      LEFT JOIN users u ON po.phone = u.phone
      WHERE po.status = ${status} AND po.urgent = true
      ORDER BY po.ordered_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `;
  } else if (status) {
    rows = await prisma.$queryRaw`
      SELECT po.id, po.phone, po.order_note, po.file_key, po.prescription_id,
             po.urgent, po.status, po.notes, po.requested_by, po.requested_by_role,
             po.updated_by, po.updated_by_role, po.ordered_at, po.updated_at,
             TO_CHAR(po.ordered_at, 'DD-MM-YYYY HH24:MI') AS ordered_at_formatted,
             u.name AS patient_name
      FROM pharmacy_orders po
      LEFT JOIN users u ON po.phone = u.phone
      WHERE po.status = ${status}
      ORDER BY po.ordered_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `;
  } else if (urgent_only) {
    rows = await prisma.$queryRaw`
      SELECT po.id, po.phone, po.order_note, po.file_key, po.prescription_id,
             po.urgent, po.status, po.notes, po.requested_by, po.requested_by_role,
             po.updated_by, po.updated_by_role, po.ordered_at, po.updated_at,
             TO_CHAR(po.ordered_at, 'DD-MM-YYYY HH24:MI') AS ordered_at_formatted,
             u.name AS patient_name
      FROM pharmacy_orders po
      LEFT JOIN users u ON po.phone = u.phone
      WHERE po.urgent = true
      ORDER BY po.ordered_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `;
  } else {
    rows = await prisma.$queryRaw`
      SELECT po.id, po.phone, po.order_note, po.file_key, po.prescription_id,
             po.urgent, po.status, po.notes, po.requested_by, po.requested_by_role,
             po.updated_by, po.updated_by_role, po.ordered_at, po.updated_at,
             TO_CHAR(po.ordered_at, 'DD-MM-YYYY HH24:MI') AS ordered_at_formatted,
             u.name AS patient_name
      FROM pharmacy_orders po
      LEFT JOIN users u ON po.phone = u.phone
      ORDER BY po.ordered_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `;
  }

  return { orders: rows, count: rows.length, filters };
};
