// src/controllers/health/systemHealthController.js
import * as systemHealthService from '../../services/health/systemHealthService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HEALTH_MESSAGES } from '../../config/healthConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';

export async function getBasicHealth(req, res) {
  success(res, { message: HEALTH_MESSAGES.SERVICE_RUNNING }, 'Service reachable');
}

export async function getComprehensiveHealth(req, res) {
  try {
    const dbHealth = await systemHealthService.checkDatabaseHealth();
    const envCheck = systemHealthService.checkEnvironmentVariables();
    
    if (envCheck.missing.length > 0) {
      return error(res, `${HEALTH_MESSAGES.MISSING_ENV}: ${envCheck.missing.join(', ')}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
    
    if (dbHealth.status === 'disconnected') {
      return error(res, HEALTH_MESSAGES.HEALTH_CHECK_FAILED, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
    
    success(res, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        database: dbHealth.status,
        environment: envCheck.status
      }
    }, HEALTH_MESSAGES.HEALTH_CHECK_PASSED);
  } catch (err) {
    logger.error('Health check error:', err.stack || err.toString());
    error(res, HEALTH_MESSAGES.HEALTH_CHECK_FAILED, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getAppVersion(req, res) {
  const versionInfo = systemHealthService.getAppVersion();
  success(res, versionInfo, 'App version fetched successfully');
}

export async function getSystemStatus(req, res) {
  try {
    const systemStatus = systemHealthService.getSystemStatus();
    success(res, systemStatus, 'System health check successful');
  } catch (err) {
    logger.error('System status error:', err);
    res.status(500).json({
      success: false,
      message: 'System health check failed',
      status: 'unhealthy',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
}