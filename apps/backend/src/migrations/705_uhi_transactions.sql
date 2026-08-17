-- 705_uhi_transactions.sql
--
-- Remainder feature R-2 — UHI (Unified Health Interface) adapter evidence.
--
-- Gap: zero UHI code exists. UHI is ABDM's DHP/beckn-derived open network for
-- health service discovery + booking: an end-user app (EUA) sends
-- search/init/confirm intents through the UHI gateway; a provider (HSP — this
-- platform) answers with on_search/on_init/on_confirm callbacks. This
-- migration adds the ONE table the adapter needs: a per-message evidence +
-- replay-dedupe ledger. Deliberately thin — confirmed bookings land in the
-- EXISTING appointments tables through the existing booking service (which
-- already emits canonical timeline + audit rows via
-- appointmentLifecycleService.recordCanonicalClinicalEvent); UHI never grows
-- a parallel booking store.
--
-- One row per protocol message leg (inbound intent or outbound callback):
--   * Dedupe identity: UNIQUE (tenant_id, environment, transaction_id,
--     message_id, action). `action` is part of the key because beckn-style
--     callbacks REUSE the originating message_id — an inbound `search` and
--     our outbound `on_search` share (transaction_id, message_id) and must
--     both be recorded; a gateway REDELIVERY of the same leg collapses onto
--     the existing row (insert ... ON CONFLICT DO NOTHING → replay-safe 200).
--   * `payload` stores the raw message body as signed-request evidence;
--     `signature_verified` + `verification_failure_reason` record the auth
--     outcome (failed-signature messages are stored as evidence and rejected).
--   * Correlation: nullable appointment FK + booking_snapshot (686/689
--     audit-survival idiom) once a confirm leg books through the existing
--     appointment path.
--
-- Provider-side, sandbox default (`environment`), config-gated OFF via env
-- UHI_ENABLED + tenants.settings.uhi (ambulanceGpsTracking accessor pattern)
-- — ship-disabled posture, enabling is a settings write, not a migration.
--
-- Pre-RLS mount: the UHI webhook router is mounted before tenant middleware
-- (ABDM callbackRouter precedent). Tenant is resolved from the provider id in
-- the message context BEFORE any write, and tenant_id is ALWAYS written
-- explicitly by code (never left to a GUC-reading default).
--
-- RLS follows the 680/683 request-path pattern: permissive tenant_isolation
-- + FORCE; explicit tenant predicates everywhere.

BEGIN;

-- id is SERIAL (int4), not BIGSERIAL: admin evidence-list queries project the
-- raw column and Prisma maps int8 to JS BigInt, which JSON.stringify rejects
-- (680 precedent).
CREATE TABLE IF NOT EXISTS uhi_transactions (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment                 VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CONSTRAINT chk_uhi_txn_environment
      CHECK (environment IN ('sandbox', 'production')),
  -- DHP context identifiers (context.transaction_id spans the whole
  -- search→init→confirm journey; context.message_id identifies one exchange).
  transaction_id              VARCHAR(120) NOT NULL
    CONSTRAINT chk_uhi_txn_transaction_id
      CHECK (NULLIF(BTRIM(transaction_id), '') IS NOT NULL),
  message_id                  VARCHAR(120) NOT NULL
    CONSTRAINT chk_uhi_txn_message_id
      CHECK (NULLIF(BTRIM(message_id), '') IS NOT NULL),
  action                      VARCHAR(20) NOT NULL
    CONSTRAINT chk_uhi_txn_action
      CHECK (action IN (
        'search', 'on_search', 'init', 'on_init', 'confirm', 'on_confirm',
        'status', 'on_status', 'cancel', 'on_cancel'
      )),
  direction                   VARCHAR(10) NOT NULL
    CONSTRAINT chk_uhi_txn_direction
      CHECK (direction IN ('inbound', 'outbound')),
  -- The counterparty subscriber (EUA/gateway id from context.consumer_id /
  -- context.consumer_uri) — evidence, not an FK.
  counterparty_subscriber_id  VARCHAR(200),
  -- Raw message body (context + message) as received/sent — the evidence.
  payload                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Signature outcome for inbound legs (outbound rows record our own signing
  -- as verified=true by construction).
  signature_verified          BOOLEAN NOT NULL DEFAULT FALSE,
  verification_failure_reason VARCHAR(300),
  -- Processing outcome of the leg.
  status                      VARCHAR(20) NOT NULL DEFAULT 'received'
    CONSTRAINT chk_uhi_txn_status
      CHECK (status IN ('received', 'processed', 'failed', 'rejected')),
  -- ACK/NACK returned (inbound) or received (outbound callback delivery).
  ack                         VARCHAR(8)
    CONSTRAINT chk_uhi_txn_ack CHECK (ack IS NULL OR ack IN ('ACK', 'NACK')),
  error_code                  VARCHAR(80),
  error_message               VARCHAR(500),
  -- Booking correlation: set by the confirm leg AFTER the existing
  -- appointment-booking service created the row. Snapshot survives
  -- appointment deletion (686/689 idiom).
  appointment_id              INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  booking_snapshot            JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Replay dedupe: gateway redelivery of the same leg collapses here.
  CONSTRAINT uq_uhi_txn_leg
    UNIQUE (tenant_id, environment, transaction_id, message_id, action),
  -- rejected ⇒ a recorded reason (failed signature / disabled / bad shape).
  CONSTRAINT chk_uhi_txn_rejected_reason
    CHECK (
      status <> 'rejected'
      OR verification_failure_reason IS NOT NULL
      OR error_code IS NOT NULL
    )
);

-- Journey correlation (all legs of one transaction, in order).
CREATE INDEX IF NOT EXISTS idx_uhi_txn_tenant_transaction
  ON uhi_transactions (tenant_id, transaction_id, received_at, id);
CREATE INDEX IF NOT EXISTS idx_uhi_txn_tenant_received
  ON uhi_transactions (tenant_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_uhi_txn_appointment
  ON uhi_transactions (appointment_id)
  WHERE appointment_id IS NOT NULL;

ALTER TABLE uhi_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE uhi_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON uhi_transactions;
CREATE POLICY tenant_isolation ON uhi_transactions
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

COMMENT ON TABLE uhi_transactions IS
  'UHI (DHP/beckn) adapter evidence + replay-dedupe ledger: one row per protocol message leg (search/init/confirm intents and on_* callbacks), provider-side, sandbox default. UNIQUE (tenant_id, environment, transaction_id, message_id, action) — action is in the key because beckn callbacks reuse the originating message_id. Bookings land in the EXISTING appointments tables via the existing booking service; this table never stores a parallel booking. Written from a pre-RLS mount — tenant_id always resolved and written explicitly.';
COMMENT ON COLUMN uhi_transactions.transaction_id IS
  'DHP context.transaction_id — spans the whole search→init→confirm journey; correlate legs via idx_uhi_txn_tenant_transaction.';
COMMENT ON COLUMN uhi_transactions.booking_snapshot IS
  'Denormalized booking evidence ({appointment_id, patient_uid, doctor_id, slot, booked_at}) captured when the confirm leg booked through the existing appointment path; survives appointment deletion (FK is SET NULL).';

COMMIT;
