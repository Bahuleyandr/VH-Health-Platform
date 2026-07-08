-- Migration 414: Mortuary body custody chain and unclaimed-body escalation seed.
--
-- Body custody is append-only and hooks to death_records. Release continues to
-- use migration 167's death_records release fields and medicolegal gate.

BEGIN;

CREATE TABLE IF NOT EXISTS body_custody_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  death_record_id INTEGER NOT NULL REFERENCES death_records(id) ON DELETE CASCADE,
  slot_id BIGINT REFERENCES mortuary_slots(id) ON DELETE SET NULL,
  event_type VARCHAR(30) NOT NULL
    CHECK (event_type IN ('receive', 'store', 'release')),
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  performed_by UUID,
  performed_by_role VARCHAR(80),
  witness_name VARCHAR(160),
  witness_uid UUID,
  witness_id_proof VARCHAR(80),
  claimant_name VARCHAR(160),
  claimant_relation VARCHAR(80),
  claimant_contact VARCHAR(80),
  is_unclaimed BOOLEAN NOT NULL DEFAULT false,
  unclaimed_reason TEXT,
  release_method VARCHAR(40)
    CHECK (release_method IS NULL OR release_method IN ('family', 'mortuary_van', 'unclaimed_to_municipality')),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_body_custody_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT body_custody_release_has_method
    CHECK (event_type <> 'release' OR release_method IS NOT NULL),
  CONSTRAINT body_custody_store_has_slot
    CHECK (event_type <> 'store' OR slot_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_body_custody_events_record
  ON body_custody_events (tenant_id, death_record_id, event_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_body_custody_events_slot
  ON body_custody_events (tenant_id, slot_id, event_at DESC)
  WHERE slot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_body_custody_events_unclaimed
  ON body_custody_events (tenant_id, event_at DESC)
  WHERE is_unclaimed = true;

CREATE OR REPLACE FUNCTION prevent_body_custody_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'body_custody_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_body_custody_events_append_only ON body_custody_events;
CREATE TRIGGER trg_body_custody_events_append_only
  BEFORE UPDATE ON body_custody_events
  FOR EACH ROW EXECUTE FUNCTION prevent_body_custody_event_mutation();

ALTER TABLE body_custody_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE body_custody_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON body_custody_events;
CREATE POLICY tenant_isolation ON body_custody_events
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

INSERT INTO workflow_sla_rules
  (rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, metadata)
VALUES
  ('mortuary_unclaimed_body', 'Unclaimed body custody follow-up', 'mortuary.body_received', 1440, 'high',
   ARRAY['MEDICAL_RECORDS']::TEXT[],
   ARRAY['DEPARTMENT_HEAD', 'CMO', 'MEDICAL_SUPERINTENDENT']::TEXT[],
   '{"description":"Escalates bodies received into mortuary custody without a claimant or release plan."}'::jsonb)
ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), rule_code)
DO UPDATE SET
  title = EXCLUDED.title,
  trigger_event_type = EXCLUDED.trigger_event_type,
  target_minutes = EXCLUDED.target_minutes,
  severity = EXCLUDED.severity,
  owner_role_codes = EXCLUDED.owner_role_codes,
  escalation_role_codes = EXCLUDED.escalation_role_codes,
  metadata = EXCLUDED.metadata,
  enabled = TRUE,
  updated_at = NOW();

INSERT INTO escalation_rules
  (tenant_id, display_name, description, scope, match_filter, trigger_condition,
   trigger_window_minutes, action_kind, action_payload, is_active)
SELECT '00000000-0000-4000-8000-000000000001'::uuid, v.display_name, v.description,
       'task', v.match_filter::jsonb, 'sla_breach', v.win, 'notify', v.action_payload::jsonb, true
FROM (VALUES
  ('Mortuary unclaimed body T1 notify', 'Notify medical records when a body becomes unclaimed past SLA',
     '{"task_kind":"review","sla_key":"mortuary_unclaimed_body"}', 0,
     '{"tier":1,"notify_role":"MEDICAL_RECORDS"}'),
  ('Mortuary unclaimed body T2 department head', 'Escalate unclaimed body custody to the department head',
     '{"task_kind":"review","sla_key":"mortuary_unclaimed_body"}', 720,
     '{"tier":2,"notify_role":"DEPARTMENT_HEAD"}'),
  ('Mortuary unclaimed body T3 leadership', 'Escalate unresolved unclaimed body custody to leadership',
     '{"task_kind":"review","sla_key":"mortuary_unclaimed_body"}', 1440,
     '{"tier":3,"notify_role":"LEADERSHIP","security_webhook":true}')
) AS v(display_name, description, match_filter, win, action_payload)
WHERE NOT EXISTS (
  SELECT 1 FROM escalation_rules e
  WHERE e.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
    AND e.display_name = v.display_name
);

COMMIT;
