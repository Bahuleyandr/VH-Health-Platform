-- Singular test: tenant × day × store × type must be unique in the TAT
-- mart; status splits must sum back to the placed count; percentiles must
-- be ordered.
select tenant_id, date_day, order_store, order_type, count(*) as dupes
from {{ ref('mart_lab_tat_daily') }}
group by 1, 2, 3, 4
having count(*) > 1

union all

select tenant_id, date_day, order_store, order_type, 1
from {{ ref('mart_lab_tat_daily') }}
where orders_completed + orders_cancelled + orders_open <> orders_placed
   or completion_pct < 0 or completion_pct > 100
   or (tat_p50_hours is not null and tat_p90_hours is not null
       and tat_p50_hours > tat_p90_hours)
