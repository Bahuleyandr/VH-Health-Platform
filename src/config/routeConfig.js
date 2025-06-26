// src/config/routeConfig.js
// Route Metadata and Configuration Management

/**
 * Route metadata configuration
 * Defines all routes, their properties, and monitoring settings
 */
export const ROUTE_METADATA = {
  // ===== AUTHENTICATION & AUTHORIZATION =====
  auth: {
    category: 'authentication',
    priority: 'critical',
    description: 'User authentication and session management',
    endpoints: 15,
    security: 'public + admin',
    healthCheck: true
  },
  firebaseAuth: {
    category: 'authentication',
    priority: 'high',
    description: 'Firebase authentication integration',
    endpoints: 13,
    security: 'public + admin',
    healthCheck: true
  },
  otp: {
    category: 'authentication',
    priority: 'high',
    description: 'OTP verification with security monitoring',
    endpoints: 12,
    security: 'public + monitored',
    healthCheck: true
  },
  otpDev: {
    category: 'development',
    priority: 'low',
    description: 'OTP development and testing endpoints',
    endpoints: 8,
    security: 'development only',
    healthCheck: true,
    developmentOnly: true
  },
  rbac: {
    category: 'authorization',
    priority: 'critical',
    description: 'Role-based access control management',
    endpoints: 35,
    security: 'admin + security',
    healthCheck: true
  },

  // ===== CORE PATIENT MANAGEMENT =====
  users: {
    category: 'patient-management',
    priority: 'critical',
    description: 'User profile and account management',
    endpoints: 45,
    security: 'user + admin',
    healthCheck: true
  },
  lookup: {
    category: 'patient-management',
    priority: 'medium',
    description: 'User search and directory services',
    endpoints: 9,
    security: 'staff + admin',
    healthCheck: true
  },
  appointments: {
    category: 'patient-management',
    priority: 'critical',
    description: 'Appointment scheduling and management',
    endpoints: 13,
    security: 'multi-role',
    healthCheck: true
  },
  healthRecords: {
    category: 'medical',
    priority: 'critical',
    description: 'Medical records with HIPAA compliance',
    endpoints: 32,
    security: 'hipaa-compliant',
    healthCheck: true
  },
  investigations: {
    category: 'medical',
    priority: 'high',
    description: 'Laboratory investigation management',
    endpoints: 24,
    security: 'lab + medical',
    healthCheck: true
  },
  pharmacy: {
    category: 'medical',
    priority: 'high',
    description: 'Pharmacy and medication management',
    endpoints: 28,
    security: 'pharmacy + medical',
    healthCheck: true
  },
  feedback: {
    category: 'communication',
    priority: 'medium',
    description: 'Patient feedback and satisfaction',
    endpoints: 12,
    security: 'all users',
    healthCheck: true
  },
  sos: {
    category: 'emergency',
    priority: 'critical',
    description: 'Emergency response and crisis management',
    endpoints: 43,
    security: 'emergency system',
    healthCheck: true
  },

  // ===== HOSPITAL STRUCTURE & INFORMATION =====
  departments: {
    category: 'hospital-structure',
    priority: 'medium',
    description: 'Department organization and management',
    endpoints: 14,
    security: 'staff + admin',
    healthCheck: true
  },
  doctors: {
    category: 'hospital-structure',
    priority: 'medium',
    description: 'Doctor profiles and scheduling',
    endpoints: 14,
    security: 'multi-role',
    healthCheck: true
  },
  version: {
    category: 'system',
    priority: 'low',
    description: 'API version and system information',
    endpoints: 10,
    security: 'public + admin',
    healthCheck: true
  },
  health: {
    category: 'system',
    priority: 'critical',
    description: 'System health checks and monitoring',
    endpoints: 14,
    security: 'public + protected',
    healthCheck: false // This IS the health check
  },

  // ===== FILE MANAGEMENT & MEDIA =====
  upload: {
    category: 'file-management',
    priority: 'high',
    description: 'Hospital-grade file management with HIPAA compliance',
    endpoints: 43,
    security: 'role-based',
    healthCheck: true
  },

  // ===== ADMINISTRATIVE & MANAGEMENT =====
  adminDepartments: {
    category: 'administration',
    priority: 'medium',
    description: 'Administrative department management',
    endpoints: 8,
    security: 'admin only',
    healthCheck: true
  },
  adminDoctors: {
    category: 'administration',
    priority: 'medium',
    description: 'Administrative doctor management',
    endpoints: 6,
    security: 'admin only',
    healthCheck: true
  },
  adminNotifications: {
    category: 'administration',
    priority: 'medium',
    description: 'Administrative notification management',
    endpoints: 12,
    security: 'admin only',
    healthCheck: true
  },
  admin: {
    category: 'administration',
    priority: 'high',
    description: 'System administration and management',
    endpoints: 22,
    security: 'admin only',
    healthCheck: true
  },
  analytics: {
    category: 'administration',
    priority: 'medium',
    description: 'Hospital analytics and reporting',
    endpoints: 10,
    security: 'admin + manager',
    healthCheck: true
  },
  staff: {
    category: 'administration',
    priority: 'high',
    description: 'Staff management and HR system',
    endpoints: 35,
    security: 'hr + management',
    healthCheck: true
  },

  // ===== TECHNICAL & SYSTEM =====
  debug: {
    category: 'technical',
    priority: 'low',
    description: 'System debugging and monitoring',
    endpoints: 13,
    security: 'admin only',
    healthCheck: true
  },
  devices: {
    category: 'technical',
    priority: 'medium',
    description: 'Device registration and push notifications',
    endpoints: 11,
    security: 'user-based',
    healthCheck: true
  },
  notifications: {
    category: 'communication',
    priority: 'medium',
    description: 'Patient notification system',
    endpoints: 20,
    security: 'role-based',
    healthCheck: true
  },
  swagger: {
    category: 'documentation',
    priority: 'low',
    description: 'API documentation interface',
    endpoints: 3,
    security: 'public',
    healthCheck: false
  }
};

/**
 * Route file mappings
 * Maps route keys to their file paths (relative to src/utils/)
 */
export const ROUTE_FILES = {
  // Authentication & Authorization
  auth: '../routes/authRoutes.js',
  firebaseAuth: '../routes/firebaseAuthRoutes.js',
  otp: '../routes/otpRoutes.js',
  otpDev: '../routes/otpDevRoutes.js',
  rbac: '../routes/rbacRoutes.js',
  
  // Core Patient Management
  users: '../routes/userRoutes.js',
  lookup: '../routes/lookupRoutes.js',
  appointments: '../routes/appointment/index.js',
  healthRecords: '../routes/record/index.js',
  investigations: '../routes/investigation/index.js',
  pharmacy: '../routes/pharmacy/index.js',
  feedback: '../routes/feedbackRoutes.js',
  sos: '../routes/sosRoutes.js',
  
  // Hospital Structure & Information
  departments: '../routes/departmentRoutes.js',
  doctors: '../routes/doctorRoutes.js',
  version: '../routes/versionRoutes.js',
  health: '../routes/health/index.js',
  
  // File Management & Media
  upload: '../routes/uploadRoutes.js',
  
  // Administrative & Management
  adminDepartments: '../routes/adminDepartmentRoutes.js',
  adminDoctors: '../routes/adminDoctorRoutes.js',
  adminNotifications: '../routes/adminNotificationRoutes.js',
  admin: '../routes/adminRoutes.js',
  analytics: '../routes/analyticsRoutes.js',
  staff: '../routes/staff/index.js',
  
  // Technical & System
  debug: '../routes/debugRoutes.js',
  devices: '../routes/deviceRoutes.js',
  notifications: '../routes/notificationRoutes.js',
  swagger: '../routes/swaggerRoutes.js'
};

/**
 * Route categories and their descriptions
 */
export const CATEGORY_DESCRIPTIONS = {
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
  'documentation': 'API documentation and help systems',
  'development': 'Development tools and testing endpoints'
};

/**
 * Route loading priorities
 * Higher priority routes are loaded first
 */
export const LOADING_PRIORITIES = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4
};

/**
 * Environment-specific route configurations
 */
export const ENVIRONMENT_CONFIG = {
  development: {
    enableDevRoutes: true,
    enableDebugLogging: true,
    healthCheckInterval: 30000 // 30 seconds
  },
  test: {
    enableDevRoutes: true,
    enableDebugLogging: false,
    healthCheckInterval: 60000 // 1 minute
  },
  production: {
    enableDevRoutes: false,
    enableDebugLogging: false,
    healthCheckInterval: 300000 // 5 minutes
  }
};

/**
 * Gets configuration for current environment
 * @returns {Object} Environment configuration
 */
export function getCurrentEnvironmentConfig() {
  const env = process.env.NODE_ENV || 'development';
  return ENVIRONMENT_CONFIG[env] || ENVIRONMENT_CONFIG.development;
}