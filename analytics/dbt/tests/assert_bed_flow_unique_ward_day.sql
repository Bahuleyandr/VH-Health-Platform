-- Singular test (no external packages): ward × day must be unique in the
-- bed-flow mart, and occupancy must stay within 0–150% (over 100 is real —
-- floor beds / overbooking — but >150 means the ward-name join broke).
select date_day, ward_id, count(*) as dupes
from {{ ref('mart_bed_flow_daily') }}
group by 1, 2
having count(*) > 1

union all

select date_day, ward_id, 1
from {{ ref('mart_bed_flow_daily') }}
where occupancy_pct is not null and (occupancy_pct < 0 or occupancy_pct > 150)
