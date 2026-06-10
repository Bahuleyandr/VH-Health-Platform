select
    id                                   as transfer_id,
    tenant_id,
    patient_uid,
    admission_id,
    from_bed_id,
    to_bed_id,
    transferred_at,
    transferred_at::date                 as transfer_date
from {{ source('vhhealth', 'bed_transfers') }}
where transferred_at is not null
