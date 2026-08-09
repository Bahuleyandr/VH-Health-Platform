import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
import { emitPharmacyOrderEvent } from '../clinical/canonicalOperationalBridgeService.js';

export const updatePharmacyOrderStatus = async (data) => {
  const {
    phone, order_id, status, notes,
    dispensed_medications, pharmacist_notes,
    dispensed_at, tenantId, updatedBy, updatedByName
  } = data;

  if (!tenantId) throw new Error('TENANT_REQUIRED');

  // Phase 1 — the dispense bookkeeping UPDATE and the canonical
  // timeline/audit emit commit or roll back together (canonical clinical
  // timeline invariant). Previously the UPDATE autocommitted and the emit ran
  // post-commit best-effort, so a later failure 500'd after commit and a
  // client retry re-ran dispense bookkeeping (audit BE-M6).
  //
  // Schema columns are `dispensed_by` (no leading underscore) and `ordered_at`
  // (there is no `placed_at` column). See prisma/schema.prisma#pharmacy_orders.
  const result = await setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(`
      UPDATE pharmacy_orders SET
        status = $1,
        order_note = COALESCE($2, order_note),
        dispensed_medications = $3,
        pharmacist_notes = $4,
        dispensed_by = $5,
        dispensed_at = CASE WHEN $1 = 'dispensed' THEN COALESCE($6, NOW()) ELSE dispensed_at END,
        updated_by = $7,
        updated_at = NOW()
      WHERE id = $8 AND phone = $9 AND tenant_id = $10::uuid
      RETURNING id, uid, tenant_id, phone, status, order_note, dispensed_medications, pharmacist_notes, dispensed_by, dispensed_at, updated_by, updated_at, ordered_at
    `,
      status, notes,
      dispensed_medications ? JSON.stringify(dispensed_medications) : null,
      pharmacist_notes,
      status === 'dispensed' ? updatedBy : null,
      dispensed_at,
      updatedBy, order_id, phone, tenantId
    );

    if (rows.length === 0) {
      throw new Error('ORDER_NOT_FOUND');
    }

    await emitPharmacyOrderEvent({
      db: tx,
      order: rows[0],
      actorUid: updatedBy,
      eventType: 'pharmacy.order_status_changed',
      eventStatus: status,
      payload: {
        source: 'staff_pharmacy_service',
        notes: notes || null,
        pharmacist_notes: pharmacist_notes || null,
        updated_by_name: updatedByName || null,
      },
    });

    return rows;
  });

  // Phase 1.5 — post-commit best-effort writes. Each failure is logged, never
  // thrown: the dispense already committed, so a 500 here would only trigger
  // a client retry that re-runs the dispense bookkeeping.
  const statusMessages = {
    preparing: 'Your pharmacy order is being prepared.',
    ready: 'Your pharmacy order is ready for pickup.',
    dispensed: 'Your medications have been dispensed successfully.',
    cancelled: 'Your pharmacy order has been cancelled.'
  };

  let patientNotified = true;
  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO notifications (
        phone, title, body, type, related_id, tenant_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::uuid, NOW())`,

        phone,
        `Pharmacy Order ${status.charAt(0).toUpperCase() + status.slice(1)}`,
        statusMessages[status] || `Your pharmacy order status has been updated to ${status}.`,
        'pharmacy_update',
        order_id,
        tenantId

    );
  } catch (notifyErr) {
    patientNotified = false;
    logger.warn(`Pharmacy order ${order_id} status notification insert failed (order update already committed):`, notifyErr.message);
  }

  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_activity_logs (
        staff_uid, action, patient_phone, order_id,
        old_status, new_status, notes, tenant_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, NOW())`,

        updatedBy,
        'ORDER_STATUS_UPDATED',
        phone,
        order_id,
        'previous_status',
        status,
        notes,
        tenantId

    );
  } catch (activityErr) {
    logger.warn(`Pharmacy order ${order_id} activity log insert failed (order update already committed):`, activityErr.message);
  }

  logger.info(`💊 Pharmacy order ${order_id} updated to ${status} by ${updatedByName} for patient ${maskPhoneForLog(phone)}`);

  return {
    order: {
      ...result[0],
      ordered_at: result[0].ordered_at ? result[0].ordered_at.toLocaleString('en-IN') : null,
      dispensed_at: result[0].dispensed_at ? result[0].dispensed_at.toLocaleString('en-IN') : null,
      updated_at: result[0].updated_at.toLocaleString('en-IN')
    },
    updatedBy: updatedByName,
    patientNotified
  };
};
