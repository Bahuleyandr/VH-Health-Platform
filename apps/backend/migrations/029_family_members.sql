-- 029_family_members.sql
-- Family members linked to a patient account

CREATE TABLE IF NOT EXISTS family_members (
  id              SERIAL PRIMARY KEY,
  patient_uid     UUID NOT NULL,
  name            VARCHAR(255) NOT NULL,
  phone           VARCHAR(20),
  relationship    VARCHAR(50),
  date_of_birth   DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_family_members_uid ON family_members (patient_uid);
