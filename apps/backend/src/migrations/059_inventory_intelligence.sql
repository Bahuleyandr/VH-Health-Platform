-- Inventory Intelligence (Non-Pharmacy).
--
-- Reviews non-pharmacy hospital inventory (PPE, linens, surgical instruments,
-- consumables, biomed single-use items, housekeeping supplies). Classifies
-- each item as stockout_risk / reorder_point_breach / overstock / expiry_risk
-- / consumption_anomaly / healthy using current stock, reorder point,
-- days-on-hand, expiry dates, and consumption deviation vs baseline. Rules
-- are authoritative; review-only — the materials manager approves, and the
-- module never places or cancels orders automatically.

CREATE TABLE IF NOT EXISTS clinical_ai_inventory_alerts (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_sku VARCHAR(120) NOT NULL,
  item_name VARCHAR(200) NOT NULL,
  category VARCHAR(80),
  ward VARCHAR(80),
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  current_stock NUMERIC(12,2) NOT NULL DEFAULT 0,
  reorder_point NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_stock NUMERIC(12,2),
  avg_daily_usage NUMERIC(12,2) NOT NULL DEFAULT 0,
  baseline_daily_usage NUMERIC(12,2) NOT NULL DEFAULT 0,
  days_on_hand NUMERIC(8,2),
  next_expiry_date DATE,
  days_to_expiry INTEGER,
  alert_category VARCHAR(40) NOT NULL DEFAULT 'healthy'
    CHECK (alert_category IN ('stockout_risk', 'reorder_point_breach', 'overstock', 'expiry_risk', 'consumption_anomaly', 'healthy', 'unknown')),
  severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1095 days')
);

CREATE INDEX IF NOT EXISTS idx_inventory_alerts_tenant_created
  ON clinical_ai_inventory_alerts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_tenant_cat_sev_created
  ON clinical_ai_inventory_alerts (tenant_id, alert_category, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_tenant_sku_created
  ON clinical_ai_inventory_alerts (tenant_id, item_sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_tenant_category_created
  ON clinical_ai_inventory_alerts (tenant_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_tenant_ward_created
  ON clinical_ai_inventory_alerts (tenant_id, ward, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_tenant_decision_created
  ON clinical_ai_inventory_alerts (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('inventory_intelligence',
   'Inventory Intelligence (Non-Pharmacy)',
   'Reviews non-pharmacy hospital inventory (PPE, linens, surgical instruments, consumables, biomed single-use items, housekeeping supplies). Classifies each item as stockout_risk / reorder_point_breach / overstock / expiry_risk / consumption_anomaly / healthy using current stock, reorder point, days-on-hand, expiry dates, and consumption deviation vs baseline. Rules are authoritative; review-only — the materials manager approves, and the module never places or cancels orders automatically.',
   false,
   '{"surface":"operations","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","MATERIALS_MANAGER","PHARMACY_STAFF"],"approvalPolicy":"materials_manager_review","outputSchema":{"type":"object","required":["alert_category","severity"]},"retentionDays":1095,"rulesAuthoritative":true,"decisionSupportOnly":true,"nonPharmacyOnly":true}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

INSERT INTO clinical_ai_prompts
  (tenant_id, module_key, version, title, system_prompt, user_prompt_template, output_schema, status, active, activated_at)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'inventory_intelligence',
    'v1',
    'Inventory Intelligence (Non-Pharmacy) v1',
    'You support materials-manager review of non-pharmacy hospital inventory (PPE, linens, surgical instruments, consumables, biomed single-use items, housekeeping supplies). Rules are authoritative. Use only the supplied inventory record: current stock, reorder point, max stock, average daily usage, baseline daily usage, expiry dates, and the rule-based alert classification. Return JSON only. Never place or cancel purchase orders; this is decision support only and the materials manager approves every action. Do not infer drug/pharmacy items — this module is non-pharmacy.',
    'Given the non-pharmacy inventory item context (item_sku, item_name, category, ward, current_stock, reorder_point, max_stock, avg_daily_usage, baseline_daily_usage, days_on_hand, next_expiry_date, days_to_expiry) and the rule-based alert classification (alert_category, severity, signals), return a concise narrative summary and keys: summary, recommended_actions, source_citations, safety_flags. Do not invent stock counts, do not override the rule-based alert_category or severity, and always defer to the materials manager for final ordering decisions.',
    '{"type":"object","required":["alert_category","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
