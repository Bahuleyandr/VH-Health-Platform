-- Claims aging (NL-10 mart expansion, finance/RCM): monthly submission
-- cohorts of TPA + insurance claims with an as-of-build aging bucket for
-- everything still open, plus settlement value and lag for what closed.
-- Grain: tenant_id × claim_month (submission month) × claim_store ×
-- aging_bucket. Open claims bucket on age since submission AS OF the dbt
-- run (nightly), so buckets migrate rightward until the claim closes;
-- settled/closed claims land in the terminal pseudo-buckets. The two claim
-- stores stay distinct on purpose — TPA cashless and direct insurance
-- reimbursement have different lifecycles (see stg_claims).
select
    tenant_id,
    date_trunc('month', submitted_at)::date as claim_month,
    claim_store,
    case
        when status_class = 'settled' then 'settled'
        when status_class = 'closed'  then 'closed_unsettled'
        when current_date - submitted_at::date <= 30  then 'open_0_30'
        when current_date - submitted_at::date <= 60  then 'open_31_60'
        when current_date - submitted_at::date <= 90  then 'open_61_90'
        else 'open_over_90'
    end                                   as aging_bucket,
    count(*)                              as claims,
    sum(claimed_amount)                   as claimed_amount,
    sum(approved_amount)                  as approved_amount,
    sum(paid_amount)                      as paid_amount,
    sum(claimed_amount) filter (where status_class = 'open')
                                          as open_claimed_amount,
    round(avg(settlement_lag_days) filter (where settlement_lag_days is not null)::numeric, 1)
                                          as avg_settlement_lag_days
from {{ ref('stg_claims') }}
where submitted_at is not null
group by 1, 2, 3, 4
