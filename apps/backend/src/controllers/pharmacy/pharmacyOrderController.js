// src/controllers/pharmacy/pharmacyOrderController.js
// Full pharmacy order lifecycle: PENDING → CONFIRMED → PREPARING → DISPATCHED → DELIVERED

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';
import { calculateETA } from '../delivery/deliveryTrackingController.js';

// ── Helper: attach signed URL to order ──────────────────────────────────────
async function attachSignedUrl(order) {
  if (order.prescription_photo_key) {
    try {
      order.prescription_photo_url = await getSignedFileUrl(order.prescription_photo_key, 3600);
    } catch (e) { logger.warn('Signed URL generation failed for prescription photo:', e.message); }
  }
  return order;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATIENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

export const placeOrder = async (req, res) => {
  try {
    const patientId = req.user?.id;
    const {
      order_note, delivery_type, delivery_address, delivery_landmark,
      delivery_lat, delivery_lng, delivery_phone
    } = req.body;

    if (!req.file && !order_note) {
      return error(res, 'Upload a prescription photo or describe your order', HTTP_STATUS.BAD_REQUEST);
    }

    let prescriptionPhotoKey = null;
    if (req.file) {
      const timestamp = Date.now();
      const ext = req.file.originalname?.split('.').pop() || 'jpg';
      prescriptionPhotoKey = `pharmacy/prescriptions/${patientId}/${timestamp}.${ext}`;
      await uploadFileToR2(req.file.buffer, prescriptionPhotoKey, req.file.mimetype);
    }

    const patient = await prisma.$queryRawUnsafe(
      'SELECT name, phone FROM users WHERE id=$1', patientId);
    const patientName = patient[0]?.name || 'Patient';
    const patientPhone = patient[0]?.phone || '';

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO pharmacy_orders (
        patient_id, phone, patient_name, patient_phone, order_note,
        prescription_photo_key, delivery_type,
        delivery_address, delivery_landmark, delivery_lat, delivery_lng,
        delivery_phone, status, prescribed_by, ordered_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING',$13::uuid, NOW(), NOW())
      RETURNING id, uid, patient_id, patient_name, patient_phone, phone, status,
        order_note, total_amount, created_at, updated_at, order_number, delivery_type
    `,
      patientId, patientPhone, patientName, patientPhone,
      order_note || null, prescriptionPhotoKey,
      delivery_type || 'delivery',
      delivery_address || null, delivery_landmark || null,
      delivery_lat || null, delivery_lng || null,
      delivery_phone || patientPhone,
      req.user?.uid || null
    );

    const order = result[0];

    await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_order_history (order_id, to_status, changed_by, changed_by_role, notes)
       VALUES ($1, 'PENDING', $2, 'patient', 'Order placed')`,
      order.id, patientId
    );

    setImmediate(async () => {
      try {
        await import('../../services/smsService.js');
        logger.info(`Pharmacy order ${order.order_number} placed by ${patientName}`);
      } catch (e) {
        logger.warn('Pharmacist alert failed:', e.message);
      }
    });

    success(res, order, `Order placed. ${order.order_number}`);
  } catch (err) {
    logger.error('Place pharmacy order error:', err);
    error(res, 'Failed to place order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getMyOrders = async (req, res) => {
  try {
    const patientId = req.user?.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, uid, patient_id, patient_name, patient_phone, prescription_url, prescription_photo_key,
        status, order_note, delivery_type, delivery_address, delivery_landmark,
        total_amount, payment_status, assigned_pharmacist, token_number,
        created_at, updated_at, dispatched_at, delivered_at
       FROM pharmacy_orders WHERE patient_id=$1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      patientId, limit, offset);

    const orders = await Promise.all(result.map(attachSignedUrl));
    success(res, orders, 'My orders', HTTP_STATUS.OK, { limit, offset });
  } catch (err) {
    logger.error('Get my pharmacy orders error:', err);
    error(res, 'Failed to fetch orders', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PHARMACIST / STAFF ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

export const getOrderQueue = async (req, res) => {
  try {
    const { status, from_date, to_date } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (status) {
      params.push(status);
      where += ` AND po.status=$${params.length}`;
    }
    if (from_date) {
      params.push(from_date);
      where += ` AND DATE(po.created_at)>=$${params.length}`;
    }
    if (to_date) {
      params.push(to_date);
      where += ` AND DATE(po.created_at)<=$${params.length}`;
    }

    const result = await prisma.$queryRawUnsafe(`
      SELECT po.id, po.uid, po.patient_id, po.patient_name, po.patient_phone, po.prescription_url,
        po.prescription_photo_key, po.status, po.order_note, po.delivery_type, po.delivery_address,
        po.total_amount, po.payment_status, po.assigned_pharmacist, po.token_number,
        po.created_at, po.updated_at, po.dispatched_at, po.delivered_at,
        EXTRACT(EPOCH FROM (NOW()-po.created_at))/60 as mins_since_placed,
        CASE WHEN po.status='PENDING' AND po.sla_confirm_target IS NOT NULL AND NOW()>po.sla_confirm_target THEN TRUE ELSE FALSE END as sla_breached
      FROM pharmacy_orders po
      ${where}
      ORDER BY
        CASE po.status
          WHEN 'PENDING' THEN 1
          WHEN 'CONFIRMED' THEN 2
          WHEN 'PREPARING' THEN 3
          WHEN 'DISPATCHED' THEN 4
          ELSE 5
        END,
        po.created_at ASC
    `, ...params);

    const orders = await Promise.all(result.map(attachSignedUrl));
    success(res, orders, 'Order queue');
  } catch (err) {
    logger.error('Get pharmacy order queue error:', err);
    error(res, 'Failed to fetch order queue', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const confirmOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { confirmation_notes, items_list, total_amount } = req.body;

    if (items_list !== undefined) {
      if (!Array.isArray(items_list)) return error(res, 'items_list must be an array', HTTP_STATUS.BAD_REQUEST);
      if (items_list.length > 100) return error(res, 'items_list exceeds maximum of 100 items', HTTP_STATUS.BAD_REQUEST);
      for (const item of items_list) {
        if (typeof item !== 'object' || item === null) return error(res, 'Each item must be an object', HTTP_STATUS.BAD_REQUEST);
      }
    }

    const order = await prisma.$queryRawUnsafe(
      `SELECT id, uid, patient_id, patient_name, patient_phone, phone, prescription_url, status,
        order_note, delivery_type, delivery_address, total_amount, payment_status, assigned_pharmacist,
        token_number, order_number, delivery_phone, created_at, updated_at, dispatched_at, delivered_at
       FROM pharmacy_orders WHERE id=$1`, parseInt(id));
    if (!order.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    if (order[0].status !== 'PENDING') {
      return error(res, 'Can only confirm PENDING orders', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE pharmacy_orders SET
        status='CONFIRMED', confirmed_by=$1, confirmed_at=NOW(),
        confirmation_notes=$2, items_list=$3::jsonb, total_amount=$4,
        sla_dispatch_target=NOW()+INTERVAL '30 minutes', updated_at=NOW()
      WHERE id=$5
      RETURNING id, uid, patient_id, patient_name, status, order_note, total_amount,
        confirmation_notes, items_list, created_at, updated_at
    `,
      staffId, confirmation_notes || null,
      JSON.stringify(items_list || []),
      total_amount ?? order[0].total_amount,
      parseInt(id)
    );

    await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role, notes)
       VALUES ($1, 'PENDING', 'CONFIRMED', $2, 'pharmacist', $3)`,
      parseInt(id), staffId, confirmation_notes || null
    );

    setImmediate(async () => {
      try {
        const { sendSMS } = await import('../../services/smsService.js');
        const patientPhone = order[0].phone || order[0].delivery_phone;
        if (sendSMS && patientPhone) {
          await sendSMS(
            patientPhone,
            `Dear ${order[0].patient_name || 'Patient'}, your pharmacy order ${order[0].order_number} is confirmed. Total: Rs.${total_amount || 'TBD'}. Cash on delivery.`
          ).catch(e => logger.warn('Pharmacy confirm SMS failed:', e.message));
        }
      } catch (e) {
        logger.warn('Pharmacy confirm notification failed:', e.message);
      }
    });

    success(res, result[0], 'Order confirmed');
  } catch (err) {
    logger.error('Confirm pharmacy order error:', err);
    error(res, 'Failed to confirm order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const markPreparing = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await prisma.$queryRawUnsafe(
      `UPDATE pharmacy_orders SET status='PREPARING', preparing_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='CONFIRMED'
       RETURNING id, uid, patient_id, patient_name, status, order_note, total_amount, created_at, updated_at`,
      parseInt(id)
    );

    if (!result.length) {
      return error(res, 'Order not found or wrong status', HTTP_STATUS.BAD_REQUEST);
    }

    await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role)
       VALUES ($1, 'CONFIRMED', 'PREPARING', $2, 'pharmacist')`,
      parseInt(id), req.user?.id
    );

    success(res, result[0], 'Preparing');
  } catch (err) {
    logger.error('Mark preparing error:', err);
    error(res, 'Failed to update order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const dispatchOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { delivery_person, delivery_person_phone } = req.body;

    const order = await prisma.$queryRawUnsafe(
      `SELECT id, uid, patient_id, patient_name, patient_phone, phone, status,
        order_note, order_number, delivery_type, delivery_address, delivery_phone,
        delivery_lat, delivery_lng, total_amount
       FROM pharmacy_orders WHERE id=$1`, parseInt(id));
    if (!order.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);

    const validStatuses = ['CONFIRMED', 'PREPARING'];
    if (!validStatuses.includes(order[0].status)) {
      return error(res, 'Order must be CONFIRMED or PREPARING to dispatch', HTTP_STATUS.BAD_REQUEST);
    }

    const fromStatus = order[0].status;

    const result = await prisma.$queryRawUnsafe(`
      UPDATE pharmacy_orders SET
        status='DISPATCHED', dispatched_at=NOW(), dispatched_by=$1,
        delivery_person=$2, delivery_person_phone=$3,
        sla_delivery_target=NOW()+INTERVAL '2 hours', updated_at=NOW()
      WHERE id=$4
      RETURNING id, uid, patient_id, patient_name, status, delivery_person,
        delivery_person_phone, dispatched_at, total_amount, created_at, updated_at
    `,
      staffId, delivery_person || null, delivery_person_phone || null, parseInt(id)
    );

    await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role)
       VALUES ($1, $2, 'DISPATCHED', $3, 'pharmacist')`,
      parseInt(id), fromStatus, staffId
    );

    let eta = { estimated_mins: null, distance_km: null };
    try {
      eta = calculateETA(order[0].delivery_lat, order[0].delivery_lng) || eta;
    } catch (e) {
      logger.warn('calculateETA failed:', e.message);
    }
    await prisma.$queryRawUnsafe(
      `UPDATE pharmacy_orders SET estimated_delivery_mins=$1, delivery_distance_km=$2,
         delivery_started_at=NOW(), delivery_tracking_active=TRUE WHERE id=$3`,
      eta.estimated_mins, eta.distance_km, parseInt(id)
    );

    setImmediate(async () => {
      try {
        const { sendSMS } = await import('../../services/smsService.js');
        const patientPhone = order[0].phone || order[0].delivery_phone;
        if (sendSMS && patientPhone) {
          await sendSMS(
            patientPhone,
            `Your medicines (${order[0].order_number}) have been dispatched. Estimated delivery: ~${eta.estimated_mins} minutes. ${delivery_person_phone ? 'Delivery contact: ' + delivery_person_phone : ''}`
          ).catch(e => logger.warn('Dispatch SMS failed:', e.message));
        }
      } catch (e) {
        logger.warn('Dispatch notification failed:', e.message);
      }
    });

    success(res, result[0], 'Order dispatched');
  } catch (err) {
    logger.error('Dispatch pharmacy order error:', err);
    error(res, 'Failed to dispatch order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const markDelivered = async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    if (!Number.isInteger(orderId)) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }

    // Pull items_list + linked prescription up-front so we can do the
    // stock decrement + Rx fulfilment hook in the same transaction.
    // Findings: 2026-05-08-walk-in-opd-pharmacy-dispense-no-stock-decrement,
    // 2026-05-08-walk-in-opd-pharmacy-prescription-not-fulfilled-after-dispense.
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders SET status='DELIVERED', delivered_at=NOW(),
           delivery_tracking_active=FALSE, updated_at=NOW()
         WHERE id=$1 AND status='DISPATCHED'
         RETURNING id, uid, patient_id, patient_name, status, order_note, total_amount,
           items_list, delivered_at, created_at, updated_at`,
        orderId,
      );
      if (!updated.length) return null;
      const order = updated[0];

      // Decrement stock for each catalog item that resolved to a row.
      // Items with no catalog_id and no name match are skipped (kept loose
      // so legacy free-text orders don't 500). Aggregate per catalog_id so
      // duplicates in the items_list don't double-skip a single UPDATE.
      const items = Array.isArray(order.items_list) ? order.items_list : [];
      const decrementByCatalog = new Map();
      for (const item of items) {
        const qty = Number(item?.qty ?? item?.quantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        let catalogId = item?.catalog_id ? parseInt(item.catalog_id, 10) : null;
        if (!catalogId && item?.name) {
          const match = await tx.$queryRawUnsafe(
            'SELECT id FROM pharmacy_catalog WHERE name ILIKE $1 LIMIT 1',
            item.name,
          );
          if (match.length) catalogId = match[0].id;
        }
        if (!catalogId) continue;
        decrementByCatalog.set(catalogId, (decrementByCatalog.get(catalogId) ?? 0) + qty);
      }
      for (const [catalogId, qty] of decrementByCatalog.entries()) {
        await tx.$queryRawUnsafe(
          `UPDATE pharmacy_catalog
              SET stock_quantity = GREATEST(COALESCE(stock_quantity, 0) - $1, 0),
                  updated_at = NOW()
            WHERE id = $2`,
          qty, catalogId,
        );
      }

      // Mirror the dispense onto the linked e_prescriptions row so the same
      // Rx can't be dispensed twice. Best-effort: pharmacy_order_id is not
      // always set (legacy paths) — skip silently if no link.
      await tx.$executeRawUnsafe(
        `UPDATE e_prescriptions
            SET status = 'fulfilled',
                pharmacy_opted = TRUE,
                pharmacy_order_id = COALESCE(pharmacy_order_id, $1),
                updated_at = NOW()
          WHERE pharmacy_order_id = $1
             OR (pharmacy_order_id IS NULL AND id IN (
                   SELECT ep.id FROM e_prescriptions ep
                   WHERE ep.patient_id = $2
                     AND ep.status IN ('active', 'pharmacy_linked')
                   ORDER BY ep.created_at DESC LIMIT 1
                 ))`,
        orderId, order.patient_id ?? null,
      );

      // History row last so it lands inside the same tx.
      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role)
         VALUES ($1, 'DISPATCHED', 'DELIVERED', $2, 'pharmacist')`,
        orderId, req.user?.id ?? null,
      );

      return order;
    });

    if (!result) {
      return error(res, 'Order not found or wrong status', HTTP_STATUS.BAD_REQUEST);
    }

    success(res, result, 'Delivered');
  } catch (err) {
    logger.error('Mark delivered error:', err);
    error(res, 'Failed to update order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * B-2 — counter-dispense flow. The patient walks up to the pharmacy
 * with their Rx, the pharmacist confirms + hands it over on the spot.
 * No CONFIRMED -> PREPARING -> DISPATCHED -> DELIVERED chain — that's
 * for delivery orders. From PENDING (or CONFIRMED) directly to
 * DISPENSED, with the same stock-decrement + Rx-fulfilment hooks
 * markDelivered runs. Required: delivery_type='counter' on the order
 * (else use the delivery flow).
 */
export const markCounterDispensed = async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId)) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$transaction(async (tx) => {
      // Pull state + delivery_type up-front so the wrong-flow guard
      // returns a clean 400 instead of an empty UPDATE result.
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, status, delivery_type, items_list, patient_id
           FROM pharmacy_orders WHERE id=$1`,
        orderId,
      );
      if (!existing.length) return { error: 'NOT_FOUND' };
      const order = existing[0];
      if (order.delivery_type !== 'counter') {
        return { error: 'WRONG_FLOW' };
      }
      if (!['PENDING', 'CONFIRMED'].includes(order.status)) {
        return { error: 'WRONG_STATUS', status: order.status };
      }

      // dispensed_by is UUID FK → users.uid (not the int id). Use the
      // JWT's uid claim, not the integer id used elsewhere in this
      // controller for confirmed_by/changed_by (those are int FKs).
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET status='DISPENSED', dispensed_by=$2::uuid, dispensed_at=NOW(),
                delivery_tracking_active=FALSE, updated_at=NOW()
          WHERE id=$1
          RETURNING id, uid, patient_id, patient_name, status, order_note,
                    total_amount, items_list, dispensed_at, created_at,
                    updated_at, order_number, delivery_type`,
        orderId, req.user?.uid ?? null,
      );
      const out = updated[0];

      // Same stock-decrement aggregator as markDelivered.
      const items = Array.isArray(out.items_list) ? out.items_list : [];
      const decByCatalog = new Map();
      for (const item of items) {
        const qty = Number(item?.qty ?? item?.quantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        let catalogId = item?.catalog_id ? parseInt(item.catalog_id, 10) : null;
        if (!catalogId && item?.name) {
          const match = await tx.$queryRawUnsafe(
            'SELECT id FROM pharmacy_catalog WHERE name ILIKE $1 LIMIT 1',
            item.name,
          );
          if (match.length) catalogId = match[0].id;
        }
        if (!catalogId) continue;
        decByCatalog.set(catalogId, (decByCatalog.get(catalogId) ?? 0) + qty);
      }
      for (const [catalogId, qty] of decByCatalog.entries()) {
        await tx.$queryRawUnsafe(
          `UPDATE pharmacy_catalog
              SET stock_quantity = GREATEST(COALESCE(stock_quantity, 0) - $1, 0),
                  updated_at = NOW()
            WHERE id = $2`,
          qty, catalogId,
        );
      }

      // Rx fulfilment, identical to markDelivered.
      await tx.$executeRawUnsafe(
        `UPDATE e_prescriptions
            SET status = 'fulfilled',
                pharmacy_opted = TRUE,
                pharmacy_order_id = COALESCE(pharmacy_order_id, $1),
                updated_at = NOW()
          WHERE pharmacy_order_id = $1
             OR (pharmacy_order_id IS NULL AND id IN (
                   SELECT ep.id FROM e_prescriptions ep
                   WHERE ep.patient_id = $2
                     AND ep.status IN ('active', 'pharmacy_linked')
                   ORDER BY ep.created_at DESC LIMIT 1
                 ))`,
        orderId, out.patient_id ?? null,
      );

      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1, $2, 'DISPENSED', $3, 'pharmacist', 'Counter dispense')`,
        orderId, order.status, req.user?.id ?? null,
      );

      return { ok: out };
    });

    if (result.error === 'NOT_FOUND') return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    if (result.error === 'WRONG_FLOW') {
      return error(res, 'Order is not a counter order — use the delivery flow', HTTP_STATUS.BAD_REQUEST);
    }
    if (result.error === 'WRONG_STATUS') {
      return error(res, `Cannot dispense from status=${result.status}; expected PENDING or CONFIRMED`, HTTP_STATUS.BAD_REQUEST);
    }
    success(res, result.ok, 'Counter dispense complete');
  } catch (err) {
    logger.error('Counter dispense error:', err);
    error(res, 'Failed to dispense order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { cancellation_reason } = req.body;

    const order = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM pharmacy_orders WHERE id=$1`, parseInt(id));
    if (!order.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    if (['DELIVERED', 'CANCELLED'].includes(order[0].status)) {
      return error(res, 'Cannot cancel delivered or already cancelled order', HTTP_STATUS.BAD_REQUEST);
    }

    const fromStatus = order[0].status;

    const result = await prisma.$queryRawUnsafe(
      `UPDATE pharmacy_orders SET status='CANCELLED', cancellation_reason=$2,
         cancelled_at=NOW(), updated_at=NOW()
       WHERE id=$1
       RETURNING id, uid, patient_id, patient_name, status, order_note, total_amount,
         cancellation_reason, cancelled_at, created_at, updated_at`,
      parseInt(id), cancellation_reason || null
    );

    await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role, notes)
       VALUES ($1, $2, 'CANCELLED', $3, 'staff', $4)`,
      parseInt(id), fromStatus, req.user?.id, cancellation_reason || null
    );

    success(res, result[0], 'Order cancelled');
  } catch (err) {
    logger.error('Cancel pharmacy order error:', err);
    error(res, 'Failed to cancel order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getPharmacySLADashboard = async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const from = from_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to = to_date || new Date().toISOString().split('T')[0];

    const [summary, avgTimes, slaBreaches] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int as total,
          COUNT(CASE WHEN status='PENDING' THEN 1 END)::int as placed,
          COUNT(CASE WHEN status='CONFIRMED' THEN 1 END)::int as confirmed,
          COUNT(CASE WHEN status='PREPARING' THEN 1 END)::int as preparing,
          COUNT(CASE WHEN status='DISPATCHED' THEN 1 END)::int as dispatched,
          COUNT(CASE WHEN status='DELIVERED' THEN 1 END)::int as delivered,
          COUNT(CASE WHEN status='CANCELLED' THEN 1 END)::int as cancelled,
          SUM(CASE WHEN status='DELIVERED' THEN COALESCE(total_amount,0) ELSE 0 END) as total_revenue
        FROM pharmacy_orders WHERE DATE(created_at) BETWEEN $1::date AND $2::date
      `, from, to),
      prisma.$queryRawUnsafe(`
        SELECT
          AVG(EXTRACT(EPOCH FROM (confirmed_at-created_at))/60) as avg_confirm_mins,
          AVG(EXTRACT(EPOCH FROM (dispatched_at-confirmed_at))/60) as avg_dispatch_mins,
          AVG(EXTRACT(EPOCH FROM (delivered_at-dispatched_at))/60) as avg_delivery_mins
        FROM pharmacy_orders WHERE delivered_at IS NOT NULL AND DATE(created_at) BETWEEN $1::date AND $2::date
      `, from, to),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int as count FROM pharmacy_orders
         WHERE status='PENDING' AND sla_confirm_target IS NOT NULL AND NOW()>sla_confirm_target
           AND DATE(created_at) BETWEEN $1::date AND $2::date`,
        from, to
      ),
    ]);

    success(res, {
      summary: summary[0],
      avg_times: avgTimes[0],
      sla_breaches: parseInt(slaBreaches[0]?.count || 0),
      date_range: { from, to }
    });
  } catch (err) {
    logger.error('Pharmacy SLA dashboard error:', err);
    error(res, 'Failed to fetch SLA data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getOrderDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.$queryRawUnsafe(
      `SELECT id, uid, patient_id, patient_name, patient_phone, prescription_url,
        prescription_photo_key, status, order_note, delivery_type, delivery_address,
        total_amount, payment_status, assigned_pharmacist, token_number, order_number,
        confirmation_notes, items_list, cancellation_reason, cancelled_at,
        created_at, updated_at, confirmed_at, preparing_at, dispatched_at, delivered_at
       FROM pharmacy_orders WHERE id=$1`, parseInt(id));
    if (!order.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);

    const history = await prisma.$queryRawUnsafe(
      `SELECT id, order_id, from_status, to_status, changed_by, changed_by_role, notes, created_at
       FROM pharmacy_order_history WHERE order_id=$1 ORDER BY created_at ASC`,
      parseInt(id));

    await attachSignedUrl(order[0]);

    success(res, { order: order[0], history }, 'Order detail');
  } catch (err) {
    logger.error('Get pharmacy order detail error:', err);
    error(res, 'Failed to fetch order detail', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CATALOG ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

export const getCatalog = async (req, res) => {
  try {
    const { category, search } = req.query;
    let where = 'WHERE is_active=TRUE';
    const params = [];

    if (category) {
      params.push(category);
      where += ` AND category=$${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (name ILIKE $${params.length} OR generic_name ILIKE $${params.length})`;
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, name, category, price, stock, is_available, description, created_at
       FROM pharmacy_catalog ${where} ORDER BY category, name`,
      ...params
    );
    success(res, result, 'Catalog');
  } catch (err) {
    logger.error('Get pharmacy catalog error:', err);
    error(res, 'Failed to fetch catalog', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const upsertCatalog = async (req, res) => {
  try {
    const {
      id, name, generic_name, category, manufacturer,
      unit_price, pack_size, requires_prescription,
      in_stock, stock_quantity, reorder_level
    } = req.body;

    if (!name) return error(res, 'Medicine name is required', HTTP_STATUS.BAD_REQUEST);

    let result;
    if (id) {
      result = await prisma.$queryRawUnsafe(
        `UPDATE pharmacy_catalog SET
          name=$1, generic_name=$2, category=$3, manufacturer=$4,
          unit_price=$5, pack_size=$6, requires_prescription=$7,
          in_stock=$8, stock_quantity=$9, reorder_level=$10, updated_at=NOW()
        WHERE id=$11 RETURNING id, name, generic_name, category, manufacturer,
          unit_price, pack_size, requires_prescription, in_stock, stock_quantity,
          reorder_level, updated_at`,
        name, generic_name, category, manufacturer, unit_price, pack_size,
        requires_prescription ?? true, in_stock ?? true,
        stock_quantity || 0, reorder_level || 10, id
      );
    } else {
      result = await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_catalog
          (name, generic_name, category, manufacturer, unit_price, pack_size,
           requires_prescription, in_stock, stock_quantity, reorder_level)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id, name, generic_name, category, manufacturer, unit_price,
          pack_size, requires_prescription, in_stock, stock_quantity, reorder_level, created_at`,
        name, generic_name || null, category || 'other', manufacturer || null,
        unit_price || null, pack_size || null, requires_prescription ?? true,
        in_stock ?? true, stock_quantity || 0, reorder_level || 10
      );
    }

    success(res, result[0], id ? 'Medicine updated' : 'Medicine added');
  } catch (err) {
    logger.error('Upsert pharmacy catalog error:', err);
    error(res, 'Failed to save medicine', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
