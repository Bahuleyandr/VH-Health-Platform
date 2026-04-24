-- 082_investigations_fk_constraints.sql
--
-- Adds FK constraints on investigations so Prisma introspection (`db pull`)
-- produces declared relations — which in turn lets us migrate the six
-- SELECT+JOIN list queries from findMany+batch-stitch (batch 30) to native
-- `include`-based reads, closing the relation-rename drift gap that
-- findMany+stitch can't cover.
--
-- Prerequisite: investigations has 20 orphan rows in `requested_by` pointing
-- at the fixed test UUID '550e8400-e29b-41d4-a716-446655440000'. That UUID
-- is hard-coded in src/tests/testClient.js and used by every admin-role
-- test, so tests continuously regenerate orphan rows when they create
-- investigations. Seeding a user with that UUID resolves the existing
-- orphans and keeps new test-created rows satisfying the FK.
--
-- The seeded user carries phone 9876543210 (a well-known test fixture
-- already used across this codebase) and role ADMIN. Idempotent: ON CONFLICT
-- DO NOTHING means reapplying this migration is safe, and re-seeding the
-- same UUID in dev/test/prod databases converges on the same state.

-- 1. Seed the test-harness user so the 20 existing orphan `requested_by`
--    rows become valid. tenant_id uses the default (DEFAULT_TENANT_ID),
--    role defaults to ADMIN (matches how testClient.js signs its JWTs).
--    Both timestamps are explicit — `updated_at` is NOT NULL without a DB
--    default (see `\d users`), so NOW() it.
INSERT INTO users (uid, phone, name, role, is_active, registered_at, updated_at)
VALUES (
  '550e8400-e29b-41d4-a716-446655440000',
  '9876543210',
  'Test Harness User',
  'ADMIN',
  true,
  NOW(),
  NOW()
)
ON CONFLICT (uid) DO NOTHING;

-- 2. patient_id → users.id FK. The column is nullable (investigations
--    created via phone-only entry points may have a NULL patient_id)
--    so NOT ENFORCED on NULLs. ON DELETE SET NULL preserves the
--    investigation record if a patient is purged.
ALTER TABLE investigations
  DROP CONSTRAINT IF EXISTS investigations_patient_id_fkey,
  ADD CONSTRAINT investigations_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

-- 3. requested_by → users.uid FK. Same nullable semantics — some
--    investigations are created by tasks/jobs without a requesting user.
ALTER TABLE investigations
  DROP CONSTRAINT IF EXISTS investigations_requested_by_fkey,
  ADD CONSTRAINT investigations_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES users(uid)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

-- 4. doctors.user_id → users.id FK. Covers the third table that the
--    investigations list queries used to JOIN (for specialty/department
--    info). The doctors table has zero orphan rows in dev, so this FK
--    validates cleanly on existing data.
ALTER TABLE doctors
  DROP CONSTRAINT IF EXISTS doctors_user_id_fkey,
  ADD CONSTRAINT doctors_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
