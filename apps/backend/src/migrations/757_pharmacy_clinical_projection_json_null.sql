-- Migration 757: let the migration-753 clinical projection tolerate a JSON
-- null the way it already tolerates SQL NULL.
--
-- 753 hung the patient safety fence on bump_pharmacy_patient_safety_version_753().
-- Its UPDATE fast-path compares
--   pharmacy_patient_safety_projection_753(TG_TABLE_NAME, to_jsonb(OLD))
-- with the same projection of to_jsonb(NEW), and that projection routes the
-- medication-line columns through pharmacy_erx_clinical_projection_753().
--
-- to_jsonb() renders a SQL NULL column as the JSON null SCALAR, not as SQL
-- NULL, so `COALESCE(lines, '[]'::jsonb)` inside the projection never fires for
-- that shape and jsonb_array_elements('null'::jsonb) raises
--   22023  cannot extract elements from a scalar
-- which aborts the whole statement.
--
-- Reach: pharmacy_orders.items_list, pharmacy_orders.dispensed_medications and
-- e_prescriptions.medications are all nullable with no default, and
-- POST /pharmacy-orders/orders/place writes neither pharmacy_orders column. So
-- every order a patient placed through the product's own placement endpoint was
-- unconfirmable AND uncancellable — confirmOrder / cancelOrder answered a bare
-- 500 — and every legacy row carrying a NULL list was frozen the same way.
-- dispensed_medications alone is enough to trip it, so this covered essentially
-- the entire pharmacy order lifecycle.
--
-- This does NOT relax the fence. pharmacy_erx_clinical_projection_753 is a
-- comparison projection, not an authority guard: it grants nothing and refuses
-- nothing. Today those rows abort before the fence can be evaluated at all;
-- afterwards they reach the comparison and get the version bump they were
-- always meant to get, so the fence covers strictly MORE rows than before. "No
-- list" and "empty list" have always been the same clinical fact here — which
-- is exactly what 753's own COALESCE already says for the SQL NULL spelling.
-- Only the JSON null scalar is normalised; any other non-array scalar still
-- raises, because that would be genuinely malformed data and failing closed on
-- it is correct.
--
-- Body is otherwise byte-identical to 753's; CREATE OR REPLACE keeps the
-- owner, the ACL and every dependent trigger in place.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

CREATE OR REPLACE FUNCTION public.pharmacy_erx_clinical_projection_753(lines JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'catalog_id', value->'catalog_id',
      'original_catalog_id', value->'original_catalog_id',
      'name', value->'name',
      'medicine_name', value->'medicine_name',
      'generic_name', value->'generic_name',
      'strength', value->'strength',
      'form', value->'form',
      'dose', value->'dose',
      'dosage', value->'dosage',
      'route', value->'route',
      'frequency', value->'frequency',
      'duration', value->'duration',
      'duration_days', value->'duration_days',
      'instructions', value->'instructions',
      'quantity', value->'quantity',
      'qty', value->'qty',
      'ordered_quantity', value->'ordered_quantity',
      'order_line_index', value->'order_line_index',
      'prescription_line_index', value->'prescription_line_index'
    )) ORDER BY ordinality),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(
    COALESCE(NULLIF(lines, 'null'::jsonb), '[]'::jsonb)
  ) WITH ORDINALITY AS item(value, ordinality)
$$;

COMMIT;
