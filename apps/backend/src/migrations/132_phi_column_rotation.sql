-- Migration 132: Phase E3 follow-up — shadow PHI columns for envelope
-- encryption rotation.
--
-- Adds *_encrypted shadow columns alongside the highest-PHI plaintext
-- columns identified by the spec audit (users.name / users.phone /
-- users.address, medical_records.description / diagnosis / treatment).
--
-- Plus `users.phone_search_hash` — a deterministic HMAC-SHA256 of the
-- normalised phone for equality-search lookups without decryption
-- (Firebase OTP and staff lookup paths depend on phone equality).
--
-- This migration is ADDITIVE. The plaintext columns remain authoritative
-- for reads and unencrypted callers continue to work. Once the helper
-- (phiColumnEncryption.js) is wired into write paths and the backfill
-- script has run, an operational follow-up flips reads to
-- encrypted-first-with-plaintext-fallback, then a future migration drops
-- the plaintext columns. Each cutover step is independently reversible.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS name_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS phone_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS phone_search_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS address_encrypted TEXT;

CREATE INDEX IF NOT EXISTS idx_users_phone_search_hash
  ON users (phone_search_hash) WHERE phone_search_hash IS NOT NULL;

ALTER TABLE medical_records
  ADD COLUMN IF NOT EXISTS description_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS diagnosis_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS treatment_encrypted TEXT;

COMMIT;
