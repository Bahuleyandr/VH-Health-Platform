-- Harden operational forecast prerequisites used by the Clinical AI forecast workbench.

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS expected_los_days INTEGER;

CREATE INDEX IF NOT EXISTS idx_admissions_status_ward_admitted
  ON admissions (status, ward, admitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_orders_medication_created
  ON clinical_orders (order_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_uid_tenant
  ON users (uid, tenant_id);
