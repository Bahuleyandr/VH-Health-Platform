-- Encounter volume (NL-10 mart expansion): OPD / IPD / ER daily volume by
-- department, from the unified encounters fact.
-- Grain: tenant_id × date_day × department × encounter_type. Department is
-- coalesced to 'Unassigned' so the grain stays NOT NULL (OPD rows can lack
-- a department upstream; ER is hard-coded 'Emergency' in fct_encounters).
-- avg_los_days is only meaningful for IPD rows — encounters of other types
-- have no LOS and leave it null.
select
    tenant_id,
    encounter_date                        as date_day,
    coalesce(department, 'Unassigned')    as department,
    encounter_type,
    count(*)                              as encounters,
    count(distinct patient_uid)           as unique_patients,
    count(*) filter (where is_open)       as open_encounters,
    round(avg(los_days) filter (where los_days is not null)::numeric, 2)
                                          as avg_los_days
from {{ ref('fct_encounters') }}
where encounter_date is not null
group by 1, 2, 3, 4
