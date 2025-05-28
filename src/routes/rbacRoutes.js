import express from 'express';
import * as rbacController from '../controllers/rbacController.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

wrapAutoRBAC(router, 'rbacRoutes', {
  get: [
    ['/roles', rbacController.getAllRoles],
    ['/users', rbacController.getUsersByRole],
  ],
  post: [['/assign-role', rbacController.assignUserRole]],
});

export default router;
