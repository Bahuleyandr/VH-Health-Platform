-- 701_abha_enrolment_sessions.sql
--
-- ABDM completion, part 1 of 3 — ABHA enrolment session/txn evidence.
--
-- Gap (abdmService.registerABHA docblock): the platform can LINK an existing
-- ABHA to a patient but cannot CREATE one — abdmGateway exposes no enrolment
-- call. Enrolment is the ABDM v3 Aadhaar-OTP flow (request-otp → enrol
-- byAadhaar with RSA-encrypted Aadhaar+OTP) plus the mobile-OTP
-- verify/update leg, driven against the ABHA sandbox by default.
--
-- One row per enrolment attempt = the txn state machine:
--   initiated → otp_sent → otp_verified → enrolled → linked
--                                       → failed | expired | cancelled
-- txn_id is the ABDM transaction id returned by request-otp; UNIQUE
-- (tenant_id, txn_id, environment) makes OTP-verify replays and duplicate
-- callbacks collapse. On 'enrolled' the resulting ABHA number/address are
-- recorded here; 'linked' means the users-row linkage (users.abha_number +
-- 653 verification gate, abha_verification_status='verified' since the
-- number came from the gateway itself) completed.
--
-- PRIVACY: no Aadhaar material is EVER stored — not masked, not hashed. The
-- flow encrypts Aadhaar in memory with the gateway's public certificate and
-- discards it. mobile_last4 is the only demographic echo kept for the UI.
--
-- ABHA enrolment is identity, not clinical care (registerABHA precedent,
-- abdmService.js:474-477): completion writes a clinical_audit_events row,
-- never a clinical_timeline_events row.
--
-- RLS: 683 request-path pattern. All writers are authenticated routes
-- (patient portal self-enrolment + front-desk assisted), no pre-RLS path.

BEGIN;

CREATE TABLE IF NOT EXISTS abha_enrolment_sessions (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid        UUID NOT NULL,
  flow               VARCHAR(20) NOT NULL
    CONSTRAINT chk_abha_enrolment_flow
      CHECK (flow IN ('aadhaar_otp', 'mobile_otp')),
  environment        VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CONSTRAINT chk_abha_enrolment_environment
      CHECK (environment IN ('sandbox', 'production')),
  -- ABDM transaction id from request-otp; carried through verify/enrol.
  txn_id             VARCHAR(120),
  status             VARCHAR(24) NOT NULL DEFAULT 'initiated'
    CONSTRAINT chk_abha_enrolment_status
      CHECK (status IN (
        'initiated', 'otp_sent', 'otp_verified', 'enrolled', 'linked',
        'failed', 'expired', 'cancelled'
      )),
  otp_attempts       INTEGER NOT NULL DEFAULT 0
    CONSTRAINT chk_abha_enrolment_otp_attempts CHECK (otp_attempts >= 0),
  -- Last 4 digits of the OTP-target mobile — the only demographic echo kept.
  mobile_last4       VARCHAR(4),
  -- Result of a successful enrolment.
  abha_number        VARCHAR(20),
  abha_address       VARCHAR(120),
  -- Non-Aadhaar profile echo returned by the gateway (name/gender/yob…).
  profile_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code         VARCHAR(80),
  failure_reason     VARCHAR(500),
  -- Actor: the patient's own uid (portal) or the assisting staff uid.
  requested_by_uid   UUID,
  otp_sent_at        TIMESTAMPTZ,
  otp_verified_at    TIMESTAMPTZ,
  enrolled_at        TIMESTAMPTZ,
  linked_at          TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- DEFERRABLE: the patient-merge sweep re-points composite patient_uid FKs
  -- parent-then-child inside one transaction (migration 634 pin, enforced by
  -- patient-merge-execution.deep.test.js).
  CONSTRAINT fk_abha_enrolment_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid) ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,
  -- enrolled/linked require the resulting ABHA number + instant.
  CONSTRAINT chk_abha_enrolment_result_evidence
    CHECK (
      status NOT IN ('enrolled', 'linked')
      OR (abha_number IS NOT NULL AND enrolled_at IS NOT NULL)
    ),
  -- Any state past 'initiated' has a gateway txn behind it.
  CONSTRAINT chk_abha_enrolment_txn_presence
    CHECK (
      status IN ('initiated', 'failed', 'expired', 'cancelled')
      OR txn_id IS NOT NULL
    )
);

-- Gateway txn identity — OTP-verify replays collapse.
CREATE UNIQUE INDEX IF NOT EXISTS ux_abha_enrolment_tenant_txn
  ON abha_enrolment_sessions (tenant_id, txn_id, environment)
  WHERE txn_id IS NOT NULL;

-- One live (non-terminal) enrolment session per patient.
CREATE UNIQUE INDEX IF NOT EXISTS ux_abha_enrolment_patient_live
  ON abha_enrolment_sessions (tenant_id, patient_uid)
  WHERE status IN ('initiated', 'otp_sent', 'otp_verified');

CREATE INDEX IF NOT EXISTS idx_abha_enrolment_tenant_status
  ON abha_enrolment_sessions (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abha_enrolment_patient
  ON abha_enrolment_sessions (tenant_id, patient_uid, created_at DESC);
-- Expiry sweep.
CREATE INDEX IF NOT EXISTS idx_abha_enrolment_expiry
  ON abha_enrolment_sessions (expires_at)
  WHERE status IN ('initiated', 'otp_sent', 'otp_verified');

ALTER TABLE abha_enrolment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE abha_enrolment_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON abha_enrolment_sessions;
CREATE POLICY tenant_isolation ON abha_enrolment_sessions
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

COMMENT ON TABLE abha_enrolment_sessions IS
  'ABHA enrolment txn state machine (ABDM v3 Aadhaar-OTP / mobile-OTP, sandbox by default). No Aadhaar material is ever stored. Completion links users.abha_number via the 653 verification gate; identity-not-clinical (audit row yes, timeline row no).';
COMMENT ON COLUMN abha_enrolment_sessions.txn_id IS
  'ABDM gateway transaction id from request-otp; UNIQUE per (tenant, environment) so verify replays and duplicate submissions collapse.';
COMMENT ON COLUMN abha_enrolment_sessions.status IS
  'initiated → otp_sent → otp_verified → enrolled → linked | failed | expired | cancelled.';

COMMIT;
