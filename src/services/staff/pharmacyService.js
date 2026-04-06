import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export const updatePharmacyOrderStatus = async (data) => {
  const { 
    phone, order_id, status, notes, 
    dispensed_medications, pharmacist_notes,
    _dispensed_by, dispensed_at, updatedBy, updatedByName
  } = data;

  // Update pharmacy order
  const result = await prisma.$queryRawUnsafe(`
    UPDATE pharmacy_orders SET 
      status = $1, 
      order_note = COALESCE($2, order_note),
      dispensed_medications = $3,
      pharmacist_notes = $4,
      dispensed_by = $5,
      dispensed_at = CASE WHEN $1 = 'dispensed' THEN COALESCE($6, NOW()) ELSE dispensed_at END,
      updated_by = $7,
      updated_at = NOW()
    WHERE id = $8 AND phone = $9
    RETURNING id, phone, status, order_note, dispensed_medications, pharmacist_notes, _dispensed_by, dispensed_at, updated_by, updated_at, placed_at
  `, [
    status, notes, 
    dispensed_medications ? JSON.stringify(dispensed_medications) : null,
    pharmacist_notes, 
    status === 'dispensed' ? updatedBy : null,
    dispensed_at,
    updatedBy, order_id, phone
  ]);

  if (result.length === 0) {
    throw new Error('ORDER_NOT_FOUND');
  }

  // Create notification
  const statusMessages = {
    preparing: 'Your pharmacy order is being prepared.',
    ready: 'Your pharmacy order is ready for pickup.',
    dispensed: 'Your medications have been dispensed successfully.',
    cancelled: 'Your pharmacy order has been cancelled.'
  };

  await prisma.$queryRawUnsafe(
    `INSERT INTO notifications (
      phone, title, body, type, related_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      phone,
      `Pharmacy Order ${status.charAt(0).toUpperCase() + status.slice(1)}`,
      statusMessages[status] || `Your pharmacy order status has been updated to ${status}.`,
      'pharmacy_update',
      order_id
    ]
  );

  // Log activity
  await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_activity_logs (
      staff_uid, action, patient_phone, order_id,
      old_status, new_status, notes, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      updatedBy,
      'ORDER_STATUS_UPDATED',
      phone,
      order_id,
      'previous_status',
      status,
      notes
    ]
  );

  logger.info(`💊 Pharmacy order ${order_id} updated to ${status} by ${updatedByName} for patient ${phone}`);

  return {
    order: {
      ...result[0],
      placed_at: result[0].placed_at ? result[0].placed_at.toLocaleString('en-IN') : null,
      dispensed_at: result[0].dispensed_at ? result[0].dispensed_at.toLocaleString('en-IN') : null,
      updated_at: result[0].updated_at.toLocaleString('en-IN')
    },
    updatedBy: updatedByName,
    patientNotified: true
  };
};