// src/services/appointment/appointmentReaperService.js
//
// A8 — visit-status reaper. Stale appointments still in SCHEDULED long
// after their slot has passed look like the patient is "still expected"
// in dashboards and block no-show analytics. OFF/SHADOW tenants retain the
// legacy SCHEDULED -> MISSED bookkeeping behavior. ACTIVE OP pathway tenants
// are deliberately left unchanged because the canonical appointment
// lifecycle has no registered system-actor transition today.
//
// Design notes:
//   - Grace window is 60 min by default. A longer window (e.g. 4h)
//     would be friendlier to OPDs that run heavily-late but masks
//     genuine no-shows from the dashboard. 60 min matches the SLA
//     threshold most clinics use.
//   - admin_override = true rows are skipped: those are explicit
//     overrides (e.g. "doctor will see at 5pm") and should not be
//     auto-reaped.
//   - The reaper is idempotent: re-running is safe because the UPDATE filters
//     on status='SCHEDULED' and returns the exact rows that flipped.
//   - Tenant settings rows are share-locked in the mutation transaction so an
//     activation update cannot race a legacy MISSED write.
//   - Combines appointment_date (DATE) + appointment_time (VARCHAR
//     'HH:MM') into a timestamp via Postgres-side casting so server-tz
//     ambiguity is bounded to one place.
//
// Architectural item A8. No specific finding — inferred from the
// "completed-visit-empty-shell" + "no-show analytics empty" pattern
// across walk-in OPD findings. Bookkeeping companion to the existing
// stuck-order escalation job.

import { setTenantTx } from '../../lib/prisma.js';
import { runWithSuperAdmin } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import {
  CARE_PATHWAY_KEYS,
  DEFAULT_PATHWAY_MODE,
  PATHWAY_MODES,
  normalizePathwayMode,
} from '../pathways/pathwayMode.js';
import {
  DEFAULT_APPOINTMENT_REAPER_GRACE_MINUTES,
  normalizeAppointmentReaperGraceMinutes,
} from './appointmentReaperPolicy.js';

/**
 * One sweep. Returns the count of rows reaped.
 * Safe to call ad-hoc (admin reset utility) or from cron.
 *
 * Phase-2 RLS: cross-tenant reaper. Wraps in runWithSuperAdmin so
 * RLS bypasses when AUTH_ENFORCE_TENANT_RLS=true.
 */
export async function reapStaleScheduledVisits({
  graceMinutes = DEFAULT_APPOINTMENT_REAPER_GRACE_MINUTES,
} = {}) {
  return runWithSuperAdmin(async () => reapStaleScheduledVisitsInner({ graceMinutes }));
}

async function reapStaleScheduledVisitsInner({
  graceMinutes = DEFAULT_APPOINTMENT_REAPER_GRACE_MINUTES,
} = {}) {
  const grace = normalizeAppointmentReaperGraceMinutes(graceMinutes);

  const outcome = await setTenantTx(null, async (tx) => {
    // The CAST stitches DATE + 'HH:MM' into a timestamp without a separate
    // timezone column; appointment slots are stored in local clinic time.
    const candidates = await tx.$queryRawUnsafe(
      `SELECT appointment.id,
              appointment.tenant_id,
              tenant.settings -> 'care_pathways' ->> $2::text AS pathway_mode
         FROM appointments AS appointment
         JOIN tenants AS tenant
           ON tenant.id = appointment.tenant_id
        WHERE appointment.status = 'SCHEDULED'
          AND appointment.admin_override = false
          AND (appointment.appointment_date::timestamp +
               COALESCE(
                 NULLIF(appointment.appointment_time, '')::interval,
                 INTERVAL '0 minutes'
               ))
              < (NOW() - ($1 || ' minutes')::interval)
        ORDER BY appointment.id
        FOR UPDATE OF appointment
        FOR SHARE OF tenant`,
      String(grace),
      CARE_PATHWAY_KEYS.OP,
    );
    if (!candidates.length) return { reaped: 0, skippedActive: 0 };

    const legacyIds = [];
    let skippedActive = 0;
    for (const candidate of candidates) {
      const mode = normalizePathwayMode(candidate.pathway_mode) || DEFAULT_PATHWAY_MODE;
      if (mode === PATHWAY_MODES.ACTIVE) {
        skippedActive += 1;
      } else {
        const id = Number(candidate.id);
        if (Number.isSafeInteger(id) && id > 0) legacyIds.push(id);
      }
    }
    if (!legacyIds.length) return { reaped: 0, skippedActive };

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE appointments
          SET status = 'MISSED',
              updated_at = NOW()
        WHERE id = ANY($1::integer[])
          AND status = 'SCHEDULED'
          AND admin_override = false
      RETURNING id, tenant_id`,
      legacyIds,
    );
    if (updatedRows.length > 0) {
      await tx.appointment_status_history.createMany({
        data: updatedRows.map((row) => ({
          tenant_id: row.tenant_id,
          appointment_id: Number(row.id),
          from_status: 'SCHEDULED',
          to_status: 'MISSED',
          changed_by: null,
          changed_by_role: 'system',
          reason: `auto-missed: no-show grace exceeded (${grace} min)`,
        })),
        skipDuplicates: false,
      });
    }
    return { reaped: updatedRows.length, skippedActive };
  }, { superAdmin: true });

  if (outcome.reaped > 0) {
    logger.info(
      `Visit reaper: marked ${outcome.reaped} stale SCHEDULED appointment(s) as MISSED (grace=${grace}m)`,
    );
  }
  if (outcome.skippedActive > 0) {
    logger.warn('Visit reaper left ACTIVE-pathway appointments unchanged', {
      skipped: outcome.skippedActive,
      reason: 'registered system appointment transition unavailable',
    });
  }
  return outcome;
}

export default {
  reapStaleScheduledVisits,
};
