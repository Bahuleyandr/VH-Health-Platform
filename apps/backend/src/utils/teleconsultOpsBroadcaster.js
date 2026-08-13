// src/utils/teleconsultOpsBroadcaster.js
//
// Per-tenant cron producer for the teleconsult operational snapshot.

import { getTeleconsultOpsSnapshot } from '../services/dashboards/teleconsultOpsService.js';
import { emitTeleconsultOpsConfirmed } from './websocket/realtimeEmitter.js';
import { runForEachTenant } from './tenantFanout.js';

export async function tickTeleconsultOps() {
  await runForEachTenant('teleconsult-ops-tick', async (tenantId) => {
    const snap = await getTeleconsultOpsSnapshot({ tenantId });
    if (snap) await emitTeleconsultOpsConfirmed(snap, { tenantId });
  });
}

export default { tickTeleconsultOps };
