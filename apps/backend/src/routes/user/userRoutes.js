// src/routes/user/userRoutes.js
import express from 'express';
import { UserController } from '../../controllers/user/userController.js';
import { sanitizeProfileFields } from '../../middleware/sanitizeMiddleware.js';
import {
  userValidation,
  userUpdateValidation,
  searchValidation,
  userIdValidation,
  roleValidation,
  departmentValidation,
  userSearchValidation,
  statusChangeValidation,
  bulkImportValidation,
  userDeactivationValidation
} from '../../validators/user/userValidator.js';

const router = express.Router();

// Create/Update User Profile
router.post('/profile', userValidation, sanitizeProfileFields, UserController.createOrUpdateProfile);

// Bulk User Import (Admin/HR only)
router.post('/bulk-import', bulkImportValidation, UserController.bulkImportUsers);

// List Users with Advanced Filtering
router.get('/', searchValidation, UserController.listUsers);

// Get User by ID/UID
router.get('/:identifier', userIdValidation, UserController.getUserById);

// Get Users by Role
router.get('/role/:role', roleValidation, UserController.getUsersByRole);

// Get Users by Department
router.get('/department/:department', departmentValidation, UserController.getUsersByDepartment);

// Search Users with Advanced Filters
router.get('/search', userSearchValidation, UserController.searchUsers);

// Update User Profile
router.put('/:identifier', [...userIdValidation, ...userUpdateValidation], sanitizeProfileFields, UserController.updateUser);

// Change User Status
router.put('/:identifier/status', statusChangeValidation, UserController.changeUserStatus);

// Deactivate User (Soft Delete)
router.delete('/:identifier', userDeactivationValidation, UserController.deactivateUser);

export default router;
