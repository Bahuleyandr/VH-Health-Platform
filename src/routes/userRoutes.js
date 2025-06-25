// src/routes/userRoutes.js - Modularized Hospital User Management Routes

import express from 'express';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';

// Import controllers
import * as userController from '../controllers/userController.js';
import * as adminController from '../controllers/adminUserController.js';

// Import validators
import {
  userValidation,
  searchValidation,
  userIdValidation,
  roleValidation,
  departmentValidation,
  userSearchValidation,
  statusChangeValidation,
  bulkImportValidation,
  userDeactivationValidation,
  reactivationValidation,
  analyticsValidation,
  activityAuditValidation,
  inactiveUsersValidation,
  reportGenerationValidation
} from '../validators/userValidators.js';

const router = express.Router();

// ✅ RBAC Protected User Routes
wrapAutoRBAC(router, 'userRoutes', {
  post: [
    // 👤 Create/Update User Profile
    [
      '/profile',
      ...userValidation,
      userController.createOrUpdateProfile
    ],

    // 👥 Bulk User Import (Admin/HR only)
    [
      '/bulk-import',
      bulkImportValidation,
      userController.bulkImportUsers
    ]
  ],

  get: [
    // 📋 List Users with Advanced Filtering
    [
      '/',
      ...searchValidation,
      userController.listUsers
    ],

    // 👤 Get User by ID/UID
    [
      '/:identifier',
      ...userIdValidation,
      userController.getUserById
    ],

    // 🏥 Get Users by Role
    [
      '/role/:role',
      roleValidation,
      userController.getUsersByRole
    ],

    // 🏢 Get Users by Department
    [
      '/department/:department',
      departmentValidation,
      userController.getUsersByDepartment
    ],

    // 🔍 Search Users with Advanced Filters
    [
      '/search',
      userSearchValidation,
      userController.searchUsers
    ]
  ],

  put: [
    // ✏️ Update User Profile
    [
      '/:identifier',
      ...userIdValidation.concat(userValidation),
      userController.updateUser
    ],

    // 🔄 Change User Status
    [
      '/:identifier/status',
      statusChangeValidation,
      userController.changeUserStatus
    ]
  ],

  delete: [
    // 🗑️ Deactivate User (Soft Delete)
    [
      '/:identifier',
      userDeactivationValidation,
      userController.deactivateUser
    ]
  ]
});

// ✅ Admin-Only Hospital User Management Routes
wrapRoutes(
  router,
  ['ADMIN'], // Admin only
  {
    get: [
      // 📊 Hospital User Analytics
      [
        '/admin/analytics',
        analyticsValidation,
        adminController.getUserAnalytics
      ],

      // 🔍 User Activity Audit
      [
        '/admin/activity-audit',
        activityAuditValidation,
        adminController.getActivityAudit
      ],

      // 👥 Inactive Users Report
      [
        '/admin/inactive-users',
        inactiveUsersValidation,
        adminController.getInactiveUsersReport
      ]
    ],

    post: [
      // 🔄 Reactivate User
      [
        '/admin/reactivate/:userId',
        reactivationValidation,
        adminController.reactivateUser
      ],

      // 📊 Generate User Report
      [
        '/admin/generate-report',
        reportGenerationValidation,
        adminController.generateReport
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

// ✅ System Information Route (Public)
wrapRoutes(
  router,
  [], // Public access
  {
    get: [
      [
        '/system-info',
        adminController.getSystemInfo
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;