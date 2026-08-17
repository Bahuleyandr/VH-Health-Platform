-- 703_abdm_hiu_fetch_sessions.sql
--
-- ABDM completion, part 3 of 3 — thin HIU data-fetch evidence.
--
-- The abdmFull layer (124) already carries the HIU-side consent objects
-- (abdm_consent_requests flow_kind='hiu', abdm_consent_artifacts) and a
-- transfer ledger with an inbound slot (abdm_data_transfers direction='in').
-- This migration deliberately EXTENDS that layer rather than duplicating it.
-- What is missing for an actual HIU data fetch:
--
--   1. abdm_hiu_fetch_sessions — the cm/health-information request txn.
--      Unlike the HIP push leg (abdmCrypto: ephemeral keys never persisted),
--      the HIU RECEIVE leg must hold its X25519 private key across the
--      async gap between the hi-request and the HIP's push to our
--      dataPushUrl — so the key is persisted encryptField()-encrypted for
--      the txn lifetime and NULLed by code immediately after decryption
--      ('key material is a liability, not evidence').
--   2. abdm_hiu_received_bundles — references to decrypted FHIR bundles.
--      PHI bundle bytes go to R2 (bundle_storage_key), never into this
--      table; the row is checksum + care-context provenance.
--
-- Clinical-timeline posture: fetched bundles RENDERED transiently to a
-- clinician are PHI access (logPhiAccess), not a clinical write — no
-- timeline row. If a later feature imports a fetched record into the local
-- chart, THAT write takes the standard detail+timeline+audit same-tx rule.
--
-- Status machine (simple CHECK list):
--   requested → acknowledged → receiving → completed | partial | failed | expired
--
-- RLS: 683 request-path pattern. The data-push callback and consent
-- callbacks are pre-RLS mounts — tenant resolved via the 618 authenticated
-- intake (abdm_webhook_events) before any write here; tenant_id always
-- written explicitly.

BEGIN;

CREATE TABLE IF NOT EXISTS abdm_hiu_fetch_sessions (
  id                              SERIAL PRIMARY KEY,
  tenant_id                       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment                     VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CONSTRAINT chk_abdm_hiu_fetch_environment
      CHECK (environment IN ('sandbox', 'production')),
  consent_artifact_id             INTEGER
    REFERENCES abdm_consent_artifacts(id) ON DELETE SET NULL,
  data_transfer_id                INTEGER
    REFERENCES abdm_data_transfers(id) ON DELETE SET NULL,
  patient_uid                     UUID,
  -- ABDM transaction id of the health-information request.
  transaction_id                  VARCHAR(120) NOT NULL,
  request_id                      VARCHAR(120),
  hi_types                        TEXT[] NOT NULL DEFAULT '{}',
  date_range_from                 TIMESTAMPTZ,
  date_range_to                   TIMESTAMPTZ,
  -- Our dataPushUrl handed to the CM for this txn.
  data_push_url                   TEXT,
  -- HIU receive-leg key material: X25519 private key, encryptField()
  -- ciphertext, NULLed by code as soon as all parts are decrypted.
  key_material_private_ciphertext TEXT,
  key_material_nonce              VARCHAR(64),
  key_material_expires_at         TIMESTAMPTZ,
  status                          VARCHAR(24) NOT NULL DEFAULT 'requested'
    CONSTRAINT chk_abdm_hiu_fetch_status
      CHECK (status IN (
        'requested', 'acknowledged', 'receiving',
        'completed', 'partial', 'failed', 'expired'
      )),
  parts_expected                  INTEGER
    CONSTRAINT chk_abdm_hiu_fetch_parts_expected
      CHECK (parts_expected IS NULL OR parts_expected >= 0),
  parts_received                  INTEGER NOT NULL DEFAULT 0
    CONSTRAINT chk_abdm_hiu_fetch_parts_received
      CHECK (parts_received >= 0),
  pages_expected                 INTEGER
    CONSTRAINT chk_abdm_hiu_fetch_pages_expected
      CHECK (pages_expected IS NULL OR pages_expected >= 1),
  next_page_number               INTEGER NOT NULL DEFAULT 1
    CONSTRAINT chk_abdm_hiu_fetch_next_page
      CHECK (next_page_number >= 1),
  initiated_by_uid                UUID,
  requested_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at                 TIMESTAMPTZ,
  completed_at                    TIMESTAMPTZ,
  failure_reason                  VARCHAR(500),
  metadata                        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_abdm_hiu_fetch_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT uq_abdm_hiu_fetch_txn
    UNIQUE (tenant_id, transaction_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_abdm_hiu_fetch_tenant_status
  ON abdm_hiu_fetch_sessions (tenant_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_abdm_hiu_fetch_patient
  ON abdm_hiu_fetch_sessions (tenant_id, patient_uid, requested_at DESC)
  WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_abdm_hiu_fetch_artifact
  ON abdm_hiu_fetch_sessions (consent_artifact_id)
  WHERE consent_artifact_id IS NOT NULL;
-- Stuck-session sweep (sweepStuckDataRequests idiom).
CREATE INDEX IF NOT EXISTS idx_abdm_hiu_fetch_key_expiry
  ON abdm_hiu_fetch_sessions (key_material_expires_at)
  WHERE status IN ('requested', 'acknowledged', 'receiving');

CREATE TABLE IF NOT EXISTS abdm_hiu_fetch_pages (
  id                       SERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fetch_session_id         INTEGER NOT NULL,
  page_number              INTEGER NOT NULL
    CONSTRAINT chk_abdm_hiu_page_number CHECK (page_number >= 1),
  page_count               INTEGER NOT NULL
    CONSTRAINT chk_abdm_hiu_page_count CHECK (page_count >= 1),
  payload_sha256           CHAR(64) NOT NULL
    CONSTRAINT chk_abdm_hiu_page_payload_sha CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status                   VARCHAR(20) NOT NULL DEFAULT 'claimed'
    CONSTRAINT chk_abdm_hiu_page_status CHECK (status IN ('claimed', 'completed', 'failed')),
  claim_id                 UUID NOT NULL,
  claimed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parts_count              INTEGER NOT NULL DEFAULT 0
    CONSTRAINT chk_abdm_hiu_page_parts CHECK (parts_count >= 0),
  failure_reason           VARCHAR(500),
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_abdm_hiu_page_session
    FOREIGN KEY (tenant_id, fetch_session_id)
    REFERENCES abdm_hiu_fetch_sessions (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_abdm_hiu_page_bounds CHECK (page_number <= page_count),
  CONSTRAINT uq_abdm_hiu_page_tenant_id
    UNIQUE (tenant_id, fetch_session_id, id, page_number),
  CONSTRAINT uq_abdm_hiu_fetch_page UNIQUE (tenant_id, fetch_session_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_abdm_hiu_fetch_page_claim
  ON abdm_hiu_fetch_pages (status, claimed_at)
  WHERE status = 'claimed';

CREATE TABLE IF NOT EXISTS abdm_hiu_received_bundles (
  id                       SERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fetch_session_id         INTEGER NOT NULL,
  fetch_page_id            INTEGER NOT NULL,
  page_number              INTEGER NOT NULL
    CONSTRAINT chk_abdm_hiu_bundle_page CHECK (page_number >= 1),
  care_context_reference   VARCHAR(120),
  hi_type                  VARCHAR(60),
  part_number              INTEGER NOT NULL
    CONSTRAINT chk_abdm_hiu_bundle_part CHECK (part_number >= 0),
  -- R2 object key of the DECRYPTED FHIR bundle — PHI bytes never land in
  -- this table.
  bundle_storage_key       VARCHAR(500) NOT NULL,
  bundle_sha256            CHAR(64) NOT NULL
    CONSTRAINT chk_abdm_hiu_bundle_sha CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  checksum_verified        BOOLEAN NOT NULL DEFAULT false,
  media_type               VARCHAR(60) NOT NULL DEFAULT 'application/fhir+json',
  received_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_abdm_hiu_bundle_session
    FOREIGN KEY (tenant_id, fetch_session_id)
    REFERENCES abdm_hiu_fetch_sessions (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_abdm_hiu_bundle_page
    FOREIGN KEY (tenant_id, fetch_session_id, fetch_page_id, page_number)
    REFERENCES abdm_hiu_fetch_pages
      (tenant_id, fetch_session_id, id, page_number) ON DELETE CASCADE,
  CONSTRAINT uq_abdm_hiu_bundle_page_part
    UNIQUE (tenant_id, fetch_session_id, page_number, part_number)
);

CREATE INDEX IF NOT EXISTS idx_abdm_hiu_bundle_session
  ON abdm_hiu_received_bundles (tenant_id, fetch_session_id, received_at DESC);

DO $rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'abdm_hiu_fetch_sessions',
    'abdm_hiu_fetch_pages',
    'abdm_hiu_received_bundles'
  ]
  LOOP
    EXECUTE FORMAT('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE FORMAT($policy$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
    $policy$, table_name);
  END LOOP;
END
$rls$;

COMMENT ON TABLE abdm_hiu_fetch_sessions IS
  'HIU health-information fetch txn state machine, extending the 124 abdmFull layer (consent objects + abdm_data_transfers direction=in). Persists the receive-leg X25519 private key encryptField()-encrypted for the txn lifetime only — code NULLs it after decryption.';
COMMENT ON COLUMN abdm_hiu_fetch_sessions.key_material_private_ciphertext IS
  'encryptField() ciphertext of the txn X25519 private key. Required across the async hi-request → data-push gap; NULLed by code immediately after all parts decrypt.';
COMMENT ON TABLE abdm_hiu_fetch_pages IS
  'Durable exact-payload page claims. A retry must carry the same raw-body SHA-256; its bundle references and fetch-session page/count advancement commit atomically.';
COMMENT ON TABLE abdm_hiu_received_bundles IS
  'References to decrypted HIU-fetched FHIR bundles. PHI bytes live in R2 (bundle_storage_key); rendering to a clinician is PHI access (logPhiAccess), not a clinical write — importing into the local chart would be, and takes the timeline+audit same-tx rule.';

COMMIT;
