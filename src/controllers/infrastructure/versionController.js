// controllers/infrastructure/versionController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { VersionService } from '../../services/infrastructure/versionService.js';
import { success, error } from '../../utils/responseHelper.js';

// Get version information (Public)
export const getVersion = async (req, res) => {
  try {
    const versionInfo = VersionService.getVersionInfo();
    success(res, versionInfo, 'Version information retrieved successfully');
  } catch (err) {
    logger.error('[GetVersion]:', err);
    error(res, 'Failed to retrieve version information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get API capabilities (Public)
export const getCapabilities = async (req, res) => {
  try {
    const capabilities = VersionService.getCapabilities();
    success(res, capabilities, 'API capabilities retrieved successfully');
  } catch (err) {
    logger.error('[GetCapabilities]:', err);
    error(res, 'Failed to retrieve API capabilities', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get health status (Public)
export const getHealthStatus = async (req, res) => {
  try {
    const healthStatus = await VersionService.getHealthStatus();
    
    const statusCode = healthStatus.status === 'healthy' ? HTTP_STATUS.OK : 503;
    res.status(statusCode).json({
      success: healthStatus.status === 'healthy',
      message: `System ${healthStatus.status}`,
      data: healthStatus
    });
  } catch (err) {
    logger.error('[GetHealthStatus]:', err);
    error(res, 'Health check failed', 503);
  }
};

// Get system information (Staff/Admin)
export const getVersionSystemInfo = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid || 'unknown',
      role: req.user?.role,
      ipAddress: req.headers['x-forwarded-for'] || req.connection?.remoteAddress
    };
    
    const systemInfo = await VersionService.getSystemInfo(userInfo);
    
    logger.info(`[System Info] Accessed by ${userInfo.role} user: ${userInfo.uid}`);
    success(res, systemInfo, 'System information retrieved successfully');
  } catch (err) {
    logger.error('[GetSystemInfo]:', err);
    error(res, 'Failed to retrieve system information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get API catalog (Staff/Admin)
export const getAPICatalog = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid,
      role: req.user?.role
    };
    
    const apiCatalog = VersionService.getAPICatalog(userInfo);
    
    logger.info(`[API Catalog] Accessed by ${userInfo.role} user: ${userInfo.uid}`);
    success(res, apiCatalog, 'API catalog retrieved successfully');
  } catch (err) {
    logger.error('[GetAPICatalog]:', err);
    error(res, 'Failed to retrieve API catalog', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get database schema information (Staff/Admin)
export const getSchemaInfo = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid,
      role: req.user?.role
    };
    
    const schemaInfo = await VersionService.getSchemaInfo(userInfo);
    
    logger.info(`[Schema Info] Accessed by ${userInfo.role} user: ${userInfo.uid}`);
    success(res, schemaInfo, 'Database schema information retrieved successfully');
  } catch (err) {
    logger.error('[GetSchemaInfo]:', err);
    error(res, 'Failed to retrieve database schema information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get advanced diagnostics (Admin only)
export const getDiagnostics = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid,
      ipAddress: req.headers['x-forwarded-for'] || req.connection?.remoteAddress
    };
    
    const diagnostics = await VersionService.getDiagnostics(userInfo);
    
    logger.info(`[System Diagnostics] Accessed by admin: ${userInfo.uid}`);
    success(res, diagnostics, 'System diagnostics retrieved successfully');
  } catch (err) {
    logger.error('[GetDiagnostics]:', err);
    error(res, 'Failed to retrieve system diagnostics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get performance metrics (Admin only)
export const getMetrics = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const userInfo = {
      uid: req.user?.uid
    };
    
    const metrics = await VersionService.getPerformanceMetrics(userInfo);
    
    logger.info(`[System Metrics] Accessed by admin: ${userInfo.uid}`);
    success(res, metrics, 'Performance metrics retrieved successfully');
  } catch (err) {
    logger.error('[GetMetrics]:', err);
    error(res, 'Failed to retrieve performance metrics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get version history (Admin only)
export const getHistory = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const userInfo = {
      uid: req.user?.uid
    };
    
    const versionHistory = VersionService.getVersionHistory(userInfo);
    
    logger.info(`[Version History] Accessed by admin: ${userInfo.uid}`);
    success(res, versionHistory, 'Version history retrieved successfully');
  } catch (err) {
    logger.error('[GetHistory]:', err);
    error(res, 'Failed to retrieve version history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Check for updates (Admin only)
export const checkUpdates = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid
    };
    
    const updateCheck = await VersionService.checkForUpdates(userInfo);
    
    logger.info(`[Update Check] Triggered by admin: ${userInfo.uid}`);
    success(res, updateCheck, 'Update check completed successfully');
  } catch (err) {
    logger.error('[CheckUpdates]:', err);
    error(res, 'Failed to perform update check', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};