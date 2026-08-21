-- Singular test: tenant × day × mode must be unique in the collections
-- mart, and the day_* billing context must be identical across the mode
-- rows of one tenant-day (it is tenant × day grain, repeated — summing it
-- across modes would double-count, which BI must be able to trust).
select tenant_id, date_day, mode, count(*) as dupes
from {{ ref('mart_collections_daily') }}
group by 1, 2, 3
having count(*) > 1

union all

select tenant_id, date_day, 'day_context_diverges', count(distinct day_gross_billed)
from {{ ref('mart_collections_daily') }}
group by 1, 2
having count(distinct day_gross_billed) > 1
    or count(distinct day_outstanding) > 1
    or count(distinct day_invoices_issued) > 1
