// src/app.js

import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

import logger from './logging/logger.js';
import loggingMiddleware from './middleware/loggingMiddleware.js';
import errorHandlerMiddleware from './middleware/errorHandlerMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';
import jwtAuth from './middleware/jwtMiddleware.js';
import corsMiddleware from './middleware/corsMiddleware.js';
import authMiddleware from './middleware/authMiddleware.js';
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js';

import debugRoutes from './routes/debugRoutes.js';
import routes from './routes/index.js';
import adminRoutes from './routes/adminRoutes.js';
import staffRoutes from './routes/staffRoutes.js';
import departmentRoutes from './routes/departmentRoutes.js';

import {
  patientRateLimiter,
  genericLimiter
} from './middleware/rateLimitMiddleware.js';

import swaggerLoader from './utils/swaggerLoader.js';

// ✅ Load .env from local file if available, else rely on Render secrets
dotenv.config();
import './utils/validateEnv.js';

const app = express(); // ✅ define app before using it
app.set('trust proxy', 1); // ✅ Required for Render or Cloudflare

// ✅ JWT-Protected Debug Routes
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
app.use(loggingMiddleware);          // Log incoming requests
app.use(logger.morganMiddleware);
app.use(normalizeIdentityFields);    // Normalize phone, uid, etc.

// ✅ Swagger Docs (no API key required)
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ✅ Public Routes — no API Key, no JWT
app.use('/api/v1/auth', patientRateLimiter, routes.auth);
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
app.use('/api/v1/departments', departmentRoutes);

// ✅ JWT-Protected Admin/Staff Routes
app.use('/api/v1/admin', jwtAuth, adminRoutes);
app.use('/api/v1/staff', jwtAuth, staffRoutes);

// ✅ Fallback rate limiter
app.use(genericLimiter);

// ✅ Global Error Handler
app.use(errorHandlerMiddleware);

export default app;
