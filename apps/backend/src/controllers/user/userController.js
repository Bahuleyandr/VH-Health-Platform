// src/controllers/user/userController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { UserService } from '../../services/user/userService.js';
import { success, error } from '../../utils/responseHelper.js';

export class UserController {
  // Create or update user profile
  static async createOrUpdateProfile(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const result = await UserService.createOrUpdateProfile(
        req.body,
        req.user?.uid || 'system'
      );
      
      success(res, {
        user: result.user,
        isNew: result.isNew
      }, result.isNew ? 'User created successfully' : 'User updated successfully');
      
    } catch (err) {
      logger.error('Create/Update Profile Controller Error:', err);
      error(res, 'Failed to process user profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // List users with advanced filtering
  static async listUsers(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const result = await UserService.listUsers(req.query, req.user?.role);
      
      success(res, result, 'Users retrieved successfully');
      
    } catch (err) {
      logger.error('List Users Controller Error:', err);
      error(res, 'Failed to retrieve users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Get the currently-authenticated user's own profile. Distinct from
  // `getUserById('me')` which would slam 'me' into a UUID cast and 500.
  // See finding 2026-05-08-pediatric-opd-patient-users-me-500.
  static async getMe(req, res) {
    try {
      // Prefer uid for a UUID lookup; fall back to numeric id when the
      // token only carries an int (rare, but happens for legacy sessions).
      const identifier = req.user?.uid || (req.user?.id != null ? String(req.user.id) : null);
      if (!identifier) {
        return error(res, 'Authenticated user has no uid or id', HTTP_STATUS.UNAUTHORIZED);
      }
      const user = await UserService.getUserById(identifier, req.user?.role);
      if (!user) {
        return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
      }
      success(res, { user }, 'User retrieved successfully');
    } catch (err) {
      logger.error('Get Me Controller Error:', err);
      error(res, 'Failed to retrieve user', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  // Get user by ID/UID
  static async getUserById(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const user = await UserService.getUserById(req.params.identifier, req.user?.role);
      
      if (!user) {
        return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
      }
      
      success(res, { user }, 'User retrieved successfully');
      
    } catch (err) {
      logger.error('Get User By ID Controller Error:', err);
      error(res, 'Failed to retrieve user', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Get users by role
  static async getUsersByRole(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const result = await UserService.getUsersByRole(req.params.role, req.query);
      
      success(res, result, 'Users retrieved successfully');
      
    } catch (err) {
      logger.error('Get Users By Role Controller Error:', err);
      error(res, 'Failed to retrieve users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Get users by department
  static async getUsersByDepartment(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const result = await UserService.getUsersByDepartment(req.params.department, req.query);
      
      success(res, result, 'Users retrieved successfully');
      
    } catch (err) {
      logger.error('Get Users By Department Controller Error:', err);
      error(res, 'Failed to retrieve users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Search users with advanced filters
  static async searchUsers(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const result = await UserService.searchUsers(req.query, req.user?.role);
      
      success(res, result, 'User search completed successfully');
      
    } catch (err) {
      logger.error('Search Users Controller Error:', err);
      error(res, 'Failed to search users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Update user
  static async updateUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const user = await UserService.updateUser(
        req.params.identifier,
        req.body,
        req.user?.uid
      );
      
      success(res, { user }, 'User updated successfully');
      
    } catch (err) {
      logger.error('Update User Controller Error:', err);
      error(res, 'Failed to update user', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Change user status
  static async changeUserStatus(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const result = await UserService.changeUserStatus(
        req.params.identifier,
        req.body.status,
        req.body.reason,
        req.user?.uid
      );
      
      success(res, result, 'User status updated successfully');
      
    } catch (err) {
      logger.error('Change User Status Controller Error:', err);
      error(res, 'Failed to change user status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Deactivate user
  static async deactivateUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const result = await UserService.deactivateUser(
        req.params.identifier,
        req.body.reason,
        req.user?.uid
      );
      
      success(res, result, 'User deactivated successfully');
      
    } catch (err) {
      logger.error('Deactivate User Controller Error:', err);
      error(res, 'Failed to deactivate user', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
  
  // Bulk import users
  static async bulkImportUsers(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }
      
      const result = await UserService.bulkImportUsers(
        req.body.users,
        req.user?.uid
      );
      
      success(res, result, 'Bulk import completed');
      
    } catch (err) {
      logger.error('Bulk Import Users Controller Error:', err);
      error(res, 'Failed to import users', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
}