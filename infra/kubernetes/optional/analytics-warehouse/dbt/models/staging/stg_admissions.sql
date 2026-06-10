-- IPD admissions, one row per admission episode.
select
    id                                   as admission_id,
    tenant_id,
    patient_uid,
    encounter_id,
    department,
    ward,
    bed_id,
    admission_type,
    priority,
    govt_scheme,
    policy_id,
    package_id,
    admitted_at,
    discharged_at,
    discharge_type,
    discharge_disposition,
    billing_closed_at,
    from_er_visit_id,
    status,
    case
        when discharged_at is not null and admitted_at is not null
            then greatest(extract(epoch from (discharged_at - admitted_at)) / 86400.0, 0)
    end                                  as los_days
from {{ source('vhhealth', 'admissions') }}
where admitted_at is not null
