-- Migration 090: batch-50 — declare the staff.user_id → users.uid FK.
--
-- Prisma needs an underlying FK constraint to synthesise the
-- staff ↔ users relation. Once the FK exists, `prisma db pull`
-- picks up the relation on both sides and callers can replace the
-- two-call `fetchStaffRow` helper (batch 49) with a single
-- `prisma.users.findUnique({ include: { staff: true } })`.
--
-- Pre-check (dev + test DB): 0 orphan staff rows — every staff.user_id
-- has a matching users.uid. Adding the FK with ON DELETE SET NULL so
-- a user deletion soft-detaches the staff row rather than cascading
-- (staff row preserves the employee_id / designation / etc. for
-- historical reporting).

BEGIN;

ALTER TABLE staff
  ADD CONSTRAINT staff_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(uid)
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- Matches the pattern the Prisma-generated schema uses for other
-- users-keyed tables (doctors, payslips, medical_records, etc.).
CREATE INDEX IF NOT EXISTS idx_staff_user_id_fk ON staff(user_id);

COMMIT;
