// src/utils/validateEnv.js

import Joi from 'joi';
import logger from '../logging/logger.js';

// Define the expected environment variables schema
const envSchema = Joi.object({
  API_KEY: Joi.string().required().label('API_KEY'),
  JWT_SECRET: Joi.string().min(32).required().label('JWT_SECRET'),
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
  CF_ACCOUNT_ID: Joi.string().optional().label('CF_ACCOUNT_ID'),
  CF_R2_BUCKET: Joi.string().optional().label('CF_R2_BUCKET'),
  CF_R2_URL: Joi.string().uri().optional().label('CF_R2_URL'),
  CF_R2_ACCESS_KEY_ID: Joi.string().optional().label('CF_R2_ACCESS_KEY_ID'),
  CF_R2_SECRET_ACCESS_KEY: Joi.string().optional().label('CF_R2_SECRET_ACCESS_KEY'),

  // Firebase — optional but warn if missing
  FIREBASE_AUTH_ENABLED: Joi.string().valid('true', 'false').optional().label('FIREBASE_AUTH_ENABLED'),
  FIREBASE_PROJECT_ID: Joi.string().optional().label('FIREBASE_PROJECT_ID'),
  FIREBASE_CLIENT_EMAIL: Joi.string().email().optional().label('FIREBASE_CLIENT_EMAIL'),
  FIREBASE_PRIVATE_KEY: Joi.string().optional().label('FIREBASE_PRIVATE_KEY'),
  GOOGLE_APPLICATION_CREDENTIALS: Joi.string().optional().label('GOOGLE_APPLICATION_CREDENTIALS'),

  // Monitoring — optional but warn if missing
  SENTRY_DSN: Joi.string().optional().label('SENTRY_DSN'),

  // Encryption — optional but recommended for production
  FIELD_ENCRYPTION_KEY: Joi.string().min(32).optional().label('FIELD_ENCRYPTION_KEY'),
  TOTP_ENCRYPTION_KEY: Joi.string().min(32).optional().label('TOTP_ENCRYPTION_KEY'),

  // Admin IP allowlist — optional, comma-separated IPs/CIDRs
  ADMIN_IP_ALLOWLIST: Joi.string().optional().label('ADMIN_IP_ALLOWLIST'),
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
if (!envVars.CF_ACCOUNT_ID || !envVars.CF_R2_BUCKET || !envVars.CF_R2_URL || !envVars.CF_R2_ACCESS_KEY_ID || !envVars.CF_R2_SECRET_ACCESS_KEY) {
  optionalWarnings.push('R2 storage credentials (CF_ACCOUNT_ID, CF_R2_BUCKET, CF_R2_URL, CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY) are not fully configured — file uploads will fail');
}
if (envVars.FIREBASE_AUTH_ENABLED === 'true') {
  const hasFirebaseCert = !!(envVars.FIREBASE_PROJECT_ID && envVars.FIREBASE_CLIENT_EMAIL && envVars.FIREBASE_PRIVATE_KEY);
  const hasFirebaseAdc = !!(envVars.FIREBASE_PROJECT_ID && envVars.GOOGLE_APPLICATION_CREDENTIALS);
  if (!hasFirebaseCert && !hasFirebaseAdc) {
    optionalWarnings.push('Firebase auth is enabled but Firebase Admin credentials are incomplete — set FIREBASE_PROJECT_ID plus FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY or GOOGLE_APPLICATION_CREDENTIALS');
  }
} else if (!envVars.FIREBASE_PROJECT_ID) {
  optionalWarnings.push('FIREBASE_PROJECT_ID is not set — Firebase authentication will not work if enabled');
}
if (!envVars.SENTRY_DSN) {
  optionalWarnings.push('SENTRY_DSN is not set — error monitoring is disabled');
}
if (!envVars.FIELD_ENCRYPTION_KEY) {
  optionalWarnings.push('FIELD_ENCRYPTION_KEY is not set — field-level encryption will use JWT_SECRET as fallback (not recommended for production)');
}
if (!envVars.TOTP_ENCRYPTION_KEY) {
  optionalWarnings.push('TOTP_ENCRYPTION_KEY is not set — TOTP secrets will use JWT_SECRET as fallback (not recommended for production)');
}
if (optionalWarnings.length > 0) {
  optionalWarnings.forEach(w => logger.warn(`⚠️  ${w}`));
}

// Export validated environment variables for safe usage elsewhere
export default envVars;
