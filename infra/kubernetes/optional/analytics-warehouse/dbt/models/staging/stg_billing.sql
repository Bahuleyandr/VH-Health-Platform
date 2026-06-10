-- Invoice header + line + payment staging in one file (ephemeral CTE style
-- keeps the staging layer compact; downstream refs use the three views
-- below via dbt's standard one-model-per-file siblings).
-- This model: invoice HEADERS only. Voided invoices are kept with a flag —
-- finance wants both gross and net-of-void views.
select
    id                                   as invoice_id,
    tenant_id,
    invoice_number,
    patient_uid,
    admission_id,
    doctor_uid,
    department,
    invoice_type,
    subtotal,
    cgst_amount,
    sgst_amount,
    igst_amount,
    discount_amount,
    total_amount,
    amount_paid,
    amount_due,
    status,
    issued_at,
    (voided_at is not null)              as is_voided,
    date_trunc('month', issued_at)::date as invoice_month
from {{ source('vhhealth', 'billing_invoices') }}
where issued_at is not null
