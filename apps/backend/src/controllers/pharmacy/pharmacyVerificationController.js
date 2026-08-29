// src/controllers/pharmacy/pharmacyVerificationController.js
//
// Roadmap B1 — pharmacist clinical-verification endpoints.
//   POST /pharmacy/:id/verify      — record the verification verdict
//   GET  /pharmacy/:id/pack-label  — med-pack barcode + printable payload

import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import {
  verifyOrder,
  getPackLabel,
} from '../../services/pharmacy/pharmacistVerificationService.js';
import { createDispenseCommandIdentity } from '../../services/pharmacy/pharmacyOrderInventoryService.js';
import { pharmacyCommandRequestSha256 } from '../../services/pharmacy/pharmacyOrderCommandReceiptService.js';

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

export const verifyPharmacyOrder = async (req, res) => {
  try {
    const orderId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }
    const requestPayload = {
      decision: req.body?.decision || 'verified',
      override_reason: req.body?.override_reason || null,
      rejection_reason: req.body?.rejection_reason || null,
      manual_allergy_review_completed: req.body?.manual_allergy_review_completed === true,
      notes: req.body?.notes || null,
    };
    const commandKeySha256 = createDispenseCommandIdentity({
      tenantId: req.tenantId,
      actorUid: req.user?.uid,
      scope: `verify:${orderId}`,
      idempotencyKey: req.idempotencyClaim?.requestKey || req.get?.('idempotency-key'),
    });
    const result = await verifyOrder(orderId, {
      tenantId: req.tenantId,
      decision: requestPayload.decision,
      overrideReason: requestPayload.override_reason,
      rejectionReason: requestPayload.rejection_reason,
      manualAllergyReviewCompleted: requestPayload.manual_allergy_review_completed,
      notes: requestPayload.notes,
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      commandKeySha256,
      requestSha256: pharmacyCommandRequestSha256(requestPayload),
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
    const label = await getPackLabel(orderId, req.tenantId);
    return success(res, label, 'Med-pack label payload');
  } catch (err) {
    return handleFailure(res, err, 'build pack label');
  }
};

export default { verifyPharmacyOrder, getPharmacyPackLabel };
