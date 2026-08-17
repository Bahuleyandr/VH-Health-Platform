-- 707_abdm_uhi_security_upgrade.sql
--
-- Additive upgrade for the security constraints originally developed against
-- migrations 701, 703, and 705. Those filenames were already published and
-- are immutable because the raw migration runner tracks applied filenames,
-- not file digests. This migration therefore converges both supported states:
--   * a retained database that applied the published 701/703/705 files; and
--   * a database that briefly applied the amended branch versions.
--
-- Legacy HIU bundle rows are backfilled only when their page identity can be
-- derived from 703's part-number encoding. Ambiguous evidence aborts the whole
-- transaction; protocol history is never guessed or silently discarded.

BEGIN;

-- -------------------------------------------------------------------------
-- 701: claim-token CAS for ABHA OTP verification.
-- -------------------------------------------------------------------------

ALTER TABLE abha_enrolment_sessions
  ADD COLUMN IF NOT EXISTS verification_claim_id UUID,
  ADD COLUMN IF NOT EXISTS verification_claimed_at TIMESTAMPTZ;

ALTER TABLE abha_enrolment_sessions
  DROP CONSTRAINT IF EXISTS chk_abha_enrolment_status;
ALTER TABLE abha_enrolment_sessions
  ADD CONSTRAINT chk_abha_enrolment_status
  CHECK (status IN (
    'initiated', 'otp_sent', 'otp_verifying', 'otp_verified', 'enrolled',
    'linked', 'failed', 'expired', 'cancelled'
  ));

DROP INDEX IF EXISTS ux_abha_enrolment_patient_live;
CREATE UNIQUE INDEX ux_abha_enrolment_patient_live
  ON abha_enrolment_sessions (tenant_id, patient_uid)
  WHERE status IN ('initiated', 'otp_sent', 'otp_verifying', 'otp_verified');

DROP INDEX IF EXISTS idx_abha_enrolment_expiry;
CREATE INDEX idx_abha_enrolment_expiry
  ON abha_enrolment_sessions (expires_at)
  WHERE status IN ('initiated', 'otp_sent', 'otp_verifying', 'otp_verified');

COMMENT ON COLUMN abha_enrolment_sessions.status IS
  'initiated → otp_sent → otp_verifying → linked | failed | expired | cancelled.';
COMMENT ON COLUMN abha_enrolment_sessions.verification_claim_id IS
  'CAS ownership token for one active OTP verifier; terminal transitions must match it.';

-- -------------------------------------------------------------------------
-- 703: durable page identity and atomic page/bundle/session advancement.
-- -------------------------------------------------------------------------

ALTER TABLE abdm_hiu_fetch_sessions
  ADD COLUMN IF NOT EXISTS pages_expected INTEGER,
  ADD COLUMN IF NOT EXISTS next_page_number INTEGER DEFAULT 1;

UPDATE abdm_hiu_fetch_sessions
   SET next_page_number = 1
 WHERE next_page_number IS NULL;

ALTER TABLE abdm_hiu_fetch_sessions
  ALTER COLUMN next_page_number SET DEFAULT 1,
  ALTER COLUMN next_page_number SET NOT NULL,
  DROP CONSTRAINT IF EXISTS chk_abdm_hiu_fetch_pages_expected,
  DROP CONSTRAINT IF EXISTS chk_abdm_hiu_fetch_next_page;
ALTER TABLE abdm_hiu_fetch_sessions
  ADD CONSTRAINT chk_abdm_hiu_fetch_pages_expected
    CHECK (pages_expected IS NULL OR pages_expected >= 1),
  ADD CONSTRAINT chk_abdm_hiu_fetch_next_page
    CHECK (next_page_number >= 1);

DO $session_unique$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'abdm_hiu_fetch_sessions'::regclass
       AND conname = 'uq_abdm_hiu_fetch_tenant_id'
  ) THEN
    ALTER TABLE abdm_hiu_fetch_sessions
      ADD CONSTRAINT uq_abdm_hiu_fetch_tenant_id UNIQUE (tenant_id, id);
  END IF;
END
$session_unique$;

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
  CONSTRAINT uq_abdm_hiu_fetch_page
    UNIQUE (tenant_id, fetch_session_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_abdm_hiu_fetch_page_claim
  ON abdm_hiu_fetch_pages (status, claimed_at)
  WHERE status = 'claimed';

ALTER TABLE abdm_hiu_received_bundles
  ADD COLUMN IF NOT EXISTS fetch_page_id INTEGER,
  ADD COLUMN IF NOT EXISTS page_number INTEGER;

DO $legacy_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_received_bundles b
      JOIN abdm_hiu_fetch_sessions s ON s.id = b.fetch_session_id
     WHERE b.tenant_id <> s.tenant_id
  ) THEN
    RAISE EXCEPTION
      '707 preflight: HIU bundle tenant does not match its fetch session'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_received_bundles
     WHERE (fetch_page_id IS NULL) <> (page_number IS NULL)
  ) THEN
    RAISE EXCEPTION
      '707 preflight: HIU bundle has partial page identity'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_received_bundles
     WHERE fetch_page_id IS NULL
       AND part_number IS NULL
  ) THEN
    RAISE EXCEPTION
      '707 preflight: legacy HIU bundle has no ordered part identity'
      USING ERRCODE = '23514';
  END IF;

  -- Published 703 encoded pages in base 1000 without bounding the source
  -- array. The signed callback ledger is the only retained evidence that can
  -- prove a legacy part belongs to the page implied by that encoding. Refuse
  -- the upgrade when the evidence is absent, malformed, oversized, or cannot
  -- contain the derived local part; guessing would relabel PHI across pages.
  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_received_bundles b
      JOIN abdm_hiu_fetch_sessions s
        ON s.id = b.fetch_session_id AND s.tenant_id = b.tenant_id
      LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN JSONB_TYPEOF(e.payload->'entryCount') = 'number'
                  AND (e.payload->>'entryCount') ~ '^[0-9]+$'
                 THEN (e.payload->>'entryCount')::numeric
               END AS entry_count
          FROM abdm_webhook_events e
         WHERE e.tenant_id = s.tenant_id
           AND e.environment = s.environment
           AND e.event_type = 'hiu_data_push'
           AND e.signature_verified IS TRUE
           AND e.payload->>'transactionId' = s.transaction_id
           AND CASE
                 WHEN JSONB_TYPEOF(e.payload->'pageNumber') = 'number'
                  AND (e.payload->>'pageNumber') ~ '^[0-9]+$'
                 THEN (e.payload->>'pageNumber')::numeric
               END = (b.part_number / 1000) + 1
         ORDER BY e.id DESC
         LIMIT 1
      ) page_evidence ON TRUE
     WHERE b.fetch_page_id IS NULL
       AND (
         page_evidence.entry_count IS NULL
         OR page_evidence.entry_count > 1000
         OR page_evidence.entry_count <= MOD(b.part_number, 1000)
       )
  ) THEN
    RAISE EXCEPTION
      '707 preflight: legacy HIU base-1000 page identity is not proven by callback evidence'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_received_bundles
     WHERE fetch_page_id IS NULL
     GROUP BY tenant_id, fetch_session_id,
              (part_number / 1000) + 1, MOD(part_number, 1000)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      '707 preflight: legacy HIU bundles collide on derived page and part identity'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_received_bundles b
      JOIN abdm_hiu_fetch_sessions s ON s.id = b.fetch_session_id
     WHERE b.fetch_page_id IS NULL
     GROUP BY b.tenant_id, b.fetch_session_id, s.parts_expected
    HAVING s.parts_expected IS NOT NULL
       AND s.parts_expected > 0
       AND MAX((b.part_number / 1000) + 1) > s.parts_expected
  ) THEN
    RAISE EXCEPTION
      '707 preflight: legacy HIU bundle page exceeds the recorded page count'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_received_bundles
     WHERE fetch_page_id IS NULL
     GROUP BY tenant_id, fetch_session_id
    HAVING COUNT(DISTINCT ((part_number / 1000) + 1))
           <> MAX((part_number / 1000) + 1)
  ) THEN
    RAISE EXCEPTION
      '707 preflight: legacy HIU bundle pages are not contiguous from page one'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_fetch_sessions s
      LEFT JOIN abdm_hiu_received_bundles b
        ON b.fetch_session_id = s.id AND b.tenant_id = s.tenant_id
     WHERE s.parts_received > 0
     GROUP BY s.id
    HAVING COUNT(b.id) = 0
  ) THEN
    RAISE EXCEPTION
      '707 preflight: HIU session count has no retained bundle evidence'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_fetch_sessions s
      LEFT JOIN abdm_hiu_received_bundles b
        ON b.fetch_session_id = s.id AND b.tenant_id = s.tenant_id
       AND b.fetch_page_id IS NULL
     WHERE s.status IN ('completed', 'partial')
       AND NOT EXISTS (
         SELECT 1 FROM abdm_hiu_fetch_pages p
          WHERE p.tenant_id = s.tenant_id AND p.fetch_session_id = s.id
       )
     GROUP BY s.id, s.parts_expected
    HAVING s.parts_expected IS NULL
        OR s.parts_expected < 1
        OR COUNT(DISTINCT ((b.part_number / 1000) + 1)) <> s.parts_expected
  ) THEN
    RAISE EXCEPTION
      '707 preflight: terminal legacy HIU session lacks a complete ordered page ledger'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_received_bundles b
      JOIN abdm_hiu_fetch_pages p ON p.id = b.fetch_page_id
     WHERE b.fetch_page_id IS NOT NULL
       AND (
         p.tenant_id <> b.tenant_id
         OR p.fetch_session_id <> b.fetch_session_id
         OR p.page_number <> b.page_number
       )
  ) THEN
    RAISE EXCEPTION
      '707 preflight: existing HIU bundle page binding is inconsistent'
      USING ERRCODE = '23514';
  END IF;
END
$legacy_preflight$;

-- 703 encoded the page in the high-order part-number digits:
--   global part = ((page - 1) * 1000) + zero-based part.
WITH legacy_pages AS (
  SELECT b.tenant_id,
         b.fetch_session_id,
         (b.part_number / 1000) + 1 AS page_number,
         GREATEST(
           COALESCE(NULLIF(s.parts_expected, 0), 1),
           MAX((b.part_number / 1000) + 1)
         )::integer AS page_count,
         ENCODE(DIGEST(
           STRING_AGG(
             b.id::text || ':' || b.part_number::text || ':' || BTRIM(b.bundle_sha256),
             '|' ORDER BY b.part_number, b.id
           ),
           'sha256'
         ), 'hex') AS payload_sha256,
         COUNT(*)::integer AS parts_count,
         MIN(b.received_at) AS claimed_at,
         MAX(b.received_at) AS completed_at
    FROM abdm_hiu_received_bundles b
    JOIN abdm_hiu_fetch_sessions s
      ON s.id = b.fetch_session_id AND s.tenant_id = b.tenant_id
   WHERE b.fetch_page_id IS NULL
   GROUP BY b.tenant_id, b.fetch_session_id,
            (b.part_number / 1000) + 1, s.parts_expected
)
INSERT INTO abdm_hiu_fetch_pages
       (tenant_id, fetch_session_id, page_number, page_count, payload_sha256,
        status, claim_id, claimed_at, parts_count, completed_at, created_at,
        updated_at)
SELECT lp.tenant_id, lp.fetch_session_id, lp.page_number, lp.page_count,
       lp.payload_sha256, 'completed', gen_random_uuid(), lp.claimed_at,
       lp.parts_count, lp.completed_at, lp.claimed_at, lp.completed_at
  FROM legacy_pages lp
 WHERE NOT EXISTS (
   SELECT 1
     FROM abdm_hiu_fetch_pages p
    WHERE p.tenant_id = lp.tenant_id
      AND p.fetch_session_id = lp.fetch_session_id
      AND p.page_number = lp.page_number
 );

WITH legacy_session_stats AS (
  SELECT b.tenant_id,
         b.fetch_session_id,
         COUNT(*)::integer AS bundle_count,
         MAX((b.part_number / 1000) + 1)::integer AS last_page,
         MAX(p.page_count)::integer AS page_count
    FROM abdm_hiu_received_bundles b
    JOIN abdm_hiu_fetch_pages p
      ON p.tenant_id = b.tenant_id
     AND p.fetch_session_id = b.fetch_session_id
     AND p.page_number = (b.part_number / 1000) + 1
   WHERE b.fetch_page_id IS NULL
   GROUP BY b.tenant_id, b.fetch_session_id
)
UPDATE abdm_hiu_fetch_sessions s
   SET pages_expected = COALESCE(s.pages_expected, ls.page_count),
       next_page_number = GREATEST(s.next_page_number, ls.last_page + 1),
       parts_received = ls.bundle_count,
       updated_at = NOW()
  FROM legacy_session_stats ls
 WHERE s.id = ls.fetch_session_id
   AND s.tenant_id = ls.tenant_id;

UPDATE abdm_hiu_received_bundles b
   SET fetch_page_id = p.id,
       page_number = (b.part_number / 1000) + 1,
       metadata = b.metadata || jsonb_build_object(
         'legacy_global_part_number', b.part_number,
         'page_identity_backfilled_by', '707_abdm_uhi_security_upgrade'
       ),
       part_number = MOD(b.part_number, 1000)
  FROM abdm_hiu_fetch_pages p
 WHERE b.fetch_page_id IS NULL
   AND p.tenant_id = b.tenant_id
   AND p.fetch_session_id = b.fetch_session_id
   AND p.page_number = (b.part_number / 1000) + 1;

DO $post_backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM abdm_hiu_received_bundles
     WHERE fetch_page_id IS NULL OR page_number IS NULL OR part_number IS NULL
  ) THEN
    RAISE EXCEPTION
      '707 postflight: HIU bundle page identity backfill is incomplete'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM abdm_hiu_received_bundles
     GROUP BY tenant_id, fetch_session_id, page_number, part_number
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      '707 postflight: HIU bundle page identity is not unique'
      USING ERRCODE = '23514';
  END IF;
END
$post_backfill$;

ALTER TABLE abdm_hiu_received_bundles
  DROP CONSTRAINT IF EXISTS abdm_hiu_received_bundles_fetch_session_id_fkey,
  DROP CONSTRAINT IF EXISTS fk_abdm_hiu_bundle_session,
  DROP CONSTRAINT IF EXISTS fk_abdm_hiu_bundle_page,
  DROP CONSTRAINT IF EXISTS uq_abdm_hiu_bundle_content,
  DROP CONSTRAINT IF EXISTS uq_abdm_hiu_bundle_page_part,
  DROP CONSTRAINT IF EXISTS chk_abdm_hiu_bundle_part,
  DROP CONSTRAINT IF EXISTS chk_abdm_hiu_bundle_page;

ALTER TABLE abdm_hiu_received_bundles
  ALTER COLUMN fetch_page_id SET NOT NULL,
  ALTER COLUMN page_number SET NOT NULL,
  ALTER COLUMN part_number SET NOT NULL,
  ADD CONSTRAINT chk_abdm_hiu_bundle_page CHECK (page_number >= 1),
  ADD CONSTRAINT chk_abdm_hiu_bundle_part CHECK (part_number >= 0),
  ADD CONSTRAINT fk_abdm_hiu_bundle_session
    FOREIGN KEY (tenant_id, fetch_session_id)
    REFERENCES abdm_hiu_fetch_sessions (tenant_id, id)
    ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT fk_abdm_hiu_bundle_page
    FOREIGN KEY (tenant_id, fetch_session_id, fetch_page_id, page_number)
    REFERENCES abdm_hiu_fetch_pages
      (tenant_id, fetch_session_id, id, page_number)
    ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT uq_abdm_hiu_bundle_page_part
    UNIQUE (tenant_id, fetch_session_id, page_number, part_number);

ALTER TABLE abdm_hiu_received_bundles
  VALIDATE CONSTRAINT fk_abdm_hiu_bundle_session;
ALTER TABLE abdm_hiu_received_bundles
  VALIDATE CONSTRAINT fk_abdm_hiu_bundle_page;

ALTER TABLE abdm_hiu_fetch_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE abdm_hiu_fetch_pages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON abdm_hiu_fetch_pages;
CREATE POLICY tenant_isolation ON abdm_hiu_fetch_pages
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

COMMENT ON TABLE abdm_hiu_fetch_pages IS
  'Durable exact-payload page claims. A retry must carry the same raw-body SHA-256; its bundle references and fetch-session page/count advancement commit atomically.';

-- -------------------------------------------------------------------------
-- 705: sender-specific UHI replay identity.
-- -------------------------------------------------------------------------

UPDATE uhi_transactions
   SET counterparty_subscriber_id = LEFT(COALESCE(
         NULLIF(BTRIM(counterparty_subscriber_id), ''),
         NULLIF(BTRIM(payload #>> '{context,bap_id}'), ''),
         NULLIF(BTRIM(payload #>> '{context,consumer_id}'), '')
       ), 200)
 WHERE counterparty_subscriber_id IS NULL
    OR NULLIF(BTRIM(counterparty_subscriber_id), '') IS NULL;

DO $uhi_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM uhi_transactions
     WHERE counterparty_subscriber_id IS NULL
        OR NULLIF(BTRIM(counterparty_subscriber_id), '') IS NULL
  ) THEN
    RAISE EXCEPTION
      '707 preflight: UHI transaction lacks signed counterparty identity'
      USING ERRCODE = '23514';
  END IF;
END
$uhi_preflight$;

ALTER TABLE uhi_transactions
  DROP CONSTRAINT IF EXISTS uq_uhi_txn_leg,
  DROP CONSTRAINT IF EXISTS chk_uhi_txn_counterparty;

ALTER TABLE uhi_transactions
  ALTER COLUMN counterparty_subscriber_id SET NOT NULL,
  ADD CONSTRAINT chk_uhi_txn_counterparty
    CHECK (NULLIF(BTRIM(counterparty_subscriber_id), '') IS NOT NULL),
  ADD CONSTRAINT uq_uhi_txn_leg
    UNIQUE (tenant_id, environment, counterparty_subscriber_id,
            transaction_id, message_id, action, direction, signature_verified);

COMMENT ON TABLE uhi_transactions IS
  'UHI (DHP/beckn) adapter evidence + replay-dedupe ledger: one row per protocol message leg (search/init/confirm intents and on_* callbacks), provider-side, sandbox default. Replay identity is bound to tenant, environment, counterparty subscriber, transaction, message, action, direction, and signature-verification state. Bookings land in the EXISTING appointments tables via the existing booking service; this table never stores a parallel booking. Written from a pre-RLS mount — tenant_id always resolved and written explicitly.';

COMMIT;
