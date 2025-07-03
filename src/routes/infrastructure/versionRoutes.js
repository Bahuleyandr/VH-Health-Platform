// routes/infrastructure/versionRoutes.js
import express from 'express';
import { wrapAutoRBAC, wrapRoutes } from '../../config/routeWrapper.js';
import * as versionController from '../../controllers/infrastructure/versionController.js';
import { 
  metricsQueryValidator, 
  historyQueryValidator 
} from '../../validators/infrastructure/versionValidator.js';

const router = express.Router();

// 🌐 PUBLIC VERSION ENDPOINTS (No Authentication Required)
wrapRoutes(
  router,
  [], // No roles required - public access
  {
    get: [
      // 📊 Basic Version Information (Public)
      ['/', versionController.getVersion],
      
      // 🏥 Public API Capabilities
      ['/capabilities', versionController.getCapabilities],
      
      // 📈 Public Health Status
      ['/health', versionController.getHealthStatus]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true,
    configKey: 'versionRoutes'
  }
);

// 🔐 PROTECTED SYSTEM INFORMATION (RBAC Required)
wrapAutoRBAC(
  router,
  'versionRoutes', // Maps to rbacConfig for staff/admin access
  {
    get: [
      // 🔍 Detailed System Information (Staff/Admin)
      ['/system', versionController.getSystemInfo],
      
      // 📋 Complete API Catalog (Staff/Admin)
      ['/api-catalog', versionController.getAPICatalog],
      
      // 📊 Database Schema Information (Staff/Admin)
      ['/schema', versionController.getSchemaInfo]
    ]
  },
  {
    requireUID: true,
    requirePhone: false,
    configKey: 'versionRoutes'
  }
);

// 🛡️ ADMIN-ONLY SYSTEM MANAGEMENT
wrapAutoRBAC(
  router,
  'adminRoutes', // Admin-only access
  {
    get: [
      // 🔧 Advanced System Diagnostics (Admin Only)
      ['/diagnostics', versionController.getDiagnostics],
      
      // 📈 Performance Metrics (Admin Only)
      ['/metrics', metricsQueryValidator, versionController.getMetrics],
      
      // 🔄 Version History (Admin Only)
      ['/history', historyQueryValidator, versionController.getHistory]
    ],
    
    post: [
      // 🔄 Trigger System Update Check (Admin Only)
      ['/update-check', versionController.checkUpdates]
    ]
  },
  {
    requireUID: true,
    requirePhone: false,
    configKey: 'adminRoutes'
  }
);

export default router;