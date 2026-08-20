-- Order turnaround (NL-10 mart expansion): daily ordered/completed volume
-- and turnaround percentiles per order store and type. Named for its
-- headline use (lab TAT dashboards) but covers all three replicated order
-- stores — clinical CPOE, pharmacy, investigations — so radiology and
-- pharmacy TAT read from the same mart.
-- Grain: tenant_id × date_day (ordered date) × order_store × order_type.
-- TAT percentiles cover orders ORDERED that day that have completed —
-- recent days under-report until their open orders close (cohort view, the
-- honest one for SLA trending).
select
    tenant_id,
    order_date                            as date_day,
    order_store,
    order_type,
    count(*)                              as orders_placed,
    count(*) filter (where status_class = 'completed') as orders_completed,
    count(*) filter (where status_class = 'cancelled') as orders_cancelled,
    count(*) filter (where status_class = 'open')      as orders_open,
    round(
        100.0 * count(*) filter (where status_class = 'completed')
              / count(*),
        1
    )                                     as completion_pct,
    round((percentile_cont(0.5) within group (order by turnaround_hours)
        filter (where turnaround_hours is not null))::numeric, 2)
                                          as tat_p50_hours,
    round((percentile_cont(0.9) within group (order by turnaround_hours)
        filter (where turnaround_hours is not null))::numeric, 2)
                                          as tat_p90_hours
from {{ ref('fct_orders') }}
group by 1, 2, 3, 4
