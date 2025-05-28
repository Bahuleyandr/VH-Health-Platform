// src/routes/departmentRoutes.js

import express from 'express';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as departmentController from '../controllers/departmentController.js';

const router = express.Router();

/**
 * ✅ Department Routes (RBAC-controlled via `departmentRoutes`)
 * Includes:
 *  - All departments
 *  - Departments with doctors
 *  - Single department by ID
 */
wrapAutoRBAC(router, 'departmentRoutes', {
  get: [
    ['/', departmentController.getAllDepartments],
    [
      '/departments-with-doctors',
      departmentController.getDepartmentsWithDoctors,
    ],
    ['/:departmentId', departmentController.getDepartmentById],
  ],
  post: [['/', departmentController.addDepartment]],
  delete: [['/:departmentId', departmentController.deleteDepartment]],
});

export default router;
