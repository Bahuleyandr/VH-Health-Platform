// apps/backend/src/routes/clinical/cathDeviceHistoryHandler.js
//
// GET .../devices/:deviceId/history — ONE handler function, registered twice:
//   /api/v1/cath-lab/devices/:deviceId/history          (cath workflow roles)
//   /api/v1/cath-reprocessing/devices/:deviceId/history (governance roles, so
//     infection control can open the device tags its own notifications name).
//
// The response lists every patient the device touched, which makes it PHI with
// NO single patient subject. Neither mount can produce a per-patient trail on
// its own: the cath mount's phiAccessLogger('CATH_LAB') resolves a patient
// from the REQUEST, and this request carries none, so it records one row with
// patient_id = NULL; the governance mount carries no PHI logger at all. The
// trail is therefore written explicitly — one hipaa_access_log row per
// distinct patient in the answer, which is also the only shape a
// breach-detection query over patient_id can use.
//
// Both routers share this exact function rather than each writing their own
// chain, because two copies of an audit obligation is how one of them quietly
// stops writing.

import {
  deviceHistory,
  logDeviceHistoryAccess,
} from '../../services/clinical/cathDeviceReuseService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { relayAppError, success } from '../../utils/responseHelper.js';

export default async function cathDeviceHistoryHandler(req, res) {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const deviceId = req.params.deviceId;
    const history = await deviceHistory({ tenantId, deviceId });
    // Awaited BEFORE the response: a reader must never receive the patient
    // list on a request whose access rows were not even attempted.
    await logDeviceHistoryAccess({
      tenantId,
      deviceId,
      history,
      actor: {
        actorUid: req.user?.uid || null,
        actorRole: req.user?.role || req.user?.rawRole || null,
        ipAddress: req.ip || null,
        requestId: req.id || null,
      },
    });
    return success(res, history, 'Reprocessable device history');
  } catch (err) {
    return relayAppError(res, err, 'Failed to device history');
  }
}
