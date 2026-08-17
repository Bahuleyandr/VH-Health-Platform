-- 716_abdm_resend_signer_and_patient_delete_safety.sql
--
-- Forward-only safety convergence after published 701/702/707 and local 714.
--  * reserve ABHA OTP resend slots with a durable lease before the gateway call;
--  * reject any 714-era HIU reconciliation that lacks the HIP identity retained
--    on the authenticated callback itself (current credentials are not history);
--  * let patient deletion preserve a resolved Scan & Share intake without
--    attempting to null its required tenant_id.

BEGIN;

-- -------------------------------------------------------------------------
-- ABHA resend claims.
-- -------------------------------------------------------------------------

ALTER TABLE abha_enrolment_sessions
  ADD COLUMN IF NOT EXISTS resend_count SMALLINT,
  ADD COLUMN IF NOT EXISTS resend_claim_id UUID,
  ADD COLUMN IF NOT EXISTS resend_claimed_at TIMESTAMPTZ;

DO $abha_resend_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM abha_enrolment_sessions
     WHERE metadata ? 'resend_count'
       AND (
         JSONB_TYPEOF(metadata->'resend_count') NOT IN ('number', 'string')
         OR (metadata->>'resend_count') !~ '^[0-3]$'
       )
  ) THEN
    RAISE EXCEPTION
      '716 preflight: ABHA enrolment resend_count metadata is malformed or exceeds the supported cap'
      USING ERRCODE = '23514';
  END IF;
END
$abha_resend_preflight$;

UPDATE abha_enrolment_sessions
   SET resend_count = COALESCE((metadata->>'resend_count')::smallint, 0)
 WHERE resend_count IS NULL;

ALTER TABLE abha_enrolment_sessions
  ALTER COLUMN resend_count SET DEFAULT 0,
  ALTER COLUMN resend_count SET NOT NULL,
  DROP CONSTRAINT IF EXISTS chk_abha_enrolment_resend_count,
  DROP CONSTRAINT IF EXISTS chk_abha_enrolment_resend_claim;

ALTER TABLE abha_enrolment_sessions
  ADD CONSTRAINT chk_abha_enrolment_resend_count
    CHECK (resend_count BETWEEN 0 AND 3),
  ADD CONSTRAINT chk_abha_enrolment_resend_claim
    CHECK (
      (resend_claim_id IS NULL AND resend_claimed_at IS NULL)
      OR (
        resend_claim_id IS NOT NULL
        AND resend_claimed_at IS NOT NULL
        AND status = 'otp_sent'
      )
    );

COMMENT ON COLUMN abha_enrolment_sessions.resend_count IS
  'Durable count of gateway OTP resend reservations. Incremented atomically before outbound dispatch; maximum three per enrolment session.';
COMMENT ON COLUMN abha_enrolment_sessions.resend_claim_id IS
  'Lease owner for the in-flight OTP resend. Gateway results update txn_id only through a claim-token CAS.';

-- -------------------------------------------------------------------------
-- Retained historical HIP evidence for every page migration 714 considered.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.m716_consent_hip(metadata JSONB, signed_payload JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  parsed_payload JSONB;
  hip_id TEXT;
BEGIN
  hip_id := NULLIF(BTRIM(metadata->>'hip_id'), '');
  IF hip_id IS NOT NULL THEN
    RETURN hip_id;
  END IF;

  parsed_payload := signed_payload;
  IF JSONB_TYPEOF(parsed_payload->'raw') = 'string' THEN
    BEGIN
      parsed_payload := (parsed_payload->>'raw')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END IF;
  RETURN NULLIF(BTRIM(parsed_payload #>> '{hip,id}'), '');
END;
$$;

CREATE TEMP TABLE _m716_hiu_page_signers ON COMMIT DROP AS
SELECT p.id AS page_id,
       p.tenant_id,
       s.environment,
       s.transaction_id,
       p.page_number,
       pg_temp.m716_consent_hip(a.metadata, a.signed_payload) AS expected_hip_id,
       COUNT(e.id)::integer AS event_count,
       MIN(NULLIF(BTRIM(e.payload->>'authenticatedHipId'), '')) AS retained_hip_id,
       COUNT(e.id) FILTER (
         WHERE NULLIF(BTRIM(e.payload->>'authenticatedHipId'), '') IS NOT NULL
       )::integer AS signer_evidence_count
  FROM abdm_hiu_fetch_pages p
  JOIN abdm_hiu_fetch_sessions s
    ON s.tenant_id = p.tenant_id AND s.id = p.fetch_session_id
  LEFT JOIN abdm_consent_artifacts a
    ON a.tenant_id = s.tenant_id
   AND a.id = s.consent_artifact_id
   AND a.environment = s.environment
  LEFT JOIN abdm_webhook_events e
    ON e.tenant_id = p.tenant_id
   AND e.environment = s.environment
   AND e.event_type = 'hiu_data_push'
   AND e.signature_verified IS TRUE
   AND e.external_event_id = s.transaction_id || ':page:' || p.page_number::text
   AND e.payload->>'transactionId' = s.transaction_id
   AND CASE
         WHEN JSONB_TYPEOF(e.payload->'pageNumber') = 'number'
          AND (e.payload->>'pageNumber') ~ '^[0-9]+$'
         THEN (e.payload->>'pageNumber')::numeric
       END = p.page_number
 WHERE p.status = 'completed'
    OR EXISTS (
      SELECT 1
        FROM abdm_hiu_received_bundles b
       WHERE b.tenant_id = p.tenant_id
         AND b.fetch_session_id = p.fetch_session_id
         AND b.fetch_page_id = p.id
         AND b.page_number = p.page_number
    )
 GROUP BY p.id, p.tenant_id, s.environment, s.transaction_id, p.page_number,
          a.metadata, a.signed_payload;

DO $hiu_signer_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM _m716_hiu_page_signers
     WHERE expected_hip_id IS NULL
        OR event_count <> 1
        OR signer_evidence_count <> 1
        OR retained_hip_id IS NULL
        OR retained_hip_id <> expected_hip_id
  ) THEN
    RAISE EXCEPTION
      '716 preflight: HIU page reconciliation lacks unambiguous retained historical signer evidence'
      USING ERRCODE = '23514';
  END IF;
END
$hiu_signer_preflight$;

COMMENT ON TABLE abdm_hiu_fetch_pages IS
  'Durable exact-payload page claims. Reconciled pages require the HIP identity retained on their authenticated callback event; current tenant credentials are never historical signer evidence.';

-- -------------------------------------------------------------------------
-- Scan & Share patient deletion.
-- -------------------------------------------------------------------------

ALTER TABLE abdm_patient_share_intakes
  ADD COLUMN IF NOT EXISTS matched_patient_deleted_at TIMESTAMPTZ;

ALTER TABLE abdm_patient_share_intakes
  DROP CONSTRAINT IF EXISTS fk_abdm_share_intake_patient,
  DROP CONSTRAINT IF EXISTS chk_abdm_share_intake_resolution_evidence,
  DROP CONSTRAINT IF EXISTS chk_abdm_share_intake_patient_lifecycle;

ALTER TABLE abdm_patient_share_intakes
  ADD CONSTRAINT chk_abdm_share_intake_resolution_evidence
    CHECK (
      status NOT IN ('matched', 'registered', 'linked_visit')
      OR (
        processed_at IS NOT NULL
        AND (
          (matched_patient_uid IS NOT NULL AND matched_patient_deleted_at IS NULL)
          OR (matched_patient_uid IS NULL AND matched_patient_deleted_at IS NOT NULL)
        )
      )
    ),
  ADD CONSTRAINT chk_abdm_share_intake_patient_lifecycle
    CHECK (matched_patient_uid IS NULL OR matched_patient_deleted_at IS NULL),
  ADD CONSTRAINT fk_abdm_share_intake_patient
    FOREIGN KEY (tenant_id, matched_patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION
    ON DELETE SET NULL (matched_patient_uid);

CREATE OR REPLACE FUNCTION clear_abdm_share_intake_patient_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  EXECUTE FORMAT(
    'UPDATE %I.abdm_patient_share_intakes
        SET matched_patient_uid = NULL,
            matched_patient_deleted_at = COALESCE(matched_patient_deleted_at, NOW()),
            updated_at = NOW()
      WHERE tenant_id = $1 AND matched_patient_uid = $2',
    TG_TABLE_SCHEMA
  ) USING OLD.tenant_id, OLD.uid;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_abdm_share_intake_patient_binding ON users;
CREATE TRIGGER trg_clear_abdm_share_intake_patient_binding
BEFORE DELETE ON users
FOR EACH ROW
EXECUTE FUNCTION clear_abdm_share_intake_patient_binding();

COMMENT ON COLUMN abdm_patient_share_intakes.matched_patient_deleted_at IS
  'Preserves truthful resolution evidence when the matched patient is hard-deleted; tenant identity and intake history survive while the patient UID is cleared.';

COMMIT;
