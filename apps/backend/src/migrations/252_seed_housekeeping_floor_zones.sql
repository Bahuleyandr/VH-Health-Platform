-- Seed housekeeping floor zones from ward floors.
--
-- Admin/HR can then keep these visible, grey them out by setting is_active=false,
-- add more zones, or remove unused zones through the existing housekeeping zone
-- management APIs.

BEGIN;

INSERT INTO housekeeping_zones (name, zone_type, floor, building, is_active)
SELECT src.name,
       'floor',
       src.floor,
       src.building,
       true
  FROM (
    SELECT DISTINCT
           CONCAT('Floor ', COALESCE(floor::text, 'Unassigned')) AS name,
           floor::text AS floor,
           'Main'::text AS building
      FROM wards
  ) src
 WHERE NOT EXISTS (
   SELECT 1
     FROM housekeeping_zones hz
    WHERE LOWER(hz.name) = LOWER(src.name)
      AND LOWER(hz.zone_type) = 'floor'
 );

COMMIT;
