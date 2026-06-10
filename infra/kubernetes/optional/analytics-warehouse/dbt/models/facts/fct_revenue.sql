-- Revenue fact at invoice-LINE grain, with header context denormalized.
-- Voided invoices ride along flagged so finance can see gross vs net-of-void.
-- payer_class for IPD lines comes via the admission's policy/scheme; OPD and
-- walk-in invoices are 'unattributed' here — encounter-level payer mix lives
-- on fct_encounters, claims settlement on the payer-mix mart.
with ipd_payer as (
    select
        a.admission_id,
        case
            when a.govt_scheme is not null and a.govt_scheme <> '' then 'govt_scheme'
            when p.tpa_id is not null then 'tpa'
            when p.payer_id is not null then 'insurance'
            when a.policy_id is not null then 'insurance'
            else 'cash'
        end as payer_class
    from {{ ref('stg_admissions') }} a
    left join {{ source('vhhealth', 'insurance_policies') }} p
        on p.id = a.policy_id
)

select
    it.item_id                            as revenue_line_key,
    inv.tenant_id,
    inv.invoice_id,
    inv.invoice_number,
    inv.invoice_type,
    inv.department,
    inv.patient_uid,
    inv.admission_id,
    coalesce(ip.payer_class,
             case when inv.admission_id is null then 'unattributed' end,
             'unattributed')              as payer_class,
    it.category                           as service_category,
    it.service_code,
    it.source_ref_type,
    it.quantity,
    it.line_subtotal,
    it.line_total,
    inv.status                            as invoice_status,
    inv.is_voided,
    inv.issued_at,
    inv.invoice_month
from {{ ref('stg_billing_items') }} it
join {{ ref('stg_billing') }} inv on inv.invoice_id = it.invoice_id
left join ipd_payer ip on ip.admission_id = inv.admission_id
