-- 246_radiology_tech_license_capture.sql
--
-- D51 — radiology acquisition traceability. The acquisition row already
-- captures the technologist UID/name, but the chain of custody had no
-- durable license/registration field. Add a nullable column so existing
-- sites keep working while mapped HPR/staff data can be stamped at acquire.

BEGIN;

ALTER TABLE radiology_orders
  ADD COLUMN IF NOT EXISTS tech_license_number VARCHAR(120);

COMMIT;
