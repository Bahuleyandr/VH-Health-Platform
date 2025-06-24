// src/routes/index.js
// Hospital-Grade Route Management and Aggregation System
// Enhanced with comprehensive monitoring, validation, and security features

import logger from '../logging/logger.js';

// ===================================================================
// 🔐 AUTHENTICATION & AUTHORIZATION ROUTES
// ===================================================================
let authRoutes, firebaseAuthRoutes, otpRoutes, rbacRoutes;
try {
  authRoutes = (await import('./authRoutes.js')).default;
  firebaseAuthRoutes = (await import('./firebaseAuthRoutes.js')).default;
  otpRoutes = (await import('./otpRoutes.js')).default;
  rbacRoutes = (await import('./rbacRoutes.js')).default;
  logger.info('✅ Authentication routes loaded successfully');
} catch (err) {
  logger.error('❌ Failed to load authentication routes:', err.message);
  throw new Error('Critical authentication routes failed to load');
}

// ===================================================================
// 👥 CORE USER & PATIENT MANAGEMENT ROUTES
// ===================================================================
let userRoutes, lookupRoutes, appointmentRoutes, recordRoutes, investigationRoutes;
let pharmacyRoutes, feedbackRoutes, sosRoutes;
try {
  userRoutes = (await import('./userRoutes.js')).default;
  lookupRoutes = (await import('./lookupRoutes.js')).default;
  appointmentRoutes = (await import('./appointmentRoutes.js')).default;
  recordRoutes = (await import('./recordRoutes.js')).default;
  investigationRoutes = (await import('./investigationRoutes.js')).default;
  pharmacyRoutes = (await import('./pharmacyRoutes.js')).default;
  feedbackRoutes = (await import('./feedbackRoutes.js')).default;
  sosRoutes = (await import('./sosRoutes.js')).default;
  logger.info('✅ Core patient management routes loaded successfully');
} catch (err) {
  logger.error('❌ Failed to load patient management routes:', err.message);
  throw new Error('Critical patient management routes failed to load');
}

// ===================================================================
// 🏥 HOSPITAL STRUCTURE & INFORMATION ROUTES
// ===================================================================
let departmentRoutes, doctorRoutes, versionRoutes, healthRoutes;
try {
  departmentRoutes = (await import('./departmentRoutes.js')).default;
  doctorRoutes = (await import('./doctorRoutes.js')).default;
  versionRoutes = (await import('./versionRoutes.js')).default;
  healthRoutes = (await import('./healthRoutes.js')).default;
  logger.info('✅ Hospital structure routes loaded successfully');
} catch (err) {
  logger.error('❌ Failed to load hospital structure routes:', err.message);
  throw new Error('Critical hospital structure routes failed to load');
}

// ===================================================================
// 📁 FILE MANAGEMENT & MEDIA ROUTES
// ===================================================================
let uploadRoutes;
try {
  uploadRoutes = (await import('./uploadRoutes.js')).default;
  logger.info('✅ File management routes loaded successfully');
} catch (err) {
  logger.error('❌ Failed to load file management routes:', err.message);
  throw new Error('Critical file management routes failed to load');
}

// ===================================================================
// 🛡️ ADMINISTRATIVE & MANAGEMENT ROUTES
// ===================================================================
let adminDepartmentRoutes, adminDoctorRoutes, adminNotificationRoutes;
let adminRoutes, analyticsRoutes, staffRoutes;
try {
  adminDepartmentRoutes = (await import('./adminDepartmentRoutes.js')).default;
  adminDoctorRoutes = (await import('./adminDoctorRoutes.js')).default;
  adminNotificationRoutes = (await import('./adminNotificationRoutes.js')).default;
  adminRoutes = (await import('./adminRoutes.js')).default;
  analyticsRoutes = (await import('./analyticsRoutes.js')).default;
  staffRoutes = (await import('./staffRoutes.js')).default;
  logger.info('✅ Administrative routes loaded successfully');
} catch (err) {
  logger.error('❌ Failed to load administrative routes:', err.message);
  throw new Error('Critical administrative routes failed to load');
}

// ===================================================================
// 🔧 TECHNICAL & SYSTEM ROUTES
// ===================================================================
let debugRoutes, deviceRoutes, notificationRoutes, swaggerRoutes;
try {
  debugRoutes = (await import('./debugRoutes.js')).default;
  deviceRoutes = (await import('./deviceRoutes.js')).default;
  notificationRoutes = (await import('./notificationRoutes.js')).default;
  swaggerRoutes = (await import('./swaggerRoutes.js')).default;
  logger.info('✅ Technical system routes loaded successfully');
} catch (err) {
  logger.error('❌ Failed to load technical routes:', err.message);
  throw new Error('Critical technical routes failed to load');
}

// ===================================================================
// 📊 ROUTE METADATA AND CONFIGURATION
// ===================================================================
const routeMetadata = {
  // Authentication & Security Routes
  auth: {
    module: authRoutes,
    category: 'authentication',
    priority: 'critical',
    description: 'User authentication and session management',
    endpoints: 15,
    security: 'public + admin',
    healthCheck: true
  },
  firebaseAuth: {
    module: firebaseAuthRoutes,
    category: 'authentication',
    priority: 'high',
    description: 'Firebase authentication integration',
    endpoints: 13,
    security: 'public + admin',
    healthCheck: true
  },
  otp: {
    module: otpRoutes,
    category: 'authentication',
    priority: 'high',
    description: 'OTP verification with security monitoring',
    endpoints: 18,
    security: 'public + monitored',
    healthCheck: true
  },
  rbac: {
    module: rbacRoutes,
    category: 'authorization',
    priority: 'critical',
    description: 'Role-based access control management',
    endpoints: 35,
    security: 'admin + security',
    healthCheck: true
  },

  // Core Patient Management
  users: {
    module: userRoutes,
    category: 'patient-management',
    priority: 'critical',
    description: 'User profile and account management',
    endpoints: 45,
    security: 'user + admin',
    healthCheck: true
  },
  lookup: {
    module: lookupRoutes,
    category: 'patient-management',
    priority: 'medium',
    description: 'User search and directory services',
    endpoints: 9,
    security: 'staff + admin',
    healthCheck: true
  },
  appointments: {
    module: appointmentRoutes,
    category: 'patient-management',
    priority: 'critical',
    description: 'Appointment scheduling and management',
    endpoints: 13,
    security: 'multi-role',
    healthCheck: true
  },
  healthRecords: {
    module: recordRoutes,
    category: 'medical',
    priority: 'critical',
    description: 'Medical records with HIPAA compliance',
    endpoints: 32,
    security: 'hipaa-compliant',
    healthCheck: true
  },
  investigations: {
    module: investigationRoutes,
    category: 'medical',
    priority: 'high',
    description: 'Laboratory investigation management',
    endpoints: 24,
    security: 'lab + medical',
    healthCheck: true
  },
  pharmacy: {
    module: pharmacyRoutes,
    category: 'medical',
    priority: 'high',
    description: 'Pharmacy and medication management',
    endpoints: 28,
    security: 'pharmacy + medical',
    healthCheck: true
  },
  feedback: {
    module: feedbackRoutes,
    category: 'communication',
    priority: 'medium',
    description: 'Patient feedback and satisfaction',
    endpoints: 12,
    security: 'all users',
    healthCheck: true
  },
  sos: {
    module: sosRoutes,
    category: 'emergency',
    priority: 'critical',
    description: 'Emergency response and crisis management',
    endpoints: 43,
    security: 'emergency system',
    healthCheck: true
  },

  // Hospital Structure
  departments: {
    module: departmentRoutes,
    category: 'hospital-structure',
    priority: 'medium',
    description: 'Department organization and management',
    endpoints: 14,
    security: 'staff + admin',
    healthCheck: true
  },
  doctors: {
    module: doctorRoutes,
    category: 'hospital-structure',
    priority: 'medium',
    description: 'Doctor profiles and scheduling',
    endpoints: 14,
    security: 'multi-role',
    healthCheck: true
  },
  version: {
    module: versionRoutes,
    category: 'system',
    priority: 'low',
    description: 'API version and system information',
    endpoints: 10,
    security: 'public + admin',
    healthCheck: true
  },
  health: {
    module: healthRoutes,
    category: 'system',
    priority: 'critical',
    description: 'System health checks and monitoring',
    endpoints: 14,
    security: 'public + protected',
    healthCheck: false // This IS the health check
  },

  // File Management
  upload: {
    module: uploadRoutes,
    category: 'file-management',
    priority: 'high',
    description: 'Hospital-grade file management with HIPAA compliance',
    endpoints: 43,
    security: 'role-based',
    healthCheck: true
  },

  // Administrative
  adminDepartments: {
    module: adminDepartmentRoutes,
    category: 'administration',
    priority: 'medium',
    description: 'Administrative department management',
    endpoints: 8,
    security: 'admin only',
    healthCheck: true
  },
  adminDoctors: {
    module: adminDoctorRoutes,
    category: 'administration',
    priority: 'medium',
    description: 'Administrative doctor management',
    endpoints: 6,
    security: 'admin only',
    healthCheck: true
  },
  adminNotifications: {
    module: adminNotificationRoutes,
    category: 'administration',
    priority: 'medium',
    description: 'Administrative notification management',
    endpoints: 12,
    security: 'admin only',
    healthCheck: true
  },
  admin: {
    module: adminRoutes,
    category: 'administration',
    priority: 'high',
    description: 'System administration and management',
    endpoints: 22,
    security: 'admin only',
    healthCheck: true
  },
  analytics: {
    module: analyticsRoutes,
    category: 'administration',
    priority: 'medium',
    description: 'Hospital analytics and reporting',
    endpoints: 10,
    security: 'admin + manager',
    healthCheck: true
  },
  staff: {
    module: staffRoutes,
    category: 'administration',
    priority: 'high',
    description: 'Staff management and HR system',
    endpoints: 35,
    security: 'hr + management',
    healthCheck: true
  },

  // Technical System
  debug: {
    module: debugRoutes,
    category: 'technical',
    priority: 'low',
    description: 'System debugging and monitoring',
    endpoints: 13,
    security: 'admin only',
    healthCheck: true
  },
  devices: {
    module: deviceRoutes,
    category: 'technical',
    priority: 'medium',
    description: 'Device registration and push notifications',
    endpoints: 11,
    security: 'user-based',
    healthCheck: true
  },
  notifications: {
    module: notificationRoutes,
    category: 'communication',
    priority: 'medium',
    description: 'Patient notification system',
    endpoints: 20,
    security: 'role-based',
    healthCheck: true
  },
  swagger: {
    module: swaggerRoutes,
    category: 'documentation',
    priority: 'low',
    description: 'API documentation interface',
    endpoints: 3,
    security: 'public',
    healthCheck: false
  }
};

// ===================================================================
// 🏥 ROUTE HEALTH MONITORING SYSTEM
// ===================================================================

/**
 * Performs health check on all route modules
 * @returns {Object} Health status report
 */
export function performRouteHealthCheck() {
  const healthReport = {
    timestamp: new Date().toISOString(),
    totalRoutes: Object.keys(routeMetadata).length,
    healthyRoutes: 0,
    unhealthyRoutes: 0,
    criticalIssues: [],
    routeStatus: {}
  };

  for (const [routeName, metadata] of Object.entries(routeMetadata)) {
    try {
      const isHealthy = metadata.module && typeof metadata.module === 'object';
      
      healthReport.routeStatus[routeName] = {
        status: isHealthy ? 'healthy' : 'unhealthy',
        priority: metadata.priority,
        category: metadata.category,
        endpoints: metadata.endpoints,
        security: metadata.security,
        lastChecked: new Date().toISOString()
      };

      if (isHealthy) {
        healthReport.healthyRoutes++;
      } else {
        healthReport.unhealthyRoutes++;
        
        if (metadata.priority === 'critical') {
          healthReport.criticalIssues.push({
            route: routeName,
            issue: 'Route module failed to load',
            priority: 'critical',
            impact: 'Service disruption'
          });
        }
      }
    } catch (err) {
      healthReport.unhealthyRoutes++;
      healthReport.routeStatus[routeName] = {
        status: 'error',
        error: err.message,
        priority: metadata.priority,
        lastChecked: new Date().toISOString()
      };

      if (metadata.priority === 'critical') {
        healthReport.criticalIssues.push({
          route: routeName,
          issue: err.message,
          priority: 'critical',
          impact: 'Service disruption'
        });
      }
    }
  }

  // Calculate overall system health
  const healthPercentage = (healthReport.healthyRoutes / healthReport.totalRoutes) * 100;
  healthReport.overallHealth = healthPercentage >= 95 ? 'excellent' : 
                              healthPercentage >= 85 ? 'good' : 
                              healthPercentage >= 70 ? 'degraded' : 'critical';

  logger.info(`[Route Health Check] ${healthReport.healthyRoutes}/${healthReport.totalRoutes} routes healthy (${Math.round(healthPercentage)}%)`);

  if (healthReport.criticalIssues.length > 0) {
    logger.error(`[Route Health Check] ${healthReport.criticalIssues.length} critical issues detected:`, 
                 healthReport.criticalIssues.map(issue => issue.route).join(', '));
  }

  return healthReport;
}

/**
 * Generates comprehensive route documentation
 * @returns {Object} Complete route documentation
 */
export function generateRouteDocumentation() {
  const documentation = {
    generated: new Date().toISOString(),
    apiVersion: '1.0.0',
    totalRoutes: Object.keys(routeMetadata).length,
    totalEndpoints: Object.values(routeMetadata).reduce((sum, meta) => sum + meta.endpoints, 0),
    categories: {},
    securityLevels: {},
    routes: {}
  };

  // Organize by categories
  for (const [routeName, metadata] of Object.entries(routeMetadata)) {
    // Category grouping
    if (!documentation.categories[metadata.category]) {
      documentation.categories[metadata.category] = {
        routes: [],
        totalEndpoints: 0,
        description: getCategoryDescription(metadata.category)
      };
    }
    documentation.categories[metadata.category].routes.push(routeName);
    documentation.categories[metadata.category].totalEndpoints += metadata.endpoints;

    // Security level grouping
    if (!documentation.securityLevels[metadata.security]) {
      documentation.securityLevels[metadata.security] = [];
    }
    documentation.securityLevels[metadata.security].push(routeName);

    // Detailed route information
    documentation.routes[routeName] = {
      description: metadata.description,
      category: metadata.category,
      priority: metadata.priority,
      endpoints: metadata.endpoints,
      security: metadata.security,
      healthMonitored: metadata.healthCheck
    };
  }

  return documentation;
}

/**
 * Gets description for route categories
 * @param {string} category - Category name
 * @returns {string} Category description
 */
function getCategoryDescription(category) {
  const descriptions = {
    'authentication': 'User authentication and identity verification',
    'authorization': 'Access control and permission management',
    'patient-management': 'Core patient care and data management',
    'medical': 'Medical records, treatments, and clinical data',
    'communication': 'Messaging, notifications, and feedback systems',
    'emergency': 'Crisis response and emergency management',
    'hospital-structure': 'Organizational and staff information',
    'system': 'System health, monitoring, and information',
    'file-management': 'Document and media handling',
    'administration': 'Administrative tools and management',
    'technical': 'Technical system management and debugging',
    'documentation': 'API documentation and help systems'
  };
  return descriptions[category] || 'General system functionality';
}

// ===================================================================
// 🎯 EXPORTED ROUTE CONFIGURATION
// ===================================================================

// Perform initial health check
const initialHealthCheck = performRouteHealthCheck();
if (initialHealthCheck.criticalIssues.length > 0) {
  logger.error('❌ Critical route loading issues detected. System may be unstable.');
} else {
  logger.info('✅ All route modules loaded successfully. System ready.');
}

// Export structured route configuration
export default {
  // ===== AUTHENTICATION & AUTHORIZATION =====
  auth: authRoutes,
  firebaseAuth: firebaseAuthRoutes,
  otp: otpRoutes,
  rbac: rbacRoutes,
  
  // ===== CORE PATIENT MANAGEMENT =====
  users: userRoutes,
  lookup: lookupRoutes,
  appointments: appointmentRoutes,
  healthRecords: recordRoutes,
  investigations: investigationRoutes,
  pharmacy: pharmacyRoutes,
  feedback: feedbackRoutes,
  sos: sosRoutes,
  
  // ===== HOSPITAL STRUCTURE & INFORMATION =====
  departments: departmentRoutes,
  doctors: doctorRoutes,
  version: versionRoutes,
  health: healthRoutes,
  
  // ===== FILE MANAGEMENT & MEDIA =====
  upload: uploadRoutes,
  
  // ===== ADMINISTRATIVE & MANAGEMENT =====
  adminDepartments: adminDepartmentRoutes,
  adminDoctors: adminDoctorRoutes,
  adminNotifications: adminNotificationRoutes,
  admin: adminRoutes,
  analytics: analyticsRoutes,
  staff: staffRoutes,
  
  // ===== TECHNICAL & SYSTEM =====
  debug: debugRoutes,
  devices: deviceRoutes,
  notifications: notificationRoutes,
  swagger: swaggerRoutes,

  // ===== SYSTEM UTILITIES =====
  _metadata: routeMetadata,
  _healthCheck: performRouteHealthCheck,
  _documentation: generateRouteDocumentation
};

// Log final system status
logger.info(`🏥 VH Health Route System initialized with ${Object.keys(routeMetadata).length} routes and ${Object.values(routeMetadata).reduce((sum, meta) => sum + meta.endpoints, 0)} endpoints`);

// Export route health monitoring for external use
export { routeMetadata, performRouteHealthCheck, generateRouteDocumentation };