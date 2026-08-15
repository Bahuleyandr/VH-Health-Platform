// src/utils/kpiAggregator.js
//
// Per-tenant cron producer for the admin dashboard KPI tiles. Computes the
// tiles that pair a baseline (queried fresh each tick) with live event deltas,
// and emits them on the `admin:kpi` channel so subscribers paint immediately
// on mount and stay fresh without polling.
//
// Mirrors dailyOpsBroadcaster.js: the counts are strictly tenant-scoped, so
// the tick fans out per active tenant, every tile query carries an explicit
// `tenant_id = $1::uuid` predicate, and each emit is stamped with the tenant
// id so the per-broadcast tenant filter in wsServer.js delivers a tenant's
// numbers only to that tenant's admin sockets. Never emit a tenant-null
// `admin:kpi` message — tenant-null matches every connected socket.

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { emitAdminKpi } from './websocket/realtimeEmitter.js';
import { runForEachTenant } from './tenantFanout.js';

/**
 * Emit a KPI tile on the WebSocket `admin:kpi` channel AND log it as a
 * structured event so external observability (CloudWatch/Loki/Datadog) can
 * scrape the same metrics without depending on WS subscribers. The log event
 * has a stable shape: { event: 'kpi.snapshot', metric, tenantId, payload }.
 */
function emitAndLogKpi(metric, payload, { tenantId }) {
  emitAdminKpi(metric, payload, { tenantId });
  logger.info('kpi.snapshot', { event: 'kpi.snapshot', metric, tenantId, payload });
}

/**
 * Snapshot each tile for every active tenant and emit it on `admin:kpi`.
 * Any single tile query failure is logged and skipped — we'd rather emit a
 * partial tick than block the tenant's whole cycle.
 */
export async function tickAdminKpi() {
  await runForEachTenant('admin-kpi-tick', async (tenantId) => {
    await Promise.all([
      _occupancyTile(tenantId),
      _waitingQueueTile(tenantId),
    ]);
  });
}

async function _occupancyTile(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int                                            AS total,
         COUNT(*) FILTER (WHERE status = 'OCCUPIED')::int         AS occupied,
         COUNT(*) FILTER (WHERE status = 'AVAILABLE')::int        AS available,
         COUNT(*) FILTER (WHERE status NOT IN ('OCCUPIED','AVAILABLE'))::int AS other
       FROM beds
       WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    const r = rows[0] || { total: 0, occupied: 0, available: 0, other: 0 };
    const total = Number(r.total) || 0;
    const occupied = Number(r.occupied) || 0;
    const occupancyPct = total > 0 ? Math.round((occupied / total) * 100) : 0;
    emitAndLogKpi('bed-occupancy', {
      total,
      occupied,
      available: Number(r.available) || 0,
      other: Number(r.other) || 0,
      occupancyPct,
    }, { tenantId });
  } catch (err) {
    logger.warn(`kpi: bed-occupancy tile failed for tenant ${tenantId}:`, err.message);
  }
}

async function _waitingQueueTile(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('CONFIRMED','SCHEDULED'))::int AS waiting,
         COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int              AS in_progress,
         COUNT(DISTINCT doctor_id)
           FILTER (WHERE status IN ('CONFIRMED','SCHEDULED','IN_PROGRESS'))::int AS active_doctors
       FROM appointments
       WHERE tenant_id = $1::uuid
         AND DATE(appointment_date) = CURRENT_DATE`,
      tenantId,
    );
    const r = rows[0] || { waiting: 0, in_progress: 0, active_doctors: 0 };
    emitAndLogKpi('waiting-queue', {
      waiting: Number(r.waiting) || 0,
      inProgress: Number(r.in_progress) || 0,
      activeDoctors: Number(r.active_doctors) || 0,
    }, { tenantId });
  } catch (err) {
    logger.warn(`kpi: waiting-queue tile failed for tenant ${tenantId}:`, err.message);
  }
}

export default { tickAdminKpi };
