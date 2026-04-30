-- Migration 129: Phase E3 — encryption key registry for PHI envelope
-- encryption.
--
-- This is the SUBSTRATE for field-level PHI encryption. Each row tracks
-- a Key Encryption Key (KEK) version. The actual key material lives in
-- the configured KMS provider (AWS KMS / GCP KMS / Vault / env-var dev
-- backend); this table holds the metadata needed for rotation +
-- backward-compatible decryption.
--
-- Per-record Data Encryption Keys (DEKs) are NOT stored here — they
-- live inside the envelope blob alongside each encrypted record (see
-- phiEnvelopeService.js for the wire format). Only KEKs are registered.
--
-- Rotating columns onto envelope encryption is an operational follow-up
-- per surface (users.medical_history, medical_records.notes, etc.) —
-- the substrate ships first; rollouts come later as additive `*_encrypted`
-- columns + dual-write + cutover.

BEGIN;

CREATE TABLE IF NOT EXISTS encryption_keys (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  -- A short, stable identifier for this key version (embedded in the
  -- envelope as `kid`). E.g. 'k1', 'k2026-q1'.
  key_id                      VARCHAR(64) NOT NULL,
  provider                    VARCHAR(40) NOT NULL DEFAULT 'env'
    CHECK (provider IN ('env', 'aws-kms', 'gcp-kms', 'vault', 'azure-keyvault')),
  -- Provider-specific reference: ARN for AWS, key ring path for GCP,
  -- vault secret path, or the env var name for the env provider.
  provider_reference          VARCHAR(512),
  algorithm                   VARCHAR(40) NOT NULL DEFAULT 'aes-256-gcm',
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retiring', 'retired', 'compromised')),
  rotated_from                INTEGER REFERENCES encryption_keys(id) ON DELETE SET NULL,
  -- When this key was first activated for new writes
  activated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Once retiring, no new writes use it but old reads still work
  retiring_at                 TIMESTAMPTZ,
  -- Once retired, the KMS material can be deleted (caller's job)
  retired_at                  TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_enc_keys_active
  ON encryption_keys (tenant_id, status, activated_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_enc_keys_rotated_from
  ON encryption_keys (rotated_from) WHERE rotated_from IS NOT NULL;

COMMIT;
