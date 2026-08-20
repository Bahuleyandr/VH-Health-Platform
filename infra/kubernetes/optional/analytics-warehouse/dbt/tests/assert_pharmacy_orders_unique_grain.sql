-- Singular test: tenant × day × status_class must be unique in the
-- pharmacy mart.
select tenant_id, date_day, status_class, count(*) as dupes
from {{ ref('mart_pharmacy_orders_daily') }}
group by 1, 2, 3
having count(*) > 1
