// src/utils/notifications/stuckOrderEscalation.js
// Escalation cron — detects stuck orders and alerts admins

import prisma from '../../lib/prisma.js';
import { runWithSuperAdmin } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';

/**
 * Check for stuck orders across appointments, pharmacy, and investigations.
 * Marks stuck appointments with escalation note.
 * Sends push notifications to admin users.
 *
 * Called by scheduler every 30 minutes.
 *
 * Phase-2 RLS: cross-tenant aggregator. See src/lib/tenantContext.js.
 */
export async function escalateStuckOrders() {
  return runWithSuperAdmin(async () => escalateStuckOrdersInner());
}

async function escalateStuckOrdersInner() {
  logger.info('[Escalation] Checking for stuck orders...');

  // Per-tenant aggregator (audit 2026-06-18 §3): previously this ran once across
  // ALL tenants under super-admin (RLS off) — admins of every tenant got one
  // alert mixing every tenant's counts, and a global LIMIT 10 could starve a
  // tenant's admins. Now each tenant's stuck orders + admin alerts are scoped to
  // that tenant via an explicit tenant_id filter (defense-in-depth on top of the
  // super-admin context the scheduler wraps this in).
  const tenants = await prisma.$queryRawUnsafe('SELECT id FROM tenants');

  let sendPushNotification;
  try {
    const mod = await import('../../utils/notifications/sendPushNotification.js');
    sendPushNotification = mod.sendPushNotification;
  } catch {
    // Push not available — just log
  }

  const totals = { stuckAppointments: 0, stuckPharmacy: 0, stuckInvestigations: 0 };
  for (const t of tenants) {
    const r = await escalateStuckOrdersForTenant(t.id, sendPushNotification);
    totals.stuckAppointments += r.stuckAppointments;
    totals.stuckPharmacy += r.stuckPharmacy;
    totals.stuckInvestigations += r.stuckInvestigations;
  }

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
      SELECT id, uid, device_token FROM users
      WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND device_token IS NOT NULL AND is_active = TRUE
        AND tenant_id = $1::uuid
      LIMIT 10
    `, tenantId);

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
