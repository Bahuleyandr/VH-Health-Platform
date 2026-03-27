// src/controllers/pharmacy/pharmacyOrderController.js
// Full pharmacy order lifecycle: PLACED → CONFIRMED → PREPARING → DISPATCHED → DELIVERED

import { HTTP_STATUS } from '../../config/responseCodes.js';
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';
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

// POST /pharmacy/orders/place — patient places order with prescription photo
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

    const patient = await db.query('SELECT name, phone FROM users WHERE id=$1', [patientId]);
    const patientName = patient.rows[0]?.name || 'Patient';
    const patientPhone = patient.rows[0]?.phone || '';

    const result = await db.query(`
      INSERT INTO pharmacy_orders (
        patient_id, phone, patient_name, order_note,
        prescription_photo_key, delivery_type,
        delivery_address, delivery_landmark, delivery_lat, delivery_lng,
        delivery_phone, status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PLACED',$12)
      RETURNING *
    `, [
      patientId, patientPhone, patientName,
      order_note || null, prescriptionPhotoKey,
      delivery_type || 'delivery',
      delivery_address || null, delivery_landmark || null,
      delivery_lat || null, delivery_lng || null,
      delivery_phone || patientPhone,
      req.user?.uid
    ]);

    const order = result.rows[0];

    // Log history
    await db.query(
      `INSERT INTO pharmacy_order_history (order_id, to_status, changed_by, changed_by_role, notes)
       VALUES ($1,'PLACED',$2,'patient','Order placed')`,
      [order.id, patientId]
    );

    // Alert pharmacist staff (fire-and-forget)
    setImmediate(async () => {
      try {
        const { sendSMS } = await import('../../services/smsService.js');
        // Notify admin/pharmacy staff via SMS or push — simplified
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

// GET /pharmacy/orders/my — patient's own orders
export const getMyOrders = async (req, res) => {
  try {
    const patientId = req.user?.id;
    const result = await db.query(
      `SELECT * FROM pharmacy_orders WHERE patient_id=$1 ORDER BY created_at DESC`,
      [patientId]
    );

    const orders = await Promise.all(result.rows.map(attachSignedUrl));
    success(res, orders, 'My orders');
  } catch (err) {
    logger.error('Get my pharmacy orders error:', err);
    error(res, 'Failed to fetch orders', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PHARMACIST / STAFF ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /pharmacy/orders/queue — pharmacist sees all orders
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

    const result = await db.query(`
      SELECT po.*,
        EXTRACT(EPOCH FROM (NOW()-po.created_at))/60 as mins_since_placed,
        CASE WHEN po.status='PLACED' AND NOW()>po.sla_confirm_target THEN TRUE ELSE FALSE END as sla_breached
      FROM pharmacy_orders po
      ${where}
      ORDER BY
        CASE po.status
          WHEN 'PLACED' THEN 1
          WHEN 'CONFIRMED' THEN 2
          WHEN 'PREPARING' THEN 3
          WHEN 'DISPATCHED' THEN 4
          ELSE 5
        END,
        po.created_at ASC
    `, params);

    const orders = await Promise.all(result.rows.map(attachSignedUrl));
    success(res, orders, 'Order queue');
  } catch (err) {
    logger.error('Get pharmacy order queue error:', err);
    error(res, 'Failed to fetch order queue', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /pharmacy/orders/:id/confirm — pharmacist confirms, enters items + cost
export const confirmOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { confirmation_notes, items_list, total_cost } = req.body;

    const order = await db.query('SELECT * FROM pharmacy_orders WHERE id=$1', [id]);
    if (!order.rows.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    if (order.rows[0].status !== 'PLACED') {
      return error(res, 'Can only confirm PLACED orders', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await db.query(`
      UPDATE pharmacy_orders SET
        status='CONFIRMED', confirmed_by=$1, confirmed_at=NOW(),
        confirmation_notes=$2, items_list=$3, total_cost=$4,
        sla_dispatch_target=NOW()+INTERVAL '30 minutes', updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [
      staffId, confirmation_notes || null,
      JSON.stringify(items_list || []),
      total_cost || order.rows[0].total_cost,
      id
    ]);

    await db.query(
      `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role, notes)
       VALUES ($1,'PLACED','CONFIRMED',$2,'pharmacist',$3)`,
      [id, staffId, confirmation_notes]
    );

    // Notify patient (fire-and-forget)
    setImmediate(async () => {
      try {
        const { sendSMS } = await import('../../services/smsService.js');
        const patientPhone = order.rows[0].phone || order.rows[0].delivery_phone;
        if (sendSMS && patientPhone) {
          await sendSMS(
            patientPhone,
            `Dear ${order.rows[0].patient_name || 'Patient'}, your pharmacy order ${order.rows[0].order_number} is confirmed. Total: Rs.${total_cost || 'TBD'}. Cash on delivery.`
          ).catch(e => logger.warn('Pharmacy confirm SMS failed:', e.message));
        }
      } catch (e) {
        logger.warn('Pharmacy confirm notification failed:', e.message);
      }
    });

    success(res, result.rows[0], 'Order confirmed');
  } catch (err) {
    logger.error('Confirm pharmacy order error:', err);
    error(res, 'Failed to confirm order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /pharmacy/orders/:id/preparing — mark order as being prepared
export const markPreparing = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE pharmacy_orders SET status='PREPARING', preparing_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='CONFIRMED' RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return error(res, 'Order not found or wrong status', HTTP_STATUS.BAD_REQUEST);
    }

    await db.query(
      `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role)
       VALUES ($1,'CONFIRMED','PREPARING',$2,'pharmacist')`,
      [id, req.user?.id]
    );

    success(res, result.rows[0], 'Preparing');
  } catch (err) {
    logger.error('Mark preparing error:', err);
    error(res, 'Failed to update order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /pharmacy/orders/:id/dispatch — pharmacist dispatches
export const dispatchOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { delivery_person, delivery_person_phone } = req.body;

    const order = await db.query('SELECT * FROM pharmacy_orders WHERE id=$1', [id]);
    if (!order.rows.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);

    const validStatuses = ['CONFIRMED', 'PREPARING'];
    if (!validStatuses.includes(order.rows[0].status)) {
      return error(res, 'Order must be CONFIRMED or PREPARING to dispatch', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await db.query(`
      UPDATE pharmacy_orders SET
        status='DISPATCHED', dispatched_at=NOW(), dispatched_by=$1,
        delivery_person=$2, delivery_person_phone=$3,
        sla_delivery_target=NOW()+INTERVAL '2 hours', updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [staffId, delivery_person || null, delivery_person_phone || null, id]);

    await db.query(
      `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role)
       VALUES ($1,$2,'DISPATCHED',$3,'pharmacist')`,
      [id, order.rows[0].status, staffId]
    );

    // Calculate ETA based on delivery destination
    const eta = calculateETA(order.rows[0].delivery_lat, order.rows[0].delivery_lng);
    await db.query(`UPDATE pharmacy_orders SET estimated_delivery_mins=$1, delivery_distance_km=$2, delivery_started_at=NOW(), delivery_tracking_active=TRUE WHERE id=$3`,
      [eta.estimated_mins, eta.distance_km, id]);

    // Notify patient
    setImmediate(async () => {
      try {
        const { sendSMS } = await import('../../services/smsService.js');
        const patientPhone = order.rows[0].phone || order.rows[0].delivery_phone;
        if (sendSMS && patientPhone) {
          await sendSMS(
            patientPhone,
            `Your medicines (${order.rows[0].order_number}) have been dispatched. Estimated delivery: ~${eta.estimated_mins} minutes. ${delivery_person_phone ? 'Delivery contact: ' + delivery_person_phone : ''}`
          ).catch(e => logger.warn('Dispatch SMS failed:', e.message));
        }
      } catch (e) {
        logger.warn('Dispatch notification failed:', e.message);
      }
    });

    success(res, result.rows[0], 'Order dispatched');
  } catch (err) {
    logger.error('Dispatch pharmacy order error:', err);
    error(res, 'Failed to dispatch order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /pharmacy/orders/:id/delivered — mark as delivered
export const markDelivered = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE pharmacy_orders SET status='DELIVERED', delivered_at=NOW(), delivery_tracking_active=FALSE, updated_at=NOW()
       WHERE id=$1 AND status='DISPATCHED' RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return error(res, 'Order not found or wrong status', HTTP_STATUS.BAD_REQUEST);
    }

    await db.query(
      `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role)
       VALUES ($1,'DISPATCHED','DELIVERED',$2,'pharmacist')`,
      [id, req.user?.id]
    );

    success(res, result.rows[0], 'Delivered');
  } catch (err) {
    logger.error('Mark delivered error:', err);
    error(res, 'Failed to update order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /pharmacy/orders/:id/cancel — cancel order
export const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { cancellation_reason } = req.body;

    const order = await db.query('SELECT * FROM pharmacy_orders WHERE id=$1', [id]);
    if (!order.rows.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    if (['DELIVERED', 'CANCELLED'].includes(order.rows[0].status)) {
      return error(res, 'Cannot cancel delivered or already cancelled order', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await db.query(
      `UPDATE pharmacy_orders SET status='CANCELLED', cancellation_reason=$2,
       cancelled_at=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id, cancellation_reason || null]
    );

    await db.query(
      `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role, notes)
       VALUES ($1,$2,'CANCELLED',$3,'staff',$4)`,
      [id, order.rows[0].status, req.user?.id, cancellation_reason]
    );

    success(res, result.rows[0], 'Order cancelled');
  } catch (err) {
    logger.error('Cancel pharmacy order error:', err);
    error(res, 'Failed to cancel order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// GET /pharmacy/orders/sla — SLA dashboard
export const getPharmacySLADashboard = async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const from = from_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to = to_date || new Date().toISOString().split('T')[0];

    const [summary, avgTimes, slaBreaches] = await Promise.all([
      db.query(`
        SELECT COUNT(*) as total,
          COUNT(CASE WHEN status='PLACED' THEN 1 END) as placed,
          COUNT(CASE WHEN status='CONFIRMED' THEN 1 END) as confirmed,
          COUNT(CASE WHEN status='PREPARING' THEN 1 END) as preparing,
          COUNT(CASE WHEN status='DISPATCHED' THEN 1 END) as dispatched,
          COUNT(CASE WHEN status='DELIVERED' THEN 1 END) as delivered,
          COUNT(CASE WHEN status='CANCELLED' THEN 1 END) as cancelled,
          SUM(CASE WHEN status='DELIVERED' THEN COALESCE(total_cost,0) ELSE 0 END) as total_revenue
        FROM pharmacy_orders WHERE DATE(created_at) BETWEEN $1 AND $2
      `, [from, to]),
      db.query(`
        SELECT
          AVG(EXTRACT(EPOCH FROM (confirmed_at-created_at))/60) as avg_confirm_mins,
          AVG(EXTRACT(EPOCH FROM (dispatched_at-confirmed_at))/60) as avg_dispatch_mins,
          AVG(EXTRACT(EPOCH FROM (delivered_at-dispatched_at))/60) as avg_delivery_mins
        FROM pharmacy_orders WHERE delivered_at IS NOT NULL AND DATE(created_at) BETWEEN $1 AND $2
      `, [from, to]),
      db.query(
        `SELECT COUNT(*) as count FROM pharmacy_orders
         WHERE status='PLACED' AND NOW()>sla_confirm_target AND DATE(created_at) BETWEEN $1 AND $2`,
        [from, to]
      ),
    ]);

    success(res, {
      summary: summary.rows[0],
      avg_times: avgTimes.rows[0],
      sla_breaches: parseInt(slaBreaches.rows[0]?.count || 0),
      date_range: { from, to }
    });
  } catch (err) {
    logger.error('Pharmacy SLA dashboard error:', err);
    error(res, 'Failed to fetch SLA data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// GET /pharmacy/orders/:id — order detail with history
export const getOrderDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await db.query('SELECT * FROM pharmacy_orders WHERE id=$1', [id]);
    if (!order.rows.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);

    const history = await db.query(
      'SELECT * FROM pharmacy_order_history WHERE order_id=$1 ORDER BY created_at',
      [id]
    );

    await attachSignedUrl(order.rows[0]);

    success(res, { order: order.rows[0], history: history.rows }, 'Order detail');
  } catch (err) {
    logger.error('Get pharmacy order detail error:', err);
    error(res, 'Failed to fetch order detail', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CATALOG ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /pharmacy/catalog — medicine catalog
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

    const result = await db.query(
      `SELECT * FROM pharmacy_catalog ${where} ORDER BY category, name`,
      params
    );
    success(res, result.rows, 'Catalog');
  } catch (err) {
    logger.error('Get pharmacy catalog error:', err);
    error(res, 'Failed to fetch catalog', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// POST /pharmacy/catalog — add/edit medicine
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
      result = await db.query(
        `UPDATE pharmacy_catalog SET
          name=$1, generic_name=$2, category=$3, manufacturer=$4,
          unit_price=$5, pack_size=$6, requires_prescription=$7,
          in_stock=$8, stock_quantity=$9, reorder_level=$10, updated_at=NOW()
        WHERE id=$11 RETURNING *`,
        [name, generic_name, category, manufacturer, unit_price, pack_size,
         requires_prescription ?? true, in_stock ?? true,
         stock_quantity || 0, reorder_level || 10, id]
      );
    } else {
      result = await db.query(
        `INSERT INTO pharmacy_catalog
          (name, generic_name, category, manufacturer, unit_price, pack_size,
           requires_prescription, in_stock, stock_quantity, reorder_level)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [name, generic_name || null, category || 'other', manufacturer || null,
         unit_price || null, pack_size || null, requires_prescription ?? true,
         in_stock ?? true, stock_quantity || 0, reorder_level || 10]
      );
    }

    success(res, result.rows[0], id ? 'Medicine updated' : 'Medicine added');
  } catch (err) {
    logger.error('Upsert pharmacy catalog error:', err);
    error(res, 'Failed to save medicine', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
