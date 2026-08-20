-- Department revenue & collections, monthly (F2 "department P&L").
-- Grain: tenant_id × department × month (NL-10: every mart carries
-- tenant_id so embeds can lock on it).
-- DELIBERATELY revenue-side only ("P&L-lite"): salary/cost tables are
-- excluded from the v1 replication set pending an explicit privacy sign-off
-- (see docs/ANALYTICS_WAREHOUSE.md). Collections are allocated to the
-- invoice's department; header discounts live on the header, so they are
-- aggregated from stg_billing rather than line-apportioned.
with lines as (
    select
        tenant_id,
        coalesce(department, 'Unassigned') as department,
        invoice_month,
        sum(line_total) filter (where not is_voided)  as gross_billed,
        count(distinct invoice_id) filter (where not is_voided) as invoices
    from {{ ref('fct_revenue') }}
    group by 1, 2, 3
),

headers as (
    select
        tenant_id,
        coalesce(department, 'Unassigned') as department,
        invoice_month,
        sum(discount_amount) filter (where not is_voided) as discounts,
        sum(amount_due)      filter (where not is_voided) as outstanding,
        sum(total_amount)    filter (where is_voided)     as voided_amount
    from {{ ref('stg_billing') }}
    group by 1, 2, 3
),

collections as (
    select
        p.tenant_id,
        coalesce(inv.department, 'Unassigned') as department,
        p.collection_month                     as invoice_month,
        sum(p.amount) filter (where not p.reversed) as collected
    from {{ ref('stg_billing_payments') }} p
    left join {{ ref('stg_billing') }} inv on inv.invoice_id = p.invoice_id
    group by 1, 2, 3
)

select
    coalesce(l.tenant_id, h.tenant_id, c.tenant_id)          as tenant_id,
    coalesce(l.department, h.department, c.department)       as department,
    coalesce(l.invoice_month, h.invoice_month, c.invoice_month) as month,
    coalesce(l.invoices, 0)               as invoices,
    coalesce(l.gross_billed, 0)           as gross_billed,
    coalesce(h.discounts, 0)              as discounts,
    coalesce(l.gross_billed, 0) - coalesce(h.discounts, 0) as net_billed,
    coalesce(c.collected, 0)              as collected,
    coalesce(h.outstanding, 0)            as outstanding,
    coalesce(h.voided_amount, 0)          as voided_amount
from lines l
full outer join headers h
    on h.tenant_id = l.tenant_id
   and h.department = l.department
   and h.invoice_month = l.invoice_month
full outer join collections c
    on c.tenant_id = coalesce(l.tenant_id, h.tenant_id)
   and c.department = coalesce(l.department, h.department)
   and c.invoice_month = coalesce(l.invoice_month, h.invoice_month)
