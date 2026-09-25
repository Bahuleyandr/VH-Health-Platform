-- Restore the three tenant domains declared by 013 but absent because the
-- baseline already created public.tenants before CREATE TABLE IF NOT EXISTS.
-- Fresh PG17 catalog at 95baac6b5: these three CHECKs are absent; the
-- migration-155 pregnancy CHECKs are present as the census positive control.
-- Comprehensive-seed pre-check (2026-09-25, two tenant rows; each result zero):
-- SELECT count(*) FILTER (WHERE (region IN ('IN','EU','US','AP','OTHER')) IS FALSE),
--        count(*) FILTER (WHERE (compliance_profile IN ('DPDP','HIPAA','GDPR','NONE')) IS FALSE),
--        count(*) FILTER (WHERE (status IN ('active','suspended','offboarding')) IS FALSE)
-- FROM public.tenants;
-- Production may contain historical values outside these domains. Do not
-- rewrite tenant identity or access state: an affected CHECK remains NOT VALID
-- until the records and operator disposition are reviewed.

BEGIN;

DO $$
DECLARE
  invalid_region BIGINT;
  invalid_compliance_profile BIGINT;
  invalid_status BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tenants'::regclass
       AND conname = 'tenants_region_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_region_check
      CHECK (region IN ('IN', 'EU', 'US', 'AP', 'OTHER')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tenants'::regclass
       AND conname = 'tenants_compliance_profile_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_compliance_profile_check
      CHECK (compliance_profile IN ('DPDP', 'HIPAA', 'GDPR', 'NONE')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tenants'::regclass
       AND conname = 'tenants_status_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_status_check
      CHECK (status IN ('active', 'suspended', 'offboarding')) NOT VALID;
  END IF;

  SELECT
    count(*) FILTER (WHERE (region IN ('IN', 'EU', 'US', 'AP', 'OTHER')) IS FALSE),
    count(*) FILTER (WHERE (compliance_profile IN ('DPDP', 'HIPAA', 'GDPR', 'NONE')) IS FALSE),
    count(*) FILTER (WHERE (status IN ('active', 'suspended', 'offboarding')) IS FALSE)
    INTO invalid_region, invalid_compliance_profile, invalid_status
    FROM public.tenants;

  IF invalid_region = 0 THEN
    ALTER TABLE public.tenants VALIDATE CONSTRAINT tenants_region_check;
  END IF;
  IF invalid_compliance_profile = 0 THEN
    ALTER TABLE public.tenants VALIDATE CONSTRAINT tenants_compliance_profile_check;
  END IF;
  IF invalid_status = 0 THEN
    ALTER TABLE public.tenants VALIDATE CONSTRAINT tenants_status_check;
  END IF;

  IF invalid_region + invalid_compliance_profile + invalid_status > 0 THEN
    RAISE WARNING 'Migration 803: historical tenant-domain violations (region=%, compliance_profile=%, status=%). Affected CHECKs remain NOT VALID; no rows changed. Operator review required.',
      invalid_region, invalid_compliance_profile, invalid_status;
  END IF;
END
$$;

COMMIT;
