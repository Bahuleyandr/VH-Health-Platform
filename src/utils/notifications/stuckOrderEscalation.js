// src/utils/notifications/stuckOrderEscalation.js
// Escalation cron — detects stuck orders and alerts admins

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

/**
 * Check for stuck orders across appointments, pharmacy, and investigations.
 * Marks stuck appointments with escalation note.
 * Sends push notifications to admin users.
 *
 * Called by scheduler every 30 minutes.
 */
export async function escalateStuckOrders() {
  logger.info('[Escalation] Checking for stuck orders...');

  // 1. Appointments stuck in SCHEDULED >48h with no staff confirmation
  const stuckAppointments = await prisma.$queryRawUnsafe(`
    UPDATE appointments
    SET notes = COALESCE(notes, '') || ' [AUTO-ESCALATED: No confirmation after 48h]'
    WHERE status = 'SCHEDULED' AND confirmed_at IS NULL
      AND created_at < NOW() - INTERVAL '48 hours'
      AND (notes IS NULL OR notes NOT LIKE '%AUTO-ESCALATED%')
    RETURNING id, patient_id
  `);

  // 2. Pharmacy orders stuck past SLA confirm target
  const stuckPharmacy = await prisma.$queryRawUnsafe(`
    SELECT po.id, po.order_number, po.patient_name, po.phone AS patient_phone,
      ROUND(EXTRACT(EPOCH FROM (NOW() - po.created_at)) / 60) as mins_waiting
    FROM pharmacy_orders po
    WHERE po.status = 'PLACED' AND NOW() > po.sla_confirm_target
      AND po.created_at > NOW() - INTERVAL '7 days'
  `);

  // 3. Investigation bookings stuck in DISPATCHED >4h
  const stuckInvestigations = await prisma.$queryRawUnsafe(`
    SELECT ib.id, ib.booking_number, ib.patient_name,
      ROUND(EXTRACT(EPOCH FROM (NOW() - ib.dispatched_at)) / 60) as mins_since_dispatch
    FROM investigation_bookings ib
    WHERE ib.status = 'DISPATCHED' AND ib.dispatched_at < NOW() - INTERVAL '4 hours'
      AND ib.created_at > NOW() - INTERVAL '7 days'
  `);

  const totalStuck =
    stuckAppointments.length +
    stuckPharmacy.length +
    stuckInvestigations.length;

  if (totalStuck > 0) {
    // Find admin users with device tokens
    const admins = await prisma.$queryRawUnsafe(`
      SELECT id, device_token FROM users
      WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND device_token IS NOT NULL AND is_active = TRUE
      LIMIT 10
    `);

    let sendPushNotification;
    try {
      const mod = await import('../../utils/notifications/sendPushNotification.js');
      sendPushNotification = mod.sendPushNotification;
    } catch {
      // Push not available — just log
    }

    for (const admin of admins) {
      if (sendPushNotification && admin.device_token) {
        try {
          await sendPushNotification({
            tokens: admin.device_token,
            title: '⚠️ Stuck Orders Alert',
            body: `${stuckAppointments.length} appointments, ${stuckPharmacy.length} pharmacy orders, ${stuckInvestigations.length} lab bookings need attention.`,
            data: { type: 'stuck_orders_alert' },
            userId: admin.uid,
          });
        } catch {
          // Best-effort — don't crash escalation for push failures
        }
      }
    }

    logger.warn(`[Escalation] Found ${totalStuck} stuck orders — admins alerted (${stuckAppointments.length} appt, ${stuckPharmacy.length} pharm, ${stuckInvestigations.length} inv)`);
  } else {
    logger.info('[Escalation] No stuck orders found');
  }

  return {
    stuckAppointments: stuckAppointments.length,
    stuckPharmacy: stuckPharmacy.length,
    stuckInvestigations: stuckInvestigations.length,
  };
}
