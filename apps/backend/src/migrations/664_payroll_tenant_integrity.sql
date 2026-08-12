-- 664: Make automated payroll records structurally tenant-consistent.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.payslips AS payslip
      JOIN public.payroll_runs AS payroll_run ON payroll_run.id = payslip.payroll_run_id
     WHERE payslip.tenant_id <> payroll_run.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payslips contain cross-tenant payroll_run references';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payslips AS payslip
      JOIN public.users AS staff_user ON staff_user.uid = payslip.staff_uid
     WHERE payslip.tenant_id <> staff_user.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payslips contain cross-tenant staff references';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.annual_review_reminders AS reminder
      JOIN public.users AS staff_user ON staff_user.uid = reminder.staff_uid
     WHERE reminder.tenant_id <> staff_user.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'annual_review_reminders contain cross-tenant staff references';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_payroll_runs_tenant_id
  ON public.payroll_runs (tenant_id, id);

DROP INDEX IF EXISTS public.payslips_staff_uid_month_year_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_payslips_tenant_staff_period
  ON public.payslips (tenant_id, staff_uid, month, year);

DROP INDEX IF EXISTS public.annual_review_reminders_staff_uid_review_year_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_annual_review_reminders_tenant_staff_year
  ON public.annual_review_reminders (tenant_id, staff_uid, review_year);

ALTER TABLE public.payslips
  DROP CONSTRAINT IF EXISTS payslips_payroll_run_id_fkey,
  DROP CONSTRAINT IF EXISTS payslips_staff_uid_fkey;

ALTER TABLE public.annual_review_reminders
  DROP CONSTRAINT IF EXISTS annual_review_reminders_staff_uid_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payslips'::regclass
       AND conname = 'fk_payslips_payroll_run_tenant'
  ) THEN
    ALTER TABLE public.payslips
      ADD CONSTRAINT fk_payslips_payroll_run_tenant
      FOREIGN KEY (tenant_id, payroll_run_id)
      REFERENCES public.payroll_runs (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payslips'::regclass
       AND conname = 'fk_payslips_staff_tenant'
  ) THEN
    ALTER TABLE public.payslips
      ADD CONSTRAINT fk_payslips_staff_tenant
      FOREIGN KEY (tenant_id, staff_uid)
      REFERENCES public.users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.annual_review_reminders'::regclass
       AND conname = 'fk_annual_review_reminders_staff_tenant'
  ) THEN
    ALTER TABLE public.annual_review_reminders
      ADD CONSTRAINT fk_annual_review_reminders_staff_tenant
      FOREIGN KEY (tenant_id, staff_uid)
      REFERENCES public.users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END
$$;
