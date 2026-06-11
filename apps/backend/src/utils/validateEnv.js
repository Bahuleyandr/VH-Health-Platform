// src/utils/validateEnv.js

import Joi from 'joi';
import logger from '../logging/logger.js';

// Minimum key length for all at-rest encryption keys (base64-encoded 32 bytes = 44 chars,
// but Joi.min counts characters; 32 is the floor below which we refuse to boot).
const MIN_KEY_LENGTH = 32;

const ENCRYPTION_KEY_HELP =
  'Generate with `openssl rand -base64 32` and store as a SealedSecret in the cluster. ' +
  'See docs/DEPLOYMENT_GUIDE.md#secrets for the full procedure.';

const SIGNED_INTEGRATION_SECRET_HELP =
  'Generate with `openssl rand -base64 32` and store as a SealedSecret. ' +
  'HL7_INBOUND_SHARED_SECRET signs inbound HL7 writes; ABDM_CALLBACK_SECRET signs public ABDM callbacks.';

// Define the expected environment variables schema
const envSchema = Joi.object({
  API_KEY: Joi.string().required().label('API_KEY'),
  HL7_INBOUND_SHARED_SECRET: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(MIN_KEY_LENGTH).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('HL7_INBOUND_SHARED_SECRET'),
  JWT_SECRET: Joi.string().min(32).required().label('JWT_SECRET'),
  DATABASE_URL: Joi.string().uri().required().label('DATABASE_URL'),
  ALLOWED_ORIGINS: Joi.string().default('http://localhost:3000').label('ALLOWED_ORIGINS'),
  PORT: Joi.number().default(5000).label('PORT'),
  RATE_LIMIT_WINDOW_MS: Joi.number().optional().label('RATE_LIMIT_WINDOW_MS'),
  RATE_LIMIT_MAX: Joi.number().optional().label('RATE_LIMIT_MAX'),
  // E6 — hours between lab-result sign-off and automatic patient release
  // (0 = release immediately at sign-off; clinician hold always wins).
  PORTAL_RESULT_RELEASE_DELAY_HOURS: Joi.number().min(0).max(720).optional()
    .label('PORTAL_RESULT_RELEASE_DELAY_HOURS'),
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
  SENTRY_DSN: Joi.string().allow('').optional().label('SENTRY_DSN'),

  // PACS / imaging viewer (roadmap B4) — optional until the optional/pacs
  // module is enabled. When unset, /api/v1/pacs/config reports enabled=false
  // and study links carry no viewer URL.
  PACS_DICOMWEB_URL: Joi.string().uri().allow('').optional().label('PACS_DICOMWEB_URL'),
  PACS_VIEWER_URL: Joi.string().uri().allow('').optional().label('PACS_VIEWER_URL'),
  PACS_AET: Joi.string().max(16).allow('').optional().label('PACS_AET'),

  // Encryption — MANDATORY. No JWT_SECRET fallback (compliance footgun).
  // Each key protects a different class of data and MUST be rotated independently.
  //   FIELD_ENCRYPTION_KEY  — at-rest PHI columns (names, DOB, diagnosis, etc.)
  //   TOTP_ENCRYPTION_KEY   — user TOTP shared secrets
  //   BACKUP_ENCRYPTION_KEY — openssl-encrypted DB dumps (deploy/backup scripts)
  FIELD_ENCRYPTION_KEY: Joi.string()
    .min(MIN_KEY_LENGTH)
    .required()
    .label('FIELD_ENCRYPTION_KEY'),
  TOTP_ENCRYPTION_KEY: Joi.string()
    .min(MIN_KEY_LENGTH)
    .required()
    .label('TOTP_ENCRYPTION_KEY'),
  BACKUP_ENCRYPTION_KEY: Joi.string()
    .min(MIN_KEY_LENGTH)
    .required()
    .label('BACKUP_ENCRYPTION_KEY'),

  // Admin IP allowlist — optional, comma-separated IPs/CIDRs
  ADMIN_IP_ALLOWLIST: Joi.string().optional().label('ADMIN_IP_ALLOWLIST'),

  // Feature flag: enforce mandatory TOTP MFA enrollment for SUPER_ADMIN accounts.
  // When 'true', a SUPER_ADMIN without totp_enabled cannot obtain a full-access
  // JWT — login returns an mfa_setup_required response carrying a short-lived
  // setup token scoped only to the /mfa/setup-enroll + /mfa/setup-confirm routes.
  // Defaults to 'true' in prod; jest.setup.cjs pins it to 'false' for tests.
  REQUIRE_MFA_FOR_SUPER_ADMIN: Joi.string()
    .valid('true', 'false')
    .default('true')
    .label('REQUIRE_MFA_FOR_SUPER_ADMIN'),

  // Tenant RLS enforcement. The runtime defaults this on in production when
  // unset; explicit false is reserved for confirmed single-tenant deployments.
  AUTH_ENFORCE_TENANT_RLS: Joi.string()
    .valid('true', 'false')
    .allow('')
    .optional()
    .label('AUTH_ENFORCE_TENANT_RLS'),
  AUTH_TENANT_RLS_TEST_ROLE: Joi.string()
    .allow('')
    .optional()
    .label('AUTH_TENANT_RLS_TEST_ROLE'),

  // WHO ICD API — optional until ICD-11 lookup is enabled for a deployment.
  // Cloud API uses OAuth2 client credentials; a local WHO ICD deployment may
  // set WHO_ICD_DISABLE_AUTH=true and point WHO_ICD_BASE_URL at the local host.
  WHO_ICD_BASE_URL: Joi.string().uri().allow('').optional().label('WHO_ICD_BASE_URL'),
  WHO_ICD_AUTH_URL: Joi.string().uri().allow('').optional().label('WHO_ICD_AUTH_URL'),
  WHO_ICD_CLIENT_ID: Joi.string().allow('').optional().label('WHO_ICD_CLIENT_ID'),
  WHO_ICD_CLIENT_SECRET: Joi.string().allow('').optional().label('WHO_ICD_CLIENT_SECRET'),
  WHO_ICD_RELEASE_ID: Joi.string().allow('').optional().label('WHO_ICD_RELEASE_ID'),
  WHO_ICD_LANGUAGE: Joi.string().allow('').optional().label('WHO_ICD_LANGUAGE'),
  WHO_ICD_TIMEOUT_MS: Joi.number().min(1000).max(60000).optional().label('WHO_ICD_TIMEOUT_MS'),
  WHO_ICD_DISABLE_AUTH: Joi.string().valid('true', 'false').allow('').optional().label('WHO_ICD_DISABLE_AUTH'),

  // Signed public/integration callbacks. ABDM callbacks are public by mount
  // and HL7 inbound clinical writes intentionally sit before global JWT auth,
  // so production must fail closed if the HMAC secrets are not provisioned.
  ABDM_ENABLED: Joi.string().valid('true', 'false').default('false').label('ABDM_ENABLED'),
  ABDM_HIP_ID: Joi.when('ABDM_ENABLED', {
    is: 'true',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('ABDM_HIP_ID'),
  ABDM_CALLBACK_SECRET: Joi.when('ABDM_ENABLED', {
    is: 'true',
    then: Joi.string().min(MIN_KEY_LENGTH).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('ABDM_CALLBACK_SECRET'),
}).unknown(true);

// Validate the current environment variables
const { error, value: envVars } = envSchema.validate(process.env, { abortEarly: false });

// Handle validation errors by terminating the application
if (error) {
  const details = error.details.map(d => d.message);
  const mentionsEncryptionKey = details.some(msg =>
    /FIELD_ENCRYPTION_KEY|TOTP_ENCRYPTION_KEY|BACKUP_ENCRYPTION_KEY/.test(msg),
  );
  const mentionsSignedIntegrationSecret = details.some(msg =>
    /HL7_INBOUND_SHARED_SECRET|ABDM_CALLBACK_SECRET|ABDM_HIP_ID/.test(msg),
  );

  logger.error('❌ Environment validation failed:');
  details.forEach(msg => logger.error(`   • ${msg}`));

  if (mentionsEncryptionKey) {
    logger.error('');
    logger.error('FIELD_ENCRYPTION_KEY, TOTP_ENCRYPTION_KEY, and BACKUP_ENCRYPTION_KEY are mandatory.');
    logger.error(ENCRYPTION_KEY_HELP);
  }

  if (mentionsSignedIntegrationSecret) {
    logger.error('');
    logger.error('Signed integration callback secrets are mandatory when their endpoints can process PHI or clinical writes.');
    logger.error(SIGNED_INTEGRATION_SECRET_HELP);
  }

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
if (optionalWarnings.length > 0) {
  optionalWarnings.forEach(w => logger.warn(`⚠️  ${w}`));
}

// Export validated environment variables for safe usage elsewhere
export default envVars;
