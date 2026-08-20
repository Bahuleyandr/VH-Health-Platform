-- OT utilization (F2): per tenant per theatre per day. Denominator = the
-- staffed-day var (ot_available_minutes_per_day, default 600 = 10h).
-- Completed cases without a recorded actual_duration fall back to the
-- estimate so the utilization line doesn't lie low while documentation lags.
-- Grain: tenant_id × ot_room × date_day — the migration-465 catalog already
-- declares this mart tenant_id-bounded; the model now actually carries it.
select
    tenant_id,
    scheduled_date                        as date_day,
    ot_room,
    count(*)                              as cases_scheduled,
    count(*) filter (where lower(coalesce(status, '')) = 'completed')
                                          as cases_completed,
    count(*) filter (where lower(coalesce(status, '')) in ('cancelled', 'canceled'))
                                          as cases_cancelled,
    sum(coalesce(estimated_minutes, 0))   as planned_minutes,
    sum(
        case when lower(coalesce(status, '')) = 'completed'
             then coalesce(actual_minutes, estimated_minutes, 0)
             else 0 end
    )                                     as utilized_minutes,
    round(
        100.0 * sum(
            case when lower(coalesce(status, '')) = 'completed'
                 then coalesce(actual_minutes, estimated_minutes, 0)
                 else 0 end
        ) / {{ var('ot_available_minutes_per_day') }},
        1
    )                                     as utilization_pct
from {{ ref('stg_ot_schedules') }}
where ot_room is not null
group by 1, 2, 3
