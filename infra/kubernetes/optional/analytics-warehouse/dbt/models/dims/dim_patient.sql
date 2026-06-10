-- Pseudonymous patient dimension — only the column-listed replication
-- allow-list reaches this database (migration 295), so this model CANNOT
-- leak more than uid + coarse demographics by construction.
select
    uid                                  as patient_uid,
    tenant_id,
    gender,
    is_minor,
    registered_at,
    case
        when birthday is null then 'unknown'
        when date_part('year', age(birthday)) < 1   then 'infant'
        when date_part('year', age(birthday)) < 13  then 'child'
        when date_part('year', age(birthday)) < 18  then 'adolescent'
        when date_part('year', age(birthday)) < 40  then '18-39'
        when date_part('year', age(birthday)) < 60  then '40-59'
        when date_part('year', age(birthday)) < 75  then '60-74'
        else '75+'
    end                                  as age_band
from {{ source('vhhealth', 'users') }}
where lower(coalesce(role, '')) = 'patient'
