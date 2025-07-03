// src/controllers/user/adminUserController.js
import { validationResult } from 'express-validator';
import { AdminUserService } from '../../services/user/adminUserService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';

export class AdminUserController {
  // Get user analytics
  static async getUserAnalytics(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const analytics = await AdminUserService.getUserAnalytics(req.query.timeframe);
      
      success(res, analytics, 'User analytics retrieved successfully');
      
    } catch (err) {
      logger.error('Get User Analytics Controller Error:', err);
      error(res, err.message || 'Failed to retrieve analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Get activity audit
  static async getActivityAudit(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const audit = await AdminUserService.getActivityAudit(req.query);
      
      success(res, audit, 'Activity audit retrieved successfully');
      
    } catch (err) {
      logger.error('Get Activity Audit Controller Error:', err);
      error(res, err.message || 'Failed to retrieve audit logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Get inactive users report
  static async getInactiveUsersReport(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const report = await AdminUserService.getInactiveUsersReport(req.query.inactiveDays);
      
      success(res, report, 'Inactive users report generated successfully');
      
    } catch (err) {
      logger.error('Get Inactive Users Report Controller Error:', err);
      error(res, err.message || 'Failed to generate report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Reactivate user
  static async reactivateUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const user = await AdminUserService.reactivateUser(
        req.params.userId,
        req.user?.uid
      );
      
      success(res, { user }, 'User reactivated successfully');
      
    } catch (err) {
      logger.error('Reactivate User Controller Error:', err);
      error(res, err.message || 'Failed to reactivate user', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Generate report
  static async generateReport(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const report = await AdminUserService.generateReport(
        req.body.reportType,
        { ...req.body.filters, generatedBy: req.user?.uid }
      );
      
      success(res, report, 'Report generated successfully');
      
    } catch (err) {
      logger.error('Generate Report Controller Error:', err);
      error(res, err.message || 'Failed to generate report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Get system info
  static async getSystemInfo(req, res) {
    try {
      const systemInfo = await AdminUserService.getSystemInfo();
      
      success(res, systemInfo, 'System information retrieved successfully');
      
    } catch (err) {
      logger.error('Get System Info Controller Error:', err);
      error(res, err.message || 'Failed to retrieve system information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Get admin dashboard
  static async getDashboard(req, res) {
    try {
      const dashboard = await AdminUserService.getDashboardData(req.user?.uid);
      
      success(res, dashboard, 'Dashboard data retrieved successfully');
      
    } catch (err) {
      logger.error('Get Dashboard Controller Error:', err);
      error(res, err.message || 'Failed to retrieve dashboard data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
}