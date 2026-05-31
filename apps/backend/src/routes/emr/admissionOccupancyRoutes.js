import express from 'express';

import { HTTP_STATUS } from '../../config/responseCodes.js';
import admissionService from '../../services/emr/admissionService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.get(
  '/',
  wrapAsync(async (req, res) => {
    const result = await admissionService.getActiveAdmissions({
      page: 1,
      limit: 1,
      tenantId: req.tenantId,
    }, {
      uid: req.user?.uid,
      id: req.user?.id,
      role: req.user?.role,
      tenantId: req.tenantId,
    });

    success(
      res,
      {
        total: result.pagination.total,
        scope: result.scope,
      },
      'Inpatient occupancy count retrieved',
      HTTP_STATUS.OK,
      { scope: result.scope },
    );
  }),
);

export default router;
