-- Migration 130: Phase E4 — generic idempotency-key store.
--
-- Lets clients safely retry critical POST endpoints (orders, payments,
-- prescriptions, claims, etc.) without creating duplicates. The middleware
-- expects the client to send `Idempotency-Key: <opaque-id>` and consults
-- this table.

BEGIN;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID REFERENCES tenants(id) ON DELETE CASCADE,
  -- The opaque key the client sent. Bounded to 200 chars so we can
  -- safely use it in a UNIQUE constraint without an index bloat.
  request_key         VARCHAR(200) NOT NULL,
  -- The request scope: which user issued it (so two users can reuse
  -- the same key without colliding) and the request signature
  -- (method+path+sha256-of-body) so a key reused with a *different*
  -- payload is rejected.
  user_uid            UUID,
  request_method      VARCHAR(10) NOT NULL,
  request_path        VARCHAR(255) NOT NULL,
  request_body_hash   CHAR(64),
  -- Lifecycle: in-flight while the original request executes; complete
  -- once the response is captured. 'failed' means the original attempt
  -- failed and the cached response is the failure. 'expired' is a
  -- soft tombstone left after retention.
  status              VARCHAR(20) NOT NULL DEFAULT 'in_flight'
    CHECK (status IN ('in_flight', 'complete', 'failed', 'expired')),
  -- Cached response: status code + body. Body is JSONB so we can store
  -- large nested objects; consumers that want raw text can wrap it.
  response_status     INTEGER,
  response_body       JSONB,
  -- Bookkeeping
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_uid, request_key, request_path)
);

CREATE INDEX IF NOT EXISTS idx_idem_expires
  ON idempotency_keys (expires_at)
  WHERE status NOT IN ('expired');
CREATE INDEX IF NOT EXISTS idx_idem_status_created
  ON idempotency_keys (tenant_id, status, created_at DESC);

COMMIT;
