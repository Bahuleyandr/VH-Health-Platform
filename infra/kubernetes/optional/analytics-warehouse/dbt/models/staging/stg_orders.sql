-- Unified order activity across the three order stores, coarse-grained for
-- analytics (volume, mix, turnaround). The canonical CPOE store
-- (clinical_orders) carries nested details JSON; analytics only needs the
-- envelope. Status classes:
--   open      — clinically live (ordered/verified/in_progress + pharmacy
--               pre-delivery lifecycle)
--   completed — done/delivered/resulted
--   cancelled — cancelled/discontinued/rejected
select
    'clinical'                            as order_store,
    id::text                              as source_id,
    tenant_id,
    patient_uid,
    lower(coalesce(order_type, 'unknown')) as order_type,
    lower(coalesce(status, 'ordered'))     as status_raw,
    case
        when lower(coalesce(status, '')) in ('completed') then 'completed'
        when lower(coalesce(status, '')) in ('cancelled', 'canceled', 'discontinued', 'stopped') then 'cancelled'
        else 'open'
    end                                   as status_class,
    created_at                            as ordered_at,
    completed_at,
    case
        when completed_at is not null and created_at is not null
            then greatest(extract(epoch from (completed_at - created_at)) / 3600.0, 0)
    end                                   as turnaround_hours
from {{ source('vhhealth', 'clinical_orders') }}

union all

select
    'pharmacy',
    id::text,
    tenant_id,
    uid                                   as patient_uid,
    'medication',
    lower(coalesce(status, 'pending')),
    case
        when lower(coalesce(status, '')) in ('delivered', 'dispensed', 'completed') then 'completed'
        when lower(coalesce(status, '')) in ('cancelled', 'canceled', 'rejected') then 'cancelled'
        else 'open'
    end,
    coalesce(ordered_at, created_at),
    coalesce(delivered_at, dispensed_at),
    case
        when coalesce(delivered_at, dispensed_at) is not null
         and coalesce(ordered_at, created_at) is not null
            then greatest(extract(epoch from (coalesce(delivered_at, dispensed_at)
                                              - coalesce(ordered_at, created_at))) / 3600.0, 0)
    end
from {{ source('vhhealth', 'pharmacy_orders') }}

union all

select
    'investigation',
    id::text,
    tenant_id,
    coalesce(patient_uid, uid),
    lower(coalesce(investigation_type, test_type, 'lab')),
    lower(coalesce(status, 'requested')),
    case
        when lower(coalesce(status, '')) in ('completed', 'report_ready', 'resulted') then 'completed'
        when lower(coalesce(status, '')) in ('cancelled', 'canceled', 'rejected') then 'cancelled'
        else 'open'
    end,
    coalesce(requested_at, created_at),
    completed_at,
    case
        when completed_at is not null and coalesce(requested_at, created_at) is not null
            then greatest(extract(epoch from (completed_at - coalesce(requested_at, created_at))) / 3600.0, 0)
    end
from {{ source('vhhealth', 'investigations') }}
