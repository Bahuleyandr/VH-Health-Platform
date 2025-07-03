// src/utils/auth/otpHelpers.js - OTP Helper Functions

import { OTP_CONFIG } from '../../config/otpConfig.js';
import logger from '../../logging/logger.js';

// Calculate OTP expiry time
export const calculateOtpExpiry = () => {
  return new Date(Date.now() + (OTP_CONFIG.expirationMinutes * 60 * 1000));
};

// Check if OTP is expired
export const isOtpExpired = (expiryTime) => {
  return new Date() > new Date(expiryTime);
};

// Format OTP session response
export const formatOtpSessionResponse = (session) => {
  const now = new Date();
  const expiresAt = new Date(session.expires_at);
  const remainingSeconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  
  return {
    sessionId: session.id,
    phone: session.phone,
    purpose: session.purpose,
    attemptsUsed: session.attempts,
    attemptsRemaining: Math.max(0, OTP_CONFIG.maxAttempts - session.attempts),
    expiresInSeconds: remainingSeconds,
    createdAt: session.created_at
  };
};

// Validate OTP format
export const validateOtpFormat = (otp) => {
  const otpRegex = new RegExp(`^\\d{${OTP_CONFIG.length}}$`);
  return otpRegex.test(otp);
};

// Generate OTP statistics
export const generateOtpStatistics = (logs) => {
  const stats = {
    totalRequests: 0,
    successfulVerifications: 0,
    failedVerifications: 0,
    averageAttemptsToVerify: 0,
    mostCommonFailureReason: null,
    peakHour: null
  };
  
  if (!logs || logs.length === 0) {
    return stats;
  }
  
  // Calculate statistics
  const requestLogs = logs.filter(log => log.action === 'request');
  const verifyLogs = logs.filter(log => log.action === 'verify');
  
  stats.totalRequests = requestLogs.length;
  stats.successfulVerifications = verifyLogs.filter(log => log.success).length;
  stats.failedVerifications = verifyLogs.filter(log => !log.success).length;
  
  // Calculate average attempts
  if (stats.successfulVerifications > 0) {
    const totalAttempts = verifyLogs
      .filter(log => log.success)
      .reduce((sum, log) => sum + (log.attempts || 1), 0);
    stats.averageAttemptsToVerify = totalAttempts / stats.successfulVerifications;
  }
  
  // Find most common failure reason
  const failureReasons = verifyLogs
    .filter(log => !log.success && log.failure_reason)
    .reduce((acc, log) => {
      acc[log.failure_reason] = (acc[log.failure_reason] || 0) + 1;
      return acc;
    }, {});
  
  if (Object.keys(failureReasons).length > 0) {
    stats.mostCommonFailureReason = Object.entries(failureReasons)
      .sort(([, a], [, b]) => b - a)[0][0];
  }
  
  // Find peak hour
  const hourCounts = logs.reduce((acc, log) => {
    const hour = new Date(log.created_at).getHours();
    acc[hour] = (acc[hour] || 0) + 1;
    return acc;
  }, {});
  
  if (Object.keys(hourCounts).length > 0) {
    const peakHourEntry = Object.entries(hourCounts)
      .sort(([, a], [, b]) => b - a)[0];
    stats.peakHour = parseInt(peakHourEntry[0]);
  }
  
  return stats;
};

// Check if phone number is suspicious
export const isPhoneSuspicious = (phone, recentActivity) => {
  const suspiciousThresholds = {
    requestsPerHour: 10,
    failedAttemptsPerHour: 5,
    differentIpsPerHour: 3
  };
  
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentLogs = recentActivity.filter(log => 
    log.phone === phone && new Date(log.created_at) > hourAgo
  );
  
  if (recentLogs.length >= suspiciousThresholds.requestsPerHour) {
    return { suspicious: true, reason: 'Too many requests' };
  }
  
  const failedAttempts = recentLogs.filter(log => 
    log.action === 'verify' && !log.success
  ).length;
  
  if (failedAttempts >= suspiciousThresholds.failedAttemptsPerHour) {
    return { suspicious: true, reason: 'Too many failed attempts' };
  }
  
  const uniqueIps = new Set(recentLogs.map(log => log.ip_address)).size;
  
  if (uniqueIps >= suspiciousThresholds.differentIpsPerHour) {
    return { suspicious: true, reason: 'Multiple IP addresses' };
  }
  
  return { suspicious: false };
};

// Format OTP for display (partial masking)
export const maskOtp = (otp) => {
  if (!otp || otp.length < 4) return '******';
  return otp.substring(0, 2) + '****';
};