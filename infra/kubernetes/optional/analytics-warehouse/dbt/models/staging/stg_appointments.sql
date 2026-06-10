-- OPD appointments. appointment_time is a varchar in OLTP; the date column
-- is the analytical grain. created_at is timestamp WITHOUT time zone
-- (legacy) — kept as-is, used only for ordering.
select
    id                                   as appointment_id,
    tenant_id,
    uid                                  as patient_uid,
    doctor_id,
    department,
    appointment_date,
    status,
    visit_type,
    visit_no,
    payer_type,
    patient_category,
    insurer_name,
    scheme_name,
    triage_acuity,
    created_at
from {{ source('vhhealth', 'appointments') }}
where appointment_date is not null
