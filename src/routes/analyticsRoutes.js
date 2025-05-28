import express from 'express';
import * as analyticsController from '../controllers/analyticsController.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

wrapAutoRBAC(router, 'analyticsRoutes', {
  get: [
    ['/registrations', analyticsController.getUserRegistrations],
    ['/counts', analyticsController.getEntityCounts],
    ['/active-users', analyticsController.getActiveUsers],
    ['/active-departments', analyticsController.getActiveDepartments],
  ],
});

export default router;
