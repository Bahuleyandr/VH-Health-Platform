-- Procurement Negotiation Assistant.
--
-- Hospital procurement decision-support for non-pharmacy and pharmacy line
-- items. Given SKU, vendor, current unit price, historical baseline, quoted
-- alternatives, annual volume, vendor count for the category, and contract
-- tenure/end date, classifies opportunities as price_anomaly /
-- volume_consolidation / tenure_leverage / alternatives_available /
-- expiring_contract / no_action and estimates annual savings potential.
-- Rules are authoritative; review-only — the procurement lead negotiates,
-- and the module never contacts vendors, places orders, or modifies
-- contracts.

CREATE TABLE IF NOT EXISTS clinical_ai_procurement_opportunities (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_sku VARCHAR(120) NOT NULL,
  item_name VARCHAR(200) NOT NULL,
  category VARCHAR(80),
  vendor_name VARCHAR(200),
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  current_unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  historical_avg_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  historical_min_price NUMERIC(12,2),
  quoted_alternative_price NUMERIC(12,2),
  annual_volume NUMERIC(12,2) NOT NULL DEFAULT 0,
  vendor_count_for_category INTEGER NOT NULL DEFAULT 1,
  contract_tenure_months INTEGER,
  contract_end_date DATE,
  price_delta_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
  alternative_savings_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
  estimated_annual_savings NUMERIC(12,2) NOT NULL DEFAULT 0,
  opportunity_category VARCHAR(40) NOT NULL DEFAULT 'no_action'
    CHECK (opportunity_category IN ('price_anomaly', 'volume_consolidation', 'tenure_leverage', 'alternatives_available', 'expiring_contract', 'no_action', 'unknown')),
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1825 days')
);

CREATE INDEX IF NOT EXISTS idx_procurement_opps_tenant_created
  ON clinical_ai_procurement_opportunities (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_opps_tenant_cat_sev_created
  ON clinical_ai_procurement_opportunities (tenant_id, opportunity_category, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_opps_tenant_sku_created
  ON clinical_ai_procurement_opportunities (tenant_id, item_sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_opps_tenant_category_created
  ON clinical_ai_procurement_opportunities (tenant_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_opps_tenant_vendor_created
  ON clinical_ai_procurement_opportunities (tenant_id, vendor_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_opps_tenant_decision_created
  ON clinical_ai_procurement_opportunities (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('procurement_negotiation_assistant',
   'Procurement Negotiation Assistant',
   'Hospital procurement decision-support for non-pharmacy and pharmacy line items. Given SKU, vendor, current unit price, historical baseline, quoted alternatives, annual volume, vendor count for the category, and contract tenure/end date, classifies opportunities as price_anomaly / volume_consolidation / tenure_leverage / alternatives_available / expiring_contract / no_action and estimates annual savings potential. Rules are authoritative; review-only — the procurement lead negotiates, and the module never contacts vendors, places orders, or modifies contracts.',
   false,
   '{"surface":"operations","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","PROCUREMENT_LEAD","MATERIALS_MANAGER"],"approvalPolicy":"procurement_lead_review","outputSchema":{"type":"object","required":["opportunity_category","severity"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'procurement_negotiation_assistant',
    'v1',
    'Procurement Negotiation Assistant v1',
    'You support hospital procurement-lead review of line items (non-pharmacy and pharmacy). Rules are authoritative. Use only the supplied procurement record: SKU, vendor, current unit price, historical average and minimum price, quoted alternative price, annual volume, vendor count for the category, contract tenure months, and contract end date. Return JSON only. Never contact vendors, never place or cancel purchase orders, never modify contracts — this is decision support only and the procurement lead negotiates every action.',
    'Given the procurement item context (item_sku, item_name, category, vendor_name, current_unit_price, historical_avg_price, historical_min_price, quoted_alternative_price, annual_volume, vendor_count_for_category, contract_tenure_months, contract_end_date) and the rule-based classification (opportunity_category, severity, signals, price_delta_pct, alternative_savings_pct, estimated_annual_savings), return a concise narrative summary and keys: summary, recommended_actions, source_citations, safety_flags. Do not invent prices or contract terms, do not override the rule-based opportunity_category or severity, and always defer to the procurement lead for negotiation decisions.',
    '{"type":"object","required":["opportunity_category","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
