// src/routes/index.js
// Simplified Route Index - Hospital-Grade Route Management System
// Refactored for maintainability and clean architecture

import { ROUTE_METADATA } from '../config/routeConfig.js';
import logger from '../logging/logger.js';
import { routeDocumentationService } from '../services/routeDocumentationService.js';
import { routeHealthService } from '../services/routeHealthService.js';
import {
  loadAllRoutes,
  validateLoadedRoutes,
  getRouteLoadingStats,
  warnUnusedRouteFiles
} from '../utils/routeLoader.js';

/**
 * Load and initialize all route modules
 * @returns {Promise<Object>} Loaded routes with system utilities
 */
async function initializeRoutes() {
  logger.info('Initializing VH Health route system');
  
  try {

    // Check unused routes first
    warnUnusedRouteFiles();

    // Load all routes using the route loader utility
    const routes = await loadAllRoutes();
    
    // Validate loaded routes
    const validation = validateLoadedRoutes(routes);
    logger.info(`Route validation: ${validation.validRoutes} valid, ${validation.stubRoutes} stubbed, ${validation.missingRoutes.length} missing`);
    
    // Perform initial health check
    const healthReport = routeHealthService.performHealthCheck(routes);
    
    // Generate documentation
    routeDocumentationService.generateDocumentation(routes);
    
    // Get loading statistics
    const stats = getRouteLoadingStats(routes);
    
    // Log system status
    logSystemStatus(healthReport, stats);
    
    // Handle critical issues
    if (healthReport.criticalIssues.length > 0) {
      logger.error('Critical route loading issues detected. System may be unstable.');
      // In development, we might want to continue, but log the issues
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`Critical routes failed to load: ${healthReport.criticalIssues.map(i => i.route).join(', ')}`);
      }
    }
    
    // Start health monitoring in production unless an explicit harness/ops
    // override disables the interval.
    if (
      process.env.NODE_ENV === 'production' &&
      String(process.env.ROUTE_HEALTH_MONITOR_ENABLED || 'true').toLowerCase() !== 'false'
    ) {
      routeHealthService.startHealthMonitoring(routes);
    }
    
    logger.info('VH Health route system initialized successfully');
    
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    const stats = getSystemStatistics();
    logger.info(`Development route health: ${stats.health?.overallHealth} | Routes: ${stats.health?.healthyRoutes}/${stats.health?.totalRoutes}`);
  }, 1000 * 60 * 5); // every 5 minutes
}

    // Return routes with system utilities
    return {
      // ===== AUTHENTICATION & AUTHORIZATION =====
      auth: routes.auth,
      firebaseAuth: routes.firebaseAuth,
      otp: routes.otp,
      otpDev: routes.otpDev,
      rbac: routes.rbac,
      
      // ===== CORE PATIENT MANAGEMENT =====
      users: routes.users,
      lookup: routes.lookup,
      appointments: routes.appointments,
      healthRecords: routes.healthRecords,
      investigations: routes.investigations,
      pharmacy: routes.pharmacy,
      feedback: routes.feedback,
      sos: routes.sos,
      
      // ===== HOSPITAL STRUCTURE & INFORMATION =====
      departments: routes.departments,
      doctors: routes.doctors,
      version: routes.version,
      health: routes.health,
      
      // ===== ADMINISTRATIVE & MANAGEMENT =====
      adminDepartments: routes.adminDepartments,
      adminDoctors: routes.adminDoctors,
      admin: routes.admin,
      analytics: routes.analytics,
      staff: routes.staff,
      
      // ===== TECHNICAL & SYSTEM =====
      debug: routes.debug,
      devices: routes.devices,
      notifications: routes.notifications,
      swagger: routes.swagger,

      // ===== SYSTEM UTILITIES =====
      _metadata: ROUTE_METADATA,
      _healthCheck: () => routeHealthService.performHealthCheck(routes),
      documentation: () => routeDocumentationService.generateDocumentation(routes),
      _stats: () => getRouteLoadingStats(routes),
      _validation: () => validateLoadedRoutes(routes),
      _healthService: routeHealthService,
      _documentationService: routeDocumentationService
    };
    
  } catch (error) {
    logger.error('Failed to initialize route system:', error.message);
    throw error;
  }
}

/**
 * Logs comprehensive system status
 * @param {Object} healthReport - Health check report
 * @param {Object} stats - Loading statistics
 */
function logSystemStatus(healthReport, stats) {
  const totalEndpoints = Object.values(ROUTE_METADATA).reduce((sum, meta) => sum + meta.endpoints, 0);
  const developmentInfo = process.env.NODE_ENV === 'development' ? ' (including development routes)' : '';
  
  logger.info('VH Health route system status');
  logger.info(`Routes: ${stats.totalRoutes} loaded, ${healthReport.healthyRoutes} healthy, ${healthReport.stubRoutes} stubbed`);
  logger.info(`Endpoints: ${totalEndpoints} total${developmentInfo}`);
  logger.info(`Categories: ${Object.keys(stats.byCategory).length} (${Object.keys(stats.byCategory).join(', ')})`);
  logger.info(`Security levels: ${Object.keys(stats.byStatus).length}`);
  logger.info(`Overall health: ${healthReport.overallHealth.toUpperCase()}`);
  
  if (healthReport.criticalIssues.length > 0) {
    logger.warn(`Critical route issues: ${healthReport.criticalIssues.length}`);
  }
  
  if (healthReport.recommendations.length > 0) {
    const urgentRecs = healthReport.recommendations.filter(rec => rec.priority === 'urgent').length;
    if (urgentRecs > 0) {
      logger.warn(`Urgent route recommendations: ${urgentRecs}`);
    }
  }
}

/**
 * Export health check function for external monitoring
 * @returns {Object} Current system health
 */
export function performSystemHealthCheck() {
  return routeHealthService.getLastHealthCheck() || { status: 'not_initialized' };
}

/**
 * Export documentation generation function
 * @param {string} format - Export format (json, markdown, html)
 * @returns {string|Object} Generated documentation
 */
export function generateSystemDocumentation(format = 'json') {
  const doc = routeDocumentationService.getLastDocumentation();
  if (!doc) {
    throw new Error('Documentation not available. System may not be initialized.');
  }
  
  if (format === 'object') {
    return doc;
  }
  
  return routeDocumentationService.exportDocumentation(doc, format);
}

/**
 * Export route statistics for monitoring
 * @returns {Object} Route statistics
 */
export function getSystemStatistics() {
  const healthCheck = routeHealthService.getLastHealthCheck();
  const documentation = routeDocumentationService.getLastDocumentation();
    
  return {
    health: healthCheck ? {
      overallHealth: healthCheck.overallHealth,
      healthyRoutes: healthCheck.healthyRoutes,
      totalRoutes: healthCheck.totalRoutes,
      criticalIssues: healthCheck.criticalIssues.length,
      lastCheck: healthCheck.timestamp
    } : null,
    documentation: documentation ? {
      totalEndpoints: documentation.overview.totalEndpoints,
      categories: Object.keys(documentation.categories).length,
      lastGenerated: documentation.metadata.generated
    } : null,
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  };
}

// Initialize and export routes
export default await initializeRoutes();
