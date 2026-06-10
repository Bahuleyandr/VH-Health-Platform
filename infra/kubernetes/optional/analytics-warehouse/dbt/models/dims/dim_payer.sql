-- Payer dimension: real payers/TPAs from the masters plus the synthetic
-- classes facts fall back to. payer_key is the join key facts carry.
select
    'payer:' || id::text                 as payer_key,
    'insurance'                          as payer_class,
    display_name,
    payer_kind,
    status
from {{ source('vhhealth', 'payers') }}

union all

select
    'tpa:' || id::text,
    'tpa',
    display_name,
    'tpa',
    status
from {{ source('vhhealth', 'tpas') }}

union all

select * from (
    values
        ('class:cash',        'cash',        'Cash / self-pay',        'synthetic', 'active'),
        ('class:govt_scheme', 'govt_scheme', 'Government scheme',      'synthetic', 'active'),
        ('class:insurance',   'insurance',   'Insurance (unmapped)',   'synthetic', 'active'),
        ('class:tpa',         'tpa',         'TPA (unmapped)',         'synthetic', 'active'),
        ('class:corporate',   'corporate',   'Corporate / employer',   'synthetic', 'active'),
        ('class:other',       'other',       'Other / unattributed',   'synthetic', 'active')
) s (payer_key, payer_class, display_name, payer_kind, status)
