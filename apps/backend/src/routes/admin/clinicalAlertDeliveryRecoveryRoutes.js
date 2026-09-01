import express from 'express';

import { markRouterDomain } from '../../config/openapiDomain.js';
import { ADMIN_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import { enforceStaffClinicalWriteDevicePosture } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { sanitizeAllBodyStrings } from '../../middleware/sanitizeMiddleware.js';
import {
  getClinicalAlertRecoveryCase,
  listClinicalAlertRecoveryCases,
  retryClinicalAlertRecoveryCase,
  supersedeClinicalAlertRecoveryCase,
} from '../../services/clinical/clinicalAlertDeliveryObligationService.js';
import { AppError } from '../../utils/AppError.js';
import { success } from '../../utils/responseHelper.js';

const router = markRouterDomain(express.Router(), 'operational-alert');

router.use(requireRole(...ADMIN_ROUTE_ROLES));
router.use(sanitizeAllBodyStrings);
router.use(phiAccessLogger('CLINICAL_ALERTS'));

function requireCaseId(value) {
  const id = String(value || '').trim();
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw AppError.badRequest(
      'Recovery case id must be a positive integer',
      'CLINICAL_ALERT_RECOVERY_ID_INVALID',
    );
  }
  return id;
}

function requireIdempotencyKey(req) {
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (!key) {
    throw AppError.badRequest(
      'Idempotency-Key header is required',
      'CLINICAL_ALERT_RECOVERY_IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  return key;
}

function exactReasonBody(req) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== 'reason') {
    throw AppError.badRequest(
      'Recovery command body must contain only reason',
      'CLINICAL_ALERT_RECOVERY_BODY_INVALID',
    );
  }
  return body.reason;
}

router.get('/recovery-cases', async (req, res, next) => {
  try {
    const allowed = new Set(['status', 'case_kind', 'limit']);
    if (Object.keys(req.query || {}).some((field) => !allowed.has(field))) {
      throw AppError.badRequest(
        'Recovery workbench query contains unsupported fields',
        'CLINICAL_ALERT_RECOVERY_QUERY_INVALID',
      );
    }
    const result = await listClinicalAlertRecoveryCases({
      tenantId: req.tenantId,
      status: req.query.status === 'all' ? null : (req.query.status || 'open'),
      caseKind: req.query.case_kind || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Clinical alert recovery cases retrieved');
  } catch (error) {
    return next(error);
  }
});

router.get('/recovery-cases/:caseId', async (req, res, next) => {
  try {
    if (Object.keys(req.query || {}).length > 0) {
      throw AppError.badRequest(
        'Recovery case query contains unsupported fields',
        'CLINICAL_ALERT_RECOVERY_QUERY_INVALID',
      );
    }
    const result = await getClinicalAlertRecoveryCase({
      tenantId: req.tenantId,
      caseId: requireCaseId(req.params.caseId),
    });
    return success(res, result, 'Clinical alert recovery case retrieved');
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/recovery-cases/:caseId/retry',
  enforceStaffClinicalWriteDevicePosture,
  async (req, res, next) => {
    try {
      const result = await retryClinicalAlertRecoveryCase({
        tenantId: req.tenantId,
        caseId: requireCaseId(req.params.caseId),
        actorUid: req.user?.uid || null,
        reason: exactReasonBody(req),
        idempotencyKey: requireIdempotencyKey(req),
        requestId: req.id,
      });
      return success(
        res,
        result,
        result.replayed
          ? 'Clinical alert delivery retry replayed'
          : 'Clinical alert delivery retry recorded',
      );
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/recovery-cases/:caseId/supersede',
  enforceStaffClinicalWriteDevicePosture,
  async (req, res, next) => {
    try {
      const result = await supersedeClinicalAlertRecoveryCase({
        tenantId: req.tenantId,
        caseId: requireCaseId(req.params.caseId),
        actorUid: req.user?.uid || null,
        reason: exactReasonBody(req),
        idempotencyKey: requireIdempotencyKey(req),
        requestId: req.id,
      });
      return success(
        res,
        result,
        result.replayed
          ? 'Clinical alert supersession replayed'
          : 'Clinical alert supersession recorded',
      );
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
