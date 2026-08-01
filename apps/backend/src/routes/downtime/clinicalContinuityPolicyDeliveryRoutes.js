import express from 'express';

import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import {
  authorizeClinicalContinuityPolicyFacility,
  getClinicalContinuityPolicyDelivery
} from '../../controllers/downtime/clinicalContinuityPolicyDeliveryController.js';
import { getRateLimiter } from '../../middleware/rateLimitMiddleware.js';
import {
  clinicalContinuityPolicyDeliveryValidator
} from '../../validators/clinicalContinuityPolicyDeliveryValidator.js';

const router = express.Router();

wrapAutoRBAC(
  router,
  'staffRoutes',
  {
    get: [[
      '/facilities/:facilityId/policy',
      getRateLimiter('clinicalContinuityPolicyDelivery'),
      clinicalContinuityPolicyDeliveryValidator,
      authorizeClinicalContinuityPolicyFacility,
      getClinicalContinuityPolicyDelivery
    ]]
  },
  {
    requirePhone: false,
    configKey: 'staffRoutes'
  }
);

export default router;
