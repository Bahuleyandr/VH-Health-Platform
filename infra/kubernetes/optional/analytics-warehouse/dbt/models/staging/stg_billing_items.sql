-- Invoice line items — the service-mix grain (category, source traceability).
select
    i.id                                 as item_id,
    i.invoice_id,
    i.service_code,
    i.category,
    i.quantity,
    i.unit_price,
    i.line_subtotal,
    i.line_total,
    i.gst_rate,
    i.source_ref_type,
    i.tpa_decision
from {{ source('vhhealth', 'billing_invoice_items') }} i
