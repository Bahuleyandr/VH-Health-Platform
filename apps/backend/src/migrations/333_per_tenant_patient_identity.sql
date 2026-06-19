-- 333_per_tenant_patient_identity.sql
--
-- W2 (multi-tenancy program) — schema completeness, HIGH. Decision §8.1:
-- per-tenant patient identity. The same person at two hospitals is two
-- isolated patient records (two rows, two uids, same phone, different
-- tenant). So the patient-identity uniques on `users` move from GLOBAL to
-- per-tenant, and the phone/user-keyed global-auth tables get tenant_id.
--
-- ⚠ COORDINATES WITH W4 (edge routing & token tenant claim). Once
-- (tenant_id, phone) is the uniqueness key, login MUST supply the tenant
-- (the per-tenant subdomain/build does; W4 wires the token exchange). Until
-- W4 lands this is a NO-OP for single-tenant login: every existing user is
-- the default tenant, so `WHERE phone = $1` still resolves to exactly one
-- row and the permissive-when-GUC-unset policy keeps every auth flow working
-- unchanged.
--
-- Verified against live QA schema (mig tip 332):
--
--  USERS UNIQUES:
--   * phone — was GLOBAL unique (users_phone_key, a standalone INDEX, NOT
--     NULL, 0 dups, NO FK depends on it) -> (tenant_id, phone).
--   * firebase_uid — had NO unique today (nullable, currently all-NULL).
--     It is the Firebase auth identity (1 Firebase user = 1 patient per
--     tenant), so add the per-tenant identity unique it should have had:
--     (tenant_id, firebase_uid) WHERE firebase_uid IS NOT NULL.
--   * email — DELIBERATELY NOT made unique. There is no existing email
--     unique to tenant-scope, email is nullable, and an email is legitimately
--     SHARED across patient records (a guardian's email for paediatric
--     patients, family accounts). Adding a brand-new uniqueness contract
--     would risk 23505 on legitimate future inserts — out of scope for
--     "tenant-scope the existing identity uniques". (If per-tenant email
--     uniqueness is ever wanted it is a separate product decision that must
--     also handle the shared-email case.)
--   * uid (global surrogate, NOT NULL) and id (PK) are UNCHANGED — both are
--     referenced by dozens of FKs and remain the global keys (§8.1).
--
--  AUTH TABLES (Pattern A — tenant_id + RLS): otp_sessions, otp_logs (phone),
--   password_reset_otps, user_sessions (user_id -> users.id),
--   user_active_sessions (user_uid -> users.uid). totp_challenges and
--   invalidated_tokens stay GLOBAL (platform/opaque per the program's
--   "legitimately global" list).
--
-- Mirrors migration 239 (Pattern A) + 326 (uniq_<t>_tenant_<col>) + 328 (GUC).

BEGIN;

-- ---------------------------------------------------------------------------
-- Part 1: Pattern A on the 5 phone/user-keyed auth tables.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  rec RECORD;
  default_expr text := $def$COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, '00000000-0000-4000-8000-000000000001'::uuid)$def$;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      -- (table, local_key, users_key)  — backfill x.local_key = users.users_key.
      -- NB: password_reset_otps.user_id / user_sessions.user_id are uuid
      -- columns that reference users.uid (NOT the integer users.id) despite
      -- the "_id" name; user_active_sessions.user_uid is likewise users.uid.
      ('otp_sessions',         'phone',    'phone'),
      ('otp_logs',             'phone',    'phone'),
      ('password_reset_otps',  'user_id',  'uid'),
      ('user_sessions',        'user_id',  'uid'),
      ('user_active_sessions', 'user_uid', 'uid')
    ) AS v(tbl, local_key, users_key)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=rec.tbl) THEN
      RAISE NOTICE 'Skipping %: table does not exist', rec.tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid', rec.tbl);
    EXECUTE format(
      'UPDATE %1$I x SET tenant_id = COALESCE(u.tenant_id, ''00000000-0000-4000-8000-000000000001''::uuid) '
      'FROM users u WHERE x.tenant_id IS NULL AND u.%2$I = x.%3$I',
      rec.tbl, rec.users_key, rec.local_key
    );
    EXECUTE format(
      'UPDATE %I SET tenant_id = ''00000000-0000-4000-8000-000000000001''::uuid WHERE tenant_id IS NULL', rec.tbl
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT %s', rec.tbl, default_expr
    );
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = format('fk_%s_tenant', rec.tbl)) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION',
        rec.tbl, format('fk_%s_tenant', rec.tbl)
      );
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', format('idx_%s_tenant_id', rec.tbl), rec.tbl);

    RAISE NOTICE 'Added tenant_id to auth table % (backfill via users.%)', rec.tbl, rec.users_key;
  END LOOP;
END
$$;

-- ENABLE + FORCE RLS + tenant_isolation policy. Kept as a FOREACH-over-ARRAY
-- loop (NOT folded into the VALUES loop above) so the static
-- check-phi-tenant-id guard — which harvests policied tables from ARRAY[...]
-- literals — recognizes these tables as policied.
DO $$
DECLARE
  t text;
  auth_tbls text[] := ARRAY['otp_sessions','otp_logs','password_reset_otps','user_sessions','user_active_sessions'];
BEGIN
  FOREACH t IN ARRAY auth_tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
    $f$, t);
    RAISE NOTICE 'RLS-policied auth table %', t;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Part 2: users identity uniques -> per-tenant.
-- ---------------------------------------------------------------------------
-- phone: swap the global unique (safe — old global unique guarantees no
-- per-tenant collision; verified 0 dups). uid + id are left untouched.
DROP INDEX IF EXISTS users_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_tenant_phone
  ON users (tenant_id, phone);

-- firebase_uid: add the per-tenant identity unique (new; partial — exempts
-- the NULLs of users who never linked a Firebase account).
DO $$
DECLARE clash RECORD;
BEGIN
  SELECT tenant_id, firebase_uid, count(*) AS n INTO clash
    FROM users WHERE firebase_uid IS NOT NULL
   GROUP BY tenant_id, firebase_uid HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'users has % rows sharing (tenant_id=%, firebase_uid=%); dedupe before migration 333',
      clash.n, clash.tenant_id, clash.firebase_uid;
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_tenant_firebase_uid
  ON users (tenant_id, firebase_uid) WHERE firebase_uid IS NOT NULL;

COMMIT;
