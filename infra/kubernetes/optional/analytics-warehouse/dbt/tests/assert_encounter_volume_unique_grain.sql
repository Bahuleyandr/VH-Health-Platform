-- Singular test: tenant × day × department × encounter_type must be unique,
-- and counts must be internally consistent.
select tenant_id, date_day, department, encounter_type, count(*) as dupes
from {{ ref('mart_encounter_volume_daily') }}
group by 1, 2, 3, 4
having count(*) > 1

union all

select tenant_id, date_day, department, encounter_type, 1
from {{ ref('mart_encounter_volume_daily') }}
where open_encounters > encounters or unique_patients > encounters
