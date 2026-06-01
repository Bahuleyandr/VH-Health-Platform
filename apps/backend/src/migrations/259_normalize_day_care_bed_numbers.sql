-- Normalize legacy Day Care demo beds into the current DC-1..DC-10 range.
--
-- Some live environments already have occupied DC-001/DC-002/DC-003 rows.
-- Preserve those bed IDs and admissions while moving the visible labels to
-- the canonical Day Care numbering requested for the bed board.

BEGIN;

WITH day_care_ward AS (
  SELECT id FROM wards WHERE LOWER(name) = 'day care' LIMIT 1
),
renamed AS (
  UPDATE beds b
     SET bed_number = regexp_replace(b.bed_number, '^DC-0+([1-9][0-9]*)$', 'DC-\1', 'i'),
         ward_id = COALESCE(b.ward_id, (SELECT id FROM day_care_ward)),
         ward_name = 'Day Care',
         floor = 0,
         bed_type = 'day_care',
         updated_at = NOW()
   WHERE b.bed_number ~* '^DC-0+[1-9][0-9]*$'
     AND NOT EXISTS (
       SELECT 1
         FROM beds other
        WHERE other.id <> b.id
          AND LOWER(other.bed_number) = LOWER(regexp_replace(b.bed_number, '^DC-0+([1-9][0-9]*)$', 'DC-\1', 'i'))
     )
  RETURNING b.id, b.bed_number AS new_bed_number
),
old_numbers AS (
  SELECT id,
         'DC-' || LPAD(regexp_replace(new_bed_number, '\D', '', 'g'), 3, '0') AS old_bed_number,
         new_bed_number
    FROM renamed
)
UPDATE admissions a
   SET bed_number = o.new_bed_number,
       ward = COALESCE(NULLIF(a.ward, ''), 'Day Care'),
       updated_at = NOW()
  FROM old_numbers o
 WHERE a.bed_id = o.id
   AND (a.bed_number = o.old_bed_number OR a.bed_number IS NULL);

UPDATE wards
   SET floor = 0,
       total_beds = 10,
       attendant_pass_screening_level = COALESCE(attendant_pass_screening_level, 'standard'),
       updated_at = NOW()
 WHERE LOWER(name) = 'day care';

WITH target_ward AS (
  SELECT id FROM wards WHERE LOWER(name) = 'day care' LIMIT 1
),
seed_beds AS (
  SELECT 'DC-' || n::text AS bed_number
    FROM generate_series(1, 10) AS n
)
INSERT INTO beds
  (ward_id, ward_name, bed_number, status, bed_type, floor, notes, tenant_id, created_at, updated_at)
SELECT tw.id,
       'Day Care',
       sb.bed_number,
       'available',
       'day_care',
       0,
       'Day Care; floor 0; room type: Day Care Bed; tariff pending confirmation',
       '00000000-0000-4000-8000-000000000001'::uuid,
       NOW(),
       NOW()
  FROM seed_beds sb
  CROSS JOIN target_ward tw
 WHERE NOT EXISTS (
   SELECT 1 FROM beds b WHERE LOWER(b.bed_number) = LOWER(sb.bed_number)
 );

COMMIT;
