-- Cash/UPI/card collections at the counter. Reversed payments excluded from
-- collection measures but kept for reconciliation counts.
select
    id                                   as payment_id,
    tenant_id,
    invoice_id,
    patient_uid,
    amount,
    mode,
    shift,
    collected_at,
    reversed,
    date_trunc('month', collected_at)::date as collection_month
from {{ source('vhhealth', 'billing_payments') }}
where collected_at is not null
