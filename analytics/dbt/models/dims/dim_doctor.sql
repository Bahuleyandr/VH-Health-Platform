select
    id                                   as doctor_id,
    name                                 as doctor_name,
    department_id,
    department                           as department_name,
    specialty,
    is_active
from {{ source('vhhealth', 'doctors') }}
