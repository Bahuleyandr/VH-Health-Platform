-- Singular test: tenant × theatre × day must be unique in the OT mart.
select tenant_id, date_day, ot_room, count(*) as dupes
from {{ ref('mart_ot_utilization_daily') }}
group by 1, 2, 3
having count(*) > 1
