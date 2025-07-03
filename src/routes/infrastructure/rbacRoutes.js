// routes/infrastructure/rbacRoutes.js
import express from 'express';
import { wrapAutoRBAC, wrapRoutes } from '../../config/routeWrapper.js';
import * as rbacController from '../../controllers/infrastructure/rbacController.js';
import { 
  roleAssignmentValidator,
  bulkAssignmentValidator,
  toggleUserStatusValidator,
  massRoleUpdateValidator,
  auditLogQueryValidator,
  usersQueryValidator,
  rbacAnalyticsQueryValidator,
  migrationReportQueryValidator
} from '../../validators/infrastructure/rbacValidator.js';
import { ADMIN } from '../../utils/roles.js';

const router = express.Router();

// PUBLIC INFO ROUTES (No authentication required)
wrapRoutes(
  router,
  [], // No roles = public access
  {
    get: [
      ['/public/roles', rbacController.getPublicRoles]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true
  }
);

// BASIC RBAC ROUTES (HR_STAFF, ADMIN)
wrapAutoRBAC(
  router, 
  'rbacRoutes',
  {
    get: [
      // 📋 Get All Available Roles with Details
      ['/roles', rbacController.getRoles],
      
      // 👥 Get Users Grouped by Role
      ['/users', usersQueryValidator, rbacController.getUsersByRole],
      
      // 🔍 Role Permissions Matrix
      ['/permissions', rbacController.getPermissions],
      
      // 📊 Role Statistics and Analytics
      ['/analytics', rbacAnalyticsQueryValidator, rbacController.getAnalytics]
    ],
    
    post: [
      // 👤 Assign Role to User
      ['/assign-role', roleAssignmentValidator, rbacController.assignRole],
      
      // 🔄 Bulk Role Assignment
      ['/bulk-assign', bulkAssignmentValidator, rbacController.bulkAssignRoles]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

// ADMIN ONLY ROUTES
wrapRoutes(
  router,
  [ADMIN],
  {
    get: [
      // 🔍 Comprehensive Role Audit Log
      ['/admin/audit-log', auditLogQueryValidator, rbacController.getAuditLog],
      
      // 🚨 Security Alerts for Role Changes
      ['/admin/security-alerts', rbacController.getSecurityAlerts],
      
      // 📈 Role Migration Report
      ['/admin/migration-report', migrationReportQueryValidator, rbacController.getMigrationReport],
      
      // 📊 Export RBAC Data
      ['/admin/export', rbacController.exportRBACData]
    ],
    
    post: [
      // 🔒 Lock/Unlock User Account
      ['/admin/toggle-user-status', toggleUserStatusValidator, rbacController.toggleUserStatus],
      
      // 🔄 Mass Role Update
      ['/admin/mass-role-update', massRoleUpdateValidator, rbacController.massRoleUpdate]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

// SELF-SERVICE ROUTES (All authenticated users)
wrapRoutes(
  router,
  [], // Any authenticated user
  {
    get: [
      // 📋 Get My Role Information
      ['/my-role', rbacController.getMyRole],
      
      // 🔍 Check My Permissions
      ['/my-permissions', rbacController.getMyPermissions]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

export default router;