-- ABDM consent and data-request persistence.
-- The ABDM routes/services have used these tables for consent callbacks,
-- patient approvals, and HIU data requests; this migration makes the schema
-- explicit in the canonical migration stream.

CREATE TABLE IF NOT EXISTS abdm_consents (
  id SERIAL PRIMARY KEY,
  consent_id VARCHAR(100) UNIQUE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  hip_id VARCHAR(100),
  hiu_id VARCHAR(100),
  purpose VARCHAR(100),
  hi_types TEXT[],
  date_range_from TIMESTAMPTZ,
  date_range_to TIMESTAMPTZ,
  expiry_date TIMESTAMPTZ,
  status VARCHAR(50) NOT NULL DEFAULT 'REQUESTED',
  requester_name VARCHAR(255),
  consent_artifact JSONB,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE abdm_consents
  ADD COLUMN IF NOT EXISTS consent_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS patient_uid UUID,
  ADD COLUMN IF NOT EXISTS hip_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS hiu_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(100),
  ADD COLUMN IF NOT EXISTS hi_types TEXT[],
  ADD COLUMN IF NOT EXISTS date_range_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS date_range_to TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'REQUESTED',
  ADD COLUMN IF NOT EXISTS requester_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS consent_artifact JSONB,
  ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_abdm_consents_consent_id
  ON abdm_consents(consent_id)
  WHERE consent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_abdm_consents_patient_uid ON abdm_consents(patient_uid);
CREATE INDEX IF NOT EXISTS idx_abdm_consents_status ON abdm_consents(status);
CREATE INDEX IF NOT EXISTS idx_abdm_consents_created_at ON abdm_consents(created_at DESC);

CREATE TABLE IF NOT EXISTS abdm_data_requests (
  id SERIAL PRIMARY KEY,
  transaction_id VARCHAR(100) UNIQUE,
  consent_id VARCHAR(100),
  patient_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  hi_types TEXT[],
  date_range_from TIMESTAMPTZ,
  date_range_to TIMESTAMPTZ,
  key_material JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'PROCESSING',
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE abdm_data_requests
  ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS consent_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS patient_uid UUID,
  ADD COLUMN IF NOT EXISTS hi_types TEXT[],
  ADD COLUMN IF NOT EXISTS date_range_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS date_range_to TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS key_material JSONB,
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'PROCESSING',
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_abdm_data_requests_transaction_id
  ON abdm_data_requests(transaction_id)
  WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_abdm_data_requests_patient_uid ON abdm_data_requests(patient_uid);
CREATE INDEX IF NOT EXISTS idx_abdm_data_requests_consent_id ON abdm_data_requests(consent_id);
CREATE INDEX IF NOT EXISTS idx_abdm_data_requests_status ON abdm_data_requests(status);
