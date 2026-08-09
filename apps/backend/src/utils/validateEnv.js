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
  'Set HL7_INBOUND_ENABLED=true only after provisioning HL7_INBOUND_SHARED_SECRET; ' +
  'ABDM_CALLBACK_SECRET signs public ABDM callbacks.';

// Define the expected environment variables schema
// Exported for unit tests (the module-level validation below runs at import).
export const envSchema = Joi.object({
  API_KEY: Joi.string().required().label('API_KEY'),
  HL7_INBOUND_ENABLED: Joi.string().valid('true', 'false').default('false').label('HL7_INBOUND_ENABLED'),
  HL7_INBOUND_SHARED_SECRET: Joi.when('HL7_INBOUND_ENABLED', {
    is: 'true',
    then: Joi.string().min(MIN_KEY_LENGTH).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('HL7_INBOUND_SHARED_SECRET'),
  JWT_SECRET: Joi.string().min(32).required().label('JWT_SECRET'),
  DATABASE_URL: Joi.string().uri().required().label('DATABASE_URL'),
  ALLOWED_ORIGINS: Joi.string().default('http://localhost:3000').label('ALLOWED_ORIGINS'),
  PORT: Joi.number().default(5000).label('PORT'),
  RATE_LIMIT_WINDOW_MS: Joi.number().optional().label('RATE_LIMIT_WINDOW_MS'),
  RATE_LIMIT_MAX: Joi.number().optional().label('RATE_LIMIT_MAX'),

  // Cap on tenant-scoped staff push fan-out (staffPushRecipientService).
  // .max(500) is the Firebase multicast ceiling: sendPushNotification THROWS
  // above 500 tokens, so an operator raising this to "stop dropping recipients"
  // would flip the path from notifying 500 staff to notifying zero. Failing at
  // boot is better than that. The service clamps again at runtime.
  STAFF_PUSH_FANOUT_CAP: Joi.number().integer().min(1).max(500).optional()
    .label('STAFF_PUSH_FANOUT_CAP'),

  // ── Clinical credential-gate enforcement flags (see config/privilegeGates.js) ──
  // Each turns ON credential enforcement for one clinical act; default OFF.
  // Registered here so the canonical flag names are documented in ONE place.
  // Values are intentionally NOT strictly validated — a bad value must not crash
  // the app (validateEnv exits on any schema error); it simply reads as "off".
  // The authoritative runtime read is gateFlagEnabled()/isGateEnabled() against
  // process.env, and logPrivilegeGateStates() prints each gate's resolved state
  // at boot so a mistyped flag can't silently leave a gate disabled unnoticed.
  THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE: Joi.string().optional().label('THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE'),
  THEATRE_REQUIRE_OT_READY_SURGEON_PRIVILEGE: Joi.string().optional().label('THEATRE_REQUIRE_OT_READY_SURGEON_PRIVILEGE'),
  ANESTHESIA_REQUIRE_FINALIZE_PRIVILEGE: Joi.string().optional().label('ANESTHESIA_REQUIRE_FINALIZE_PRIVILEGE'),
  CTVS_ENFORCE_PERFUSIONIST_SIGNOFF_PRIVILEGE: Joi.string().optional().label('CTVS_ENFORCE_PERFUSIONIST_SIGNOFF_PRIVILEGE'),
  CATH_LAB_PRIVILEGE_GATE_ENABLED: Joi.string().optional().label('CATH_LAB_PRIVILEGE_GATE_ENABLED'),
  CHEMO_REQUIRE_ADMIN_PRIVILEGE: Joi.string().optional().label('CHEMO_REQUIRE_ADMIN_PRIVILEGE'),
  CONTROLLED_SUBSTANCE_REQUIRE_PRESCRIBE_PRIVILEGE: Joi.string().optional().label('CONTROLLED_SUBSTANCE_REQUIRE_PRESCRIBE_PRIVILEGE'),
  RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED: Joi.string().optional().label('RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED'),
  OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED: Joi.string().optional().label('OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED'),
  // Optional per-gate privilege-key overrides (advanced; defaults in privilegeGates.js).
  RADIATION_ONCOLOGY_PRIVILEGE_KEY: Joi.string().optional().label('RADIATION_ONCOLOGY_PRIVILEGE_KEY'),
  OBGYN_LABOUR_WARD_PRIVILEGE_KEY: Joi.string().optional().label('OBGYN_LABOUR_WARD_PRIVILEGE_KEY'),

  // Patient hard-upgrade gate served by public GET /api/v1/config.
  // 0 disables the gate; otherwise set this to the minimum accepted mobile
  // build number. Semver advisory checks remain on /health/client-requirements.
  MIN_PATIENT_VERSION_CODE: Joi.number()
    .integer()
    .min(0)
    .default(0)
    .label('MIN_PATIENT_VERSION_CODE'),
  PATIENT_OUTAGE_COMMUNICATION_JSON: Joi.string()
    .max(16 * 1024)
    .allow('')
    .optional()
    .label('PATIENT_OUTAGE_COMMUNICATION_JSON'),

  // HTTP server timeouts (REL-4 / B2.4). Defaults: requestTimeout=60s,
  // keepAliveTimeout=61s, headersTimeout=65s. keepAlive < headers is required
  // to avoid the Node.js race where headersTimeout fires before keepAlive on
  // a persistent connection, causing an abrupt ECONNRESET. All are optional.
  HTTP_REQUEST_TIMEOUT_MS:   Joi.number().min(0).optional().label('HTTP_REQUEST_TIMEOUT_MS'),
  HTTP_KEEPALIVE_TIMEOUT_MS: Joi.number().min(0).optional().label('HTTP_KEEPALIVE_TIMEOUT_MS'),
  HTTP_HEADERS_TIMEOUT_MS:   Joi.number().min(0).optional().label('HTTP_HEADERS_TIMEOUT_MS'),

  // Global express.json / urlencoded body limit (audit §5). OPTIONAL — defaults
  // to '1mb' in app.js when unset. Conservative on purpose: JSON parsing is a
  // CPU-bound DoS surface and file uploads go through multer, not express.json.
  // Accepts a bytes() string ('1mb', '512kb') or a raw byte count.
  HTTP_BODY_LIMIT: Joi.string()
    .pattern(/^\d+(\.\d+)?\s*(b|kb|mb|gb)?$/i)
    .allow('')
    .optional()
    .label('HTTP_BODY_LIMIT'),

  // App-layer DB statement timeout (DB-2 / B2.8). Applied to the PRIMARY
  // connection via ?options=-c statement_timeout=<ms> in the URL (session
  // default; overridden to 120s inside migration transactions). Default 30000.
  // STATEMENT_TIMEOUT_READ_MS applies to the read replica only; 0 = leave at
  // the CNPG cluster default (analytics queries may legitimately exceed 30s).
  STATEMENT_TIMEOUT_MS:      Joi.number().min(0).optional().label('STATEMENT_TIMEOUT_MS'),
  STATEMENT_TIMEOUT_READ_MS: Joi.number().min(0).optional().label('STATEMENT_TIMEOUT_READ_MS'),
  // E6 — hours between lab-result sign-off and automatic patient release
  // (0 = release immediately at sign-off; clinician hold always wins).
  PORTAL_RESULT_RELEASE_DELAY_HOURS: Joi.number().min(0).max(720).optional()
    .label('PORTAL_RESULT_RELEASE_DELAY_HOURS'),
  // Max active clinicians ONE escalation tier will page for a single task
  // (services/workflow/escalationEngineService.js). A blast-radius backstop, not
  // a page size: exceeding it is a misconfigured-rule signal and is always
  // logged + counted. Unset = 500; values above 5000 clamp to 5000.
  // Bounded at the same ceiling the service clamps to, so an out-of-range value
  // fails loudly at boot instead of being silently clamped — silent clamping is
  // the exact failure mode this setting exists to remove.
  ESCALATION_RECIPIENT_FANOUT_CAP: Joi.number().integer().min(1).max(5000).optional()
    .label('ESCALATION_RECIPIENT_FANOUT_CAP'),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development')
    .label('NODE_ENV'),

  // Dev-only OTP bypass opt-in. When 'true' (and NODE_ENV is NOT production),
  // OTP generation returns the fixed '123456' for local/CI flows that cannot
  // complete a real OTP round-trip (see config/otpConfig.js). OPTIONAL and
  // OFF by default. Fail-closed: under NODE_ENV=production the value 'true' is
  // REJECTED at startup so a stray flag can never weaken OTP security in prod
  // (the runtime guard in otpConfig.js is the second line of defence).
  ALLOW_DEV_OTP: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('false', '').optional()
      .messages({ 'any.only': 'ALLOW_DEV_OTP must not be "true" when NODE_ENV=production' }),
    otherwise: Joi.string().valid('true', 'false').allow('').optional(),
  }).label('ALLOW_DEV_OTP'),

  // Base host for per-tenant subdomain resolution (audit 2026-06-22 W3-H2).
  // tenantFromHost() parses "<slug>-api.<TENANT_BASE_HOST>" → tenant slug; when
  // unset it falls back to "localhost", so any real per-tenant host fails to
  // parse and resolves to the DEFAULT tenant — a cross-tenant exposure path that
  // also silently disables the W4 Host↔token cross-check. FAIL-CLOSED: under
  // NODE_ENV=production this MUST be set to a real host (not localhost). Dev/test
  // may leave it unset (localhost fallback is correct there).
  TENANT_BASE_HOST: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(1).invalid('localhost').required().messages({
      'any.required': 'TENANT_BASE_HOST must be set in production (e.g. "vhhealth.app") so per-tenant subdomains resolve correctly instead of defaulting cross-tenant',
      'string.empty': 'TENANT_BASE_HOST must be set in production (e.g. "vhhealth.app")',
      'any.invalid': 'TENANT_BASE_HOST must not be "localhost" in production',
    }),
    otherwise: Joi.string().allow('').optional(),
  }).label('TENANT_BASE_HOST'),

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
  // Firebase App Check verification for app-facing traffic: off = skip,
  // report = verify + metrics only (never rejects). Enforcement is not an
  // accepted runtime mode until a separate client-rollout change adds it.
  APP_CHECK_MODE: Joi.string().valid('off', 'report').default('off').label('APP_CHECK_MODE'),
  FIREBASE_APP_CHECK_PATIENT_APP_IDS: Joi.when('APP_CHECK_MODE', {
    is: 'report',
    then: Joi.string().trim().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('FIREBASE_APP_CHECK_PATIENT_APP_IDS'),
  FIREBASE_APP_CHECK_STAFF_APP_IDS: Joi.when('APP_CHECK_MODE', {
    is: 'report',
    then: Joi.string().trim().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('FIREBASE_APP_CHECK_STAFF_APP_IDS'),

  // Monitoring — optional but warn if missing
  SENTRY_DSN: Joi.string().allow('').optional().label('SENTRY_DSN'),

  // C3.1 signed continuity generation is disabled by default. Legacy static
  // ward packs retain their temp fallback, but the signed writer requires an
  // explicit operator-owned root whenever it is enabled.
  CLINICAL_CONTINUITY_PACKS_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('CLINICAL_CONTINUITY_PACKS_ENABLED'),
  CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED'),
  CLINICAL_CONTINUITY_REPLAY_RECEIPTS_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('CLINICAL_CONTINUITY_REPLAY_RECEIPTS_ENABLED'),
  CLINICAL_CONTINUITY_PAPER_RECONCILIATION_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('CLINICAL_CONTINUITY_PAPER_RECONCILIATION_ENABLED'),
  DOWNTIME_MIRROR_DIR: Joi.when('CLINICAL_CONTINUITY_PACKS_ENABLED', {
    is: 'true',
    then: Joi.string().trim().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('DOWNTIME_MIRROR_DIR'),

  // PACS / imaging viewer (roadmap B4) — optional until the optional/pacs
  // module is enabled. When unset, /api/v1/pacs/config reports enabled=false
  // and study links carry no viewer URL.
  PACS_DICOMWEB_URL: Joi.string().uri().allow('').optional().label('PACS_DICOMWEB_URL'),
  PACS_VIEWER_URL: Joi.string().uri().allow('').optional().label('PACS_VIEWER_URL'),
  PACS_AET: Joi.string().max(16).allow('').optional().label('PACS_AET'),

  // Embedded BI (NL-10 B1) — optional until Metabase is enabled. The Metabase
  // deployment must use the analytics warehouse marts role only, never OLTP.
  METABASE_URL: Joi.string().uri().allow('').optional().label('METABASE_URL'),
  METABASE_EMBED_SECRET: Joi.string().allow('').optional().label('METABASE_EMBED_SECRET'),
  METABASE_DASH_DAILY_OPS: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_DAILY_OPS'),
  METABASE_DASH_OPD_VOLUME: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_OPD_VOLUME'),
  METABASE_DASH_IP_OCCUPANCY: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_IP_OCCUPANCY'),
  METABASE_DASH_PAYER_MIX: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_PAYER_MIX'),
  METABASE_DASH_LAB_TAT: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_LAB_TAT'),
  METABASE_DASH_DOCTOR_PROD: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_DOCTOR_PROD'),
  METABASE_DASH_OR_THROUGHPUT: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_OR_THROUGHPUT'),
  METABASE_DASH_SAFETY: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_SAFETY'),

  // Encryption — MANDATORY. No JWT_SECRET fallback (compliance footgun).
  // Each key protects a different class of data and MUST be rotated independently.
  //   FIELD_ENCRYPTION_KEY  — at-rest PHI columns (names, DOB, diagnosis, etc.)
  //   TOTP_ENCRYPTION_KEY   — user TOTP shared secrets
  //   BACKUP_ENCRYPTION_KEY — openssl-encrypted DB dumps (deploy/backup scripts)
  FIELD_ENCRYPTION_KEY: Joi.string()
    .min(MIN_KEY_LENGTH)
    .required()
    .label('FIELD_ENCRYPTION_KEY'),
  // Envelope-encryption KEK for enc:v2: field payloads. OPTIONAL: when unset,
  // the KEK is derived from FIELD_ENCRYPTION_KEY so existing deployments keep
  // working with no new secret. Set a dedicated value (openssl rand -base64 32)
  // to separate the KEK from the legacy data key. FIELD_ENCRYPTION_KEK_ID stamps
  // the keyId into each payload (default 'local-v1'); FIELD_ENCRYPTION_KEK_OLD*
  // let a single process unwrap DEKs still wrapped under a retired KEK during
  // rotation (see scripts/rotate-field-kek.mjs).
  FIELD_ENCRYPTION_KEK: Joi.string()
    .min(MIN_KEY_LENGTH)
    .allow('')
    .optional()
    .label('FIELD_ENCRYPTION_KEK'),
  FIELD_ENCRYPTION_KEK_ID: Joi.string().allow('').optional().label('FIELD_ENCRYPTION_KEK_ID'),
  FIELD_ENCRYPTION_KEK_OLD: Joi.string()
    .min(MIN_KEY_LENGTH)
    .allow('')
    .optional()
    .label('FIELD_ENCRYPTION_KEK_OLD'),
  FIELD_ENCRYPTION_KEK_OLD_ID: Joi.string().allow('').optional().label('FIELD_ENCRYPTION_KEK_OLD_ID'),
  // Separate HMAC key for searchableHash() (deterministic search index). OPTIONAL:
  // when unset, defaults to the legacy-derived key so existing search hashes keep
  // matching. Rotating to a real value REQUIRES scripts/rebuild-search-hashes.mjs.
  FIELD_SEARCH_HMAC_KEY: Joi.string()
    .min(MIN_KEY_LENGTH)
    .allow('')
    .optional()
    .label('FIELD_SEARCH_HMAC_KEY'),
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

  // NL-1 SSO operational bounds. IdP issuer/client/secret/SAML cert config stays
  // tenant-scoped in tenant_identity_providers; these are only global safety
  // limits for outbound metadata calls and assertion validation.
  SSO_OIDC_HTTP_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(30000)
    .default(5000)
    .label('SSO_OIDC_HTTP_TIMEOUT_MS'),
  SSO_METADATA_CACHE_TTL_SECONDS: Joi.number()
    .integer()
    .min(30)
    .max(3600)
    .default(300)
    .label('SSO_METADATA_CACHE_TTL_SECONDS'),
  SSO_ASSERTION_CLOCK_SKEW_SECONDS: Joi.number()
    .integer()
    .min(0)
    .max(600)
    .default(60)
    .label('SSO_ASSERTION_CLOCK_SKEW_SECONDS'),
  SSO_SAML_MAX_ASSERTION_BYTES: Joi.number()
    .integer()
    .min(4096)
    .max(2 * 1024 * 1024)
    .default(256 * 1024)
    .label('SSO_SAML_MAX_ASSERTION_BYTES'),
  SSO_DEBUG_ASSERTION_LOGGING: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('false', '').optional()
      .messages({ 'any.only': 'SSO_DEBUG_ASSERTION_LOGGING must not be "true" when NODE_ENV=production' }),
    otherwise: Joi.string().valid('true', 'false').allow('').optional(),
  }).label('SSO_DEBUG_ASSERTION_LOGGING'),

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
  // Clinical AI operational alert sweep — advisory, flag-gated. Off by default.
  // Enable in .env when the sweep is ready for a deployment.
  CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED: Joi.string()
    .valid('true', 'false')
    .allow('')
    .optional()
    .label('CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED'),

  // Nightly clinical-coding suggestion batch — review-gated drafts only, off
  // by default (double-gated with the clinical_coding_assist module toggle).
  CLINICAL_AI_CODING_BATCH_ENABLED: Joi.string()
    .valid('true', 'false')
    .allow('')
    .optional()
    .label('CLINICAL_AI_CODING_BATCH_ENABLED'),
  CLINICAL_AI_CODING_BATCH_LIMIT: Joi.number()
    .min(1)
    .max(100)
    .optional()
    .label('CLINICAL_AI_CODING_BATCH_LIMIT'),
  CLINICAL_AI_CODING_BATCH_LOOKBACK_DAYS: Joi.number()
    .min(1)
    .max(90)
    .optional()
    .label('CLINICAL_AI_CODING_BATCH_LOOKBACK_DAYS'),

  PATHWAY_PROJECTOR_SHADOW_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('PATHWAY_PROJECTOR_SHADOW_ENABLED'),

  CARE_PATHWAY_RECONCILIATION_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('CARE_PATHWAY_RECONCILIATION_ENABLED'),
  CARE_PATHWAY_RECONCILIATION_REPAIR_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('CARE_PATHWAY_RECONCILIATION_REPAIR_ENABLED'),
  CARE_PATHWAY_RECONCILIATION_CRON: Joi.string()
    .max(100)
    .allow('')
    .optional()
    .label('CARE_PATHWAY_RECONCILIATION_CRON'),

  // External clinical-AI PHI egress region allowlist (comma-separated, e.g.
  // `US,AP`). FAIL-CLOSED default (audit 2026-06-18): when empty/unset, a tenant
  // that carries a region is DENIED external use — external egress is allowed
  // ONLY for explicitly allow-listed regions. A tenant with no region tagged is
  // still allowed under an empty allowlist (single-tenant pilot escape). Set the
  // literal sentinel `*` to deliberately allow EVERY region. Enforced in
  // src/services/ai/localLlmClient.js#tenantCanUseExternal.
  CLINICAL_AI_EXTERNAL_REGIONS: Joi.string()
    .allow('')
    .optional()
    .label('CLINICAL_AI_EXTERNAL_REGIONS'),

  // Staff dictation V1 STT engine. Warn-tier only: missing or partial values
  // keep the backend bootable and /clinical/voice-note/config reports
  // configured=false so staff UI can disable dictation honestly.
  STT_PROVIDER: Joi.string().allow('').optional().label('STT_PROVIDER'),
  STT_BASE_URL: Joi.string().allow('').optional().label('STT_BASE_URL'),
  STT_MODEL: Joi.string().allow('').optional().label('STT_MODEL'),
  STT_TIMEOUT_MS: Joi.string().allow('').optional().label('STT_TIMEOUT_MS'),
  STT_LANGUAGE: Joi.string().allow('').optional().label('STT_LANGUAGE'),
  STT_PROMPT: Joi.string().allow('').optional().label('STT_PROMPT'),
  STT_API_KEY: Joi.string().allow('').optional().label('STT_API_KEY'),

  REVENUE_CYCLE_TRACKER_ENABLED: Joi.string()
    .valid('true', 'false')
    .allow('')
    .optional()
    .label('REVENUE_CYCLE_TRACKER_ENABLED'),

  // NL-2 NHCX claims exchange. P1 builds inert/mock-first and must remain off
  // until operators lock the live NHCX/NRCeS version, sandbox enrolment,
  // participant codes, gateway URLs, and certificate/JWE requirements.
  NHCX_ENABLED: Joi.string().valid('true', 'false').default('false').label('NHCX_ENABLED'),
  NHCX_CREDENTIAL_CACHE_TTL_MS: Joi.number().min(1000).max(900000).optional()
    .label('NHCX_CREDENTIAL_CACHE_TTL_MS'),

  // NL-3 P1 teleconsult media. Disabled by default: deployments must
  // explicitly provision self-hosted LiveKit inside hospital-owned infra before
  // any room or token endpoint can mint access. Recording/Egress is not
  // configured for MVP.
  LIVEKIT_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('LIVEKIT_ENABLED'),
  LIVEKIT_SERVER_URL: Joi.when('LIVEKIT_ENABLED', {
    is: 'true',
    then: Joi.string().uri({ scheme: ['http', 'https', 'ws', 'wss'] }).required(),
    otherwise: Joi.string().uri({ scheme: ['http', 'https', 'ws', 'wss'] }).allow('').optional(),
  }).label('LIVEKIT_SERVER_URL'),
  LIVEKIT_API_KEY: Joi.when('LIVEKIT_ENABLED', {
    is: 'true',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('LIVEKIT_API_KEY'),
  LIVEKIT_API_SECRET: Joi.when('LIVEKIT_ENABLED', {
    is: 'true',
    then: Joi.string().min(MIN_KEY_LENGTH).required(),
    otherwise: Joi.string().min(MIN_KEY_LENGTH).allow('').optional(),
  }).label('LIVEKIT_API_SECRET'),
  TELECONSULT_TOKEN_TTL_SECONDS: Joi.number()
    .integer()
    .min(300)
    .max(600)
    .default(600)
    .label('TELECONSULT_TOKEN_TTL_SECONDS'),

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
  // CAN-026: Consent-Manager artefact signature verification is a mandatory
  // trust layer for the national health network — an ABDM-enabled deployment
  // must run with it ON and a CM public key present, so it can't silently accept
  // unsigned/forged consent artefacts.
  ABDM_VERIFY_CONSENT_ARTEFACT: Joi.when('ABDM_ENABLED', {
    is: 'true',
    then: Joi.string().valid('true').required(),
    otherwise: Joi.string().valid('true', 'false').allow('').optional(),
  }).label('ABDM_VERIFY_CONSENT_ARTEFACT'),
  ABDM_CM_PUBLIC_KEY: Joi.when('ABDM_ENABLED', {
    is: 'true',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('ABDM_CM_PUBLIC_KEY'),
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
if (!envVars.DOWNTIME_MIRROR_DIR && envVars.CLINICAL_CONTINUITY_PACKS_ENABLED !== 'true') {
  optionalWarnings.push('DOWNTIME_MIRROR_DIR is not set — static downtime ward-pack mirror falls back to an OS-temp directory; packs will not survive a pod restart/outage or be LAN-synced (point it at a shared hostPath/Longhorn volume — see docs/DOWNTIME_PROCEDURE.md)');
}
const sttProvider = String(envVars.STT_PROVIDER || '').trim().toLowerCase().replace(/_/g, '-');
if (sttProvider && !['none', 'openai-compatible'].includes(sttProvider)) {
  optionalWarnings.push(`STT_PROVIDER=${envVars.STT_PROVIDER} is unsupported for staff dictation V1 — expected none or openai-compatible; dictation will report unconfigured`);
}
if (sttProvider === 'openai-compatible') {
  if (!envVars.STT_BASE_URL || !envVars.STT_MODEL) {
    optionalWarnings.push('STT_PROVIDER=openai-compatible is set but STT_BASE_URL/STT_MODEL are incomplete — /clinical/voice-note/config will report dictation as unconfigured');
  }
  const sttTimeout = Number.parseInt(envVars.STT_TIMEOUT_MS || '', 10);
  if (envVars.STT_TIMEOUT_MS && (!Number.isFinite(sttTimeout) || sttTimeout < 60000)) {
    optionalWarnings.push('STT_TIMEOUT_MS should be a number >= 60000 for local STT engines; runtime will clamp to a safe minimum');
  }
}
if (optionalWarnings.length > 0) {
  optionalWarnings.forEach(w => logger.warn(`⚠️  ${w}`));
}

// Export validated environment variables for safe usage elsewhere
export default envVars;
