// src/routes/otpRoutes.js

import express from 'express';
import { validationResult } from 'express-validator';
import { phoneValidator, otpValidator } from '../config/validationSchemas.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapRoutesWithValidation } from '../config/routeWrapper.js';

const router = express.Router();

// ✅ Public OTP Routes (No RBAC required)
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      [
        '/request-otp',
        phoneValidator,
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          res.status(HTTP_STATUS.OK).json({
            message: `Mock OTP 123456 sent to ${req.body.phone || req.body.phoneNumber}`
          });
        }
      ],
      [
        '/verify-otp',
        [phoneValidator, otpValidator],
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          if (req.body.otp === '123456') {
            return success(res, { verified: true }, RESPONSE_MESSAGES.OTP_VERIFIED);
          } else {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              error: RESPONSE_MESSAGES.INVALID_OTP
            });
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;
