-- 702_abdm_patient_share_intakes.sql
--
-- ABDM completion, part 2 of 3 — Scan & Share intake.
--
-- Gap: no Scan & Share code exists. In ABDM's flow the patient scans a
-- counter QR with any ABDM app; the CM then POSTs a patient profile share
-- (/v0.5/patients/profile/share shape: requestId, a token number for the
-- queue display, ABHA identity + demographics, the scanned counter context)
-- to the HIP callback endpoint. The front desk consumes the intake to
-- (a) match an existing patient or register a new one via the guarded
-- POST /patients duplicate-review flow, and (b) attach the visit context.
--
-- One row per share callback = the front-desk work item:
--   received → matched | registered → linked_visit
--            → dismissed | expired | failed
-- UNIQUE (tenant_id, request_id, environment) collapses CM redeliveries.
--
-- Intake layering (618 precedent): the RAW callback evidence (signed bytes,
-- HMAC verification, durable replay claim) lands in abdm_webhook_events via
-- recordAuthenticatedAbdmCallback — the new callback path must be added to
-- ABDM_CALLBACK_PATHS + the app.js raw-body capture list. THIS table is the
-- workflow row derived from a verified callback, not the transport receipt.
--
-- Pre-RLS mount: the callback router is mounted before tenant middleware.
-- Tenant is resolved from x-hip-id via resolveTenantBySender before any
-- write, and tenant_id is ALWAYS written explicitly by code.
--
-- Registration performed FROM an intake follows front-desk registration's
-- audit pattern (identity write → audit row; no clinical timeline row).

BEGIN;

CREATE TABLE IF NOT EXISTS abdm_patient_share_intakes (
  id                     SERIAL PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment            VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CONSTRAINT chk_abdm_share_intake_environment
      CHECK (environment IN ('sandbox', 'production')),
  -- CM request id of the profile-share callback (replay identity).
  request_id             VARCHAR(120) NOT NULL,
  -- Queue token number the CM assigned for counter display.
  token_number           VARCHAR(20),
  -- The scanned counter context (hip counter id from the QR).
  counter_context        VARCHAR(120),
  abha_number            VARCHAR(20),
  abha_address           VARCHAR(120),
  -- Shared demographics payload (name, gender, yob, mobile, address…).
  profile                JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                 VARCHAR(24) NOT NULL DEFAULT 'received'
    CONSTRAINT chk_abdm_share_intake_status
      CHECK (status IN (
        'received', 'matched', 'registered', 'linked_visit',
        'dismissed', 'expired', 'failed'
      )),
  -- Resolution: the patient this intake matched or registered.
  matched_patient_uid    UUID,
  -- OP context attached from the intake (visit/appointment created or linked).
  linked_appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  processed_by_uid       UUID,
  processed_at           TIMESTAMPTZ,
  failure_reason         VARCHAR(500),
  received_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Share tokens are short-lived; the sweep expires unactioned intakes.
  expires_at             TIMESTAMPTZ,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_abdm_share_intake_request
    UNIQUE (tenant_id, request_id, environment),
  CONSTRAINT fk_abdm_share_intake_patient
    FOREIGN KEY (tenant_id, matched_patient_uid)
    REFERENCES users (tenant_id, uid) ON DELETE SET NULL,
  -- Resolution states carry their evidence.
  CONSTRAINT chk_abdm_share_intake_resolution_evidence
    CHECK (
      status NOT IN ('matched', 'registered', 'linked_visit')
      OR (matched_patient_uid IS NOT NULL AND processed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_abdm_share_intake_tenant_status
  ON abdm_patient_share_intakes (tenant_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_abdm_share_intake_abha
  ON abdm_patient_share_intakes (tenant_id, abha_number)
  WHERE abha_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_abdm_share_intake_expiry
  ON abdm_patient_share_intakes (expires_at)
  WHERE status = 'received';

ALTER TABLE abdm_patient_share_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE abdm_patient_share_intakes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON abdm_patient_share_intakes;
CREATE POLICY tenant_isolation ON abdm_patient_share_intakes
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
  );

COMMENT ON TABLE abdm_patient_share_intakes IS
  'Scan & Share front-desk work items derived from verified CM profile-share callbacks (raw transport evidence lives in abdm_webhook_events, 618 intake pattern). Written from a pre-RLS mount — tenant_id always resolved and written explicitly. UNIQUE (tenant_id, request_id, environment) collapses CM redeliveries.';
COMMENT ON COLUMN abdm_patient_share_intakes.token_number IS
  'CM-assigned queue token for counter display; shown to front desk alongside shared demographics.';

COMMIT;
