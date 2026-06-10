-- One row per encounter across OPD / IPD / ER — the F1 encounters star.
-- payer_class is the coarse mix dimension; encounter-level payer mapping is
-- defensive because OPD payer_type is free-ish text upstream.
with ipd_payer as (
    select
        a.admission_id,
        case
            when a.govt_scheme is not null and a.govt_scheme <> '' then 'govt_scheme'
            when p.tpa_id is not null then 'tpa'
            when p.payer_id is not null then 'insurance'
            when a.policy_id is not null then 'insurance'
            else 'cash'
        end as payer_class
    from {{ ref('stg_admissions') }} a
    left join {{ source('vhhealth', 'insurance_policies') }} p
        on p.id = a.policy_id
)

select
    'ipd:' || a.admission_id::text       as encounter_key,
    'ipd'                                 as encounter_type,
    a.tenant_id,
    a.patient_uid,
    a.admitted_at::date                   as encounter_date,
    date_trunc('month', a.admitted_at)::date as encounter_month,
    a.department,
    a.ward,
    null::int                             as doctor_id,
    ip.payer_class,
    a.admitted_at                         as started_at,
    a.discharged_at                       as ended_at,
    a.los_days,
    a.discharge_type                      as outcome,
    (a.discharged_at is null)             as is_open
from {{ ref('stg_admissions') }} a
left join ipd_payer ip on ip.admission_id = a.admission_id

union all

select
    'opd:' || ap.appointment_id::text,
    'opd',
    ap.tenant_id,
    ap.patient_uid,
    ap.appointment_date,
    date_trunc('month', ap.appointment_date)::date,
    ap.department,
    null,
    ap.doctor_id,
    case
        when ap.scheme_name is not null and ap.scheme_name <> '' then 'govt_scheme'
        when lower(coalesce(ap.payer_type, '')) in ('govt', 'government', 'scheme', 'govt_scheme', 'pmjay') then 'govt_scheme'
        when lower(coalesce(ap.payer_type, '')) in ('tpa') then 'tpa'
        when lower(coalesce(ap.payer_type, '')) in ('insurance', 'insurer', 'insured')
             or (ap.insurer_name is not null and ap.insurer_name <> '') then 'insurance'
        when lower(coalesce(ap.payer_type, '')) in ('corporate', 'corp', 'employer') then 'corporate'
        when lower(coalesce(ap.payer_type, '')) in ('', 'cash', 'self', 'self_pay', 'self-pay') then 'cash'
        else 'other'
    end,
    ap.created_at,
    null::timestamptz,
    null::numeric,
    ap.status,
    (lower(coalesce(ap.status, '')) in ('scheduled', 'confirmed', 'checked_in', 'in_progress'))
from {{ ref('stg_appointments') }} ap

union all

select
    'er:' || er.er_visit_id::text,
    'er',
    er.tenant_id,
    er.patient_uid,
    er.arrival_at::date,
    date_trunc('month', er.arrival_at)::date,
    'Emergency',
    null,
    null,
    'other',
    er.arrival_at,
    coalesce(er.departure_at, er.disposition_at),
    null,
    er.disposition,
    (er.disposition_at is null)
from {{ ref('stg_emergency_visits') }} er
