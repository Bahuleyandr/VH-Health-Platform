-- Blood Bank Demand and Compatibility Forecast.
--
-- Projects blood-component demand (PRBC, FFP, platelets, cryoprecipitate,
-- whole blood) across a rolling window (default 24h) against current
-- inventory. Surfaces stock-out risk by blood group + component,
-- compatibility gaps, and massive transfusion protocol (MTP) readiness.
-- Review-only: blood bank / lab staff confirm and act. The service never
-- auto-orders units, never auto-issues units, and never alters crossmatch
-- or transfusion records. Rules are authoritative; decision support only.

-- ---------------------------------------------------------------------------
-- Table 1: Lightweight inventory snapshot per (tenant, group, component).
-- One row per tenant+group+component — the service UPSERTs running counts.
-- This table is a projection for the forecast engine; it does NOT replace
-- the existing blood_requests / crossmatch tables owned by the blood bank
-- service. When a full blood_bank_units table lands later, the forecast
-- can read from either source.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinical_ai_blood_bank_inventory_snapshots (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  blood_group VARCHAR(10) NOT NULL
    CHECK (blood_group IN ('O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-')),
  component VARCHAR(40) NOT NULL
    CHECK (component IN ('packed_red_cells', 'whole_blood', 'platelets', 'ffp', 'cryoprecipitate')),
  units_available INTEGER NOT NULL DEFAULT 0
    CHECK (units_available >= 0),
  units_committed INTEGER NOT NULL DEFAULT 0
    CHECK (units_committed >= 0),
  minimum_stock_level INTEGER NOT NULL DEFAULT 0,
  expires_earliest DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_blood_bank_inventory_tenant_group_component
  ON clinical_ai_blood_bank_inventory_snapshots (tenant_id, blood_group, component);
CREATE INDEX IF NOT EXISTS idx_blood_bank_inventory_tenant_updated
  ON clinical_ai_blood_bank_inventory_snapshots (tenant_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Table 2: Forecast reviews. One row per forecast generation; reviewer
-- (blood bank / lab staff) accepts, defers, rejects, or escalates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinical_ai_blood_bank_forecast_reviews (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  forecast_window_hours INTEGER NOT NULL DEFAULT 24
    CHECK (forecast_window_hours BETWEEN 1 AND 168),
  forecast_start TIMESTAMPTZ NOT NULL,
  forecast_end TIMESTAMPTZ NOT NULL,
  predicted_demand JSONB NOT NULL DEFAULT '[]'::jsonb,
  inventory_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  stockout_risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  mtp_readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'escalated')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1825 days')
);

CREATE INDEX IF NOT EXISTS idx_blood_bank_forecast_tenant_created
  ON clinical_ai_blood_bank_forecast_reviews (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blood_bank_forecast_tenant_risk_decision_created
  ON clinical_ai_blood_bank_forecast_reviews (tenant_id, risk_band, reviewer_decision, created_at DESC);

-- ---------------------------------------------------------------------------
-- Register the module in the global catalog. Disabled by default —
-- tenants must opt in, and clinicians/blood-bank staff are the reviewers.
-- ---------------------------------------------------------------------------
INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('blood_bank_demand_forecast',
   'Blood Bank Demand and Compatibility Forecast',
   'Projects blood component demand (PRBC, FFP, platelets, cryoprecipitate, whole blood) against current inventory across a rolling window, surfaces stock-out risk by blood group + component, and assesses massive transfusion protocol (MTP) readiness. Review-only: blood bank / lab staff confirm and act; the service never auto-orders, auto-issues, or alters crossmatch or transfusion records. Rules authoritative, decision-support only.',
   false,
   '{"surface":"blood_bank","risk":"high","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["BLOOD_BANK_STAFF","LAB_STAFF","DOCTOR","ADMIN"],"approvalPolicy":"blood_bank_review","outputSchema":{"type":"object","required":["predicted_demand","risk_band","stockout_risks"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'blood_bank_demand_forecast',
    'v1',
    'Blood Bank Demand and Compatibility Forecast v1',
    'You support blood bank / lab staff review of near-term blood component demand vs. inventory. Rules are authoritative. Use only the supplied inventory snapshot, upcoming procedure list, and rule-based stock-out risk projections. Return JSON only. Never recommend issuing, reserving, or ordering units — review is human-led. Always include the decision-support disclaimer.',
    'Given the inventory snapshot (by blood group + component), the upcoming procedure list (with scheduled times and indications), and the rule-derived stock-out risk projections + MTP readiness check, return keys: summary, predicted_demand, stockout_risks, mtp_readiness, recommendations, source_citations, safety_flags. Keep recommendations advisory (e.g., "consider crossmatching additional O- units before elective cardiac case at 09:00"). Do not invent demand for procedures not present in the supplied list. If procedure data is missing, defer to human review rather than assuming baseline demand.',
    '{"type":"object","required":["predicted_demand","risk_band","stockout_risks"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
