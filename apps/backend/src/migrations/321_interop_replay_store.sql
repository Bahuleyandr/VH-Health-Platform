-- 321_interop_replay_store.sql
--
-- C-4 (interop) — cross-replica HMAC replay protection for the public,
-- unauthenticated inbound integration mounts (ABDM gateway callbacks, HL7v2
-- /receive).
--
-- PROBLEM. src/utils/signedRequest.js protected against signed-request replay
-- with a per-PROCESS `new Map()`. The backend runs CLUSTER_WORKERS workers ×
-- 3 replicas, so a captured (still timestamp-fresh) signed request replayed
-- against a DIFFERENT process is NOT seen as a replay by that process's empty
-- Map and is accepted again — defeating the protection entirely for the exact
-- multi-process topology we deploy. An attacker who captures one valid ABDM
-- data-export callback or one HL7 ORU lab-result message can replay it within
-- the 5-minute freshness window to a sibling replica.
--
-- FIX. Back the replay check with a SHARED store. The code prefers Redis
-- (SET key NX EX <window>) when REDIS_URL is wired; when Redis is not
-- connected (current prod Sealed Secret ships it un-wired) it falls back to
-- THIS table: a unique (namespace, request_id) insert is the cross-replica
-- "claim". A duplicate insert raises 23505 (unique_violation) → replay
-- rejected on every replica. The in-process Map in signedRequest.js stays as
-- the fast path (rejects same-process replays without a round-trip); this
-- table/Redis is the authoritative cross-process gate.
--
-- TTL. Rows are only meaningful for the signature freshness window (default
-- 5 min). `expires_at` lets a cheap sweep delete stale rows so the table stays
-- tiny; a stale row that has not yet been swept is harmless (it can only ever
-- reject a request whose timestamp is itself already stale and would be
-- rejected by the freshness check anyway).
--
-- NOT tenant-scoped: these are pre-tenant-context, public integration mounts;
-- the row holds only an opaque namespace + request id (no PHI), so it carries
-- no tenant_id and therefore no tenant_isolation policy (matches the
-- migration 304 self-exclusion rule for tables without a tenant_id column).
--
-- IDEMPOTENT: IF NOT EXISTS throughout; safe to re-run. Single-transaction.

BEGIN;

CREATE TABLE IF NOT EXISTS interop_replay_guard (
  id          BIGSERIAL PRIMARY KEY,
  namespace   VARCHAR(64)  NOT NULL,
  request_id  VARCHAR(256) NOT NULL,
  seen_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ  NOT NULL
);

-- The cross-replica replay claim: a duplicate (namespace, request_id) insert
-- raises 23505, which the app maps to a replay rejection.
CREATE UNIQUE INDEX IF NOT EXISTS uq_interop_replay_guard_ns_rid
  ON interop_replay_guard (namespace, request_id);

-- Sweep support — delete rows past their freshness window cheaply.
CREATE INDEX IF NOT EXISTS idx_interop_replay_guard_expires_at
  ON interop_replay_guard (expires_at);

COMMIT;
