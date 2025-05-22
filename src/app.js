// src/app.js
import fs from 'fs';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

import loggingMiddleware from './middleware/loggingMiddleware.js';
import errorHandlerMiddleware from './middleware/errorHandlerMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';
import jwtAuth from './middleware/jwtMiddleware.js';
import corsMiddleware from './middleware/corsMiddleware.js';
import authMiddleware from './middleware/authMiddleware.js';
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js';

import routes from './routes/index.js';
import adminRoutes from './routes/adminRoutes.js';
import staffRoutes from './routes/staffRoutes.js';

import {
  patientRateLimiter,
  genericLimiter
} from './middleware/rateLimitMiddleware.js';

import swaggerLoader from './utils/swaggerLoader.js';
import logger from './logging/logger.js';

// ✅ Load .env from appropriate file
if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else if (fs.existsSync('.env.render')) {
  dotenv.config({ path: '.env.render' });
} else {
  dotenv.config();
}
import './utils/validateEnv.js';

const app = express();
app.set('trust proxy', 1); // ✅ Required for Render or behind Cloudflare

// ✅ Swagger Load
let swaggerDocument;
try {
  swaggerDocument = swaggerLoader();
  if (!swaggerDocument) throw new Error('Failed to load Swagger documentation.');
  console.log('✅ Swagger documentation validated and loaded.');
} catch (err) {
  console.error('❌ Failed to load or validate Swagger documentation:', err.message);
  process.exit(1);
}

// ✅ Core Middleware Stack
app.use(helmet());
app.use(express.json());
app.use(corsMiddleware);
app.use(normalizeIdentityFields);
app.use(authMiddleware); // Attaches req.user if token is present
app.use(loggingMiddleware);
app.use(logger.morganMiddleware);

// ✅ Swagger Docs (no API Key check needed)
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ✅ Public routes — No API Key or JWT required
app.use('/api/v1/auth', patientRateLimiter, routes.auth);
app.use('/api/v1/otp', patientRateLimiter, routes.otp);
app.use('/api/v1/lookup', routes.lookup);
app.use('/api/v1/version', routes.version);
app.use('/api/v1/health', routes.health);

// ✅ Apply API Key check for protected routes
app.use(validateApiKey);

// ✅ Authenticated routes (no JWT needed)
app.use('/api/v1/users', patientRateLimiter, routes.users);
app.use('/api/v1/appointments', patientRateLimiter, routes.appointments);
app.use('/api/v1/records', patientRateLimiter, routes.healthRecords);
app.use('/api/v1/investigations', patientRateLimiter, routes.investigations);
app.use('/api/v1/pharmacy-orders', patientRateLimiter, routes.pharmacy);
app.use('/api/v1/feedback', patientRateLimiter, routes.feedback);
app.use('/api/v1/sos', patientRateLimiter, routes.sos);
app.use('/api/v1/upload', routes.upload);

// ✅ JWT-protected routes
app.use('/api/v1/admin', jwtAuth, adminRoutes);
app.use('/api/v1/staff', jwtAuth, staffRoutes);

// ✅ Catch-all limiter for remaining endpoints
app.use(genericLimiter);

// ✅ Fallback Health Check
app.get('/', (req, res) => {
  res.json({ message: 'VH Health API is running.' });
});

// ✅ Error handler
app.use(errorHandlerMiddleware);

export default app;
