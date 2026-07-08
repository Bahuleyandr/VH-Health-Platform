-- 415_ophthalmology_linkage_catalog.sql
--
-- N6-7 ophthalmology completion: link structured eye exams to OP visits and
-- seed ophthalmic investigations plus the cataract pre-op order-set bundle.

BEGIN;

ALTER TABLE ophthalmic_exams
  ADD COLUMN IF NOT EXISTS encounter_id UUID,
  ADD COLUMN IF NOT EXISTS appointment_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ophthalmic_exams_encounter'
  ) THEN
    ALTER TABLE ophthalmic_exams
      ADD CONSTRAINT fk_ophthalmic_exams_encounter
      FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ophthalmic_exams_appointment'
  ) THEN
    ALTER TABLE ophthalmic_exams
      ADD CONSTRAINT fk_ophthalmic_exams_appointment
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_ophthalmic_exams_tenant_encounter
  ON ophthalmic_exams (tenant_id, encounter_id)
  WHERE encounter_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ophthalmic_exams_tenant_appointment
  ON ophthalmic_exams (tenant_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

INSERT INTO investigation_test_catalog
  (name, code, category, description, default_cost, turnaround_hours,
   requires_fasting, patient_instructions, sample_type, is_active, updated_at)
VALUES
  ('Ophthalmic Biometry', 'OPH-BIOMETRY', 'Ophthalmology',
   'Axial length, keratometry and IOL calculation measurements recorded for cataract workup.',
   1200.00, 4, false, 'Bring prior glasses prescription and cataract notes if available.', 'ophthalmic_measurement', true, NOW()),
  ('Keratometry', 'OPH-KERATOMETRY', 'Ophthalmology',
   'Corneal curvature measurements for refractive and cataract planning.',
   500.00, 4, false, 'Avoid contact lenses as advised before the test.', 'ophthalmic_measurement', true, NOW()),
  ('Visual Field Test', 'OPH-VISUAL-FIELDS', 'Ophthalmology',
   'Automated perimetry / visual field assessment for glaucoma and neuro-ophthalmology follow-up.',
   900.00, 24, false, 'Bring current spectacles. The test may take several minutes per eye.', 'ophthalmic_function', true, NOW()),
  ('Optical Coherence Tomography', 'OPH-OCT', 'Ophthalmology',
   'Retina or optic nerve OCT imaging as an orderable ophthalmic investigation.',
   1500.00, 24, false, 'Pupil dilation may be required depending on clinical instruction.', 'ophthalmic_imaging', true, NOW())
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  default_cost = EXCLUDED.default_cost,
  turnaround_hours = EXCLUDED.turnaround_hours,
  requires_fasting = EXCLUDED.requires_fasting,
  patient_instructions = EXCLUDED.patient_instructions,
  sample_type = EXCLUDED.sample_type,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

INSERT INTO clinical_order_sets
  (tenant_id, code, title, specialty, condition_codes, description,
   active, status, source, family_key, version, approved_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000001'::uuid,
   'ORDERSET-CATARACT-PREOP',
   'Cataract pre-operative workup',
   'ophthalmology',
   ARRAY['H25.9', 'H26.9'],
   'Recorded-not-computed cataract workup bundle: biometry, keratometry, IOP review, OCT/visual fields when clinically indicated, and theatre readiness review.',
   true, 'approved', 'authored', 'cataract-preop', 1, NOW(), NOW())
ON CONFLICT (tenant_id, code) DO UPDATE SET
  title = EXCLUDED.title,
  specialty = EXCLUDED.specialty,
  condition_codes = EXCLUDED.condition_codes,
  description = EXCLUDED.description,
  active = EXCLUDED.active,
  status = EXCLUDED.status,
  source = EXCLUDED.source,
  family_key = EXCLUDED.family_key,
  version = EXCLUDED.version,
  approved_at = COALESCE(clinical_order_sets.approved_at, EXCLUDED.approved_at),
  updated_at = NOW();

INSERT INTO clinical_order_set_items (order_set_id, display_order, kind, payload)
SELECT os.id, item.display_order, item.kind, item.payload::jsonb
FROM clinical_order_sets os
JOIN (VALUES
  (1, 'lab', '{"test_code":"OPH-BIOMETRY","test_name":"Ophthalmic Biometry","urgency":"routine","notes":"Record axial length, K-readings and selected IOL power; do not auto-compute in v1."}'),
  (2, 'lab', '{"test_code":"OPH-KERATOMETRY","test_name":"Keratometry","urgency":"routine"}'),
  (3, 'lab', '{"test_code":"OPH-OCT","test_name":"Optical Coherence Tomography","urgency":"routine","default_selected":false}'),
  (4, 'lab', '{"test_code":"OPH-VISUAL-FIELDS","test_name":"Visual Field Test","urgency":"routine","default_selected":false}'),
  (5, 'nursing', '{"label":"Confirm operated eye laterality and site mark before OT-ready"}'),
  (6, 'other', '{"label":"Cataract OT readiness review","soft_warning":"Biometry should be recorded before OT-ready for cataract-coded procedures."}')
) AS item(display_order, kind, payload)
  ON os.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 AND os.code = 'ORDERSET-CATARACT-PREOP'
WHERE NOT EXISTS (
  SELECT 1
    FROM clinical_order_set_items existing
   WHERE existing.order_set_id = os.id
     AND existing.display_order = item.display_order
     AND existing.kind = item.kind
);

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'OPHTHALMOLOGY_LINKAGE_CATALOG_APPLIED',
  'ophthalmic_exams',
  '415',
  jsonb_build_object(
    'migration', '415_ophthalmology_linkage_catalog.sql',
    'scope', 'exam encounter/appointment linkage, eye-test catalog seeds, cataract pre-op order set'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'OPHTHALMOLOGY_LINKAGE_CATALOG_APPLIED'
    AND resource = 'ophthalmic_exams'
    AND resource_id = '415'
);

COMMIT;
