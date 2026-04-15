// src/utils/kpiAggregator.js
//
// Periodic KPI aggregator for the admin dashboard. Computes the tiles that
// pair a baseline (queried fresh each tick) with live event deltas, and emits
// them on the `admin:kpi` channel so subscribers paint immediately on mount
// and stay fresh without polling.

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { emitAdminKpi } from './websocket/realtimeEmitter.js';

/**
 * Snapshot each tile and emit it on `admin:kpi`.
 * Any single tile query failure is logged and skipped — we'd rather emit a
 * partial tick than block the whole cycle.
 */
export async function tickAdminKpi() {
  await Promise.all([
    _occupancyTile(),
    _waitingQueueTile(),
  ]);
}

async function _occupancyTile() {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int                                            AS total,
         COUNT(*) FILTER (WHERE status = 'OCCUPIED')::int         AS occupied,
         COUNT(*) FILTER (WHERE status = 'AVAILABLE')::int        AS available,
         COUNT(*) FILTER (WHERE status NOT IN ('OCCUPIED','AVAILABLE'))::int AS other
       FROM beds`,
    );
    const r = rows[0] || { total: 0, occupied: 0, available: 0, other: 0 };
    const total = Number(r.total) || 0;
    const occupied = Number(r.occupied) || 0;
    const occupancyPct = total > 0 ? Math.round((occupied / total) * 100) : 0;
    emitAdminKpi('bed-occupancy', {
      total,
      occupied,
      available: Number(r.available) || 0,
      other: Number(r.other) || 0,
      occupancyPct,
    });
  } catch (err) {
    logger.warn('kpi: bed-occupancy tile failed:', err.message);
  }
}

async function _waitingQueueTile() {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('CONFIRMED','SCHEDULED'))::int AS waiting,
         COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int              AS in_progress,
         COUNT(DISTINCT doctor_id)
           FILTER (WHERE status IN ('CONFIRMED','SCHEDULED','IN_PROGRESS'))::int AS active_doctors
       FROM appointments
       WHERE DATE(appointment_date) = CURRENT_DATE`,
    );
    const r = rows[0] || { waiting: 0, in_progress: 0, active_doctors: 0 };
    emitAdminKpi('waiting-queue', {
      waiting: Number(r.waiting) || 0,
      inProgress: Number(r.in_progress) || 0,
      activeDoctors: Number(r.active_doctors) || 0,
    });
  } catch (err) {
    logger.warn('kpi: waiting-queue tile failed:', err.message);
  }
}

export default { tickAdminKpi };
