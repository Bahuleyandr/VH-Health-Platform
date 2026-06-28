// src/routes/department/index.js
import express from 'express';
import adminDepartmentRoutes from './adminDepartmentRoutes.js';
import departmentRoutes from './departmentRoutes.js';
import departmentStatsRoutes from './departmentStatsRoutes.js';

const router = express.Router();

// Mount sub-routes. RBAC is applied per sub-router, NOT here:
//   * adminDepartmentRoutes applies router.use(checkAdminPermission) (ADMIN/
//     SUPER_ADMIN) to every /admin route;
//   * departmentRoutes gates its write verbs inline (checkDepartmentPermission /
//     checkAdminPermission); its reads are the broad department directory.
// The previous `export default wrapAutoRBAC(router,'departmentRoutes',{},{...})`
// here was an inert no-op — the empty routeMap attaches nothing and the
// `roles:` key in the options arg is NOT honored by wrapAutoRBAC — so it applied
// NO RBAC and only made the file look protected. Removed; see the no-op-RBAC
// guard test. (/stats stays broadly readable as before — non-PHI department
// analytics.)
router.use('/', departmentRoutes);
router.use('/stats', departmentStatsRoutes);
router.use('/admin', adminDepartmentRoutes);

export default router;