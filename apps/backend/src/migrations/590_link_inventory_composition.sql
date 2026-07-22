-- 586_link_inventory_composition.sql
--
-- Link the pharmacy SKU/inventory layer to the composition + catalog layer.
-- `pharmacy_inventory_items` (mig 123) is a facility-level SKU master keyed only by
-- free-text sku_code / generic_name strings; it has no structured tie to
-- `drug_compositions` (mig 350, the parsed active-ingredient model) or to
-- `pharmacy_catalog` (the priced formulary row, itself composition-linked in mig 350).
--
-- Without this link the substitution "alternatives" endpoint cannot answer "is an
-- equivalent brand actually on the shelf?" from real batch stock — it falls back to
-- coarse pharmacy_catalog flags. Adding composition_id lets availability be computed as
-- a live SUM over pharmacy_inventory_batches for the whole interchangeable group;
-- catalog_id supports brand-exact stock when needed.
--
-- Additive + nullable. Existing rows are NOT backfilled here — matching SKUs to
-- compositions/catalog needs resolver logic that does not belong in DDL; new inserts
-- set them forward and a separate ticket can backfill history.
--
-- pharmacy_inventory_items is already tenant-RLS-enabled (mig 304), and RLS policies
-- are row filters (not column filters), so adding nullable columns is transparently
-- covered by the existing tenant_isolation policy — no ENABLE/FORCE/POLICY re-statement.

BEGIN;

ALTER TABLE pharmacy_inventory_items
  ADD COLUMN IF NOT EXISTS composition_id INTEGER REFERENCES drug_compositions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS catalog_id     INTEGER REFERENCES pharmacy_catalog(id)  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pharmacy_items_composition
  ON pharmacy_inventory_items(composition_id)
  WHERE composition_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pharmacy_items_catalog
  ON pharmacy_inventory_items(catalog_id)
  WHERE catalog_id IS NOT NULL;

COMMIT;
