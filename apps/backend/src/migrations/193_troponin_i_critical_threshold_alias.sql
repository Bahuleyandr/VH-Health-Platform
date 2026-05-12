-- Migration 193: Troponin-I critical threshold alias.
-- (Renumbered from 192 on cherry-pick — main already had 192_bed_cleaning_status.sql.)
--
-- Emergency and catalog flows use TROPI / LOINC 10839-9 for high-sensitivity
-- Troponin-I, while the original critical-threshold seed only covered TROP /
-- LOINC 6598-7. Keep both codes classified as the same critical cardiac marker.
--
-- Finding: 2026-05-12-emergency-walk-in-lab-tech-ecf47272.

BEGIN;

UPDATE lab_critical_thresholds
   SET critical_high = COALESCE(critical_high, 0.04),
       unit = COALESCE(unit, 'ng/mL'),
       updated_at = NOW()
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
   AND is_active = true
   AND (loinc_code = '10839-9' OR UPPER(test_code) = 'TROPI')
   AND critical_high IS NULL;

INSERT INTO lab_critical_thresholds
  (tenant_id, loinc_code, test_code, test_name, unit, critical_low, critical_high, source, notes)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  '10839-9',
  'TROPI',
  'Troponin I',
  'ng/mL',
  NULL::NUMERIC,
  0.04::NUMERIC,
  'cap',
  'Above 0.04 ng/mL suggests AMI; TROPI / hs-Troponin-I alias.'
WHERE NOT EXISTS (
  SELECT 1
    FROM lab_critical_thresholds
   WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
     AND is_active = true
     AND (loinc_code = '10839-9' OR UPPER(test_code) = 'TROPI')
);

UPDATE lab_reference_ranges
   SET critical_high = COALESCE(critical_high, range_high, 0.04),
       updated_at = NOW()
 WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
   AND is_active = true
   AND (loinc_code = '10839-9' OR UPPER(test_code) = 'TROPI')
   AND critical_high IS NULL;

COMMIT;
