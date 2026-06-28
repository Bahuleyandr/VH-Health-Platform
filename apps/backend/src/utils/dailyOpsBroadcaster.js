// src/utils/dailyOpsBroadcaster.js
//
// Per-tenant cron producer for the Daily Operations Snapshot. Mirrors
// kpiAggregator.js, but fans out per active tenant (the snapshot is
// strictly tenant-scoped) and broadcasts the computed snapshot on the
// admin:daily-ops channel so subscribers render without refetching.

import logger from '../logging/logger.js';
import { getDailyOpsSnapshot } from '../services/dashboards/snapshotService.js';
import { emitDailyOps } from './websocket/realtimeEmitter.js';
import { runForEachTenant } from './tenantFanout.js';

/** Compute the daily-ops snapshot for each active tenant and broadcast it. */
export async function tickDailyOps() {
  await runForEachTenant('daily-ops-tick', async (tenantId) => {
    try {
      const snap = await getDailyOpsSnapshot({ tenantId });
      if (snap) emitDailyOps(snap, { tenantId });
    } catch (err) {
      logger.warn(`daily-ops-tick: snapshot failed for tenant ${tenantId}: ${err.message}`);
    }
  });
}

export default { tickDailyOps };
