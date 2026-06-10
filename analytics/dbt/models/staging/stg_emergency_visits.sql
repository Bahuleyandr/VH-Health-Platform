-- ER visits — arrival to departure/disposition.
select
    id                                   as er_visit_id,
    tenant_id,
    patient_uid,
    visit_number,
    arrival_at,
    arrival_mode,
    triage_priority,
    status,
    disposition,
    disposition_at,
    departure_at,
    attending_doctor_uid,
    is_mlc,
    case
        when disposition_at is not null and arrival_at is not null
            then greatest(extract(epoch from (disposition_at - arrival_at)) / 3600.0, 0)
    end                                  as door_to_disposition_hours
from {{ source('vhhealth', 'emergency_visits') }}
where arrival_at is not null
