// src/utils/validateEnv.js

import Joi from 'joi';
import {
  FILE_SCAN_POLICY,
  FILE_SCAN_POLICY_VALUES,
  describeFileScanPolicy,
} from '../config/fileScanPolicy.js';
import logger from '../logging/logger.js';
import { patientMinimumVersionPolicyFromEnv } from '../services/patientMinimumVersionPolicy.js';

// Minimum key length for all at-rest encryption keys (base64-encoded 32 bytes = 44 chars,
// but Joi.min counts characters; 32 is the floor below which we refuse to boot).
const MIN_KEY_LENGTH = 32;
const ABHA_ENROLMENT_SANDBOX_HOST = 'abhasbx.abdm.gov.in';
const NON_PRODUCTION_HOST_LABEL = /(^|[.-])(dev|sandbox|sbx)([.-]|$)/i;

function rejectProductionAbhaSandboxHost(value, helpers) {
  if (new URL(value).hostname.toLowerCase() === ABHA_ENROLMENT_SANDBOX_HOST) {
    return helpers.error('any.invalid');
  }
  return value;
}

function rejectProductionAbdmNonProductionHost(value, helpers) {
  const hostname = new URL(value).hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname === '0.0.0.0'
    || hostname === '[::1]'
    || hostname.endsWith('.local')
    || /^127\./.test(hostname)
    || NON_PRODUCTION_HOST_LABEL.test(hostname)
  ) {
    return helpers.error('any.invalid');
  }
  return value;
}

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

  // Redis is optional for local single-process development. Production uses
  // the in-cluster three-Sentinel topology and opts into fail-closed discovery
  // with REDIS_REQUIRE_SENTINEL=true; it must never fall back to REDIS_URL.
  REDIS_REQUIRE_SENTINEL: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('REDIS_REQUIRE_SENTINEL'),
  REDIS_URL: Joi.when('REDIS_REQUIRE_SENTINEL', {
    is: 'true',
    then: Joi.forbidden().messages({
      'any.unknown': 'REDIS_URL must be unset when REDIS_REQUIRE_SENTINEL=true',
    }),
    otherwise: Joi.string().uri({ scheme: ['redis', 'rediss'] }).allow('').optional(),
  }).label('REDIS_URL'),
  REDIS_SENTINEL_HOSTS: Joi.when('REDIS_REQUIRE_SENTINEL', {
    is: 'true',
    then: Joi.string().trim().min(1).required(),
    otherwise: Joi.string().trim().allow('').optional(),
  }).label('REDIS_SENTINEL_HOSTS'),
  REDIS_SENTINEL_MASTER: Joi.when('REDIS_REQUIRE_SENTINEL', {
    is: 'true',
    then: Joi.string().trim().min(1).required(),
    otherwise: Joi.string().trim().allow('').optional(),
  }).label('REDIS_SENTINEL_MASTER'),
  REDIS_USERNAME: Joi.when('REDIS_REQUIRE_SENTINEL', {
    is: 'true',
    then: Joi.string().trim().min(1).invalid('default').required(),
    otherwise: Joi.string().trim().min(1).default('default'),
  }).label('REDIS_USERNAME'),
  REDIS_SENTINEL_USERNAME: Joi.when('REDIS_REQUIRE_SENTINEL', {
    is: 'true',
    then: Joi.string().trim().min(1).invalid('default').required(),
    otherwise: Joi.string().trim().min(1).default('default'),
  }).label('REDIS_SENTINEL_USERNAME'),
  REDIS_PASSWORD: Joi.when('REDIS_REQUIRE_SENTINEL', {
    is: 'true',
    then: Joi.string().min(16).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('REDIS_PASSWORD'),
  REDIS_SENTINEL_PASSWORD: Joi.when('REDIS_REQUIRE_SENTINEL', {
    is: 'true',
    then: Joi.string().min(16).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('REDIS_SENTINEL_PASSWORD'),
  // Hard deadline for boot-time Redis initialization (lib/redis.js). Without
  // it, unreachable Sentinels hang initRedis() forever — the strict-mode
  // fail-fast in bin/www.js never executes and the pod neither becomes ready
  // nor crash-loops (Redis-loss drill 2026-08-15, Finding 2). Floor of 1s so a
  // typo can't make every boot fail; ceiling of 5min so it stays a deadline.
  REDIS_INIT_TIMEOUT_MS: Joi.number().integer().min(1000).max(300000).optional()
    .label('REDIS_INIT_TIMEOUT_MS'),
  // Per-command Redis timeout (lib/redis.js). Bounds commands on blackholed
  // sockets and commands queued behind reconnect backoff — measured unbounded
  // and 15.2s respectively without it. Floor of 100ms so a typo can't fail
  // every healthy command.
  REDIS_COMMAND_TIMEOUT_MS: Joi.number().integer().min(100).max(60000).optional()
    .label('REDIS_COMMAND_TIMEOUT_MS'),

  // Cap on tenant-scoped staff push fan-out (staffPushRecipientService).
  // .max(500) is the Firebase multicast ceiling: sendPushNotification THROWS
  // above 500 tokens, so an operator raising this to "stop dropping recipients"
  // would flip the path from notifying 500 staff to notifying zero. Failing at
  // boot is better than that. The service clamps again at runtime.
  STAFF_PUSH_FANOUT_CAP: Joi.number().integer().min(1).max(500).optional()
    .label('STAFF_PUSH_FANOUT_CAP'),
  NOTIFICATION_OUTBOX_AUTO_REPLAY_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('true')
    .label('NOTIFICATION_OUTBOX_AUTO_REPLAY_ENABLED'),

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
  // A non-zero legacy code with no signed envelope is a PATIENT-BRICKING
  // configuration, not a lesser form of the gate.
  //
  // Patient builds already in the field fail closed when `/config` carries a
  // minimum they cannot verify: they burn the 24h bootstrap grace and then
  // block EVERY install — including installs already above the code, and
  // including the SOS path — with no way past. The client-side gate has since
  // been corrected to fall back to the legacy comparison, but that correction
  // only reaches devices that install the new build. Refusing to boot the
  // half-configured backend is what protects the installs that never will.
  PATIENT_MINIMUM_VERSION_POLICY_JSON: Joi.when('MIN_PATIENT_VERSION_CODE', {
    is: Joi.number().greater(0).required(),
    then: Joi.string().min(1).max(16 * 1024).required(),
    otherwise: Joi.string().max(16 * 1024).allow('').optional(),
  }).label('PATIENT_MINIMUM_VERSION_POLICY_JSON'),
  PATIENT_OUTAGE_COMMUNICATION_JSON: Joi.string()
    .max(16 * 1024)
    .allow('')
    .optional()
    .label('PATIENT_OUTAGE_COMMUNICATION_JSON'),
  // Staff hard-upgrade gate, also served by public GET /api/v1/config as
  // `min_staff_version_code`. 0 disables the gate; otherwise the minimum
  // accepted staff build number. There is deliberately no signed-envelope
  // counterpart (the patient coupling above exists because fielded patient
  // builds fail closed on an unverifiable policy); every staff build
  // implements the unsigned legacy comparison and fails open on an unusable
  // /config, so a bare code is safe.
  MIN_STAFF_VERSION_CODE: Joi.number()
    .integer()
    .min(0)
    .default(0)
    .label('MIN_STAFF_VERSION_CODE'),

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

  // Malware scanning posture for every file the platform accepts from a
  // caller: all byte-ingest paths screen through
  // services/security/fileScanService.js before anything is stored.
  // `required` (default, fail-closed) refuses an upload outright when the local
  // clamd daemon is unreachable, rather than storing bytes no gate will ever
  // release. `disabled_accepted_risk` is an explicit on-the-record declaration
  // that this deployment runs without a scanner; files are stored and served as
  // `not_scanned`. Serving-side, stores that carry a per-row scan_status
  // (file_metadata, staff_message_attachments, investigation_files,
  // consent_signatures, investigation_bookings photos) re-check servability at
  // read time; the remaining stores enforce the policy at ingest only (see the
  // fileScanService header for the exact coverage map). There is deliberately
  // no third "best effort" value — that ambiguity is the defect this setting
  // replaced. See src/config/fileScanPolicy.js.
  FILE_SCAN_POLICY: Joi.string()
    .valid(...FILE_SCAN_POLICY_VALUES)
    .default(FILE_SCAN_POLICY.REQUIRED)
    .label('FILE_SCAN_POLICY'),

  // Firebase — optional but warn if missing
  FIREBASE_AUTH_ENABLED: Joi.string().valid('true', 'false').optional().label('FIREBASE_AUTH_ENABLED'),
  // Opt-OUT kill switch for the sos-alert-age-escalation sweep. Unset means
  // ENABLED — this is the HIGH-1 remediation, so it must not require an env
  // var to be live. Set 'false' only to stop a misbehaving sweep without
  // waiting on a revert commit and a second manual production sync.
  SOS_ALERT_AGE_ESCALATION_ENABLED: Joi.string()
    .valid('true', 'false')
    .optional()
    .label('SOS_ALERT_AGE_ESCALATION_ENABLED'),
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
  // Name matches the metabase_env_var seeded by migration 465 (the old
  // METABASE_DASH_PAYER_MIX name was never read by anything).
  METABASE_DASH_REVENUE_PAYER_MIX: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_REVENUE_PAYER_MIX'),
  METABASE_DASH_LAB_TAT: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_LAB_TAT'),
  METABASE_DASH_DOCTOR_PROD: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_DOCTOR_PROD'),
  METABASE_DASH_OR_THROUGHPUT: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_OR_THROUGHPUT'),
  METABASE_DASH_SAFETY: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_SAFETY'),
  // ── Analytics BI dashboard ids (wt/bi-app, migration 723) ────────────────
  // Registers the migration-465 metabase_env_var names that were missing
  // above (the six legacy METABASE_DASH_* names before this block stay for
  // back-compat; only _DAILY_OPS, _REVENUE_PAYER_MIX, and _LAB_TAT match
  // catalog rows) plus the three names seeded by migration 723.
  METABASE_DASH_BED_FLOW: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_BED_FLOW'),
  METABASE_DASH_OT_UTILIZATION: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_OT_UTILIZATION'),
  METABASE_DASH_ORDERS_TAT: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_ORDERS_TAT'),
  METABASE_DASH_QUALITY_FEEDBACK: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_QUALITY_FEEDBACK'),
  METABASE_DASH_OPERATIONAL_AI_ALERTS: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_OPERATIONAL_AI_ALERTS'),
  METABASE_DASH_PHARMACY_OPS: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_PHARMACY_OPS'),
  METABASE_DASH_COLLECTIONS_RCM: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_COLLECTIONS_RCM'),
  METABASE_DASH_ENCOUNTER_VOLUME: Joi.number().integer().min(0).allow('').optional().label('METABASE_DASH_ENCOUNTER_VOLUME'),

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
  // NB: SSO_DEBUG_ASSERTION_LOGGING was removed (guard, .env.example, and
  // seed) — the knob was validated here but read by no code anywhere; the
  // debug-assertion logging it named was never implemented. If such logging
  // is ever built, reinstate the production-must-be-false guard with it.

  // Tenant RLS enforcement. The runtime defaults this on in production when
  // unset; explicit false is reserved for confirmed single-tenant deployments.
  AUTH_ENFORCE_TENANT_RLS: Joi.string()
    .valid('true', 'false')
    .allow('')
    .optional()
    .label('AUTH_ENFORCE_TENANT_RLS'),
  CARE_TEAM_ENFORCEMENT_MODE: Joi.string()
    .valid('off', 'shadow', 'enforce')
    .optional()
    .label('CARE_TEAM_ENFORCEMENT_MODE'),
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

  // Online payment gateway (UPI + cards) deployment-wide kill switch.
  // Default OFF. Provider credentials are strictly per-tenant rows
  // (payment_gateway_provider_configs, encryptField ciphertext) — no env
  // credentials exist, so enabling requires no additional env keys; the
  // dry_run provider needs no credentials at all.
  PAYMENT_GATEWAY_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false')
    .label('PAYMENT_GATEWAY_ENABLED'),

  // SMS gateway (migrations 699/700). Unset = dry-run everywhere (DEFAULT
  // OFF); 'logger' is the explicit deployment-wide kill switch (tenant
  // configs ignored); 'msg91'/'twilio' enable an env-credential fallback for
  // tenants without their own sms_provider_configs row — per-tenant rows
  // always win, and tenants.settings.sms.enabled still gates every real
  // send. A named env provider must carry complete credentials.
  SMS_PROVIDER: Joi.string()
    .valid('msg91', 'twilio', 'logger')
    .optional()
    .label('SMS_PROVIDER'),
  MSG91_AUTH_KEY: Joi.when('SMS_PROVIDER', {
    is: 'msg91',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('MSG91_AUTH_KEY'),
  MSG91_SENDER_ID: Joi.when('SMS_PROVIDER', {
    is: 'msg91',
    then: Joi.string().min(1).max(20).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('MSG91_SENDER_ID'),
  MSG91_DLT_ENTITY_ID: Joi.when('SMS_PROVIDER', {
    is: 'msg91',
    then: Joi.string().min(1).max(40).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('MSG91_DLT_ENTITY_ID'),
  TWILIO_SMS_FROM: Joi.when('SMS_PROVIDER', {
    is: 'twilio',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('TWILIO_SMS_FROM'),
  // Shared Twilio account credentials (also used by the WhatsApp/voice
  // channels, which only soft-check them at send time) become REQUIRED when
  // the deployment names twilio as the env SMS provider.
  TWILIO_ACCOUNT_SID: Joi.when('SMS_PROVIDER', {
    is: 'twilio',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('TWILIO_ACCOUNT_SID'),
  TWILIO_AUTH_TOKEN: Joi.when('SMS_PROVIDER', {
    is: 'twilio',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('TWILIO_AUTH_TOKEN'),
  PUBLIC_BASE_URL: Joi.when('SMS_PROVIDER', {
    is: 'twilio',
    then: Joi.when('NODE_ENV', {
      is: 'production',
      then: Joi.string().uri({ scheme: ['https'] }).required(),
      otherwise: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
    }),
    otherwise: Joi.string().uri({ scheme: ['http', 'https'] }).allow('').optional(),
  }).label('PUBLIC_BASE_URL'),

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
  // The endpoint-unbound callback contract exists only as an explicit sandbox
  // migration seam. Production must never boot with downgrade acceptance.
  ABDM_CALLBACK_ALLOW_LEGACY_UNBOUND: Joi.when('ABDM_ENVIRONMENT', {
    is: 'production',
    then: Joi.string().valid('false').default('false'),
    otherwise: Joi.string().valid('true', 'false').default('false'),
  }).label('ABDM_CALLBACK_ALLOW_LEGACY_UNBOUND'),
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
  // ABDM completion (migrations 701-703): the environment is EXPLICIT — the
  // gateway previously hardcoded X-CM-ID 'sbx'. Defaults stay sandbox; a
  // production deployment sets ABDM_ENVIRONMENT=production and MUST then name
  // its Consent-Manager id (no production default exists on purpose).
  ABDM_ENVIRONMENT: Joi.string()
    .valid('sandbox', 'production')
    .default('sandbox')
    .label('ABDM_ENVIRONMENT'),
  ABDM_CM_ID: Joi.when('ABDM_ENVIRONMENT', {
    is: 'production',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('ABDM_CM_ID'),
  ABDM_GATEWAY_URL: Joi.when('ABDM_ENVIRONMENT', {
    is: 'production',
    then: Joi.string()
      .uri({ scheme: ['https'] })
      .custom(rejectProductionAbdmNonProductionHost)
      .required(),
    otherwise: Joi.string()
      .uri({ scheme: ['https'] })
      .default('https://dev.abdm.gov.in/gateway'),
  }).label('ABDM_GATEWAY_URL'),
  ABDM_BRIDGE_URL: Joi.when('ABDM_ENVIRONMENT', {
    is: 'production',
    then: Joi.string()
      .uri({ scheme: ['https'] })
      .custom(rejectProductionAbdmNonProductionHost)
      .required(),
    otherwise: Joi.string()
      .uri({ scheme: ['https'] })
      .default('https://dev.abdm.gov.in/devservice/v1'),
  }).label('ABDM_BRIDGE_URL'),
  // ABHA enrolment API base (v3). Sandbox keeps the known-safe default;
  // production must name a non-sandbox host explicitly so Aadhaar/mobile/OTP
  // material cannot cross environments through a forgotten URL override.
  ABHA_ENROLMENT_BASE_URL: Joi.when('ABDM_ENVIRONMENT', {
    is: 'production',
    then: Joi.string()
      .uri({ scheme: ['https'] })
      .custom(rejectProductionAbhaSandboxHost)
      .required(),
    otherwise: Joi.string()
      .uri({ scheme: ['https'] })
      .default('https://abhasbx.abdm.gov.in/abha/api/v3'),
  }).label('ABHA_ENROLMENT_BASE_URL'),
  // Thin-HIU identity; defaults to ABDM_HIP_ID in abdmConfig when unset.
  ABDM_HIU_ID: Joi.string().allow('').optional().label('ABDM_HIU_ID'),

  // UHI (Unified Health Interface / DHP-beckn) adapter — migration 705.
  // Deployment kill switch, default OFF (ship-disabled, zero live
  // credentials). When enabled, the network identity + signing key become
  // mandatory (ABDM_ENABLED conditional-Joi precedent); the gateway public
  // key stays optional because per-tenant verification keys live in
  // tenant_interop_secrets (kind 'uhi_callback').
  UHI_ENABLED: Joi.string().valid('true', 'false').default('false').label('UHI_ENABLED'),
  UHI_GATEWAY_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://gateway.uhi.abdm.gov.in/api/v1')
    .label('UHI_GATEWAY_URL'),
  UHI_SUBSCRIBER_ID: Joi.when('UHI_ENABLED', {
    is: 'true',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('UHI_SUBSCRIBER_ID'),
  UHI_SIGNING_PRIVATE_KEY: Joi.when('UHI_ENABLED', {
    is: 'true',
    then: Joi.string().min(MIN_KEY_LENGTH).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('UHI_SIGNING_PRIVATE_KEY'),
  UHI_SIGNING_KEY_ID: Joi.when('UHI_ENABLED', {
    is: 'true',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }).label('UHI_SIGNING_KEY_ID'),
  UHI_GATEWAY_PUBLIC_KEY: Joi.string().allow('').optional().label('UHI_GATEWAY_PUBLIC_KEY'),
  UHI_ENVIRONMENT: Joi.string()
    .valid('sandbox', 'production')
    .default('sandbox')
    .label('UHI_ENVIRONMENT'),
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

// The Joi rule above only proves the envelope string is PRESENT. A present but
// unparseable / unsigned / malformed envelope is served by GET /api/v1/config
// as `minimum_version_policy` absent plus the bare non-zero legacy code — which
// is byte-for-byte the patient-bricking response the rule exists to prevent. So
// the structural check runs here, where the shared validator can be reused.
//
// Tenant binding is deliberately NOT asserted: `patientMinimumVersionPolicy
// FromEnv` matches `policy.tenant_id` against the tenant resolved PER REQUEST,
// which boot has no single answer for. This proves format, signature shape,
// bounds and grace window; the per-request tenant check stays where it is.
if (Number(envVars.MIN_PATIENT_VERSION_CODE ?? 0) > 0) {
  const envelope = patientMinimumVersionPolicyFromEnv(
    envVars.PATIENT_MINIMUM_VERSION_POLICY_JSON,
    null,
  );
  if (envelope === null) {
    logger.error('❌ Environment validation failed:');
    logger.error(
      `   • PATIENT_MINIMUM_VERSION_POLICY_JSON is not a valid signed minimum-version envelope, but MIN_PATIENT_VERSION_CODE is ${envVars.MIN_PATIENT_VERSION_CODE}.`,
    );
    logger.error('');
    logger.error(
      'Serving a non-zero minimum with no verifiable envelope hard-blocks every patient install that fails closed on an unverifiable policy — including installs already above that code, and including their SOS path.',
    );
    logger.error(
      'Mint the envelope with `npm run patient:min-version:sign -- ...` (apps/backend/scripts/sign-patient-minimum-version-policy.mjs), or set MIN_PATIENT_VERSION_CODE=0 to leave the hard-upgrade gate off.',
    );
    process.exit(1);
  }
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
// Make the file-scanning posture discoverable at boot without reading code:
// an operator scanning pod logs must be able to answer "is this deployment
// scanning uploads?" A declared no-scanner deployment says so out loud every
// start, because it is an accepted risk, not a default.
if (envVars.FILE_SCAN_POLICY === FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK) {
  optionalWarnings.push(
    `FILE_SCAN_POLICY=${FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK} — malware scanning is OFF by explicit configuration. ` +
      'Uploads and staff-message attachments are stored and served with scan_status=not_scanned. ' +
      'Deploy clamd on the node and set FILE_SCAN_POLICY=required to restore scanning.',
  );
} else {
  logger.info(`🛡️  File malware scanning: ${describeFileScanPolicy(envVars)}`);
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
