-- OT bookings: scheduled vs actual minutes per theatre-day.
select
    id                                   as ot_schedule_id,
    tenant_id,
    patient_uid,
    surgeon,
    anesthetist,
    procedure_name,
    procedure_code,
    ot_room,
    scheduled_date,
    scheduled_time,
    estimated_duration                   as estimated_minutes,
    actual_duration                      as actual_minutes,
    status
from {{ source('vhhealth', 'ot_schedules') }}
where scheduled_date is not null
