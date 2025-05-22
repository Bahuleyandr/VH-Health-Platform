// src/app.js
import fs from 'fs';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';

import loggingMiddleware from './middleware/loggingMiddleware.js';
import errorHandlerMiddleware from './middleware/errorHandlerMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';
import routes from './routes/index.js';
import swaggerLoader from './utils/swaggerLoader.js';
import logger from './logging/logger.js';
import jwtAuth from './middleware/jwtMiddleware.js';
import corsMiddleware from './middleware/corsMiddleware.js';
import authMiddleware from './middleware/authMiddleware.js';
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js';

import adminRoutes from './routes/adminRoutes.js';
import staffRoutes from './routes/staffRoutes.js';
import {
  patientRateLimiter,
  genericLimiter
} from './middleware/rateLimitMiddleware.js';

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
app.set('trust proxy', 1); // ✅ Required for Render, Cloudflare, etc.

// ✅ Load Swagger Documentation
let swaggerDocument;
try {
  swaggerDocument = swaggerLoader();
  if (!swaggerDocument) throw new Error('Failed to load Swagger documentation.');
  console.log('✅ Swagger documentation validated and loaded.');
} catch (err) {
  console.error('❌ Failed to load or validate Swagger documentation:', err.message);
  process.exit(1);
}

// ✅ Base Middleware (CORS, JSON, security)
app.use(helmet());
app.use(express.json());
app.use(corsMiddleware);

// ✅ Normalize identity input before anything else
app.use(normalizeIdentityFields);

// ✅ Apply logger and API key checks early
app.use(loggingMiddleware);
app.use(validateApiKey);
app.use(logger.morganMiddleware);

// ✅ Serve Swagger API Docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ✅ Mount public routes before JWT auth
// ⛔ Must be before JWT to avoid forcing token on /auth
app.use('/api/v1/auth', patientRateLimiter);
app.use('/api/v1/otp', patientRateLimiter);
app.use('/', routes); // ✅ mounts /auth, /otp, /lookup, etc.

// ✅ JWT Enforcement begins here (admin/staff require it)
app.use(authMiddleware);

// ✅ Auth-protected Routes
app.use('/api/v1/admin', jwtAuth, adminRoutes);
app.use('/api/v1/staff', jwtAuth, staffRoutes);

// ✅ Rate-limited authenticated user routes
app.use('/api/v1/users', patientRateLimiter);
app.use('/api/v1/appointments', patientRateLimiter);
app.use('/api/v1/records', patientRateLimiter);
app.use('/api/v1/investigations', patientRateLimiter);
app.use('/api/v1/pharmacy-orders', patientRateLimiter);
app.use('/api/v1/feedback', patientRateLimiter);
app.use('/api/v1/sos', patientRateLimiter);

// ✅ Apply fallback rate limit for anything else
app.use(genericLimiter);

// ✅ Root Health Check
app.get('/', (req, res) => {
  res.json({ message: 'VH Health API is running.' });
});

// ✅ Global Error Handler
app.use(errorHandlerMiddleware);

export default app;
