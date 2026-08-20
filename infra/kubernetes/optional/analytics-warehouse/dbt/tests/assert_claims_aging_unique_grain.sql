-- Singular test: tenant × month × store × bucket must be unique in the
-- claims-aging mart, and open-value must never exceed claimed value.
select tenant_id, claim_month, claim_store, aging_bucket, count(*) as dupes
from {{ ref('mart_claims_aging_monthly') }}
group by 1, 2, 3, 4
having count(*) > 1

union all

select tenant_id, claim_month, claim_store, aging_bucket, 1
from {{ ref('mart_claims_aging_monthly') }}
where coalesce(open_claimed_amount, 0) > claimed_amount
