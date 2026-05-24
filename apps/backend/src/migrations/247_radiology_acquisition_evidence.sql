-- 247_radiology_acquisition_evidence.sql
--
-- D53 - radiology acquisition must carry PACS/image evidence. The tech
-- action should not be able to move an order to "acquired" without a
-- durable pointer to the captured study or uploaded image package.

BEGIN;

ALTER TABLE radiology_orders
  ADD COLUMN IF NOT EXISTS pacs_study_instance_uid VARCHAR(200),
  ADD COLUMN IF NOT EXISTS acquisition_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_radiology_orders_pacs_study_uid
  ON radiology_orders(pacs_study_instance_uid)
  WHERE pacs_study_instance_uid IS NOT NULL;

COMMIT;
