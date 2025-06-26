// src/app.js - FULLY MODULAR VERSION with Staff, Pharmacy, Investigation, Appointment, and Record Routes

import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import * as Sentry from '@sentry/node';

import logger from './logging/logger.js';
import loggingMiddleware from './middleware/loggingMiddleware.js';
import errorHandlerMiddleware from './middleware/errorHandlerMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';
import jwtAuth from './middleware/jwtMiddleware.js';
import corsMiddleware from './middleware/corsMiddleware.js';
import authMiddleware from './middleware/authMiddleware.js';
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js';

// ✅ Import routes - HYBRID approach (individual + bulk)
import debugRoutes from './routes/debugRoutes.js';
import routes from './routes/index.js';
import adminRoutes from './routes/adminRoutes.js';

// ✅ UPDATED: Import all modular routes
import staffRoutes from './routes/staff/index.js';  // Modular staff routes
import pharmacyRoutes from './routes/pharmacy/index.js';  // Modular pharmacy routes
import investigationRoutes from './routes/investigation/index.js';  // Modular investigation routes
import appointmentRoutes from './routes/appointment/index.js';  // Modular appointment routes
import recordRoutes from './routes/record/index.js';  // NEW: Modular record routes
import healthRoutes from './routes/health/index.js';

import departmentRoutes from './routes/departmentRoutes.js';
import rbacRoutes from './routes/rbacRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import doctorRoutes from './routes/doctorRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import deviceRoutes from './routes/deviceRoutes.js';
import firebaseAuthRoutes from './routes/firebaseAuthRoutes.js';

// Import the admin routes
// import otpAdminRoutes from './routes/otpAdminRoutes.js';

import { attachUserContext } from './middleware/attachUserContext.js';
import { patientRateLimiter, genericLimiter } from './middleware/rateLimitMiddleware.js';
import swaggerLoader from './utils/swaggerLoader.js';

// ✅ Load .env from local file if available, else rely on Render secrets
dotenv.config();
import './utils/validateEnv.js';

// ✅ Sentry Initialization
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
  environment: process.env.NODE_ENV || 'development'
});

const app = express();
app.set('trust proxy', 1); // ✅ Required for Render or Cloudflare

// ✅ Sentry Request Middleware
app.use(Sentry.Handlers.requestHandler());

// ✅ Debug Routes (secured by JWT)
app.use('/api/v1/debug', jwtAuth, debugRoutes);

// ✅ Swagger Setup
let swaggerDocument;
try {
  swaggerDocument = swaggerLoader();
  if (!swaggerDocument) throw new Error('Failed to load Swagger documentation.');
  console.log('✅ Swagger documentation validated and loaded.');
} catch (err) {
  console.error('❌ Swagger load failed:', err.message);
  process.exit(1);
}

// ✅ Global Middleware
app.use(helmet());
app.use(express.json());
app.use(corsMiddleware);
app.use(loggingMiddleware);
app.use(logger.morganMiddleware);
app.use(attachUserContext);
app.use(normalizeIdentityFields);

// ✅ Swagger Docs (no API key required)
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ✅ Public Routes — no API Key, no JWT
app.use('/api/v1/auth', patientRateLimiter, routes.auth);
app.use('/api/v1/firebase-auth', patientRateLimiter, firebaseAuthRoutes);
app.use('/api/v1/otp', patientRateLimiter, routes.otp);
app.use('/api/v1/lookup', routes.lookup);
app.use('/api/v1/version', routes.version);
app.use('/api/v1/health', healthRoutes);

// ✅ Root Health Check for Render and bots
app.get('/', (req, res) => {
  res.json({ message: 'VH Health API is running.' });
});
app.head('/', (req, res) => {
  res.status(200).end();
});

// ✅ Apply API Key and Auth Middleware
app.use(validateApiKey);
app.use(authMiddleware);

// ✅ Authenticated (API key only) Routes
app.use('/api/v1/users', patientRateLimiter, routes.users);

// ✅ UPDATED: Appointment routes now use modular structure
app.use('/api/v1/appointments', patientRateLimiter, appointmentRoutes);

// ✅ UPDATED: Record routes now use modular structure
// OLD: app.use('/api/v1/records', patientRateLimiter, routes.healthRecords);
// NEW: Use modular record routes
app.use('/api/v1/records', patientRateLimiter, recordRoutes);

// ✅ Investigation routes use modular structure
app.use('/api/v1/investigations', patientRateLimiter, investigationRoutes);

// ✅ Pharmacy routes use modular structure
app.use('/api/v1/pharmacy-orders', patientRateLimiter, pharmacyRoutes);

app.use('/api/v1/feedback', patientRateLimiter, routes.feedback);
app.use('/api/v1/sos', patientRateLimiter, routes.sos);
app.use('/api/v1/upload', routes.upload);
app.use('/api/v1/departments', departmentRoutes);
app.use('/api/v1/doctors', doctorRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/devices', deviceRoutes);

// ✅ JWT-Protected Admin/Staff Routes
// app.use('/api/v1/admin/otp', jwtAuth, otpAdminRoutes);
app.use('/api/v1/admin/rbac', jwtAuth, rbacRoutes);
app.use('/api/v1/admin/analytics', jwtAuth, analyticsRoutes);
app.use('/api/v1/admin', jwtAuth, adminRoutes);

// ✅ Staff routes use modular structure
app.use('/api/v1/staff', jwtAuth, staffRoutes);

// ✅ Fallback rate limiter
app.use(genericLimiter);

// ✅ Sentry Error Handler
app.use(Sentry.Handlers.errorHandler());

// ✅ Global Error Handler
app.use(errorHandlerMiddleware);

// ✅ Log available routes for debugging (optional)
if (process.env.NODE_ENV === 'development') {
  console.log('\n👥 Available Staff Routes:');
  console.log('  Staff Management:');
  console.log('  - GET  /api/v1/staff/list');
  console.log('  - GET  /api/v1/staff/:identifier');
  console.log('  - GET  /api/v1/staff/department/:department');
  console.log('  - GET  /api/v1/staff/shift/:shift');
  console.log('  - GET  /api/v1/staff/stats/summary');
  console.log('  - POST /api/v1/staff/create');
  console.log('  - PUT  /api/v1/staff/:id');
  
  console.log('  Attendance:');
  console.log('  - POST /api/v1/staff/attendance');
  console.log('  - GET  /api/v1/staff/attendance/:id');
  
  console.log('  HR Management:');
  console.log('  - GET  /api/v1/staff/hr/dashboard');
  console.log('  - GET  /api/v1/staff/hr/performance-report');
  console.log('  - POST /api/v1/staff/hr/performance-review');
  console.log('  - GET  /api/v1/staff/hr/onboarding/:staff_id');
  console.log('  - PUT  /api/v1/staff/hr/onboarding/:staff_id/task');
  console.log('  - GET  /api/v1/staff/hr/leave-balance/:staff_id');
  console.log('  - POST /api/v1/staff/hr/leave/apply');
  console.log('  - GET  /api/v1/staff/hr/department/:department/summary');
  console.log('  - GET  /api/v1/staff/hr/attendance-analytics');
  console.log('  - GET  /api/v1/staff/hr/export-report');
  
  console.log('  Medical Documents:');
  console.log('  - POST /api/v1/staff/medical/consultations');
  console.log('  - POST /api/v1/staff/medical/investigations');
  
  console.log('  Pharmacy:');
  console.log('  - POST /api/v1/staff/pharmacy/orders');

  console.log('\n💊 Available Pharmacy Routes:');
  console.log('  - GET  /api/v1/pharmacy-orders/test');
  console.log('  - POST /api/v1/pharmacy-orders/orders');
  console.log('  - GET  /api/v1/pharmacy-orders/orders/:phone');
  console.log('  - GET  /api/v1/pharmacy-orders/orders/uid/:uid');
  console.log('  - PUT  /api/v1/pharmacy-orders/orders/:orderId/status');
  console.log('  - GET  /api/v1/pharmacy-orders/medications');
  console.log('  - GET  /api/v1/pharmacy-orders/medications/:id');
  console.log('  - POST /api/v1/pharmacy-orders/medications');
  console.log('  - PUT  /api/v1/pharmacy-orders/medications/:id');
  console.log('  - DELETE /api/v1/pharmacy-orders/medications/:id');
  console.log('  - PUT  /api/v1/pharmacy-orders/medications/:id/stock');
  console.log('  - GET  /api/v1/pharmacy-orders/medications/category/:category');
  console.log('  - GET  /api/v1/pharmacy-orders/search');
  console.log('  - GET  /api/v1/pharmacy-orders/inventory/low-stock');
  console.log('  - GET  /api/v1/pharmacy-orders/inventory/expired');
  console.log('  - GET  /api/v1/pharmacy-orders/inventory/expiring-soon');
  console.log('  - GET  /api/v1/pharmacy-orders/inventory/summary');
  console.log('  - GET  /api/v1/pharmacy-orders/categories/list');
  console.log('  - GET  /api/v1/pharmacy-orders/admin/orders');
  console.log('  - GET  /api/v1/pharmacy-orders/admin/analytics');

  console.log('\n🔬 Available Investigation Routes:');
  console.log('  - GET  /api/v1/investigations/test');
  console.log('  - GET  /api/v1/investigations/list');
  console.log('  - GET  /api/v1/investigations/:id');
  console.log('  - GET  /api/v1/investigations/patient/:patient_id');
  console.log('  - GET  /api/v1/investigations/doctor/:doctor_id');
  console.log('  - GET  /api/v1/investigations/type/:type');
  console.log('  - GET  /api/v1/investigations/status/pending');
  console.log('  - POST /api/v1/investigations/order');
  console.log('  - PUT  /api/v1/investigations/:id/status');
  console.log('  - PUT  /api/v1/investigations/:id/results');
  console.log('  - GET  /api/v1/investigations/stats/summary');
  console.log('  - GET  /api/v1/investigations/:phone (legacy)');
  console.log('  - GET  /api/v1/investigations/uid/:uid (legacy)');
  console.log('  - POST /api/v1/investigations/ (legacy)');

  console.log('\n📅 Available Appointment Routes:');
  console.log('  - GET  /api/v1/appointments/test');
  console.log('  - GET  /api/v1/appointments/list');
  console.log('  - GET  /api/v1/appointments/:id');
  console.log('  - GET  /api/v1/appointments/doctor/:doctor_id');
  console.log('  - GET  /api/v1/appointments/patient/:patient_id');
  console.log('  - GET  /api/v1/appointments/today/list');
  console.log('  - POST /api/v1/appointments/book');
  console.log('  - PUT  /api/v1/appointments/:id');
  console.log('  - PUT  /api/v1/appointments/:id/status');
  console.log('  - DELETE /api/v1/appointments/:id');
  console.log('  - GET  /api/v1/appointments/phone/:phone (legacy)');
  console.log('  - GET  /api/v1/appointments/uid/:uid (legacy)');
  console.log('  - POST /api/v1/appointments/ (legacy)');

  console.log('\n📋 Available Record Routes:');
  console.log('  - GET  /api/v1/records/test');
  console.log('  - GET  /api/v1/records/uid/:uid');
  console.log('  - GET  /api/v1/records/health-records/:phone');
  console.log('  - POST /api/v1/records/health-records');
  console.log('  - GET  /api/v1/records/consultations/:phoneNumber (legacy)');
  console.log('  - GET  /api/v1/records/list');
  console.log('  - GET  /api/v1/records/record/:id');
  console.log('  - GET  /api/v1/records/patient/:patient_id');
  console.log('  - GET  /api/v1/records/doctor/:doctor_id');
  console.log('  - GET  /api/v1/records/patient/:patient_id/summary');
  console.log('  - POST /api/v1/records/create');
  console.log('  - PUT  /api/v1/records/:id');
  console.log('  - GET  /api/v1/records/admin/analytics');
  console.log('  - GET  /api/v1/records/admin/hipaa-audit');
  console.log('  - DELETE /api/v1/records/:id');

  console.log('\n🏥 Available Health Routes:');
  console.log('  Public Routes:');
  console.log('  - GET  /api/v1/health/');
  console.log('  - GET  /api/v1/health/health-check');
  console.log('  - GET  /api/v1/health/app-version');
  console.log('  - GET  /api/v1/health/system/status');
  console.log('  Protected Routes:');
  console.log('  - GET  /api/v1/health/test');
  console.log('  - GET  /api/v1/health/records');
  console.log('  - GET  /api/v1/health/records/:id');
  console.log('  - POST /api/v1/health/records');
  console.log('  - PUT  /api/v1/health/records/:id');
  console.log('  - GET  /api/v1/health/patient/:patient_id/summary');
  console.log('  - GET  /api/v1/health/patient/:patient_id/trends');
  console.log('  - GET  /api/v1/health/patient/:patient_id/allergies');
  console.log('  - GET  /api/v1/health/patient/:patient_id/conditions');
  console.log('  - GET  /api/v1/health/stats/overview');
}
export default app;