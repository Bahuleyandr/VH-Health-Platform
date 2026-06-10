-- Department dimension. Facts mostly carry department NAME varchars
-- (admissions.department, billing_invoices.department), so the natural key
-- here is the name; id retained for joins to wards.department_id.
select
    id                                   as department_id,
    name                                 as department_name,
    code                                 as department_code,
    is_active
from {{ source('vhhealth', 'departments') }}
