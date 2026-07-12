-- NL-13 P1d: reuse the existing patient implant registry for cath implants.
-- OT implants retain their ot_schedule_id source; cath implants point to their
-- case and originating usage row instead of creating a parallel registry.

ALTER TABLE surgical_implants
  ADD COLUMN IF NOT EXISTS cath_case_id BIGINT,
  ADD COLUMN IF NOT EXISTS cath_usage_id BIGINT;

ALTER TABLE surgical_implants
  ALTER COLUMN ot_schedule_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_surgical_implants_cath_case'
       AND conrelid = 'surgical_implants'::regclass
  ) THEN
    ALTER TABLE surgical_implants
      ADD CONSTRAINT fk_surgical_implants_cath_case
      FOREIGN KEY (cath_case_id) REFERENCES cath_lab_cases(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_surgical_implants_cath_usage'
       AND conrelid = 'surgical_implants'::regclass
  ) THEN
    ALTER TABLE surgical_implants
      ADD CONSTRAINT fk_surgical_implants_cath_usage
      FOREIGN KEY (cath_usage_id) REFERENCES cath_case_consumable_usage(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_surgical_implants_cath_origin_tenant'
       AND conrelid = 'surgical_implants'::regclass
  ) THEN
    ALTER TABLE surgical_implants
      ADD CONSTRAINT fk_surgical_implants_cath_origin_tenant
      FOREIGN KEY (tenant_id, cath_usage_id, cath_case_id, patient_uid)
      REFERENCES cath_case_consumable_usage (tenant_id, id, case_id, patient_uid)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'surgical_implants_source_check'
       AND conrelid = 'surgical_implants'::regclass
  ) THEN
    ALTER TABLE surgical_implants
      ADD CONSTRAINT surgical_implants_source_check
      CHECK (num_nonnulls(ot_schedule_id, cath_case_id) = 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'surgical_implants_cath_link_check'
       AND conrelid = 'surgical_implants'::regclass
  ) THEN
    ALTER TABLE surgical_implants
      ADD CONSTRAINT surgical_implants_cath_link_check
      CHECK (
        (cath_case_id IS NULL AND cath_usage_id IS NULL)
        OR (cath_case_id IS NOT NULL AND cath_usage_id IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'surgical_implants_cath_patient_check'
       AND conrelid = 'surgical_implants'::regclass
  ) THEN
    ALTER TABLE surgical_implants
      ADD CONSTRAINT surgical_implants_cath_patient_check
      CHECK (cath_case_id IS NULL OR patient_uid IS NOT NULL);
  END IF;
END $$;

DROP INDEX IF EXISTS ux_surgical_implants_cath_usage;
CREATE UNIQUE INDEX ux_surgical_implants_cath_usage
  ON surgical_implants (tenant_id, cath_usage_id, cath_case_id, patient_uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_surgical_implants_cath_usage_id
  ON surgical_implants (cath_usage_id)
  WHERE cath_usage_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_surgical_implants_cath_case
  ON surgical_implants (tenant_id, cath_case_id, status)
  WHERE cath_case_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_stock_movements_cath_usage
  ON pharmacy_stock_movements (
    tenant_id, reference_type, reference_id, COALESCE(inventory_batch_id, 0)
  )
  WHERE reference_type = 'cath_consumable_usage' AND reference_id IS NOT NULL;
