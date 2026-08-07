import express from 'express';

import rbacConfig from '../../config/rbacConfig.js';
import { getPatientReadiness } from '../../controllers/health/patientReadinessController.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
import { getRateLimiter } from '../../middleware/rateLimitMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import tenantContextMiddleware from '../../middleware/tenantContextMiddleware.js';
import tenantRlsMiddleware from '../../middleware/tenantRlsMiddleware.js';
import validateApiKey from '../../middleware/validateApiKey.js';

const router = express.Router();

router.get(
  '/patient-readiness',
  validateApiKey,
  jwtAuth,
  tenantContextMiddleware,
  tenantRlsMiddleware,
  requireRole(...rbacConfig.patientReadinessRoutes),
  getRateLimiter('clientReadiness'),
  getPatientReadiness,
);

export default router;
