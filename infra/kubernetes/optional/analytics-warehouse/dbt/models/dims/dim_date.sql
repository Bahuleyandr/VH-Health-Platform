-- Day spine from the warehouse epoch through one year ahead of today.
-- Rebuilt on every dbt run (table materialization) so "one year ahead"
-- tracks the run date.
with spine as (
    select generate_series(
        '{{ var("warehouse_epoch") }}'::date,
        (current_date + interval '1 year')::date,
        interval '1 day'
    )::date as date_day
)
select
    date_day,
    extract(year  from date_day)::int     as year,
    extract(month from date_day)::int     as month,
    date_trunc('month', date_day)::date   as month_start,
    to_char(date_day, 'YYYY-MM')          as year_month,
    extract(isodow from date_day)::int    as iso_dow,
    (extract(isodow from date_day) >= 6)  as is_weekend
from spine
