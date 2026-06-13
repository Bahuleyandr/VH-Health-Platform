// src/services/appointment/appointmentReaperService.js
//
// A8 — visit-status reaper. Stale appointments still in SCHEDULED long
// after their slot have-passed look like the patient is "still expected"
// in dashboards, block the no-show analytics, and stop the follow-up
// engagement workflow from firing. This reaper runs on a cron, finds
// SCHEDULED appointments whose slot is more than the grace window past,
// flips them to MISSED, and writes an audit row to
// appointment_status_history.
//
// Design notes:
//   - Grace window is 60 min by default. A longer window (e.g. 4h)
//     would be friendlier to OPDs that run heavily-late but masks
//     genuine no-shows from the dashboard. 60 min matches the SLA
//     threshold most clinics use.
//   - admin_override = true rows are skipped: those are explicit
//     overrides (e.g. "doctor will see at 5pm") and should not be
//     auto-reaped.
//   - The reaper is idempotent: re-running is safe because the
//     UPDATE filters on status='SCHEDULED' and the history INSERT
//     only happens for rows that flipped.
//   - Combines appointment_date (DATE) + appointment_time (VARCHAR
//     'HH:MM') into a timestamp via Postgres-side casting so server-tz
//     ambiguity is bounded to one place.
//
// Architectural item A8. No specific finding — inferred from the
// "completed-visit-empty-shell" + "no-show analytics empty" pattern
// across walk-in OPD findings. Bookkeeping companion to the existing
// stuck-order escalation job.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { runWithSuperAdmin } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';

const DEFAULT_GRACE_MIN = 60;

/**
 * One sweep. Returns the count of rows reaped.
 * Safe to call ad-hoc (admin reset utility) or from cron.
 *
 * Phase-2 RLS: cross-tenant reaper. Wraps in runWithSuperAdmin so
 * RLS bypasses when AUTH_ENFORCE_TENANT_RLS=true.
 */
export async function reapStaleScheduledVisits({ graceMinutes = DEFAULT_GRACE_MIN } = {}) {
  return runWithSuperAdmin(async () => reapStaleScheduledVisitsInner({ graceMinutes }));
}

async function reapStaleScheduledVisitsInner({ graceMinutes = DEFAULT_GRACE_MIN } = {}) {
  const grace = Math.max(15, Math.min(720, Number(graceMinutes) || DEFAULT_GRACE_MIN));

  // Find candidates first — same predicate used by the UPDATE so the
  // history INSERT only sees rows that actually flipped.
  // The CAST stitches DATE + 'HH:MM' into a timestamp without a
  // separate timezone column; the server's TZ is acceptable because
  // appointment slots have always been stored in local clinic time.
  const candidates = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM appointments
      WHERE status = 'SCHEDULED'
        AND admin_override = false
        AND (appointment_date::timestamp +
             COALESCE(NULLIF(appointment_time, '')::interval, INTERVAL '0 minutes'))
            < (NOW() - ($1 || ' minutes')::interval)`,
    String(grace),
  );
  if (!candidates.length) return { reaped: 0 };

  const ids = candidates.map((r) => Number(r.id)).filter(Number.isFinite);
  if (!ids.length) return { reaped: 0 };

  // Flip + history in one transaction so a partial failure doesn't
  // leave the audit trail desynced from the row state.
  const reaped = await setTenantTx(null, async (tx) => {
    const updated = await tx.appointments.updateMany({
      where: { id: { in: ids }, status: 'SCHEDULED', admin_override: false },
      data: { status: 'MISSED', updated_at: new Date() },
    });
    if (updated.count > 0) {
      // Bulk createMany; one row per reaped appointment.
      await tx.appointment_status_history.createMany({
        data: ids.map((id) => ({
          appointment_id: id,
          from_status: 'SCHEDULED',
          to_status: 'MISSED',
          changed_by: null,
          changed_by_role: 'system',
          reason: `auto-missed: no-show grace exceeded (${grace} min)`,
        })),
        skipDuplicates: false,
      });
    }
    return updated.count;
  }, { superAdmin: true });

  if (reaped > 0) {
    logger.info(`Visit reaper: marked ${reaped} stale SCHEDULED appointment(s) as MISSED (grace=${grace}m)`);
  }
  return { reaped };
}

export default {
  reapStaleScheduledVisits,
};
