-- Seed Day Care beds 1-10 and Dialysis beds 1-4.
--
-- Idempotent: safe to run after the current bed-structure seed and safe to
-- re-run on live environments.

BEGIN;

WITH requested_wards AS (
  SELECT *
  FROM (VALUES
    ('Day Care'::text, 0::int, 10::int, 'Day Care'::text, 'day_care'::text, 'Day Care Bed'::text, 'DC'::text),
    ('Dialysis'::text, 0::int, 4::int, 'Dialysis Unit'::text, 'dialysis'::text, 'Dialysis Bed'::text, 'DIAL'::text)
  ) AS rw(name, floor, total_beds, building, bed_type, room_type, bed_prefix)
),
inserted_wards AS (
  INSERT INTO wards
    (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level, created_at, updated_at)
  SELECT rw.name, rw.floor, rw.total_beds, 'blue', 'standard', NOW(), NOW()
    FROM requested_wards rw
   WHERE NOT EXISTS (
     SELECT 1 FROM wards w WHERE LOWER(w.name) = LOWER(rw.name)
   )
  RETURNING id, name
)
UPDATE wards w
   SET floor = rw.floor,
       total_beds = rw.total_beds,
       attendant_pass_color = COALESCE(w.attendant_pass_color, 'blue'),
       attendant_pass_screening_level = COALESCE(w.attendant_pass_screening_level, 'standard'),
       updated_at = NOW()
  FROM requested_wards rw
 WHERE LOWER(w.name) = LOWER(rw.name);

WITH requested_wards AS (
  SELECT *
  FROM (VALUES
    ('Day Care'::text, 0::int, 10::int, 'Day Care'::text, 'day_care'::text, 'Day Care Bed'::text, 'DC'::text),
    ('Dialysis'::text, 0::int, 4::int, 'Dialysis Unit'::text, 'dialysis'::text, 'Dialysis Bed'::text, 'DIAL'::text)
  ) AS rw(name, floor, total_beds, building, bed_type, room_type, bed_prefix)
),
target_wards AS (
  SELECT w.id, rw.name, rw.floor, rw.total_beds, rw.building, rw.bed_type, rw.room_type, rw.bed_prefix
    FROM requested_wards rw
    JOIN wards w ON LOWER(w.name) = LOWER(rw.name)
),
seed_beds AS (
  SELECT
    tw.id AS ward_id,
    tw.name AS ward_name,
    tw.floor,
    tw.building,
    tw.bed_type,
    tw.room_type,
    tw.bed_prefix || '-' || n::text AS bed_number
  FROM target_wards tw
  CROSS JOIN LATERAL generate_series(1, tw.total_beds) AS n
)
UPDATE beds b
   SET ward_id = sb.ward_id,
       ward_name = sb.ward_name,
       floor = sb.floor,
       bed_type = sb.bed_type,
       notes = CASE
         WHEN b.patient_id IS NULL AND b.patient_uid IS NULL AND b.admission_id IS NULL THEN
           sb.building || '; floor ' || sb.floor::text || '; room type: ' || sb.room_type || '; tariff pending confirmation'
         ELSE COALESCE(b.notes, sb.building || '; floor ' || sb.floor::text || '; room type: ' || sb.room_type || '; tariff pending confirmation')
       END,
       tenant_id = COALESCE(b.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid),
       updated_at = NOW()
  FROM seed_beds sb
 WHERE LOWER(b.bed_number) = LOWER(sb.bed_number);

WITH requested_wards AS (
  SELECT *
  FROM (VALUES
    ('Day Care'::text, 0::int, 10::int, 'Day Care'::text, 'day_care'::text, 'Day Care Bed'::text, 'DC'::text),
    ('Dialysis'::text, 0::int, 4::int, 'Dialysis Unit'::text, 'dialysis'::text, 'Dialysis Bed'::text, 'DIAL'::text)
  ) AS rw(name, floor, total_beds, building, bed_type, room_type, bed_prefix)
),
target_wards AS (
  SELECT w.id, rw.name, rw.floor, rw.total_beds, rw.building, rw.bed_type, rw.room_type, rw.bed_prefix
    FROM requested_wards rw
    JOIN wards w ON LOWER(w.name) = LOWER(rw.name)
),
seed_beds AS (
  SELECT
    tw.id AS ward_id,
    tw.name AS ward_name,
    tw.floor,
    tw.building,
    tw.bed_type,
    tw.room_type,
    tw.bed_prefix || '-' || n::text AS bed_number
  FROM target_wards tw
  CROSS JOIN LATERAL generate_series(1, tw.total_beds) AS n
)
INSERT INTO beds
  (ward_id, ward_name, bed_number, status, bed_type, floor, notes, tenant_id, created_at, updated_at)
SELECT sb.ward_id,
       sb.ward_name,
       sb.bed_number,
       'available',
       sb.bed_type,
       sb.floor,
       sb.building || '; floor ' || sb.floor::text || '; room type: ' || sb.room_type || '; tariff pending confirmation',
       '00000000-0000-4000-8000-000000000001'::uuid,
       NOW(),
       NOW()
  FROM seed_beds sb
 WHERE NOT EXISTS (
   SELECT 1 FROM beds b WHERE LOWER(b.bed_number) = LOWER(sb.bed_number)
 );

WITH requested_wards AS (
  SELECT *
  FROM (VALUES
    ('Day Care'::text, 0::text, 'Day Care'::text),
    ('Dialysis'::text, 0::text, 'Dialysis Unit'::text)
  ) AS rw(name, floor, building)
)
INSERT INTO housekeeping_zones
  (name, zone_type, floor, building, is_active, created_at, updated_at)
SELECT rw.name, 'floor', rw.floor, rw.building, TRUE, NOW(), NOW()
  FROM requested_wards rw
 WHERE NOT EXISTS (
   SELECT 1
     FROM housekeeping_zones hz
    WHERE LOWER(hz.name) = LOWER(rw.name)
      AND LOWER(hz.zone_type) = 'floor'
 );

WITH requested_wards AS (
  SELECT *
  FROM (VALUES
    ('Day Care'::text, 0::text, 'Day Care'::text),
    ('Dialysis'::text, 0::text, 'Dialysis Unit'::text)
  ) AS rw(name, floor, building)
)
UPDATE housekeeping_zones hz
   SET floor = rw.floor,
       building = rw.building,
       is_active = TRUE,
       updated_at = NOW()
  FROM requested_wards rw
 WHERE LOWER(hz.name) = LOWER(rw.name)
   AND LOWER(hz.zone_type) = 'floor';

COMMIT;
