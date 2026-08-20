-- Pharmacy operations (NL-10 mart expansion): daily pharmacy order volume
-- and dispense-to-delivery turnaround, from the pharmacy slice of the
-- unified order staging (backed by the replicated pharmacy_orders table).
-- Grain: tenant_id × date_day (ordered date) × status_class.
-- NOTE: OTC counter sales (migration 684) are NOT in the replication
-- publication, so walk-in counter revenue is out of scope here — adding it
-- is a publication migration + deep-test change (tracked follow-up).
select
    tenant_id,
    ordered_at::date                      as date_day,
    status_class,
    count(*)                              as orders,
    count(distinct patient_uid)           as unique_patients,
    round((percentile_cont(0.5) within group (order by turnaround_hours)
        filter (where turnaround_hours is not null))::numeric, 2)
                                          as tat_p50_hours,
    round((percentile_cont(0.9) within group (order by turnaround_hours)
        filter (where turnaround_hours is not null))::numeric, 2)
                                          as tat_p90_hours
from {{ ref('stg_orders') }}
where order_store = 'pharmacy'
  and ordered_at is not null
group by 1, 2, 3
