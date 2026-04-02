// src/routes/otpDevRoutes.js
// Development-Only OTP Routes - Working Version without wrapRoutesWithValidation

import express from 'express';
import { validationResult } from 'express-validator';
import prisma from '../lib/prisma.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import { OTPService } from '../services/otpService.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { success, error } from '../utils/responseHelper.js';
import { phoneValidator, otpValidator, phoneOtpValidator } from '../validators/otpValidators.js';

const router = express.Router();

// ✅ Environment check - only load routes in development/test
const isDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

if (isDevelopment) {
  // ✅ Health check for development routes
  router.get('/health', (req, res) => {
    success(res, {
      status: 'operational',
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
      warning: 'Development routes - not available in production'
    }, 'OTP Development routes are healthy');
  });

  // ✅ Get OTP statistics for debugging
  router.get('/stats', async (req, res) => {
    try {
      // Get OTP statistics from database
      const stats = await prisma.$queryRawUnsafe(`
        SELECT 
          COUNT(*) as total_otps,
          COUNT(CASE WHEN verified = true THEN 1 END) as verified_otps,
          COUNT(CASE WHEN expires_at > NOW() THEN 1 END) as active_otps,
          COUNT(CASE WHEN expires_at <= NOW() THEN 1 END) as expired_otps
        FROM otp_codes 
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      `);

      const dailyStats = await prisma.$queryRawUnsafe(`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as count,
          COUNT(CASE WHEN verified = true THEN 1 END) as verified_count
        FROM otp_codes 
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `);

      success(res, {
        summary: stats[0] || {},
        daily: dailyStats.rows || [],
        warning: 'Development statistics only'
      }, 'OTP statistics retrieved');

    } catch (err) {
      logger.error('OTP Stats Error:', err);
      error(res, 'Failed to retrieve OTP statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  });

  // ✅ Get OTP details by phone (using query parameter)
  router.get('/phone', async (req, res) => {
    try {
      const { phone } = req.query;
      if (!phone) {
        return error(res, 'Phone number is required as query parameter', HTTP_STATUS.BAD_REQUEST);
      }

      const normalizedPhone = normalizePhone(phone);
      if (!normalizedPhone) {
        return error(res, 'Invalid phone number format', HTTP_STATUS.BAD_REQUEST);
      }

      const otps = await prisma.$queryRawUnsafe(`
        SELECT id, otp_code, purpose, expires_at, verified, created_at, attempts
        FROM otp_codes 
        WHERE phone = $1 
        ORDER BY created_at DESC 
        LIMIT 10
      `, [normalizedPhone]);

      success(res, {
        phone: normalizedPhone,
        otps: otps.rows.map(otp => ({
          ...otp,
          otp_code: '***' + otp.otp_code.slice(-3), // Mask for security
          is_expired: new Date(otp.expires_at) <= new Date(),
          age_minutes: Math.round((Date.now() - new Date(otp.created_at)) / 60000)
        })),
        warning: 'Development data only - OTP codes are masked'
      }, 'OTP history retrieved');

    } catch (err) {
      logger.error('OTP Phone Lookup Error:', err);
      error(res, 'Failed to retrieve OTP history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  });

  // ✅ Generate test OTP with specific code
  router.post('/generate-test-otp', phoneValidator, async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const { phone, purpose = 'test', customOtp } = req.body;
      const normalizedPhone = normalizePhone(phone);
      
      // Generate or use custom OTP
      const otpCode = customOtp || OTPService.generateOTP();
      
      // Store test OTP with longer expiration for development
      const expirationMinutes = 30; // 30 minutes for development
      const expiresAt = new Date(Date.now() + expirationMinutes * 60 * 1000);
      
      const result = await prisma.$queryRawUnsafe(`
        INSERT INTO otp_codes (phone, otp_code, purpose, expires_at, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING id, session_id
      `, [normalizedPhone, otpCode, purpose, expiresAt]);

      const sessionId = result[0]?.session_id || 'dev-session';

      logger.info(`🧪 [DEV] Test OTP generated for ${normalizedPhone}: ${otpCode}`);

      success(res, {
        phone: normalizedPhone,
        purpose,
        otp: otpCode, // ⚠️ Only show in development!
        sessionId,
        expiresAt: expiresAt.toISOString(),
        expirationMinutes,
        environment: process.env.NODE_ENV,
        warning: 'This endpoint is only available in development/test environments'
      }, 'Test OTP generated successfully');

    } catch (err) {
      logger.error('Test OTP Generation Error:', err);
      error(res, 'Failed to generate test OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  });

  // ✅ Verify test OTP with detailed response
  router.post('/verify-test-otp', phoneOtpValidator, async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const { phone, otp } = req.body;
      const normalizedPhone = normalizePhone(phone);

      // Verify OTP using service
      const verificationResult = await OTPService.verifyOTP(normalizedPhone, otp);

      if (verificationResult.verified) {
        logger.info(`🧪 [DEV] Test OTP verified for ${normalizedPhone}`);
        
        success(res, {
          verified: true,
          phone: normalizedPhone,
          message: 'Test OTP verified successfully',
          details: {
            sessionId: verificationResult.sessionId,
            purpose: verificationResult.purpose,
            verifiedAt: new Date().toISOString(),
            environment: process.env.NODE_ENV
          },
          warning: 'Development verification only'
        }, 'Test OTP verification successful');

      } else {
        logger.warn(`🧪 [DEV] Test OTP verification failed for ${normalizedPhone}: ${verificationResult.error}`);
        
        error(res, verificationResult.error || 'Invalid or expired OTP', HTTP_STATUS.BAD_REQUEST, {
          verified: false,
          phone: normalizedPhone,
          attempts: verificationResult.attempts,
          environment: process.env.NODE_ENV
        });
      }

    } catch (err) {
      logger.error('Test OTP Verification Error:', err);
      error(res, 'Failed to verify test OTP', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  });

  // ✅ Clear OTP data for testing
  router.post('/clear-phone-otps', phoneValidator, async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const { phone } = req.body;
      const normalizedPhone = normalizePhone(phone);

      const result = await prisma.$queryRawUnsafe(`
        DELETE FROM otp_codes 
        WHERE phone = $1
      `, [normalizedPhone]);

      logger.info(`🧪 [DEV] Cleared ${result.length} OTP records for ${normalizedPhone}`);

      success(res, {
        phone: normalizedPhone,
        deletedCount: result.length,
        clearedAt: new Date().toISOString(),
        warning: 'Development cleanup only'
      }, `Cleared ${result.length} OTP records`);

    } catch (err) {
      logger.error('OTP Clear Error:', err);
      error(res, 'Failed to clear OTP records', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  });

  // ✅ Get OTP details by phone (POST endpoint)
  router.post('/get-phone-otps', phoneValidator, async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const { phone } = req.body;
      const normalizedPhone = normalizePhone(phone);

      const otps = await prisma.$queryRawUnsafe(`
        SELECT id, otp_code, purpose, expires_at, verified, created_at, attempts
        FROM otp_codes 
        WHERE phone = $1 
        ORDER BY created_at DESC 
        LIMIT 10
      `, [normalizedPhone]);

      success(res, {
        phone: normalizedPhone,
        otps: otps.rows.map(otp => ({
          ...otp,
          otp_code: '***' + otp.otp_code.slice(-3), // Mask for security
          is_expired: new Date(otp.expires_at) <= new Date(),
          age_minutes: Math.round((Date.now() - new Date(otp.created_at)) / 60000)
        })),
        warning: 'Development data only - OTP codes are masked'
      }, 'OTP history retrieved');

    } catch (err) {
      logger.error('OTP Phone Lookup Error:', err);
      error(res, 'Failed to retrieve OTP history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  });

  // ✅ Clear all test OTP data
  router.delete('/clear-all-test-data', async (req, res) => {
    try {
      // Only clear test/development OTP data
      const result = await prisma.$queryRawUnsafe(`
        DELETE FROM otp_codes 
        WHERE purpose IN ('test', 'development', 'debug')
        OR created_at < NOW() - INTERVAL '24 hours'
      `);

      logger.warn(`🧪 [DEV] Cleared ${result.length} test OTP records`);

      success(res, {
        deletedCount: result.length,
        clearedAt: new Date().toISOString(),
        warning: 'Cleared test and expired OTP data only'
      }, `Cleared ${result.length} test OTP records`);

    } catch (err) {
      logger.error('OTP Test Data Clear Error:', err);
      error(res, 'Failed to clear test OTP data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  });

  logger.info('✅ OTP development routes loaded successfully');

} else {
  // ✅ Production safety - add stub route that explains why dev routes aren't available
  router.all('*', (req, res) => {
    res.status(HTTP_STATUS.NOT_FOUND).json({
      success: false,
      message: 'OTP development routes are not available in production environment',
      environment: process.env.NODE_ENV,
      availableIn: ['development', 'test']
    });
  });

  logger.info('ℹ️ OTP development routes disabled (production mode)');
}

export default router;