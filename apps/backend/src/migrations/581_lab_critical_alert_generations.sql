-- Migration 581: durable generations for corrected critical lab alerts.
--
-- A corrected/amended result is a new acknowledgement obligation even when
-- the prior alert was still open. Supersession is distinct from clinician
-- acknowledgement: acknowledged_at remains reserved for an actual read-back.

BEGIN;

ALTER TABLE lab_critical_alerts
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by_alert_id INTEGER,
  ADD COLUMN IF NOT EXISTS superseded_by_signoff_id INTEGER,
  ADD COLUMN IF NOT EXISTS generation_signoff_id INTEGER,
  ADD COLUMN IF NOT EXISTS acknowledgement_task_id INTEGER,
  ADD COLUMN IF NOT EXISTS generation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE lab_critical_alerts
  DROP CONSTRAINT IF EXISTS fk_lab_critical_alert_superseded_by_alert,
  DROP CONSTRAINT IF EXISTS fk_lab_critical_alert_superseded_by_signoff,
  DROP CONSTRAINT IF EXISTS fk_lab_critical_alert_generation_signoff,
  DROP CONSTRAINT IF EXISTS fk_lab_critical_alert_acknowledgement_task,
  DROP CONSTRAINT IF EXISTS fk_lab_critical_alert_result_patient_tenant,
  DROP CONSTRAINT IF EXISTS lab_critical_alerts_result_id_fkey,
  DROP CONSTRAINT IF EXISTS ex_lab_critical_alert_one_current,
  DROP CONSTRAINT IF EXISTS ex_lab_critical_alert_ack_task;

-- Remove the superseded immediate invariant before any rerun bridge work.
-- The replacement exclusion constraint is transaction-deferred.
DROP INDEX IF EXISTS ux_lab_critical_alert_current_generation;

-- A direct rerun is also a rolling-upgrade reconciliation pass. Remove the
-- 581 guards before evidence-backed bridge writes, then recreate them below.
DROP TRIGGER IF EXISTS trg_validate_lab_critical_alert_supersession
  ON lab_critical_alerts;
DROP TRIGGER IF EXISTS trg_validate_lab_critical_alert_generation_binding
  ON lab_critical_alerts;
DROP TRIGGER IF EXISTS trg_protect_lab_critical_alert_generation_provenance
  ON lab_critical_alerts;
DROP TRIGGER IF EXISTS trg_protect_lab_critical_alert_signoff_dependency
  ON lab_pathologist_signoffs;
DROP TRIGGER IF EXISTS trg_protect_lab_critical_alert_task_dependency ON tasks;
DROP TRIGGER IF EXISTS trg_protect_lab_critical_alert_sla_dependency
  ON workflow_sla_instances;
DROP FUNCTION IF EXISTS reconcile_legacy_lab_critical_alert_generations();

ALTER TABLE lab_critical_alerts
  DROP CONSTRAINT IF EXISTS chk_lab_critical_alert_supersession_complete,
  ADD CONSTRAINT chk_lab_critical_alert_supersession_complete CHECK (
    (superseded_at IS NULL
      AND superseded_by_alert_id IS NULL
      AND superseded_by_signoff_id IS NULL)
    OR
    (superseded_at IS NOT NULL
      AND superseded_by_alert_id IS NOT NULL
      AND superseded_by_signoff_id IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS chk_lab_critical_alert_not_self_superseded,
  ADD CONSTRAINT chk_lab_critical_alert_not_self_superseded CHECK (
    superseded_by_alert_id IS NULL OR superseded_by_alert_id <> id
  ),
  DROP CONSTRAINT IF EXISTS chk_lab_critical_alert_generation_metadata_object,
  ADD CONSTRAINT chk_lab_critical_alert_generation_metadata_object CHECK (
    jsonb_typeof(generation_metadata) = 'object'
  ),
  DROP CONSTRAINT IF EXISTS chk_lab_critical_alert_generation_binding_complete,
  ADD CONSTRAINT chk_lab_critical_alert_generation_binding_complete CHECK (
    generation_signoff_id IS NULL OR acknowledgement_task_id IS NOT NULL
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_critical_alerts'::regclass
       AND conname = 'ux_lab_critical_alerts_tenant_id'
  ) THEN
    ALTER TABLE lab_critical_alerts
      ADD CONSTRAINT ux_lab_critical_alerts_tenant_id UNIQUE (tenant_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_pathologist_signoffs'::regclass
       AND conname = 'ux_lab_pathologist_signoffs_tenant_id'
  ) THEN
    ALTER TABLE lab_pathologist_signoffs
      ADD CONSTRAINT ux_lab_pathologist_signoffs_tenant_id UNIQUE (tenant_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_pathologist_signoffs'::regclass
       AND conname = 'ux_lab_pathologist_signoffs_tenant_id_patient'
  ) THEN
    ALTER TABLE lab_pathologist_signoffs
      ADD CONSTRAINT ux_lab_pathologist_signoffs_tenant_id_patient
        UNIQUE (tenant_id, id, patient_uid);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_results'::regclass
       AND conname = 'ux_lab_results_tenant_id_patient'
  ) THEN
    ALTER TABLE lab_results
      ADD CONSTRAINT ux_lab_results_tenant_id_patient
        UNIQUE (tenant_id, id, patient_uid);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lab_critical_thresholds'::regclass
       AND conname = 'ux_lab_critical_thresholds_tenant_id'
  ) THEN
    ALTER TABLE lab_critical_thresholds
      ADD CONSTRAINT ux_lab_critical_thresholds_tenant_id
        UNIQUE (tenant_id, id);
  END IF;
END
$$;

-- A corrected/amended sign-off that legitimately creates no alert still needs
-- immutable, per-sign-off evidence. This table also records historical gaps
-- found after old replicas have drained; those rows point at the later typed
-- alert/receipt that superseded the missed window and never claim an ACK.
CREATE TABLE IF NOT EXISTS lab_critical_alert_reconciliation_receipts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  result_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  signoff_id INTEGER NOT NULL,
  signoff_decision VARCHAR(20) NOT NULL,
  signoff_signed_at TIMESTAMPTZ(6) NOT NULL,
  outcome VARCHAR(64) NOT NULL,
  source VARCHAR(100) NOT NULL,
  result_value_text VARCHAR(255),
  result_value_numeric NUMERIC(15, 4),
  result_unit VARCHAR(40),
  evaluated_value NUMERIC(15, 4),
  threshold_id INTEGER,
  threshold_test_code VARCHAR(50),
  threshold_loinc_code VARCHAR(20),
  threshold_low NUMERIC(15, 4),
  threshold_high NUMERIC(15, 4),
  threshold_unit VARCHAR(40),
  threshold_applies_to VARCHAR(20),
  threshold_conversion VARCHAR(100),
  successor_signoff_id INTEGER,
  successor_alert_id INTEGER,
  successor_receipt_id BIGINT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_lab_alert_receipt_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_lab_alert_receipt_result_signoff
    UNIQUE (tenant_id, result_id, signoff_id),
  CONSTRAINT fk_lab_alert_receipt_result
    FOREIGN KEY (tenant_id, result_id, patient_uid)
    REFERENCES lab_results (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_alert_receipt_signoff
    FOREIGN KEY (tenant_id, signoff_id, patient_uid)
    REFERENCES lab_pathologist_signoffs (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_alert_receipt_threshold
    FOREIGN KEY (tenant_id, threshold_id)
    REFERENCES lab_critical_thresholds (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_alert_receipt_successor_signoff
    FOREIGN KEY (tenant_id, successor_signoff_id, patient_uid)
    REFERENCES lab_pathologist_signoffs (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_alert_receipt_successor_alert
    FOREIGN KEY (tenant_id, successor_alert_id)
    REFERENCES lab_critical_alerts (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_alert_receipt_successor_receipt
    FOREIGN KEY (tenant_id, successor_receipt_id)
    REFERENCES lab_critical_alert_reconciliation_receipts (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_lab_alert_receipt_decision CHECK (
    signoff_decision IN ('corrected', 'amended')
  ),
  CONSTRAINT chk_lab_alert_receipt_evidence_object CHECK (
    jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT chk_lab_alert_receipt_source_nonblank CHECK (
    NULLIF(BTRIM(source), '') IS NOT NULL
  ),
  CONSTRAINT chk_lab_alert_receipt_outcome CHECK (
    outcome IN (
      'within_active_critical_thresholds',
      'no_active_critical_threshold',
      'superseded_by_later_generation'
    )
  ),
  CONSTRAINT chk_lab_alert_receipt_resolution_shape CHECK (
    (
      outcome = 'within_active_critical_thresholds'
      AND threshold_id IS NOT NULL
      AND evaluated_value IS NOT NULL
      AND successor_signoff_id IS NULL
      AND successor_alert_id IS NULL
      AND successor_receipt_id IS NULL
    )
    OR
    (
      outcome = 'no_active_critical_threshold'
      AND threshold_id IS NULL
      AND successor_signoff_id IS NULL
      AND successor_alert_id IS NULL
      AND successor_receipt_id IS NULL
    )
    OR
    (
      outcome = 'superseded_by_later_generation'
      AND successor_signoff_id IS NOT NULL
      AND successor_signoff_id > signoff_id
      AND num_nonnulls(successor_alert_id, successor_receipt_id) = 1
      AND threshold_id IS NULL
      AND evaluated_value IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_lab_alert_receipt_tenant_created
  ON lab_critical_alert_reconciliation_receipts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_alert_receipt_successor_signoff
  ON lab_critical_alert_reconciliation_receipts
     (tenant_id, successor_signoff_id)
  WHERE successor_signoff_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_lab_critical_alert_reconciliation_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  signoff_row RECORD;
  result_row RECORD;
  threshold_row RECORD;
  successor_count INTEGER;
BEGIN
  SELECT signoff.id, signoff.decision, signoff.signed_at, signoff.result_ids
    INTO signoff_row
    FROM lab_pathologist_signoffs AS signoff
   WHERE signoff.tenant_id = NEW.tenant_id
     AND signoff.id = NEW.signoff_id
     AND signoff.patient_uid = NEW.patient_uid;
  IF NOT FOUND
     OR NEW.result_id <> ALL(signoff_row.result_ids)
     OR signoff_row.decision IS DISTINCT FROM NEW.signoff_decision
     OR signoff_row.signed_at IS DISTINCT FROM NEW.signoff_signed_at THEN
    RAISE EXCEPTION 'invalid critical-alert reconciliation sign-off binding'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.outcome IN (
    'within_active_critical_thresholds',
    'no_active_critical_threshold'
  ) THEN
    SELECT result.value_text, result.value_numeric, result.unit
      INTO result_row
      FROM lab_results AS result
     WHERE result.tenant_id = NEW.tenant_id
       AND result.id = NEW.result_id
       AND result.patient_uid = NEW.patient_uid;
    IF NOT FOUND
       OR result_row.value_text IS DISTINCT FROM NEW.result_value_text
       OR result_row.value_numeric IS DISTINCT FROM NEW.result_value_numeric
       OR result_row.unit IS DISTINCT FROM NEW.result_unit THEN
      RAISE EXCEPTION 'invalid critical-alert reconciliation result snapshot'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.outcome = 'within_active_critical_thresholds' THEN
    SELECT threshold.test_code, threshold.loinc_code, threshold.critical_low,
           threshold.critical_high, threshold.unit, threshold.applies_to
      INTO threshold_row
      FROM lab_critical_thresholds AS threshold
     WHERE threshold.tenant_id = NEW.tenant_id
       AND threshold.id = NEW.threshold_id;
    IF NOT FOUND
       OR threshold_row.test_code IS DISTINCT FROM NEW.threshold_test_code
       OR threshold_row.loinc_code IS DISTINCT FROM NEW.threshold_loinc_code
       OR threshold_row.critical_low IS DISTINCT FROM NEW.threshold_low
       OR threshold_row.critical_high IS DISTINCT FROM NEW.threshold_high
       OR threshold_row.unit IS DISTINCT FROM NEW.threshold_unit
       OR threshold_row.applies_to IS DISTINCT FROM NEW.threshold_applies_to THEN
      RAISE EXCEPTION 'invalid critical-alert reconciliation threshold snapshot'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.outcome = 'superseded_by_later_generation' THEN
    IF NEW.successor_alert_id IS NOT NULL THEN
      SELECT COUNT(*)::int
        INTO successor_count
        FROM lab_critical_alerts AS alert
       WHERE alert.tenant_id = NEW.tenant_id
         AND alert.id = NEW.successor_alert_id
         AND alert.result_id = NEW.result_id
         AND alert.patient_uid = NEW.patient_uid
         AND alert.generation_signoff_id = NEW.successor_signoff_id;
    ELSE
      SELECT COUNT(*)::int
        INTO successor_count
        FROM lab_critical_alert_reconciliation_receipts AS receipt
       WHERE receipt.tenant_id = NEW.tenant_id
         AND receipt.id = NEW.successor_receipt_id
         AND receipt.result_id = NEW.result_id
         AND receipt.patient_uid = NEW.patient_uid
         AND receipt.signoff_id = NEW.successor_signoff_id;
    END IF;
    IF successor_count <> 1 THEN
      RAISE EXCEPTION 'invalid critical-alert reconciliation successor binding'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_lab_alert_reconciliation_receipt
  ON lab_critical_alert_reconciliation_receipts;
CREATE CONSTRAINT TRIGGER trg_validate_lab_alert_reconciliation_receipt
AFTER INSERT
ON lab_critical_alert_reconciliation_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_lab_critical_alert_reconciliation_receipt();

CREATE OR REPLACE FUNCTION protect_lab_critical_alert_reconciliation_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'critical-alert reconciliation receipts are append-only'
    USING ERRCODE = '23514';
END
$$;

DROP TRIGGER IF EXISTS trg_protect_lab_alert_reconciliation_receipt
  ON lab_critical_alert_reconciliation_receipts;
CREATE TRIGGER trg_protect_lab_alert_reconciliation_receipt
BEFORE UPDATE OR DELETE
ON lab_critical_alert_reconciliation_receipts
FOR EACH ROW
EXECUTE FUNCTION protect_lab_critical_alert_reconciliation_receipt();

ALTER TABLE lab_critical_alert_reconciliation_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_critical_alert_reconciliation_receipts
  FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation
  ON lab_critical_alert_reconciliation_receipts;
CREATE POLICY tenant_isolation
ON lab_critical_alert_reconciliation_receipts
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

DO $$
DECLARE
  mismatch RECORD;
BEGIN
  SELECT alert.tenant_id, alert.id AS alert_id, alert.result_id, alert.patient_uid
    INTO mismatch
    FROM lab_critical_alerts AS alert
    LEFT JOIN lab_results AS result
      ON result.tenant_id = alert.tenant_id
     AND result.id = alert.result_id
     AND result.patient_uid = alert.patient_uid
   WHERE result.id IS NULL
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'critical-alert result identity reconciliation required: tenant=%, alert=%, result=%, patient=%',
      mismatch.tenant_id, mismatch.alert_id, mismatch.result_id, mismatch.patient_uid
      USING ERRCODE = '23514';
  END IF;
END
$$;

ALTER TABLE lab_critical_alerts
  ADD CONSTRAINT fk_lab_critical_alert_superseded_by_alert
    FOREIGN KEY (tenant_id, superseded_by_alert_id)
    REFERENCES lab_critical_alerts (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_lab_critical_alert_superseded_by_signoff
    FOREIGN KEY (tenant_id, superseded_by_signoff_id)
    REFERENCES lab_pathologist_signoffs (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_lab_critical_alert_generation_signoff
    FOREIGN KEY (tenant_id, generation_signoff_id)
    REFERENCES lab_pathologist_signoffs (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_lab_critical_alert_acknowledgement_task
    FOREIGN KEY (tenant_id, acknowledgement_task_id)
    REFERENCES tasks (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_lab_critical_alert_result_patient_tenant
    FOREIGN KEY (tenant_id, result_id, patient_uid)
    REFERENCES lab_results (tenant_id, id, patient_uid)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

-- A typed alert is retained clinical evidence. Deleting its result must fail;
-- the provenance guard below also rejects deleting the alert itself.

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_tenant_id_for_lab_ack_receipt
  ON tasks (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_comments_tenant_id_for_lab_ack_receipt
  ON task_comments (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_clinical_timeline_tenant_id_for_lab_ack_receipt
  ON clinical_timeline_events (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_clinical_audit_tenant_id_for_lab_ack_receipt
  ON clinical_audit_events (tenant_id, id);

-- One immutable receipt per acknowledged alert generation.  The SLA instance
-- is intentionally not unique here: corrected results reuse the resource SLA,
-- while this row preserves each generation's exact closed-clock snapshot.
-- Override reasons remain on the already-audited source rows; this table stores
-- only their digest and therefore introduces no additional plaintext PHI.
CREATE TABLE IF NOT EXISTS lab_critical_alert_acknowledgement_receipts (
  tenant_id UUID NOT NULL,
  alert_id INTEGER NOT NULL,
  result_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  generation_signoff_id INTEGER,
  generation_state VARCHAR(64) NOT NULL,
  acknowledgement_task_id INTEGER NOT NULL,
  workflow_sla_instance_id UUID NOT NULL,
  task_comment_id INTEGER NOT NULL,
  timeline_event_id UUID NOT NULL,
  audit_event_id UUID NOT NULL,
  acknowledged_at TIMESTAMPTZ(6) NOT NULL,
  acknowledged_by UUID NOT NULL,
  acknowledgement_authorization VARCHAR(20) NOT NULL,
  read_back_method VARCHAR(160),
  task_status_at_ack VARCHAR(20) NOT NULL,
  comment_from_status VARCHAR(20) NOT NULL,
  sla_status_at_ack VARCHAR(40) NOT NULL,
  sla_completed_at TIMESTAMPTZ(6) NOT NULL,
  sla_completed_via VARCHAR(40) NOT NULL,
  sla_completed_by_task INTEGER NOT NULL,
  sla_completed_by UUID NOT NULL,
  override_source VARCHAR(120),
  override_id VARCHAR(120),
  override_reason_sha256 CHAR(64),
  ack_contract_version SMALLINT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_lab_critical_alert_ack_receipt
    PRIMARY KEY (tenant_id, alert_id),
  CONSTRAINT ux_lab_critical_alert_ack_receipt_task
    UNIQUE (tenant_id, acknowledgement_task_id),
  CONSTRAINT ux_lab_critical_alert_ack_receipt_comment
    UNIQUE (tenant_id, task_comment_id),
  CONSTRAINT ux_lab_critical_alert_ack_receipt_timeline
    UNIQUE (tenant_id, timeline_event_id),
  CONSTRAINT ux_lab_critical_alert_ack_receipt_audit
    UNIQUE (tenant_id, audit_event_id),
  CONSTRAINT fk_lab_critical_alert_ack_receipt_alert
    FOREIGN KEY (tenant_id, alert_id)
    REFERENCES lab_critical_alerts (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_critical_alert_ack_receipt_result
    FOREIGN KEY (tenant_id, result_id, patient_uid)
    REFERENCES lab_results (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_critical_alert_ack_receipt_signoff
    FOREIGN KEY (tenant_id, generation_signoff_id)
    REFERENCES lab_pathologist_signoffs (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_critical_alert_ack_receipt_task
    FOREIGN KEY (tenant_id, acknowledgement_task_id)
    REFERENCES tasks (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_critical_alert_ack_receipt_sla
    FOREIGN KEY (tenant_id, workflow_sla_instance_id)
    REFERENCES workflow_sla_instances (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_critical_alert_ack_receipt_comment
    FOREIGN KEY (tenant_id, task_comment_id)
    REFERENCES task_comments (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_critical_alert_ack_receipt_timeline
    FOREIGN KEY (tenant_id, timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_lab_critical_alert_ack_receipt_audit
    FOREIGN KEY (tenant_id, audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_lab_critical_alert_ack_receipt_contract CHECK (
    ack_contract_version = 2
  ),
  CONSTRAINT chk_lab_critical_alert_ack_receipt_authorization CHECK (
    acknowledgement_authorization IN ('assignee', 'role', 'admin', 'override')
  ),
  CONSTRAINT chk_lab_critical_alert_ack_receipt_task_status CHECK (
    task_status_at_ack IN ('in_progress', 'completed')
  ),
  CONSTRAINT chk_lab_critical_alert_ack_receipt_comment_from CHECK (
    comment_from_status IN ('open', 'overdue', 'blocked')
  ),
  CONSTRAINT chk_lab_critical_alert_ack_receipt_sla_status CHECK (
    sla_status_at_ack IN ('completed', 'breached', 'escalated')
  ),
  CONSTRAINT chk_lab_critical_alert_ack_receipt_sla_semantics CHECK (
    sla_completed_at = acknowledged_at
    AND sla_completed_via = 'task_ack'
    AND sla_completed_by_task = acknowledgement_task_id
    AND sla_completed_by = acknowledged_by
  ),
  CONSTRAINT chk_lab_critical_alert_ack_receipt_override CHECK (
    (
      acknowledgement_authorization <> 'override'
      AND num_nonnulls(override_source, override_id, override_reason_sha256) = 0
    )
    OR
    (
      acknowledgement_authorization = 'override'
      AND override_source = 'patient_access_break_glass'
      AND NULLIF(BTRIM(override_id), '') IS NOT NULL
      AND override_reason_sha256 ~ '^[0-9a-f]{64}$'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_lab_critical_alert_ack_receipt_sla
  ON lab_critical_alert_acknowledgement_receipts
     (tenant_id, workflow_sla_instance_id, acknowledged_at DESC);

ALTER TABLE lab_critical_alert_acknowledgement_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_critical_alert_acknowledgement_receipts
  FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation
  ON lab_critical_alert_acknowledgement_receipts;
CREATE POLICY tenant_isolation
ON lab_critical_alert_acknowledgement_receipts
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

-- An acknowledged pre-581 alert is the dangerous historical split: the old
-- route could stamp the alert after a broad clinical-staff check while a task
-- acknowledgement independently stopped its SLA.  Never infer that the two
-- writes were authorized merely because their actor and timestamps resemble
-- one another.  Contract v2 is emitted only by the exact alert-bound task
-- acknowledgement transaction and is repeated on every durable receipt.
CREATE OR REPLACE FUNCTION resolve_lab_critical_alert_current_closed_ack_task(
  p_tenant_id UUID,
  p_alert_id INTEGER,
  p_expected_task_id INTEGER DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  alert_row lab_critical_alerts%ROWTYPE;
  matched_task_id INTEGER;
  matched_task_count INTEGER;
BEGIN
  SELECT *
    INTO alert_row
    FROM lab_critical_alerts AS alert
   WHERE alert.tenant_id = p_tenant_id
     AND alert.id = p_alert_id;

  IF NOT FOUND
     OR alert_row.acknowledged_at IS NULL
     OR alert_row.acknowledged_by IS NULL
     OR alert_row.acknowledged_at < alert_row.fired_at THEN
    RAISE EXCEPTION
      'critical-alert acknowledged binding reconciliation required: tenant=%, alert=%, reason=invalid_alert_ack_receipt',
      p_tenant_id, p_alert_id
      USING ERRCODE = '23514';
  END IF;

  WITH exact_candidates AS (
    SELECT task.id
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.tenant_id = alert_row.tenant_id
       AND (p_expected_task_id IS NULL OR task.id = p_expected_task_id)
       AND task.patient_uid = alert_row.patient_uid
       AND task.related_resource_type = 'lab_result'
       AND task.related_resource_id = alert_row.result_id::text
       AND task.sla_completion_semantics = 'acknowledgement'
       AND task.status IN ('in_progress', 'completed')
       AND task.metadata->'ack_contract_version' = '2'::jsonb
       AND LOWER(task.metadata->>'acknowledged_by') = LOWER(alert_row.acknowledged_by::text)
       AND task.metadata->>'acknowledged_via' IN ('assignee', 'role', 'admin', 'override')
       AND CASE
             WHEN pg_input_is_valid(
                    task.metadata->>'acknowledged_at',
                    'timestamp with time zone'
                  )
               THEN (task.metadata->>'acknowledged_at')::timestamptz
                      = alert_row.acknowledged_at
             ELSE FALSE
           END
       AND (
         (
           p_expected_task_id IS NULL
           AND (
             task.metadata->>'lab_critical_alert_id' IS NULL
             OR task.metadata->>'lab_critical_alert_id' = alert_row.id::text
           )
         )
         OR task.metadata->>'lab_critical_alert_id' = alert_row.id::text
       )
       AND (
         (
           p_expected_task_id IS NULL
           AND (
             task.metadata->>'lab_alert_generation_state' IS NULL
             OR task.metadata->>'lab_alert_generation_state'
                  = COALESCE(
                      alert_row.generation_metadata->>'corrected_state',
                      'critical'
                    )
           )
         )
         OR task.metadata->>'lab_alert_generation_state'
              = alert_row.generation_metadata->>'corrected_state'
       )
       AND (
         (
           alert_row.generation_signoff_id IS NULL
           AND task.metadata->>'lab_alert_generation_signoff_id' IS NULL
         )
         OR task.metadata->>'lab_alert_generation_signoff_id'
              = alert_row.generation_signoff_id::text
       )
       AND NOT EXISTS (
             SELECT 1
               FROM lab_critical_alerts AS other_alert
              WHERE other_alert.tenant_id = alert_row.tenant_id
                AND other_alert.id <> alert_row.id
                AND other_alert.acknowledgement_task_id = task.id
                AND NOT (
                  other_alert.generation_metadata @>
                    '{"legacy_bridge": true, "legacy_window_reused": true}'::jsonb
                  AND alert_row.generation_metadata @>
                    '{"legacy_bridge": true, "legacy_window_reused": true}'::jsonb
                )
           )
       AND sla.rule_code = 'critical_result_ack'
       AND sla.source_table = 'lab_result'
       AND sla.source_id = alert_row.result_id::text
       AND sla.patient_uid = alert_row.patient_uid
       AND sla.status IN ('completed', 'breached', 'escalated')
       AND sla.completed_at = alert_row.acknowledged_at
       AND sla.metadata->>'completed_via' = 'task_ack'
       AND sla.metadata->>'completed_by_task' = task.id::text
       AND LOWER(sla.metadata->>'completed_by')
             = LOWER(alert_row.acknowledged_by::text)
       AND sla.metadata->'ack_contract_version' = '2'::jsonb
       AND (
         (task.metadata->>'acknowledged_via' = 'assignee'
           AND task.assigned_to_uid = alert_row.acknowledged_by)
         OR (task.metadata->>'acknowledged_via' = 'role'
           AND NULLIF(BTRIM(task.assigned_to_role), '') IS NOT NULL)
         OR task.metadata->>'acknowledged_via' = 'admin'
         OR (
           task.metadata->>'acknowledged_via' = 'override'
           AND task.metadata->>'acknowledge_override_source'
                 = 'patient_access_break_glass'
           AND pg_input_is_valid(
                 task.metadata->>'acknowledge_override_id',
                 'integer'
               )
           AND NULLIF(BTRIM(task.metadata->>'acknowledge_override_reason'), '')
                 IS NOT NULL
           AND CASE
                 WHEN pg_input_is_valid(
                        task.metadata->>'acknowledge_override_id',
                        'integer'
                      )
                   THEN EXISTS (
                     SELECT 1
                       FROM patient_access_break_glass AS break_glass
                      WHERE break_glass.id
                              = (task.metadata->>'acknowledge_override_id')::integer
                        AND break_glass.tenant_id = alert_row.tenant_id
                        AND break_glass.patient_uid = alert_row.patient_uid
                        AND break_glass.actor_uid = alert_row.acknowledged_by
                        AND break_glass.reason
                              = task.metadata->>'acknowledge_override_reason'
                        AND break_glass.started_at <= alert_row.acknowledged_at
                        AND break_glass.expires_at > alert_row.acknowledged_at
                        AND (
                          break_glass.ended_at IS NULL
                          OR break_glass.ended_at >= alert_row.acknowledged_at
                        )
                   )
                 ELSE FALSE
               END
         )
       )
       AND (
         task.metadata->>'acknowledged_via' = 'override'
         OR num_nonnulls(
              task.metadata->>'acknowledge_override_source',
              task.metadata->>'acknowledge_override_id',
              task.metadata->>'acknowledge_override_reason'
            ) = 0
       )
       AND (
         SELECT COUNT(*)::int
           FROM task_comments AS receipt
          WHERE receipt.tenant_id = alert_row.tenant_id
            AND receipt.task_id = task.id
            AND receipt.author_uid = alert_row.acknowledged_by
            AND receipt.body_kind = 'state_change'
            AND receipt.metadata->'ack_contract_version' = '2'::jsonb
            AND receipt.metadata->>'from' IN ('open', 'overdue', 'blocked')
            AND receipt.metadata->>'to' = 'in_progress'
            AND receipt.metadata->>'via'
                  = task.metadata->>'acknowledged_via'
            AND CASE
                  WHEN pg_input_is_valid(
                         receipt.metadata->>'acknowledged_at',
                         'timestamp with time zone'
                       )
                    THEN (receipt.metadata->>'acknowledged_at')::timestamptz
                           = alert_row.acknowledged_at
                  ELSE FALSE
                END
            AND ABS(EXTRACT(EPOCH FROM (
                  receipt.created_at - alert_row.acknowledged_at
                ))) <= 60
            AND receipt.metadata->>'override_source' IS NOT DISTINCT FROM
                  task.metadata->>'acknowledge_override_source'
            AND receipt.metadata->>'override_id' IS NOT DISTINCT FROM
                  task.metadata->>'acknowledge_override_id'
            AND receipt.metadata->>'override_reason' IS NOT DISTINCT FROM
                  task.metadata->>'acknowledge_override_reason'
       ) = 1
       AND (
         SELECT COUNT(*)::int
           FROM clinical_timeline_events AS timeline
          WHERE timeline.tenant_id = alert_row.tenant_id
            AND timeline.patient_uid = alert_row.patient_uid
            AND timeline.event_type = 'critical_result.acknowledged'
            AND timeline.event_status = 'acknowledged'
            AND timeline.source_table = 'lab_critical_alerts'
            AND timeline.source_id = alert_row.id::text
            AND timeline.resource_type = 'critical_lab_alert'
            AND timeline.resource_id = alert_row.id::text
            AND timeline.actor_uid = alert_row.acknowledged_by
            AND timeline.occurred_at = alert_row.acknowledged_at
            AND timeline.idempotency_key
                  = 'lab_critical_alerts:' || alert_row.id::text || ':acknowledged'
            AND timeline.payload->'ack_contract_version' = '2'::jsonb
            AND timeline.payload->'alert_id' = to_jsonb(alert_row.id)
            AND timeline.payload->'result_id' = to_jsonb(alert_row.result_id)
            AND timeline.payload->>'acknowledgement_authorization'
                  = task.metadata->>'acknowledged_via'
            AND timeline.payload ? 'read_back_method'
            AND timeline.payload->>'read_back_method'
                  IS NOT DISTINCT FROM alert_row.read_back_method
            AND timeline.payload->>'acknowledge_override_source'
                  IS NOT DISTINCT FROM task.metadata->>'acknowledge_override_source'
            AND timeline.payload->>'acknowledge_override_id'
                  IS NOT DISTINCT FROM task.metadata->>'acknowledge_override_id'
            AND timeline.payload->>'acknowledge_override_reason'
                  IS NOT DISTINCT FROM task.metadata->>'acknowledge_override_reason'
       ) = 1
       AND (
         SELECT COUNT(*)::int
           FROM clinical_audit_events AS audit
          WHERE audit.tenant_id = alert_row.tenant_id
            AND audit.patient_uid = alert_row.patient_uid
            AND audit.action = 'critical_result.acknowledged'
            AND audit.action_status = 'success'
            AND audit.resource_table = 'lab_critical_alerts'
            AND audit.resource_id = alert_row.id::text
            AND audit.resource_type = 'critical_lab_alert'
            AND audit.actor_uid = alert_row.acknowledged_by
            AND audit.occurred_at = alert_row.acknowledged_at
            AND audit.idempotency_key
                  = 'lab_critical_alerts:' || alert_row.id::text || ':audit:acknowledged'
            AND audit.metadata->'ack_contract_version' = '2'::jsonb
            AND audit.after_state->'ack_contract_version' = '2'::jsonb
            AND audit.after_state->>'acknowledged_by'
                  = alert_row.acknowledged_by::text
            AND audit.after_state ? 'acknowledged_at'
            AND CASE
                  WHEN pg_input_is_valid(
                         audit.after_state->>'acknowledged_at',
                         'timestamp with time zone'
                       )
                    THEN (audit.after_state->>'acknowledged_at')::timestamptz
                           = alert_row.acknowledged_at
                  ELSE FALSE
                END
            AND audit.after_state ? 'read_back_method'
            AND audit.after_state->>'read_back_method'
                  IS NOT DISTINCT FROM alert_row.read_back_method
       ) = 1
  )
  SELECT COUNT(*)::int, MIN(id)
    INTO matched_task_count, matched_task_id
    FROM exact_candidates;

  IF matched_task_count <> 1 THEN
    RAISE EXCEPTION
      'critical-alert acknowledged binding reconciliation required: tenant=%, alert=%, result=%, reason=closed_ack_contract_count_%',
      alert_row.tenant_id,
      alert_row.id,
      alert_row.result_id,
      matched_task_count
      USING ERRCODE = '23514';
  END IF;

  RETURN matched_task_id;
END
$$;

CREATE OR REPLACE FUNCTION assert_lab_critical_alert_acknowledgement_receipt(
  p_tenant_id UUID,
  p_alert_id INTEGER,
  p_require_current_closure BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  exact_receipt_count INTEGER;
BEGIN
  SELECT COUNT(*)::int
    INTO exact_receipt_count
    FROM lab_critical_alert_acknowledgement_receipts AS receipt
    JOIN lab_critical_alerts AS alert
      ON alert.tenant_id = receipt.tenant_id
     AND alert.id = receipt.alert_id
     AND alert.result_id = receipt.result_id
     AND alert.patient_uid = receipt.patient_uid
     AND alert.generation_signoff_id IS NOT DISTINCT FROM receipt.generation_signoff_id
     AND alert.generation_metadata->>'corrected_state' = receipt.generation_state
     AND alert.acknowledgement_task_id = receipt.acknowledgement_task_id
     AND alert.acknowledged_at = receipt.acknowledged_at
     AND alert.acknowledged_by = receipt.acknowledged_by
     AND alert.read_back_method IS NOT DISTINCT FROM receipt.read_back_method
    JOIN tasks AS task
      ON task.tenant_id = receipt.tenant_id
     AND task.id = receipt.acknowledgement_task_id
     AND task.patient_uid = receipt.patient_uid
     AND task.related_resource_type = 'lab_result'
     AND task.related_resource_id = receipt.result_id::text
     AND task.workflow_sla_instance_id = receipt.workflow_sla_instance_id
     AND task.sla_completion_semantics = 'acknowledgement'
     AND task.status IN ('in_progress', 'completed')
     AND task.metadata->>'lab_critical_alert_id' = receipt.alert_id::text
     AND task.metadata->>'lab_alert_generation_state' = receipt.generation_state
     AND (
       (receipt.generation_signoff_id IS NULL
         AND task.metadata->>'lab_alert_generation_signoff_id' IS NULL)
       OR task.metadata->>'lab_alert_generation_signoff_id'
            = receipt.generation_signoff_id::text
     )
     AND task.metadata->'ack_contract_version' = '2'::jsonb
     AND LOWER(task.metadata->>'acknowledged_by')
           = LOWER(receipt.acknowledged_by::text)
     AND task.metadata->>'acknowledged_via'
           = receipt.acknowledgement_authorization
     AND CASE
           WHEN pg_input_is_valid(
                  task.metadata->>'acknowledged_at',
                  'timestamp with time zone'
                )
             THEN (task.metadata->>'acknowledged_at')::timestamptz
                    = receipt.acknowledged_at
           ELSE FALSE
         END
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = receipt.tenant_id
     AND sla.id = receipt.workflow_sla_instance_id
     AND sla.rule_code = 'critical_result_ack'
     AND sla.source_table = 'lab_result'
     AND sla.source_id = receipt.result_id::text
     AND sla.patient_uid = receipt.patient_uid
    JOIN task_comments AS task_comment
      ON task_comment.tenant_id = receipt.tenant_id
     AND task_comment.id = receipt.task_comment_id
     AND task_comment.task_id = receipt.acknowledgement_task_id
     AND task_comment.author_uid = receipt.acknowledged_by
     AND task_comment.body_kind = 'state_change'
     AND task_comment.metadata->'ack_contract_version' = '2'::jsonb
     AND task_comment.metadata->>'from' = receipt.comment_from_status
     AND task_comment.metadata->>'to' = 'in_progress'
     AND task_comment.metadata->>'via' = receipt.acknowledgement_authorization
     AND CASE
           WHEN pg_input_is_valid(
                  task_comment.metadata->>'acknowledged_at',
                  'timestamp with time zone'
                )
             THEN (task_comment.metadata->>'acknowledged_at')::timestamptz
                    = receipt.acknowledged_at
           ELSE FALSE
         END
     AND ABS(EXTRACT(EPOCH FROM (
           task_comment.created_at - receipt.acknowledged_at
         ))) <= 60
    JOIN clinical_timeline_events AS timeline
      ON timeline.tenant_id = receipt.tenant_id
     AND timeline.id = receipt.timeline_event_id
     AND timeline.patient_uid = receipt.patient_uid
     AND timeline.event_type = 'critical_result.acknowledged'
     AND timeline.event_status = 'acknowledged'
     AND timeline.source_table = 'lab_critical_alerts'
     AND timeline.source_id = receipt.alert_id::text
     AND timeline.resource_type = 'critical_lab_alert'
     AND timeline.resource_id = receipt.alert_id::text
     AND timeline.actor_uid = receipt.acknowledged_by
     AND timeline.occurred_at = receipt.acknowledged_at
     AND timeline.idempotency_key
           = 'lab_critical_alerts:' || receipt.alert_id::text || ':acknowledged'
     AND timeline.payload->'ack_contract_version' = '2'::jsonb
     AND timeline.payload->'alert_id' = to_jsonb(receipt.alert_id)
     AND timeline.payload->'result_id' = to_jsonb(receipt.result_id)
     AND timeline.payload->>'acknowledgement_authorization'
           = receipt.acknowledgement_authorization
     AND timeline.payload ? 'read_back_method'
     AND timeline.payload->>'read_back_method'
           IS NOT DISTINCT FROM receipt.read_back_method
    JOIN clinical_audit_events AS audit
      ON audit.tenant_id = receipt.tenant_id
     AND audit.id = receipt.audit_event_id
     AND audit.patient_uid = receipt.patient_uid
     AND audit.action = 'critical_result.acknowledged'
     AND audit.action_status = 'success'
     AND audit.resource_table = 'lab_critical_alerts'
     AND audit.resource_id = receipt.alert_id::text
     AND audit.resource_type = 'critical_lab_alert'
     AND audit.actor_uid = receipt.acknowledged_by
     AND audit.occurred_at = receipt.acknowledged_at
     AND audit.idempotency_key
           = 'lab_critical_alerts:' || receipt.alert_id::text || ':audit:acknowledged'
     AND audit.metadata->'ack_contract_version' = '2'::jsonb
     AND audit.after_state->'ack_contract_version' = '2'::jsonb
     AND audit.after_state->>'acknowledged_by' = receipt.acknowledged_by::text
     AND audit.after_state ? 'acknowledged_at'
     AND CASE
           WHEN pg_input_is_valid(
                  audit.after_state->>'acknowledged_at',
                  'timestamp with time zone'
                )
             THEN (audit.after_state->>'acknowledged_at')::timestamptz
                    = receipt.acknowledged_at
           ELSE FALSE
         END
     AND audit.after_state ? 'read_back_method'
     AND audit.after_state->>'read_back_method'
           IS NOT DISTINCT FROM receipt.read_back_method
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.alert_id = p_alert_id
     AND receipt.ack_contract_version = 2
     AND receipt.sla_completed_at = receipt.acknowledged_at
     AND receipt.sla_completed_via = 'task_ack'
     AND receipt.sla_completed_by_task = receipt.acknowledgement_task_id
     AND receipt.sla_completed_by = receipt.acknowledged_by
     AND (
       NOT p_require_current_closure
       OR (
         task.status = receipt.task_status_at_ack
         AND sla.status = receipt.sla_status_at_ack
         AND sla.completed_at = receipt.sla_completed_at
         AND sla.metadata->>'completed_via' = receipt.sla_completed_via
         AND sla.metadata->>'completed_by_task'
               = receipt.sla_completed_by_task::text
         AND LOWER(sla.metadata->>'completed_by')
               = LOWER(receipt.sla_completed_by::text)
         AND sla.metadata->'ack_contract_version' = '2'::jsonb
       )
     )
     AND (
       SELECT COUNT(*)::int
         FROM task_comments AS exact_comment
        WHERE exact_comment.tenant_id = receipt.tenant_id
          AND exact_comment.task_id = receipt.acknowledgement_task_id
          AND exact_comment.author_uid = receipt.acknowledged_by
          AND exact_comment.body_kind = 'state_change'
          AND exact_comment.metadata->'ack_contract_version' = '2'::jsonb
          AND exact_comment.metadata->>'from' IN ('open', 'overdue', 'blocked')
          AND exact_comment.metadata->>'to' = 'in_progress'
          AND exact_comment.metadata->>'via' = receipt.acknowledgement_authorization
          AND CASE
                WHEN pg_input_is_valid(
                       exact_comment.metadata->>'acknowledged_at',
                       'timestamp with time zone'
                     )
                  THEN (exact_comment.metadata->>'acknowledged_at')::timestamptz
                         = receipt.acknowledged_at
                ELSE FALSE
              END
          AND ABS(EXTRACT(EPOCH FROM (
                exact_comment.created_at - receipt.acknowledged_at
              ))) <= 60
     ) = 1
     AND receipt.override_source IS NOT DISTINCT FROM
           task.metadata->>'acknowledge_override_source'
     AND receipt.override_id IS NOT DISTINCT FROM
           task.metadata->>'acknowledge_override_id'
     AND receipt.override_reason_sha256 IS NOT DISTINCT FROM
           CASE
             WHEN receipt.acknowledgement_authorization = 'override'
               THEN encode(
                 public.digest(task.metadata->>'acknowledge_override_reason', 'sha256'),
                 'hex'
               )
             ELSE NULL
           END
     AND task_comment.metadata->>'override_source'
           IS NOT DISTINCT FROM receipt.override_source
     AND task_comment.metadata->>'override_id'
           IS NOT DISTINCT FROM receipt.override_id
     AND CASE
           WHEN receipt.acknowledgement_authorization = 'override'
             THEN encode(
               public.digest(task_comment.metadata->>'override_reason', 'sha256'),
               'hex'
             ) = receipt.override_reason_sha256
           ELSE task_comment.metadata->>'override_reason' IS NULL
         END
     AND timeline.payload->>'acknowledge_override_source'
           IS NOT DISTINCT FROM receipt.override_source
     AND timeline.payload->>'acknowledge_override_id'
           IS NOT DISTINCT FROM receipt.override_id
     AND CASE
           WHEN receipt.acknowledgement_authorization = 'override'
             THEN encode(
               public.digest(timeline.payload->>'acknowledge_override_reason', 'sha256'),
               'hex'
             ) = receipt.override_reason_sha256
           ELSE timeline.payload->>'acknowledge_override_reason' IS NULL
         END
     AND (
       (receipt.acknowledgement_authorization = 'assignee'
         AND task.assigned_to_uid = receipt.acknowledged_by)
       OR (receipt.acknowledgement_authorization = 'role'
         AND NULLIF(BTRIM(task.assigned_to_role), '') IS NOT NULL)
       OR receipt.acknowledgement_authorization = 'admin'
       OR (
         receipt.acknowledgement_authorization = 'override'
         AND receipt.override_source = 'patient_access_break_glass'
         AND pg_input_is_valid(receipt.override_id, 'integer')
         AND CASE
               WHEN pg_input_is_valid(receipt.override_id, 'integer')
                 THEN EXISTS (
                   SELECT 1
                     FROM patient_access_break_glass AS break_glass
                    WHERE break_glass.id = receipt.override_id::integer
                      AND break_glass.tenant_id = receipt.tenant_id
                      AND break_glass.patient_uid = receipt.patient_uid
                      AND break_glass.actor_uid = receipt.acknowledged_by
                      AND encode(public.digest(break_glass.reason, 'sha256'), 'hex')
                            = receipt.override_reason_sha256
                      AND break_glass.started_at <= receipt.acknowledged_at
                      AND break_glass.expires_at > receipt.acknowledged_at
                      AND (
                        break_glass.ended_at IS NULL
                        OR break_glass.ended_at >= receipt.acknowledged_at
                      )
                 )
               ELSE FALSE
             END
       )
     );

  IF exact_receipt_count <> 1 THEN
    RAISE EXCEPTION
      'critical-alert acknowledgement receipt is invalid: tenant=%, alert=%, exact_receipt_count=%',
      p_tenant_id, p_alert_id, exact_receipt_count
      USING ERRCODE = '23514';
  END IF;

  RETURN TRUE;
END
$$;

CREATE OR REPLACE FUNCTION record_lab_critical_alert_acknowledgement_receipt(
  p_tenant_id UUID,
  p_alert_id INTEGER,
  p_expected_task_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  resolved_task_id INTEGER;
  existing_task_id INTEGER;
BEGIN
  SELECT receipt.acknowledgement_task_id
    INTO existing_task_id
    FROM lab_critical_alert_acknowledgement_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.alert_id = p_alert_id;
  IF FOUND THEN
    IF existing_task_id IS DISTINCT FROM p_expected_task_id THEN
      RAISE EXCEPTION
        'critical-alert acknowledgement receipt task mismatch: tenant=%, alert=%',
        p_tenant_id, p_alert_id
        USING ERRCODE = '23514';
    END IF;
    PERFORM assert_lab_critical_alert_acknowledgement_receipt(
      p_tenant_id, p_alert_id, FALSE
    );
    RETURN TRUE;
  END IF;

  IF p_expected_task_id IS NULL THEN
    RAISE EXCEPTION
      'critical-alert acknowledgement receipt requires an expected task: tenant=%, alert=%',
      p_tenant_id, p_alert_id
      USING ERRCODE = '23514';
  END IF;
  resolved_task_id := resolve_lab_critical_alert_current_closed_ack_task(
    p_tenant_id, p_alert_id, p_expected_task_id
  );
  IF resolved_task_id IS DISTINCT FROM p_expected_task_id THEN
    RAISE EXCEPTION
      'critical-alert acknowledgement receipt task mismatch: tenant=%, alert=%',
      p_tenant_id, p_alert_id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO lab_critical_alert_acknowledgement_receipts
    (tenant_id, alert_id, result_id, patient_uid, generation_signoff_id,
     generation_state, acknowledgement_task_id, workflow_sla_instance_id,
     task_comment_id, timeline_event_id, audit_event_id, acknowledged_at,
     acknowledged_by, acknowledgement_authorization, read_back_method,
     task_status_at_ack, comment_from_status, sla_status_at_ack,
     sla_completed_at, sla_completed_via, sla_completed_by_task,
     sla_completed_by, override_source, override_id, override_reason_sha256,
     ack_contract_version)
  SELECT alert.tenant_id,
         alert.id,
         alert.result_id,
         alert.patient_uid,
         alert.generation_signoff_id,
         alert.generation_metadata->>'corrected_state',
         task.id,
         task.workflow_sla_instance_id,
         exact_comment.id,
         timeline.id,
         audit.id,
         alert.acknowledged_at,
         alert.acknowledged_by,
         task.metadata->>'acknowledged_via',
         alert.read_back_method,
         task.status,
         exact_comment.metadata->>'from',
         sla.status,
         sla.completed_at,
         sla.metadata->>'completed_via',
         task.id,
         alert.acknowledged_by,
         task.metadata->>'acknowledge_override_source',
         task.metadata->>'acknowledge_override_id',
         CASE
           WHEN task.metadata->>'acknowledged_via' = 'override'
             THEN encode(
               public.digest(task.metadata->>'acknowledge_override_reason', 'sha256'),
               'hex'
             )
           ELSE NULL
         END,
         2
    FROM lab_critical_alerts AS alert
    JOIN tasks AS task
      ON task.tenant_id = alert.tenant_id
     AND task.id = alert.acknowledgement_task_id
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
    JOIN LATERAL (
      SELECT task_comment.id, task_comment.metadata
        FROM task_comments AS task_comment
       WHERE task_comment.tenant_id = task.tenant_id
         AND task_comment.task_id = task.id
         AND task_comment.author_uid = alert.acknowledged_by
         AND task_comment.body_kind = 'state_change'
         AND task_comment.metadata->'ack_contract_version' = '2'::jsonb
         AND task_comment.metadata->>'from' IN ('open', 'overdue', 'blocked')
         AND task_comment.metadata->>'to' = 'in_progress'
         AND task_comment.metadata->>'via' = task.metadata->>'acknowledged_via'
         AND CASE
               WHEN pg_input_is_valid(
                      task_comment.metadata->>'acknowledged_at',
                      'timestamp with time zone'
                    )
                 THEN (task_comment.metadata->>'acknowledged_at')::timestamptz
                        = alert.acknowledged_at
               ELSE FALSE
             END
         AND ABS(EXTRACT(EPOCH FROM (
               task_comment.created_at - alert.acknowledged_at
             ))) <= 60
       ORDER BY task_comment.id
       LIMIT 1
    ) AS exact_comment ON TRUE
    JOIN clinical_timeline_events AS timeline
      ON timeline.tenant_id = alert.tenant_id
     AND timeline.idempotency_key
           = 'lab_critical_alerts:' || alert.id::text || ':acknowledged'
    JOIN clinical_audit_events AS audit
      ON audit.tenant_id = alert.tenant_id
     AND audit.idempotency_key
           = 'lab_critical_alerts:' || alert.id::text || ':audit:acknowledged'
   WHERE alert.tenant_id = p_tenant_id
     AND alert.id = p_alert_id
     AND task.id = resolved_task_id
  ON CONFLICT DO NOTHING;

  PERFORM assert_lab_critical_alert_acknowledgement_receipt(
    p_tenant_id, p_alert_id, TRUE
  );
  RETURN TRUE;
END
$$;

CREATE OR REPLACE FUNCTION validate_lab_critical_alert_acknowledgement_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  require_current_closure BOOLEAN;
BEGIN
  SELECT alert.superseded_at IS NULL
    INTO require_current_closure
    FROM lab_critical_alerts AS alert
   WHERE alert.tenant_id = NEW.tenant_id
     AND alert.id = NEW.alert_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'critical-alert acknowledgement receipt alert is missing: tenant=%, alert=%',
      NEW.tenant_id, NEW.alert_id
      USING ERRCODE = '23514';
  END IF;
  PERFORM assert_lab_critical_alert_acknowledgement_receipt(
    NEW.tenant_id, NEW.alert_id, require_current_closure
  );
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_lab_critical_alert_ack_receipt
  ON lab_critical_alert_acknowledgement_receipts;
CREATE CONSTRAINT TRIGGER trg_validate_lab_critical_alert_ack_receipt
AFTER INSERT
ON lab_critical_alert_acknowledgement_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_lab_critical_alert_acknowledgement_receipt();

CREATE OR REPLACE FUNCTION protect_lab_critical_alert_acknowledgement_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'critical-alert acknowledgement receipts are append-only'
    USING ERRCODE = '23514';
END
$$;

DROP TRIGGER IF EXISTS trg_protect_lab_critical_alert_ack_receipt
  ON lab_critical_alert_acknowledgement_receipts;
CREATE TRIGGER trg_protect_lab_critical_alert_ack_receipt
BEFORE UPDATE OR DELETE
ON lab_critical_alert_acknowledgement_receipts
FOR EACH ROW
EXECUTE FUNCTION protect_lab_critical_alert_acknowledgement_receipt();

-- Bind an acknowledged legacy row only after the resolver has proved a single
-- already-closed contract-v2 task/SLA/comment/canonical chain.  This bridge
-- adds provenance pointers; it never changes task/SLA state, timestamps,
-- actors, authorization, comments, or canonical evidence.
DO $$
DECLARE
  candidate RECORD;
  bound_task_id INTEGER;
BEGIN
  FOR candidate IN
    SELECT alert.id,
           alert.tenant_id,
           alert.acknowledgement_task_id,
           alert.generation_signoff_id,
           alert.generation_metadata
      FROM lab_critical_alerts AS alert
     WHERE alert.acknowledged_at IS NOT NULL
     ORDER BY alert.tenant_id, alert.result_id, alert.id
  LOOP
    SELECT receipt.acknowledgement_task_id
      INTO bound_task_id
      FROM lab_critical_alert_acknowledgement_receipts AS receipt
     WHERE receipt.tenant_id = candidate.tenant_id
       AND receipt.alert_id = candidate.id;
    IF FOUND THEN
      IF candidate.acknowledgement_task_id IS DISTINCT FROM bound_task_id THEN
        RAISE EXCEPTION
          'critical-alert acknowledgement receipt task mismatch: tenant=%, alert=%',
          candidate.tenant_id, candidate.id
          USING ERRCODE = '23514';
      END IF;
      PERFORM assert_lab_critical_alert_acknowledgement_receipt(
        candidate.tenant_id, candidate.id, FALSE
      );
    ELSE
      bound_task_id := resolve_lab_critical_alert_current_closed_ack_task(
        candidate.tenant_id,
        candidate.id,
        candidate.acknowledgement_task_id
      );
    END IF;

    IF candidate.acknowledgement_task_id IS NULL THEN
      IF candidate.generation_signoff_id IS NOT NULL
         OR candidate.generation_metadata <> '{}'::jsonb THEN
        RAISE EXCEPTION
          'critical-alert acknowledged binding reconciliation required: tenant=%, alert=%, reason=unbound_generation_provenance_not_empty',
          candidate.tenant_id, candidate.id
          USING ERRCODE = '23514';
      END IF;

      UPDATE tasks
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'lab_critical_alert_id', candidate.id,
               'lab_alert_generation_state', 'critical'
             ),
             updated_at = NOW()
       WHERE tenant_id = candidate.tenant_id
         AND id = bound_task_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'critical-alert acknowledged binding changed concurrently: tenant=%, alert=%',
          candidate.tenant_id, candidate.id
          USING ERRCODE = '23514';
      END IF;

      UPDATE lab_critical_alerts
         SET acknowledgement_task_id = bound_task_id,
             generation_metadata = jsonb_build_object(
               'kind', 'initial_result_generation',
               'source', 'migration_581_legacy_closed_ack_bridge',
               'acknowledgement_task_id', bound_task_id,
               'corrected_state', 'critical',
               'legacy_bridge', true,
               'closed_ack_contract_version', 2
             )
       WHERE tenant_id = candidate.tenant_id
         AND id = candidate.id
         AND acknowledgement_task_id IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'critical-alert acknowledged binding changed concurrently: tenant=%, alert=%',
          candidate.tenant_id, candidate.id
          USING ERRCODE = '23514';
      END IF;
    ELSIF bound_task_id IS DISTINCT FROM candidate.acknowledgement_task_id THEN
      RAISE EXCEPTION
        'critical-alert acknowledged binding reconciliation required: tenant=%, alert=%, reason=bound_task_mismatch',
        candidate.tenant_id, candidate.id
        USING ERRCODE = '23514';
    END IF;

    PERFORM record_lab_critical_alert_acknowledgement_receipt(
      candidate.tenant_id,
      candidate.id,
      bound_task_id
    );
  END LOOP;
END
$$;

-- Public invariant used by deferred alert/dependency validators.  Historical
-- generations resolve through their immutable per-alert receipt and therefore
-- remain provable after the shared resource SLA is rearmed for a successor.
CREATE OR REPLACE FUNCTION resolve_lab_critical_alert_closed_ack_task(
  p_tenant_id UUID,
  p_alert_id INTEGER,
  p_expected_task_id INTEGER DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  receipt_task_id INTEGER;
BEGIN
  SELECT receipt.acknowledgement_task_id
    INTO receipt_task_id
    FROM lab_critical_alert_acknowledgement_receipts AS receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.alert_id = p_alert_id;
  IF NOT FOUND
     OR (p_expected_task_id IS NOT NULL
       AND receipt_task_id IS DISTINCT FROM p_expected_task_id) THEN
    RAISE EXCEPTION
      'critical-alert acknowledgement receipt is missing: tenant=%, alert=%',
      p_tenant_id, p_alert_id
      USING ERRCODE = '23514';
  END IF;

  PERFORM assert_lab_critical_alert_acknowledgement_receipt(
    p_tenant_id, p_alert_id, FALSE
  );
  RETURN receipt_task_id;
END
$$;

-- Bind every outstanding pre-581 alert to exact live task/SLA evidence. A
-- missing or ambiguous obligation aborts the migration for reconciliation;
-- migration-time code must not invent a clinical clock.
DO $$
DECLARE
  candidate RECORD;
  binding RECORD;
  binding_count INTEGER;
BEGIN
  FOR candidate IN
    SELECT alert.id, alert.tenant_id, alert.result_id, alert.patient_uid
      FROM lab_critical_alerts AS alert
     WHERE alert.superseded_at IS NULL
       AND alert.acknowledged_at IS NULL
       AND alert.acknowledgement_task_id IS NULL
       AND NOT EXISTS (
             SELECT 1
               FROM lab_pathologist_signoffs AS signoff
              WHERE signoff.tenant_id = alert.tenant_id
                AND signoff.patient_uid = alert.patient_uid
                AND alert.result_id = ANY(signoff.result_ids)
                AND signoff.decision IN ('corrected', 'amended')
                AND NOT EXISTS (
                      SELECT 1
                        FROM lab_critical_alerts AS represented
                       WHERE represented.tenant_id = alert.tenant_id
                         AND represented.result_id = alert.result_id
                         AND represented.generation_signoff_id = signoff.id
                    )
           )
     ORDER BY alert.tenant_id, alert.result_id, alert.id
  LOOP
    SELECT COUNT(*)::int
      INTO binding_count
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.tenant_id = candidate.tenant_id
       AND task.patient_uid = candidate.patient_uid
       AND task.related_resource_type = 'lab_result'
       AND task.related_resource_id = candidate.result_id::text
       AND task.sla_completion_semantics = 'acknowledgement'
       AND task.status IN ('open', 'blocked', 'overdue')
       AND sla.rule_code = 'critical_result_ack'
       AND sla.source_table = 'lab_result'
       AND sla.source_id = candidate.result_id::text
       AND sla.patient_uid = candidate.patient_uid
       AND sla.status IN ('active', 'breached', 'escalated')
       AND sla.completed_at IS NULL;
    IF binding_count <> 1 THEN
      RAISE EXCEPTION
        'critical-alert initial binding reconciliation required: tenant=%, alert=%, result=%, reason=live_binding_count_%',
        candidate.tenant_id, candidate.id, candidate.result_id, binding_count
        USING ERRCODE = '23514';
    END IF;

    SELECT task.id AS task_id
      INTO binding
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.tenant_id = candidate.tenant_id
       AND task.patient_uid = candidate.patient_uid
       AND task.related_resource_type = 'lab_result'
       AND task.related_resource_id = candidate.result_id::text
       AND task.sla_completion_semantics = 'acknowledgement'
       AND task.status IN ('open', 'blocked', 'overdue')
       AND sla.rule_code = 'critical_result_ack'
       AND sla.source_table = 'lab_result'
       AND sla.source_id = candidate.result_id::text
       AND sla.patient_uid = candidate.patient_uid
       AND sla.status IN ('active', 'breached', 'escalated')
       AND sla.completed_at IS NULL;

    UPDATE tasks
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'lab_critical_alert_id', candidate.id,
             'lab_alert_generation_state', 'critical'
           ),
           updated_at = NOW()
     WHERE tenant_id = candidate.tenant_id
       AND id = binding.task_id;

    UPDATE lab_critical_alerts
       SET acknowledgement_task_id = binding.task_id,
           generation_metadata = jsonb_build_object(
             'kind', 'initial_result_generation',
             'source', 'migration_581_legacy_bridge',
             'acknowledgement_task_id', binding.task_id,
             'corrected_state', 'critical',
             'legacy_bridge', true
           )
     WHERE tenant_id = candidate.tenant_id
       AND id = candidate.id
       AND acknowledgement_task_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'critical-alert initial binding reconciliation changed concurrently: tenant=%, alert=%',
        candidate.tenant_id, candidate.id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION validate_lab_critical_alert_supersession()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  successor lab_critical_alerts%ROWTYPE;
  signoff lab_pathologist_signoffs%ROWTYPE;
  linked_task RECORD;
BEGIN
  IF NEW.superseded_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO successor
    FROM lab_critical_alerts
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.superseded_by_alert_id;
  IF NOT FOUND
     OR successor.result_id <> NEW.result_id
     OR successor.patient_uid <> NEW.patient_uid
     OR successor.id <= NEW.id
     OR successor.fired_at <= NEW.fired_at
     OR successor.fired_at > NEW.superseded_at
     OR successor.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid critical-alert successor generation'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO signoff
    FROM lab_pathologist_signoffs
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.superseded_by_signoff_id;
  IF NOT FOUND
     OR signoff.decision NOT IN ('corrected', 'amended')
     OR (NEW.result_id = ANY(signoff.result_ids)) IS NOT TRUE
     OR signoff.patient_uid <> NEW.patient_uid
     OR signoff.signed_at < NEW.fired_at
     OR signoff.signed_at > successor.fired_at
     OR successor.generation_signoff_id <> signoff.id THEN
    RAISE EXCEPTION 'invalid critical-alert corrective sign-off'
      USING ERRCODE = '23514';
  END IF;

  IF successor.generation_metadata->>'kind' IS DISTINCT FROM 'corrected_result_generation'
     OR successor.generation_metadata->>'signoff_id' IS DISTINCT FROM signoff.id::text
     OR successor.generation_metadata->>'supersedes_alert_id' IS DISTINCT FROM NEW.id::text
     OR COALESCE(successor.generation_metadata->>'corrected_state', '')
          NOT IN ('critical', 'within_active_critical_thresholds',
                  'threshold_unavailable', 'legacy_unclassified')
     OR successor.generation_metadata->>'acknowledgement_task_id'
          IS DISTINCT FROM successor.acknowledgement_task_id::text THEN
    RAISE EXCEPTION 'invalid critical-alert generation provenance'
      USING ERRCODE = '23514';
  END IF;

  SELECT task.id INTO linked_task
    FROM tasks AS task
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
   WHERE task.tenant_id = NEW.tenant_id
     AND task.id = successor.acknowledgement_task_id
     AND task.related_resource_type = 'lab_result'
     AND task.related_resource_id = NEW.result_id::text
     AND task.patient_uid = NEW.patient_uid
     AND task.sla_completion_semantics = 'acknowledgement'
     AND task.status IN ('open', 'blocked', 'overdue')
     AND task.metadata->>'lab_critical_alert_id' IS NOT DISTINCT FROM successor.id::text
     AND task.metadata->>'lab_alert_generation_signoff_id' IS NOT DISTINCT FROM signoff.id::text
     AND task.metadata->>'lab_alert_generation_state'
          IS NOT DISTINCT FROM successor.generation_metadata->>'corrected_state'
     AND sla.rule_code = 'critical_result_ack'
     AND sla.source_table = 'lab_result'
     AND sla.source_id = NEW.result_id::text
     AND sla.patient_uid = NEW.patient_uid
     AND sla.status IN ('active', 'breached', 'escalated')
     AND sla.completed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid critical-alert acknowledgement-task provenance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_lab_critical_alert_supersession
  ON lab_critical_alerts;
CREATE CONSTRAINT TRIGGER trg_validate_lab_critical_alert_supersession
AFTER INSERT OR UPDATE OF superseded_at, superseded_by_alert_id,
  superseded_by_signoff_id
ON lab_critical_alerts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.superseded_at IS NOT NULL)
EXECUTE FUNCTION validate_lab_critical_alert_supersession();

CREATE OR REPLACE FUNCTION validate_lab_critical_alert_generation_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  signoff lab_pathologist_signoffs%ROWTYPE;
  predecessor lab_critical_alerts%ROWTYPE;
  linked_task RECORD;
BEGIN
  IF NEW.acknowledged_at IS NULL
     AND NEW.generation_signoff_id IS NULL
     AND NEW.acknowledgement_task_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM lab_results AS result
     WHERE result.tenant_id = NEW.tenant_id
       AND result.id = NEW.result_id
       AND result.patient_uid = NEW.patient_uid
  ) THEN
    RAISE EXCEPTION 'invalid critical-alert result/patient binding'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.acknowledgement_task_id IS NULL THEN
    RAISE EXCEPTION 'critical-alert generation is missing its acknowledgement task'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.acknowledged_at IS NOT NULL
     AND (
       NEW.acknowledged_by IS NULL
       OR NEW.acknowledged_at < NEW.fired_at
     ) THEN
    RAISE EXCEPTION 'invalid critical-alert acknowledgement receipt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.generation_signoff_id IS NULL THEN
    IF NEW.generation_metadata->>'kind' IS DISTINCT FROM 'initial_result_generation'
       OR NEW.generation_metadata->>'acknowledgement_task_id'
            IS DISTINCT FROM NEW.acknowledgement_task_id::text
       OR NEW.generation_metadata->>'corrected_state' IS DISTINCT FROM 'critical'
       OR NEW.generation_metadata ? 'signoff_id'
       OR NEW.generation_metadata ? 'supersedes_alert_id'
       OR EXISTS (
            SELECT 1
              FROM lab_critical_alerts AS prior
             WHERE prior.tenant_id = NEW.tenant_id
               AND prior.superseded_by_alert_id = NEW.id
          ) THEN
      RAISE EXCEPTION 'invalid initial critical-alert generation metadata binding'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO signoff
      FROM lab_pathologist_signoffs
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.generation_signoff_id;
    IF NOT FOUND
       OR signoff.decision NOT IN ('corrected', 'amended')
       OR (NEW.result_id = ANY(signoff.result_ids)) IS NOT TRUE
       OR signoff.patient_uid <> NEW.patient_uid
       OR signoff.signed_at > NEW.fired_at THEN
      RAISE EXCEPTION 'invalid critical-alert generation sign-off binding'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.generation_metadata->>'kind' IS DISTINCT FROM 'corrected_result_generation'
       OR NEW.generation_metadata->>'signoff_id' IS DISTINCT FROM signoff.id::text
       OR NEW.generation_metadata->>'acknowledgement_task_id'
            IS DISTINCT FROM NEW.acknowledgement_task_id::text
       OR COALESCE(NEW.generation_metadata->>'corrected_state', '')
            NOT IN ('critical', 'within_active_critical_thresholds',
                    'threshold_unavailable', 'legacy_unclassified') THEN
      RAISE EXCEPTION 'invalid corrective critical-alert generation metadata binding'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.generation_metadata ? 'legacy_window_reused'
       AND (
         jsonb_typeof(NEW.generation_metadata->'legacy_window_reused')
           IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(NEW.generation_metadata->'legacy_bridge')
           IS DISTINCT FROM 'boolean'
         OR NEW.generation_metadata->>'legacy_bridge' IS DISTINCT FROM 'true'
       ) THEN
      RAISE EXCEPTION 'invalid legacy critical-alert acknowledgement-window marker'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.generation_metadata->>'supersedes_alert_id' IS NULL THEN
      IF NEW.generation_metadata->>'legacy_window_reused' = 'true' THEN
        RAISE EXCEPTION 'legacy critical-alert acknowledgement-window reuse requires a predecessor'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM lab_critical_alerts AS prior
         WHERE prior.tenant_id = NEW.tenant_id
           AND prior.superseded_by_alert_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'critical-alert generation omits its predecessor provenance'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.generation_metadata->>'supersedes_alert_id' !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'invalid critical-alert predecessor provenance'
          USING ERRCODE = '23514';
      END IF;
      SELECT * INTO predecessor
        FROM lab_critical_alerts
       WHERE tenant_id = NEW.tenant_id
         AND id = (NEW.generation_metadata->>'supersedes_alert_id')::integer
         AND result_id = NEW.result_id
         AND patient_uid = NEW.patient_uid
         AND superseded_by_alert_id = NEW.id
         AND superseded_by_signoff_id = NEW.generation_signoff_id
         AND fired_at <= signoff.signed_at;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'critical-alert predecessor provenance is not reciprocal'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.generation_metadata->>'legacy_window_reused' = 'true'
         AND (
           NEW.generation_metadata->>'legacy_bridge' IS DISTINCT FROM 'true'
           OR predecessor.acknowledgement_task_id
                IS DISTINCT FROM NEW.acknowledgement_task_id
         ) THEN
        RAISE EXCEPTION 'invalid legacy critical-alert acknowledgement-window reuse'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.acknowledged_at IS NOT NULL THEN
    PERFORM resolve_lab_critical_alert_closed_ack_task(
      NEW.tenant_id,
      NEW.id,
      NEW.acknowledgement_task_id
    );
    RETURN NEW;
  END IF;

  SELECT task.id INTO linked_task
    FROM tasks AS task
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
   WHERE task.tenant_id = NEW.tenant_id
     AND task.id = NEW.acknowledgement_task_id
     AND task.related_resource_type = 'lab_result'
     AND task.related_resource_id = NEW.result_id::text
     AND task.patient_uid = NEW.patient_uid
     AND task.sla_completion_semantics = 'acknowledgement'
     AND task.status IN ('open', 'blocked', 'overdue')
     AND task.metadata->>'lab_critical_alert_id' IS NOT DISTINCT FROM NEW.id::text
     AND (
       NEW.generation_signoff_id IS NULL
       OR task.metadata->>'lab_alert_generation_signoff_id'
            IS NOT DISTINCT FROM NEW.generation_signoff_id::text
     )
     AND task.metadata->>'lab_alert_generation_state'
          IS NOT DISTINCT FROM NEW.generation_metadata->>'corrected_state'
     AND sla.rule_code = 'critical_result_ack'
     AND sla.source_table = 'lab_result'
     AND sla.source_id = NEW.result_id::text
     AND sla.patient_uid = NEW.patient_uid
     AND sla.status IN ('active', 'breached', 'escalated')
     AND sla.completed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid critical-alert generation task/SLA binding'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_lab_critical_alert_generation_binding
  ON lab_critical_alerts;
CREATE CONSTRAINT TRIGGER trg_validate_lab_critical_alert_generation_binding
AFTER INSERT OR UPDATE OF generation_signoff_id, acknowledgement_task_id,
  generation_metadata, result_id, patient_uid, fired_at,
  acknowledged_at, acknowledged_by, read_back_method
ON lab_critical_alerts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  NEW.generation_signoff_id IS NOT NULL
  OR NEW.acknowledgement_task_id IS NOT NULL
  OR NEW.acknowledged_at IS NOT NULL
)
EXECUTE FUNCTION validate_lab_critical_alert_generation_binding();

CREATE OR REPLACE FUNCTION protect_lab_critical_alert_generation_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  legacy_initial_binding BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.superseded_at IS NOT NULL
       OR OLD.generation_signoff_id IS NOT NULL
       OR OLD.acknowledgement_task_id IS NOT NULL
       OR EXISTS (
            SELECT 1
              FROM lab_critical_alerts AS successor
             WHERE successor.tenant_id = OLD.tenant_id
               AND successor.generation_metadata->>'supersedes_alert_id' = OLD.id::text
          ) THEN
      RAISE EXCEPTION 'critical-alert generation evidence cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  legacy_initial_binding := (
    OLD.generation_signoff_id IS NULL
    AND OLD.acknowledgement_task_id IS NULL
    AND OLD.superseded_at IS NULL
    AND OLD.acknowledged_at IS NULL
    AND OLD.generation_metadata = '{}'::jsonb
    AND NEW.generation_signoff_id IS NULL
    AND NEW.acknowledgement_task_id IS NOT NULL
    AND NEW.generation_metadata->>'kind' = 'initial_result_generation'
    AND NEW.generation_metadata->>'acknowledgement_task_id'
          = NEW.acknowledgement_task_id::text
    AND NEW.generation_metadata->>'corrected_state' = 'critical'
  );
  IF OLD.generation_metadata IS DISTINCT FROM NEW.generation_metadata
     AND NOT legacy_initial_binding THEN
    RAISE EXCEPTION 'critical-alert generation provenance is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.generation_signoff_id IS DISTINCT FROM NEW.generation_signoff_id
    OR OLD.result_id IS DISTINCT FROM NEW.result_id
    OR OLD.patient_uid IS DISTINCT FROM NEW.patient_uid
    OR OLD.fired_at IS DISTINCT FROM NEW.fired_at
    OR (
      OLD.acknowledgement_task_id IS DISTINCT FROM NEW.acknowledgement_task_id
      AND NOT legacy_initial_binding
    ) THEN
    RAISE EXCEPTION 'critical-alert generation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND (
    OLD.superseded_at IS DISTINCT FROM NEW.superseded_at
    OR OLD.superseded_by_alert_id IS DISTINCT FROM NEW.superseded_by_alert_id
    OR OLD.superseded_by_signoff_id IS DISTINCT FROM NEW.superseded_by_signoff_id
  ) THEN
    RAISE EXCEPTION 'critical-alert supersession is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM lab_critical_alert_acknowledgement_receipts AS receipt
     WHERE receipt.tenant_id = OLD.tenant_id
       AND receipt.alert_id = OLD.id
  ) AND (
    OLD.acknowledged_at IS DISTINCT FROM NEW.acknowledged_at
    OR OLD.acknowledged_by IS DISTINCT FROM NEW.acknowledged_by
    OR OLD.acknowledged_by_name IS DISTINCT FROM NEW.acknowledged_by_name
    OR OLD.read_back_method IS DISTINCT FROM NEW.read_back_method
    OR OLD.notes IS DISTINCT FROM NEW.notes
  ) THEN
    RAISE EXCEPTION 'critical-alert acknowledgement evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_protect_lab_critical_alert_generation_provenance
  ON lab_critical_alerts;

CREATE OR REPLACE FUNCTION protect_lab_critical_alert_signoff_dependency()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (
    EXISTS (
      SELECT 1
        FROM lab_critical_alerts AS alert
       WHERE alert.tenant_id = OLD.tenant_id
         AND (alert.generation_signoff_id = OLD.id
           OR alert.superseded_by_signoff_id = OLD.id)
    )
    OR EXISTS (
      SELECT 1
        FROM lab_critical_alert_reconciliation_receipts AS receipt
       WHERE receipt.tenant_id = OLD.tenant_id
         AND (receipt.signoff_id = OLD.id
           OR receipt.successor_signoff_id = OLD.id)
    )
  ) AND (
    TG_OP = 'DELETE'
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.patient_uid IS DISTINCT FROM NEW.patient_uid
    OR OLD.result_ids IS DISTINCT FROM NEW.result_ids
    OR OLD.decision IS DISTINCT FROM NEW.decision
    OR OLD.signed_off_by IS DISTINCT FROM NEW.signed_off_by
    OR OLD.signed_at IS DISTINCT FROM NEW.signed_at
  ) THEN
    RAISE EXCEPTION 'referenced critical-alert corrective sign-off is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_protect_lab_critical_alert_signoff_dependency
  ON lab_pathologist_signoffs;

CREATE OR REPLACE FUNCTION protect_lab_critical_alert_task_dependency()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM lab_critical_alerts AS alert
     WHERE alert.tenant_id = OLD.tenant_id
       AND alert.acknowledgement_task_id = OLD.id
  ) AND (
    TG_OP = 'DELETE'
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.patient_uid IS DISTINCT FROM NEW.patient_uid
    OR OLD.related_resource_type IS DISTINCT FROM NEW.related_resource_type
    OR OLD.related_resource_id IS DISTINCT FROM NEW.related_resource_id
    OR OLD.workflow_sla_instance_id IS DISTINCT FROM NEW.workflow_sla_instance_id
    OR OLD.sla_completion_semantics IS DISTINCT FROM NEW.sla_completion_semantics
    OR OLD.metadata->>'lab_critical_alert_id'
         IS DISTINCT FROM NEW.metadata->>'lab_critical_alert_id'
    OR OLD.metadata->>'lab_alert_generation_signoff_id'
         IS DISTINCT FROM NEW.metadata->>'lab_alert_generation_signoff_id'
    OR OLD.metadata->>'lab_alert_generation_state'
         IS DISTINCT FROM NEW.metadata->>'lab_alert_generation_state'
  ) THEN
    RAISE EXCEPTION 'referenced critical-alert acknowledgement task binding is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM lab_critical_alert_acknowledgement_receipts AS receipt
     WHERE receipt.tenant_id = OLD.tenant_id
       AND receipt.acknowledgement_task_id = OLD.id
  ) AND (
    TG_OP = 'DELETE'
    OR OLD.assigned_to_uid IS DISTINCT FROM NEW.assigned_to_uid
    OR OLD.assigned_to_role IS DISTINCT FROM NEW.assigned_to_role
    OR OLD.metadata->>'acknowledged_at'
         IS DISTINCT FROM NEW.metadata->>'acknowledged_at'
    OR OLD.metadata->>'acknowledged_by'
         IS DISTINCT FROM NEW.metadata->>'acknowledged_by'
    OR OLD.metadata->>'acknowledged_via'
         IS DISTINCT FROM NEW.metadata->>'acknowledged_via'
    OR OLD.metadata->'ack_contract_version'
         IS DISTINCT FROM NEW.metadata->'ack_contract_version'
    OR OLD.metadata->>'acknowledge_override_source'
         IS DISTINCT FROM NEW.metadata->>'acknowledge_override_source'
    OR OLD.metadata->>'acknowledge_override_id'
         IS DISTINCT FROM NEW.metadata->>'acknowledge_override_id'
    OR OLD.metadata->>'acknowledge_override_reason'
         IS DISTINCT FROM NEW.metadata->>'acknowledge_override_reason'
    OR (
      OLD.status IS DISTINCT FROM NEW.status
      AND NOT (OLD.status = 'in_progress' AND NEW.status = 'completed')
    )
    OR (
      OLD.completed_at IS DISTINCT FROM NEW.completed_at
      AND NOT (OLD.status = 'in_progress' AND NEW.status = 'completed')
    )
  ) THEN
    RAISE EXCEPTION 'critical-alert acknowledgement task receipt is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_protect_lab_critical_alert_task_dependency ON tasks;

CREATE OR REPLACE FUNCTION protect_lab_critical_alert_sla_dependency()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  acknowledged_alert RECORD;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM lab_critical_alerts AS alert
      JOIN tasks AS task
        ON task.tenant_id = alert.tenant_id
       AND task.id = alert.acknowledgement_task_id
     WHERE task.tenant_id = OLD.tenant_id
       AND task.workflow_sla_instance_id = OLD.id
  ) AND (
    TG_OP = 'DELETE'
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.rule_code IS DISTINCT FROM NEW.rule_code
    OR OLD.source_table IS DISTINCT FROM NEW.source_table
    OR OLD.source_id IS DISTINCT FROM NEW.source_id
    OR OLD.patient_uid IS DISTINCT FROM NEW.patient_uid
  ) THEN
    RAISE EXCEPTION 'referenced critical-alert SLA identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'DELETE' AND (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
    OR OLD.breached_at IS DISTINCT FROM NEW.breached_at
    OR OLD.escalated_at IS DISTINCT FROM NEW.escalated_at
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR OLD.due_at IS DISTINCT FROM NEW.due_at
    OR OLD.metadata IS DISTINCT FROM NEW.metadata
  ) THEN
    FOR acknowledged_alert IN
      SELECT alert.tenant_id, alert.id
        FROM lab_critical_alerts AS alert
        JOIN tasks AS task
          ON task.tenant_id = alert.tenant_id
         AND task.id = alert.acknowledgement_task_id
       WHERE task.tenant_id = OLD.tenant_id
         AND task.workflow_sla_instance_id = OLD.id
         AND alert.acknowledged_at IS NOT NULL
    LOOP
      PERFORM assert_lab_critical_alert_acknowledgement_receipt(
        acknowledged_alert.tenant_id,
        acknowledged_alert.id,
        FALSE
      );
    END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_protect_lab_critical_alert_sla_dependency
  ON workflow_sla_instances;

CREATE OR REPLACE FUNCTION assert_lab_critical_alert_sla_generation_state(
  p_tenant_id UUID,
  p_sla_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  referenced_alert_count INTEGER;
  current_generation_count INTEGER;
  acknowledged_alert RECORD;
  current_generation RECORD;
BEGIN
  SELECT COUNT(*)::int
    INTO referenced_alert_count
    FROM lab_critical_alerts AS alert
    JOIN tasks AS task
      ON task.tenant_id = alert.tenant_id
     AND task.id = alert.acknowledgement_task_id
   WHERE task.tenant_id = p_tenant_id
     AND task.workflow_sla_instance_id = p_sla_id;
  IF referenced_alert_count = 0 THEN
    RETURN TRUE;
  END IF;

  FOR acknowledged_alert IN
    SELECT alert.tenant_id, alert.id
      FROM lab_critical_alerts AS alert
      JOIN tasks AS task
        ON task.tenant_id = alert.tenant_id
       AND task.id = alert.acknowledgement_task_id
     WHERE task.tenant_id = p_tenant_id
       AND task.workflow_sla_instance_id = p_sla_id
       AND alert.acknowledged_at IS NOT NULL
  LOOP
    PERFORM assert_lab_critical_alert_acknowledgement_receipt(
      acknowledged_alert.tenant_id,
      acknowledged_alert.id,
      FALSE
    );
  END LOOP;

  SELECT COUNT(*)::int
    INTO current_generation_count
    FROM lab_critical_alerts AS alert
    JOIN tasks AS task
      ON task.tenant_id = alert.tenant_id
     AND task.id = alert.acknowledgement_task_id
   WHERE task.tenant_id = p_tenant_id
     AND task.workflow_sla_instance_id = p_sla_id
     AND alert.superseded_at IS NULL;
  IF current_generation_count <> 1 THEN
    RAISE EXCEPTION
      'critical-alert SLA has no unique current generation: tenant=%, sla=%, count=%',
      p_tenant_id, p_sla_id, current_generation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT alert.id AS alert_id,
         alert.result_id,
         alert.patient_uid,
         alert.generation_signoff_id,
         alert.generation_metadata,
         alert.acknowledged_at,
         task.id AS task_id,
         task.status AS task_status,
         task.metadata AS task_metadata,
         sla.status AS sla_status,
         sla.completed_at,
         sla.metadata AS sla_metadata
    INTO current_generation
    FROM lab_critical_alerts AS alert
    JOIN tasks AS task
      ON task.tenant_id = alert.tenant_id
     AND task.id = alert.acknowledgement_task_id
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
   WHERE task.tenant_id = p_tenant_id
     AND task.workflow_sla_instance_id = p_sla_id
     AND alert.superseded_at IS NULL;

  IF current_generation.acknowledged_at IS NOT NULL THEN
    PERFORM assert_lab_critical_alert_acknowledgement_receipt(
      p_tenant_id,
      current_generation.alert_id,
      TRUE
    );
  ELSIF current_generation.task_status NOT IN ('open', 'blocked', 'overdue')
     OR current_generation.sla_status NOT IN ('active', 'breached', 'escalated')
     OR current_generation.completed_at IS NOT NULL
     OR current_generation.task_metadata->>'lab_critical_alert_id'
          IS DISTINCT FROM current_generation.alert_id::text
     OR current_generation.task_metadata->>'lab_alert_generation_state'
          IS DISTINCT FROM current_generation.generation_metadata->>'corrected_state'
     OR (
       current_generation.generation_signoff_id IS NULL
       AND current_generation.task_metadata->>'lab_alert_generation_signoff_id'
             IS NOT NULL
     )
     OR (
       current_generation.generation_signoff_id IS NOT NULL
       AND current_generation.task_metadata->>'lab_alert_generation_signoff_id'
             IS DISTINCT FROM current_generation.generation_signoff_id::text
     )
     OR current_generation.sla_metadata->>'completed_via' IS NOT NULL
     OR current_generation.sla_metadata->>'completed_by_task' IS NOT NULL
     OR current_generation.sla_metadata->>'completed_by' IS NOT NULL
     OR current_generation.sla_metadata->>'acknowledged_by' IS NOT NULL
     OR current_generation.sla_metadata->>'completion_evidence' IS NOT NULL
     OR current_generation.sla_metadata ? 'ack_contract_version'
     OR current_generation.task_metadata->>'acknowledged_at' IS NOT NULL
     OR current_generation.task_metadata->>'acknowledged_by' IS NOT NULL
     OR current_generation.task_metadata->>'acknowledged_via' IS NOT NULL
     OR current_generation.task_metadata->>'acknowledge_override_source' IS NOT NULL
     OR current_generation.task_metadata->>'acknowledge_override_id' IS NOT NULL
     OR current_generation.task_metadata->>'acknowledge_override_reason' IS NOT NULL
     OR current_generation.task_metadata ? 'ack_contract_version' THEN
    RAISE EXCEPTION
      'critical-alert SLA current generation is not an exact open obligation: tenant=%, sla=%, alert=%',
      p_tenant_id, p_sla_id, current_generation.alert_id
      USING ERRCODE = '23514';
  END IF;

  RETURN TRUE;
END
$$;

CREATE OR REPLACE FUNCTION validate_lab_critical_alert_sla_generation_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM assert_lab_critical_alert_sla_generation_state(NEW.tenant_id, NEW.id);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_lab_critical_alert_sla_generation_state
  ON workflow_sla_instances;

CREATE OR REPLACE FUNCTION protect_lab_critical_alert_ack_receipt_dependency()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  referenced BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'task_comments' THEN
    SELECT EXISTS (
      SELECT 1
        FROM lab_critical_alert_acknowledgement_receipts AS receipt
       WHERE receipt.tenant_id = OLD.tenant_id
         AND receipt.task_comment_id = OLD.id
    ) INTO referenced;
  ELSIF TG_TABLE_NAME = 'clinical_timeline_events' THEN
    SELECT EXISTS (
      SELECT 1
        FROM lab_critical_alert_acknowledgement_receipts AS receipt
       WHERE receipt.tenant_id = OLD.tenant_id
         AND receipt.timeline_event_id = OLD.id
    ) INTO referenced;
  ELSIF TG_TABLE_NAME = 'clinical_audit_events' THEN
    SELECT EXISTS (
      SELECT 1
        FROM lab_critical_alert_acknowledgement_receipts AS receipt
       WHERE receipt.tenant_id = OLD.tenant_id
         AND receipt.audit_event_id = OLD.id
    ) INTO referenced;
  END IF;

  IF referenced THEN
    RAISE EXCEPTION 'critical-alert acknowledgement receipt evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_protect_lab_ack_receipt_task_comment
  ON task_comments;
DROP TRIGGER IF EXISTS trg_protect_lab_ack_receipt_timeline
  ON clinical_timeline_events;
DROP TRIGGER IF EXISTS trg_protect_lab_ack_receipt_audit
  ON clinical_audit_events;

CREATE OR REPLACE FUNCTION validate_lab_critical_alert_ack_comment_set()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  affected_tenant_id UUID;
  affected_task_id INTEGER;
  sealed_alert RECORD;
BEGIN
  affected_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  affected_task_id := COALESCE(NEW.task_id, OLD.task_id);
  FOR sealed_alert IN
    SELECT receipt.tenant_id, receipt.alert_id
      FROM lab_critical_alert_acknowledgement_receipts AS receipt
     WHERE receipt.tenant_id = affected_tenant_id
       AND receipt.acknowledgement_task_id = affected_task_id
  LOOP
    PERFORM assert_lab_critical_alert_acknowledgement_receipt(
      sealed_alert.tenant_id,
      sealed_alert.alert_id,
      FALSE
    );
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_validate_lab_critical_alert_ack_comment_set
  ON task_comments;

-- Migration-time upgrade bridge for PR #587-era corrected sign-offs. This
-- binds only exact task/SLA evidence already present before migration 581.
-- Corrections committed by an old replica after this transaction are handled
-- after replica drain by the application materializer reconciliation script,
-- which creates an exact alert/task/SLA window for a current critical value or
-- appends typed no-alert/historical-supersession evidence. It never repoints a
-- protected task or invents a clinician acknowledgement.
DO $$
DECLARE
  candidate RECORD;
  prior_alert RECORD;
  current_result RECORD;
  live_binding RECORD;
  current_alert_count INTEGER;
  live_binding_count INTEGER;
  successor_id INTEGER;
  bound_alert_id INTEGER;
  legacy_window_reused BOOLEAN;
  bridged_signoff_ids JSONB;
  successor_fired_at TIMESTAMPTZ;
BEGIN
  FOR candidate IN
    WITH expanded AS (
      SELECT signoff.id AS signoff_id,
             signoff.tenant_id,
             signoff.patient_uid,
             signoff.signed_off_by,
             signoff.signed_at,
             result_id,
             ROW_NUMBER() OVER (
               PARTITION BY signoff.tenant_id, result_id
               ORDER BY signoff.id DESC
             ) AS recency
        FROM lab_pathologist_signoffs AS signoff
        CROSS JOIN LATERAL unnest(signoff.result_ids) AS result_id
       WHERE signoff.decision IN ('corrected', 'amended')
    )
    SELECT *
      FROM expanded
     WHERE recency = 1
       AND NOT EXISTS (
             SELECT 1
               FROM lab_critical_alerts AS represented
              WHERE represented.tenant_id = expanded.tenant_id
                AND represented.result_id = expanded.result_id
                AND represented.superseded_at IS NULL
                AND represented.generation_signoff_id = expanded.signoff_id
           )
     ORDER BY tenant_id, result_id
  LOOP
    -- Serialize with the new application materializer/acknowledger and then
    -- revalidate the candidate selected before this resource lock.
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        jsonb_build_array(
          candidate.tenant_id::text,
          'lab_result',
          candidate.result_id::text
        )::text,
        0
      )
    );
    IF EXISTS (
      SELECT 1
        FROM lab_pathologist_signoffs AS newer
       WHERE newer.tenant_id = candidate.tenant_id
         AND newer.patient_uid = candidate.patient_uid
         AND candidate.result_id = ANY(newer.result_ids)
         AND newer.decision IN ('corrected', 'amended')
         AND newer.id > candidate.signoff_id
    ) OR EXISTS (
      SELECT 1
        FROM lab_critical_alerts AS represented
       WHERE represented.tenant_id = candidate.tenant_id
         AND represented.result_id = candidate.result_id
         AND represented.superseded_at IS NULL
         AND represented.generation_signoff_id = candidate.signoff_id
    ) THEN
      CONTINUE;
    END IF;

    SELECT COUNT(*)::int
      INTO current_alert_count
      FROM lab_critical_alerts AS alert
     WHERE alert.tenant_id = candidate.tenant_id
       AND alert.result_id = candidate.result_id
       AND alert.superseded_at IS NULL;

    -- No critical-alert history means this may be an ordinary normal-result
    -- correction; it has no critical obligation to bridge.
    IF current_alert_count = 0 THEN
      CONTINUE;
    END IF;
    IF current_alert_count <> 1
    THEN
      RAISE EXCEPTION
        'critical-alert legacy reconciliation required: tenant=%, result=%, reason=current_alert_ambiguous',
        candidate.tenant_id, candidate.result_id
        USING ERRCODE = '23514';
    END IF;
    SELECT alert.id, alert.patient_uid, alert.test_name,
           alert.threshold_breached, alert.threshold_value, alert.fired_at
      INTO prior_alert
      FROM lab_critical_alerts AS alert
     WHERE alert.tenant_id = candidate.tenant_id
       AND alert.result_id = candidate.result_id
       AND alert.superseded_at IS NULL
     FOR UPDATE;
    IF prior_alert.patient_uid IS DISTINCT FROM candidate.patient_uid THEN
      RAISE EXCEPTION
        'critical-alert legacy reconciliation required: tenant=%, result=%, reason=patient_mismatch',
        candidate.tenant_id, candidate.result_id
        USING ERRCODE = '23514';
    END IF;
    IF candidate.signed_at < prior_alert.fired_at THEN
      RAISE EXCEPTION
        'critical-alert legacy reconciliation required: tenant=%, result=%, reason=signoff_predates_predecessor',
        candidate.tenant_id, candidate.result_id
        USING ERRCODE = '23514';
    END IF;

    SELECT result.id, result.patient_uid, result.test_name, result.value_text,
           result.value_numeric, result.unit
      INTO current_result
      FROM lab_results AS result
     WHERE result.tenant_id = candidate.tenant_id
       AND result.id = candidate.result_id
       AND result.patient_uid = candidate.patient_uid
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'critical-alert legacy reconciliation required: tenant=%, result=%, reason=result_binding_missing',
        candidate.tenant_id, candidate.result_id
        USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*)::int
      INTO live_binding_count
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.tenant_id = candidate.tenant_id
       AND task.patient_uid = candidate.patient_uid
       AND task.related_resource_type = 'lab_result'
       AND task.related_resource_id = candidate.result_id::text
       AND task.sla_completion_semantics = 'acknowledgement'
       AND task.status IN ('open', 'blocked', 'overdue')
       AND sla.rule_code = 'critical_result_ack'
       AND sla.source_table = 'lab_result'
       AND sla.source_id = candidate.result_id::text
       AND sla.patient_uid = candidate.patient_uid
       AND sla.status IN ('active', 'breached', 'escalated')
       AND sla.completed_at IS NULL;
    IF live_binding_count <> 1 THEN
      RAISE EXCEPTION
        'critical-alert legacy reconciliation required: tenant=%, result=%, reason=live_binding_count_%',
        candidate.tenant_id, candidate.result_id, live_binding_count
        USING ERRCODE = '23514';
    END IF;
    SELECT task.id AS task_id,
           task.workflow_sla_instance_id AS sla_id,
           task.task_kind,
           task.title,
           task.description,
           task.encounter_id,
           task.priority,
           task.assigned_to_uid,
           task.assigned_to_role,
           task.sla_definition_id,
           task.metadata,
           sla.rule_id
      INTO live_binding
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.tenant_id = candidate.tenant_id
       AND task.patient_uid = candidate.patient_uid
       AND task.related_resource_type = 'lab_result'
       AND task.related_resource_id = candidate.result_id::text
       AND task.sla_completion_semantics = 'acknowledgement'
       AND task.status IN ('open', 'blocked', 'overdue')
       AND sla.rule_code = 'critical_result_ack'
       AND sla.source_table = 'lab_result'
       AND sla.source_id = candidate.result_id::text
       AND sla.patient_uid = candidate.patient_uid
       AND sla.status IN ('active', 'breached', 'escalated')
       AND sla.completed_at IS NULL
     FOR UPDATE OF task, sla;

    SELECT alert.id
      INTO bound_alert_id
      FROM lab_critical_alerts AS alert
     WHERE alert.tenant_id = candidate.tenant_id
       AND alert.acknowledgement_task_id = live_binding.task_id
     LIMIT 1;
    legacy_window_reused := FOUND;

    SELECT COALESCE(jsonb_agg(signoff.id ORDER BY signoff.id), '[]'::jsonb)
      INTO bridged_signoff_ids
      FROM lab_pathologist_signoffs AS signoff
     WHERE signoff.tenant_id = candidate.tenant_id
       AND signoff.patient_uid = candidate.patient_uid
       AND candidate.result_id = ANY(signoff.result_ids)
       AND signoff.decision IN ('corrected', 'amended')
       AND signoff.id <= candidate.signoff_id;

    SELECT nextval(pg_get_serial_sequence('lab_critical_alerts', 'id'))::int
      INTO successor_id;

    UPDATE tasks
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'lab_critical_alert_id', successor_id,
             'lab_alert_generation_signoff_id', candidate.signoff_id,
             'lab_alert_generation_state', 'legacy_unclassified'
           ),
           updated_at = NOW()
     WHERE tenant_id = candidate.tenant_id
       AND id = live_binding.task_id;

    successor_fired_at := GREATEST(
      clock_timestamp(),
      candidate.signed_at + INTERVAL '1 microsecond',
      prior_alert.fired_at + INTERVAL '1 microsecond'
    );
    UPDATE lab_critical_alerts
       SET superseded_at = successor_fired_at,
           superseded_by_alert_id = successor_id,
           superseded_by_signoff_id = candidate.signoff_id
     WHERE tenant_id = candidate.tenant_id
       AND id = prior_alert.id
       AND superseded_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'critical-alert legacy reconciliation required: tenant=%, result=%, reason=predecessor_changed',
        candidate.tenant_id, candidate.result_id
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO lab_critical_alerts
      (id, tenant_id, result_id, patient_uid, test_name, value_text,
       value_numeric, unit, threshold_breached, threshold_value, fired_at,
       generation_signoff_id, acknowledgement_task_id, generation_metadata)
    VALUES
      (successor_id, candidate.tenant_id, candidate.result_id, candidate.patient_uid,
       current_result.test_name, current_result.value_text,
       current_result.value_numeric, current_result.unit, NULL, NULL,
       successor_fired_at, candidate.signoff_id, live_binding.task_id,
       jsonb_build_object(
         'kind', 'corrected_result_generation',
         'signoff_id', candidate.signoff_id,
         'supersedes_alert_id', prior_alert.id,
         'acknowledgement_task_id', live_binding.task_id,
         'corrected_state', 'legacy_unclassified',
         'legacy_bridge', true,
         'legacy_window_reused', legacy_window_reused,
         'legacy_bridge_signoff_ids', bridged_signoff_ids,
         'prior_threshold_breached', prior_alert.threshold_breached,
         'prior_threshold_value', prior_alert.threshold_value
       ));
  END LOOP;
END
$$;

-- Flush the bridge's deferred generation/supersession validators before DDL;
-- PostgreSQL rejects CREATE INDEX while the relation has pending trigger
-- events. This is also the migration's fail-closed bridge validation gate.
SET CONSTRAINTS ALL IMMEDIATE;

-- Bridge mutations are complete. From this point onward, provenance identity
-- is immutable for every application role; no session setting bypasses it.
CREATE TRIGGER trg_protect_lab_critical_alert_generation_provenance
BEFORE UPDATE OR DELETE
ON lab_critical_alerts
FOR EACH ROW
EXECUTE FUNCTION protect_lab_critical_alert_generation_provenance();

CREATE TRIGGER trg_protect_lab_critical_alert_signoff_dependency
BEFORE UPDATE OR DELETE
ON lab_pathologist_signoffs
FOR EACH ROW
EXECUTE FUNCTION protect_lab_critical_alert_signoff_dependency();

CREATE TRIGGER trg_protect_lab_critical_alert_task_dependency
BEFORE UPDATE OR DELETE
ON tasks
FOR EACH ROW
EXECUTE FUNCTION protect_lab_critical_alert_task_dependency();

CREATE TRIGGER trg_protect_lab_critical_alert_sla_dependency
BEFORE UPDATE OR DELETE
ON workflow_sla_instances
FOR EACH ROW
EXECUTE FUNCTION protect_lab_critical_alert_sla_dependency();

CREATE CONSTRAINT TRIGGER trg_validate_lab_critical_alert_sla_generation_state
AFTER INSERT OR UPDATE
ON workflow_sla_instances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_lab_critical_alert_sla_generation_state();

CREATE TRIGGER trg_protect_lab_ack_receipt_task_comment
BEFORE UPDATE OR DELETE
ON task_comments
FOR EACH ROW
EXECUTE FUNCTION protect_lab_critical_alert_ack_receipt_dependency();

CREATE TRIGGER trg_protect_lab_ack_receipt_timeline
BEFORE UPDATE OR DELETE
ON clinical_timeline_events
FOR EACH ROW
EXECUTE FUNCTION protect_lab_critical_alert_ack_receipt_dependency();

CREATE TRIGGER trg_protect_lab_ack_receipt_audit
BEFORE UPDATE OR DELETE
ON clinical_audit_events
FOR EACH ROW
EXECUTE FUNCTION protect_lab_critical_alert_ack_receipt_dependency();

CREATE CONSTRAINT TRIGGER trg_validate_lab_critical_alert_ack_comment_set
AFTER INSERT OR UPDATE OR DELETE
ON task_comments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_lab_critical_alert_ack_comment_set();

DROP INDEX IF EXISTS idx_lab_critical_alert_superseded_by;
CREATE UNIQUE INDEX idx_lab_critical_alert_superseded_by
  ON lab_critical_alerts (tenant_id, superseded_by_alert_id)
  WHERE superseded_by_alert_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lab_critical_alert_superseded_signoff
  ON lab_critical_alerts (tenant_id, superseded_by_signoff_id)
  WHERE superseded_by_signoff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lab_critical_alert_generation_signoff_lookup
  ON lab_critical_alerts (tenant_id, generation_signoff_id)
  WHERE generation_signoff_id IS NOT NULL;

DROP INDEX IF EXISTS idx_lab_critical_alert_generation_signoff;
CREATE UNIQUE INDEX idx_lab_critical_alert_generation_signoff
  ON lab_critical_alerts (tenant_id, result_id, generation_signoff_id)
  WHERE generation_signoff_id IS NOT NULL;

DROP INDEX IF EXISTS idx_lab_critical_alert_ack_task;
ALTER TABLE lab_critical_alerts
  ADD CONSTRAINT ex_lab_critical_alert_ack_task
    EXCLUDE USING gist (
      tenant_id WITH =,
      acknowledgement_task_id WITH =
    )
    WHERE (
      acknowledgement_task_id IS NOT NULL
      AND NOT (
        generation_metadata @> '{"legacy_bridge": true, "legacy_window_reused": true}'::jsonb
      )
    )
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_lab_critical_alert_ack_task_lookup
  ON lab_critical_alerts (tenant_id, acknowledgement_task_id)
  WHERE acknowledgement_task_id IS NOT NULL;

DO $$
DECLARE
  duplicate_generation RECORD;
BEGIN
  SELECT tenant_id, result_id, COUNT(*)::int AS generation_count
    INTO duplicate_generation
    FROM lab_critical_alerts
   WHERE superseded_at IS NULL
   GROUP BY tenant_id, result_id
  HAVING COUNT(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'critical-alert generation reconciliation required for tenant %, result % (% current rows)',
      duplicate_generation.tenant_id,
      duplicate_generation.result_id,
      duplicate_generation.generation_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

ALTER TABLE lab_critical_alerts
  DROP CONSTRAINT IF EXISTS ex_lab_critical_alert_one_current,
  ADD CONSTRAINT ex_lab_critical_alert_one_current
    EXCLUDE USING gist (tenant_id WITH =, result_id WITH =)
    WHERE (superseded_at IS NULL)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_lab_critical_alert_current_generation
  ON lab_critical_alerts (tenant_id, result_id, id DESC)
  WHERE superseded_at IS NULL;

DROP INDEX IF EXISTS idx_critical_alerts_tenant_pending;
CREATE INDEX idx_critical_alerts_tenant_pending
  ON lab_critical_alerts (tenant_id, fired_at DESC)
  WHERE acknowledged_at IS NULL AND superseded_at IS NULL;

CREATE OR REPLACE VIEW bi_daily_ops_snapshot AS
SELECT
  CURRENT_DATE AS d,
  (SELECT COUNT(*)::int FROM appointments
    WHERE appointment_date = CURRENT_DATE) AS opd_today,
  (SELECT COUNT(*)::int FROM appointments
    WHERE appointment_date = CURRENT_DATE
      AND status IN ('COMPLETED','CHECKED_OUT')) AS opd_completed_today,
  (SELECT COUNT(*)::int FROM admissions
    WHERE status = 'admitted') AS ip_in_house,
  (SELECT COUNT(*)::int FROM ot_schedules
    WHERE scheduled_date = CURRENT_DATE
      AND status NOT IN ('cancelled')) AS or_cases_today,
  (SELECT COUNT(*)::int FROM lab_critical_alerts
    WHERE acknowledged_at IS NULL
      AND superseded_at IS NULL) AS open_critical_alerts,
  (SELECT COALESCE(SUM(amount), 0) FROM billing_payments
    WHERE collected_at::date = CURRENT_DATE
      AND reversed = false) AS collections_today,
  (SELECT COUNT(*)::int FROM insurance_preauth
    WHERE status = 'submitted') AS preauth_pending,
  (SELECT COUNT(*)::int FROM tpa_claims
    WHERE status IN ('submitted','queried')) AS claims_outstanding;

COMMENT ON COLUMN lab_critical_alerts.superseded_at IS
  'When this alert generation stopped being current because a corrected/amended value created a successor. Not a clinician acknowledgement.';
COMMENT ON COLUMN lab_critical_alerts.superseded_by_alert_id IS
  'Same-tenant successor alert generation.';
COMMENT ON COLUMN lab_critical_alerts.superseded_by_signoff_id IS
  'Same-tenant corrective pathologist sign-off that created the successor.';
COMMENT ON COLUMN lab_critical_alerts.generation_metadata IS
  'Immutable-at-ack provenance for the alert generation, independent of free-text read-back notes.';
COMMENT ON TABLE lab_critical_alert_reconciliation_receipts IS
  'Append-only typed evidence for corrected/amended sign-offs that legitimately created no alert, or were already superseded when late legacy reconciliation ran.';
COMMENT ON COLUMN lab_critical_alert_reconciliation_receipts.outcome IS
  'within_active_critical_thresholds, no_active_critical_threshold, or superseded_by_later_generation; never acknowledgement evidence.';

COMMIT;
