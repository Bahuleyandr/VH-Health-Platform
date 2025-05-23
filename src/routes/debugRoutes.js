// src/routes/debugRoutes.js

import express from 'express';
import { success } from '../utils/responseHelper.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as debugController from '../controllers/debugController.js';

const router = express.Router();

/**
 * ✅ Debug Routes
 * RBAC-protected using config key: debugRoutes
 */
wrapAutoRBAC(router, 'debugRoutes', {
  get: [
    ['/ping', (req, res) => {
      success(res, { message: 'Debug route is operational' }, 'Ping successful');
    }],
    ['/debug', debugController.getDebugInfo],
    ['/debug-sentry', (req, res, next) => {
      try {
        throw new Error('Sentry debug trigger: My first Sentry error!');
      } catch (err) {
        next(err); // Will be caught by centralized error handler
      }
    }]
  ]
});

export default router;
