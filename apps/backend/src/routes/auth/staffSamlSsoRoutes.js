import express from 'express';
import { param, validationResult } from 'express-validator';

import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import * as controller from '../../controllers/auth/staffSamlSsoController.js';
import { authRateLimiter } from '../../middleware/rateLimitMiddleware.js';
import { error } from '../../utils/responseHelper.js';

const router = express.Router();

const providerParam = param('provider')
  .matches(/^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$/)
  .withMessage('Invalid provider key');

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, {
      topLevel: { errors: errors.array() },
    });
  }
  return next();
};

router.get('/providers', authRateLimiter, controller.listProviders);
router.get('/:provider/start', authRateLimiter, providerParam, handleValidation, controller.start);
router.post('/:provider/acs', authRateLimiter, providerParam, handleValidation, controller.acs);

export default router;
