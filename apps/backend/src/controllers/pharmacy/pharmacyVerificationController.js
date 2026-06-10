// src/controllers/pharmacy/pharmacyVerificationController.js
//
// Roadmap B1 — pharmacist clinical-verification endpoints.
//   POST /pharmacy/:id/verify      — record the verification verdict
//   GET  /pharmacy/:id/pack-label  — med-pack barcode + printable payload

import logger from '../../logging/logger.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import {
  verifyOrder,
  getPackLabel,
} from '../../services/pharmacy/pharmacistVerificationService.js';

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Pharmacy verification ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

export const verifyPharmacyOrder = async (req, res) => {
  try {
    const orderId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await verifyOrder(orderId, {
      decision: req.body?.decision || 'verified',
      overrideReason: req.body?.override_reason || null,
      notes: req.body?.notes || null,
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, result, `Order verification ${result.order.clinical_verification_status}`);
  } catch (err) {
    return handleFailure(res, err, 'verify pharmacy order');
  }
};

export const getPharmacyPackLabel = async (req, res) => {
  try {
    const orderId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }
    const label = await getPackLabel(orderId);
    return success(res, label, 'Med-pack label payload');
  } catch (err) {
    return handleFailure(res, err, 'build pack label');
  }
};

export default { verifyPharmacyOrder, getPharmacyPackLabel };
