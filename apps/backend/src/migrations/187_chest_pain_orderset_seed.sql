-- 187_chest_pain_orderset_seed.sql
--
-- E-7 — chest-pain rule-out order set.
--
-- Migration 156 seeded ORDERSET-AMI-STEMI (full STEMI activation
-- bundle with cath-lab call). The ER doctor's "chest pain — could be
-- ACS, run the workup" pathway is a different, lighter bundle: serial
-- troponin, ECG q15min, basic labs, IV access, aspirin load,
-- sublingual GTN PRN. STEMI activation only fires after the workup
-- confirms.
--
-- Closes:
--   2026-05-08-emergency-walk-in-doctor-no-chest-pain-bundle
--
-- Idempotent: ON CONFLICT (code) DO NOTHING via the unique code constraint.
-- Items only seeded if the parent set was just created (FK lookup
-- returns null for existing rows so the items INSERT no-ops via the
-- WHERE NOT EXISTS guard).

BEGIN;

-- 1. Parent order set (rule-out / serial troponin protocol).
INSERT INTO clinical_order_sets (code, title, specialty, condition_codes, description)
VALUES
  ('ORDERSET-CHEST-PAIN-RULEOUT',
   'Chest pain — ACS rule-out workup',
   'emergency',
   ARRAY['R07.9', 'I20.9', 'R07.89'],
   'ER chest-pain workup. Serial troponin + ECG q15min + supportive. ' ||
   'Use ORDERSET-AMI-STEMI for confirmed STEMI activation.')
ON CONFLICT (code) DO NOTHING;

-- 2. Items for the rule-out bundle.
INSERT INTO clinical_order_set_items (order_set_id, display_order, kind, payload)
SELECT (SELECT id FROM clinical_order_sets WHERE code = 'ORDERSET-CHEST-PAIN-RULEOUT'),
       d.display_order, d.kind, d.payload::jsonb
FROM (VALUES
  (1,  'lab',     '{"test_code":"ECG12","test_name":"12-lead ECG","urgency":"stat"}'),
  (2,  'lab',     '{"test_code":"TROP","test_name":"hs-Troponin-I (baseline)","urgency":"stat"}'),
  (3,  'lab',     '{"test_code":"TROP","test_name":"hs-Troponin-I (3h serial)","urgency":"stat","scheduled_offset_min":180,"comment":"Serial repeat at +3h"}'),
  (4,  'lab',     '{"test_code":"BMP","test_name":"Basic metabolic panel","urgency":"routine"}'),
  (5,  'lab',     '{"test_code":"CBC","test_name":"Complete blood count","urgency":"routine"}'),
  (6,  'lab',     '{"test_code":"COAG","test_name":"PT/INR + aPTT","urgency":"routine"}'),
  (7,  'med',     '{"drug":"Aspirin","dose":"325mg","route":"PO chewed","frequency":"STAT","comment":"Hold if active bleeding"}'),
  (8,  'med',     '{"drug":"Glyceryl trinitrate (GTN)","dose":"0.4mg","route":"sublingual","frequency":"q5min PRN x3","prn":true,"prn_for":"chest pain","comment":"Hold if SBP <90 or RV infarct"}'),
  (9,  'nursing', '{"action":"IV access (18G antecubital)","urgency":"stat"}'),
  (10, 'nursing', '{"action":"IV NS lock","frequency":"continuous"}'),
  (11, 'monitor', '{"target":"vitals","frequency":"q15min","duration_min":60,"comment":"15-min vitals during ACS workup window"}'),
  (12, 'monitor', '{"target":"continuous_telemetry","frequency":"continuous"}'),
  (13, 'note',    '{"template":"chest_pain_reassess_15min","comment":"Reassess chest pain + ECG at 15 min"}')
) AS d(display_order, kind, payload)
WHERE EXISTS (SELECT 1 FROM clinical_order_sets WHERE code = 'ORDERSET-CHEST-PAIN-RULEOUT')
  AND NOT EXISTS (
    SELECT 1 FROM clinical_order_set_items
     WHERE order_set_id = (SELECT id FROM clinical_order_sets WHERE code = 'ORDERSET-CHEST-PAIN-RULEOUT')
  );

COMMIT;
