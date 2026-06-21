-- 339_fix_data_processing_activities_lawful_basis.sql
--
-- Backfill for already-deployed databases: correct data_processing_activities
-- rows whose lawful_basis was seeded with non-Art.6 GDPR values by the original
-- migration 300 -- 'medical_care' (INDIA_TREATMENT_CARE_RECORDS,
-- INDIA_PHARMACY_SUPPLY) and 'security' (INDIA_AUDIT_SECURITY).
--
-- Migration 300 itself was corrected to seed the valid Art.6 basis
-- 'legitimate_interests' for FRESH applies, but rows inserted by the old 300 on
-- databases provisioned before that fix keep the invalid values until this runs.
-- 'legitimate_interests' is one of the six Art.6 bases enforced by
-- data_processing_activities_lawful_basis_check (migration 127); this also
-- brings any such rows back into constraint-compliance.
--
-- Idempotent and a no-op on fresh DBs (those rows already say
-- 'legitimate_interests'). Covers every tenant's rows, not just the default.

BEGIN;

UPDATE data_processing_activities
   SET lawful_basis = 'legitimate_interests',
       updated_at   = NOW()
 WHERE lawful_basis IN ('medical_care', 'security');

COMMIT;
