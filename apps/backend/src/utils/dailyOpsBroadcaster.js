// src/utils/dailyOpsBroadcaster.js
//
// Per-tenant cron producer for the Daily Operations Snapshot. Mirrors
// kpiAggregator.js, but fans out per active tenant (the snapshot is
// strictly tenant-scoped) and broadcasts the computed snapshot on the
// admin:daily-ops channel so subscribers render without refetching.

import { getDailyOpsSnapshot } from '../services/dashboards/snapshotService.js';
import { emitDailyOpsConfirmed } from './websocket/realtimeEmitter.js';
import { runForEachTenant } from './tenantFanout.js';

/** Compute the daily-ops snapshot for each active tenant and broadcast it. */
export async function tickDailyOps() {
  await runForEachTenant('daily-ops-tick', async (tenantId) => {
    const snap = await getDailyOpsSnapshot({ tenantId });
    if (snap) await emitDailyOpsConfirmed(snap, { tenantId });
  });
}

export default { tickDailyOps };
