-- Current VH bed structure from the A/B block room lists.
--
-- Wards are block/floor units so Bed Board, housekeeping zones, and roster
-- deployment all target the same operational areas. Per-room tariff/class is
-- carried on beds.bed_type + beds.notes until a dedicated tariff table exists.

BEGIN;

CREATE TEMP TABLE vh_current_bed_seed (
  ward_name TEXT NOT NULL,
  floor INTEGER NOT NULL,
  building TEXT NOT NULL,
  bed_number TEXT NOT NULL,
  bed_type TEXT NOT NULL,
  room_type TEXT NOT NULL,
  tariff INTEGER
) ON COMMIT DROP;

INSERT INTO vh_current_bed_seed
  (ward_name, floor, building, bed_number, bed_type, room_type, tariff)
VALUES
  ('A Block - Floor III', 3, 'A Block', 'A-301', 'single_non_ac', 'Single Non A/C', 4500),
  ('A Block - Floor III', 3, 'A Block', 'A-302', 'unclassified', 'Handwritten floor list - tariff pending', NULL),
  ('A Block - Floor III', 3, 'A Block', 'A-303', 'general_ward', 'General Ward', 2500),
  ('A Block - Floor III', 3, 'A Block', 'A-304A', 'general_ward', 'General Ward', 2500),
  ('A Block - Floor III', 3, 'A Block', 'A-304B', 'general_ward', 'General Ward', 2500),
  ('A Block - Floor III', 3, 'A Block', 'A-305', 'general_ward', 'General Ward', 2500),
  ('A Block - Floor III', 3, 'A Block', 'A-306', 'general_ward', 'General Ward', 2500),
  ('A Block - Floor III', 3, 'A Block', 'A-307', 'general_ward', 'General Ward', 2500),
  ('A Block - Floor III', 3, 'A Block', 'A-308', 'general_ward', 'General Ward', 2500),
  ('A Block - Floor III', 3, 'A Block', 'A-309', 'single_non_ac', 'Single Non A/C', 4500),
  ('A Block - Floor III', 3, 'A Block', 'A-310A', 'twin_sharing_ac', 'Twin Sharing A/C', 4500),
  ('A Block - Floor III', 3, 'A Block', 'A-310B', 'twin_sharing_ac', 'Twin Sharing A/C', 4500),
  ('A Block - Floor III', 3, 'A Block', 'A-311A', 'neonatal', 'Neonatal', 7500),
  ('A Block - Floor III', 3, 'A Block', 'A-311B', 'neonatal', 'Neonatal', 7500),
  ('A Block - Floor III', 3, 'A Block', 'A-311C', 'neonatal', 'Neonatal', 7500),
  ('A Block - Floor IV', 4, 'A Block', 'A-401', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor IV', 4, 'A Block', 'A-402', 'single_non_ac', 'Single Non A/C', 4500),
  ('A Block - Floor IV', 4, 'A Block', 'A-403', 'single_non_ac', 'Single Non A/C', 4500),
  ('A Block - Floor IV', 4, 'A Block', 'A-404', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor IV', 4, 'A Block', 'A-405', 'single_non_ac', 'Single Non A/C', 4500),
  ('A Block - Floor IV', 4, 'A Block', 'A-406A', 'twin_sharing_non_ac', 'Twin Sharing Non A/C', 3500),
  ('A Block - Floor IV', 4, 'A Block', 'A-406B', 'twin_sharing_non_ac', 'Twin Sharing Non A/C', 3500),
  ('A Block - Floor IV', 4, 'A Block', 'A-407', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor IV', 4, 'A Block', 'A-408', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor IV', 4, 'A Block', 'A-409', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor IV', 4, 'A Block', 'A-410', 'deluxe_ac', 'Deluxe A/C', 7500),
  ('A Block - Floor V', 5, 'A Block', 'A-501', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor V', 5, 'A Block', 'A-502', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor V', 5, 'A Block', 'A-503', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor V', 5, 'A Block', 'A-504', 'deluxe_ac', 'Deluxe A/C', 7500),
  ('A Block - Floor V', 5, 'A Block', 'A-505', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor V', 5, 'A Block', 'A-506A', 'twin_sharing_ac', 'Twin Sharing A/C', 4500),
  ('A Block - Floor V', 5, 'A Block', 'A-506B', 'twin_sharing_ac', 'Twin Sharing A/C', 4500),
  ('A Block - Floor V', 5, 'A Block', 'A-507', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor V', 5, 'A Block', 'A-508', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor V', 5, 'A Block', 'A-509', 'single_ac', 'Single A/C', 6500),
  ('A Block - Floor V', 5, 'A Block', 'A-510', 'deluxe_ac', 'Deluxe A/C', 7500),
  ('B Block - ICU', 1, 'B Block', 'B-101', 'icu_secluded', 'ICU / Secluded', 20000),
  ('B Block - ICU', 1, 'B Block', 'B-102', 'icu_secluded', 'ICU / Secluded', 20000),
  ('B Block - ICU', 1, 'B Block', 'B-103', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-104', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-105', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-106', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-107', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-108', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-109', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-110', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-111', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-112', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-113', 'icu', 'ICU', 15000),
  ('B Block - ICU', 1, 'B Block', 'B-114', 'icu', 'ICU', 15000),
  ('B Block - Floor II', 2, 'B Block', 'B-202', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor II', 2, 'B Block', 'B-203', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor II', 2, 'B Block', 'B-204', 'suite', 'Suite Room', 14500),
  ('B Block - Floor II', 2, 'B Block', 'B-205', 'single_ac', 'Single A/C', 6500),
  ('B Block - Floor II', 2, 'B Block', 'B-206', 'single_ac', 'Single A/C', 6500),
  ('B Block - Floor II', 2, 'B Block', 'B-207', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor II', 2, 'B Block', 'B-208', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor II', 2, 'B Block', 'B-209', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor II', 2, 'B Block', 'B-211', 'super_deluxe', 'Super Deluxe', 8500),
  ('B Block - Floor II', 2, 'B Block', 'B-212', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor III', 3, 'B Block', 'B-301', 'suite', 'Suite Room', 14500),
  ('B Block - Floor III', 3, 'B Block', 'B-302', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor III', 3, 'B Block', 'B-303', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor III', 3, 'B Block', 'B-304', 'unclassified', 'Handwritten floor list - tariff pending', NULL),
  ('B Block - Floor III', 3, 'B Block', 'B-305', 'unclassified', 'Handwritten floor list - tariff pending', NULL),
  ('B Block - Floor III', 3, 'B Block', 'B-306', 'unclassified', 'Handwritten floor list - tariff pending', NULL),
  ('B Block - Floor III', 3, 'B Block', 'B-307', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor III', 3, 'B Block', 'B-308', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor III', 3, 'B Block', 'B-309', 'deluxe', 'Deluxe', 7500),
  ('B Block - Floor III', 3, 'B Block', 'B-310', 'unclassified', 'Handwritten floor list - tariff pending', NULL),
  ('B Block - Floor III', 3, 'B Block', 'B-311', 'suite', 'Suite Room', 14500),
  ('B Block - Floor III', 3, 'B Block', 'B-312', 'deluxe', 'Deluxe', 7500);

WITH seed_wards AS (
  SELECT ward_name, floor, COUNT(*)::int AS total_beds
    FROM vh_current_bed_seed
   GROUP BY ward_name, floor
)
UPDATE wards w
   SET floor = sw.floor,
       total_beds = sw.total_beds,
       attendant_pass_screening_level = CASE
         WHEN LOWER(sw.ward_name) LIKE '%icu%' THEN 'strict'
         ELSE COALESCE(w.attendant_pass_screening_level, 'standard')
       END,
       updated_at = NOW()
  FROM seed_wards sw
 WHERE LOWER(w.name) = LOWER(sw.ward_name);

WITH seed_wards AS (
  SELECT ward_name, floor, COUNT(*)::int AS total_beds
    FROM vh_current_bed_seed
   GROUP BY ward_name, floor
)
INSERT INTO wards
  (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level, created_at, updated_at)
SELECT sw.ward_name,
       sw.floor,
       sw.total_beds,
       CASE WHEN LOWER(sw.ward_name) LIKE '%icu%' THEN 'red' ELSE 'blue' END,
       CASE WHEN LOWER(sw.ward_name) LIKE '%icu%' THEN 'strict' ELSE 'standard' END,
       NOW(),
       NOW()
  FROM seed_wards sw
 WHERE NOT EXISTS (
   SELECT 1 FROM wards w WHERE LOWER(w.name) = LOWER(sw.ward_name)
 );

UPDATE beds b
   SET ward_id = w.id,
       ward_name = s.ward_name,
       floor = s.floor,
       bed_type = s.bed_type,
       notes = CASE
         WHEN b.patient_id IS NULL AND b.patient_uid IS NULL AND b.admission_id IS NULL THEN
           s.building || '; floor ' || s.floor::text || '; room type: ' || s.room_type ||
           CASE WHEN s.tariff IS NOT NULL THEN '; tariff: Rs.' || s.tariff::text || '/day' ELSE '; tariff pending confirmation' END
         ELSE COALESCE(b.notes,
           s.building || '; floor ' || s.floor::text || '; room type: ' || s.room_type ||
           CASE WHEN s.tariff IS NOT NULL THEN '; tariff: Rs.' || s.tariff::text || '/day' ELSE '; tariff pending confirmation' END)
       END,
       tenant_id = COALESCE(b.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid),
       updated_at = NOW()
  FROM vh_current_bed_seed s
  JOIN wards w ON LOWER(w.name) = LOWER(s.ward_name)
 WHERE LOWER(b.bed_number) = LOWER(s.bed_number);

INSERT INTO beds
  (ward_id, ward_name, bed_number, status, bed_type, floor, notes, tenant_id, created_at, updated_at)
SELECT w.id,
       s.ward_name,
       s.bed_number,
       'available',
       s.bed_type,
       s.floor,
       s.building || '; floor ' || s.floor::text || '; room type: ' || s.room_type ||
         CASE WHEN s.tariff IS NOT NULL THEN '; tariff: Rs.' || s.tariff::text || '/day' ELSE '; tariff pending confirmation' END,
       '00000000-0000-4000-8000-000000000001'::uuid,
       NOW(),
       NOW()
  FROM vh_current_bed_seed s
  JOIN wards w ON LOWER(w.name) = LOWER(s.ward_name)
 WHERE NOT EXISTS (
   SELECT 1 FROM beds b WHERE LOWER(b.bed_number) = LOWER(s.bed_number)
 );

INSERT INTO housekeeping_zones
  (name, zone_type, floor, building, is_active, created_at, updated_at)
SELECT DISTINCT s.ward_name, 'floor', s.floor::text, s.building, TRUE, NOW(), NOW()
  FROM vh_current_bed_seed s
 WHERE NOT EXISTS (
   SELECT 1
     FROM housekeeping_zones hz
    WHERE LOWER(hz.name) = LOWER(s.ward_name)
      AND LOWER(hz.zone_type) = 'floor'
 );

UPDATE housekeeping_zones hz
   SET floor = s.floor::text,
       building = s.building,
       is_active = TRUE,
       updated_at = NOW()
  FROM (
    SELECT DISTINCT ward_name, floor, building FROM vh_current_bed_seed
  ) s
 WHERE LOWER(hz.name) = LOWER(s.ward_name)
   AND LOWER(hz.zone_type) = 'floor';

DELETE FROM beds b
  USING wards w
 WHERE b.ward_id = w.id
   AND LOWER(w.name) = ANY(ARRAY[
     'general ward', 'icu', 'ccu', 'semi-private', 'private', 'deluxe', 'day care'
   ])
   AND b.patient_id IS NULL
   AND b.patient_uid IS NULL
   AND b.admission_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM admissions a WHERE a.bed_id = b.id AND a.discharged_at IS NULL
   );

DELETE FROM wards w
 WHERE LOWER(w.name) = ANY(ARRAY[
   'general ward', 'icu', 'ccu', 'semi-private', 'private', 'deluxe', 'day care'
 ])
   AND NOT EXISTS (SELECT 1 FROM beds b WHERE b.ward_id = w.id)
   AND NOT EXISTS (
     SELECT 1
       FROM admissions a
      WHERE LOWER(COALESCE(a.ward, '')) = LOWER(w.name)
        AND a.discharged_at IS NULL
   );

COMMIT;
