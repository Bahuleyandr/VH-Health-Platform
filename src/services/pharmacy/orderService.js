import db from '../../config/database.js';
import { ORDER_STATUS } from '../../config/pharmacyConfig.js';
import logger from '../../logging/logger.js';

export const createOrder = async (orderData) => {
  const { phone, order_note, file_key, prescription_id, urgent, requestedBy, requestedByRole } = orderData;

  const result = await db.query(
    `INSERT INTO pharmacy_orders (
      phone, order_note, file_key, prescription_id, urgent, 
      status, requested_by, requested_by_role, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) 
    RETURNING id, phone, order_note, file_key, prescription_id, urgent, status, requested_by, requested_by_role, created_at`,
    [
      phone,
      order_note,
      file_key || null,
      prescription_id || null,
      urgent || false,
      ORDER_STATUS.PENDING,
      requestedBy,
      requestedByRole
    ]
  );

  logger.info(`Pharmacy order created: ${result.rows[0].id} for ${phone}`);

  return {
    ...result.rows[0],
    requestedBy,
    requestedByRole
  };
};

export const getOrdersByPhone = async (phone, filters) => {
  const { status, limit, offset } = filters;

  let query = 'SELECT id, phone, order_note, file_key, prescription_id, urgent, status, notes, requested_by, requested_by_role, updated_by, updated_by_role, created_at, updated_at FROM pharmacy_orders WHERE phone = $1';
  const params = [phone];

  if (status) {
    query += ' AND status = $2';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(limit, offset);

  const result = await db.query(query, params);

  return {
    orders: result.rows,
    filters: { status, limit, offset }
  };
};

export const getOrdersByUID = async (uid, filters) => {
  const { status, limit, offset } = filters;

  // First get phone number from UID
  const userResult = await db.query('SELECT phone FROM users WHERE uid = $1', [uid]);
  
  if (userResult.rows.length === 0) {
    return { orders: [], filters: { status, limit, offset } };
  }

  const phone = userResult.rows[0].phone;
  return getOrdersByPhone(phone, filters);
};

// Valid state transitions for pharmacy order state machine
const VALID_TRANSITIONS = {
  'PENDING': ['CONFIRMED', 'CANCELLED'],
  'CONFIRMED': ['PREPARING', 'CANCELLED'],
  'PREPARING': ['READY', 'DISPATCHED', 'CANCELLED'],
  'READY': ['DISPATCHED', 'CANCELLED'],
  'DISPATCHED': ['DELIVERED', 'CANCELLED'],
  'DELIVERED': [],
  'CANCELLED': []
};

export const updateOrderStatus = async (orderId, status, notes, updatedBy, updatedByRole) => {
  // Validate status is a known value
  const validStatuses = Object.values(ORDER_STATUS);
  if (!validStatuses.includes(status)) {
    throw new Error('INVALID_STATUS');
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Lock the row and get current status to validate transition
    const current = await client.query(
      'SELECT id, status FROM pharmacy_orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );

    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const currentStatus = current.rows[0].status;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(status)) {
      await client.query('ROLLBACK');
      throw new Error('INVALID_TRANSITION');
    }

    const result = await client.query(
      `UPDATE pharmacy_orders
       SET status = $1, notes = $2, updated_by = $3, updated_by_role = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING id, phone, order_note, file_key, prescription_id, urgent, status, notes, requested_by, requested_by_role, updated_by, updated_by_role, created_at, updated_at`,
      [status, notes || null, updatedBy, updatedByRole, orderId]
    );

    await client.query('COMMIT');

    logger.info(`Order ${orderId} status updated from ${currentStatus} to ${status} by ${updatedBy}`);

    return {
      order: result.rows[0],
      previousStatus: currentStatus,
      updatedBy,
      updatedByRole
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(rollbackErr => {
      logger.error('Transaction rollback failed:', rollbackErr);
    });
    throw err;
  } finally {
    client.release();
  }
};

export const getAllOrders = async (filters) => {
  const { status, limit, offset, urgent_only } = filters;

  let query = `
    SELECT po.id, po.phone, po.order_note, po.file_key, po.prescription_id, po.urgent, po.status, po.notes, po.requested_by, po.requested_by_role, po.updated_by, po.updated_by_role, po.created_at, po.updated_at,
           TO_CHAR(po.created_at, 'DD-MM-YYYY HH24:MI') as created_at_formatted,
           u.name as patient_name
    FROM pharmacy_orders po
    LEFT JOIN users u ON po.phone = u.phone
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    query += ' AND po.status = $' + (params.length + 1);
    params.push(status);
  }

  if (urgent_only) {
    query += ' AND po.urgent = true';
  }

  query += ' ORDER BY po.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(limit, offset);

  const result = await db.query(query, params);

  return {
    orders: result.rows,
    count: result.rows.length,
    filters: { status, limit, offset, urgent_only }
  };
};