// src/utils/notifications/stuckOrderEscalation.js
// Escalation cron — detects stuck orders and alerts admins

import prisma from '../../lib/prisma.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';

// Cap on admins alerted per tenant per sweep. Runaway guard only — a tenant with
// more than this many active admins holding device tokens is already anomalous.
const STUCK_ORDER_ADMIN_CAP = 50;

/**
 * Check for stuck orders across appointments, pharmacy, and investigations.
 * Marks stuck appointments with escalation note.
 * Sends push notifications to admin users.
 *
 * Called by scheduler every 30 minutes.
 *
 * Runs for ONE tenant: the scheduler fans it out with runForEachTenant, which
 * establishes that tenant's context. See src/lib/tenantContext.js.
 */
export async function escalateStuckOrders(tenantId = getCurrentTenantId()) {
  // The scheduler fans this job out with runForEachTenant, which runs each
  // tenant inside runInTenantContext. Use that context rather than replacing it
  // with a cross-tenant one and re-walking the fleet. Re-walking repeated every
  // tenant's work once per tenant, and a cross-tenant context is fail-closed on
  // pharmacy_orders and users, so those reads would return no rows silently
  // instead of erroring.
  if (!tenantId) {
    throw new Error('escalateStuckOrders requires a tenant context');
  }
  logger.info('[Escalation] Checking for stuck orders...');

  let sendPushNotification;
  try {
    const mod = await import('../../utils/notifications/sendPushNotification.js');
    sendPushNotification = mod.sendPushNotification;
  } catch {
    // Push not available — just log
  }

  const totals = await escalateStuckOrdersForTenant(tenantId, sendPushNotification);

  if (totals.stuckAppointments + totals.stuckPharmacy + totals.stuckInvestigations === 0) {
    logger.info('[Escalation] No stuck orders found');
  }
  return totals;
}

async function escalateStuckOrdersForTenant(tenantId, sendPushNotification) {
  // 1. Appointments stuck in SCHEDULED >48h with no staff confirmation
  const stuckAppointments = await prisma.$queryRawUnsafe(`
    UPDATE appointments
    SET notes = COALESCE(notes, '') || ' [AUTO-ESCALATED: No confirmation after 48h]'
    WHERE status = 'SCHEDULED' AND confirmed_at IS NULL
      AND created_at < NOW() - INTERVAL '48 hours'
      AND (notes IS NULL OR notes NOT LIKE '%AUTO-ESCALATED%')
      AND tenant_id = $1::uuid
    RETURNING id, patient_id
  `, tenantId);

  // 2. Pharmacy orders stuck past SLA confirm target
  const stuckPharmacy = await prisma.$queryRawUnsafe(`
    SELECT po.id, po.order_number, po.patient_name, po.phone AS patient_phone,
      ROUND(EXTRACT(EPOCH FROM (NOW() - po.created_at)) / 60) as mins_waiting
    FROM pharmacy_orders po
    WHERE po.status = 'PLACED' AND NOW() > po.sla_confirm_target
      AND po.created_at > NOW() - INTERVAL '7 days'
      AND po.tenant_id = $1::uuid
  `, tenantId);

  // 3. Investigation bookings stuck in DISPATCHED >4h
  const stuckInvestigations = await prisma.$queryRawUnsafe(`
    SELECT ib.id, ib.booking_number, ib.patient_name,
      ROUND(EXTRACT(EPOCH FROM (NOW() - ib.dispatched_at)) / 60) as mins_since_dispatch
    FROM investigation_bookings ib
    WHERE ib.status = 'DISPATCHED' AND ib.dispatched_at < NOW() - INTERVAL '4 hours'
      AND ib.created_at > NOW() - INTERVAL '7 days'
      AND ib.tenant_id = $1::uuid
  `, tenantId);

  const totalStuck =
    stuckAppointments.length +
    stuckPharmacy.length +
    stuckInvestigations.length;

  if (totalStuck > 0) {
    // Admins of THIS tenant only
    const admins = await prisma.$queryRawUnsafe(`
      SELECT id, uid, device_token, COUNT(*) OVER () AS total_matched FROM users
      WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND device_token IS NOT NULL AND is_active = TRUE
        AND tenant_id = $1::uuid
      ORDER BY id
      LIMIT $2::int
    `, tenantId, STUCK_ORDER_ADMIN_CAP);

    // Without ORDER BY the cap evicted an arbitrary, planner-dependent subset of
    // admins; ordering makes it deterministic and the count makes any eviction
    // visible instead of silent.
    const totalAdmins = admins.length ? Number(admins[0].total_matched) : 0;
    if (totalAdmins > admins.length) {
      logger.warn('[Escalation] Stuck-order admin fan-out truncated by cap', {
        tenantId,
        cap: STUCK_ORDER_ADMIN_CAP,
        totalAdmins,
        notified: admins.length,
        dropped: totalAdmins - admins.length,
      });
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

    logger.warn(`[Escalation] Tenant ${tenantId}: ${totalStuck} stuck orders — admins alerted (${stuckAppointments.length} appt, ${stuckPharmacy.length} pharm, ${stuckInvestigations.length} inv)`);
  }

  return {
    stuckAppointments: stuckAppointments.length,
    stuckPharmacy: stuckPharmacy.length,
    stuckInvestigations: stuckInvestigations.length,
  };
}
