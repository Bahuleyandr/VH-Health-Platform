// src/app.js
import { initializeSourceMaps } from './config/sourceMapConfig.js';

// Initialize source maps before anything else
initializeSourceMaps();

import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

// Logging and middleware imports
import logger from './logging/logger.js';
import { attachUserContext } from './middleware/attachUserContext.js';
import authMiddleware from './middleware/authMiddleware.js';
import corsMiddleware, { corsErrorHandler } from './middleware/corsMiddleware.js';
import { errorHandlerMiddleware } from './middleware/errorHandlerMiddleware.js';
import jwtAuth from './middleware/jwtMiddleware.js';
import { requireRole } from './middleware/rbacMiddleware.js';
import loggingMiddleware from './middleware/loggingMiddleware.js';
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js';
import { auditLogMiddleware } from './middleware/auditLog.js';
import { patientRateLimiter, genericLimiter, adminRateLimiter } from './middleware/rateLimitMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';

// ====================================
// ROUTE IMPORTS - Organized by category
// ====================================

// Public / mixed modules
import appointmentRoutes from './routes/appointment/index.js';
import departmentRoutes from './routes/department/index.js';
import deviceRoutes from './routes/deviceRoutes.js';
import doctorRoutes from './routes/doctor/index.js';
import healthRoutes from './routes/health/index.js';
import routes from './routes/index.js';
import infrastructureRoutes from './routes/infrastructure/index.js';
import internalRoutes from './routes/internalRoutes.js';
import deliveryRoutes from './routes/delivery/index.js';
import investigationRoutes from './routes/investigation/index.js';
import notificationRoutes from './routes/notification/index.js';
import pharmacyRoutes from './routes/pharmacy/index.js';
import prescriptionRoutes from './routes/prescription/index.js';
import recordRoutes from './routes/record/index.js';
import searchRoutes from './routes/searchRoutes.js';
import staffRoutes from './routes/staff/index.js';
import userRoutes from './routes/user/index.js';
import { bedRouter, wardRouter } from './routes/bed/bedRoutes.js';

// Admin (centralized under /api/v1/admin)
import adminDashboardRoutes from './routes/admin/index.js';

// System settings and logs (admin portal: /api/v1/system/* and /api/v1/logs/*)
import systemRoutes from './routes/system/index.js';
import logRoutes from './routes/logs/index.js';

// Patient dashboard (API key only, no JWT)
import dashboardRoutes from './routes/dashboard/index.js';

// GDPR Data Export
import dataExportRoutes from './routes/dataExportRoutes.js';

// Swagger loader
import swaggerLoader from './utils/swaggerLoader.js';

// ====================================
// ENVIRONMENT AND INITIALIZATION
// ====================================

dotenv.config();
import './utils/validateEnv.js';

// Create Express app
const app = express();
app.set('trust proxy', 1); // Required for Render or Cloudflare

// ====================================
// SWAGGER SETUP
// ====================================

let swaggerDocument;
try {
  swaggerDocument = swaggerLoader();
  if (!swaggerDocument) throw new Error('Failed to load Swagger documentation.');
  logger.info('✅ Swagger documentation validated and loaded.');
} catch (err) {
  logger.error('❌ Swagger load failed:', err.message);
  process.exit(1);
}

// ====================================
// GLOBAL MIDDLEWARE
// ====================================

app.use(helmet());
app.use(express.json());
app.use(corsMiddleware);

// Logging
app.use(loggingMiddleware);
app.use(logger.morganMiddleware);

// User context middleware
app.use(attachUserContext);
// NOTE: normalizeIdentityFields now runs AFTER authMiddleware below

// Universal audit log — fire-and-forget, captures all routes, handles null user gracefully
app.use(auditLogMiddleware);

// ====================================
// PUBLIC ROUTES (No authentication required)
// ====================================

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use('/api/v1/internal', validateApiKey, internalRoutes);

// Root health check
app.get('/', (req, res) => {
  res.json({
    message: 'VH Health API is running.',
    version: process.env.API_VERSION || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});
app.head('/', (req, res) => res.status(200).end());

// Public API routes
app.use('/api/v1/auth', patientRateLimiter, routes.auth); // Patient Auth
app.use('/api/v1/otp', patientRateLimiter, routes.otp);
app.use('/api/v1/health', healthRoutes);

// Infrastructure (mixed auth handled inside)
app.use('/api/v1', infrastructureRoutes);

// ====================================
// API KEY & AUTH MIDDLEWARE
// Apply to all routes below this point
// ====================================

app.use(validateApiKey);

// ====================================
// API KEY ONLY ROUTES (no JWT required)
// Mount before authMiddleware so Flutter can call these without a JWT
// ====================================

// Patient dashboard — Flutter app uses API key only for this
app.use('/api/v1/dashboard', patientRateLimiter, dashboardRoutes);

app.use(authMiddleware);
app.use(normalizeIdentityFields); // runs AFTER authMiddleware

// ====================================
// AUTHENTICATED ROUTES (API key required)
// ====================================

// User management
app.use('/api/v1/users', patientRateLimiter, userRoutes);

// Healthcare services - Modularized
app.use('/api/v1/appointments', patientRateLimiter, appointmentRoutes);
app.use('/api/v1/records', patientRateLimiter, recordRoutes);
app.use('/api/v1/investigations', patientRateLimiter, investigationRoutes);
app.use('/api/v1/pharmacy-orders', patientRateLimiter, pharmacyRoutes);
app.use('/api/v1/prescriptions', patientRateLimiter, prescriptionRoutes);
app.use('/api/v1/delivery', patientRateLimiter, deliveryRoutes);
app.use('/api/v1/departments', departmentRoutes);
app.use('/api/v1/doctors', doctorRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// Healthcare services - Legacy (to be modularized)
app.use('/api/v1/devices', deviceRoutes);

// Support services
app.use('/api/v1/feedback', patientRateLimiter, routes.feedback);
app.use('/api/v1/sos', patientRateLimiter, routes.sos);
app.use('/api/v1/search', jwtAuth, searchRoutes);
app.use('/api/v1/upload', routes.upload);

// GDPR Data Export
app.use('/api/v1/data-export', patientRateLimiter, dataExportRoutes);

// ====================================
// JWT PROTECTED ROUTES (JWT token required)
// ====================================

app.use('/api/v1/staff', jwtAuth, staffRoutes);

// Bed/Ward management (admin only)
app.use('/api/v1/beds', jwtAuth, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSE'), bedRouter);
app.use('/api/v1/wards', jwtAuth, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSE'), wardRouter);

// Centralized admin namespace
// AdminDashboardRoutes internally mounts: /appointments, /departments, /doctors,
// /users, /notifications, /records, /investigations, /pharmacy, /analytics
app.use('/api/v1/admin', jwtAuth, requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, adminDashboardRoutes);

// System settings + status (portal: /api/v1/system/settings, /api/v1/system/status)
app.use('/api/v1/system', jwtAuth, requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, systemRoutes);

// Audit + system logs (portal: /api/v1/logs/audit, /api/v1/logs/system)
app.use('/api/v1/logs', jwtAuth, requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, logRoutes);

// (Optional but recommended) serve report exports if you use local file URLs
app.use('/exports', express.static('exports'));

// ====================================
// ERROR HANDLING
// ====================================

// Fallback rate limiter
app.use(genericLimiter);

// CORS error handler
app.use(corsErrorHandler);

// Global error handler
app.use(errorHandlerMiddleware);

// ====================================
// DEVELOPMENT LOGGING
// ====================================

if (process.env.NODE_ENV === 'development') {
  logger.info('\n🚀 API Routes Summary:');
  logger.info('=====================================');

  logger.info('\n📋 Public Routes:');
  logger.info('  - GET    / (Health check)');
  logger.info('  - ALL    /api-docs (Swagger documentation)');
  logger.info('  - ALL    /api/v1/auth/*');
  logger.info('  - ALL    /api/v1/otp/*');
  logger.info('  - ALL    /api/v1/health/* (Some routes protected)');
  logger.info('  - MIXED  /api/v1/* (infrastructure)');

  logger.info('\n🔐 API Key Protected Routes:');
  logger.info('  - ALL    /api/v1/users/*');
  logger.info('  - ALL    /api/v1/appointments/*');
  logger.info('  - ALL    /api/v1/records/*');
  logger.info('  - ALL    /api/v1/investigations/*');
  logger.info('  - ALL    /api/v1/pharmacy-orders/*');
  logger.info('  - ALL    /api/v1/departments/*');
  logger.info('  - ALL    /api/v1/doctors/*');
  logger.info('  - ALL    /api/v1/notifications/*');
  logger.info('  - ALL    /api/v1/devices/*');
  logger.info('  - ALL    /api/v1/feedback/*');
  logger.info('  - ALL    /api/v1/sos/*');
  logger.info('  - ALL    /api/v1/upload/*');

  logger.info('\n🔑 JWT Protected Routes:');
  logger.info('  - ALL    /api/v1/staff/*');
  logger.info('  - ALL    /api/v1/admin/*  (Admin Dashboard + all admin submodules)');

  logger.info('\n✅ Modularized Routes:');
  logger.info('  - ✓ Staff (/api/v1/staff)');
  logger.info('  - ✓ Pharmacy (/api/v1/pharmacy-orders)');
  logger.info('  - ✓ Investigation (/api/v1/investigations)');
  logger.info('  - ✓ Appointment (/api/v1/appointments)');
  logger.info('  - ✓ Medical Records (/api/v1/records)');
  logger.info('  - ✓ Health (/api/v1/health)');
  logger.info('  - ✓ Department (/api/v1/departments)');
  logger.info('  - ✓ Doctors (/api/v1/doctors)');
  logger.info('  - ✓ Users (/api/v1/users)');
  logger.info('  - ✓ Notifications (/api/v1/notifications)');
  logger.info('  - ✓ Authentication (/api/v1/auth)');
  logger.info('  - ✓ Infrastructure (/api/v1/*)');
  logger.info('=====================================\n');
}

export default app;
