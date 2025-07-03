// routes/infrastructure/debugRoutes.js
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as debugController from '../../controllers/infrastructure/debugController.js';
import { loadTestValidator, logQueryValidator } from '../../validators/infrastructure/debugValidator.js';

const router = express.Router();

// Debug routes with RBAC protection (Admin only)
wrapAutoRBAC(
  router,
  'debugRoutes',
  {
    get: [
      // 🏓 Basic Ping Test
      [
        '/ping',
        (req, res) => {
          const { success } = require('../../utils/responseHelper.js');
          success(res, { 
            message: 'Debug route is operational',
            timestamp: new Date().toISOString(),
            requestId: req.headers['x-request-id'] || 'unknown',
            user: req.user?.name || 'Unknown',
            userRole: req.user?.role || 'Unknown'
          }, 'Ping successful');
        }
      ],
      
      // 🔍 Debug info
      ['/debug', debugController.getDebugInfo],
      ['/info', debugController.getDebugInfo],
      
      // 💻 System Information
      ['/system', debugController.getSystemInfo],
      
      // 🔍 Database Connection Test
      ['/db-test', debugController.testDatabase],
      
      // 🔥 Trigger Sentry Error (Testing)
      ['/debug-sentry', debugController.triggerSentryError],
      
      // 📊 Application Health Check
      ['/health', debugController.getHealth],
      
      // 🔧 Environment Variables (Sanitized)
      ['/env', debugController.getEnvironment],
      
      // 📝 Application Logs (Recent)
      ['/logs', logQueryValidator, debugController.getLogs],
      
      // 🔍 Request Headers Debug
      ['/headers', debugController.getHeaders],
      
      // ⚡ Performance Metrics
      ['/performance', debugController.getPerformance]
    ],
    
    post: [
      // 🔧 Trigger Garbage Collection
      ['/gc', debugController.triggerGC],
      
      // 🔄 Simulate Load Test
      ['/load-test', loadTestValidator, debugController.runLoadTest]
    ]
  },
  {
    requireUID: true,
    requirePhone: false,
    auditLog: true,
    rateLimiting: true,
    roles: ['ADMIN']
  }
);

export default router;