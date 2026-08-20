-- Collections (NL-10 mart expansion): daily counter collections by payment
-- mode, with same-day billing context from the invoice headers.
-- Grain: tenant_id × date_day (collection date) × mode.
-- The day_* columns are BILLING-day context (invoices ISSUED that day,
-- non-voided) at tenant × day grain, repeated across the mode rows of that
-- day — aggregate them with max/avg in BI, never sum across modes.
-- Reversed payments are excluded from collected_amount but counted
-- separately for reconciliation.
with payments as (
    select
        tenant_id,
        collected_at::date                as date_day,
        lower(coalesce(mode, 'unknown'))  as mode,
        count(*) filter (where not reversed)     as payments,
        sum(amount) filter (where not reversed)  as collected_amount,
        count(*) filter (where reversed)         as reversed_payments,
        sum(amount) filter (where reversed)      as reversed_amount
    from {{ ref('stg_billing_payments') }}
    group by 1, 2, 3
),

billed_days as (
    select
        tenant_id,
        issued_at::date                   as date_day,
        count(*) filter (where not is_voided)              as day_invoices_issued,
        sum(total_amount) filter (where not is_voided)     as day_gross_billed,
        sum(discount_amount) filter (where not is_voided)  as day_discounts,
        sum(amount_due) filter (where not is_voided)       as day_outstanding
    from {{ ref('stg_billing') }}
    group by 1, 2
)

select
    p.tenant_id,
    p.date_day,
    p.mode,
    coalesce(p.payments, 0)               as payments,
    coalesce(p.collected_amount, 0)       as collected_amount,
    coalesce(p.reversed_payments, 0)      as reversed_payments,
    coalesce(p.reversed_amount, 0)        as reversed_amount,
    coalesce(b.day_invoices_issued, 0)    as day_invoices_issued,
    coalesce(b.day_gross_billed, 0)       as day_gross_billed,
    coalesce(b.day_discounts, 0)          as day_discounts,
    coalesce(b.day_gross_billed, 0) - coalesce(b.day_discounts, 0)
                                          as day_net_billed,
    coalesce(b.day_outstanding, 0)        as day_outstanding
from payments p
left join billed_days b
    on b.tenant_id = p.tenant_id and b.date_day = p.date_day
