// routes/infrastructure/rbacRoutes.js
import express from 'express';
import { wrapAsync, wrapAutoRBAC, wrapRoutes } from '../../config/routeWrapper.js';
import * as rbacController from '../../controllers/infrastructure/rbacController.js';
import authenticatedTenantContext from '../../middleware/authenticatedTenantContext.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
import { ADMIN } from '../../utils/roles.js';
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

const router = express.Router();

// CAN-004: infrastructure routes mount before the app-level tenant middleware,
// so the RBAC user/analytics/audit/export reads below otherwise ran with no
// tenant context and could span tenants. Once a request is authenticated (the
// production infra-admin gate at the mount, or a route's own jwtAuth, populates
// req.user), resolve the tenant and seed RLS so those queries are tenant-scoped.
// Unauthenticated public routes (e.g. /public/roles) skip this unchanged.
router.use(authenticatedTenantContext);

// Canonical role policy graph for authenticated Staff/Admin consumers.
// Infrastructure routes are mounted before the app-level jwtAuth middleware,
// so this route must authenticate itself while staying outside HR/Admin RBAC.
router.get('/policy', jwtAuth, wrapAsync(rbacController.getPolicy));

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
      ['/analytics', rbacAnalyticsQueryValidator, rbacController.getRBACAnalytics]
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
