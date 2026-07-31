import { clinicalContinuityReplayReceiptsEnabled } from '../config/downtimeConfig.js';
import { precheckClinicalContinuityReplay } from '../services/downtime/clinicalContinuityReplayReceiptService.js';
import {
  CLINICAL_CONTINUITY_REPLAY_ENVELOPE_HEADER,
  CLINICAL_CONTINUITY_REPLAY_SOURCE_HEADER,
  parseClinicalContinuityReplayEnvelope
} from '../validators/clinicalContinuityReplayEnvelope.js';
import { error, success } from '../utils/responseHelper.js';

export async function clinicalContinuityReplayMiddleware(req, res, next) {
  const authorization = req.clinicalContinuityActionAuthorization;
  if (!authorization) return next();
  if (!clinicalContinuityReplayReceiptsEnabled()) {
    return error(res, 'Clinical continuity replay is unavailable', 503, {
      code: 'CONTINUITY_REPLAY_RECEIPTS_UNAVAILABLE',
      decision: 'deny',
      safe: true
    });
  }
  try {
    const idempotencyKey = String(req.get('idempotency-key') || '').trim();
    const parsed = parseClinicalContinuityReplayEnvelope({
      encodedEnvelope: req.get(CLINICAL_CONTINUITY_REPLAY_ENVELOPE_HEADER),
      sourceKind: String(req.get(CLINICAL_CONTINUITY_REPLAY_SOURCE_HEADER) || '').trim(),
      body: req.body,
      idempotencyKey,
      binding: authorization.binding,
      authorization,
      tenantId: req.tenantId,
      replayActorUid: req.user?.uid
    });
    const input = Object.freeze({
      authorization,
      binding: authorization.binding,
      body: req.body,
      facilityContext: authorization.facilityContext,
      parsed,
      replayActorUid: req.user?.uid,
      replayRole: req.user?.role,
      requestId: req.id,
      tenantId: req.tenantId
    });
    const existing = await precheckClinicalContinuityReplay(input);
    if (existing) return success(res, existing, 'Draft saved');
    Object.defineProperty(req, 'clinicalContinuityReplay', {
      configurable: false,
      enumerable: true,
      value: input,
      writable: false
    });
    return next();
  } catch (err) {
    return next(err);
  }
}

export default clinicalContinuityReplayMiddleware;
