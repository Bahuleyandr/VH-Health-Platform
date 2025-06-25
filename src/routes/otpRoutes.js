// src/routes/otpRoutes.js - Core OTP Routes (Production)

import express from 'express';
import { validationResult } from 'express-validator';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapRoutesWithValidation } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { logAudit } from '../utils/logAudit.js';
import logger from '../logging/logger.js';

// Import our split modules
import { OTP_CONFIG } from '../config/otpConfig.js';
import { OTPService } from '../services/otpService.js';
import { phoneValidator, phoneOtpValidator } from '../validators/otpValidators.js'; // ✅ Fixed import

const router = express.Router();

// ✅ PUBLIC OTP ROUTES
wrapRoutesWithValidation(
  router,
  [],
  {
    post: [
      [
        '/request-otp',
        ...phoneValidator, // ✅ Fixed validator
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          try {
            const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
            const purpose = req.body.purpose || 'general';
            const userId = req.body.user_id || null;
            
            // Check daily limit
            const dailyLimitOk = await OTPService.checkDailyLimit(phone);
            if (!dailyLimitOk) {
              await OTPService.logActivity(phone, purpose, 'request', false, 'daily_limit_exceeded', req);
              return error(res, 'Daily OTP limit exceeded. Try again tomorrow.', HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Check resend cooldown
            const cooldownOk = await OTPService.checkResendCooldown(phone, purpose);
            if (!cooldownOk) {
              await OTPService.logActivity(phone, purpose, 'request', false, 'resend_cooldown', req);
              return error(res, `Please wait ${OTP_CONFIG.resendCooldownMinutes} minute(s) before requesting another OTP`, HTTP_STATUS.TOO_MANY_REQUESTS);
            }

            // Generate and store OTP
            const { otp, expiresAt, sessionId } = await OTPService.storeOTP(phone, purpose, userId);

            // Log successful request
            await OTPService.logActivity(phone, purpose, 'request', true, null, req);

            logger.info(`📱 OTP ${otp} generated for ${phone} (${purpose}) - Session: ${sessionId}`);

            success(res, {
              phone,
              purpose,
              otpSent: true,
              sessionId,
              expiresInMinutes: OTP_CONFIG.expirationMinutes,
              attemptsAllowed: OTP_CONFIG.maxAttempts,
              ...(OTP_CONFIG.devMode && { devOtp: otp })
            }, `OTP sent successfully for ${purpose}`);

          } catch (err) {
            logger.error('OTP Request Error:', err);
            await OTPService.logActivity(
              req.body.phone, 
              req.body.purpose || 'general', 
              'request', 
              false, 
              'system_error', 
              req
            );
            error(res, 'Failed to send OTP. Please try again.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      [
        '/verify-otp',
        ...phoneOtpValidator, // ✅ Fixed validator
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          try {
            const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
            const inputOtp = req.body.otp;
            const purpose = req.body.purpose || 'general';

            // Verify OTP
            const verification = await OTPService.verifyOTP(phone, inputOtp, purpose);
            
            // Log verification attempt
            await OTPService.logActivity(
              phone, purpose, 'verify', verification.valid,
              verification.valid ? null : verification.reason, req
            );

            if (!verification.valid) {
              return res.status(HTTP_STATUS.BAD_REQUEST).json({
                success: false,
                error: verification.reason,
                attemptsLeft: verification.attemptsLeft
              });
            }

            // Log audit for successful verification
            await logAudit(req, 'otp-verified', {
              phone,
              purpose,
              sessionId: verification.sessionId
            });

            logger.info(`✅ OTP verified for ${phone} (${purpose})`);

            success(res, {
              phone,
              purpose,
              verified: true,
              sessionId: verification.sessionId,
              userId: verification.userId,
              verifiedAt: new Date().toISOString()
            }, RESPONSE_MESSAGES.OTP_VERIFIED);

          } catch (err) {
            logger.error('OTP Verification Error:', err);
            await OTPService.logActivity(
              req.body.phone, 
              req.body.purpose || 'general', 
              'verify', 
              false, 
              'system_error', 
              req
            );
            error(res, 'OTP verification failed. Please try again.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    get: [
      [
        '/health',
        async (req, res) => {
          try {
            const healthData = await OTPService.getHealthStatus();
            success(res, healthData, 'OTP service is healthy');
          } catch (err) {
            logger.error('OTP Health Check Error:', err);
            success(res, {
              status: 'degraded',
              message: 'OTP service temporarily unavailable',
              timestamp: new Date().toISOString()
            }, 'OTP service status check');
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

logger.info('✅ OTP routes loaded successfully');
export default router;