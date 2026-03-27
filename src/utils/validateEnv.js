// src/utils/validateEnv.js

import Joi from 'joi';
import logger from '../logging/logger.js';

// Define the expected environment variables schema
const envSchema = Joi.object({
  API_KEY: Joi.string().required().label('API_KEY'),
  DATABASE_URL: Joi.string().uri().required().label('DATABASE_URL'),
  ALLOWED_ORIGINS: Joi.string().default('http://localhost:3000').label('ALLOWED_ORIGINS'),
  PORT: Joi.number().default(5000).label('PORT'),
  RATE_LIMIT_WINDOW_MS: Joi.number().optional().label('RATE_LIMIT_WINDOW_MS'),
  RATE_LIMIT_MAX: Joi.number().optional().label('RATE_LIMIT_MAX'),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development')
    .label('NODE_ENV'),

  // Storage credentials — optional but warn if missing
  R2_ACCESS_KEY_ID: Joi.string().optional().label('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: Joi.string().optional().label('R2_SECRET_ACCESS_KEY'),
  R2_BUCKET_NAME: Joi.string().optional().label('R2_BUCKET_NAME'),

  // Firebase — optional but warn if missing
  FIREBASE_PROJECT_ID: Joi.string().optional().label('FIREBASE_PROJECT_ID'),

  // Monitoring — optional but warn if missing
  SENTRY_DSN: Joi.string().optional().label('SENTRY_DSN'),
}).unknown(true);

// Validate the current environment variables
const { error, value: envVars } = envSchema.validate(process.env);

// Handle validation errors by terminating the application
if (error) {
  logger.error('❌ Environment validation error:', error.details.map(d => d.message).join(', '));
  process.exit(1);
}

// Warn about missing optional service credentials
const optionalWarnings = [];
if (!envVars.R2_ACCESS_KEY_ID || !envVars.R2_SECRET_ACCESS_KEY || !envVars.R2_BUCKET_NAME) {
  optionalWarnings.push('R2 storage credentials (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME) are not fully configured — file uploads will fail');
}
if (!envVars.FIREBASE_PROJECT_ID) {
  optionalWarnings.push('FIREBASE_PROJECT_ID is not set — Firebase authentication will not work');
}
if (!envVars.SENTRY_DSN) {
  optionalWarnings.push('SENTRY_DSN is not set — error monitoring is disabled');
}
if (optionalWarnings.length > 0) {
  optionalWarnings.forEach(w => logger.warn(`⚠️  ${w}`));
}

// Export validated environment variables for safe usage elsewhere
export default envVars;
