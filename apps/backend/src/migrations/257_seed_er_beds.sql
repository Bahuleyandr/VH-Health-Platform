-- Seed ER bed board beds 1-10.
--
-- Idempotent: safe to run after the current A/B block seed and safe to
-- re-run on live environments.

BEGIN;

WITH er_ward AS (
  INSERT INTO wards
    (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level, created_at, updated_at)
  SELECT 'ER', 0, 10, 'orange', 'strict', NOW(), NOW()
  WHERE NOT EXISTS (
    SELECT 1 FROM wards WHERE LOWER(name) = 'er'
  )
  RETURNING id
),
existing_er AS (
  SELECT id FROM wards WHERE LOWER(name) = 'er'
),
ward_upsert AS (
  UPDATE wards
     SET floor = 0,
         total_beds = 10,
         attendant_pass_color = COALESCE(attendant_pass_color, 'orange'),
         attendant_pass_screening_level = 'strict',
         updated_at = NOW()
   WHERE LOWER(name) = 'er'
   RETURNING id
),
target_ward AS (
  SELECT id FROM ward_upsert
  UNION
  SELECT id FROM er_ward
  UNION
  SELECT id FROM existing_er
  LIMIT 1
),
seed_beds AS (
  SELECT
    'ER-' || n::text AS bed_number,
    n AS sort_order
  FROM generate_series(1, 10) AS n
)
UPDATE beds b
   SET ward_id = tw.id,
       ward_name = 'ER',
       floor = 0,
       bed_type = 'er',
       notes = CASE
         WHEN b.patient_id IS NULL AND b.patient_uid IS NULL AND b.admission_id IS NULL THEN
           'Emergency; floor 0; room type: Emergency Bed; tariff pending confirmation'
         ELSE COALESCE(b.notes, 'Emergency; floor 0; room type: Emergency Bed; tariff pending confirmation')
       END,
       tenant_id = COALESCE(b.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid),
       updated_at = NOW()
  FROM seed_beds sb
  CROSS JOIN target_ward tw
 WHERE LOWER(b.bed_number) = LOWER(sb.bed_number);

WITH target_ward AS (
  SELECT id FROM wards WHERE LOWER(name) = 'er' LIMIT 1
),
seed_beds AS (
  SELECT 'ER-' || n::text AS bed_number
  FROM generate_series(1, 10) AS n
)
INSERT INTO beds
  (ward_id, ward_name, bed_number, status, bed_type, floor, notes, tenant_id, created_at, updated_at)
SELECT tw.id,
       'ER',
       sb.bed_number,
       'available',
       'er',
       0,
       'Emergency; floor 0; room type: Emergency Bed; tariff pending confirmation',
       '00000000-0000-4000-8000-000000000001'::uuid,
       NOW(),
       NOW()
  FROM seed_beds sb
  CROSS JOIN target_ward tw
 WHERE NOT EXISTS (
   SELECT 1 FROM beds b WHERE LOWER(b.bed_number) = LOWER(sb.bed_number)
 );

INSERT INTO housekeeping_zones
  (name, zone_type, floor, building, is_active, created_at, updated_at)
SELECT 'ER', 'floor', '0', 'Emergency', TRUE, NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1
    FROM housekeeping_zones
   WHERE LOWER(name) = 'er'
     AND LOWER(zone_type) = 'floor'
);

UPDATE housekeeping_zones
   SET floor = '0',
       building = 'Emergency',
       is_active = TRUE,
       updated_at = NOW()
 WHERE LOWER(name) = 'er'
   AND LOWER(zone_type) = 'floor';

COMMIT;
