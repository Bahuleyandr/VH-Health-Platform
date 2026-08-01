import { param, validationResult } from 'express-validator';

import { AppError } from '../utils/AppError.js';

function validate(req, _res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  return next(
    AppError.badRequest(
      'Clinical continuity policy facility is invalid',
      'VALIDATION_ERROR',
      result.array({ onlyFirstError: true })
    )
  );
}

export const clinicalContinuityPolicyDeliveryValidator = [
  param('facilityId')
    .isInt({ min: 1, max: 2_147_483_647 })
    .withMessage('facilityId must be a positive integer'),
  validate
];
