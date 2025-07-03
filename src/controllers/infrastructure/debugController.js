// controllers/infrastructure/debugController.js
import { validationResult } from 'express-validator';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { DebugService } from '../../services/infrastructure/debugService.js';
import logger from '../../logging/logger.js';

// Get debug information
export const getDebugInfo = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid,
      name: req.user?.name,
      role: req.user?.role
    };
    
    const debugInfo = await DebugService.getDebugInfo(userInfo);
    success(res, debugInfo, 'Debug information retrieved');
  } catch (err) {
    logger.error('[GetDebugInfo]:', err);
    error(res, 'Failed to retrieve debug information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Test database connection
export const testDatabase = async (req, res) => {
  try {
    const testResult = await DebugService.testDatabaseConnection();
    testResult.testedBy = req.user?.name;
    
    success(res, testResult, 'Database connection test successful');
  } catch (err) {
    logger.error('[TestDatabase]:', err);
    error(res, {
      connected: false,
      error: err.message,
      testedBy: req.user?.name
    }, 'Database connection failed');
  }
};

// Get application health
export const getHealth = async (req, res) => {
  try {
    const healthData = await DebugService.getApplicationHealth();
    healthData.checkedBy = req.user?.name;
    
    success(res, healthData, `Application health: ${healthData.status}`);
  } catch (err) {
    logger.error('[GetHealth]:', err);
    error(res, {
      status: 'unhealthy',
      error: err.message,
      checkedBy: req.user?.name
    }, 'Health check failed');
  }
};

// Get environment variables
export const getEnvironment = async (req, res) => {
  try {
    const envData = DebugService.getEnvironmentVariables();
    
    success(res, {
      ...envData,
      requestedBy: req.user?.name
    }, 'Environment variables retrieved (sanitized)');
  } catch (err) {
    logger.error('[GetEnvironment]:', err);
    error(res, 'Failed to retrieve environment variables', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get recent logs
export const getLogs = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { level = 'all', limit = 50 } = req.query;
    
    const logsData = await DebugService.getRecentLogs(level, limit);
    
    success(res, {
      ...logsData,
      requestedBy: req.user?.name
    }, 'Recent logs retrieved');
  } catch (err) {
    logger.error('[GetLogs]:', err);
    error(res, 'Failed to retrieve logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get request headers
export const getHeaders = async (req, res) => {
  try {
    const debugHeaders = {
      allHeaders: req.headers,
      userAgent: req.get('User-Agent'),
      authorization: req.get('Authorization') ? 'Bearer [REDACTED]' : 'None',
      contentType: req.get('Content-Type'),
      acceptLanguage: req.get('Accept-Language'),
      xForwardedFor: req.get('X-Forwarded-For'),
      xRealIp: req.get('X-Real-IP'),
      host: req.get('Host'),
      origin: req.get('Origin'),
      referer: req.get('Referer'),
      userInfo: {
        uid: req.user?.uid,
        role: req.user?.role,
        name: req.user?.name
      },
      requestInfo: {
        method: req.method,
        url: req.url,
        protocol: req.protocol,
        secure: req.secure,
        ip: req.ip,
        ips: req.ips
      }
    };
    
    success(res, debugHeaders, 'Request headers and user info retrieved');
  } catch (err) {
    logger.error('[GetHeaders]:', err);
    error(res, 'Failed to retrieve header information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get performance metrics
export const getPerformance = async (req, res) => {
  try {
    const metrics = await DebugService.getPerformanceMetrics();
    metrics.requestedBy = req.user?.name;
    
    success(res, metrics, 'Performance metrics retrieved');
  } catch (err) {
    logger.error('[GetPerformance]:', err);
    error(res, 'Failed to retrieve performance metrics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Trigger garbage collection
export const triggerGC = async (req, res) => {
  try {
    const gcResult = DebugService.triggerGarbageCollection();
    gcResult.triggeredBy = req.user?.name;
    
    const message = gcResult.triggered 
      ? 'Garbage collection triggered' 
      : 'Garbage collection not available';
      
    success(res, gcResult, message);
  } catch (err) {
    logger.error('[TriggerGC]:', err);
    error(res, 'Failed to trigger garbage collection', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Simulate load test
export const runLoadTest = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { iterations = 1000, delay = 1 } = req.body;
    
    logger.info(`🔄 Load test started by ${req.user?.name}: ${iterations} iterations`);
    
    const result = await DebugService.simulateLoadTest(iterations, delay);
    result.triggeredBy = req.user?.name;
    
    success(res, result, 'Load test completed');
  } catch (err) {
    logger.error('[RunLoadTest]:', err);
    error(res, 'Load test failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get system information
export const getSystemInfo = async (req, res) => {
  try {
    const systemInfo = await DebugService.getDebugInfo({
      uid: req.user?.uid,
      name: req.user?.name,
      role: req.user?.role
    });
    
    success(res, systemInfo, 'System information retrieved');
  } catch (err) {
    logger.error('[GetSystemInfo]:', err);
    error(res, 'Failed to retrieve system information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Trigger Sentry error for testing
export const triggerSentryError = async (req, res, next) => {
  try {
    logger.warn(`🔥 Sentry debug error triggered by ${req.user?.name || 'Unknown'}`);
    throw new Error(`Sentry debug trigger: Test error for monitoring! Triggered by ${req.user?.name || 'Unknown'}`);
  } catch (err) {
    next(err); // Will be caught by centralized error handler
  }
};