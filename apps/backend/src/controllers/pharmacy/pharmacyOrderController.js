// src/controllers/pharmacy/pharmacyOrderController.js
// Full pharmacy order lifecycle: PENDING → CONFIRMED → PREPARING → DISPATCHED → DELIVERED

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';
import { calculateETA } from '../delivery/deliveryTrackingController.js';
import { probePharmacyCap, shouldBlockDispense } from '../../services/pharmacy/pharmacyCapService.js';

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

    // Surface `items_list` (the dispensed medication schedule —
    // name/dose/route/frequency/duration/instructions per line item).
    // Without it the patient sees only "DISPENSED" + an order note and
    // cannot safely administer multi-medication regimens at home (e.g.
    // post-cataract eye drops: Moxifloxacin QID, Prednisolone QID taper,
    // Nepafenac BD). Finding
    // 2026-05-10-surgical-day-care-patient-pharmacy-order-omits-eye-drop-schedule.
    const result = await prisma.$queryRawUnsafe(
      `SELECT id, uid, patient_id, patient_name, patient_phone, prescription_url, prescription_photo_key,
        status, order_note, delivery_type, delivery_address, delivery_landmark,
        total_amount, payment_status, assigned_pharmacist, token_number,
        items_list,
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
    // Stage-4-C — surface real cause. The previous catch-all "Failed to
    // confirm order" hid the actual DB / validation error so the
    // pharmacist couldn't tell whether the order was missing, already
    // confirmed, or hit a constraint. AppErrors keep their statusCode
    // + message; Postgres errors (FK violation 23503, unique 23505) map
    // to 400 with the constraint name so the operator at least knows
    // which input was wrong.
    // Finding: 2026-05-09-pediatric-opd-pharmacy-confirm-500
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, err.details);
    }
    if (err && typeof err.code === 'string' && err.code.startsWith('23')) {
      logger.error('Confirm pharmacy order DB constraint:', { code: err.code, detail: err.detail, constraint: err.constraint });
      return error(res, `Confirm rejected by database constraint ${err.constraint || err.code}`, HTTP_STATUS.BAD_REQUEST);
    }
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

    // Phase 0 — TPA pharmacy-cap pre-flight. Same gate as the counter
    // flow (see markCounterDispensed). markDelivered is the home-delivery
    // tail, but an IPD ward dispense can ride this flow when the order
    // was created before the counter route was wired, so we still
    // probe the cap.
    try {
      const preRows = await prisma.$queryRawUnsafe(
        `SELECT patient_id, total_amount FROM pharmacy_orders WHERE id=$1`,
        orderId,
      );
      if (preRows.length) {
        const probe = await probePharmacyCap({
          patientId: preRows[0].patient_id,
          additionalAmount: Number(preRows[0].total_amount ?? 0),
        });
        if (probe.message) {
          logger.warn('Pharmacy cap probe', { order_id: orderId, ...probe });
        }
        if (shouldBlockDispense(probe, { allowOverride: Boolean(req.body?.cap_override) })) {
          return error(res, probe.message, HTTP_STATUS.BAD_REQUEST, {
            code: 'TPA_PHARMACY_CAP_EXCEEDED',
            cap_amount: probe.pharmacyCap,
            current_spend: probe.currentSpend,
            projected_total: probe.projectedTotal,
            utilisation_pct: probe.utilisationPct,
          });
        }
      }
    } catch (capErr) {
      logger.warn('Pharmacy cap probe failed', { order_id: orderId, error: capErr.message });
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
      // Items_list shape is canonicalised on the order-create path, but
      // accept `medication_name` and `drug_name` as aliases for backwards
      // compat with rows created before that fix. See finding
      // 2026-05-09-walk-in-opd-pharmacy-stock-not-decremented.
      const items = Array.isArray(order.items_list) ? order.items_list : [];
      const decrementByCatalog = new Map();
      for (const item of items) {
        const qty = Number(item?.qty ?? item?.quantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        let catalogId = item?.catalog_id ? parseInt(item.catalog_id, 10) : null;
        const itemName = item?.name || item?.medication_name || item?.drug_name || null;
        if (!catalogId && itemName) {
          const match = await tx.$queryRawUnsafe(
            'SELECT id FROM pharmacy_catalog WHERE name ILIKE $1 LIMIT 1',
            itemName,
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

// Payment modes accepted on the counter dispense payload. Anything else
// is dropped so we don't write garbage strings into the column.
const COUNTER_PAYMENT_MODES = new Set([
  'cash', 'card', 'upi', 'wallet',
  'corporate_tpa', 'insurance', 'package', 'credit', 'none',
]);

// Modes that cover the cost through a non-cash channel — used to decide
// whether `amount_collected: 0` means "fully covered" or "still owed".
const NON_CASH_PAYMENT_MODES = new Set([
  'corporate_tpa', 'insurance', 'package', 'credit',
]);

const RECEIPT_DELIVERY_MODES = new Set(['phone', 'print', 'email', 'none']);

/**
 * Merge the pharmacist-supplied dispensed_items into the order's
 * existing items_list. Each dispensed item is keyed off catalog_id (or
 * name when catalog_id is absent) so a partial dispense overrides the
 * matching line rather than appending a duplicate. Returns the merged
 * items_list (used for stock decrement + total_amount) plus the
 * normalised partial flag.
 */
function mergeDispensedItems(existingItems, dispensedItems) {
  const existing = Array.isArray(existingItems) ? existingItems.map((i) => ({ ...i })) : [];
  const dispensed = Array.isArray(dispensedItems) ? dispensedItems : [];
  if (!dispensed.length) {
    return { items: existing, partialFromQty: false, mismatches: [] };
  }
  let partialFromQty = false;
  // Lines where the dispensed quantity diverges from the prescribed/ordered
  // quantity, or where the order itself never carried a confirmed quantity
  // (quantity_needs_confirmation). The dispense flow must surface these and
  // require acknowledgement rather than silently billing/fulfilling whatever
  // the pharmacist typed. Finding: 2026-05-21-walk-in-opd-pharmacy-1646bc24.
  const mismatches = [];
  for (const d of dispensed) {
    if (!d || typeof d !== 'object') continue;
    const dCatalogId = d.catalog_id ? Number(d.catalog_id) : null;
    const dName = d.name || d.medication_name || d.drug_name || null;
    const idx = existing.findIndex((e) => {
      if (dCatalogId && e.catalog_id && Number(e.catalog_id) === dCatalogId) return true;
      if (!dCatalogId && dName) {
        const eName = e.name || e.medication_name || e.drug_name;
        return eName && String(eName).toLowerCase() === String(dName).toLowerCase();
      }
      return false;
    });
    const orderedQty = idx >= 0 ? Number(existing[idx].qty ?? existing[idx].quantity ?? 0) : 0;
    const dispensedQty = Number(d.dispensed_quantity ?? d.dispensed_qty ?? d.qty ?? d.quantity ?? orderedQty);
    const effectiveQty = Number.isFinite(dispensedQty) && dispensedQty >= 0 ? dispensedQty : orderedQty;
    if (orderedQty > 0 && effectiveQty < orderedQty) partialFromQty = true;
    // Mismatch: dispensed differs from a positive ordered quantity, OR the
    // order line never had a confirmed quantity but a quantity is being
    // dispensed. Under-dispense alone (partial) is allowed once acknowledged.
    const lineNeedsConfirmation = idx >= 0
      && Boolean(existing[idx].quantity_needs_confirmation);
    if (orderedQty > 0 && effectiveQty !== orderedQty) {
      mismatches.push({
        catalog_id: dCatalogId ?? (idx >= 0 ? existing[idx].catalog_id ?? null : null),
        name: dName ?? (idx >= 0 ? existing[idx].name ?? existing[idx].medication_name ?? null : null),
        ordered_qty: orderedQty,
        dispensed_qty: effectiveQty,
        kind: effectiveQty > orderedQty ? 'over_dispense' : 'under_dispense',
      });
    } else if (lineNeedsConfirmation && effectiveQty > 0) {
      mismatches.push({
        catalog_id: dCatalogId ?? existing[idx].catalog_id ?? null,
        name: dName ?? existing[idx].name ?? existing[idx].medication_name ?? null,
        ordered_qty: orderedQty,
        dispensed_qty: effectiveQty,
        kind: 'unconfirmed_order_qty',
      });
    }
    const merged = idx >= 0 ? { ...existing[idx] } : {};
    if (dCatalogId) merged.catalog_id = dCatalogId;
    if (dName) {
      merged.name = dName;
      merged.medication_name = dName;
    }
    merged.qty = effectiveQty;
    if (orderedQty > 0) merged.ordered_qty = orderedQty;
    merged.dispensed_qty = effectiveQty;
    // The pharmacist has now acted on this line, so the "quantity unconfirmed"
    // flag from order creation is resolved — drop it so the dispensed record
    // doesn't carry a stale needs-confirmation marker.
    if ('quantity_needs_confirmation' in merged) delete merged.quantity_needs_confirmation;
    if (d.dispensed_quantity_ml != null) merged.dispensed_quantity_ml = Number(d.dispensed_quantity_ml);
    if (d.prescribed_dose) merged.prescribed_dose = d.prescribed_dose;
    if (d.child_weight_kg != null) merged.child_weight_kg = Number(d.child_weight_kg);
    if (d.measuring_instruction) merged.measuring_instruction = d.measuring_instruction;
    if (d.label_instruction) merged.label_instruction = d.label_instruction;
    if (d.instructions) merged.instructions = d.instructions;
    if (d.batch_no) merged.batch_no = d.batch_no;
    if (d.expiry_date) merged.expiry_date = d.expiry_date;
    if (typeof d.price === 'number' && Number.isFinite(d.price)) {
      merged.price = d.price;
    }
    if (typeof merged.price === 'number' && Number.isFinite(merged.price)) {
      merged.line_total = Number((merged.price * effectiveQty).toFixed(2));
    }
    if (idx >= 0) existing[idx] = merged;
    else existing.push(merged);
  }
  return { items: existing, partialFromQty, mismatches };
}

/**
 * Estimate the rupee amount about to be dispensed, BEFORE the
 * transaction runs. Mirrors the totalAmount recomputation inside
 * markCounterDispensed: prefer summed line_total across the merged
 * items_list, fall back to the existing total_amount on the order for
 * free-text/legacy orders with no priced lines.
 */
function computeDispenseProbeAmount({ existingItems, dispensedItems, fallbackTotal }) {
  const { items: merged } = mergeDispensedItems(
    Array.isArray(existingItems) ? existingItems : [],
    Array.isArray(dispensedItems) ? dispensedItems : [],
  );
  const priced = merged.filter(
    (i) => typeof i.line_total === 'number' && Number.isFinite(i.line_total),
  );
  if (priced.length) {
    return Number(priced.reduce((s, i) => s + i.line_total, 0).toFixed(2));
  }
  const n = Number(fallbackTotal);
  return Number.isFinite(n) ? n : 0;
}

/**
 * B-2 — counter-dispense flow. The patient walks up to the pharmacy
 * with their Rx, the pharmacist confirms + hands it over on the spot.
 * No CONFIRMED -> PREPARING -> DISPATCHED -> DELIVERED chain — that's
 * for delivery orders. From PENDING (or CONFIRMED) directly to
 * DISPENSED, with the same stock-decrement + Rx-fulfilment hooks
 * markDelivered runs. Required: delivery_type='counter' on the order
 * (else use the delivery flow).
 *
 * The pharmacist may supply a rich dispense payload — partial quantity,
 * paediatric label, cash/TPA payment, guardian acknowledgement, receipt
 * delivery preference. All of it is persisted on the order so the label
 * endpoint + billing can reach it. See findings
 *   2026-05-09-pediatric-opd-pharmacy-zero-bill-no-items
 *   2026-05-10-pediatric-opd-pharmacy-dispense-payload-label-payment-dropped
 *   2026-05-10-walk-in-opd-pharmacy-partial-dispense-payment-ignored
 */
export const markCounterDispensed = async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId)) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }

    const {
      dispensed_items,
      payment_mode: rawPaymentMode,
      payment_method,
      amount_collected,
      partial_dispense: rawPartialDispense,
      partial_reason,
      confirmation_notes,
      receipt_delivery,
      guardian_acknowledged,
      quantity_mismatch_acknowledged,
      mismatch_reason,
      insurer,
      policy_number,
      package_deduction,
      tpa_reference,
      cap_override,
    } = req.body ?? {};

    // Phase 0 — TPA pharmacy-cap pre-flight (outside the transaction
    // per the Phase 0/1/1.5 boundary rule in apps/backend/CLAUDE.md).
    // For an admitted patient on a TPA preauth with a pharmacy cap,
    // block dispensing that would push cumulative pharmacy spend over
    // the cap unless the caller passed cap_override=true (gated by
    // billing-supervisor RBAC in higher layers).
    // See finding 2026-05-09-tpa-insurance-claim-billing-pharmacy-cap-not-enforced.
    try {
      const preRows = await prisma.$queryRawUnsafe(
        `SELECT patient_id, items_list, total_amount
           FROM pharmacy_orders WHERE id=$1`,
        orderId,
      );
      if (preRows.length) {
        const probeAmount = computeDispenseProbeAmount({
          existingItems: preRows[0].items_list,
          dispensedItems: dispensed_items,
          fallbackTotal: preRows[0].total_amount,
        });
        const probe = await probePharmacyCap({
          patientId: preRows[0].patient_id,
          additionalAmount: probeAmount,
        });
        if (probe.message) {
          logger.warn('Pharmacy cap probe', {
            order_id: orderId, ...probe,
          });
        }
        if (shouldBlockDispense(probe, { allowOverride: Boolean(cap_override) })) {
          return error(res, probe.message, HTTP_STATUS.BAD_REQUEST, {
            code: 'TPA_PHARMACY_CAP_EXCEEDED',
            cap_amount: probe.pharmacyCap,
            current_spend: probe.currentSpend,
            projected_total: probe.projectedTotal,
            utilisation_pct: probe.utilisationPct,
          });
        }
      }
    } catch (capErr) {
      // Probe failure is non-fatal — log and continue. The cap check
      // is opt-in until every admission has structured caps.
      logger.warn('Pharmacy cap probe failed', {
        order_id: orderId, error: capErr.message,
      });
    }

    const paymentModeInput = String(rawPaymentMode ?? payment_method ?? '').toLowerCase();
    const paymentMode = COUNTER_PAYMENT_MODES.has(paymentModeInput) ? paymentModeInput : null;
    const amountCollected = (() => {
      const n = Number(amount_collected);
      return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : null;
    })();
    const receiptDelivery = RECEIPT_DELIVERY_MODES.has(String(receipt_delivery ?? '').toLowerCase())
      ? String(receipt_delivery).toLowerCase()
      : null;

    const result = await prisma.$transaction(async (tx) => {
      // Pull state + delivery_type up-front so the wrong-flow guard
      // returns a clean 400 instead of an empty UPDATE result.
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, status, delivery_type, items_list, patient_id,
                patient_name, order_number, total_amount
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

      // Merge pharmacist-supplied dispensed_items into the items_list
      // already on the order (typically populated by orderPharmacyFromPrescription
      // or the confirm step). When the pharmacist passes a partial qty
      // the merged line carries dispensed_qty AND ordered_qty so the
      // remaining-balance is reachable from the order detail.
      const { items: mergedItems, partialFromQty, mismatches } = mergeDispensedItems(
        Array.isArray(order.items_list) ? order.items_list : [],
        Array.isArray(dispensed_items) ? dispensed_items : [],
      );

      // Quantity-safety gate. A dispensed quantity that differs from the
      // prescribed/ordered quantity — or any line whose order quantity was
      // never confirmed (defaulted to 1 at order creation) — must NOT be
      // billed and fulfilled silently. Require an explicit acknowledgement:
      //   - quantity_mismatch_acknowledged=true (any mismatch), or
      //   - partial_dispense / partial_reason (under-dispense only — the
      //     existing partial-dispense intent already covers giving less).
      // Otherwise block with a clear 400 so the counter UI prompts the
      // pharmacist to confirm the true count.
      // Finding: 2026-05-21-walk-in-opd-pharmacy-1646bc24 (+ 938226ba).
      if (mismatches.length) {
        const acknowledged = quantity_mismatch_acknowledged === true;
        const partialIntent = Boolean(rawPartialDispense) || Boolean(partial_reason);
        const allUnderDispense = mismatches.every((m) => m.kind === 'under_dispense');
        if (!acknowledged && !(partialIntent && allUnderDispense)) {
          return { error: 'QUANTITY_MISMATCH', mismatches };
        }
      }

      // Recompute total_amount from the merged item lines whenever any
      // line carries a numeric price. Falls back to the existing total
      // for free-text orders where prices were never resolved.
      let totalAmount = Number(order.total_amount ?? 0);
      const priced = mergedItems.filter(
        (i) => typeof i.line_total === 'number' && Number.isFinite(i.line_total),
      );
      if (priced.length) {
        totalAmount = Number(priced.reduce((sum, i) => sum + i.line_total, 0).toFixed(2));
      }

      const partialDispense = Boolean(rawPartialDispense) || partialFromQty;

      const packageDeduction = Number(package_deduction);
      const paymentMetadata = {};
      if (insurer) paymentMetadata.insurer = String(insurer);
      if (policy_number) paymentMetadata.policy_number = String(policy_number);
      if (Number.isFinite(packageDeduction)) paymentMetadata.package_deduction = packageDeduction;
      if (tpa_reference) paymentMetadata.tpa_reference = String(tpa_reference);
      if (typeof guardian_acknowledged === 'boolean') {
        paymentMetadata.guardian_acknowledged = guardian_acknowledged;
      }
      const hasPaymentMetadata = Object.keys(paymentMetadata).length > 0;

      const nonCashCoverage = paymentMode && NON_CASH_PAYMENT_MODES.has(paymentMode);
      const cashCapture = paymentMode && paymentMode !== 'none' && !nonCashCoverage && amountCollected != null;
      if (totalAmount > 0 && !nonCashCoverage && !cashCapture) {
        return { error: 'PAYMENT_REQUIRED', totalAmount };
      }

      // Decide payment_status:
      //   - amount_collected >= total_amount → paid
      //   - non-cash mode (TPA/insurance/package/credit) → paid when the
      //     package_deduction (or any non-zero deduction) at least matches
      //     total, else partial
      //   - none of the above → pending
      let paymentStatus = 'pending';
      if (totalAmount <= 0) {
        paymentStatus = 'paid';
      } else if (amountCollected != null && amountCollected >= totalAmount) {
        paymentStatus = 'paid';
      } else if (paymentMode && NON_CASH_PAYMENT_MODES.has(paymentMode)) {
        if (Number.isFinite(packageDeduction) && packageDeduction >= totalAmount) {
          paymentStatus = 'paid';
        } else if (amountCollected != null && amountCollected > 0) {
          paymentStatus = 'partial';
        } else {
          paymentStatus = 'paid';
        }
      } else if (amountCollected != null && amountCollected > 0) {
        paymentStatus = 'partial';
      }

      // Build the dispense_label snapshot. Pharmacy app / staff app can
      // re-render this without re-reading the prescription. Keep the
      // shape tight — patient name, items with labels, dispensed_at.
      const dispenseLabel = {
        order_number: order.order_number,
        patient_name: order.patient_name,
        dispensed_at: new Date().toISOString(),
        partial_dispense: partialDispense,
        partial_reason: partial_reason ?? null,
        items: mergedItems.map((i) => ({
          name: i.name || i.medication_name || null,
          strength: i.strength ?? null,
          dose: i.dose ?? i.prescribed_dose ?? null,
          frequency: i.frequency ?? null,
          duration: i.duration ?? null,
          route: i.route ?? null,
          dispensed_qty: i.dispensed_qty ?? i.qty,
          dispensed_quantity_ml: i.dispensed_quantity_ml ?? null,
          child_weight_kg: i.child_weight_kg ?? null,
          measuring_instruction: i.measuring_instruction ?? null,
          label_instruction: i.label_instruction ?? i.instructions ?? null,
        })),
      };

      // dispensed_by is UUID FK → users.uid (not the int id). Use the
      // JWT's uid claim, not the integer id used elsewhere in this
      // controller for confirmed_by/changed_by (those are int FKs).
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_orders
            SET status='DISPENSED',
                dispensed_by=$2::uuid,
                dispensed_at=NOW(),
                delivery_tracking_active=FALSE,
                items_list=$3::jsonb,
                dispensed_medications=$3::jsonb,
                total_amount=$4,
                payment_status=$5,
                payment_mode=$6,
                amount_collected=$7,
                partial_dispense=$8,
                partial_reason=$9,
                receipt_delivery=$10,
                payment_metadata=$11::jsonb,
                dispense_label=$12::jsonb,
                confirmation_notes=COALESCE($13, confirmation_notes),
                updated_at=NOW()
          WHERE id=$1
          RETURNING id, uid, patient_id, patient_name, status, order_note,
                    total_amount, items_list, dispensed_medications,
                    payment_status, payment_mode, amount_collected,
                    partial_dispense, partial_reason, receipt_delivery,
                    payment_metadata, dispense_label, confirmation_notes,
                    dispensed_at, created_at, updated_at, order_number, delivery_type`,
        orderId,
        req.user?.uid ?? null,
        JSON.stringify(mergedItems),
        totalAmount,
        paymentStatus,
        paymentMode,
        amountCollected,
        partialDispense,
        partial_reason ?? null,
        receiptDelivery,
        hasPaymentMetadata ? JSON.stringify(paymentMetadata) : null,
        JSON.stringify(dispenseLabel),
        confirmation_notes ?? null,
      );
      const out = updated[0];

      // Stock decrement: aggregate per catalog_id from the MERGED items
      // so a partial dispense only pulls dispensed_qty out of stock.
      const decByCatalog = new Map();
      for (const item of mergedItems) {
        const qty = Number(item?.dispensed_qty ?? item?.qty ?? item?.quantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        let catalogId = item?.catalog_id ? parseInt(item.catalog_id, 10) : null;
        const itemName = item?.name || item?.medication_name || item?.drug_name || null;
        if (!catalogId && itemName) {
          const match = await tx.$queryRawUnsafe(
            'SELECT id FROM pharmacy_catalog WHERE name ILIKE $1 LIMIT 1',
            itemName,
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

      // Full counter dispenses close the prescription. Short supplies stay
      // linked to pharmacy so the remaining quantity is not hidden as fulfilled.
      const prescriptionStatus = partialDispense ? 'pharmacy_linked' : 'fulfilled';
      await tx.$executeRawUnsafe(
        `UPDATE e_prescriptions
            SET status = $3,
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
        orderId, out.patient_id ?? null, prescriptionStatus,
      );

      await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_order_history (order_id, from_status, to_status, changed_by, changed_by_role, notes)
         VALUES ($1, $2, 'DISPENSED', $3, 'pharmacist', $4)`,
        orderId,
        order.status,
        req.user?.id ?? null,
        (() => {
          let note = partialDispense
            ? `Counter dispense (partial${partial_reason ? `: ${partial_reason}` : ''})`
            : 'Counter dispense';
          if (mismatches.length && quantity_mismatch_acknowledged === true) {
            note += ` — quantity mismatch acknowledged${mismatch_reason ? `: ${String(mismatch_reason)}` : ''}`;
          }
          return note;
        })(),
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
    if (result.error === 'PAYMENT_REQUIRED') {
      return error(
        res,
        'Payment mode and amount_collected are required before dispensing a positive-value counter order, unless the order is covered by insurance/package/credit.',
        HTTP_STATUS.BAD_REQUEST,
        { code: 'COUNTER_PAYMENT_REQUIRED', total_amount: result.totalAmount },
      );
    }
    if (result.error === 'QUANTITY_MISMATCH') {
      return error(
        res,
        'Dispensed quantity does not match the prescribed/ordered quantity. Confirm the correct count and resubmit with quantity_mismatch_acknowledged=true (and an optional mismatch_reason), or mark a partial dispense for an under-supply.',
        HTTP_STATUS.BAD_REQUEST,
        { code: 'DISPENSE_QUANTITY_MISMATCH', mismatches: result.mismatches },
      );
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
        total_amount, payment_status, payment_mode, amount_collected,
        partial_dispense, partial_reason, receipt_delivery, payment_metadata,
        dispense_label, dispensed_medications, dispensed_at,
        assigned_pharmacist, token_number, order_number,
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

/**
 * GET /pharmacy/orders/:id/label
 *
 * Returns the dispense label as JSON so the staff/patient app can render
 * it (with paediatric weight, measuring-cup instructions, and dosing
 * schedule) or hand off to the receipt printer. Available once the order
 * has been DISPENSED or DELIVERED; the stored `dispense_label` snapshot
 * is the source of truth, with a freshly-computed fallback so legacy
 * orders that pre-date column 201 still produce a label.
 *
 * Closes:
 *   2026-05-09-pediatric-opd-pharmacy-no-label-endpoint
 *   2026-05-09-walk-in-opd-pharmacy-no-label-endpoint (delivery flow shares the endpoint)
 */
export const getDispenseLabel = async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId)) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT po.id, po.uid, po.patient_id, po.patient_name, po.patient_phone, po.phone,
              po.order_number, po.status, po.delivery_type, po.total_amount,
              po.payment_status, po.payment_mode, po.amount_collected,
              po.partial_dispense, po.partial_reason, po.receipt_delivery,
              po.payment_metadata, po.dispense_label, po.items_list,
              po.confirmation_notes, po.dispensed_at, po.delivered_at,
              po.created_at,
              u.birthday AS patient_birthday,
              (SELECT vc.weight_kg FROM vitals_chart vc
                 JOIN users vu ON vu.uid = vc.patient_uid
                WHERE vu.id = po.patient_id AND vc.weight_kg IS NOT NULL
                ORDER BY vc.recorded_at DESC NULLS LAST LIMIT 1) AS latest_weight_kg,
              (SELECT array_agg(DISTINCT pa.allergy_name)
                 FROM patient_allergies pa
                WHERE pa.patient_id = po.patient_id AND pa.is_active = TRUE) AS allergies
         FROM pharmacy_orders po
         LEFT JOIN users u ON u.id = po.patient_id
        WHERE po.id = $1`,
      orderId,
    );
    if (!rows.length) return error(res, 'Order not found', HTTP_STATUS.NOT_FOUND);
    const o = rows[0];

    if (!['DISPENSED', 'DELIVERED'].includes(o.status)) {
      return error(
        res,
        `Label not available until order is dispensed (current status: ${o.status})`,
        HTTP_STATUS.BAD_REQUEST,
      );
    }

    // Prefer the stored snapshot — that's what the pharmacist actually
    // saw at dispense time. Fall back to a derived label from items_list
    // for legacy orders that pre-date column 201.
    const storedLabel = o.dispense_label && typeof o.dispense_label === 'object'
      ? o.dispense_label
      : null;
    const items = Array.isArray(o.items_list) ? o.items_list : [];

    const ageYears = (() => {
      if (!o.patient_birthday) return null;
      const dob = new Date(o.patient_birthday);
      if (Number.isNaN(dob.getTime())) return null;
      const diffMs = Date.now() - dob.getTime();
      return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365.25));
    })();
    const weightKg = o.latest_weight_kg != null ? Number(o.latest_weight_kg) : null;

    const labelItems = (storedLabel?.items ?? items).map((i) => ({
      name: i.name || i.medication_name || null,
      strength: i.strength ?? null,
      dose: i.dose ?? i.prescribed_dose ?? null,
      frequency: i.frequency ?? null,
      duration: i.duration ?? null,
      route: i.route ?? null,
      dispensed_qty: i.dispensed_qty ?? i.qty ?? null,
      dispensed_quantity_ml: i.dispensed_quantity_ml ?? null,
      child_weight_kg: i.child_weight_kg ?? null,
      measuring_instruction: i.measuring_instruction ?? null,
      label_instruction: i.label_instruction ?? i.instructions ?? null,
    }));

    const label = {
      order_number: o.order_number,
      order_id: o.id,
      patient: {
        name: o.patient_name,
        phone: o.patient_phone || o.phone,
        age_years: ageYears,
        weight_kg: weightKg,
        allergies: Array.isArray(o.allergies) ? o.allergies : [],
      },
      items: labelItems,
      partial_dispense: o.partial_dispense ?? false,
      partial_reason: o.partial_reason ?? null,
      payment: {
        status: o.payment_status,
        mode: o.payment_mode,
        amount_collected: o.amount_collected != null ? Number(o.amount_collected) : null,
        total_amount: o.total_amount != null ? Number(o.total_amount) : null,
        metadata: o.payment_metadata ?? null,
      },
      receipt_delivery: o.receipt_delivery,
      confirmation_notes: o.confirmation_notes,
      dispensed_at: o.dispensed_at ?? o.delivered_at ?? null,
      // Paediatric measuring-cup helper. The dispensing pharmacist usually
      // writes "2.5 ml = ½ tsp" by hand; surface a stock conversion when
      // the label has any ml-based instruction so the patient/staff app
      // can render the same hint in print.
      measuring_guide: labelItems.some((i) =>
        (i.dispensed_quantity_ml ?? null) != null ||
        /\d+\s*ml\b/i.test(String(i.dose ?? '')) ||
        /\d+\s*ml\b/i.test(String(i.label_instruction ?? '')),
      )
        ? { '5_ml': '1 teaspoon', '2_5_ml': '½ teaspoon', '15_ml': '1 tablespoon' }
        : null,
    };

    success(res, label, 'Dispense label');
  } catch (err) {
    logger.error('Get dispense label error:', err);
    error(res, 'Failed to fetch label', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
      `SELECT id, name, generic_name, category, manufacturer, price, unit_price, pack_size,
              COALESCE(stock_quantity, stock) AS stock,
              in_stock, is_available, requires_prescription, reorder_level, description, created_at
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
          in_stock=$8, is_available=$8, stock_quantity=$9, reorder_level=$10, updated_at=NOW()
        WHERE id=$11 RETURNING id, name, generic_name, category, manufacturer,
          unit_price, pack_size, requires_prescription, in_stock, is_available, stock_quantity,
          reorder_level, updated_at`,
        name, generic_name, category, manufacturer, unit_price, pack_size,
        requires_prescription ?? true, in_stock ?? true,
        stock_quantity || 0, reorder_level || 10, id
      );
    } else {
      result = await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_catalog
          (name, generic_name, category, manufacturer, unit_price, pack_size,
           requires_prescription, in_stock, is_available, stock_quantity, reorder_level)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)
        RETURNING id, name, generic_name, category, manufacturer, unit_price,
          pack_size, requires_prescription, in_stock, is_available, stock_quantity, reorder_level, created_at`,
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

export const removeCatalog = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return error(res, 'Valid medicine id is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE pharmacy_catalog
       SET is_active=FALSE, is_available=FALSE, in_stock=FALSE, updated_at=NOW()
       WHERE id=$1 AND is_active=TRUE
       RETURNING id, name, generic_name, category, updated_at`,
      id
    );

    if (!result?.length) {
      return error(res, 'Medicine not found in active formulary', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result[0], 'Medicine removed from formulary');
  } catch (err) {
    logger.error('Remove pharmacy catalog error:', err);
    error(res, 'Failed to remove medicine', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
