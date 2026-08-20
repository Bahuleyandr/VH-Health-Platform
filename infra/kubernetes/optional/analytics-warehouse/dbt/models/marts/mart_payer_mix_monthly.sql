-- Payer mix, monthly (F2): encounter mix by payer class + the
-- claims-settlement view (TPA + insurance) so finance sees volume AND
-- realisation side by side.
-- Grain: tenant_id × payer_class × month (NL-10: every mart carries
-- tenant_id so embeds can lock on it).
with encounter_mix as (
    select
        tenant_id,
        encounter_month                   as month,
        payer_class,
        count(*)                          as encounters,
        count(*) filter (where encounter_type = 'ipd') as ipd_encounters,
        count(*) filter (where encounter_type = 'opd') as opd_encounters,
        count(*) filter (where encounter_type = 'er')  as er_encounters
    from {{ ref('fct_encounters') }}
    where payer_class is not null
    group by 1, 2, 3
),

ipd_billed as (
    select
        tenant_id,
        invoice_month                     as month,
        payer_class,
        sum(line_total) filter (where not is_voided) as billed
    from {{ ref('fct_revenue') }}
    group by 1, 2, 3
),

tpa_settlement as (
    select
        tenant_id,
        date_trunc('month', coalesce(paid_at, updated_at, created_at))::date as month,
        'tpa'                             as payer_class,
        sum(coalesce(claimed_amount, 0))  as claimed,
        sum(coalesce(approved_amount, 0)) as approved,
        sum(coalesce(paid_amount, 0))     as paid,
        sum(coalesce(disallowed_amount, non_payable_amount, 0)) as disallowed
    from {{ source('vhhealth', 'tpa_claims') }}
    group by 1, 2, 3
),

insurance_settlement as (
    select
        tenant_id,
        date_trunc('month', coalesce(reviewed_at, updated_at, created_at))::date as month,
        'insurance'                       as payer_class,
        sum(coalesce(claim_amount, 0)),
        sum(coalesce(approved_amount, 0)),
        null::numeric,
        sum(coalesce(non_payable_amount, 0))
    from {{ source('vhhealth', 'insurance_claims') }}
    group by 1, 2, 3
),

settlements as (
    select * from tpa_settlement
    union all
    select * from insurance_settlement
)

select
    coalesce(e.tenant_id, b.tenant_id, s.tenant_id) as tenant_id,
    coalesce(e.month, b.month, s.month)   as month,
    coalesce(e.payer_class, b.payer_class, s.payer_class) as payer_class,
    coalesce(e.encounters, 0)             as encounters,
    coalesce(e.ipd_encounters, 0)         as ipd_encounters,
    coalesce(e.opd_encounters, 0)         as opd_encounters,
    coalesce(e.er_encounters, 0)          as er_encounters,
    coalesce(b.billed, 0)                 as billed,
    coalesce(s.claimed, 0)                as claims_claimed,
    coalesce(s.approved, 0)               as claims_approved,
    coalesce(s.paid, 0)                   as claims_paid,
    coalesce(s.disallowed, 0)             as claims_disallowed
from encounter_mix e
full outer join ipd_billed b
    on b.tenant_id = e.tenant_id and b.month = e.month and b.payer_class = e.payer_class
full outer join settlements s
    on s.tenant_id = coalesce(e.tenant_id, b.tenant_id)
   and s.month = coalesce(e.month, b.month)
   and s.payer_class = coalesce(e.payer_class, b.payer_class)
