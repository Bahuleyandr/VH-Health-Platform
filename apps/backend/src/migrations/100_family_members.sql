-- Migration 100: family_members.
--
-- Backs the patient app's Family screen — list + add + remove family
-- members linked to a patient account. Same shape that the existing
-- familyRoutes.js reads/writes; without this table every fetch was
-- failing with 42P01 and the route was returning [] via the graceful
-- fallback added in the dashboard sweep.
--
-- patient_uid is uuid (matches `users.uid`) so the route's
-- `WHERE patient_uid = $1::uuid` query lands cleanly with the JWT's
-- own uid.

BEGIN;

CREATE TABLE IF NOT EXISTS family_members (
  id            BIGSERIAL PRIMARY KEY,
  patient_uid   UUID NOT NULL,
  name          VARCHAR(255) NOT NULL,
  phone         VARCHAR(20),
  relationship  VARCHAR(50),
  date_of_birth DATE,
  created_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT family_members_patient_fk
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_family_members_patient_uid
  ON family_members(patient_uid);

COMMIT;
