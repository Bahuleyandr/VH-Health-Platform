-- 186_ecg_catalog_seed.sql
--
-- E-6 — seed ECG (and other commonly-ordered cardiology) entries
-- into investigation_test_catalog. ECG was missing from the seeded
-- catalog so doctors typed "ECG" / "EKG" / "12-lead ECG" / "ECG 12
-- lead" all as different free-text strings, breaking door-to-ECG
-- analytics.
--
-- Finding: 2026-05-08-emergency-walk-in-doctor-catalog-no-ecg-free-text-bypass.
--
-- Idempotent: ON CONFLICT (name, COALESCE(code, '')) DO NOTHING-style
-- guard via WHERE NOT EXISTS, since the table doesn't have a unique
-- constraint on (name, code). New rows only.

BEGIN;

INSERT INTO investigation_test_catalog
  (name, code, category, normal_range, unit, default_cost,
   turnaround_hours, requires_fasting, patient_instructions, description, is_active)
SELECT v.name, v.code, v.category, v.normal_range, v.unit, v.cost,
       v.tat, v.fasting, v.instr, v.descr, true
  FROM (VALUES
    ('12-lead ECG',           'ECG12',  'CARDIOLOGY', 'NSR; rate 60-100',
     NULL, 250, 1, false,
     'Lie still on the bed; remove metal jewelry from the chest area.',
     '12-lead resting electrocardiogram. Standard cardiac evaluation.'),
    ('15-lead ECG',           'ECG15',  'CARDIOLOGY', 'NSR; rate 60-100',
     NULL, 320, 1, false,
     'Lie still on the bed; additional posterior leads.',
     '15-lead ECG with right and posterior chest leads. For posterior MI workup.'),
    ('Rhythm strip',          'ECGRHY', 'CARDIOLOGY', NULL,
     NULL, 150, 1, false,
     'Brief lead-II tracing.',
     'Single-lead rhythm strip for arrhythmia identification.'),
    ('Holter (24h)',          'HOLTER24','CARDIOLOGY', NULL,
     NULL, 1800, 24, false,
     '24-hour ambulatory monitoring; resume normal activity.',
     '24-hour Holter monitor. Patient returns the next day for analysis.'),
    ('Stress ECG (TMT)',      'TMT',    'CARDIOLOGY', NULL,
     NULL, 1500, 2, true,
     'Light meal 2h prior; comfortable shoes; bring inhaler if applicable.',
     'Treadmill exercise stress test. Bruce protocol unless otherwise specified.')
  ) AS v(name, code, category, normal_range, unit, cost, tat, fasting, instr, descr)
WHERE NOT EXISTS (
  SELECT 1 FROM investigation_test_catalog t
   WHERE LOWER(t.name) = LOWER(v.name)
      OR (t.code IS NOT NULL AND LOWER(t.code) = LOWER(v.code))
);

COMMIT;
