// src/controllers/auth/otpController.js - OTP Controller
// NOTE: This controller is NOT for patient OTP (patients use Firebase)
// This is for: admin override, testing, special OTP needs

import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as otpService from '../../services/auth/otpService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';

// Request OTP (stores in database, doesn't send SMS)
export const requestOtp = async (req, res) => {
  try {
    const { phone, purpose = 'general', user_id } = req.body;
    
    const result = await otpService.requestOtp(phone, purpose, user_id, req);
    
    success(res, result, `OTP sent successfully for ${purpose}`);
  } catch (err) {
    logger.error('OTP Request Error:', err);
    
    if (err.statusCode === HTTP_STATUS.TOO_MANY_REQUESTS) {
      return error(res, err.message, HTTP_STATUS.TOO_MANY_REQUESTS);
    }
    
    error(res, 'Failed to send OTP. Please try again.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Verify OTP
export const verifyOtp = async (req, res) => {
  try {
    const { phone, otp, purpose = 'general' } = req.body;
    
    const result = await otpService.verifyOtp(phone, otp, purpose, req);
    
    if (!result.valid) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: result.reason,
        attemptsLeft: result.attemptsLeft
      });
    }
    
    // Log audit for successful verification
    await logAudit(req, 'otp-verified', {
      phone,
      purpose,
      sessionId: result.sessionId
    });
    
    success(res, result, 'OTP verified successfully');
  } catch (err) {
    logger.error('OTP Verification Error:', err);
    error(res, 'OTP verification failed. Please try again.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get OTP service health
export const getHealthStatus = async (req, res) => {
  try {
    const healthData = await otpService.getHealthStatus();
    success(res, healthData, 'OTP service is healthy');
  } catch (err) {
    logger.error('OTP Health Check Error:', err);
    success(res, {
      status: 'degraded',
      message: 'OTP service temporarily unavailable',
      timestamp: new Date().toISOString()
    }, 'OTP service status check');
  }
};