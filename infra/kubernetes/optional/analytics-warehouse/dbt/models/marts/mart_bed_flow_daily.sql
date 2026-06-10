-- Bed-flow board (F2): per ward per day — admissions in, discharges out,
-- transfers in/out, midnight census, occupancy vs the seeded bed structure.
-- Census definition: admissions overlapping the day boundary (admitted
-- before the NEXT midnight, not discharged before it) — the NABH/billing
-- convention for occupied-bed-days.
with days as (
    select date_day from {{ ref('dim_date') }}
    where date_day <= current_date
),

wards as (
    select ward_id, ward_name, total_beds from {{ ref('stg_wards') }}
),

admits as (
    select ward, admitted_at::date as d, count(*) as n
    from {{ ref('stg_admissions') }}
    group by 1, 2
),

discharges as (
    select ward, discharged_at::date as d, count(*) as n
    from {{ ref('stg_admissions') }}
    where discharged_at is not null
    group by 1, 2
),

transfers as (
    select
        bt.transfer_date as d,
        bf.ward_id       as from_ward_id,
        bt2.ward_id      as to_ward_id
    from {{ ref('stg_bed_transfers') }} bt
    left join {{ source('vhhealth', 'beds') }} bf on bf.id = bt.from_bed_id
    left join {{ source('vhhealth', 'beds') }} bt2 on bt2.id = bt.to_bed_id
),

census as (
    select
        d.date_day,
        a.ward,
        count(*) as midnight_census
    from days d
    join {{ ref('stg_admissions') }} a
      on a.admitted_at < (d.date_day + 1)
     and (a.discharged_at is null or a.discharged_at >= (d.date_day + 1))
    group by 1, 2
)

select
    d.date_day,
    w.ward_id,
    w.ward_name,
    w.total_beds,
    coalesce(ad.n, 0)                     as admissions_in,
    coalesce(dis.n, 0)                    as discharges_out,
    coalesce(tin.n, 0)                    as transfers_in,
    coalesce(tout.n, 0)                   as transfers_out,
    coalesce(c.midnight_census, 0)        as midnight_census,
    case when w.total_beds > 0
         then round(100.0 * coalesce(c.midnight_census, 0) / w.total_beds, 1)
    end                                   as occupancy_pct
from days d
cross join wards w
left join admits     ad  on ad.ward = w.ward_name and ad.d = d.date_day
left join discharges dis on dis.ward = w.ward_name and dis.d = d.date_day
left join census     c   on c.ward = w.ward_name and c.date_day = d.date_day
left join (
    select d, from_ward_id, count(*) as n from transfers group by 1, 2
) tout on tout.from_ward_id = w.ward_id and tout.d = d.date_day
left join (
    select d, to_ward_id, count(*) as n from transfers group by 1, 2
) tin on tin.to_ward_id = w.ward_id and tin.d = d.date_day
where coalesce(ad.n, dis.n, tin.n, tout.n, c.midnight_census, 0) > 0
   or d.date_day >= current_date - 90
