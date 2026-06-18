-- 324_audit_chain_hardening.sql
--
-- Platform audit 2026-06-18 §3 (PHI/Audit — "audit hash chain is theatrical").
--
-- Problem: the application DB role can UPDATE or DELETE any row in the audit
-- tables. The tamper-evident hash chain on clinical_audit_events (migration
-- 282) only DETECTS edits after the fact; nothing PREVENTS an attacker (or a
-- buggy code path) with app-level DB write from rewriting or deleting audit
-- history. For HIPAA these tables must be append-only at the database layer.
--
-- Fix: a BEFORE UPDATE OR DELETE trigger on every existing audit table that
-- RAISEs an exception, so the tables accept INSERT only. The trigger fires for
-- EVERY role (including the table owner / superuser) — triggers are not
-- role-gated; the only thing that suppresses them is session_replication_role
-- = 'replica', which the app never sets.
--
-- Legitimate UPDATE/DELETE escape hatches. The guard allows a mutation when
-- EITHER of the following holds:
--
--   (1) `app.audit_bypass = 'on'` — an EXPLICIT, transaction-local opt-in. The
--       90-day retention purge of audit_log (src/utils/scheduler.js) and any
--       future maintenance migration set `SET LOCAL app.audit_bypass = 'on'`
--       (or set_config('app.audit_bypass','on',true)) before the UPDATE/DELETE.
--       This mirrors the existing `app.current_tenant_id` RLS-bypass idiom:
--       normal request/job code never sets it, so ordinary writes stay
--       append-only, while a named, auditable code path can perform retention
--       deletes. Transaction-local → never leaks across pooled connections, and
--       works even when the caller has SET LOCAL ROLE to the non-superuser
--       runtime role.
--
--   (2) the effective role (current_user) is a SUPERUSER. This is the accepted
--       threat-model boundary for DB-trigger append-only: a superuser can drop
--       the trigger outright, so blocking it buys nothing. The PRODUCTION app
--       role is NOSUPERUSER NOBYPASSRLS by design (vhhealth_app — see
--       src/lib/prisma.js role-sealing + docs/GO_LIVE_ACTIVATION_CHECKLIST.md),
--       so an attacker holding only app-level DB write is blocked. This branch
--       exists so superuser-connected maintenance / the test harness keep
--       working without every cleanup site having to know about the bypass GUC;
--       it grants the prod app role nothing, because that role is not super.
--
--   NB: migration 282's chain backfill (UPDATE clinical_audit_events SET
--   chain_seq …) runs BEFORE this migration, so it is unaffected. Any FUTURE
--   migration that must touch a chained/audit row should set app.audit_bypass
--   inside its own transaction (or rely on the superuser branch when applied as
--   superuser) — by design.
--
-- Idempotent: DROP TRIGGER IF EXISTS then CREATE for each table; guarded by an
-- information_schema existence check so only tables that actually exist in this
-- database get the trigger (the six audit tables are not all present on every
-- historical schema).

BEGIN;

-- Single shared guard function. Blocks UPDATE and DELETE unless the caller has
-- explicitly opted into the append-only bypass for this transaction.
CREATE OR REPLACE FUNCTION audit_append_only_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- (1) Explicit, transaction-scoped maintenance opt-in (retention purge etc.).
  IF current_setting('app.audit_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- (2) Superuser maintenance / test harness. The prod app role is
  --     NOSUPERUSER NOBYPASSRLS, so this never grants the application a bypass.
  IF COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'audit table %.% is append-only: % is not permitted (set app.audit_bypass to perform an authorized maintenance delete)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

-- Attach the guard to each audit table that exists. One BEFORE UPDATE OR DELETE
-- trigger per table; INSERT is never touched, so the append path is unaffected.
DO $$
DECLARE
  t TEXT;
  audit_tables TEXT[] := ARRAY[
    'clinical_audit_events',
    'audit_log',
    'audit_logs',
    'hipaa_access_log',
    'patient_access_audit_log',
    'staff_access_audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY audit_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_append_only ON public.%I', t, t);
      EXECUTE format(
        'CREATE TRIGGER trg_%s_append_only '
        || 'BEFORE UPDATE OR DELETE ON public.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard()',
        t, t
      );
      RAISE NOTICE 'migration 324: append-only trigger installed on %', t;
    ELSE
      RAISE NOTICE 'migration 324: audit table % does not exist — skipped', t;
    END IF;
  END LOOP;
END
$$;

-- Provenance row (best-effort; only if audit_logs exists and not already recorded).
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'AUDIT_APPEND_ONLY_TRIGGERS_APPLIED',
  'audit_tables',
  'audit_tables',
  jsonb_build_object(
    'migration', '324_audit_chain_hardening.sql',
    'audit_ref', 'docs/PLATFORM_AUDIT_2026-06-18.md#3',
    'reason', 'BEFORE UPDATE OR DELETE append-only guard on audit tables; UPDATE/DELETE blocked unless app.audit_bypass=on (retention purge / maintenance only).',
    'bypass_guc', 'app.audit_bypass'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'AUDIT_APPEND_ONLY_TRIGGERS_APPLIED' AND resource = 'audit_tables'
);

COMMIT;
