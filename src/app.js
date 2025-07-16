// src/app.js - FULLY MODULAR VERSION with all routes properly organized

import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

// Logging and middleware imports
import logger from './logging/logger.js';
import { attachUserContext } from './middleware/attachUserContext.js';
import authMiddleware from './middleware/authMiddleware.js';
import corsMiddleware, { corsErrorHandler } from './middleware/corsMiddleware.js';
import errorHandlerMiddleware from './middleware/errorHandlerMiddleware.js';
import jwtAuth from './middleware/jwtMiddleware.js';
import loggingMiddleware from './middleware/loggingMiddleware.js';
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js';
import { patientRateLimiter, genericLimiter } from './middleware/rateLimitMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';

// Utility imports

// ====================================
// ROUTE IMPORTS - Organized by category
// ====================================

// Legacy routes (for backward compatibility)
// import adminRoutes from './routes/adminRoutes.js';

// Modularized routes

// Non-modularized routes (to be modularized in future)
import analyticsRoutes from './routes/analyticsRoutes.js';
import appointmentRoutes from './routes/appointment/index.js';
import authRoutes from './routes/auth/index.js';
import departmentRoutes from './routes/department/index.js';
import deviceRoutes from './routes/deviceRoutes.js';
import doctorRoutes from './routes/doctor/index.js';
import healthRoutes from './routes/health/index.js';
import routes from './routes/index.js';
import infrastructureRoutes from './routes/infrastructure/index.js';
import internalRoutes from './routes/internalRoutes.js';

// Adminroutes
import adminInvestigationRoutes from './routes/investigation/adminRoutes.js';
import investigationRoutes from './routes/investigation/index.js';
import notificationRoutes from './routes/notification/index.js';
import adminPharmacyRoutes from './routes/pharmacy/adminRoutes.js';
import pharmacyRoutes from './routes/pharmacy/index.js';
import adminRecordRoutes from './routes/record/adminRoutes.js';
import recordRoutes from './routes/record/index.js';
import staffRoutes from './routes/staff/index.js';
import userRoutes from './routes/user/index.js';
import swaggerLoader from './utils/swaggerLoader.js';

// ====================================
// ENVIRONMENT AND INITIALIZATION
// ====================================

// Load environment variables
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
  if (!swaggerDocument) {throw new Error('Failed to load Swagger documentation.');}
  console.log('✅ Swagger documentation validated and loaded.');
} catch (err) {
  console.error('❌ Swagger load failed:', err.message);
  process.exit(1);
}

// ====================================
// GLOBAL MIDDLEWARE
// ====================================

// Security and parsing middleware
app.use(helmet());
app.use(express.json());
app.use(corsMiddleware);

// Logging middleware
app.use(loggingMiddleware);
app.use(logger.morganMiddleware);

// User context middleware
app.use(attachUserContext);
// ***** normalizeIdentityFields has been MOVED from here *****

// ====================================
// PUBLIC ROUTES (No authentication required)
// ====================================

// API Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use('/api/v1/internal', internalRoutes);

// Root health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'VH Health API is running.',
    version: process.env.API_VERSION || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});
app.head('/', (req, res) => {
  res.status(200).end();
});

// Public API routes
app.use('/api/v1/auth', patientRateLimiter, routes.auth); // Patient Auth
app.use('/api/v1/auth', authRoutes); 
app.use('/api/v1/otp', patientRateLimiter, routes.otp);
app.use('/api/v1/health', healthRoutes);

// Infrastructure routes (mixed authentication - handled internally)
app.use('/api/v1', infrastructureRoutes);

// ====================================
// API KEY & AUTH MIDDLEWARE
// Apply to all routes below this point
// ====================================

app.use(validateApiKey);
app.use(authMiddleware);
app.use(normalizeIdentityFields); // ***** MOVED TO HERE. It now runs AFTER authMiddleware. *****

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
app.use('/api/v1/departments', departmentRoutes);
app.use('/api/v1/doctors', doctorRoutes);
// app.use('/api/v1/users', userRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// Healthcare services - Legacy (to be modularized)
app.use('/api/v1/devices', deviceRoutes);

// Support services
app.use('/api/v1/feedback', patientRateLimiter, routes.feedback);
app.use('/api/v1/sos', patientRateLimiter, routes.sos);
app.use('/api/v1/upload', routes.upload);

// ====================================
// JWT PROTECTED ROUTES (JWT token required)
// ====================================

// Staff routes
app.use('/api/v1/staff', jwtAuth, staffRoutes);

// Admin routes
app.use('/api/v1/admin/analytics', jwtAuth, analyticsRoutes);
app.use('/api/v1/admin/records', jwtAuth, adminRecordRoutes);
app.use('/api/v1/admin/investigations', jwtAuth, adminInvestigationRoutes);
app.use('/api/v1/admin/pharmacy', jwtAuth, adminPharmacyRoutes);

// ====================================
// ERROR HANDLING
// ====================================

// Fallback rate limiter
app.use(genericLimiter);

// CORS error handler (ADD THIS LINE)
app.use(corsErrorHandler);

// Global error handler
app.use(errorHandlerMiddleware);

// ====================================
// DEVELOPMENT LOGGING
// ====================================

if (process.env.NODE_ENV === 'development') {
  console.log('\n🚀 API Routes Summary:');
  console.log('=====================================');
  
  console.log('\n📋 Public Routes:');
  console.log('  - GET    / (Health check)');
  console.log('  - ALL    /api-docs (Swagger documentation)');
  console.log('  - ALL    /api/v1/auth/*');
  console.log('  - ALL    /api/v1/firebase-auth/*');
  console.log('  - ALL    /api/v1/otp/*');
  console.log('  - ALL    /api/v1/lookup/*');
  console.log('  - ALL    /api/v1/version/*');
  console.log('  - ALL    /api/v1/health/* (Some routes protected)');
  
  console.log('\n🔐 API Key Protected Routes:');
  console.log('  - ALL    /api/v1/users/*');
  console.log('  - ALL    /api/v1/appointments/*');
  console.log('  - ALL    /api/v1/records/*');
  console.log('  - ALL    /api/v1/investigations/*');
  console.log('  - ALL    /api/v1/pharmacy-orders/*');
  console.log('  - ALL    /api/v1/departments/*');
  console.log('  - ALL    /api/v1/doctors/*');
  console.log('  - ALL    /api/v1/notifications/*');
  console.log('  - ALL    /api/v1/devices/*');
  console.log('  - ALL    /api/v1/feedback/*');
  console.log('  - ALL    /api/v1/sos/*');
  console.log('  - ALL    /api/v1/upload/*');
  
  console.log('\n🔑 JWT Protected Routes:');
  console.log('  - ALL    /api/v1/debug/*');
  console.log('  - ALL    /api/v1/staff/*');
  console.log('  - ALL    /api/v1/admin/*');
  console.log('  - ALL    /api/v1/admin/rbac/*');
  console.log('  - ALL    /api/v1/admin/analytics/*');
  
  console.log('\n✅ Modularized Routes:');
  console.log('  - ✓ Staff (/api/v1/staff)');
  console.log('  - ✓ Pharmacy (/api/v1/pharmacy-orders)');
  console.log('  - ✓ Investigation (/api/v1/investigations)');
  console.log('  - ✓ Appointment (/api/v1/appointments)');
  console.log('  - ✓ Medical Records (/api/v1/records)');
  console.log('  - ✓ Health (/api/v1/health)');
  console.log('  - ✓ Department (/api/v1/departments)');
  console.log('  - ✓ Doctors (/api/v1/doctors)');
  console.log('  - ✓ Users (/api/v1/users)');
  console.log('  - ✓ Notifications (/api/v1/notifications)');
  console.log('  - ✓ Authentication (/api/v1/auth)');
  console.log('  - ✓ Infrastructure:');
  console.log('      • Debug (/api/v1/debug)');
  console.log('      • API Docs (/api/v1/api-docs)');
  console.log('      • Version (/api/v1/version)');
  console.log('      • RBAC (/api/v1/rbac)');
  
  console.log('\n⏳ Pending Modularization:');
  console.log('  - Devices (/api/v1/devices)');
  console.log('  - Feedback (/api/v1/feedback)');
  console.log('  - SOS (/api/v1/sos)');
  console.log('  - Upload (/api/v1/upload)');
  console.log('=====================================\n');
}

export default app;