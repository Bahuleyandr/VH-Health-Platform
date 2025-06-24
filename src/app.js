// src/app.js - HYBRID VERSION (keeps your working parts)

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
import staffRoutes from './routes/staffRoutes.js';
import departmentRoutes from './routes/departmentRoutes.js';
import rbacRoutes from './routes/rbacRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import doctorRoutes from './routes/doctorRoutes.js';  // ✅ Added missing
import notificationRoutes from './routes/notificationRoutes.js';  // ✅ Added missing
import deviceRoutes from './routes/deviceRoutes.js';  // ✅ Added missing
import firebaseAuthRoutes from './routes/firebaseAuthRoutes.js';  // ✅ Added missing

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

// ✅ Debug Routes (secured by JWT) - Keep your existing approach
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
app.use('/api/v1/firebase-auth', patientRateLimiter, firebaseAuthRoutes);  // ✅ Added missing
app.use('/api/v1/otp', patientRateLimiter, routes.otp);
app.use('/api/v1/lookup', routes.lookup);
app.use('/api/v1/version', routes.version);
app.use('/api/v1/health', routes.health);

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
app.use('/api/v1/appointments', patientRateLimiter, routes.appointments);
app.use('/api/v1/records', patientRateLimiter, routes.healthRecords);
app.use('/api/v1/investigations', patientRateLimiter, routes.investigations);
app.use('/api/v1/pharmacy-orders', patientRateLimiter, routes.pharmacy);
app.use('/api/v1/feedback', patientRateLimiter, routes.feedback);
app.use('/api/v1/sos', patientRateLimiter, routes.sos);
app.use('/api/v1/upload', routes.upload);
app.use('/api/v1/departments', departmentRoutes);  // Keep your existing approach
app.use('/api/v1/doctors', doctorRoutes);  // ✅ Added missing
app.use('/api/v1/notifications', notificationRoutes);  // ✅ Added missing
app.use('/api/v1/devices', deviceRoutes);  // ✅ Added missing

// ✅ JWT-Protected Admin/Staff Routes - Keep your existing approach
app.use('/api/v1/admin/rbac', jwtAuth, rbacRoutes);
app.use('/api/v1/admin/analytics', jwtAuth, analyticsRoutes);
app.use('/api/v1/admin', jwtAuth, adminRoutes);
app.use('/api/v1/staff', jwtAuth, staffRoutes);

// ✅ Fallback rate limiter
app.use(genericLimiter);

// ✅ Sentry Error Handler
app.use(Sentry.Handlers.errorHandler());

// ✅ Global Error Handler
app.use(errorHandlerMiddleware);

export default app;