// src/controllers/user/lookupController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { LookupService } from '../../services/user/lookupService.js';
import { success, error } from '../../utils/responseHelper.js';

export class LookupController {
  // Basic user lookup
  static async lookupUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const users = await LookupService.lookupUser(
        req.query,
        req.user?.role,
        req.user?.uid
      );
      
      success(res, {
        users,
        totalFound: users.length,
        searchCriteria: req.query,
        accessLevel: req.user?.role,
        requestedBy: req.user?.uid
      }, users.length > 0 ? `Found ${users.length} matching user(s)` : 'No matching users found');
      
    } catch (err) {
      logger.error('Lookup User Controller Error:', err);
      
      if (err.message.includes('rate limit')) {
        return error(res, err.message, HTTP_STATUS.TOO_MANY_REQUESTS);
      }
      
      error(res, 'User lookup failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Quick user verification
  static async verifyUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const result = await LookupService.verifyUser(
        req.query,
        req.user?.role,
        req.user?.uid
      );
      
      success(res, {
        ...result,
        searchedBy: req.query.phone ? 'phone' : 'uid',
        requestedBy: req.user?.uid
      }, result.verified ? 'User verified successfully' : 'User not found');
      
    } catch (err) {
      logger.error('Verify User Controller Error:', err);
      error(res, 'User verification failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Get user statistics
  static async getUserStats(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const stats = await LookupService.getUserStatistics(
        req.query.detailed === 'true',
        req.user?.role
      );
      
      success(res, {
        ...stats,
        accessLevel: req.user?.role,
        generatedAt: new Date().toISOString(),
        requestedBy: req.user?.uid
      }, 'User statistics retrieved successfully');
      
    } catch (err) {
      logger.error('Get User Stats Controller Error:', err);
      error(res, err.message || 'Failed to fetch user statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Get recent activity
  static async getRecentActivity(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const activity = await LookupService.getRecentActivity(
        req.query.days,
        req.query.limit
      );
      
      success(res, {
        recentActivity: activity,
        periodDays: parseInt(req.query.days || 7),
        totalRecords: activity.length,
        generatedBy: req.user?.uid,
        generatedAt: new Date().toISOString()
      }, 'Recent user activity retrieved');
      
    } catch (err) {
      logger.error('Get Recent Activity Controller Error:', err);
      error(res, err.message || 'Failed to fetch user activity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Bulk search
  static async bulkSearch(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const users = await LookupService.bulkSearch(
        req.body.criteria,
        req.body.options
      );
      
      success(res, {
        users,
        totalFound: users.length,
        searchCriteria: req.body.criteria,
        searchOptions: req.body.options,
        executedBy: req.user?.uid,
        executedAt: new Date().toISOString()
      }, 'Bulk user search completed');
      
    } catch (err) {
      logger.error('Bulk Search Controller Error:', err);
      error(res, err.message || 'Bulk search operation failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
}