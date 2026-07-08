-- Migration 403: Dental department seed + billing/service catalog linkage.

BEGIN;

INSERT INTO departments (tenant_id, name, description, is_active, code, updated_at)
SELECT
  t.id,
  'Dentistry',
  'Dental and oral health services',
  true,
  'DENTAL',
  NOW()
FROM tenants t
ON CONFLICT (tenant_id, name) DO UPDATE SET
  description = EXCLUDED.description,
  is_active = true,
  code = COALESCE(departments.code, EXCLUDED.code),
  updated_at = NOW();

WITH dental_items(code, description, category, default_price, hsn_sac, service_kind, duration_minutes, procedure_code) AS (
  VALUES
    ('DENT-CONSULT'::varchar(50), 'Dental consultation'::varchar(255), 'consultation'::varchar(50), 600.00::numeric(12,2), '9993'::varchar(20), 'consultation'::varchar(40), 20::integer, NULL::varchar(40)),
    ('DENT-SCALING', 'Dental scaling and polishing', 'procedure', 1500.00, '9993', 'procedure', 45, 'D1110'),
    ('DENT-REST-D2391', 'Posterior composite restoration - one surface', 'procedure', 2200.00, '9993', 'procedure', 50, 'D2391'),
    ('DENT-RCT-D3310', 'Anterior root canal therapy', 'procedure', 6500.00, '9993', 'procedure', 75, 'D3310'),
    ('DENT-EXTRACT-D7140', 'Extraction - erupted tooth', 'procedure', 2500.00, '9993', 'procedure', 40, 'D7140'),
    ('DENT-CROWN-D2740', 'Porcelain or ceramic crown', 'procedure', 9000.00, '9993', 'procedure', 60, 'D2740')
),
service_master_upsert AS (
  INSERT INTO billing_service_master (
    tenant_id,
    code,
    description,
    category,
    default_price,
    gst_rate,
    hsn_sac,
    is_active,
    updated_at
  )
  SELECT
    t.id,
    di.code,
    di.description,
    di.category,
    di.default_price,
    0,
    di.hsn_sac,
    true,
    NOW()
  FROM tenants t
  CROSS JOIN dental_items di
  ON CONFLICT (tenant_id, code) DO UPDATE SET
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    default_price = EXCLUDED.default_price,
    gst_rate = EXCLUDED.gst_rate,
    hsn_sac = EXCLUDED.hsn_sac,
    is_active = true,
    updated_at = NOW()
  RETURNING tenant_id, code
)
INSERT INTO service_catalog (
  tenant_id,
  service_code,
  display_name,
  description,
  service_kind,
  specialty,
  department_id,
  default_duration_minutes,
  requires_appointment,
  default_tariff_item_code,
  status,
  metadata,
  updated_at
)
SELECT
  t.id,
  di.code,
  di.description,
  di.description,
  di.service_kind,
  'Dentistry',
  d.id,
  di.duration_minutes,
  true,
  di.code,
  'active',
  jsonb_build_object(
    'domain', 'dental',
    'billingCode', di.code,
    'procedureCode', di.procedure_code
  ),
  NOW()
FROM tenants t
CROSS JOIN dental_items di
JOIN service_master_upsert sm
  ON sm.tenant_id = t.id
 AND sm.code = di.code
LEFT JOIN departments d
  ON d.tenant_id = t.id
 AND d.name = 'Dentistry'
ON CONFLICT (tenant_id, service_code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  service_kind = EXCLUDED.service_kind,
  specialty = EXCLUDED.specialty,
  department_id = EXCLUDED.department_id,
  default_duration_minutes = EXCLUDED.default_duration_minutes,
  requires_appointment = EXCLUDED.requires_appointment,
  default_tariff_item_code = EXCLUDED.default_tariff_item_code,
  status = 'active',
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

COMMIT;
