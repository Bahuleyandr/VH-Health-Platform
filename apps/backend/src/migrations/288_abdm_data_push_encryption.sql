-- 288_abdm_data_push_encryption.sql
--
-- Roadmap C1 follow-up (docs/EPIC_LEVEL_ROADMAP.md, Pillar C) — ABDM M2
-- data-push encryption support columns.
--
--   * data_push_url        — the HIU's dataPushUrl from the hiRequest;
--                            encrypted entries POST directly to it (the
--                            gateway path is only the fallback/ack).
--   * sender_key_material  — OUR ephemeral public key material for the
--                            transfer (cryptoAlg/curve/dhPublicKey/nonce).
--                            Public half only — private keys are ephemeral
--                            in-memory and never persisted. Kept for
--                            certification-run traceability/debugging.
--
-- Payload encryption itself is code-side: src/services/abdm/abdmCrypto.js
-- (FIDELIUS-equivalent ECDH Curve25519 + HKDF-SHA256 + AES-256-GCM).

BEGIN;

ALTER TABLE abdm_data_requests ADD COLUMN IF NOT EXISTS data_push_url TEXT;
ALTER TABLE abdm_data_requests ADD COLUMN IF NOT EXISTS sender_key_material JSONB;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'ABDM_DATA_PUSH_ENCRYPTION_APPLIED',
  'abdm_data_requests',
  'abdm_data_requests',
  jsonb_build_object(
    'migration', '288_abdm_data_push_encryption.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#C1',
    'reason', 'M2 data-push: capture HIU dataPushUrl + persist sender public key material; payload encryption implemented in abdmCrypto.js.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'ABDM_DATA_PUSH_ENCRYPTION_APPLIED'
    AND resource = 'abdm_data_requests'
);

COMMIT;
