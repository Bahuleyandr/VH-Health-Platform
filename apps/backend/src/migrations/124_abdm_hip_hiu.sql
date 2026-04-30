-- Migration 124: Phase D1 — ABDM HIP / HIU full flow.
--
-- HEALTHCARE_AI_SPEC_AUDIT.md §20: today abdm_consents +
-- abdm_data_requests exist but only as a partial implementation.
-- Full ABDM compliance needs:
--   - ABHA profile master per patient
--   - Facility + practitioner registry mappings (HFR / HPR)
--   - CareContext (separate from generic abdm_consents)
--   - Split ConsentRequest / ConsentArtifact
--   - DataTransfer + WebhookEvent + IntegrationLog
--   - Sandbox / prod env isolation per tenant
--
-- This migration adds eight tables on top of the existing two
-- (abdm_consents, abdm_data_requests stay as-is — they are operational
-- working tables; the new tables are master + audit + transfer).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. abha_profiles (per-patient ABHA address master)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS abha_profiles (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid                 UUID NOT NULL,
  abha_id                     VARCHAR(40) NOT NULL,
  abha_address                VARCHAR(120),
  full_name                   VARCHAR(255),
  date_of_birth               DATE,
  gender                      VARCHAR(20),
  state_code                  VARCHAR(20),
  district_code               VARCHAR(20),
  pincode                     VARCHAR(20),
  kyc_verified                BOOLEAN NOT NULL DEFAULT false,
  kyc_method                  VARCHAR(40)
    CHECK (kyc_method IS NULL OR kyc_method IN ('aadhaar_otp', 'mobile_otp', 'face_auth', 'manual', 'other')),
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deactivated', 'archived')),
  linked_at                   TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, abha_id),
  UNIQUE (tenant_id, patient_uid)
);

CREATE INDEX IF NOT EXISTS idx_abha_profiles_tenant_status
  ON abha_profiles (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_abha_profiles_address
  ON abha_profiles (tenant_id, abha_address)
  WHERE abha_address IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. abdm_facility_mappings (HFR — Health Facility Registry)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS abdm_facility_mappings (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id                 INTEGER,
  hfr_id                      VARCHAR(120) NOT NULL,
  facility_name               VARCHAR(255) NOT NULL,
  ownership_kind              VARCHAR(40)
    CHECK (ownership_kind IS NULL OR ownership_kind IN (
      'private', 'government', 'trust', 'corporate', 'cooperative', 'public_private', 'other'
    )),
  facility_kind               VARCHAR(40)
    CHECK (facility_kind IS NULL OR facility_kind IN (
      'hospital', 'clinic', 'lab', 'pharmacy', 'imaging_center', 'wellness_center', 'other'
    )),
  registration_status         VARCHAR(20) NOT NULL DEFAULT 'unverified'
    CHECK (registration_status IN ('unverified', 'pending', 'verified', 'rejected', 'suspended')),
  state_code                  VARCHAR(20),
  district_code               VARCHAR(20),
  pincode                     VARCHAR(20),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, hfr_id)
);

CREATE INDEX IF NOT EXISTS idx_abdm_facility_tenant_status
  ON abdm_facility_mappings (tenant_id, registration_status);
CREATE INDEX IF NOT EXISTS idx_abdm_facility_facility
  ON abdm_facility_mappings (facility_id) WHERE facility_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. abdm_practitioner_mappings (HPR — Health Professional Registry)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS abdm_practitioner_mappings (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_uid                   UUID,
  hpr_id                      VARCHAR(120) NOT NULL,
  full_name                   VARCHAR(255) NOT NULL,
  specialty                   VARCHAR(120),
  council_name                VARCHAR(120),
  registration_number         VARCHAR(120),
  registration_year           INTEGER,
  qualification               VARCHAR(255),
  status                      VARCHAR(20) NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'pending', 'verified', 'rejected', 'suspended')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, hpr_id)
);

CREATE INDEX IF NOT EXISTS idx_abdm_practitioner_tenant_status
  ON abdm_practitioner_mappings (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_abdm_practitioner_staff
  ON abdm_practitioner_mappings (staff_uid) WHERE staff_uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. abdm_care_contexts (linked records under HIP)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS abdm_care_contexts (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  abha_profile_id             INTEGER REFERENCES abha_profiles(id) ON DELETE CASCADE,
  patient_uid                 UUID NOT NULL,
  facility_mapping_id         INTEGER REFERENCES abdm_facility_mappings(id) ON DELETE SET NULL,
  reference_id                VARCHAR(120) NOT NULL,
  display                     VARCHAR(255),
  hi_type                     VARCHAR(60) NOT NULL
    CHECK (hi_type IN (
      'OPConsultation', 'DischargeSummary', 'Prescription',
      'DiagnosticReport', 'ImmunizationRecord', 'WellnessRecord',
      'HealthDocumentRecord'
    )),
  source_resource_type        VARCHAR(60),
  source_resource_id          VARCHAR(120),
  status                      VARCHAR(20) NOT NULL DEFAULT 'linked'
    CHECK (status IN ('draft', 'linked', 'unlinked', 'archived')),
  linked_at                   TIMESTAMPTZ,
  unlinked_at                 TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_care_contexts_tenant_patient
  ON abdm_care_contexts (tenant_id, patient_uid, status);
CREATE INDEX IF NOT EXISTS idx_care_contexts_hi_type
  ON abdm_care_contexts (tenant_id, hi_type, status);
CREATE INDEX IF NOT EXISTS idx_care_contexts_abha
  ON abdm_care_contexts (abha_profile_id) WHERE abha_profile_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. abdm_consent_requests (HIU sends consent request to HIE-CM)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS abdm_consent_requests (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id                  VARCHAR(120) NOT NULL,
  flow_kind                   VARCHAR(20) NOT NULL DEFAULT 'hiu'
    CHECK (flow_kind IN ('hiu', 'hip', 'self')),
  abha_id                     VARCHAR(40),
  abha_profile_id             INTEGER REFERENCES abha_profiles(id) ON DELETE SET NULL,
  patient_uid                 UUID,
  requester_uid               UUID,
  hi_types                    TEXT[] NOT NULL DEFAULT '{}',
  permission_kind             VARCHAR(40) NOT NULL DEFAULT 'view'
    CHECK (permission_kind IN ('view', 'store', 'view_store')),
  data_from                   TIMESTAMPTZ,
  data_to                     TIMESTAMPTZ,
  expiry_at                   TIMESTAMPTZ,
  purpose_code                VARCHAR(20) NOT NULL DEFAULT 'CAREMGT'
    CHECK (purpose_code IN ('CAREMGT', 'BTG', 'PUBHTH', 'HPAYMT', 'DSRCH', 'PATRQT', 'OTHER')),
  status                      VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'granted', 'denied', 'revoked', 'expired', 'failed')),
  requested_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at                  TIMESTAMPTZ,
  notification_failure        TEXT,
  environment                 VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, request_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_consent_requests_tenant_status
  ON abdm_consent_requests (tenant_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_requests_abha
  ON abdm_consent_requests (tenant_id, abha_id, status)
  WHERE abha_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_requests_patient
  ON abdm_consent_requests (tenant_id, patient_uid, status)
  WHERE patient_uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. abdm_consent_artifacts (HIE-CM-issued artifact)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS abdm_consent_artifacts (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consent_request_id          INTEGER REFERENCES abdm_consent_requests(id) ON DELETE SET NULL,
  artifact_id                 VARCHAR(120) NOT NULL,
  abha_id                     VARCHAR(40),
  patient_uid                 UUID,
  hi_types                    TEXT[] NOT NULL DEFAULT '{}',
  permission_kind             VARCHAR(40) NOT NULL,
  data_from                   TIMESTAMPTZ,
  data_to                     TIMESTAMPTZ,
  expiry_at                   TIMESTAMPTZ,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  signed_payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_kid               VARCHAR(120),
  signature_algorithm         VARCHAR(40),
  granted_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at                  TIMESTAMPTZ,
  expired_at                  TIMESTAMPTZ,
  environment                 VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, artifact_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_consent_artifacts_tenant_status
  ON abdm_consent_artifacts (tenant_id, status, granted_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_artifacts_request
  ON abdm_consent_artifacts (consent_request_id) WHERE consent_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_artifacts_active_expiry
  ON abdm_consent_artifacts (tenant_id, expiry_at)
  WHERE status = 'active' AND expiry_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. abdm_data_transfers (HIP push of bundle to HIU)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS abdm_data_transfers (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consent_artifact_id         INTEGER REFERENCES abdm_consent_artifacts(id) ON DELETE SET NULL,
  transaction_id              VARCHAR(120) NOT NULL,
  patient_uid                 UUID,
  abha_id                     VARCHAR(40),
  direction                   VARCHAR(8) NOT NULL DEFAULT 'out'
    CHECK (direction IN ('out', 'in')),
  bundle_kind                 VARCHAR(60),
  payload_size_bytes          BIGINT,
  encryption_kind             VARCHAR(40)
    CHECK (encryption_kind IS NULL OR encryption_kind IN (
      'ecdh_aes_256_gcm', 'ecdh_aes_128_gcm', 'rsa_oaep', 'manual', 'other'
    )),
  destination_url             TEXT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed', 'partial')),
  attempt_count               INTEGER NOT NULL DEFAULT 0,
  started_at                  TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  failure_reason              TEXT,
  hi_types                    TEXT[] NOT NULL DEFAULT '{}',
  environment                 VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, transaction_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_data_transfers_tenant_status
  ON abdm_data_transfers (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_transfers_artifact
  ON abdm_data_transfers (consent_artifact_id) WHERE consent_artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_transfers_patient
  ON abdm_data_transfers (tenant_id, patient_uid, status)
  WHERE patient_uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 8. abdm_webhook_events (idempotency-tracked inbound webhook log)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS abdm_webhook_events (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_event_id           VARCHAR(160) NOT NULL,
  event_type                  VARCHAR(120) NOT NULL,
  source                      VARCHAR(80),
  signature_verified          BOOLEAN NOT NULL DEFAULT false,
  signature_kid               VARCHAR(120),
  payload                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processed', 'duplicate', 'failed', 'rejected')),
  processed_at                TIMESTAMPTZ,
  failure_reason              TEXT,
  related_request_id          INTEGER REFERENCES abdm_consent_requests(id) ON DELETE SET NULL,
  related_artifact_id         INTEGER REFERENCES abdm_consent_artifacts(id) ON DELETE SET NULL,
  related_transfer_id         INTEGER REFERENCES abdm_data_transfers(id) ON DELETE SET NULL,
  environment                 VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, external_event_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_abdm_webhooks_tenant_status
  ON abdm_webhook_events (tenant_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_abdm_webhooks_event_type
  ON abdm_webhook_events (tenant_id, event_type, received_at DESC);

COMMIT;
