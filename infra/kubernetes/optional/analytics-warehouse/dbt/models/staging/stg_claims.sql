-- Unified claims staging over the two replicated claim stores. The stores
-- are DELIBERATELY separate upstream (TPA cashless workflow vs direct
-- insurance reimbursement — see apps/backend/CLAUDE.md); claim_store keeps
-- them distinct here instead of pretending they share a lifecycle.
-- Status classes:
--   open     — anything still moving (prepared/submitted/queried/approved
--              pre-payment, etc.)
--   settled  — money resolved (paid / settled)
--   closed   — terminal without settlement (rejected/denied/cancelled/
--              withdrawn/closed)
select
    'tpa'                                 as claim_store,
    id::text                              as source_id,
    tenant_id,
    patient_uid,
    lower(coalesce(status, 'prepared'))   as status_raw,
    case
        when lower(coalesce(status, '')) in ('paid', 'settled') then 'settled'
        when lower(coalesce(status, '')) in
             ('rejected', 'denied', 'cancelled', 'canceled', 'withdrawn', 'closed') then 'closed'
        else 'open'
    end                                   as status_class,
    coalesce(claimed_amount, 0)           as claimed_amount,
    coalesce(approved_amount, 0)          as approved_amount,
    coalesce(paid_amount, 0)              as paid_amount,
    coalesce(submitted_at, created_at)    as submitted_at,
    paid_at                               as settled_at,
    case
        when paid_at is not null and coalesce(submitted_at, created_at) is not null
            then greatest(extract(epoch from (paid_at - coalesce(submitted_at, created_at))) / 86400.0, 0)
    end                                   as settlement_lag_days
from {{ source('vhhealth', 'tpa_claims') }}

union all

select
    'insurance',
    id::text,
    tenant_id,
    patient_uid,
    lower(coalesce(status, 'submitted')),
    case
        when lower(coalesce(status, '')) in ('paid', 'settled') then 'settled'
        when lower(coalesce(status, '')) in
             ('rejected', 'denied', 'cancelled', 'canceled', 'withdrawn', 'closed') then 'closed'
        else 'open'
    end,
    coalesce(claim_amount, 0),
    coalesce(approved_amount, 0),
    -- insurance_claims has no paid_amount column; approved is the best
    -- settled-value proxy for the reimbursement store.
    case when lower(coalesce(status, '')) in ('paid', 'settled')
         then coalesce(approved_amount, 0) else 0 end,
    coalesce(submitted_at, created_at),
    reviewed_at,
    case
        when reviewed_at is not null and coalesce(submitted_at, created_at) is not null
            then greatest(extract(epoch from (reviewed_at - coalesce(submitted_at, created_at))) / 86400.0, 0)
    end
from {{ source('vhhealth', 'insurance_claims') }}
