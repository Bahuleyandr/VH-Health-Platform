-- Ward physical structure (capacity denominator for occupancy). Bed counts
-- come from wards.total_beds — the seeded structure, migrations 255/257/258.
select
    id                                   as ward_id,
    tenant_id,
    name                                 as ward_name,
    floor,
    department_id,
    total_beds
from {{ source('vhhealth', 'wards') }}
