import { success } from '../../utils/responseHelper.js';
import {
  authorizeExternalRecoveryOperabilityResume,
  listExternalRecoveryOperabilityWorkbench,
  registerExternalRecoveryOperabilityOffset
} from '../../services/downtime/externalRecoveryOperabilityService.js';
import {
  parseExternalRecoveryRegister,
  parseExternalRecoveryResume,
  parseExternalRecoveryWorkbenchQuery
} from '../../validators/externalRecoveryOperabilitySchemas.js';

function authority(req) {
  return {
    tenantId: req.tenantId,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    requestId: req.id
  };
}

function receiptStatus(receipt) {
  return receipt?.disposition === 'exact_duplicate' || receipt?.exact_duplicate === true
    ? 200
    : 201;
}

export async function listWorkbench(req, res, next) {
  try {
    const result = await listExternalRecoveryOperabilityWorkbench({
      ...authority(req),
      filters: parseExternalRecoveryWorkbenchQuery(req.query)
    });
    return success(res, result, 'External-recovery operability workbench');
  } catch (error) {
    return next(error);
  }
}

export async function registerOffset(req, res, next) {
  try {
    const receipt = await registerExternalRecoveryOperabilityOffset({
      ...authority(req),
      idempotencyKey: req.get('idempotency-key'),
      parsed: parseExternalRecoveryRegister(req.body)
    });
    return success(
      res,
      receipt,
      receipt?.disposition === 'exact_duplicate'
        ? 'Prior external-recovery registration receipt returned'
        : 'External-recovery partition registered',
      receiptStatus(receipt)
    );
  } catch (error) {
    return next(error);
  }
}

export async function authorizeResume(req, res, next) {
  try {
    const receipt = await authorizeExternalRecoveryOperabilityResume({
      ...authority(req),
      offsetId: req.params.offsetId,
      idempotencyKey: req.get('idempotency-key'),
      parsed: parseExternalRecoveryResume(req.body)
    });
    return success(
      res,
      receipt,
      receipt?.disposition === 'exact_duplicate'
        ? 'Prior external-recovery resume receipt returned'
        : 'External-recovery partition resume authorized',
      receiptStatus(receipt)
    );
  } catch (error) {
    return next(error);
  }
}

export default Object.freeze({ authorizeResume, listWorkbench, registerOffset });
