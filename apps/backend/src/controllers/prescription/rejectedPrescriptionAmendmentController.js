import { HTTP_STATUS } from '../../config/responseCodes.js';
import { amendRejectedPrescription } from '../../services/pharmacy/rejectedPrescriptionAmendmentService.js';
import { error, relayAppError, success } from '../../utils/responseHelper.js';

export async function amendRejectedPharmacyOrder(req, res) {
  try {
    const prescriptionId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(prescriptionId) || prescriptionId <= 0) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await amendRejectedPrescription({
      prescriptionId,
      tenantId: req.tenantId,
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      idempotencyKey: req.idempotencyClaim?.requestKey || req.get?.('idempotency-key'),
      body: req.body || {},
    });
    return success(
      res,
      result,
      result.idempotent_replay
        ? 'Rejected prescription amendment replayed'
        : 'Rejected prescription amended; fresh pharmacist verification required',
    );
  } catch (err) {
    return relayAppError(res, err, 'Failed to amend rejected prescription');
  }
}

export default { amendRejectedPharmacyOrder };
