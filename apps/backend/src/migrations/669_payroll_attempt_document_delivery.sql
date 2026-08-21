-- 669: Durable payroll-attempt ownership and versioned payslip delivery.
--
-- A payroll period can be recovered after a stale worker.  The former schema
-- kept only the latest run timestamp and one mutable payslip row, so a success
-- from the abandoned attempt could be issued after the recovery attempt failed.
-- It also overwrote a stable object key with a new PDF password before the
-- password notification had any durable delivery evidence.
--
-- This migration deliberately fails on ambiguous staff identities.  Payroll
-- must enumerate one authoritative row per tenant user; choosing one of two
-- staff-directory rows would silently choose salary metadata for a money path.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  clash record;
BEGIN
  SELECT tenant_id, user_id, count(*) AS row_count
    INTO clash
    FROM public.staff
   WHERE user_id IS NOT NULL
   GROUP BY tenant_id, user_id
  HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        'staff has %s rows for tenant/user (%s, %s); resolve the authoritative staff identity before migration 669',
        clash.row_count, clash.tenant_id, clash.user_id
      );
  END IF;

  SELECT tenant_id, staff_uid, count(*) AS row_count
    INTO clash
    FROM public.staff_salary
   GROUP BY tenant_id, staff_uid
  HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        'staff_salary has %s rows for tenant/user (%s, %s); resolve the authoritative salary identity before migration 669',
        clash.row_count, clash.tenant_id, clash.staff_uid
      );
  END IF;

  SELECT tenant_id, uid, count(*) AS row_count
    INTO clash
    FROM public.users
   GROUP BY tenant_id, uid
  HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        'users has %s rows for tenant/uid (%s, %s); resolve the authoritative user identity before migration 669',
        clash.row_count, clash.tenant_id, clash.uid
      );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payroll_runs AS run
     WHERE run.failed_staff IS NOT NULL
       AND jsonb_typeof(run.failed_staff) <> 'array'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payroll_runs.failed_staff contains a non-array value';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payroll_runs AS run
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(run.failed_staff, '[]'::jsonb)) AS failure
     WHERE COALESCE(failure->>'staff_uid', '') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payroll_runs.failed_staff contains an invalid staff_uid';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payroll_runs AS run
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(run.failed_staff, '[]'::jsonb)) AS failure
     GROUP BY run.tenant_id, run.id, failure->>'staff_uid'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'payroll_runs.failed_staff contains duplicate staff outcomes';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payroll_runs AS run
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(run.failed_staff, '[]'::jsonb)) AS failure
      JOIN public.payslips AS payslip
        ON payslip.tenant_id = run.tenant_id
       AND payslip.payroll_run_id = run.id
       AND payslip.staff_uid = (failure->>'staff_uid')::uuid
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a legacy payroll run records the same staff member as both succeeded and failed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payroll_runs AS run
      JOIN public.payslips AS payslip
        ON payslip.tenant_id = run.tenant_id
       AND payslip.payroll_run_id = run.id
     WHERE (
       run.status IN ('approved', 'locked')
       OR run.hr_approved_at IS NOT NULL
       OR run.admin_approved_at IS NOT NULL
     )
       AND payslip.status NOT IN ('issued', 'viewed', 'downloaded')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'signed legacy payroll contains an unissued payslip; issue or explicitly unwind it before migration 669';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_tenant_user_identity
  ON public.staff (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_salary_tenant_user_identity
  ON public.staff_salary (tenant_id, staff_uid);


ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS attempt_token uuid,
  ADD COLUMN IF NOT EXISTS result_manifest_hash char(64),
  ADD COLUMN IF NOT EXISTS document_manifest_hash char(64);

UPDATE public.payroll_runs
   SET attempt_token = gen_random_uuid()
 WHERE attempt_token IS NULL;

ALTER TABLE public.payroll_runs
  ALTER COLUMN attempt_token SET DEFAULT gen_random_uuid(),
  ALTER COLUMN attempt_token SET NOT NULL;

CREATE UNIQUE INDEX ux_payroll_runs_current_attempt_binding
  ON public.payroll_runs (tenant_id, id, attempt_token);

ALTER TABLE public.payroll_runs
  ADD CONSTRAINT chk_payroll_runs_attempt_manifests
  CHECK (
    (result_manifest_hash IS NULL AND document_manifest_hash IS NULL)
    OR (
      result_manifest_hash ~ '^[0-9a-f]{64}$'
      AND document_manifest_hash ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS generation_attempt_token uuid,
  ADD COLUMN IF NOT EXISTS document_revision integer NOT NULL DEFAULT 1;

UPDATE public.payslips AS payslip
   SET generation_attempt_token = run.attempt_token
  FROM public.payroll_runs AS run
 WHERE payslip.generation_attempt_token IS NULL
   AND run.tenant_id = payslip.tenant_id
   AND run.id = payslip.payroll_run_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payslips
     WHERE payroll_run_id IS NOT NULL AND generation_attempt_token IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a payslip with payroll_run_id could not be assigned to a payroll attempt';
  END IF;
END
$$;

ALTER TABLE public.payslips
  ADD CONSTRAINT chk_payslips_document_revision_positive
  CHECK (document_revision > 0);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payslips_tenant_id
  ON public.payslips (tenant_id, id);

DROP INDEX IF EXISTS public.ux_payslips_tenant_staff_period;

CREATE UNIQUE INDEX ux_payslips_tenant_staff_period
  ON public.payslips (tenant_id, staff_uid, month, year)
  WHERE status IS DISTINCT FROM 'superseded';

CREATE UNIQUE INDEX ux_payslips_attempt_staff_binding
  ON public.payslips
    (tenant_id, id, payroll_run_id, generation_attempt_token, staff_uid);

CREATE TABLE public.payroll_run_attempts (
  tenant_id uuid NOT NULL,
  payroll_run_id integer NOT NULL,
  attempt_token uuid NOT NULL,
  started_at timestamptz NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'processing',
  expected_staff_count integer NOT NULL DEFAULT 0,
  succeeded_staff_count integer NOT NULL DEFAULT 0,
  failed_staff_count integer NOT NULL DEFAULT 0,
  finalized_at timestamptz,
  superseded_at timestamptz,
  superseded_by_attempt_token uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payroll_run_attempts_pkey
    PRIMARY KEY (tenant_id, payroll_run_id, attempt_token),
  CONSTRAINT fk_payroll_run_attempts_run
    FOREIGN KEY (tenant_id, payroll_run_id)
    REFERENCES public.payroll_runs (tenant_id, id),
  CONSTRAINT chk_payroll_run_attempts_status
    CHECK (status IN ('processing', 'completed', 'completed_with_errors', 'superseded')),
  CONSTRAINT chk_payroll_run_attempts_counts
    CHECK (
      expected_staff_count >= 0
      AND succeeded_staff_count >= 0
      AND failed_staff_count >= 0
      AND succeeded_staff_count + failed_staff_count <= expected_staff_count
    ),
  CONSTRAINT chk_payroll_run_attempts_supersession
    CHECK (
      (status = 'superseded' AND superseded_at IS NOT NULL AND superseded_by_attempt_token IS NOT NULL)
      OR (status <> 'superseded' AND superseded_at IS NULL AND superseded_by_attempt_token IS NULL)
    )
  ,CONSTRAINT fk_payroll_run_attempts_superseded_by
    FOREIGN KEY (tenant_id, payroll_run_id, superseded_by_attempt_token)
    REFERENCES public.payroll_run_attempts (tenant_id, payroll_run_id, attempt_token)
    DEFERRABLE INITIALLY DEFERRED
);

INSERT INTO public.payroll_run_attempts (
  tenant_id, payroll_run_id, attempt_token, started_at, status, finalized_at
)
SELECT run.tenant_id,
       run.id,
       run.attempt_token,
       COALESCE(run.generated_at, run.created_at, clock_timestamp()),
       CASE
         WHEN run.status = 'processing' THEN 'processing'
         WHEN COALESCE(run.failed_staff_count, 0) > 0 THEN 'completed_with_errors'
         ELSE 'completed'
       END,
       CASE WHEN run.status = 'processing' THEN NULL ELSE COALESCE(run.updated_at, run.generated_at, run.created_at) END
  FROM public.payroll_runs AS run
ON CONFLICT DO NOTHING;

ALTER TABLE public.payroll_runs
  ADD CONSTRAINT fk_payroll_runs_current_attempt
  FOREIGN KEY (tenant_id, id, attempt_token)
  REFERENCES public.payroll_run_attempts (tenant_id, payroll_run_id, attempt_token)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.payslips
  ADD CONSTRAINT fk_payslips_generation_attempt
  FOREIGN KEY (tenant_id, payroll_run_id, generation_attempt_token)
  REFERENCES public.payroll_run_attempts (tenant_id, payroll_run_id, attempt_token)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.payroll_run_staff_results (
  tenant_id uuid NOT NULL,
  payroll_run_id integer NOT NULL,
  attempt_token uuid NOT NULL,
  staff_uid uuid NOT NULL,
  outcome varchar(16) NOT NULL DEFAULT 'pending',
  payslip_id integer,
  payslip_document_revision integer,
  gross_salary numeric(12,2),
  net_salary numeric(12,2),
  total_deductions numeric(12,2),
  finance_effects jsonb,
  failure_reason text,
  started_at timestamptz,
  finalized_at timestamptz,
  superseded_at timestamptz,
  superseded_by_attempt_token uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payroll_run_staff_results_pkey
    PRIMARY KEY (tenant_id, payroll_run_id, attempt_token, staff_uid),
  CONSTRAINT ux_payroll_run_staff_results_payslip_binding
    UNIQUE (tenant_id, payslip_id, payroll_run_id, attempt_token, staff_uid),
  CONSTRAINT fk_payroll_run_staff_results_attempt
    FOREIGN KEY (tenant_id, payroll_run_id, attempt_token)
    REFERENCES public.payroll_run_attempts (tenant_id, payroll_run_id, attempt_token),
  CONSTRAINT fk_payroll_run_staff_results_staff
    FOREIGN KEY (tenant_id, staff_uid)
    REFERENCES public.users (tenant_id, uid),
  CONSTRAINT fk_payroll_run_staff_results_payslip
    FOREIGN KEY (tenant_id, payslip_id, payroll_run_id, attempt_token, staff_uid)
    REFERENCES public.payslips
      (tenant_id, id, payroll_run_id, generation_attempt_token, staff_uid),
  CONSTRAINT fk_payroll_run_staff_results_superseded_by
    FOREIGN KEY (tenant_id, payroll_run_id, superseded_by_attempt_token)
    REFERENCES public.payroll_run_attempts (tenant_id, payroll_run_id, attempt_token)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_payroll_run_staff_results_outcome
    CHECK (outcome IN ('pending', 'calculated', 'succeeded', 'failed')),
  CONSTRAINT chk_payroll_run_staff_results_finance_effects
    CHECK (finance_effects IS NULL OR jsonb_typeof(finance_effects) = 'object'),
  CONSTRAINT chk_payroll_run_staff_results_shape
    CHECK (
      (outcome = 'pending' AND payslip_id IS NULL AND payslip_document_revision IS NULL
        AND finance_effects IS NULL AND failure_reason IS NULL
        AND finalized_at IS NULL AND gross_salary IS NULL AND net_salary IS NULL
        AND total_deductions IS NULL)
      OR (outcome = 'calculated' AND payslip_id IS NOT NULL AND payslip_document_revision IS NOT NULL
        AND failure_reason IS NULL
        AND finalized_at IS NULL AND gross_salary IS NOT NULL AND net_salary IS NOT NULL
        AND total_deductions IS NOT NULL)
      OR (outcome = 'succeeded' AND payslip_id IS NOT NULL AND payslip_document_revision IS NOT NULL
        AND failure_reason IS NULL
        AND finalized_at IS NOT NULL AND gross_salary IS NOT NULL AND net_salary IS NOT NULL
        AND total_deductions IS NOT NULL)
      OR (outcome = 'failed' AND payslip_id IS NULL AND payslip_document_revision IS NULL
        AND finance_effects IS NULL AND failure_reason IS NOT NULL
        AND finalized_at IS NOT NULL)
    ),
  CONSTRAINT chk_payroll_run_staff_results_supersession
    CHECK (
      (superseded_at IS NULL AND superseded_by_attempt_token IS NULL)
      OR (superseded_at IS NOT NULL AND superseded_by_attempt_token IS NOT NULL)
    )
);

INSERT INTO public.payroll_run_staff_results (
  tenant_id, payroll_run_id, attempt_token, staff_uid, outcome,
  payslip_id, payslip_document_revision, gross_salary, net_salary, total_deductions,
  finalized_at, created_at, updated_at
)
SELECT payslip.tenant_id,
       payslip.payroll_run_id,
       payslip.generation_attempt_token,
       payslip.staff_uid,
       'succeeded',
       payslip.id,
       payslip.document_revision,
       payslip.gross_salary,
       payslip.net_salary,
       payslip.total_deductions,
       COALESCE(payslip.updated_at, payslip.created_at, clock_timestamp()),
       COALESCE(payslip.created_at, clock_timestamp()),
       COALESCE(payslip.updated_at, payslip.created_at, clock_timestamp())
  FROM public.payslips AS payslip
 WHERE payslip.payroll_run_id IS NOT NULL
   AND payslip.staff_uid IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.payroll_run_staff_results (
  tenant_id, payroll_run_id, attempt_token, staff_uid, outcome,
  failure_reason, finalized_at, created_at, updated_at
)
SELECT run.tenant_id,
       run.id,
       run.attempt_token,
       (failure->>'staff_uid')::uuid,
       'failed',
       LEFT(COALESCE(NULLIF(failure->>'reason', ''), 'Legacy payroll failure'), 500),
       COALESCE(run.updated_at, run.generated_at, run.created_at, clock_timestamp()),
       COALESCE(run.generated_at, run.created_at, clock_timestamp()),
       COALESCE(run.updated_at, run.generated_at, run.created_at, clock_timestamp())
  FROM public.payroll_runs AS run
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(run.failed_staff, '[]'::jsonb)) AS failure
ON CONFLICT DO NOTHING;

UPDATE public.payroll_run_attempts AS attempt
   SET expected_staff_count = counts.expected_count,
       succeeded_staff_count = counts.succeeded_count,
       failed_staff_count = counts.failed_count,
       updated_at = clock_timestamp()
  FROM (
    SELECT result.tenant_id,
           result.payroll_run_id,
           result.attempt_token,
           count(*)::integer AS expected_count,
           count(*) FILTER (WHERE result.outcome = 'succeeded')::integer AS succeeded_count,
           count(*) FILTER (WHERE result.outcome = 'failed')::integer AS failed_count
      FROM public.payroll_run_staff_results AS result
     GROUP BY result.tenant_id, result.payroll_run_id, result.attempt_token
  ) AS counts
 WHERE attempt.tenant_id = counts.tenant_id
   AND attempt.payroll_run_id = counts.payroll_run_id
   AND attempt.attempt_token = counts.attempt_token;

CREATE INDEX idx_payroll_run_staff_results_current
  ON public.payroll_run_staff_results
    (tenant_id, payroll_run_id, attempt_token, outcome)
  WHERE superseded_at IS NULL;

CREATE TABLE public.payslip_documents (
  id bigserial PRIMARY KEY,
  object_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  tenant_id uuid NOT NULL,
  payslip_id integer NOT NULL,
  payroll_run_id integer NOT NULL,
  attempt_token uuid NOT NULL,
  staff_uid uuid NOT NULL,
  payslip_revision integer NOT NULL,
  version integer NOT NULL,
  object_key text NOT NULL,
  credential_ciphertext text NOT NULL,
  content_sha256 char(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'prepared',
  storage_verified_at timestamptz,
  notification_outbox_id integer,
  failure_reason text,
  uploaded_at timestamptz,
  delivery_queued_at timestamptz,
  notification_accepted_at timestamptz,
  credential_revealed_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ux_payslip_documents_version
    UNIQUE (tenant_id, payslip_id, version),
  CONSTRAINT ux_payslip_documents_object_key UNIQUE (object_key),
  CONSTRAINT ux_payslip_documents_notification UNIQUE (tenant_id, notification_outbox_id),
  CONSTRAINT fk_payslip_documents_payslip
    FOREIGN KEY (tenant_id, payslip_id, payroll_run_id, attempt_token, staff_uid)
    REFERENCES public.payslips
      (tenant_id, id, payroll_run_id, generation_attempt_token, staff_uid),
  CONSTRAINT fk_payslip_documents_attempt
    FOREIGN KEY (tenant_id, payroll_run_id, attempt_token)
    REFERENCES public.payroll_run_attempts (tenant_id, payroll_run_id, attempt_token),
  CONSTRAINT fk_payslip_documents_outbox
    FOREIGN KEY (tenant_id, notification_outbox_id)
    REFERENCES public.notification_outbox (tenant_id, id),
  CONSTRAINT chk_payslip_documents_revision_version
    CHECK (payslip_revision > 0 AND version > 0),
  CONSTRAINT chk_payslip_documents_hash
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_payslip_documents_status
    CHECK (status IN ('prepared', 'uploaded', 'delivery_queued', 'notification_accepted', 'failed', 'superseded')),
  CONSTRAINT chk_payslip_documents_state
    CHECK (
      (status = 'prepared' AND notification_outbox_id IS NULL AND uploaded_at IS NULL
        AND storage_verified_at IS NULL
        AND delivery_queued_at IS NULL AND notification_accepted_at IS NULL AND superseded_at IS NULL)
      OR (status = 'uploaded' AND notification_outbox_id IS NULL AND uploaded_at IS NOT NULL
        AND storage_verified_at IS NOT NULL AND delivery_queued_at IS NULL
        AND notification_accepted_at IS NULL AND superseded_at IS NULL)
      OR (status = 'delivery_queued' AND notification_outbox_id IS NOT NULL AND uploaded_at IS NOT NULL
        AND storage_verified_at IS NOT NULL AND delivery_queued_at IS NOT NULL
        AND notification_accepted_at IS NULL AND superseded_at IS NULL)
      OR (status = 'notification_accepted' AND notification_outbox_id IS NOT NULL AND uploaded_at IS NOT NULL
        AND storage_verified_at IS NOT NULL AND delivery_queued_at IS NOT NULL
        AND notification_accepted_at IS NOT NULL AND superseded_at IS NULL)
      OR (status = 'failed' AND failure_reason IS NOT NULL AND superseded_at IS NULL)
      OR (status = 'superseded' AND superseded_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX ux_payslip_documents_active_revision
  ON public.payslip_documents (tenant_id, payslip_id, payslip_revision)
  WHERE status IN ('prepared', 'uploaded', 'delivery_queued', 'notification_accepted');

CREATE INDEX idx_payslip_documents_attempt_delivery
  ON public.payslip_documents (tenant_id, payroll_run_id, attempt_token, status);

CREATE OR REPLACE FUNCTION public.guard_payslip_document_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.object_token IS DISTINCT FROM OLD.object_token
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.payslip_id IS DISTINCT FROM OLD.payslip_id
     OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id
     OR NEW.attempt_token IS DISTINCT FROM OLD.attempt_token
     OR NEW.staff_uid IS DISTINCT FROM OLD.staff_uid
     OR NEW.payslip_revision IS DISTINCT FROM OLD.payslip_revision
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.credential_ciphertext IS DISTINCT FROM OLD.credential_ciphertext
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR (
       OLD.notification_outbox_id IS NOT NULL
       AND NEW.notification_outbox_id IS DISTINCT FROM OLD.notification_outbox_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payslip document identity and credential are immutable';
  END IF;

  IF OLD.status = 'superseded' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a superseded payslip document is immutable';
  END IF;

  IF (OLD.status, NEW.status) NOT IN (
    ('prepared', 'prepared'),
    ('prepared', 'uploaded'),
    ('prepared', 'failed'),
    ('prepared', 'superseded'),
    ('uploaded', 'uploaded'),
    ('uploaded', 'delivery_queued'),
    ('uploaded', 'failed'),
    ('uploaded', 'superseded'),
    ('delivery_queued', 'delivery_queued'),
    ('delivery_queued', 'notification_accepted'),
    ('delivery_queued', 'superseded'),
    ('notification_accepted', 'notification_accepted'),
    ('notification_accepted', 'superseded'),
    ('failed', 'failed'),
    ('failed', 'superseded'),
    ('superseded', 'superseded')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('invalid payslip document transition %s -> %s', OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER payslip_document_identity_guard
BEFORE UPDATE ON public.payslip_documents
FOR EACH ROW EXECUTE FUNCTION public.guard_payslip_document_identity();

CREATE OR REPLACE FUNCTION public.guard_payroll_tenant_kek_replacement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.key_id = format('t:%s:v1', OLD.tenant_id)
     AND OLD.wrapped_key_material IS DISTINCT FROM NEW.wrapped_key_material
     AND OLD.wrapped_key_material IS NOT NULL
     AND NEW.wrapped_key_material IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'tenant v1 KEK material is immutable; use a versioned rotation path';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER payroll_tenant_kek_replacement_guard
BEFORE UPDATE OF wrapped_key_material ON public.encryption_keys
FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_tenant_kek_replacement();

-- The attempt/result backfills above queue DEFERRABLE INITIALLY DEFERRED
-- FK-check trigger events that would otherwise fire only at COMMIT — and
-- Postgres refuses to ALTER a table with pending trigger events (SQLSTATE
-- 55006), which the RLS loop below must do. Fire them now; on a fresh
-- database the backfills copy zero rows and this is a no-op, which is why
-- every empty-DB CI run passed while the first populated database
-- (dalekdefender, 2026-08-21) failed here.
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_run_attempts',
    'payroll_run_staff_results',
    'payslip_documents'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', table_name);
    EXECUTE format($policy$
      CREATE POLICY tenant_isolation ON public.%I
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
    $policy$, table_name);
    EXECUTE format('DROP POLICY IF EXISTS payroll_explicit_tenant_context ON public.%I', table_name);
    EXECUTE format($policy$
      CREATE POLICY payroll_explicit_tenant_context ON public.%I
        AS RESTRICTIVE
        USING (
          current_setting('app.current_tenant_id', true) IS NOT NULL
          AND current_setting('app.current_tenant_id', true) <> ''
          AND current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NOT NULL
          AND current_setting('app.current_tenant_id', true) <> ''
          AND current_setting('app.current_tenant_id', true) <> 'bypass'
          AND tenant_id = app_current_tenant_id_uuid()
        )
    $policy$, table_name);
  END LOOP;
END
$$;

COMMENT ON TABLE public.payroll_run_attempts IS
  'Immutable-attempt ownership ledger for payroll-run recovery and sign/issue fencing.';
COMMENT ON TABLE public.payroll_run_staff_results IS
  'One durable current or superseded outcome per tenant user and payroll attempt.';
COMMENT ON TABLE public.payslip_documents IS
  'Versioned immutable PDF object and encrypted password identity, linked to a durable notification receipt.';
