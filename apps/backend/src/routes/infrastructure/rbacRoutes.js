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

// PUBLIC INFO ROUTES (No authentication required) — registered FIRST so the
// auth + tenant-context middleware below never applies to them.
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

// HEAD-004 / CAN-004: infrastructure routes mount before the app-level jwtAuth +
// tenant middleware, and the production infra-admin mount gate only enforces when
// NODE_ENV==='production'. So authenticate HERE — idempotently (skip if the mount
// gate already populated req.user) — and THEN seed the tenant/RLS context, for
// EVERY authenticated RBAC route below, regardless of environment. This makes the
// user/analytics/audit/export reads deterministically tenant-scoped rather than
// depending on the prod-only mount gate having run first.
router.use(
  (req, res, next) => (req.user ? next() : jwtAuth(req, res, next)),
  authenticatedTenantContext,
);

// Canonical role policy graph for authenticated Staff/Admin consumers
// (authenticated + tenant-scoped by the middleware above).
router.get('/policy', wrapAsync(rbacController.getPolicy));

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
