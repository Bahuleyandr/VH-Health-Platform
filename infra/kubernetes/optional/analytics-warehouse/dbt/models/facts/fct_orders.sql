-- Order activity fact (volume / mix / turnaround) over the unified staging
-- union. Grain: one row per order in its source store.
select
    order_store || ':' || source_id       as order_key,
    order_store,
    tenant_id,
    patient_uid,
    order_type,
    status_raw,
    status_class,
    ordered_at,
    ordered_at::date                      as order_date,
    date_trunc('month', ordered_at)::date as order_month,
    completed_at,
    turnaround_hours
from {{ ref('stg_orders') }}
where ordered_at is not null
