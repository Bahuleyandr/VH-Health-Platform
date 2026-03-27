// src/routes/sosRoutes.js - Simplified route definitions
import express from 'express';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as sosController from '../controllers/sosController.js';
import { sosRateLimiter } from '../middleware/rateLimitMiddleware.js';
import { sanitizeSosFields } from '../middleware/sanitizeMiddleware.js';
import * as sosValidators from '../validators/sosValidators.js';

const router = express.Router();

// Patient SOS Routes
wrapAutoRBAC(router, 'sosRoutes', {
  post: [
    ['/', sosRateLimiter, sosValidators.createAlert, sanitizeSosFields, sosController.createEmergencyAlert],
    ['/emergency-contact', sosValidators.updateEmergencyContact, sosController.updateEmergencyContact],
    ['/cancel/:alertId', sosValidators.cancelAlert, sosController.cancelAlert]
  ],
  get: [
    ['/my-alerts', sosValidators.getMyAlerts, sosController.getMyAlerts],
    ['/nearby-services', sosValidators.getNearbyServices, sosController.getNearbyServices],
    ['/medical-info', sosController.getMedicalInfo]
  ]
});

// Emergency Responder Routes
wrapAutoRBAC(router, 'emergencyResponderRoutes', {
  get: [
    ['/responder/dashboard', sosController.getResponderDashboard],
    ['/responder/analytics', sosValidators.getAnalytics, sosController.getResponderAnalytics]
  ],
  post: [
    ['/responder/respond/:alertId', sosValidators.respondToAlert, sosController.respondToAlert],
    ['/responder/resolve/:alertId', sosValidators.resolveAlert, sosController.resolveAlert]
  ]
});

// Admin Routes
wrapAutoRBAC(router, 'adminSosRoutes', {
  get: [
    ['/admin/analytics', sosValidators.getAdminAnalytics, sosController.getAdminAnalytics],
    ['/admin/alerts', sosValidators.getAdminAlerts, sosController.getAllAlerts],
    ['/admin/emergency-services', sosController.getEmergencyServices],
    ['/admin/performance-report', sosValidators.getPerformanceReport, sosController.getPerformanceReport]
  ],
  post: [
    ['/admin/update-config', sosValidators.updateConfig, sosController.updateSystemConfig],
    ['/admin/broadcast-alert', sosValidators.broadcastAlert, sosController.broadcastEmergencyAlert],
    ['/admin/escalate/:alertId', sosValidators.escalateAlert, sosController.escalateAlert]
  ]
});

export default router;