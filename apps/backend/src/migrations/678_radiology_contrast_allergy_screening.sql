-- 678_radiology_contrast_allergy_screening.sql
--
-- Feature wave 1 — contrast/allergy screening in radiology ordering.
--
-- Gap: radiology ordering performed no contrast or allergy screening.
-- `patient_allergies` (and the three sibling allergy stores unified by
-- allergySourceService) were never consulted anywhere under
-- services/radiology/, and contrast administration was tracked only in the
-- cath lab (`cath_contrast_radiation_records`). There was also no field on
-- `radiology_orders` (nor any radiology procedure catalog — only
-- `radiology_report_templates`, which describe reports, not orders) that even
-- recorded whether a study is a contrast study.
--
-- 1. `contrast_planned` / `contrast_agent` make the contrast intent explicit
--    on the order. When contrast is planned, order creation (and the new
--    pre-acquisition contrast-plan amendment endpoint) screens the patient's
--    unified active allergies for contrast-relevant allergens (iodinated
--    agents for CT/X-ray/fluoro/mammo, gadolinium agents for MR) — mirroring
--    the pharmacy allergy blocker in utils/clinical/prescriptionSafetyCheck.js.
--
-- 2. `contrast_allergy_screen` persists the screen evidence (matched
--    allergies, agent class, renal-risk context, screened_at) so the record
--    of what was known at ordering time survives later allergy-list edits.
--
-- 3. A hit blocks by default (409, RADIOLOGY_CONTRAST_ALLERGY_BLOCKED). The
--    acknowledged override path mirrors prescription_safety_overrides:
--    `contrast_override_reason` / `contrast_override_by` / `contrast_override_at`
--    record who accepted the risk and why. Overrides and findings also land in
--    `medication_safety_reviews` (platform safety-finding vehicle, canonical
--    clinical timeline invariant) via recordMedicationSafetyReviews.

ALTER TABLE radiology_orders
  ADD COLUMN IF NOT EXISTS contrast_planned         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS contrast_agent           VARCHAR(120),
  ADD COLUMN IF NOT EXISTS contrast_allergy_screen  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS contrast_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS contrast_override_by     UUID,
  ADD COLUMN IF NOT EXISTS contrast_override_at     TIMESTAMPTZ;

COMMENT ON COLUMN radiology_orders.contrast_planned IS
  'TRUE when the study is planned with contrast administration; gates the pre-order allergy screen.';
COMMENT ON COLUMN radiology_orders.contrast_agent IS
  'Planned contrast agent free text (e.g. iohexol, gadobutrol). Only meaningful when contrast_planned.';
COMMENT ON COLUMN radiology_orders.contrast_allergy_screen IS
  'Evidence of the contrast allergy screen at ordering/amendment time: {screened_at, agent_class, blockers[], warnings[], renal{}}. Immutable record of what was known when the order was placed.';
COMMENT ON COLUMN radiology_orders.contrast_override_reason IS
  'Ordering clinician''s acknowledged-override reason when proceeding despite a contrast-relevant allergy blocker (mirrors prescription_safety_overrides.reason).';
COMMENT ON COLUMN radiology_orders.contrast_override_by IS
  'UID of the user who acknowledged the contrast allergy override.';
COMMENT ON COLUMN radiology_orders.contrast_override_at IS
  'When the contrast allergy override was acknowledged.';

-- A named agent only makes sense on a contrast study.
ALTER TABLE radiology_orders
  ADD CONSTRAINT chk_radiology_contrast_agent_implies_planned
  CHECK (contrast_agent IS NULL OR contrast_planned);

-- Override fields travel together: reason + who + when are all set or all
-- NULL, and an override can only exist on a contrast study.
ALTER TABLE radiology_orders
  ADD CONSTRAINT chk_radiology_contrast_override_paired
  CHECK (
    (contrast_override_reason IS NULL
       AND contrast_override_by IS NULL
       AND contrast_override_at IS NULL)
    OR (contrast_override_reason IS NOT NULL
       AND contrast_override_by IS NOT NULL
       AND contrast_override_at IS NOT NULL
       AND contrast_planned)
  );

-- Worklist/QA surface: contrast studies with an acknowledged override are the
-- rows a radiology safety huddle reviews.
CREATE INDEX IF NOT EXISTS idx_radiology_orders_contrast_override
  ON radiology_orders (tenant_id, created_at DESC)
  WHERE contrast_override_at IS NOT NULL;
