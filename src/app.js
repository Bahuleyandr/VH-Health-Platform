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
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js'; // ✅ Centralized identity normalization

import adminRoutes from './routes/adminRoutes.js';
import staffRoutes from './routes/staffRoutes.js';
import {
  patientRateLimiter,
  genericLimiter
} from './middleware/rateLimitMiddleware.js';

// ✅ Load Environment Variables
if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
} else if (fs.existsSync('.env.render')) {
  dotenv.config({ path: '.env.render' });
} else {
  dotenv.config();
}

import './utils/validateEnv.js';

const app = express();

// ✅ Load Swagger Documentation
let swaggerDocument;
try {
  swaggerDocument = swaggerLoader();
  if (!swaggerDocument) {
    throw new Error('Failed to load Swagger documentation.');
  }
  console.log('✅ Swagger documentation validated and loaded.');
} catch (err) {
  console.error('❌ Failed to load or validate Swagger documentation:', err.message);
  process.exit(1);
}

// ✅ Middleware Stack (Ordered)
app.use(helmet());
app.use(express.json());
app.use(corsMiddleware);
app.use(normalizeIdentityFields);  // ✅ Normalize phone, uid, gender, optional fields
app.use(authMiddleware);           // ✅ Attach req.user
app.use(loggingMiddleware);        // ✅ Log request details
app.use(validateApiKey);           // ✅ Enforce API key
app.use(logger.morganMiddleware);

// ✅ Swagger Docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ✅ Auth-protected Routes
app.use('/api/v1/admin', jwtAuth, adminRoutes);
app.use('/api/v1/staff', jwtAuth, staffRoutes);

// ✅ Rate Limiting (route-specific)
app.use('/api/v1/auth', patientRateLimiter);
app.use('/api/v1/users', patientRateLimiter);
app.use('/api/v1/appointments', patientRateLimiter);
app.use('/api/v1/records', patientRateLimiter);
app.use('/api/v1/investigations', patientRateLimiter);
app.use('/api/v1/pharmacy-orders', patientRateLimiter);
app.use('/api/v1/feedback', patientRateLimiter);
app.use('/api/v1/otp', patientRateLimiter);
app.use('/api/v1/sos', patientRateLimiter);

// ✅ Generic Limiter for Remaining Routes
app.use(genericLimiter);

// ✅ Main API Routes
app.use('/', routes);

// ✅ Root Health Check
app.get('/', (req, res) => {
  res.json({ message: 'VH Health API is running.' });
});

// ✅ Global Error Handler
app.use(errorHandlerMiddleware);

export default app;
