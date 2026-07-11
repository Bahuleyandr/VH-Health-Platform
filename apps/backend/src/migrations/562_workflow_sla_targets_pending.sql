-- NL-13 P1c: permit owner-target-pending SLA evidence without inventing a
-- breach threshold and preserve a genuinely pending door clock for a
-- pre-hospital activation. NULL clock fields are valid only when metadata
-- explicitly records why the clock cannot yet be calculated.

BEGIN;

ALTER TABLE workflow_sla_instances
  ALTER COLUMN started_at DROP NOT NULL,
  ALTER COLUMN due_at DROP NOT NULL;

ALTER TABLE workflow_sla_instances
  DROP CONSTRAINT IF EXISTS workflow_sla_instances_start_or_clock_pending_chk;

ALTER TABLE workflow_sla_instances
  ADD CONSTRAINT workflow_sla_instances_start_or_clock_pending_chk
  CHECK (
    started_at IS NOT NULL
    OR (
      source_table = 'stemi_activations'
      AND rule_code IN (
        'stemi_door_to_ecg',
        'stemi_door_to_lab',
        'stemi_door_to_balloon'
      )
      AND metadata @> '{"clock_start_pending": true}'::jsonb
    )
  );

ALTER TABLE workflow_sla_instances
  DROP CONSTRAINT IF EXISTS workflow_sla_instances_due_or_targets_pending_chk;

ALTER TABLE workflow_sla_instances
  ADD CONSTRAINT workflow_sla_instances_due_or_targets_pending_chk
  CHECK (
    due_at IS NOT NULL
    OR (
      source_table = 'stemi_activations'
      AND rule_code IN (
        'stemi_door_to_ecg',
        'stemi_door_to_lab',
        'stemi_door_to_balloon'
      )
      AND (
        metadata @> '{"targets_pending": true}'::jsonb
        OR metadata @> '{"clock_start_pending": true}'::jsonb
      )
    )
  );

ALTER TABLE workflow_sla_instances
  DROP CONSTRAINT IF EXISTS workflow_sla_instances_targets_pending_not_breached_chk;

ALTER TABLE workflow_sla_instances
  ADD CONSTRAINT workflow_sla_instances_targets_pending_not_breached_chk
  CHECK (
    NOT (metadata @> '{"targets_pending": true}'::jsonb)
    OR (status <> 'breached' AND breached_at IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_workflow_sla_instances_targets_pending
  ON workflow_sla_instances (tenant_id, rule_code, started_at DESC)
  WHERE source_table = 'stemi_activations'
    AND rule_code IN ('stemi_door_to_ecg', 'stemi_door_to_lab', 'stemi_door_to_balloon')
    AND due_at IS NULL
    AND metadata @> '{"targets_pending": true}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_workflow_sla_instances_clock_start_pending
  ON workflow_sla_instances (tenant_id, rule_code, created_at DESC)
  WHERE source_table = 'stemi_activations'
    AND rule_code IN ('stemi_door_to_ecg', 'stemi_door_to_lab', 'stemi_door_to_balloon')
    AND started_at IS NULL
    AND metadata @> '{"clock_start_pending": true}'::jsonb;

COMMIT;
