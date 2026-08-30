-- Reconcile salary revisions that migration 330 assigned to a fallback tenant
-- before subject/actor ownership had been derived. Existing tenant_id is
-- evidence only: referenced user identities are the sole ownership authority.

BEGIN;

-- The migration must see quarantined rows if it is replayed after the
-- restrictive policy below already exists.
SELECT set_config('app.current_tenant_id', 'bypass', true);

ALTER TABLE salary_revisions
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_required BOOLEAN,
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_reason VARCHAR(48),
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_evidence JSONB,
  ADD COLUMN IF NOT EXISTS tenant_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS salary_baseline JSONB,
  ADD COLUMN IF NOT EXISTS hr_signer_role VARCHAR(32),
  ADD COLUMN IF NOT EXISTS hr_authority_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hr_authority_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS admin_signer_role VARCHAR(32),
  ADD COLUMN IF NOT EXISTS admin_authority_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_authority_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS terms_manifest_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS hr_signature_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS admin_signature_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS rejected_actor_role VARCHAR(32),
  ADD COLUMN IF NOT EXISTS rejected_authority_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_authority_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS rejection_evidence_sha256 CHAR(64);

ALTER TABLE salary_arrears
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_required BOOLEAN,
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_reason VARCHAR(48),
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_evidence JSONB,
  ADD COLUMN IF NOT EXISTS tenant_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS period_breakdown JSONB,
  ADD COLUMN IF NOT EXISTS gross_adjustment NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS pf_adjustment NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS esi_adjustment NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS professional_tax_adjustment NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS tds_adjustment NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS deduction_adjustment NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS net_adjustment NUMERIC(12, 2);

CREATE OR REPLACE FUNCTION salary_arrears_breakdown_valid(
  lines JSONB,
  range_from_month INTEGER,
  range_from_year INTEGER,
  range_to_month INTEGER,
  range_to_year INTEGER,
  gross_total NUMERIC,
  pf_total NUMERIC,
  esi_total NUMERIC,
  pt_total NUMERIC,
  tds_total NUMERIC,
  deduction_total NUMERIC,
  net_total NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  line JSONB;
  gross_sum NUMERIC := 0;
  pf_sum NUMERIC := 0;
  esi_sum NUMERIC := 0;
  pt_sum NUMERIC := 0;
  tds_sum NUMERIC := 0;
  deduction_sum NUMERIC := 0;
  net_sum NUMERIC := 0;
  component_sum NUMERIC;
  line_deduction_sum NUMERIC;
  period_key INTEGER;
  previous_period_key INTEGER := NULL;
  first_period_key INTEGER := NULL;
  last_period_key INTEGER := NULL;
  required_key TEXT;
BEGIN
  IF jsonb_typeof(lines) <> 'array' OR jsonb_array_length(lines) = 0
     OR gross_total IS NULL OR UPPER(gross_total::TEXT) IN ('NAN', 'INFINITY', '-INFINITY')
     OR gross_total <= 0
     OR pf_total IS NULL OR UPPER(pf_total::TEXT) IN ('NAN', 'INFINITY', '-INFINITY')
     OR esi_total IS NULL OR UPPER(esi_total::TEXT) IN ('NAN', 'INFINITY', '-INFINITY')
     OR pt_total IS NULL OR UPPER(pt_total::TEXT) IN ('NAN', 'INFINITY', '-INFINITY')
     OR tds_total IS NULL OR UPPER(tds_total::TEXT) IN ('NAN', 'INFINITY', '-INFINITY')
     OR deduction_total IS NULL OR UPPER(deduction_total::TEXT) IN ('NAN', 'INFINITY', '-INFINITY')
     OR net_total IS NULL OR UPPER(net_total::TEXT) IN ('NAN', 'INFINITY', '-INFINITY')
     OR range_from_month NOT BETWEEN 1 AND 12
     OR range_to_month NOT BETWEEN 1 AND 12
     OR range_from_year < 1900 OR range_to_year < 1900
  THEN
    RETURN FALSE;
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(lines)
  LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object'
       OR NOT (line ?& ARRAY[
         'month', 'year', 'payslip_id', 'payslip_evidence_sha256',
         'attendance_factor', 'basic_adjustment', 'hra_adjustment',
         'da_adjustment', 'special_allowance_adjustment',
         'transport_allowance_adjustment', 'medical_allowance_adjustment',
         'gross_adjustment', 'pf_adjustment', 'esi_adjustment',
         'professional_tax_adjustment', 'tds_adjustment',
         'deduction_adjustment', 'net_adjustment', 'pf_basis_policy',
         'pf_rate_pct', 'esi_applicable', 'esi_policy', 'tds_policy',
         'tds_monthly_baseline'
       ]::TEXT[])
       OR line - ARRAY[
         'month', 'year', 'payslip_id', 'payslip_evidence_sha256',
         'attendance_factor', 'basic_adjustment', 'hra_adjustment',
         'da_adjustment', 'special_allowance_adjustment',
         'transport_allowance_adjustment', 'medical_allowance_adjustment',
         'gross_adjustment', 'pf_adjustment', 'esi_adjustment',
         'professional_tax_adjustment', 'tds_adjustment',
         'deduction_adjustment', 'net_adjustment', 'pf_basis_policy',
         'pf_rate_pct', 'esi_applicable', 'esi_policy', 'tds_policy',
         'tds_monthly_baseline'
       ]::TEXT[] <> '{}'::JSONB
       OR jsonb_typeof(line->'month') IS DISTINCT FROM 'number'
       OR jsonb_typeof(line->'year') IS DISTINCT FROM 'number'
       OR jsonb_typeof(line->'payslip_id') IS DISTINCT FROM 'number'
       OR NULLIF(BTRIM(line->>'payslip_evidence_sha256'), '') IS NULL
       OR (line->>'payslip_evidence_sha256') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(line->'attendance_factor') IS DISTINCT FROM 'number'
       OR jsonb_typeof(line->'pf_rate_pct') IS DISTINCT FROM 'number'
       OR jsonb_typeof(line->'tds_monthly_baseline') IS DISTINCT FROM 'number'
       OR jsonb_typeof(line->'esi_applicable') IS DISTINCT FROM 'boolean'
       OR line->>'pf_basis_policy' IS DISTINCT FROM 'uncapped_basic_earned'
       OR line->>'esi_policy' IS DISTINCT FROM 'signed_salary_baseline'
       OR line->>'tds_policy' IS DISTINCT FROM 'unchanged_signed_monthly_deduction'
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'basic_adjustment', 'hra_adjustment', 'da_adjustment',
             'special_allowance_adjustment', 'transport_allowance_adjustment',
             'medical_allowance_adjustment', 'gross_adjustment', 'pf_adjustment',
             'esi_adjustment', 'professional_tax_adjustment', 'tds_adjustment',
             'deduction_adjustment', 'net_adjustment'
           ]) AS required_key
           WHERE jsonb_typeof(line->required_key) IS DISTINCT FROM 'number'
       )
    THEN
      RETURN FALSE;
    END IF;
    FOREACH required_key IN ARRAY ARRAY[
      'attendance_factor', 'pf_rate_pct', 'tds_monthly_baseline',
      'basic_adjustment', 'hra_adjustment', 'da_adjustment',
      'special_allowance_adjustment', 'transport_allowance_adjustment',
      'medical_allowance_adjustment', 'gross_adjustment', 'pf_adjustment',
      'esi_adjustment', 'professional_tax_adjustment', 'tds_adjustment',
      'deduction_adjustment', 'net_adjustment'
    ]
    LOOP
      IF UPPER(BTRIM(line->>required_key)) IN ('NAN', 'INFINITY', '-INFINITY') THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    IF (line->>'month')::INTEGER NOT BETWEEN 1 AND 12
       OR (line->>'year')::INTEGER < 1900
       OR (line->>'payslip_id')::BIGINT <= 0
       OR (line->>'attendance_factor')::NUMERIC < 0
       OR (line->>'attendance_factor')::NUMERIC > 1
       OR (line->>'pf_rate_pct')::NUMERIC < 0
       OR (line->>'pf_rate_pct')::NUMERIC > 100
       OR (line->>'tds_monthly_baseline')::NUMERIC < 0
    THEN
      RETURN FALSE;
    END IF;
    period_key := (line->>'year')::INTEGER * 12 + (line->>'month')::INTEGER;
    IF previous_period_key IS NOT NULL AND period_key <> previous_period_key + 1 THEN
      RETURN FALSE;
    END IF;
    first_period_key := COALESCE(first_period_key, period_key);
    last_period_key := period_key;
    previous_period_key := period_key;
    component_sum := (line->>'basic_adjustment')::NUMERIC
      + (line->>'hra_adjustment')::NUMERIC
      + (line->>'da_adjustment')::NUMERIC
      + (line->>'special_allowance_adjustment')::NUMERIC
      + (line->>'transport_allowance_adjustment')::NUMERIC
      + (line->>'medical_allowance_adjustment')::NUMERIC;
    line_deduction_sum := (line->>'pf_adjustment')::NUMERIC
      + (line->>'esi_adjustment')::NUMERIC
      + (line->>'professional_tax_adjustment')::NUMERIC
      + (line->>'tds_adjustment')::NUMERIC;
    IF ABS(component_sum - (line->>'gross_adjustment')::NUMERIC) >= 0.005
       OR ABS(line_deduction_sum - (line->>'deduction_adjustment')::NUMERIC) >= 0.005
       OR ABS(
         (line->>'gross_adjustment')::NUMERIC
         - (line->>'deduction_adjustment')::NUMERIC
         - (line->>'net_adjustment')::NUMERIC
       ) >= 0.005
    THEN
      RETURN FALSE;
    END IF;
    gross_sum := gross_sum + (line->>'gross_adjustment')::NUMERIC;
    pf_sum := pf_sum + (line->>'pf_adjustment')::NUMERIC;
    esi_sum := esi_sum + (line->>'esi_adjustment')::NUMERIC;
    pt_sum := pt_sum + (line->>'professional_tax_adjustment')::NUMERIC;
    tds_sum := tds_sum + (line->>'tds_adjustment')::NUMERIC;
    deduction_sum := deduction_sum + (line->>'deduction_adjustment')::NUMERIC;
    net_sum := net_sum + (line->>'net_adjustment')::NUMERIC;
  END LOOP;
  RETURN COALESCE(
    ABS(gross_sum - gross_total) < 0.005
    AND ABS(pf_sum - pf_total) < 0.005
    AND ABS(esi_sum - esi_total) < 0.005
    AND ABS(pt_sum - pt_total) < 0.005
    AND ABS(tds_sum - tds_total) < 0.005
    AND ABS(deduction_sum - deduction_total) < 0.005
    AND ABS(net_sum - net_total) < 0.005
    AND first_period_key = range_from_year * 12 + range_from_month
    AND last_period_key = range_to_year * 12 + range_to_month
    AND ABS((gross_total - deduction_total) - net_total) < 0.005,
    FALSE
  );
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END
$fn$;

ALTER TABLE salary_arrears
  ALTER COLUMN tenant_id DROP NOT NULL,
  ALTER COLUMN tenant_id DROP DEFAULT,
  ALTER COLUMN status TYPE VARCHAR(32);

ALTER TABLE annual_review_reminders
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_required BOOLEAN,
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_reason VARCHAR(48),
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_evidence JSONB,
  ADD COLUMN IF NOT EXISTS tenant_reconciled_at TIMESTAMPTZ;

ALTER TABLE annual_review_reminders
  ALTER COLUMN tenant_id DROP NOT NULL,
  ALTER COLUMN tenant_id DROP DEFAULT,
  ALTER COLUMN status TYPE VARCHAR(32);

UPDATE salary_revisions
SET tenant_reconciliation_required = COALESCE(tenant_reconciliation_required, FALSE),
    tenant_reconciliation_evidence = COALESCE(tenant_reconciliation_evidence, '{}'::jsonb);

UPDATE salary_arrears
SET tenant_reconciliation_required = COALESCE(tenant_reconciliation_required, FALSE),
    tenant_reconciliation_evidence = COALESCE(tenant_reconciliation_evidence, '{}'::jsonb);

UPDATE annual_review_reminders
SET tenant_reconciliation_required = COALESCE(tenant_reconciliation_required, FALSE),
    tenant_reconciliation_evidence = COALESCE(tenant_reconciliation_evidence, '{}'::jsonb);

ALTER TABLE salary_revisions
  ALTER COLUMN tenant_id DROP NOT NULL,
  ALTER COLUMN tenant_id DROP DEFAULT,
  ALTER COLUMN tenant_reconciliation_required SET DEFAULT FALSE,
  ALTER COLUMN tenant_reconciliation_required SET NOT NULL,
  ALTER COLUMN tenant_reconciliation_evidence SET DEFAULT '{}'::jsonb,
  ALTER COLUMN tenant_reconciliation_evidence SET NOT NULL;

ALTER TABLE salary_arrears
  ALTER COLUMN tenant_reconciliation_required SET DEFAULT FALSE,
  ALTER COLUMN tenant_reconciliation_required SET NOT NULL,
  ALTER COLUMN tenant_reconciliation_evidence SET DEFAULT '{}'::jsonb,
  ALTER COLUMN tenant_reconciliation_evidence SET NOT NULL;

ALTER TABLE annual_review_reminders
  ALTER COLUMN tenant_reconciliation_required SET DEFAULT FALSE,
  ALTER COLUMN tenant_reconciliation_required SET NOT NULL,
  ALTER COLUMN tenant_reconciliation_evidence SET DEFAULT '{}'::jsonb,
  ALTER COLUMN tenant_reconciliation_evidence SET NOT NULL;

CREATE OR REPLACE FUNCTION salary_revision_change_payload_valid(
  revision_kind TEXT,
  payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  entry RECORD;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RETURN FALSE;
  END IF;
  IF revision_kind = 'deduction_change' THEN
    IF payload IS DISTINCT FROM jsonb_build_object(
      'tds_monthly', payload->'tds_monthly'
    ) OR NOT (payload ? 'tds_monthly') THEN
      RETURN FALSE;
    END IF;
  ELSIF revision_kind = 'component_change' THEN
    IF payload = '{}'::jsonb
       OR payload - ARRAY[
         'hra_pct', 'da_pct', 'special_allowance',
         'transport_allowance', 'medical_allowance'
       ]::text[] <> '{}'::jsonb THEN
      RETURN FALSE;
    END IF;
  ELSE
    RETURN FALSE;
  END IF;
  FOR entry IN SELECT key, value FROM jsonb_each(payload)
  LOOP
    IF jsonb_typeof(entry.value) <> 'number'
       OR UPPER(BTRIM(entry.value::text)) IN ('NAN', 'INFINITY', '-INFINITY')
       OR (entry.value::text)::numeric < 0 THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN FALSE;
END
$fn$;

CREATE OR REPLACE FUNCTION salary_revision_baseline_valid(payload JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  required_key TEXT;
  entry RECORD;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object'
     OR payload - ARRAY[
       'basic_salary', 'hra_pct', 'da_pct', 'special_allowance',
       'transport_allowance', 'medical_allowance', 'tds_monthly',
       'pf_employee_pct', 'esi_applicable'
     ]::text[] <> '{}'::jsonb THEN
    RETURN FALSE;
  END IF;
  FOREACH required_key IN ARRAY ARRAY[
    'basic_salary', 'hra_pct', 'da_pct', 'special_allowance',
    'transport_allowance', 'medical_allowance', 'tds_monthly',
    'pf_employee_pct', 'esi_applicable'
  ]
  LOOP
    IF NOT (payload ? required_key) THEN RETURN FALSE; END IF;
  END LOOP;
  IF jsonb_typeof(payload->'esi_applicable') IS DISTINCT FROM 'boolean' THEN
    RETURN FALSE;
  END IF;
  FOR entry IN
    SELECT key, value
      FROM jsonb_each(payload - 'esi_applicable')
  LOOP
    IF jsonb_typeof(entry.value) NOT IN ('number', 'string')
       OR UPPER(BTRIM(entry.value #>> '{}')) IN ('NAN', 'INFINITY', '-INFINITY')
       OR (BTRIM(entry.value #>> '{}'))::numeric < 0 THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN (BTRIM(payload->>'basic_salary'))::numeric > 0
    AND (BTRIM(payload->>'pf_employee_pct'))::numeric BETWEEN 0 AND 100;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN FALSE;
END
$fn$;

CREATE OR REPLACE FUNCTION salary_revision_numeric_finite(value NUMERIC)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT value IS NOT NULL
    AND UPPER(BTRIM(value::TEXT)) NOT IN ('NAN', 'INFINITY', '-INFINITY')
$fn$;

CREATE OR REPLACE FUNCTION salary_revision_financial_evidence_valid(
  revision_kind TEXT,
  baseline JSONB,
  current_basic_value NUMERIC,
  proposed_basic_value NUMERIC,
  current_gross_value NUMERIC,
  proposed_gross_value NUMERIC,
  increment_amount_value NUMERIC,
  increment_pct_value NUMERIC,
  bonus_amount_value NUMERIC,
  bonus_reason_value TEXT,
  changes JSONB,
  effective_on DATE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  baseline_basic NUMERIC;
  baseline_hra NUMERIC;
  baseline_da NUMERIC;
  baseline_special NUMERIC;
  baseline_transport NUMERIC;
  baseline_medical NUMERIC;
  expected_current_gross NUMERIC;
  expected_proposed_gross NUMERIC;
  changed_hra NUMERIC;
  changed_da NUMERIC;
  changed_special NUMERIC;
  changed_transport NUMERIC;
  changed_medical NUMERIC;
BEGIN
  IF NOT salary_revision_baseline_valid(baseline)
     OR NOT salary_revision_numeric_finite(current_basic_value)
     OR current_basic_value <= 0
     OR NOT salary_revision_numeric_finite(current_gross_value)
     OR current_gross_value <= 0
     OR effective_on IS NULL
  THEN
    RETURN FALSE;
  END IF;
  baseline_basic := (baseline->>'basic_salary')::NUMERIC;
  baseline_hra := (baseline->>'hra_pct')::NUMERIC;
  baseline_da := (baseline->>'da_pct')::NUMERIC;
  baseline_special := (baseline->>'special_allowance')::NUMERIC;
  baseline_transport := (baseline->>'transport_allowance')::NUMERIC;
  baseline_medical := (baseline->>'medical_allowance')::NUMERIC;
  expected_current_gross := ROUND((
    baseline_basic
    + baseline_basic * baseline_hra / 100
    + baseline_basic * baseline_da / 100
    + baseline_special + baseline_transport + baseline_medical
  )::NUMERIC, 2);
  IF ABS(current_basic_value - baseline_basic) >= 0.005
     OR ABS(current_gross_value - expected_current_gross) >= 0.005
  THEN
    RETURN FALSE;
  END IF;

  IF revision_kind = 'increment' THEN
    IF EXTRACT(DAY FROM effective_on) <> 1
       OR NOT salary_revision_numeric_finite(proposed_basic_value)
       OR proposed_basic_value <= current_basic_value
       OR NOT salary_revision_numeric_finite(proposed_gross_value)
       OR NOT salary_revision_numeric_finite(increment_amount_value)
       OR increment_amount_value <= 0
       OR NOT salary_revision_numeric_finite(increment_pct_value)
       OR increment_pct_value <= 0
       OR ABS((proposed_basic_value - current_basic_value) - increment_amount_value) >= 0.005
       OR ABS(
         ROUND(((proposed_basic_value - current_basic_value) / current_basic_value * 100)::NUMERIC, 2)
         - increment_pct_value
       ) >= 0.005
       OR bonus_amount_value IS NOT NULL
       OR bonus_reason_value IS NOT NULL
       OR (changes IS NOT NULL AND changes <> '{}'::JSONB)
    THEN
      RETURN FALSE;
    END IF;
    expected_proposed_gross := ROUND((
      proposed_basic_value
      + proposed_basic_value * baseline_hra / 100
      + proposed_basic_value * baseline_da / 100
      + baseline_special + baseline_transport + baseline_medical
    )::NUMERIC, 2);
    RETURN COALESCE(
      ABS(proposed_gross_value - expected_proposed_gross) < 0.005
        AND proposed_gross_value > current_gross_value,
      FALSE
    );
  END IF;

  IF revision_kind = 'bonus' THEN
    RETURN COALESCE(proposed_basic_value IS NULL
      AND proposed_gross_value IS NOT NULL
      AND salary_revision_numeric_finite(proposed_gross_value)
      AND ABS(proposed_gross_value - current_gross_value) < 0.005
      AND increment_amount_value IS NULL
      AND increment_pct_value IS NULL
      AND salary_revision_numeric_finite(bonus_amount_value)
      AND bonus_amount_value > 0
      AND NULLIF(BTRIM(bonus_reason_value), '') IS NOT NULL
      AND (changes IS NULL OR changes = '{}'::JSONB), FALSE);
  END IF;

  IF revision_kind = 'deduction_change' THEN
    RETURN COALESCE(proposed_basic_value IS NULL
      AND proposed_gross_value IS NOT NULL
      AND salary_revision_numeric_finite(proposed_gross_value)
      AND ABS(proposed_gross_value - current_gross_value) < 0.005
      AND increment_amount_value IS NULL
      AND increment_pct_value IS NULL
      AND bonus_amount_value IS NULL
      AND bonus_reason_value IS NULL
      AND salary_revision_change_payload_valid('deduction_change', changes), FALSE);
  END IF;

  IF revision_kind = 'component_change' THEN
    IF EXTRACT(DAY FROM effective_on) <> 1
       OR proposed_basic_value IS NOT NULL
       OR NOT salary_revision_numeric_finite(proposed_gross_value)
       OR increment_amount_value IS NOT NULL
       OR increment_pct_value IS NOT NULL
       OR bonus_amount_value IS NOT NULL
       OR bonus_reason_value IS NOT NULL
       OR NOT salary_revision_change_payload_valid('component_change', changes)
    THEN
      RETURN FALSE;
    END IF;
    changed_hra := COALESCE((changes->>'hra_pct')::NUMERIC, baseline_hra);
    changed_da := COALESCE((changes->>'da_pct')::NUMERIC, baseline_da);
    changed_special := COALESCE((changes->>'special_allowance')::NUMERIC, baseline_special);
    changed_transport := COALESCE((changes->>'transport_allowance')::NUMERIC, baseline_transport);
    changed_medical := COALESCE((changes->>'medical_allowance')::NUMERIC, baseline_medical);
    expected_proposed_gross := ROUND((
      baseline_basic
      + baseline_basic * changed_hra / 100
      + baseline_basic * changed_da / 100
      + changed_special + changed_transport + changed_medical
    )::NUMERIC, 2);
    RETURN COALESCE(
      ABS(proposed_gross_value - expected_proposed_gross) < 0.005
        AND ABS(proposed_gross_value - current_gross_value) >= 0.005,
      FALSE
    );
  END IF;
  RETURN FALSE;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN
    RETURN FALSE;
END
$fn$;

DROP TABLE IF EXISTS pg_temp.salary_revision_754_classification;
CREATE TEMP TABLE salary_revision_754_classification ON COMMIT DROP AS
WITH identity_evidence AS (
  SELECT
    revision.id,
    revision.revision_number,
    revision.tenant_id AS observed_tenant_id,
    revision.tenant_reconciliation_required AS existing_reconciliation_required,
    revision.tenant_reconciliation_reason AS existing_reconciliation_reason,
    revision.tenant_reconciliation_evidence AS existing_reconciliation_evidence,
    revision.tenant_reconciled_at AS existing_reconciled_at,
    revision.status,
    revision.revision_type,
    revision.current_basic,
    revision.proposed_basic,
    revision.current_gross,
    revision.proposed_gross,
    revision.increment_amount,
    revision.increment_pct,
    revision.bonus_amount,
    revision.bonus_reason,
    revision.other_changes,
    revision.salary_baseline,
    revision.effective_from,
    revision.staff_uid,
    staff_owner.tenant_id AS staff_tenant_id,
    revision.proposed_by,
    proposed_owner.tenant_id AS proposed_tenant_id,
    revision.proposed_at,
    revision.hr_signed_by,
    hr_owner.tenant_id AS hr_tenant_id,
    revision.hr_signed_at,
    revision.hr_signer_role,
    revision.hr_authority_checked_at,
    revision.hr_authority_source,
    revision.terms_manifest_sha256,
    revision.hr_signature_sha256,
    revision.admin_signed_by,
    admin_owner.tenant_id AS admin_tenant_id,
    revision.admin_signed_at,
    revision.admin_signer_role,
    revision.admin_authority_checked_at,
    revision.admin_authority_source,
    revision.admin_signature_sha256,
    revision.signature_hash,
    revision.rejected_by,
    rejected_owner.tenant_id AS rejected_tenant_id,
    revision.rejected_at,
    revision.rejection_reason,
    revision.rejected_actor_role,
    revision.rejected_authority_checked_at,
    revision.rejected_authority_source,
    revision.rejection_evidence_sha256,
    revision.applied_at,
    ARRAY(
      SELECT DISTINCT candidate_tenant
      FROM unnest(ARRAY[
        staff_owner.tenant_id,
        proposed_owner.tenant_id,
        hr_owner.tenant_id,
        admin_owner.tenant_id,
        rejected_owner.tenant_id
      ]) AS candidate(candidate_tenant)
      WHERE candidate_tenant IS NOT NULL
      ORDER BY candidate_tenant
    ) AS candidate_tenant_ids
  FROM salary_revisions revision
  LEFT JOIN users staff_owner ON staff_owner.uid = revision.staff_uid
  LEFT JOIN users proposed_owner ON proposed_owner.uid = revision.proposed_by
  LEFT JOIN users hr_owner ON hr_owner.uid = revision.hr_signed_by
  LEFT JOIN users admin_owner ON admin_owner.uid = revision.admin_signed_by
  LEFT JOIN users rejected_owner ON rejected_owner.uid = revision.rejected_by
), candidates AS (
  SELECT
    identity_evidence.*,
    cardinality(candidate_tenant_ids) AS candidate_count,
    CASE
      WHEN cardinality(candidate_tenant_ids) = 1 THEN candidate_tenant_ids[1]
      ELSE NULL
    END AS candidate_tenant_id
  FROM identity_evidence
), dependencies AS (
  SELECT
    candidates.*,
    EXISTS (
      SELECT 1
      FROM salary_arrears arrears
      LEFT JOIN users arrears_staff ON arrears_staff.uid = arrears.staff_uid
      LEFT JOIN payslips arrears_payslip ON arrears_payslip.id = arrears.payslip_id
       WHERE arrears.revision_id = candidates.id
        AND (
          arrears.staff_uid IS DISTINCT FROM candidates.staff_uid
          OR arrears_staff.tenant_id IS NULL
          OR arrears_staff.tenant_id IS DISTINCT FROM candidates.candidate_tenant_id
          OR (
            arrears.payslip_id IS NOT NULL
            AND (
              arrears_payslip.tenant_id IS NULL
              OR arrears_payslip.tenant_id IS DISTINCT FROM candidates.candidate_tenant_id
              OR arrears_payslip.staff_uid IS DISTINCT FROM candidates.staff_uid
            )
          )
        )
    ) OR EXISTS (
      SELECT 1
      FROM annual_review_reminders reminder
      LEFT JOIN users reminder_staff ON reminder_staff.uid = reminder.staff_uid
       WHERE reminder.revision_id = candidates.id
        AND (
          reminder.staff_uid IS DISTINCT FROM candidates.staff_uid
          OR reminder_staff.tenant_id IS NULL
          OR reminder_staff.tenant_id IS DISTINCT FROM candidates.candidate_tenant_id
        )
    ) AS dependent_tenant_conflict,
    (
      SELECT COUNT(*)
      FROM salary_arrears arrears
      WHERE arrears.revision_id = candidates.id
    ) > 1 AS dependent_arrears_collision
  FROM candidates
), collisions AS (
  SELECT
    dependencies.*,
    COUNT(*) FILTER (WHERE candidate_tenant_id IS NOT NULL) OVER (
      PARTITION BY candidate_tenant_id, revision_number
    ) AS collision_count
  FROM dependencies
)
SELECT
  collisions.*,
  COALESCE(
    existing_reconciliation_required = FALSE
    AND existing_reconciliation_reason IS NULL
    AND existing_reconciled_at IS NOT NULL
    AND observed_tenant_id IS NOT DISTINCT FROM candidate_tenant_id
    AND existing_reconciliation_evidence->>'migration'
      = '754_salary_revision_tenant_reconciliation'
    AND existing_reconciliation_evidence->>'resolved_tenant_id'
      = candidate_tenant_id::text
    AND existing_reconciliation_evidence->>'action' = 'auto_repaired',
    FALSE
  ) AS stable_resolved_outcome,
  CASE
    WHEN existing_reconciliation_required
      AND existing_reconciliation_reason IN (
        'identity_unowned',
        'subject_identity_missing',
        'subject_identity_unowned',
        'proposer_identity_missing',
        'proposer_identity_unowned',
        'revision_status_invalid',
        'revision_lifecycle_evidence_missing',
        'revision_financial_shape_invalid',
        'identity_tenant_conflict',
        'revision_number_collision',
        'dependent_arrears_collision',
        'dependent_tenant_conflict'
      ) THEN existing_reconciliation_reason
    WHEN staff_uid IS NULL THEN 'subject_identity_missing'
    WHEN staff_tenant_id IS NULL THEN 'subject_identity_unowned'
    WHEN proposed_by IS NULL THEN 'proposer_identity_missing'
    WHEN proposed_tenant_id IS NULL THEN 'proposer_identity_unowned'
    WHEN status IS NULL OR status NOT IN (
      'pending_hr', 'pending_admin', 'approved', 'applied', 'rejected'
    ) THEN 'revision_status_invalid'
    WHEN proposed_at IS NULL THEN 'revision_lifecycle_evidence_missing'
    WHEN status IN ('pending_admin', 'approved', 'applied') AND (
      hr_signed_by IS NULL
      OR hr_tenant_id IS NULL
      OR hr_signed_at IS NULL
      OR hr_signer_role IS NULL
      OR hr_authority_checked_at IS NULL
      OR hr_authority_source IS NULL
      OR terms_manifest_sha256 IS NULL
      OR hr_signature_sha256 IS NULL
    ) THEN 'revision_lifecycle_evidence_missing'
    WHEN status IN ('approved', 'applied') AND (
      admin_signed_by IS NULL
      OR admin_tenant_id IS NULL
      OR admin_signed_at IS NULL
      OR admin_signer_role IS NULL
      OR admin_authority_checked_at IS NULL
      OR admin_authority_source IS NULL
      OR admin_signature_sha256 IS NULL
      OR signature_hash IS NULL
    ) THEN 'revision_lifecycle_evidence_missing'
    WHEN status IN ('approved', 'applied')
      AND hr_signed_by IS NOT DISTINCT FROM admin_signed_by
      THEN 'revision_lifecycle_evidence_missing'
    WHEN status = 'applied' AND applied_at IS NULL
      THEN 'revision_lifecycle_evidence_missing'
    WHEN status = 'rejected' AND (
      rejected_by IS NULL
      OR rejected_tenant_id IS NULL
      OR rejected_at IS NULL
      OR NULLIF(BTRIM(rejection_reason), '') IS NULL
      OR rejected_actor_role IS NULL
      OR rejected_authority_checked_at IS NULL
      OR rejected_authority_source IS NULL
      OR rejection_evidence_sha256 IS NULL
      OR terms_manifest_sha256 IS NULL
    ) THEN 'revision_lifecycle_evidence_missing'
    WHEN (
      CASE status
        WHEN 'pending_hr' THEN
          hr_signed_by IS NULL
          AND hr_signed_at IS NULL
          AND hr_signature_sha256 IS NULL
          AND admin_signed_by IS NULL
          AND admin_signed_at IS NULL
          AND admin_signature_sha256 IS NULL
          AND signature_hash IS NULL
          AND rejected_by IS NULL
          AND applied_at IS NULL
        WHEN 'pending_admin' THEN
          hr_signed_by IS NOT NULL
          AND hr_signed_at IS NOT NULL
          AND hr_signer_role = 'HR_STAFF'
          AND hr_authority_checked_at = hr_signed_at
          AND hr_authority_source = 'users_active_row'
          AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
          AND admin_signed_by IS NULL
          AND admin_signed_at IS NULL
          AND admin_signature_sha256 IS NULL
          AND signature_hash IS NULL
          AND rejected_by IS NULL
          AND applied_at IS NULL
        WHEN 'approved' THEN
          hr_signed_by IS NOT NULL
          AND hr_signed_at IS NOT NULL
          AND hr_signer_role = 'HR_STAFF'
          AND hr_authority_checked_at = hr_signed_at
          AND hr_authority_source = 'users_active_row'
          AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
          AND admin_signed_by IS NOT NULL
          AND admin_signed_at IS NOT NULL
          AND admin_signer_role IN ('ADMIN', 'SUPER_ADMIN')
          AND admin_authority_checked_at = admin_signed_at
          AND admin_authority_source = 'users_active_row'
          AND admin_signature_sha256 ~ '^[0-9a-f]{64}$'
          AND signature_hash = admin_signature_sha256
          AND hr_signed_by IS DISTINCT FROM admin_signed_by
          AND rejected_by IS NULL
          AND applied_at IS NULL
        WHEN 'applied' THEN
          hr_signed_by IS NOT NULL
          AND hr_signed_at IS NOT NULL
          AND hr_signer_role = 'HR_STAFF'
          AND hr_authority_checked_at = hr_signed_at
          AND hr_authority_source = 'users_active_row'
          AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
          AND admin_signed_by IS NOT NULL
          AND admin_signed_at IS NOT NULL
          AND admin_signer_role IN ('ADMIN', 'SUPER_ADMIN')
          AND admin_authority_checked_at = admin_signed_at
          AND admin_authority_source = 'users_active_row'
          AND admin_signature_sha256 ~ '^[0-9a-f]{64}$'
          AND signature_hash = admin_signature_sha256
          AND hr_signed_by IS DISTINCT FROM admin_signed_by
          AND rejected_by IS NULL
          AND applied_at IS NOT NULL
        WHEN 'rejected' THEN
          rejected_by IS NOT NULL
          AND rejected_at IS NOT NULL
          AND NULLIF(BTRIM(rejection_reason), '') IS NOT NULL
          AND rejected_actor_role IN ('HR_STAFF', 'ADMIN', 'SUPER_ADMIN')
          AND rejected_authority_checked_at = rejected_at
          AND rejected_authority_source = 'users_active_row'
          AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND rejection_evidence_sha256 ~ '^[0-9a-f]{64}$'
          AND admin_signed_by IS NULL
          AND applied_at IS NULL
        ELSE FALSE
      END
    ) IS NOT TRUE THEN 'revision_lifecycle_evidence_missing'
    WHEN NOT salary_revision_financial_evidence_valid(
      revision_type, salary_baseline, current_basic, proposed_basic,
      current_gross, proposed_gross, increment_amount, increment_pct,
      bonus_amount, bonus_reason, other_changes, effective_from
    ) THEN 'revision_financial_shape_invalid'
    WHEN candidate_count = 0 THEN 'identity_unowned'
    WHEN candidate_count > 1 THEN 'identity_tenant_conflict'
    WHEN collision_count > 1 THEN 'revision_number_collision'
    WHEN dependent_arrears_collision THEN 'dependent_arrears_collision'
    WHEN dependent_tenant_conflict THEN 'dependent_tenant_conflict'
    ELSE NULL
  END::VARCHAR(48) AS quarantine_reason
FROM collisions;

-- Quarantine every unresolved row before repairing the resolved set so a
-- candidate-tenant revision-number collision never chooses an arbitrary winner.
UPDATE salary_revisions revision
SET tenant_id = NULL,
    tenant_reconciliation_required = TRUE,
    tenant_reconciliation_reason = classification.quarantine_reason,
    tenant_reconciliation_evidence = CASE
      WHEN classification.existing_reconciliation_required
        AND classification.existing_reconciliation_reason IS NOT DISTINCT FROM classification.quarantine_reason
        AND classification.observed_tenant_id IS NULL
        AND revision.tenant_reconciliation_evidence @> jsonb_build_object(
          'migration', '754_salary_revision_tenant_reconciliation',
          'action', 'quarantined'
        )
        AND revision.tenant_reconciled_at IS NULL
        THEN revision.tenant_reconciliation_evidence
      ELSE revision.tenant_reconciliation_evidence
        || jsonb_strip_nulls(jsonb_build_object(
             'migration', '754_salary_revision_tenant_reconciliation',
             'action', 'quarantined',
             'observed_tenant_id', classification.observed_tenant_id,
             'candidate_tenant_ids', to_jsonb(classification.candidate_tenant_ids),
             'identity_tenants', jsonb_build_object(
               'staff_uid', classification.staff_uid,
               'staff_tenant_id', classification.staff_tenant_id,
               'proposed_by', classification.proposed_by,
               'proposed_tenant_id', classification.proposed_tenant_id,
               'hr_signed_by', classification.hr_signed_by,
               'hr_tenant_id', classification.hr_tenant_id,
               'admin_signed_by', classification.admin_signed_by,
               'admin_tenant_id', classification.admin_tenant_id,
               'rejected_by', classification.rejected_by,
               'rejected_tenant_id', classification.rejected_tenant_id
             ),
             'collision_count', classification.collision_count,
             'dependent_arrears_collision', classification.dependent_arrears_collision,
             'dependent_tenant_conflict', classification.dependent_tenant_conflict
           ))
    END,
    tenant_reconciled_at = NULL
FROM salary_revision_754_classification classification
WHERE revision.id = classification.id
  AND classification.quarantine_reason IS NOT NULL;

UPDATE salary_revisions revision
SET tenant_id = classification.candidate_tenant_id,
    tenant_reconciliation_required = FALSE,
    tenant_reconciliation_reason = NULL,
    tenant_reconciliation_evidence = revision.tenant_reconciliation_evidence
      || jsonb_strip_nulls(jsonb_build_object(
           'migration', '754_salary_revision_tenant_reconciliation',
           'action', 'auto_repaired',
           'observed_tenant_id', classification.observed_tenant_id,
           'resolved_tenant_id', classification.candidate_tenant_id,
           'candidate_tenant_ids', to_jsonb(classification.candidate_tenant_ids),
           'identity_tenants', jsonb_build_object(
             'staff_uid', classification.staff_uid,
             'staff_tenant_id', classification.staff_tenant_id,
             'proposed_by', classification.proposed_by,
             'proposed_tenant_id', classification.proposed_tenant_id,
             'hr_signed_by', classification.hr_signed_by,
             'hr_tenant_id', classification.hr_tenant_id,
             'admin_signed_by', classification.admin_signed_by,
             'admin_tenant_id', classification.admin_tenant_id,
             'rejected_by', classification.rejected_by,
             'rejected_tenant_id', classification.rejected_tenant_id
           )
         )),
    tenant_reconciled_at = COALESCE(revision.tenant_reconciled_at, NOW())
FROM salary_revision_754_classification classification
WHERE revision.id = classification.id
  AND classification.quarantine_reason IS NULL
  AND NOT classification.stable_resolved_outcome;

-- Arrears without a parent revision have no authoritative salary-change
-- identity. Preserve their original coordinates as evidence and detach them
-- before composite tenant constraints are validated.
UPDATE salary_arrears arrears
SET tenant_id = NULL,
    status = 'reconciliation_required',
    tenant_reconciliation_required = TRUE,
    tenant_reconciliation_reason = 'revision_identity_missing',
    tenant_reconciliation_evidence = arrears.tenant_reconciliation_evidence
      || jsonb_strip_nulls(jsonb_build_object(
           'migration', '754_salary_revision_tenant_reconciliation',
           'action', 'quarantined',
           'observed_tenant_id', arrears.tenant_id,
           'observed_staff_uid', arrears.staff_uid,
           'observed_status', arrears.status,
           'observed_payslip_id', arrears.payslip_id
         )),
    tenant_reconciled_at = NULL
WHERE arrears.revision_id IS NULL
  AND arrears.tenant_reconciliation_required = FALSE;

DROP TABLE IF EXISTS pg_temp.salary_arrears_754_classification;
CREATE TEMP TABLE salary_arrears_754_classification ON COMMIT DROP AS
SELECT
  arrears.id,
  arrears.tenant_id AS observed_tenant_id,
  arrears.staff_uid,
  arrears.revision_id AS observed_revision_id,
  arrears.status AS observed_status,
  revision.tenant_id AS revision_tenant_id,
  revision.staff_uid AS revision_staff_uid,
  revision.tenant_reconciliation_required AS revision_reconciliation_required,
  staff_owner.tenant_id AS staff_tenant_id,
  arrears.payslip_id AS observed_payslip_id,
  payslip.tenant_id AS payslip_tenant_id,
  payslip.staff_uid AS payslip_staff_uid,
  COALESCE(
    revision.id IS NOT NULL
    AND arrears.tenant_id IS NOT DISTINCT FROM revision.tenant_id
    AND arrears.tenant_reconciliation_required = FALSE
    AND arrears.tenant_reconciliation_reason IS NULL
    AND arrears.tenant_reconciled_at IS NOT NULL
    AND arrears.tenant_reconciliation_evidence->>'migration'
      = '754_salary_revision_tenant_reconciliation'
    AND arrears.tenant_reconciliation_evidence->>'resolved_tenant_id'
      = revision.tenant_id::text
    AND arrears.tenant_reconciliation_evidence->>'resolved_revision_id'
      IS NOT DISTINCT FROM arrears.revision_id::text
    AND arrears.tenant_reconciliation_evidence->>'action' = CASE
      WHEN arrears.tenant_reconciliation_evidence->>'observed_tenant_id'
        IS DISTINCT FROM revision.tenant_id::text
        THEN 'auto_repaired'
      ELSE 'auto_verified'
    END,
    FALSE
  ) AS stable_resolved_outcome,
  CASE
    WHEN revision.id IS NULL THEN 'revision_missing'
    WHEN revision.tenant_reconciliation_required OR revision.tenant_id IS NULL
      THEN 'parent_revision_quarantined'
    WHEN arrears.staff_uid IS DISTINCT FROM revision.staff_uid
      THEN 'revision_staff_conflict'
    WHEN staff_owner.tenant_id IS NULL THEN 'staff_identity_unowned'
    WHEN staff_owner.tenant_id IS DISTINCT FROM revision.tenant_id
      THEN 'staff_tenant_conflict'
    WHEN arrears.payslip_id IS NOT NULL AND payslip.id IS NULL
      THEN 'payslip_missing'
    WHEN arrears.payslip_id IS NOT NULL
      AND payslip.tenant_id IS DISTINCT FROM revision.tenant_id
      THEN 'payslip_tenant_conflict'
    WHEN arrears.payslip_id IS NOT NULL
      AND payslip.staff_uid IS DISTINCT FROM arrears.staff_uid
      THEN 'payslip_staff_conflict'
    WHEN arrears.arrears_amount IS NULL
      OR arrears.arrears_amount <= 0
      OR NOT salary_revision_numeric_finite(arrears.arrears_amount)
      THEN 'arrears_amount_invalid'
    WHEN NOT salary_arrears_breakdown_valid(
      arrears.period_breakdown,
      arrears.from_month,
      arrears.from_year,
      arrears.to_month,
      arrears.to_year,
      arrears.gross_adjustment,
      arrears.pf_adjustment,
      arrears.esi_adjustment,
      arrears.professional_tax_adjustment,
      arrears.tds_adjustment,
      arrears.deduction_adjustment,
      arrears.net_adjustment
    ) OR ABS(arrears.arrears_amount - arrears.gross_adjustment) >= 0.005
      THEN 'arrears_financial_evidence_missing'
    WHEN (
      arrears.status = 'pending'
      AND (
        arrears.payslip_id IS NOT NULL
        OR arrears.paid_in_month IS NOT NULL
        OR arrears.paid_in_year IS NOT NULL
      )
    ) OR (
      arrears.status = 'paid'
      AND (
        arrears.payslip_id IS NULL
        OR arrears.paid_in_month IS NULL
        OR arrears.paid_in_year IS NULL
      )
    ) THEN 'arrears_lifecycle_conflict'
    ELSE NULL
  END::VARCHAR(48) AS quarantine_reason
FROM salary_arrears arrears
LEFT JOIN salary_revisions revision ON revision.id = arrears.revision_id
LEFT JOIN users staff_owner ON staff_owner.uid = arrears.staff_uid
LEFT JOIN payslips payslip ON payslip.id = arrears.payslip_id
WHERE arrears.revision_id IS NOT NULL;

UPDATE salary_arrears arrears
SET tenant_id = NULL,
    revision_id = NULL,
    status = 'reconciliation_required',
    tenant_reconciliation_required = TRUE,
    tenant_reconciliation_reason = classification.quarantine_reason,
    tenant_reconciliation_evidence = arrears.tenant_reconciliation_evidence
      || jsonb_strip_nulls(jsonb_build_object(
           'migration', '754_salary_revision_tenant_reconciliation',
           'action', 'quarantined',
           'observed_tenant_id', classification.observed_tenant_id,
           'observed_staff_uid', classification.staff_uid,
           'observed_revision_id', classification.observed_revision_id,
           'observed_status', classification.observed_status,
           'revision_tenant_id', classification.revision_tenant_id,
           'revision_staff_uid', classification.revision_staff_uid,
           'revision_reconciliation_required', classification.revision_reconciliation_required,
           'staff_tenant_id', classification.staff_tenant_id,
           'observed_payslip_id', classification.observed_payslip_id,
           'payslip_tenant_id', classification.payslip_tenant_id,
           'payslip_staff_uid', classification.payslip_staff_uid
         )),
    tenant_reconciled_at = NULL
FROM salary_arrears_754_classification classification
WHERE arrears.id = classification.id
  AND classification.quarantine_reason IS NOT NULL;

UPDATE salary_arrears arrears
SET tenant_id = classification.revision_tenant_id,
    tenant_reconciliation_required = FALSE,
    tenant_reconciliation_reason = NULL,
    tenant_reconciliation_evidence = arrears.tenant_reconciliation_evidence
      || jsonb_build_object(
           'migration', '754_salary_revision_tenant_reconciliation',
           'action', CASE
             WHEN classification.observed_tenant_id IS DISTINCT FROM classification.revision_tenant_id
               THEN 'auto_repaired'
             ELSE 'auto_verified'
           END,
           'observed_tenant_id', classification.observed_tenant_id,
           'resolved_tenant_id', classification.revision_tenant_id,
           'resolved_revision_id', classification.observed_revision_id
         ),
    tenant_reconciled_at = COALESCE(arrears.tenant_reconciled_at, NOW())
FROM salary_arrears_754_classification classification
WHERE arrears.id = classification.id
  AND classification.quarantine_reason IS NULL
  AND NOT classification.stable_resolved_outcome;

DROP TABLE IF EXISTS pg_temp.annual_review_reminders_754_classification;
CREATE TEMP TABLE annual_review_reminders_754_classification ON COMMIT DROP AS
SELECT
  reminder.id,
  reminder.tenant_id AS observed_tenant_id,
  reminder.staff_uid,
  reminder.revision_id AS observed_revision_id,
  reminder.status AS observed_status,
  revision.tenant_id AS revision_tenant_id,
  revision.staff_uid AS revision_staff_uid,
  revision.tenant_reconciliation_required AS revision_reconciliation_required,
  staff_owner.tenant_id AS staff_tenant_id,
  COALESCE(revision.tenant_id, staff_owner.tenant_id) AS resolved_tenant_id,
  COALESCE(
    reminder.tenant_id
      IS NOT DISTINCT FROM COALESCE(revision.tenant_id, staff_owner.tenant_id)
    AND reminder.tenant_reconciliation_required = FALSE
    AND reminder.tenant_reconciliation_reason IS NULL
    AND reminder.tenant_reconciled_at IS NOT NULL
    AND reminder.tenant_reconciliation_evidence->>'migration'
      = '754_salary_revision_tenant_reconciliation'
    AND reminder.tenant_reconciliation_evidence->>'resolved_tenant_id'
      = COALESCE(revision.tenant_id, staff_owner.tenant_id)::text
    AND reminder.tenant_reconciliation_evidence->>'resolved_revision_id'
      IS NOT DISTINCT FROM reminder.revision_id::text
    AND reminder.tenant_reconciliation_evidence->>'action' = CASE
      WHEN reminder.tenant_reconciliation_evidence->>'observed_tenant_id'
        IS DISTINCT FROM COALESCE(revision.tenant_id, staff_owner.tenant_id)::text
        THEN 'auto_repaired'
      ELSE 'auto_verified'
    END,
    FALSE
  ) AS stable_resolved_outcome,
  COALESCE(
    reminder.tenant_reconciliation_required = TRUE
    AND reminder.tenant_id IS NULL
    AND reminder.revision_id IS NULL
    AND reminder.status = 'reconciliation_required'
    AND reminder.tenant_reconciliation_reason IN (
      'revision_missing',
      'parent_revision_quarantined',
      'revision_tenant_conflict',
      'revision_staff_conflict',
      'staff_identity_unowned',
      'staff_tenant_conflict'
    )
    AND reminder.tenant_reconciled_at IS NULL
    AND reminder.tenant_reconciliation_evidence->>'migration'
      = '754_salary_revision_tenant_reconciliation'
    AND reminder.tenant_reconciliation_evidence->>'action' = 'quarantined',
    FALSE
  ) AS stable_quarantine_outcome,
  CASE
    WHEN reminder.staff_uid IS NULL OR staff_owner.tenant_id IS NULL
      THEN 'staff_identity_unowned'
    WHEN reminder.revision_id IS NOT NULL AND revision.id IS NULL
      THEN 'revision_missing'
    WHEN reminder.revision_id IS NOT NULL
      AND (revision.tenant_reconciliation_required OR revision.tenant_id IS NULL)
      THEN 'parent_revision_quarantined'
    WHEN reminder.revision_id IS NOT NULL
      AND reminder.staff_uid IS DISTINCT FROM revision.staff_uid
      THEN 'revision_staff_conflict'
    WHEN reminder.revision_id IS NOT NULL
      AND staff_owner.tenant_id IS DISTINCT FROM revision.tenant_id
      THEN 'staff_tenant_conflict'
    ELSE NULL
  END::VARCHAR(48) AS quarantine_reason
FROM annual_review_reminders reminder
LEFT JOIN salary_revisions revision ON revision.id = reminder.revision_id
LEFT JOIN users staff_owner ON staff_owner.uid = reminder.staff_uid
;

UPDATE annual_review_reminders reminder
SET tenant_id = NULL,
    revision_id = NULL,
    status = 'reconciliation_required',
    tenant_reconciliation_required = TRUE,
    tenant_reconciliation_reason = classification.quarantine_reason,
    tenant_reconciliation_evidence = reminder.tenant_reconciliation_evidence
      || jsonb_strip_nulls(jsonb_build_object(
           'migration', '754_salary_revision_tenant_reconciliation',
           'action', 'quarantined',
           'observed_tenant_id', classification.observed_tenant_id,
           'observed_staff_uid', classification.staff_uid,
           'observed_revision_id', classification.observed_revision_id,
           'observed_status', classification.observed_status,
           'revision_tenant_id', classification.revision_tenant_id,
           'revision_staff_uid', classification.revision_staff_uid,
           'revision_reconciliation_required', classification.revision_reconciliation_required,
           'staff_tenant_id', classification.staff_tenant_id
         )),
    tenant_reconciled_at = NULL
FROM annual_review_reminders_754_classification classification
WHERE reminder.id = classification.id
  AND classification.quarantine_reason IS NOT NULL
  AND NOT classification.stable_quarantine_outcome;

UPDATE annual_review_reminders reminder
SET tenant_id = classification.resolved_tenant_id,
    tenant_reconciliation_required = FALSE,
    tenant_reconciliation_reason = NULL,
    tenant_reconciliation_evidence = reminder.tenant_reconciliation_evidence
      || jsonb_build_object(
           'migration', '754_salary_revision_tenant_reconciliation',
           'action', CASE
             WHEN classification.observed_tenant_id IS DISTINCT FROM classification.resolved_tenant_id
               THEN 'auto_repaired'
             ELSE 'auto_verified'
           END,
           'observed_tenant_id', classification.observed_tenant_id,
           'resolved_tenant_id', classification.resolved_tenant_id,
           'resolved_revision_id', classification.observed_revision_id
         ),
    tenant_reconciled_at = COALESCE(reminder.tenant_reconciled_at, NOW())
FROM annual_review_reminders_754_classification classification
WHERE reminder.id = classification.id
  AND classification.quarantine_reason IS NULL
  AND NOT classification.stable_quarantine_outcome
  AND NOT classification.stable_resolved_outcome;

ALTER TABLE annual_review_reminders
  DROP CONSTRAINT IF EXISTS fk_annual_review_reminders_staff_tenant;
ALTER TABLE annual_review_reminders
  ADD CONSTRAINT fk_annual_review_reminders_staff_tenant
    FOREIGN KEY (tenant_id, staff_uid)
    REFERENCES users (tenant_id, uid)
    NOT VALID;
ALTER TABLE annual_review_reminders
  VALIDATE CONSTRAINT fk_annual_review_reminders_staff_tenant;

ALTER TABLE salary_revisions
  DROP CONSTRAINT IF EXISTS chk_salary_revisions_tenant_reconciliation;
ALTER TABLE salary_revisions
  ADD CONSTRAINT chk_salary_revisions_tenant_reconciliation CHECK (
    (
      tenant_reconciliation_required = FALSE
      AND tenant_id IS NOT NULL
      AND tenant_reconciliation_reason IS NULL
      AND staff_uid IS NOT NULL
      AND proposed_by IS NOT NULL
    )
    OR
    (
      tenant_reconciliation_required = TRUE
      AND tenant_id IS NULL
      AND tenant_reconciliation_reason IN (
        'identity_unowned',
        'subject_identity_missing',
        'subject_identity_unowned',
        'proposer_identity_missing',
        'proposer_identity_unowned',
        'revision_status_invalid',
        'revision_lifecycle_evidence_missing',
        'revision_financial_shape_invalid',
        'identity_tenant_conflict',
        'revision_number_collision',
        'dependent_arrears_collision',
        'dependent_tenant_conflict'
      )
    )
  ) NOT VALID;
ALTER TABLE salary_revisions
  VALIDATE CONSTRAINT chk_salary_revisions_tenant_reconciliation;

ALTER TABLE salary_revisions
  DROP CONSTRAINT IF EXISTS chk_salary_revision_lifecycle_evidence;
ALTER TABLE salary_revisions
  ADD CONSTRAINT chk_salary_revision_lifecycle_evidence CHECK (
    tenant_reconciliation_required = TRUE
    OR (
      proposed_by IS NOT NULL
      AND proposed_at IS NOT NULL
      AND (
        (
          status = 'pending_hr'
          AND hr_signed_by IS NULL
          AND admin_signed_by IS NULL
          AND rejected_by IS NULL
        )
        OR (
          status = 'pending_admin'
          AND hr_signed_by IS NOT NULL
          AND hr_signed_at IS NOT NULL
          AND hr_signer_role = 'HR_STAFF'
          AND hr_authority_checked_at = hr_signed_at
          AND hr_authority_source = 'users_active_row'
          AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
          AND admin_signed_by IS NULL
          AND rejected_by IS NULL
        )
        OR (
          status IN ('approved', 'applied')
          AND hr_signed_by IS NOT NULL
          AND hr_signed_at IS NOT NULL
          AND hr_signer_role = 'HR_STAFF'
          AND hr_authority_checked_at = hr_signed_at
          AND hr_authority_source = 'users_active_row'
          AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
          AND admin_signed_by IS NOT NULL
          AND admin_signed_at IS NOT NULL
          AND admin_signer_role IN ('ADMIN', 'SUPER_ADMIN')
          AND admin_authority_checked_at = admin_signed_at
          AND admin_authority_source = 'users_active_row'
          AND admin_signature_sha256 ~ '^[0-9a-f]{64}$'
          AND signature_hash = admin_signature_sha256
          AND hr_signed_by IS DISTINCT FROM admin_signed_by
          AND rejected_by IS NULL
          AND (
            (status = 'approved' AND applied_at IS NULL)
            OR (status = 'applied' AND applied_at IS NOT NULL)
          )
        )
        OR (
          status = 'rejected'
          AND rejected_by IS NOT NULL
          AND rejected_at IS NOT NULL
          AND NULLIF(BTRIM(rejection_reason), '') IS NOT NULL
          AND rejected_actor_role IN ('HR_STAFF', 'ADMIN', 'SUPER_ADMIN')
          AND rejected_authority_checked_at = rejected_at
          AND rejected_authority_source = 'users_active_row'
          AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND rejection_evidence_sha256 ~ '^[0-9a-f]{64}$'
          AND admin_signed_by IS NULL
          AND applied_at IS NULL
        )
      )
    )
  ) NOT VALID;
ALTER TABLE salary_revisions
  VALIDATE CONSTRAINT chk_salary_revision_lifecycle_evidence;

ALTER TABLE salary_revisions
  DROP CONSTRAINT IF EXISTS chk_salary_revision_financial_shape;
ALTER TABLE salary_revisions
  ADD CONSTRAINT chk_salary_revision_financial_shape CHECK (
    tenant_reconciliation_required = TRUE
    OR salary_revision_financial_evidence_valid(
      revision_type, salary_baseline, current_basic, proposed_basic,
      current_gross, proposed_gross, increment_amount, increment_pct,
      bonus_amount, bonus_reason, other_changes, effective_from
    )
  ) NOT VALID;
ALTER TABLE salary_revisions
  VALIDATE CONSTRAINT chk_salary_revision_financial_shape;

ALTER TABLE salary_arrears
  DROP CONSTRAINT IF EXISTS chk_salary_arrears_tenant_reconciliation;
ALTER TABLE salary_arrears
  ADD CONSTRAINT chk_salary_arrears_tenant_reconciliation CHECK (
    (
      tenant_reconciliation_required = FALSE
      AND tenant_id IS NOT NULL
      AND tenant_reconciliation_reason IS NULL
    )
    OR
    (
      tenant_reconciliation_required = TRUE
      AND tenant_id IS NULL
      AND revision_id IS NULL
      AND status = 'reconciliation_required'
      AND tenant_reconciliation_reason IN (
        'revision_missing',
        'revision_identity_missing',
        'parent_revision_quarantined',
        'revision_tenant_conflict',
        'revision_staff_conflict',
        'staff_identity_unowned',
        'staff_tenant_conflict',
        'payslip_missing',
        'payslip_tenant_conflict',
        'payslip_staff_conflict',
        'arrears_amount_invalid',
        'arrears_financial_evidence_missing',
        'arrears_lifecycle_conflict',
        'arrears_command_mismatch'
      )
    )
  ) NOT VALID;
ALTER TABLE salary_arrears
  VALIDATE CONSTRAINT chk_salary_arrears_tenant_reconciliation;

ALTER TABLE salary_arrears
  DROP CONSTRAINT IF EXISTS chk_salary_arrears_financial_evidence;
ALTER TABLE salary_arrears
  ADD CONSTRAINT chk_salary_arrears_financial_evidence CHECK (
    tenant_reconciliation_required = TRUE
    OR (
      salary_arrears_breakdown_valid(
        period_breakdown, from_month, from_year, to_month, to_year,
        gross_adjustment, pf_adjustment, esi_adjustment,
        professional_tax_adjustment, tds_adjustment, deduction_adjustment,
        net_adjustment
      )
      AND ABS(arrears_amount - gross_adjustment) < 0.005
    )
  ) NOT VALID;
ALTER TABLE salary_arrears
  VALIDATE CONSTRAINT chk_salary_arrears_financial_evidence;

CREATE OR REPLACE FUNCTION salary_arrears_financial_evidence_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF OLD.period_breakdown IS NOT NULL AND (
    NEW.period_breakdown IS DISTINCT FROM OLD.period_breakdown
    OR NEW.arrears_amount IS DISTINCT FROM OLD.arrears_amount
    OR NEW.gross_adjustment IS DISTINCT FROM OLD.gross_adjustment
    OR NEW.pf_adjustment IS DISTINCT FROM OLD.pf_adjustment
    OR NEW.esi_adjustment IS DISTINCT FROM OLD.esi_adjustment
    OR NEW.professional_tax_adjustment IS DISTINCT FROM OLD.professional_tax_adjustment
    OR NEW.tds_adjustment IS DISTINCT FROM OLD.tds_adjustment
    OR NEW.deduction_adjustment IS DISTINCT FROM OLD.deduction_adjustment
    OR NEW.net_adjustment IS DISTINCT FROM OLD.net_adjustment
    OR NEW.from_month IS DISTINCT FROM OLD.from_month
    OR NEW.from_year IS DISTINCT FROM OLD.from_year
    OR NEW.to_month IS DISTINCT FROM OLD.to_month
    OR NEW.to_year IS DISTINCT FROM OLD.to_year
    OR NEW.calculated_at IS DISTINCT FROM OLD.calculated_at
  ) THEN
    RAISE EXCEPTION 'salary arrears financial evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS salary_arrears_financial_evidence_immutable
  ON salary_arrears;
CREATE TRIGGER salary_arrears_financial_evidence_immutable
  BEFORE UPDATE ON salary_arrears
  FOR EACH ROW EXECUTE FUNCTION salary_arrears_financial_evidence_immutable();

ALTER TABLE annual_review_reminders
  DROP CONSTRAINT IF EXISTS chk_annual_review_reminders_tenant_reconciliation;
ALTER TABLE annual_review_reminders
  ADD CONSTRAINT chk_annual_review_reminders_tenant_reconciliation CHECK (
    (
      tenant_reconciliation_required = FALSE
      AND tenant_id IS NOT NULL
      AND tenant_reconciliation_reason IS NULL
    )
    OR
    (
      tenant_reconciliation_required = TRUE
      AND tenant_id IS NULL
      AND revision_id IS NULL
      AND status = 'reconciliation_required'
      AND tenant_reconciliation_reason IN (
        'revision_missing',
        'parent_revision_quarantined',
        'revision_tenant_conflict',
        'revision_staff_conflict',
        'staff_identity_unowned',
        'staff_tenant_conflict'
      )
    )
  ) NOT VALID;
ALTER TABLE annual_review_reminders
  VALIDATE CONSTRAINT chk_annual_review_reminders_tenant_reconciliation;

-- Keep the legacy UID-only references as evidence-integrity constraints for
-- quarantined rows. The composite MATCH SIMPLE references below add tenant
-- coherence for resolved rows but deliberately do not fire while tenant_id is
-- NULL; retaining both layers prevents quarantined identity evidence from being
-- rewritten to a nonexistent user.
ALTER TABLE salary_revisions
  DROP CONSTRAINT IF EXISTS fk_salary_revisions_staff_tenant,
  DROP CONSTRAINT IF EXISTS fk_salary_revisions_proposer_tenant,
  DROP CONSTRAINT IF EXISTS fk_salary_revisions_hr_signer_tenant,
  DROP CONSTRAINT IF EXISTS fk_salary_revisions_admin_signer_tenant,
  DROP CONSTRAINT IF EXISTS fk_salary_revisions_rejecter_tenant;

ALTER TABLE salary_revisions
  ADD CONSTRAINT fk_salary_revisions_staff_tenant
    FOREIGN KEY (tenant_id, staff_uid) REFERENCES users (tenant_id, uid),
  ADD CONSTRAINT fk_salary_revisions_proposer_tenant
    FOREIGN KEY (tenant_id, proposed_by) REFERENCES users (tenant_id, uid),
  ADD CONSTRAINT fk_salary_revisions_hr_signer_tenant
    FOREIGN KEY (tenant_id, hr_signed_by) REFERENCES users (tenant_id, uid),
  ADD CONSTRAINT fk_salary_revisions_admin_signer_tenant
    FOREIGN KEY (tenant_id, admin_signed_by) REFERENCES users (tenant_id, uid),
  ADD CONSTRAINT fk_salary_revisions_rejecter_tenant
    FOREIGN KEY (tenant_id, rejected_by) REFERENCES users (tenant_id, uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_salary_revisions_tenant_id_id
  ON salary_revisions (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_salary_revisions_tenant_id_staff
  ON salary_revisions (tenant_id, id, staff_uid);

CREATE TABLE IF NOT EXISTS salary_revision_activation_jobs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  revision_id INTEGER NOT NULL,
  effective_on DATE NOT NULL,
  expected_admin_signature_sha256 CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  applied_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  CONSTRAINT ux_salary_revision_activation_jobs_revision
    UNIQUE (tenant_id, revision_id),
  CONSTRAINT chk_salary_revision_activation_jobs_status CHECK (
    status IN ('queued', 'processing', 'applied', 'reconciliation_required')
  ),
  CONSTRAINT chk_salary_revision_activation_jobs_signature CHECK (
    expected_admin_signature_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_salary_revision_activation_jobs_claim CHECK (
    (
      status = 'processing'
      AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      status <> 'processing'
      AND claim_token IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT fk_salary_revision_activation_jobs_revision
    FOREIGN KEY (tenant_id, revision_id)
    REFERENCES salary_revisions (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_salary_revision_activation_jobs_due
  ON salary_revision_activation_jobs (tenant_id, status, next_attempt_at, id)
  WHERE status IN ('queued', 'processing');

ALTER TABLE salary_revision_activation_jobs
  DROP CONSTRAINT IF EXISTS chk_salary_revision_activation_jobs_terminal;
ALTER TABLE salary_revision_activation_jobs
  ADD CONSTRAINT chk_salary_revision_activation_jobs_terminal CHECK (
    status IN ('queued', 'processing')
    OR (
      status = 'applied'
      AND applied_at IS NOT NULL
      AND finalized_at IS NOT NULL
      AND outcome->>'code' = 'applied'
      AND (outcome->>'revision_id')::INTEGER = revision_id
    )
    OR (
      status = 'reconciliation_required'
      AND applied_at IS NULL
      AND finalized_at IS NOT NULL
      AND outcome->>'code' IN (
        'salary_revision_activation_failed',
        'salary_revision_activation_lease_exhausted'
      )
      AND (outcome->>'attempt_count')::INTEGER = attempt_count
      AND (
        outcome->>'code' = 'salary_revision_activation_lease_exhausted'
        OR NULLIF(BTRIM(outcome->>'message'), '') IS NOT NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION salary_revision_activation_terminal_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.effective_on IS DISTINCT FROM OLD.effective_on
     OR NEW.expected_admin_signature_sha256 IS DISTINCT FROM OLD.expected_admin_signature_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'salary revision activation identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('applied', 'reconciliation_required')
     AND NOT (
       OLD.status = 'reconciliation_required'
       AND NEW.status = 'queued'
       AND payroll_reconciliation_retry_authorized(
         'salary_revision_activation', OLD.id::TEXT
       )
     )
     AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
    OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
    OR NEW.last_error IS DISTINCT FROM OLD.last_error
    OR NEW.outcome IS DISTINCT FROM OLD.outcome
    OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'terminal salary revision activation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS salary_revision_activation_terminal_immutable
  ON salary_revision_activation_jobs;
CREATE TRIGGER salary_revision_activation_terminal_immutable
  BEFORE UPDATE ON salary_revision_activation_jobs
  FOR EACH ROW EXECUTE FUNCTION salary_revision_activation_terminal_immutable();

ALTER TABLE salary_revision_activation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_revision_activation_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation
  ON salary_revision_activation_jobs;
CREATE POLICY tenant_isolation
  ON salary_revision_activation_jobs
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE salary_arrears
  DROP CONSTRAINT IF EXISTS fk_salary_arrears_staff_tenant,
  DROP CONSTRAINT IF EXISTS fk_salary_arrears_revision_tenant,
  DROP CONSTRAINT IF EXISTS fk_salary_arrears_payslip_tenant;
ALTER TABLE salary_arrears
  ADD CONSTRAINT fk_salary_arrears_staff_tenant
    FOREIGN KEY (tenant_id, staff_uid)
    REFERENCES users (tenant_id, uid)
    NOT VALID,
  ADD CONSTRAINT fk_salary_arrears_revision_tenant
    FOREIGN KEY (tenant_id, revision_id)
    REFERENCES salary_revisions (tenant_id, id)
    NOT VALID,
  ADD CONSTRAINT fk_salary_arrears_payslip_tenant
    FOREIGN KEY (tenant_id, payslip_id)
    REFERENCES payslips (tenant_id, id)
    NOT VALID;
ALTER TABLE salary_arrears
  VALIDATE CONSTRAINT fk_salary_arrears_staff_tenant;
ALTER TABLE salary_arrears
  VALIDATE CONSTRAINT fk_salary_arrears_revision_tenant;
ALTER TABLE salary_arrears
  VALIDATE CONSTRAINT fk_salary_arrears_payslip_tenant;

ALTER TABLE annual_review_reminders
  DROP CONSTRAINT IF EXISTS fk_annual_review_reminders_revision_tenant;
ALTER TABLE annual_review_reminders
  ADD CONSTRAINT fk_annual_review_reminders_revision_tenant
    FOREIGN KEY (tenant_id, revision_id)
    REFERENCES salary_revisions (tenant_id, id)
    NOT VALID;
ALTER TABLE annual_review_reminders
  VALIDATE CONSTRAINT fk_annual_review_reminders_revision_tenant;

CREATE UNIQUE INDEX IF NOT EXISTS ux_salary_arrears_tenant_revision
  ON salary_arrears (tenant_id, revision_id)
  WHERE revision_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_salary_arrears_tenant_id_id
  ON salary_arrears (tenant_id, id);

CREATE TABLE IF NOT EXISTS salary_revision_arrears_work_items (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  revision_id INTEGER NOT NULL,
  staff_uid UUID NOT NULL,
  effective_on DATE NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  arrears_id INTEGER,
  outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  last_error_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT ux_salary_revision_arrears_work_items_revision
    UNIQUE (tenant_id, revision_id),
  CONSTRAINT chk_salary_revision_arrears_work_items_status CHECK (
    status IN ('pending', 'processing', 'completed', 'reconciliation_required')
  ),
  CONSTRAINT chk_salary_revision_arrears_work_items_terminal CHECK (
    (
      status = 'pending'
      AND arrears_id IS NULL
      AND completed_at IS NULL
      AND outcome = '{}'::jsonb
      AND claim_token IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND attempt_count >= 0
    )
    OR (
      status = 'processing'
      AND arrears_id IS NULL
      AND completed_at IS NULL
      AND outcome = '{}'::jsonb
      AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
      AND lease_expires_at > claimed_at
      AND attempt_count > 0
    )
    OR (
      status = 'completed'
      AND completed_at IS NOT NULL
      AND claim_token IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND (
        (
          outcome->>'code' = 'arrears_calculated'
          AND arrears_id IS NOT NULL
          AND (outcome->>'arrears_id')::INTEGER = arrears_id
        )
        OR (
          outcome->>'code' = 'no_arrears_required'
          AND arrears_id IS NULL
        )
      )
    )
    OR (
      status = 'reconciliation_required'
      AND completed_at IS NOT NULL
      AND outcome->>'code' = 'arrears_reconciliation_required'
      AND claim_token IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND last_error_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT fk_salary_revision_arrears_work_items_revision
    FOREIGN KEY (tenant_id, revision_id, staff_uid)
    REFERENCES salary_revisions (tenant_id, id, staff_uid),
  CONSTRAINT fk_salary_revision_arrears_work_items_arrears
    FOREIGN KEY (tenant_id, arrears_id)
    REFERENCES salary_arrears (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_salary_revision_arrears_work_items_pending
  ON salary_revision_arrears_work_items (tenant_id, status, next_attempt_at, effective_on, id)
  WHERE status IN ('pending', 'processing', 'reconciliation_required');
CREATE UNIQUE INDEX IF NOT EXISTS ux_salary_revision_arrears_work_items_tenant_id_id
  ON salary_revision_arrears_work_items (tenant_id, id);

CREATE OR REPLACE FUNCTION salary_revision_arrears_work_item_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.staff_uid IS DISTINCT FROM OLD.staff_uid
     OR NEW.effective_on IS DISTINCT FROM OLD.effective_on
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
  THEN
    RAISE EXCEPTION 'salary revision arrears work identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('completed', 'reconciliation_required')
     AND NOT (
       OLD.status = 'reconciliation_required'
       AND NEW.status = 'pending'
       AND payroll_reconciliation_retry_authorized(
         'salary_revision_arrears_work', OLD.id::TEXT
       )
     )
     AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.arrears_id IS DISTINCT FROM OLD.arrears_id
    OR NEW.outcome IS DISTINCT FROM OLD.outcome
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
    OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
    OR NEW.last_error_hash IS DISTINCT FROM OLD.last_error_hash
  ) THEN
    RAISE EXCEPTION 'terminal salary revision arrears work evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS salary_revision_arrears_work_item_immutable
  ON salary_revision_arrears_work_items;
CREATE TRIGGER salary_revision_arrears_work_item_immutable
  BEFORE UPDATE ON salary_revision_arrears_work_items
  FOR EACH ROW EXECUTE FUNCTION salary_revision_arrears_work_item_immutable();

ALTER TABLE salary_revision_arrears_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_revision_arrears_work_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation
  ON salary_revision_arrears_work_items;
CREATE POLICY tenant_isolation
  ON salary_revision_arrears_work_items
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

CREATE TABLE IF NOT EXISTS salary_arrears_command_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  revision_id INTEGER NOT NULL,
  arrears_id INTEGER,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(32) NOT NULL,
  authority_checked_at TIMESTAMPTZ NOT NULL,
  authority_source VARCHAR(32) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  request_body_sha256 CHAR(64) NOT NULL,
  response_data JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_salary_arrears_command_receipt_identity CHECK (
    command_key = BTRIM(command_key)
    AND command_key ~ '^[A-Za-z0-9_:.-]+$'
    AND request_body_sha256 ~ '^[0-9a-f]{64}$'
    AND actor_role IN ('ADMIN', 'SUPER_ADMIN')
    AND authority_source IN ('users_active_row', 'salary_revision_admin_signature')
    AND jsonb_typeof(response_data) = 'object'
  ),
  CONSTRAINT ux_salary_arrears_command_receipt_command
    UNIQUE (tenant_id, actor_uid, command_key),
  CONSTRAINT ux_salary_arrears_command_receipt_revision
    UNIQUE (tenant_id, revision_id),
  CONSTRAINT fk_salary_arrears_command_receipt_revision
    FOREIGN KEY (tenant_id, revision_id)
    REFERENCES salary_revisions (tenant_id, id),
  CONSTRAINT fk_salary_arrears_command_receipt_arrears
    FOREIGN KEY (tenant_id, arrears_id)
    REFERENCES salary_arrears (tenant_id, id),
  CONSTRAINT fk_salary_arrears_command_receipt_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_salary_arrears_command_receipts_completed
  ON salary_arrears_command_receipts (tenant_id, completed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION salary_arrears_command_receipt_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'salary arrears command receipts are append-only'
    USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS salary_arrears_command_receipts_append_only
  ON salary_arrears_command_receipts;
CREATE TRIGGER salary_arrears_command_receipts_append_only
  BEFORE UPDATE OR DELETE ON salary_arrears_command_receipts
  FOR EACH ROW EXECUTE FUNCTION salary_arrears_command_receipt_append_only();

ALTER TABLE salary_arrears_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_arrears_command_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation
  ON salary_arrears_command_receipts;
CREATE POLICY tenant_isolation
  ON salary_arrears_command_receipts
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

CREATE TABLE IF NOT EXISTS payroll_reconciliation_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(48) NOT NULL,
  entity_id VARCHAR(80) NOT NULL,
  observed_tenant_id UUID,
  resolution_generation INTEGER NOT NULL,
  action VARCHAR(24) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending_admin',
  original_evidence JSONB NOT NULL,
  original_evidence_sha256 CHAR(64) NOT NULL,
  hr_evidence JSONB NOT NULL,
  hr_request_sha256 CHAR(64) NOT NULL,
  hr_attested_by UUID NOT NULL,
  hr_attested_at TIMESTAMPTZ NOT NULL,
  hr_actor_role VARCHAR(32) NOT NULL,
  hr_authority_checked_at TIMESTAMPTZ NOT NULL,
  hr_authority_source VARCHAR(32) NOT NULL,
  hr_attestation_sha256 CHAR(64) NOT NULL,
  admin_evidence JSONB,
  admin_request_sha256 CHAR(64),
  admin_resolved_by UUID,
  admin_resolved_at TIMESTAMPTZ,
  admin_actor_role VARCHAR(32),
  admin_authority_checked_at TIMESTAMPTZ,
  admin_authority_source VARCHAR(32),
  admin_resolution_sha256 CHAR(64),
  retry_consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ux_payroll_reconciliation_resolution_generation
    UNIQUE (entity_type, entity_id, resolution_generation),
  CONSTRAINT chk_payroll_reconciliation_resolution_entity CHECK (
    entity_type IN (
      'salary_revision', 'salary_arrears', 'annual_review_reminder',
      'bulk_revision_job', 'bulk_revision_item',
      'salary_revision_activation', 'salary_revision_arrears_work'
    )
  ),
  CONSTRAINT chk_payroll_reconciliation_resolution_action CHECK (
    action IN ('exclude', 'retry')
  ),
  CONSTRAINT chk_payroll_reconciliation_resolution_evidence CHECK (
    jsonb_typeof(original_evidence) = 'object'
    AND original_evidence <> '{}'::jsonb
    AND original_evidence_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(hr_evidence) = 'object'
    AND hr_evidence <> '{}'::jsonb
    AND hr_request_sha256 ~ '^[0-9a-f]{64}$'
    AND hr_attestation_sha256 ~ '^[0-9a-f]{64}$'
    AND hr_actor_role = 'SUPER_ADMIN'
    AND hr_authority_source = 'users_active_row'
    AND (
      (
        status = 'pending_admin'
        AND admin_resolved_by IS NULL
        AND admin_resolved_at IS NULL
        AND admin_evidence IS NULL
        AND admin_request_sha256 IS NULL
        AND admin_actor_role IS NULL
        AND admin_authority_checked_at IS NULL
        AND admin_authority_source IS NULL
        AND admin_resolution_sha256 IS NULL
        AND retry_consumed_at IS NULL
      )
      OR (
        status = 'resolved'
        AND admin_resolved_by IS NOT NULL
        AND admin_resolved_at IS NOT NULL
        AND admin_resolved_by IS DISTINCT FROM hr_attested_by
        AND admin_actor_role = 'SUPER_ADMIN'
        AND admin_authority_checked_at = admin_resolved_at
        AND admin_authority_source = 'users_active_row'
        AND jsonb_typeof(admin_evidence) = 'object'
        AND admin_evidence <> '{}'::jsonb
        AND admin_request_sha256 ~ '^[0-9a-f]{64}$'
        AND admin_resolution_sha256 ~ '^[0-9a-f]{64}$'
        AND (action = 'retry' OR retry_consumed_at IS NULL)
      )
    )
  ),
  CONSTRAINT fk_payroll_reconciliation_resolution_hr_actor
    FOREIGN KEY (hr_attested_by) REFERENCES users (uid),
  CONSTRAINT fk_payroll_reconciliation_resolution_admin_actor
    FOREIGN KEY (admin_resolved_by) REFERENCES users (uid)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payroll_reconciliation_resolution_pending
  ON payroll_reconciliation_resolutions (entity_type, entity_id)
  WHERE status = 'pending_admin';
CREATE INDEX IF NOT EXISTS idx_payroll_reconciliation_resolutions_status
  ON payroll_reconciliation_resolutions (status, created_at, id);

CREATE OR REPLACE FUNCTION payroll_reconciliation_resolution_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll reconciliation evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.observed_tenant_id IS DISTINCT FROM OLD.observed_tenant_id
     OR NEW.resolution_generation IS DISTINCT FROM OLD.resolution_generation
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.original_evidence IS DISTINCT FROM OLD.original_evidence
     OR NEW.original_evidence_sha256 IS DISTINCT FROM OLD.original_evidence_sha256
     OR NEW.hr_evidence IS DISTINCT FROM OLD.hr_evidence
     OR NEW.hr_request_sha256 IS DISTINCT FROM OLD.hr_request_sha256
     OR NEW.hr_attested_by IS DISTINCT FROM OLD.hr_attested_by
     OR NEW.hr_attested_at IS DISTINCT FROM OLD.hr_attested_at
     OR NEW.hr_actor_role IS DISTINCT FROM OLD.hr_actor_role
     OR NEW.hr_authority_checked_at IS DISTINCT FROM OLD.hr_authority_checked_at
     OR NEW.hr_authority_source IS DISTINCT FROM OLD.hr_authority_source
     OR NEW.hr_attestation_sha256 IS DISTINCT FROM OLD.hr_attestation_sha256
  THEN
    RAISE EXCEPTION 'payroll reconciliation attestation is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'resolved' AND NEW IS DISTINCT FROM OLD
     AND NOT (
       OLD.action = 'retry'
       AND OLD.retry_consumed_at IS NULL
       AND NEW.retry_consumed_at IS NOT NULL
       AND (to_jsonb(NEW) - 'retry_consumed_at')
         = (to_jsonb(OLD) - 'retry_consumed_at')
     )
  THEN
    RAISE EXCEPTION 'resolved payroll reconciliation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS payroll_reconciliation_resolution_immutable
  ON payroll_reconciliation_resolutions;
CREATE TRIGGER payroll_reconciliation_resolution_immutable
  BEFORE UPDATE OR DELETE ON payroll_reconciliation_resolutions
  FOR EACH ROW EXECUTE FUNCTION payroll_reconciliation_resolution_immutable();

ALTER TABLE payroll_reconciliation_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_reconciliation_resolutions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_reconciliation_resolutions_bypass_only
  ON payroll_reconciliation_resolutions;
CREATE POLICY payroll_reconciliation_resolutions_bypass_only
  ON payroll_reconciliation_resolutions
  AS RESTRICTIVE
  FOR ALL
  USING (current_setting('app.current_tenant_id', true) = 'bypass')
  WITH CHECK (current_setting('app.current_tenant_id', true) = 'bypass');

CREATE OR REPLACE FUNCTION payroll_reconciliation_retry_authorized(
  requested_entity_type TEXT,
  requested_entity_id TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM payroll_reconciliation_resolutions resolution
     WHERE resolution.entity_type = requested_entity_type
       AND resolution.entity_id = requested_entity_id
       AND resolution.action = 'retry'
       AND resolution.status = 'resolved'
       AND resolution.retry_consumed_at IS NULL
  )
$fn$;

CREATE OR REPLACE FUNCTION payroll_bulk_job_item_retry_authorized(
  requested_job_id TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM payroll_reconciliation_resolutions resolution
     WHERE resolution.entity_type = 'bulk_revision_item'
       AND resolution.action = 'retry'
       AND resolution.status = 'resolved'
       AND resolution.retry_consumed_at IS NULL
       AND resolution.original_evidence->>'job_id' = requested_job_id
  )
$fn$;

CREATE TABLE IF NOT EXISTS salary_revision_command_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(32) NOT NULL,
  authority_checked_at TIMESTAMPTZ NOT NULL,
  authority_source VARCHAR(32) NOT NULL,
  command_scope VARCHAR(48) NOT NULL,
  command_key VARCHAR(200) NOT NULL,
  request_body_sha256 CHAR(64) NOT NULL,
  target_identity VARCHAR(240) NOT NULL,
  response_data JSONB NOT NULL,
  response_message TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_salary_revision_command_receipt_identity CHECK (
    command_scope ~ '^[a-z0-9_]+$'
    AND command_key = BTRIM(command_key)
    AND command_key ~ '^[A-Za-z0-9_:.-]+$'
    AND request_body_sha256 ~ '^[0-9a-f]{64}$'
    AND target_identity = BTRIM(target_identity)
    AND target_identity <> ''
    AND actor_role <> 'PATIENT'
    AND authority_source = 'users_active_row'
    AND jsonb_typeof(response_data) = 'object'
  ),
  CONSTRAINT ux_salary_revision_command_receipt_command
    UNIQUE (tenant_id, actor_uid, command_scope, command_key),
  CONSTRAINT fk_salary_revision_command_receipt_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_salary_revision_command_receipts_completed
  ON salary_revision_command_receipts (tenant_id, completed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION salary_revision_command_receipt_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'salary revision command receipts are append-only'
    USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS salary_revision_command_receipts_append_only
  ON salary_revision_command_receipts;
CREATE TRIGGER salary_revision_command_receipts_append_only
  BEFORE UPDATE OR DELETE ON salary_revision_command_receipts
  FOR EACH ROW EXECUTE FUNCTION salary_revision_command_receipt_append_only();

ALTER TABLE salary_revision_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_revision_command_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation
  ON salary_revision_command_receipts;
CREATE POLICY tenant_isolation
  ON salary_revision_command_receipts
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

CREATE INDEX IF NOT EXISTS idx_salary_revisions_tenant_reconciliation
  ON salary_revisions (tenant_id, tenant_reconciliation_required)
  WHERE tenant_reconciliation_required = TRUE;

ALTER TABLE salary_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS salary_revisions_reconciled_only ON salary_revisions;
CREATE POLICY salary_revisions_reconciled_only
  ON salary_revisions
  AS RESTRICTIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR (
      tenant_reconciliation_required = FALSE
      AND tenant_id IS NOT NULL
      AND tenant_id = app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR (
      tenant_reconciliation_required = FALSE
      AND tenant_id IS NOT NULL
      AND tenant_id = app_current_tenant_id_uuid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_salary_arrears_tenant_reconciliation
  ON salary_arrears (tenant_id, tenant_reconciliation_required)
  WHERE tenant_reconciliation_required = TRUE;

ALTER TABLE salary_arrears ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_arrears FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS salary_arrears_reconciled_only ON salary_arrears;
CREATE POLICY salary_arrears_reconciled_only
  ON salary_arrears
  AS RESTRICTIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR (
      tenant_reconciliation_required = FALSE
      AND tenant_id = app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR (
      tenant_reconciliation_required = FALSE
      AND tenant_id = app_current_tenant_id_uuid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_annual_review_reminders_tenant_reconciliation
  ON annual_review_reminders (tenant_id, tenant_reconciliation_required)
  WHERE tenant_reconciliation_required = TRUE;

ALTER TABLE annual_review_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE annual_review_reminders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS annual_review_reminders_reconciled_only ON annual_review_reminders;
CREATE POLICY annual_review_reminders_reconciled_only
  ON annual_review_reminders
  AS RESTRICTIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR (
      tenant_reconciliation_required = FALSE
      AND tenant_id = app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR (
      tenant_reconciliation_required = FALSE
      AND tenant_id = app_current_tenant_id_uuid()
    )
  );

ALTER TABLE bulk_revision_jobs
  ALTER COLUMN status TYPE VARCHAR(32),
  ALTER COLUMN tenant_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS hr_signed_by UUID,
  ADD COLUMN IF NOT EXISTS hr_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_count INTEGER,
  ADD COLUMN IF NOT EXISTS last_processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cohort_manifest_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS terms_manifest_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS hr_signature_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS admin_signature_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS hr_signer_role VARCHAR(32),
  ADD COLUMN IF NOT EXISTS hr_authority_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hr_authority_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS admin_signer_role VARCHAR(32),
  ADD COLUMN IF NOT EXISTS admin_authority_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_authority_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS created_by_role VARCHAR(32),
  ADD COLUMN IF NOT EXISTS creator_authority_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS creator_authority_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_reason VARCHAR(48),
  ADD COLUMN IF NOT EXISTS tenant_reconciliation_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

DROP TABLE IF EXISTS pg_temp.bulk_revision_jobs_754_identity;
CREATE TEMP TABLE bulk_revision_jobs_754_identity ON COMMIT DROP AS
SELECT job.id, job.tenant_id AS observed_tenant_id,
       creator.tenant_id AS creator_tenant_id,
       hr_signer.tenant_id AS hr_tenant_id,
       admin_signer.tenant_id AS admin_tenant_id,
       job.created_by, job.hr_signed_by, job.approved_by,
       CASE
         WHEN job.created_by IS NULL OR creator.tenant_id IS NULL
           THEN 'creator_identity_unowned'
         WHEN job.hr_signed_by IS NOT NULL
           AND hr_signer.tenant_id IS DISTINCT FROM creator.tenant_id
           THEN 'signer_tenant_conflict'
         WHEN job.approved_by IS NOT NULL
           AND admin_signer.tenant_id IS DISTINCT FROM creator.tenant_id
           THEN 'signer_tenant_conflict'
         ELSE NULL
       END::VARCHAR(48) AS quarantine_reason
  FROM bulk_revision_jobs job
  LEFT JOIN users creator ON creator.uid = job.created_by
  LEFT JOIN users hr_signer ON hr_signer.uid = job.hr_signed_by
  LEFT JOIN users admin_signer ON admin_signer.uid = job.approved_by;

UPDATE bulk_revision_jobs job
SET tenant_id = CASE
      WHEN identity.quarantine_reason IS NULL THEN identity.creator_tenant_id
      ELSE NULL
    END,
    status = CASE
      WHEN identity.quarantine_reason IS NOT NULL THEN 'reconciliation_required'
      ELSE job.status
    END,
    tenant_reconciliation_required = identity.quarantine_reason IS NOT NULL,
    tenant_reconciliation_reason = identity.quarantine_reason,
    tenant_reconciliation_evidence = job.tenant_reconciliation_evidence
      || jsonb_strip_nulls(jsonb_build_object(
           'migration', '754_salary_revision_tenant_reconciliation',
           'observed_tenant_id', identity.observed_tenant_id,
           'creator_tenant_id', identity.creator_tenant_id,
           'hr_tenant_id', identity.hr_tenant_id,
           'admin_tenant_id', identity.admin_tenant_id,
           'observed_created_by', identity.created_by,
           'observed_hr_signed_by', identity.hr_signed_by,
           'observed_approved_by', identity.approved_by,
           'action', CASE WHEN identity.quarantine_reason IS NULL
             THEN 'auto_repaired' ELSE 'quarantined' END
         )),
    hr_signed_by = CASE
      WHEN identity.quarantine_reason IS NULL THEN job.hr_signed_by ELSE NULL END,
    hr_signed_at = CASE
      WHEN identity.quarantine_reason IS NULL THEN job.hr_signed_at ELSE NULL END,
    approved_by = CASE
      WHEN identity.quarantine_reason IS NULL THEN job.approved_by ELSE NULL END,
    approved_at = CASE
      WHEN identity.quarantine_reason IS NULL THEN job.approved_at ELSE NULL END,
    updated_at = NOW()
FROM bulk_revision_jobs_754_identity identity
WHERE job.id = identity.id;

CREATE OR REPLACE FUNCTION salary_revision_signed_terms_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF OLD.hr_signature_sha256 IS NOT NULL AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
    OR NEW.staff_uid IS DISTINCT FROM OLD.staff_uid
    OR NEW.revision_type IS DISTINCT FROM OLD.revision_type
    OR NEW.salary_baseline IS DISTINCT FROM OLD.salary_baseline
    OR NEW.current_basic IS DISTINCT FROM OLD.current_basic
    OR NEW.proposed_basic IS DISTINCT FROM OLD.proposed_basic
    OR NEW.current_gross IS DISTINCT FROM OLD.current_gross
    OR NEW.proposed_gross IS DISTINCT FROM OLD.proposed_gross
    OR NEW.increment_amount IS DISTINCT FROM OLD.increment_amount
    OR NEW.increment_pct IS DISTINCT FROM OLD.increment_pct
    OR NEW.bonus_amount IS DISTINCT FROM OLD.bonus_amount
    OR NEW.bonus_reason IS DISTINCT FROM OLD.bonus_reason
    OR NEW.other_changes IS DISTINCT FROM OLD.other_changes
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
    OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at
    OR NEW.terms_manifest_sha256 IS DISTINCT FROM OLD.terms_manifest_sha256
    OR NEW.hr_signed_by IS DISTINCT FROM OLD.hr_signed_by
    OR NEW.hr_signed_at IS DISTINCT FROM OLD.hr_signed_at
    OR NEW.hr_signer_role IS DISTINCT FROM OLD.hr_signer_role
    OR NEW.hr_authority_checked_at IS DISTINCT FROM OLD.hr_authority_checked_at
    OR NEW.hr_authority_source IS DISTINCT FROM OLD.hr_authority_source
    OR NEW.hr_comment IS DISTINCT FROM OLD.hr_comment
    OR NEW.hr_signature_sha256 IS DISTINCT FROM OLD.hr_signature_sha256
  ) THEN
    RAISE EXCEPTION 'salary revision HR-signed terms are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.admin_signature_sha256 IS NOT NULL AND (
    NEW.admin_signed_by IS DISTINCT FROM OLD.admin_signed_by
    OR NEW.admin_signed_at IS DISTINCT FROM OLD.admin_signed_at
    OR NEW.admin_signer_role IS DISTINCT FROM OLD.admin_signer_role
    OR NEW.admin_authority_checked_at IS DISTINCT FROM OLD.admin_authority_checked_at
    OR NEW.admin_authority_source IS DISTINCT FROM OLD.admin_authority_source
    OR NEW.admin_comment IS DISTINCT FROM OLD.admin_comment
    OR NEW.admin_signature_sha256 IS DISTINCT FROM OLD.admin_signature_sha256
    OR NEW.signature_hash IS DISTINCT FROM OLD.signature_hash
  ) THEN
    RAISE EXCEPTION 'salary revision Admin approval evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.admin_signature_sha256 IS NOT NULL AND (
    (NEW.status IS DISTINCT FROM OLD.status AND NOT (
      OLD.status = 'approved'
      AND NEW.status = 'applied'
      AND OLD.applied_at IS NULL
      AND NEW.applied_at IS NOT NULL
    ))
    OR (
      NEW.applied_at IS DISTINCT FROM OLD.applied_at
      AND NOT (
        OLD.status = 'approved'
        AND NEW.status = 'applied'
        AND OLD.applied_at IS NULL
        AND NEW.applied_at IS NOT NULL
      )
    )
  ) THEN
    RAISE EXCEPTION 'salary revision approval lifecycle is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.rejection_evidence_sha256 IS NOT NULL AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
    OR NEW.staff_uid IS DISTINCT FROM OLD.staff_uid
    OR NEW.revision_type IS DISTINCT FROM OLD.revision_type
    OR NEW.salary_baseline IS DISTINCT FROM OLD.salary_baseline
    OR NEW.current_basic IS DISTINCT FROM OLD.current_basic
    OR NEW.proposed_basic IS DISTINCT FROM OLD.proposed_basic
    OR NEW.current_gross IS DISTINCT FROM OLD.current_gross
    OR NEW.proposed_gross IS DISTINCT FROM OLD.proposed_gross
    OR NEW.increment_amount IS DISTINCT FROM OLD.increment_amount
    OR NEW.increment_pct IS DISTINCT FROM OLD.increment_pct
    OR NEW.bonus_amount IS DISTINCT FROM OLD.bonus_amount
    OR NEW.bonus_reason IS DISTINCT FROM OLD.bonus_reason
    OR NEW.other_changes IS DISTINCT FROM OLD.other_changes
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
    OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at
    OR NEW.terms_manifest_sha256 IS DISTINCT FROM OLD.terms_manifest_sha256
    OR NEW.rejected_by IS DISTINCT FROM OLD.rejected_by
    OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
    OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
    OR NEW.rejected_actor_role IS DISTINCT FROM OLD.rejected_actor_role
    OR NEW.rejected_authority_checked_at IS DISTINCT FROM OLD.rejected_authority_checked_at
    OR NEW.rejected_authority_source IS DISTINCT FROM OLD.rejected_authority_source
    OR NEW.rejection_evidence_sha256 IS DISTINCT FROM OLD.rejection_evidence_sha256
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'salary revision rejection evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS salary_revision_signed_terms_immutable ON salary_revisions;
CREATE TRIGGER salary_revision_signed_terms_immutable
  BEFORE UPDATE ON salary_revisions
  FOR EACH ROW EXECUTE FUNCTION salary_revision_signed_terms_immutable();

UPDATE bulk_revision_jobs
SET failed_count = COALESCE(failed_count, 0);

ALTER TABLE bulk_revision_jobs
  ALTER COLUMN failed_count SET DEFAULT 0,
  ALTER COLUMN failed_count SET NOT NULL;

ALTER TABLE bulk_revision_jobs
  DROP CONSTRAINT IF EXISTS chk_bulk_revision_tenant_reconciliation;
ALTER TABLE bulk_revision_jobs
  ADD CONSTRAINT chk_bulk_revision_tenant_reconciliation CHECK (
    (
      tenant_reconciliation_required = FALSE
      AND tenant_id IS NOT NULL
      AND tenant_reconciliation_reason IS NULL
    )
    OR
    (
      tenant_reconciliation_required = TRUE
      AND tenant_id IS NULL
      AND status = 'reconciliation_required'
      AND tenant_reconciliation_reason IN (
        'creator_identity_unowned',
        'signer_tenant_conflict',
        'legacy_nondurable_job'
      )
    )
  ) NOT VALID;

-- No pre-754 job has an immutable cohort/terms manifest. Preserve every legacy
-- job for governed reconciliation; it is unsafe to rebuild today's cohort and
-- attribute it to historical signers.
UPDATE bulk_revision_jobs
SET tenant_id = NULL,
    status = 'reconciliation_required',
    tenant_reconciliation_required = TRUE,
    tenant_reconciliation_reason = 'legacy_nondurable_job',
    tenant_reconciliation_evidence = tenant_reconciliation_evidence
      || jsonb_build_object(
           'migration', '754_salary_revision_tenant_reconciliation',
           'action', 'quarantined',
           'reason', 'legacy_nondurable_job',
           'observed_status', status,
           'observed_staff_count', staff_count,
           'observed_processed_count', processed_count,
           'observed_failed_count', failed_count,
           'observed_completed_at', completed_at,
           'observed_error_sha256', CASE WHEN error_log IS NULL THEN NULL
             ELSE encode(digest(error_log, 'sha256'), 'hex') END
         ),
    error_log = concat_ws(
      E'\n',
      NULLIF(error_log, ''),
      'Migration 754 quarantined a legacy non-durable bulk revision job.'
    ),
    updated_at = NOW()
WHERE tenant_reconciliation_required = FALSE
  AND (
    cohort_manifest_sha256 IS NULL
    OR terms_manifest_sha256 IS NULL
    OR status NOT IN (
      'draft', 'pending_admin', 'queued', 'processing',
      'completed', 'reconciliation_required'
    )
  );

ALTER TABLE bulk_revision_jobs
  VALIDATE CONSTRAINT chk_bulk_revision_tenant_reconciliation;

ALTER TABLE bulk_revision_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_revision_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulk_revision_jobs_reconciled_only ON bulk_revision_jobs;
CREATE POLICY bulk_revision_jobs_reconciled_only
  ON bulk_revision_jobs
  AS RESTRICTIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR (
      tenant_reconciliation_required = FALSE
      AND tenant_id = app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR (
      tenant_reconciliation_required = FALSE
      AND tenant_id = app_current_tenant_id_uuid()
    )
  );

ALTER TABLE bulk_revision_jobs
  DROP CONSTRAINT IF EXISTS chk_bulk_revision_signer_separation,
  DROP CONSTRAINT IF EXISTS chk_bulk_revision_creator_authority,
  DROP CONSTRAINT IF EXISTS chk_bulk_revision_cohort_manifest,
  DROP CONSTRAINT IF EXISTS chk_bulk_revision_signed_manifests,
  DROP CONSTRAINT IF EXISTS fk_bulk_revision_jobs_hr_signer_tenant,
  DROP CONSTRAINT IF EXISTS fk_bulk_revision_jobs_admin_signer_tenant,
  DROP CONSTRAINT IF EXISTS fk_bulk_revision_jobs_creator_tenant;

ALTER TABLE bulk_revision_jobs
  ADD CONSTRAINT chk_bulk_revision_creator_authority CHECK (
    tenant_reconciliation_required = TRUE
    OR (
      created_by_role IN ('HR_STAFF', 'ADMIN', 'SUPER_ADMIN')
      AND creator_authority_checked_at IS NOT NULL
      AND creator_authority_source = 'users_active_row'
    )
  ),
  ADD CONSTRAINT chk_bulk_revision_signer_separation CHECK (
    hr_signed_by IS NULL
    OR approved_by IS NULL
    OR hr_signed_by IS DISTINCT FROM approved_by
  ),
  ADD CONSTRAINT chk_bulk_revision_cohort_manifest CHECK (
    cohort_manifest_sha256 IS NULL
    OR cohort_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT chk_bulk_revision_signed_manifests CHECK (
    (terms_manifest_sha256 IS NULL OR terms_manifest_sha256 ~ '^[0-9a-f]{64}$')
    AND (hr_signature_sha256 IS NULL OR hr_signature_sha256 ~ '^[0-9a-f]{64}$')
    AND (admin_signature_sha256 IS NULL OR admin_signature_sha256 ~ '^[0-9a-f]{64}$')
    AND (hr_signature_sha256 IS NULL OR hr_signed_at IS NOT NULL)
    AND (admin_signature_sha256 IS NULL OR approved_at IS NOT NULL)
    AND (
      hr_signature_sha256 IS NULL
      OR (
        hr_signer_role = 'HR_STAFF'
        AND hr_authority_checked_at = hr_signed_at
        AND hr_authority_source = 'users_active_row'
      )
    )
    AND (
      admin_signature_sha256 IS NULL
      OR (
        admin_signer_role IN ('ADMIN', 'SUPER_ADMIN')
        AND admin_authority_checked_at = approved_at
        AND admin_authority_source = 'users_active_row'
      )
    )
  ),
  ADD CONSTRAINT fk_bulk_revision_jobs_hr_signer_tenant
    FOREIGN KEY (tenant_id, hr_signed_by) REFERENCES users (tenant_id, uid),
  ADD CONSTRAINT fk_bulk_revision_jobs_admin_signer_tenant
    FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, uid),
  ADD CONSTRAINT fk_bulk_revision_jobs_creator_tenant
    FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, uid);

ALTER TABLE bulk_revision_jobs
  DROP CONSTRAINT IF EXISTS chk_bulk_revision_lifecycle_evidence;
ALTER TABLE bulk_revision_jobs
  ADD CONSTRAINT chk_bulk_revision_lifecycle_evidence CHECK (
    tenant_reconciliation_required = TRUE
    OR CASE status
      WHEN 'building' THEN
        staff_count = 0
        AND cohort_manifest_sha256 IS NULL
        AND terms_manifest_sha256 IS NULL
        AND hr_signed_by IS NULL
        AND approved_by IS NULL
      WHEN 'draft' THEN
        staff_count > 0
        AND cohort_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signed_by IS NULL
        AND approved_by IS NULL
      WHEN 'pending_admin' THEN
        staff_count > 0
        AND cohort_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signed_by IS NOT NULL
        AND hr_signed_at IS NOT NULL
        AND hr_signer_role = 'HR_STAFF'
        AND hr_authority_checked_at = hr_signed_at
        AND hr_authority_source = 'users_active_row'
        AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
        AND approved_by IS NULL
        AND admin_signature_sha256 IS NULL
      WHEN 'queued' THEN
        staff_count > 0
        AND cohort_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signed_by IS NOT NULL
        AND hr_signed_at IS NOT NULL
        AND hr_signer_role = 'HR_STAFF'
        AND hr_authority_checked_at = hr_signed_at
        AND hr_authority_source = 'users_active_row'
        AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
        AND approved_by IS NOT NULL
        AND approved_at IS NOT NULL
        AND admin_signer_role IN ('ADMIN', 'SUPER_ADMIN')
        AND admin_authority_checked_at = approved_at
        AND admin_authority_source = 'users_active_row'
        AND admin_signature_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signed_by IS DISTINCT FROM approved_by
      WHEN 'processing' THEN
        staff_count > 0
        AND cohort_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
        AND admin_signature_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signer_role = 'HR_STAFF'
        AND admin_signer_role IN ('ADMIN', 'SUPER_ADMIN')
        AND hr_signed_by IS DISTINCT FROM approved_by
      WHEN 'completed' THEN
        staff_count > 0
        AND processed_count = staff_count
        AND COALESCE(failed_count, 0) = 0
        AND completed_at IS NOT NULL
        AND cohort_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
        AND admin_signature_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signed_by IS DISTINCT FROM approved_by
      WHEN 'reconciliation_required' THEN
        tenant_id IS NOT NULL
        AND cohort_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
        AND admin_signature_sha256 ~ '^[0-9a-f]{64}$'
        AND hr_signed_by IS DISTINCT FROM approved_by
      ELSE FALSE
    END
  );

CREATE OR REPLACE FUNCTION bulk_revision_job_signed_evidence_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF OLD.hr_signature_sha256 IS NOT NULL AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.revision_type IS DISTINCT FROM OLD.revision_type
    OR NEW.target_type IS DISTINCT FROM OLD.target_type
    OR NEW.target_value IS DISTINCT FROM OLD.target_value
    OR NEW.increment_type IS DISTINCT FROM OLD.increment_type
    OR NEW.increment_value IS DISTINCT FROM OLD.increment_value
    OR NEW.bonus_amount IS DISTINCT FROM OLD.bonus_amount
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.staff_count IS DISTINCT FROM OLD.staff_count
    OR NEW.cohort_manifest_sha256 IS DISTINCT FROM OLD.cohort_manifest_sha256
    OR NEW.terms_manifest_sha256 IS DISTINCT FROM OLD.terms_manifest_sha256
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_by_role IS DISTINCT FROM OLD.created_by_role
    OR NEW.creator_authority_checked_at IS DISTINCT FROM OLD.creator_authority_checked_at
    OR NEW.creator_authority_source IS DISTINCT FROM OLD.creator_authority_source
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.hr_signed_by IS DISTINCT FROM OLD.hr_signed_by
    OR NEW.hr_signed_at IS DISTINCT FROM OLD.hr_signed_at
    OR NEW.hr_signature_sha256 IS DISTINCT FROM OLD.hr_signature_sha256
    OR NEW.hr_signer_role IS DISTINCT FROM OLD.hr_signer_role
    OR NEW.hr_authority_checked_at IS DISTINCT FROM OLD.hr_authority_checked_at
    OR NEW.hr_authority_source IS DISTINCT FROM OLD.hr_authority_source
  ) THEN
    RAISE EXCEPTION 'bulk revision HR-signed evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.admin_signature_sha256 IS NOT NULL AND (
    NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.admin_signature_sha256 IS DISTINCT FROM OLD.admin_signature_sha256
    OR NEW.admin_signer_role IS DISTINCT FROM OLD.admin_signer_role
    OR NEW.admin_authority_checked_at IS DISTINCT FROM OLD.admin_authority_checked_at
    OR NEW.admin_authority_source IS DISTINCT FROM OLD.admin_authority_source
  ) THEN
    RAISE EXCEPTION 'bulk revision Admin approval evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.admin_signature_sha256 IS NOT NULL
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('processing', 'reconciliation_required'))
       OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'reconciliation_required'))
       OR (
         OLD.status = 'reconciliation_required'
         AND NEW.status = 'processing'
         AND payroll_bulk_job_item_retry_authorized(OLD.id::TEXT)
       )
     ) THEN
    RAISE EXCEPTION 'bulk revision approved lifecycle transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('completed', 'reconciliation_required')
     AND NOT (
       OLD.status = 'reconciliation_required'
       AND NEW.status = 'processing'
       AND payroll_bulk_job_item_retry_authorized(OLD.id::TEXT)
     )
     AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.staff_count IS DISTINCT FROM OLD.staff_count
    OR NEW.processed_count IS DISTINCT FROM OLD.processed_count
    OR NEW.failed_count IS DISTINCT FROM OLD.failed_count
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.last_processed_at IS DISTINCT FROM OLD.last_processed_at
    OR NEW.error_log IS DISTINCT FROM OLD.error_log
    OR NEW.tenant_reconciliation_required IS DISTINCT FROM OLD.tenant_reconciliation_required
    OR NEW.tenant_reconciliation_reason IS DISTINCT FROM OLD.tenant_reconciliation_reason
    OR NEW.tenant_reconciliation_evidence IS DISTINCT FROM OLD.tenant_reconciliation_evidence
  ) THEN
    RAISE EXCEPTION 'terminal bulk revision job evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS bulk_revision_job_signed_evidence_immutable
  ON bulk_revision_jobs;
CREATE TRIGGER bulk_revision_job_signed_evidence_immutable
  BEFORE UPDATE ON bulk_revision_jobs
  FOR EACH ROW EXECUTE FUNCTION bulk_revision_job_signed_evidence_immutable();

CREATE UNIQUE INDEX IF NOT EXISTS ux_bulk_revision_jobs_tenant_id_id
  ON bulk_revision_jobs (tenant_id, id);

CREATE TABLE IF NOT EXISTS bulk_revision_job_items (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  job_id INTEGER NOT NULL,
  staff_uid UUID NOT NULL,
  staff_role_at_freeze VARCHAR(50) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  revision_id INTEGER,
  salary_before NUMERIC(12, 2),
  salary_after NUMERIC(12, 2),
  salary_baseline JSONB,
  last_error TEXT,
  outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  CONSTRAINT ux_bulk_revision_job_items_tenant_job_staff
    UNIQUE (tenant_id, job_id, staff_uid),
  CONSTRAINT chk_bulk_revision_job_items_status CHECK (
    status IN ('pending', 'processing', 'applied', 'reconciliation_required')
  ),
  CONSTRAINT chk_bulk_revision_job_items_staff_role CHECK (
    staff_role_at_freeze = UPPER(BTRIM(staff_role_at_freeze))
    AND staff_role_at_freeze <> 'PATIENT'
  ),
  CONSTRAINT chk_bulk_revision_job_items_claim CHECK (
    (
      status = 'processing'
      AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR
    (
      status <> 'processing'
      AND claim_token IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT fk_bulk_revision_job_items_job_tenant
    FOREIGN KEY (tenant_id, job_id)
    REFERENCES bulk_revision_jobs (tenant_id, id),
  CONSTRAINT fk_bulk_revision_job_items_staff_tenant
    FOREIGN KEY (tenant_id, staff_uid)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_bulk_revision_job_items_revision_tenant
    FOREIGN KEY (tenant_id, revision_id)
    REFERENCES salary_revisions (tenant_id, id)
);

ALTER TABLE bulk_revision_job_items
  ADD COLUMN IF NOT EXISTS salary_baseline JSONB;

CREATE OR REPLACE FUNCTION bulk_revision_signed_cohort_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  parent_signed BOOLEAN;
  old_parent_signed BOOLEAN := FALSE;
  parent_tenant UUID;
  parent_job_id INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_tenant := OLD.tenant_id;
    parent_job_id := OLD.job_id;
  ELSE
    parent_tenant := NEW.tenant_id;
    parent_job_id := NEW.job_id;
  END IF;
  SELECT job.hr_signature_sha256 IS NOT NULL
    INTO parent_signed
    FROM bulk_revision_jobs job
   WHERE job.tenant_id = parent_tenant
     AND job.id = parent_job_id
   FOR SHARE;
  IF TG_OP = 'UPDATE' THEN
    SELECT job.hr_signature_sha256 IS NOT NULL
      INTO old_parent_signed
      FROM bulk_revision_jobs job
     WHERE job.tenant_id = OLD.tenant_id
       AND job.id = OLD.job_id
     FOR SHARE;
    parent_signed := COALESCE(parent_signed, FALSE)
      OR COALESCE(old_parent_signed, FALSE);
  END IF;
  IF COALESCE(parent_signed, FALSE) THEN
    IF TG_OP IN ('INSERT', 'DELETE') THEN
      RAISE EXCEPTION 'bulk revision signed cohort membership is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.job_id IS DISTINCT FROM OLD.job_id
       OR NEW.staff_uid IS DISTINCT FROM OLD.staff_uid
       OR NEW.staff_role_at_freeze IS DISTINCT FROM OLD.staff_role_at_freeze
       OR NEW.salary_before IS DISTINCT FROM OLD.salary_before
       OR NEW.salary_baseline IS DISTINCT FROM OLD.salary_baseline
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'bulk revision signed cohort baseline is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

DROP TRIGGER IF EXISTS bulk_revision_signed_cohort_immutable
  ON bulk_revision_job_items;
CREATE TRIGGER bulk_revision_signed_cohort_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON bulk_revision_job_items
  FOR EACH ROW EXECUTE FUNCTION bulk_revision_signed_cohort_immutable();

CREATE INDEX IF NOT EXISTS idx_bulk_revision_job_items_queue
  ON bulk_revision_job_items (status, next_attempt_at, id)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_bulk_revision_job_items_tenant_job
  ON bulk_revision_job_items (tenant_id, job_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bulk_revision_job_items_tenant_revision
  ON bulk_revision_job_items (tenant_id, revision_id)
  WHERE revision_id IS NOT NULL;

ALTER TABLE bulk_revision_job_items
  DROP CONSTRAINT IF EXISTS chk_bulk_revision_job_items_terminal;
-- reconciliation_required is terminal and operator-owned: the worker never
-- retries or mutates one of these rows until an explicit reconciliation action
-- is designed and authorized.
ALTER TABLE bulk_revision_job_items
  ADD CONSTRAINT chk_bulk_revision_job_items_terminal CHECK (
    (
      status = 'applied'
      AND revision_id IS NOT NULL
      AND applied_at IS NOT NULL
      AND finalized_at IS NOT NULL
      AND outcome->>'code' = 'applied'
      AND (outcome->>'revision_id')::INTEGER = revision_id
    )
    OR
    (
      status = 'reconciliation_required'
      AND revision_id IS NULL
      AND finalized_at IS NOT NULL
      AND outcome->>'code' IN (
        'bulk_revision_staff_failed',
        'bulk_revision_lease_exhausted'
      )
      AND (outcome->>'attempt_count')::INTEGER = attempt_count
      AND (
        outcome->>'code' = 'bulk_revision_lease_exhausted'
        OR NULLIF(BTRIM(outcome->>'message'), '') IS NOT NULL
      )
    )
    OR (
      status IN ('pending', 'processing')
      AND revision_id IS NULL
      AND applied_at IS NULL
      AND finalized_at IS NULL
      AND outcome = '{}'::jsonb
    )
  );

CREATE OR REPLACE FUNCTION bulk_revision_job_item_terminal_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF OLD.status IN ('applied', 'reconciliation_required')
     AND NOT (
       OLD.status = 'reconciliation_required'
       AND NEW.status = 'pending'
       AND payroll_reconciliation_retry_authorized(
         'bulk_revision_item', OLD.id::TEXT
       )
     )
     AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.staff_uid IS DISTINCT FROM OLD.staff_uid
    OR NEW.staff_role_at_freeze IS DISTINCT FROM OLD.staff_role_at_freeze
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
    OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
    OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.salary_before IS DISTINCT FROM OLD.salary_before
    OR NEW.salary_after IS DISTINCT FROM OLD.salary_after
    OR NEW.salary_baseline IS DISTINCT FROM OLD.salary_baseline
    OR NEW.last_error IS DISTINCT FROM OLD.last_error
    OR NEW.outcome IS DISTINCT FROM OLD.outcome
    OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'terminal bulk revision item evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS bulk_revision_job_item_terminal_immutable
  ON bulk_revision_job_items;
CREATE TRIGGER bulk_revision_job_item_terminal_immutable
  BEFORE UPDATE ON bulk_revision_job_items
  FOR EACH ROW EXECUTE FUNCTION bulk_revision_job_item_terminal_immutable();

ALTER TABLE bulk_revision_job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_revision_job_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bulk_revision_job_items;
CREATE POLICY tenant_isolation
  ON bulk_revision_job_items
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

CREATE TABLE IF NOT EXISTS salary_revision_payables (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  revision_id INTEGER NOT NULL,
  staff_uid UUID NOT NULL,
  payable_type VARCHAR(20) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  payroll_run_id INTEGER,
  claim_attempt_token UUID,
  payslip_id INTEGER,
  claimed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  reconciliation_reason VARCHAR(48),
  reconciliation_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  reconciliation_decision VARCHAR(32),
  reconciliation_hr_by UUID,
  reconciliation_hr_at TIMESTAMPTZ,
  reconciliation_hr_evidence JSONB,
  reconciliation_hr_evidence_sha256 CHAR(64),
  reconciliation_hr_request_sha256 CHAR(64),
  reconciliation_hr_actor_role VARCHAR(32),
  reconciliation_hr_authority_checked_at TIMESTAMPTZ,
  reconciliation_hr_authority_source VARCHAR(32),
  reconciliation_admin_by UUID,
  reconciliation_admin_at TIMESTAMPTZ,
  reconciliation_admin_evidence JSONB,
  reconciliation_admin_signature_sha256 CHAR(64),
  reconciliation_admin_request_sha256 CHAR(64),
  reconciliation_admin_actor_role VARCHAR(32),
  reconciliation_admin_authority_checked_at TIMESTAMPTZ,
  reconciliation_admin_authority_source VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_salary_revision_payables_tenant_revision
    UNIQUE (tenant_id, revision_id),
  CONSTRAINT chk_salary_revision_payables_type CHECK (payable_type = 'bonus'),
  CONSTRAINT chk_salary_revision_payables_amount CHECK (amount > 0),
  CONSTRAINT chk_salary_revision_payables_lifecycle CHECK (
    (status = 'pending'
      AND payroll_run_id IS NULL AND claim_attempt_token IS NULL
      AND payslip_id IS NULL AND claimed_at IS NULL AND paid_at IS NULL)
    OR (status = 'claimed'
      AND payroll_run_id IS NOT NULL AND claim_attempt_token IS NOT NULL
      AND payslip_id IS NULL AND claimed_at IS NOT NULL AND paid_at IS NULL)
    OR (status = 'paid'
      AND payroll_run_id IS NOT NULL AND claim_attempt_token IS NOT NULL
      AND payslip_id IS NOT NULL AND claimed_at IS NOT NULL AND paid_at IS NOT NULL)
    OR (status = 'reconciliation_required'
      AND payroll_run_id IS NULL AND claim_attempt_token IS NULL
      AND payslip_id IS NULL AND claimed_at IS NULL AND paid_at IS NULL
      AND reconciliation_reason IS NOT NULL)
    OR (status = 'excluded'
      AND payroll_run_id IS NULL AND claim_attempt_token IS NULL
      AND payslip_id IS NULL AND claimed_at IS NULL AND paid_at IS NULL)
  ),
  CONSTRAINT chk_salary_revision_payables_reconciliation_authority CHECK (
    (
      reconciliation_decision IS NULL
      AND status <> 'excluded'
      AND reconciliation_hr_by IS NULL AND reconciliation_hr_at IS NULL
      AND reconciliation_hr_evidence IS NULL
      AND reconciliation_hr_evidence_sha256 IS NULL
      AND reconciliation_hr_request_sha256 IS NULL
      AND reconciliation_hr_actor_role IS NULL
      AND reconciliation_hr_authority_checked_at IS NULL
      AND reconciliation_hr_authority_source IS NULL
      AND reconciliation_admin_by IS NULL AND reconciliation_admin_at IS NULL
      AND reconciliation_admin_evidence IS NULL
      AND reconciliation_admin_signature_sha256 IS NULL
      AND reconciliation_admin_request_sha256 IS NULL
      AND reconciliation_admin_actor_role IS NULL
      AND reconciliation_admin_authority_checked_at IS NULL
      AND reconciliation_admin_authority_source IS NULL
    )
    OR (
      reconciliation_decision IN ('confirmed_unpaid', 'confirmed_settled')
      AND reconciliation_hr_by IS NOT NULL AND reconciliation_hr_at IS NOT NULL
      AND jsonb_typeof(reconciliation_hr_evidence) = 'object'
      AND reconciliation_hr_evidence <> '{}'::jsonb
      AND reconciliation_hr_evidence_sha256 ~ '^[0-9a-f]{64}$'
      AND reconciliation_hr_request_sha256 ~ '^[0-9a-f]{64}$'
      AND reconciliation_hr_actor_role = 'HR_STAFF'
      AND reconciliation_hr_authority_checked_at = reconciliation_hr_at
      AND reconciliation_hr_authority_source = 'users_active_row'
      AND (
        (
          status = 'reconciliation_required'
          AND reconciliation_admin_by IS NULL
          AND reconciliation_admin_at IS NULL
          AND reconciliation_admin_evidence IS NULL
          AND reconciliation_admin_signature_sha256 IS NULL
          AND reconciliation_admin_request_sha256 IS NULL
          AND reconciliation_admin_actor_role IS NULL
          AND reconciliation_admin_authority_checked_at IS NULL
          AND reconciliation_admin_authority_source IS NULL
        )
        OR (
          reconciliation_admin_by IS NOT NULL
          AND reconciliation_admin_at IS NOT NULL
          AND reconciliation_admin_by IS DISTINCT FROM reconciliation_hr_by
          AND jsonb_typeof(reconciliation_admin_evidence) = 'object'
          AND reconciliation_admin_evidence <> '{}'::jsonb
          AND reconciliation_admin_signature_sha256 ~ '^[0-9a-f]{64}$'
          AND reconciliation_admin_request_sha256 ~ '^[0-9a-f]{64}$'
          AND reconciliation_admin_actor_role IN ('ADMIN', 'SUPER_ADMIN')
          AND reconciliation_admin_authority_checked_at = reconciliation_admin_at
          AND reconciliation_admin_authority_source = 'users_active_row'
          AND (
            (reconciliation_decision = 'confirmed_unpaid'
              AND status IN ('pending', 'claimed', 'paid'))
            OR (reconciliation_decision = 'confirmed_settled'
              AND status = 'excluded')
          )
        )
      )
    )
  ),
  CONSTRAINT fk_salary_revision_payables_revision
    FOREIGN KEY (tenant_id, revision_id)
    REFERENCES salary_revisions (tenant_id, id),
  CONSTRAINT fk_salary_revision_payables_staff
    FOREIGN KEY (tenant_id, staff_uid)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_salary_revision_payables_hr_reconciler
    FOREIGN KEY (tenant_id, reconciliation_hr_by)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_salary_revision_payables_admin_reconciler
    FOREIGN KEY (tenant_id, reconciliation_admin_by)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_salary_revision_payables_run
    FOREIGN KEY (tenant_id, payroll_run_id)
    REFERENCES payroll_runs (tenant_id, id),
  CONSTRAINT fk_salary_revision_payables_payslip
    FOREIGN KEY (tenant_id, payslip_id)
    REFERENCES payslips (tenant_id, id),
  CONSTRAINT fk_salary_revision_payables_payslip_attempt_staff
    FOREIGN KEY (
      tenant_id, payslip_id, payroll_run_id, claim_attempt_token, staff_uid
    )
    REFERENCES payslips (
      tenant_id, id, payroll_run_id, generation_attempt_token, staff_uid
    )
);

INSERT INTO salary_revision_payables (
  tenant_id, revision_id, staff_uid, payable_type, amount, status,
  reconciliation_reason, reconciliation_evidence
)
SELECT revision.tenant_id, revision.id, revision.staff_uid,
       'bonus', revision.bonus_amount, 'reconciliation_required',
       'legacy_settlement_unknown',
       jsonb_build_object(
         'migration', '754_salary_revision_tenant_reconciliation',
         'action', 'quarantined',
         'reason', 'legacy bonus settlement cannot be inferred'
       )
  FROM salary_revisions revision
  JOIN users staff_owner
    ON staff_owner.tenant_id = revision.tenant_id
   AND staff_owner.uid = revision.staff_uid
 WHERE revision.tenant_id IS NOT NULL
   AND revision.tenant_reconciliation_required = FALSE
   AND revision.status = 'applied'
   AND revision.revision_type = 'bonus'
   AND revision.bonus_amount > 0
ON CONFLICT (tenant_id, revision_id) DO NOTHING;

UPDATE salary_revision_payables payable
SET reconciliation_reason = 'legacy_settlement_unknown',
    reconciliation_evidence = payable.reconciliation_evidence
      || jsonb_build_object(
           'migration', '754_salary_revision_tenant_reconciliation',
           'action', 'quarantined',
           'reason', 'legacy bonus settlement cannot be inferred'
         )
WHERE payable.status = 'reconciliation_required'
  AND payable.reconciliation_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_salary_revision_payables_staff_status
  ON salary_revision_payables (tenant_id, staff_uid, status, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_salary_revision_payables_tenant_id_id
  ON salary_revision_payables (tenant_id, id);

CREATE OR REPLACE FUNCTION salary_revision_payable_reconciliation_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.staff_uid IS DISTINCT FROM OLD.staff_uid
    OR NEW.payable_type IS DISTINCT FROM OLD.payable_type
    OR NEW.amount IS DISTINCT FROM OLD.amount
  THEN
    RAISE EXCEPTION 'salary revision payable identity and amount are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.reconciliation_hr_by IS NOT NULL AND (
    NEW.reconciliation_decision IS DISTINCT FROM OLD.reconciliation_decision
    OR NEW.reconciliation_hr_by IS DISTINCT FROM OLD.reconciliation_hr_by
    OR NEW.reconciliation_hr_at IS DISTINCT FROM OLD.reconciliation_hr_at
    OR NEW.reconciliation_hr_evidence IS DISTINCT FROM OLD.reconciliation_hr_evidence
    OR NEW.reconciliation_hr_evidence_sha256 IS DISTINCT FROM OLD.reconciliation_hr_evidence_sha256
    OR NEW.reconciliation_hr_request_sha256 IS DISTINCT FROM OLD.reconciliation_hr_request_sha256
    OR NEW.reconciliation_hr_actor_role IS DISTINCT FROM OLD.reconciliation_hr_actor_role
    OR NEW.reconciliation_hr_authority_checked_at IS DISTINCT FROM OLD.reconciliation_hr_authority_checked_at
    OR NEW.reconciliation_hr_authority_source IS DISTINCT FROM OLD.reconciliation_hr_authority_source
    OR NEW.reconciliation_evidence IS DISTINCT FROM OLD.reconciliation_evidence
  ) THEN
    RAISE EXCEPTION 'salary revision payable HR reconciliation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.reconciliation_admin_by IS NOT NULL AND (
    NEW.reconciliation_admin_by IS DISTINCT FROM OLD.reconciliation_admin_by
    OR NEW.reconciliation_admin_at IS DISTINCT FROM OLD.reconciliation_admin_at
    OR NEW.reconciliation_admin_evidence IS DISTINCT FROM OLD.reconciliation_admin_evidence
    OR NEW.reconciliation_admin_signature_sha256 IS DISTINCT FROM OLD.reconciliation_admin_signature_sha256
    OR NEW.reconciliation_admin_request_sha256 IS DISTINCT FROM OLD.reconciliation_admin_request_sha256
    OR NEW.reconciliation_admin_actor_role IS DISTINCT FROM OLD.reconciliation_admin_actor_role
    OR NEW.reconciliation_admin_authority_checked_at IS DISTINCT FROM OLD.reconciliation_admin_authority_checked_at
    OR NEW.reconciliation_admin_authority_source IS DISTINCT FROM OLD.reconciliation_admin_authority_source
  ) THEN
    RAISE EXCEPTION 'salary revision payable reconciliation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS salary_revision_payable_reconciliation_immutable
  ON salary_revision_payables;
CREATE TRIGGER salary_revision_payable_reconciliation_immutable
  BEFORE UPDATE ON salary_revision_payables
  FOR EACH ROW EXECUTE FUNCTION salary_revision_payable_reconciliation_immutable();

ALTER TABLE salary_revision_payables ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_revision_payables FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation
  ON salary_revision_payables;
CREATE POLICY tenant_isolation
  ON salary_revision_payables
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

CREATE TABLE IF NOT EXISTS salary_revision_activation_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  revision_id INTEGER NOT NULL,
  staff_uid UUID NOT NULL,
  event_type VARCHAR(48) NOT NULL DEFAULT 'salary_revision_activated',
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(80) NOT NULL,
  effective_on DATE NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  terms_manifest_sha256 CHAR(64) NOT NULL,
  hr_signature_sha256 CHAR(64) NOT NULL,
  admin_signature_sha256 CHAR(64) NOT NULL,
  payable_id BIGINT,
  arrears_work_item_id BIGINT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ux_salary_revision_activation_event
    UNIQUE (tenant_id, revision_id, event_type),
  CONSTRAINT chk_salary_revision_activation_event_identity CHECK (
    event_type = 'salary_revision_activated'
    AND source_type IN ('manual_apply', 'activation_worker', 'bulk_revision_worker')
    AND NULLIF(BTRIM(source_id), '') IS NOT NULL
    AND terms_manifest_sha256 ~ '^[0-9a-f]{64}$'
    AND hr_signature_sha256 ~ '^[0-9a-f]{64}$'
    AND admin_signature_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(payload) = 'object'
    AND payload <> '{}'::jsonb
  ),
  CONSTRAINT fk_salary_revision_activation_event_revision
    FOREIGN KEY (tenant_id, revision_id, staff_uid)
    REFERENCES salary_revisions (tenant_id, id, staff_uid),
  CONSTRAINT fk_salary_revision_activation_event_payable
    FOREIGN KEY (tenant_id, payable_id)
    REFERENCES salary_revision_payables (tenant_id, id),
  CONSTRAINT fk_salary_revision_activation_event_arrears_work
    FOREIGN KEY (tenant_id, arrears_work_item_id)
    REFERENCES salary_revision_arrears_work_items (tenant_id, id)
);

CREATE OR REPLACE FUNCTION salary_revision_activation_event_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'salary revision activation events are append-only'
    USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS salary_revision_activation_event_append_only
  ON salary_revision_activation_events;
CREATE TRIGGER salary_revision_activation_event_append_only
  BEFORE UPDATE OR DELETE ON salary_revision_activation_events
  FOR EACH ROW EXECUTE FUNCTION salary_revision_activation_event_append_only();

ALTER TABLE salary_revision_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_revision_activation_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation
  ON salary_revision_activation_events;
CREATE POLICY tenant_isolation
  ON salary_revision_activation_events
  AS PERMISSIVE
  FOR ALL
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

COMMIT;
