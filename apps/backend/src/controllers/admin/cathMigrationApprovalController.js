import { approveCathMigrationDispositions } from '../../services/clinical/cathMigrationApprovalService.js';
import { success } from '../../utils/responseHelper.js';

export async function approveDispositions(req, res, next) {
  try {
    const result = await approveCathMigrationDispositions(req.body, {
      tenantId: req.tenantId,
      actorUid: req.user.uid,
      actorRole: req.user.rawRole || req.user.role,
      mfa: req.user.mfa,
      requestId: req.id,
    });
    return success(res, result, 'Migration disposition approval recorded', 201);
  } catch (err) {
    return next(err);
  }
}
