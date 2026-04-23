-- Clinical Knowledge Graph.
--
-- Lightweight generic clinical knowledge graph over 9 node types (patient,
-- diagnosis, medication, lab, procedure, provider, encounter, payer,
-- organization) and 14 edge types (has_diagnosis, prescribed, ordered,
-- performed_by, administered_to, attributed_to, covered_by, affiliated_with,
-- belongs_to_encounter, treats, contraindicates, indicates, related_to,
-- caused_by). Stores nodes, edges, and periodic health reports that classify
-- graph completeness + anomalies (orphan nodes, missing critical edges,
-- contradictions, stale nodes). Review-only — data engineer approves
-- health-report fixes; the graph itself is never modified by this service
-- (ingest happens upstream).

CREATE TABLE IF NOT EXISTS clinical_ai_kg_nodes (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  node_type VARCHAR(40) NOT NULL
    CHECK (node_type IN ('patient', 'diagnosis', 'medication', 'lab', 'procedure', 'provider', 'encounter', 'payer', 'organization')),
  node_key VARCHAR(200) NOT NULL,
  display_name VARCHAR(200),
  source VARCHAR(80),
  source_ref VARCHAR(200),
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_kg_nodes_tenant_type_key
  ON clinical_ai_kg_nodes (tenant_id, node_type, node_key);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_tenant_type_created
  ON clinical_ai_kg_nodes (tenant_id, node_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_tenant_source_created
  ON clinical_ai_kg_nodes (tenant_id, source, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_kg_edges (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  edge_type VARCHAR(40) NOT NULL
    CHECK (edge_type IN ('has_diagnosis', 'prescribed', 'ordered', 'performed_by', 'administered_to', 'attributed_to', 'covered_by', 'affiliated_with', 'belongs_to_encounter', 'treats', 'contraindicates', 'indicates', 'related_to', 'caused_by')),
  from_node_id INTEGER NOT NULL REFERENCES clinical_ai_kg_nodes(id) ON DELETE CASCADE,
  to_node_id INTEGER NOT NULL REFERENCES clinical_ai_kg_nodes(id) ON DELETE CASCADE,
  source VARCHAR(80),
  source_ref VARCHAR(200),
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_kg_edges_tenant_type_from_to
  ON clinical_ai_kg_edges (tenant_id, edge_type, from_node_id, to_node_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_tenant_from_created
  ON clinical_ai_kg_edges (tenant_id, from_node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kg_edges_tenant_to_created
  ON clinical_ai_kg_edges (tenant_id, to_node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kg_edges_tenant_type_created
  ON clinical_ai_kg_edges (tenant_id, edge_type, created_at DESC);

CREATE TABLE IF NOT EXISTS clinical_ai_kg_health_reports (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  orphan_node_count INTEGER NOT NULL DEFAULT 0,
  missing_critical_edge_count INTEGER NOT NULL DEFAULT 0,
  contradiction_count INTEGER NOT NULL DEFAULT 0,
  stale_node_count INTEGER NOT NULL DEFAULT 0,
  completeness_pct NUMERIC(6,2) NOT NULL DEFAULT 100,
  overall_health VARCHAR(20) NOT NULL DEFAULT 'healthy'
    CHECK (overall_health IN ('healthy', 'watch', 'degraded', 'critical', 'unknown')),
  severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  anomalies JSONB NOT NULL DEFAULT '[]'::jsonb,
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

CREATE INDEX IF NOT EXISTS idx_kg_health_tenant_created
  ON clinical_ai_kg_health_reports (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kg_health_tenant_overall_severity_created
  ON clinical_ai_kg_health_reports (tenant_id, overall_health, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kg_health_tenant_decision_created
  ON clinical_ai_kg_health_reports (tenant_id, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('clinical_knowledge_graph',
   'Clinical Knowledge Graph',
   'Lightweight clinical knowledge graph over 9 node types (patient, diagnosis, medication, lab, procedure, provider, encounter, payer, organization) and 14 edge types (has_diagnosis, prescribed, ordered, performed_by, administered_to, attributed_to, covered_by, affiliated_with, belongs_to_encounter, treats, contraindicates, indicates, related_to, caused_by). Stores nodes + edges + periodic health reports. Health reports classify orphan nodes, missing critical edges, contradictions, stale nodes, and compute completeness %. Rules are authoritative; review-only — data engineer approves health-report fixes; the graph itself is never modified by this service (ingest happens upstream).',
   false,
   '{"surface":"governance","risk":"low","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["ADMIN","AI_EVAL_LEAD","DATA_ENGINEER"],"approvalPolicy":"data_engineer_review","outputSchema":{"type":"object","required":["overall_health","severity"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'clinical_knowledge_graph',
    'v1',
    'Clinical Knowledge Graph v1',
    'You support the clinical knowledge graph health review. Rules are authoritative: the overall_health (healthy / watch / degraded / critical / unknown) and severity are produced by a deterministic rule-based evaluator over the supplied node + edge counts and detected anomalies (orphan nodes, missing critical edges, contradictions, stale nodes, completeness %). Return JSON only. This module is data-engineer review only — it never modifies the graph itself; a data engineer approves health-report fixes and the ingest pipeline is the only path that changes nodes or edges.',
    'Given the knowledge-graph snapshot (node_count, edge_count, orphan_node_count, missing_critical_edge_count, contradiction_count, stale_node_count, completeness_pct) plus the rule-based overall_health, severity, and matched signals, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based overall_health or severity, and do not propose changes to individual nodes or edges — this module is review-only.',
    '{"type":"object","required":["overall_health","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
