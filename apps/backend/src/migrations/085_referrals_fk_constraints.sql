-- 085_referrals_fk_constraints.sql
--
-- Declares referrals FKs so Prisma introspection produces include-
-- capable relations. Referrals' list reads don't JOIN today (batch 30
-- migrated them to findMany without relations) but having the declared
-- relations completes the drift-safety story across the three clinical
-- domains (investigations, pharmacy, appointments, now referrals).
--
-- Pre-flight on dev (2026-04-24):
--   patient_uid         orphans: 0
--   referring_doctor    orphans: 0
--   referred_to_doctor  orphans: 0
--   accepted_by         orphans: 0
-- → all four FKs validate cleanly.

ALTER TABLE referrals
  DROP CONSTRAINT IF EXISTS referrals_patient_uid_fkey,
  ADD CONSTRAINT referrals_patient_uid_fkey
    FOREIGN KEY (patient_uid) REFERENCES users(uid)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION;

ALTER TABLE referrals
  DROP CONSTRAINT IF EXISTS referrals_referring_doctor_fkey,
  ADD CONSTRAINT referrals_referring_doctor_fkey
    FOREIGN KEY (referring_doctor) REFERENCES users(uid)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION;

ALTER TABLE referrals
  DROP CONSTRAINT IF EXISTS referrals_referred_to_doctor_fkey,
  ADD CONSTRAINT referrals_referred_to_doctor_fkey
    FOREIGN KEY (referred_to_doctor) REFERENCES users(uid)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

-- accepted_by → users.uid (the uuid of whoever accepted the referral).
-- Nullable; ON DELETE SET NULL.
ALTER TABLE referrals
  DROP CONSTRAINT IF EXISTS referrals_accepted_by_fkey,
  ADD CONSTRAINT referrals_accepted_by_fkey
    FOREIGN KEY (accepted_by) REFERENCES users(uid)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
