// src/utils/teleconsultOpsBroadcaster.js
//
// Per-tenant cron producer for the teleconsult operational snapshot.

import logger from '../logging/logger.js';
import { getTeleconsultOpsSnapshot } from '../services/dashboards/teleconsultOpsService.js';
import { emitTeleconsultOps } from './websocket/realtimeEmitter.js';
import { runForEachTenant } from './tenantFanout.js';

export async function tickTeleconsultOps() {
  await runForEachTenant('teleconsult-ops-tick', async (tenantId) => {
    try {
      const snap = await getTeleconsultOpsSnapshot({ tenantId });
      if (snap) emitTeleconsultOps(snap, { tenantId });
    } catch (err) {
      logger.warn(`teleconsult-ops-tick: snapshot failed for tenant ${tenantId}: ${err.message}`);
    }
  });
}

export default { tickTeleconsultOps };
