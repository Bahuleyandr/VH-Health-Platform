import {
  countersignClinicalContinuityAdvance,
  createClinicalContinuityAdvanceIntent,
  getClinicalContinuityActivationState,
  haltClinicalContinuityActivation,
} from '../../services/downtime/clinicalContinuityActivationTransitionService.js';
import { success } from '../../utils/responseHelper.js';
import {
  parseClinicalContinuityAdvanceCountersign,
  parseClinicalContinuityAdvanceIntent,
  parseClinicalContinuityHalt,
} from '../../validators/clinicalContinuityActivationTransitionSchemas.js';

function authority(req) {
  return {
    tenantId: req.tenantId,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    requestId: req.id,
  };
}

function receiptStatus(receipt) {
  return receipt?.disposition === 'exact_duplicate' ? 200 : 201;
}

export async function getState(req, res, next) {
  try {
    const state = await getClinicalContinuityActivationState({
      ...authority(req),
      facilityId: req.params.facilityId,
    });
    return success(res, state, 'Clinical continuity activation state');
  } catch (error) {
    return next(error);
  }
}

export async function createAdvanceIntent(req, res, next) {
  try {
    const receipt = await createClinicalContinuityAdvanceIntent({
      ...authority(req),
      facilityId: req.params.facilityId,
      idempotencyKey: req.get('idempotency-key'),
      parsed: parseClinicalContinuityAdvanceIntent(req.body),
    });
    return success(
      res,
      receipt,
      receipt?.disposition === 'exact_duplicate'
        ? 'Prior activation advance intent returned'
        : 'Activation advance awaits the complementary roster key',
      receiptStatus(receipt),
    );
  } catch (error) {
    return next(error);
  }
}

export async function countersignAdvance(req, res, next) {
  try {
    const receipt = await countersignClinicalContinuityAdvance({
      ...authority(req),
      facilityId: req.params.facilityId,
      intentEventId: req.params.intentEventId,
      idempotencyKey: req.get('idempotency-key'),
      parsed: parseClinicalContinuityAdvanceCountersign(req.body),
    });
    return success(
      res,
      receipt,
      receipt?.disposition === 'exact_duplicate'
        ? 'Prior activation advance receipt returned'
        : 'Activation advance applied with two distinct roster keys',
      receiptStatus(receipt),
    );
  } catch (error) {
    return next(error);
  }
}

export async function haltActivation(req, res, next) {
  try {
    const receipt = await haltClinicalContinuityActivation({
      ...authority(req),
      facilityId: req.params.facilityId,
      idempotencyKey: req.get('idempotency-key'),
      parsed: parseClinicalContinuityHalt(req.body),
    });
    return success(
      res,
      receipt,
      receipt?.disposition === 'exact_duplicate'
        ? 'Prior activation halt receipt returned'
        : 'Activation halted to fail-closed off',
      receiptStatus(receipt),
    );
  } catch (error) {
    return next(error);
  }
}

export default Object.freeze({
  countersignAdvance,
  createAdvanceIntent,
  getState,
  haltActivation,
});
