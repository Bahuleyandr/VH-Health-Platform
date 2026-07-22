-- Migration 589: immutable diagnostic result generations and doctor actions.
--
-- These tables retain clinical evidence. Mutable execution continues to use
-- care_pathway_instances, tasks, workflow steps and workflow SLA instances.
-- No historical clinical classification is inferred by this migration.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_diagnostic_signature_tenant_id
  ON clinical_document_signatures (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_diagnostic_timeline_tenant_id
  ON clinical_timeline_events (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_diagnostic_audit_tenant_id
  ON clinical_audit_events (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_diagnostic_task_tenant_id
  ON tasks (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_diagnostic_investigations_tenant_id
  ON investigations (tenant_id, id);

CREATE TABLE diagnostic_result_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  source_kind VARCHAR(40) NOT NULL,
  source_table VARCHAR(100) NOT NULL,
  source_episode_type VARCHAR(80) NOT NULL,
  source_episode_key VARCHAR(160) NOT NULL,
  source_version BIGINT NOT NULL,
  lab_signoff_id INTEGER,
  investigation_id INTEGER,
  ordering_owner_uid UUID,
  owner_source VARCHAR(40) NOT NULL,
  signer_uid UUID NOT NULL,
  signer_role VARCHAR(80) NOT NULL,
  signed_at TIMESTAMPTZ(6) NOT NULL,
  classification VARCHAR(20) NOT NULL,
  classification_basis JSONB NOT NULL,
  snapshot_sha256 CHAR(64) NOT NULL,
  item_count INTEGER NOT NULL,
  predecessor_generation_id UUID,
  canonical_timeline_event_id UUID NOT NULL,
  canonical_audit_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_diagnostic_generations_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_diagnostic_generations_tenant_patient
    UNIQUE (tenant_id, id, patient_uid),
  CONSTRAINT ux_diagnostic_generation_source_version
    UNIQUE (tenant_id, source_kind, source_episode_key, source_version),
  CONSTRAINT fk_diagnostic_generation_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT fk_diagnostic_generation_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_diagnostic_generation_encounter
    FOREIGN KEY (tenant_id, encounter_id, patient_uid)
    REFERENCES patient_encounters (tenant_id, id, patient_uid)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_generation_owner
    FOREIGN KEY (tenant_id, ordering_owner_uid)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_diagnostic_generation_signer
    FOREIGN KEY (tenant_id, signer_uid)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_diagnostic_generation_lab_signoff
    FOREIGN KEY (tenant_id, lab_signoff_id, patient_uid)
    REFERENCES lab_pathologist_signoffs (tenant_id, id, patient_uid)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_generation_investigation
    FOREIGN KEY (tenant_id, investigation_id)
    REFERENCES investigations (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_generation_predecessor
    FOREIGN KEY (tenant_id, predecessor_generation_id, patient_uid)
    REFERENCES diagnostic_result_generations (tenant_id, id, patient_uid)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_generation_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_generation_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_diagnostic_generation_source_kind CHECK (
    source_kind IN ('lab_panel', 'shared_investigation')
  ),
  CONSTRAINT chk_diagnostic_generation_source_shape CHECK (
    (
      source_kind = 'lab_panel'
      AND source_table = 'lab_pathologist_signoffs'
      AND lab_signoff_id IS NOT NULL
    )
    OR
    (
      source_kind = 'shared_investigation'
      AND source_table = 'investigations'
      AND investigation_id IS NOT NULL
      AND lab_signoff_id IS NULL
    )
  ),
  CONSTRAINT chk_diagnostic_generation_source_text CHECK (
    NULLIF(BTRIM(source_episode_type), '') IS NOT NULL
    AND NULLIF(BTRIM(source_episode_key), '') IS NOT NULL
    AND source_version > 0
  ),
  CONSTRAINT chk_diagnostic_generation_owner_source CHECK (
    (owner_source = 'named_orderer' AND ordering_owner_uid IS NOT NULL)
    OR (owner_source = 'unnamed_role_queue' AND ordering_owner_uid IS NULL)
  ),
  CONSTRAINT chk_diagnostic_generation_signer_role CHECK (
    NULLIF(BTRIM(signer_role), '') IS NOT NULL
  ),
  CONSTRAINT chk_diagnostic_generation_classification CHECK (
    classification IN ('critical', 'abnormal', 'normal', 'indeterminate')
  ),
  CONSTRAINT chk_diagnostic_generation_basis_object CHECK (
    jsonb_typeof(classification_basis) = 'object'
  ),
  CONSTRAINT chk_diagnostic_generation_hash CHECK (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_diagnostic_generation_item_count CHECK (item_count > 0),
  CONSTRAINT chk_diagnostic_generation_not_self_predecessor CHECK (
    predecessor_generation_id IS NULL OR predecessor_generation_id <> id
  )
);

CREATE INDEX idx_diagnostic_generations_patient_time
  ON diagnostic_result_generations (tenant_id, patient_uid, signed_at DESC, id DESC);
CREATE INDEX idx_diagnostic_generations_owner_open
  ON diagnostic_result_generations (tenant_id, ordering_owner_uid, signed_at DESC)
  WHERE ordering_owner_uid IS NOT NULL;
CREATE INDEX idx_diagnostic_generations_episode
  ON diagnostic_result_generations
     (tenant_id, source_kind, source_episode_key, source_version DESC);
CREATE UNIQUE INDEX ux_diagnostic_generations_successor
  ON diagnostic_result_generations (tenant_id, predecessor_generation_id, patient_uid);

-- Migration 581 could supersede a critical alert only with another critical
-- alert, which forced a new critical task even when a signed correction was
-- normal, abnormal-noncritical or indeterminate. A diagnostic generation is
-- now the typed alternative successor for those three branches.
ALTER TABLE lab_critical_alerts
  ADD COLUMN superseded_by_diagnostic_generation_id UUID;

ALTER TABLE lab_critical_alerts
  DROP CONSTRAINT chk_lab_critical_alert_supersession_complete,
  ADD CONSTRAINT chk_lab_critical_alert_supersession_complete CHECK (
    (
      superseded_at IS NULL
      AND superseded_by_alert_id IS NULL
      AND superseded_by_signoff_id IS NULL
      AND superseded_by_diagnostic_generation_id IS NULL
    )
    OR
    (
      superseded_at IS NOT NULL
      AND superseded_by_signoff_id IS NOT NULL
      AND num_nonnulls(
        superseded_by_alert_id,
        superseded_by_diagnostic_generation_id
      ) = 1
    )
  ),
  ADD CONSTRAINT fk_lab_critical_alert_diagnostic_successor
    FOREIGN KEY (tenant_id, superseded_by_diagnostic_generation_id)
    REFERENCES diagnostic_result_generations (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_lab_critical_alert_diagnostic_successor
  ON lab_critical_alerts (tenant_id, superseded_by_diagnostic_generation_id)
  WHERE superseded_by_diagnostic_generation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_lab_critical_alert_supersession()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  successor lab_critical_alerts%ROWTYPE;
  diagnostic_successor diagnostic_result_generations%ROWTYPE;
  signoff lab_pathologist_signoffs%ROWTYPE;
  linked_task RECORD;
BEGIN
  IF NEW.superseded_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO signoff
    FROM lab_pathologist_signoffs
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.superseded_by_signoff_id;
  IF NOT FOUND
     OR signoff.decision NOT IN ('corrected', 'amended')
     OR (NEW.result_id = ANY(signoff.result_ids)) IS NOT TRUE
     OR signoff.patient_uid <> NEW.patient_uid
     OR signoff.signed_at < NEW.fired_at THEN
    RAISE EXCEPTION 'invalid critical-alert corrective sign-off'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.superseded_by_diagnostic_generation_id IS NOT NULL THEN
    SELECT * INTO diagnostic_successor
      FROM diagnostic_result_generations
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.superseded_by_diagnostic_generation_id;
    IF NOT FOUND
       OR diagnostic_successor.patient_uid <> NEW.patient_uid
       OR diagnostic_successor.source_kind <> 'lab_panel'
       OR diagnostic_successor.lab_signoff_id <> signoff.id
       OR diagnostic_successor.classification = 'critical'
       OR diagnostic_successor.signed_at IS DISTINCT FROM signoff.signed_at
       OR signoff.signed_at > NEW.superseded_at THEN
      RAISE EXCEPTION
        'invalid noncritical diagnostic successor generation: found=%, patient_match=%, source_kind=%, signoff_match=%, classification=%, signed_at_match=%, signoff_before_supersession=%',
        diagnostic_successor.id IS NOT NULL,
        diagnostic_successor.patient_uid = NEW.patient_uid,
        diagnostic_successor.source_kind,
        diagnostic_successor.lab_signoff_id = signoff.id,
        diagnostic_successor.classification,
        diagnostic_successor.signed_at IS NOT DISTINCT FROM signoff.signed_at,
        signoff.signed_at <= NEW.superseded_at
        USING ERRCODE = '23514';
    END IF;
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
     OR successor.superseded_at IS NOT NULL
     OR signoff.signed_at > successor.fired_at
     OR successor.generation_signoff_id <> signoff.id THEN
    RAISE EXCEPTION 'invalid critical-alert successor generation'
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

DROP TRIGGER trg_validate_lab_critical_alert_supersession ON lab_critical_alerts;
CREATE CONSTRAINT TRIGGER trg_validate_lab_critical_alert_supersession
AFTER INSERT OR UPDATE OF superseded_at, superseded_by_alert_id,
  superseded_by_signoff_id, superseded_by_diagnostic_generation_id
ON lab_critical_alerts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.superseded_at IS NOT NULL)
EXECUTE FUNCTION validate_lab_critical_alert_supersession();

-- Migration 581 requires every critical-result SLA to retain one current lab
-- alert generation. A noncritical signed correction now terminates that legacy
-- acknowledgement obligation in favour of its diagnostic generation, so the
-- zero-current state is valid only with exact task/SLA supersession evidence.
ALTER FUNCTION assert_lab_critical_alert_sla_generation_state(UUID, UUID)
  RENAME TO assert_lab_critical_alert_sla_generation_state_legacy;

CREATE FUNCTION assert_lab_critical_alert_sla_generation_state(
  p_tenant_id UUID,
  p_sla_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  current_generation_count INTEGER;
  terminal_generation_count INTEGER;
  acknowledged_alert RECORD;
BEGIN
  SELECT COUNT(*)::int
    INTO current_generation_count
    FROM lab_critical_alerts AS alert
    JOIN tasks AS task
      ON task.tenant_id = alert.tenant_id
     AND task.id = alert.acknowledgement_task_id
   WHERE task.tenant_id = p_tenant_id
     AND task.workflow_sla_instance_id = p_sla_id
     AND alert.superseded_at IS NULL;

  IF current_generation_count <> 0 THEN
    RETURN assert_lab_critical_alert_sla_generation_state_legacy(
      p_tenant_id,
      p_sla_id
    );
  END IF;

  SELECT COUNT(*)::int
    INTO terminal_generation_count
    FROM lab_critical_alerts AS alert
    JOIN tasks AS task
      ON task.tenant_id = alert.tenant_id
     AND task.id = alert.acknowledgement_task_id
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
    JOIN diagnostic_result_generations AS generation
      ON generation.tenant_id = alert.tenant_id
     AND generation.id = alert.superseded_by_diagnostic_generation_id
   WHERE task.tenant_id = p_tenant_id
     AND task.workflow_sla_instance_id = p_sla_id
     AND alert.superseded_at IS NOT NULL
     AND alert.superseded_by_diagnostic_generation_id IS NOT NULL
     AND alert.superseded_by_signoff_id = generation.lab_signoff_id
     AND generation.classification <> 'critical'
     AND task.status = 'completed'
     AND task.sla_completion_semantics = 'acknowledgement'
     AND task.metadata->>'supersession_reason'
           = 'diagnostic_generation_noncritical_correction'
     AND task.metadata->>'superseded_by_diagnostic_generation_id'
           = generation.id::text
     AND sla.status = 'completed'
     AND sla.completed_at IS NOT NULL
     AND sla.metadata->>'completed_via' = 'task_completion'
     AND sla.metadata->>'completed_by_task' = task.id::text
     AND sla.metadata->>'supersession_reason'
           = 'diagnostic_generation_noncritical_correction'
     AND sla.metadata->>'superseded_by_diagnostic_generation_id'
           = generation.id::text
     AND sla.metadata->>'superseded_by_actor_uid'
           = task.metadata->>'superseded_by_actor_uid';

  IF terminal_generation_count <> 1 THEN
    RETURN assert_lab_critical_alert_sla_generation_state_legacy(
      p_tenant_id,
      p_sla_id
    );
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

  RETURN TRUE;
END
$$;

CREATE OR REPLACE FUNCTION protect_lab_critical_alert_diagnostic_successor()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL
     AND OLD.superseded_by_diagnostic_generation_id IS DISTINCT FROM
         NEW.superseded_by_diagnostic_generation_id THEN
    RAISE EXCEPTION 'critical-alert diagnostic supersession is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_protect_lab_critical_alert_diagnostic_successor
BEFORE UPDATE OF superseded_by_diagnostic_generation_id ON lab_critical_alerts
FOR EACH ROW EXECUTE FUNCTION protect_lab_critical_alert_diagnostic_successor();

CREATE TABLE diagnostic_result_generation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  generation_id UUID NOT NULL,
  source_table VARCHAR(100) NOT NULL,
  source_row_id VARCHAR(120) NOT NULL,
  source_version VARCHAR(120) NOT NULL,
  source_ordinal INTEGER NOT NULL,
  item_code VARCHAR(120),
  item_name VARCHAR(240) NOT NULL,
  value_snapshot JSONB NOT NULL,
  normalized_flag VARCHAR(20),
  source_critical BOOLEAN,
  classification VARCHAR(20) NOT NULL,
  item_snapshot_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_diagnostic_generation_items_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_diagnostic_generation_item_source
    UNIQUE (tenant_id, generation_id, source_table, source_row_id, source_version, source_ordinal),
  CONSTRAINT fk_diagnostic_generation_item_generation
    FOREIGN KEY (tenant_id, generation_id, patient_uid)
    REFERENCES diagnostic_result_generations (tenant_id, id, patient_uid)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_diagnostic_generation_item_source CHECK (
    source_table IN ('lab_results', 'investigations')
    AND NULLIF(BTRIM(source_row_id), '') IS NOT NULL
    AND NULLIF(BTRIM(source_version), '') IS NOT NULL
    AND source_ordinal > 0
    AND NULLIF(BTRIM(item_name), '') IS NOT NULL
  ),
  CONSTRAINT chk_diagnostic_generation_item_value_object CHECK (
    jsonb_typeof(value_snapshot) = 'object'
    AND pg_column_size(value_snapshot) <= 16384
  ),
  CONSTRAINT chk_diagnostic_generation_item_classification CHECK (
    classification IN ('critical', 'abnormal', 'normal', 'indeterminate')
  ),
  CONSTRAINT chk_diagnostic_generation_item_hash CHECK (
    item_snapshot_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX idx_diagnostic_generation_items_generation
  ON diagnostic_result_generation_items
     (tenant_id, generation_id, source_ordinal);

CREATE TABLE diagnostic_result_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  generation_id UUID NOT NULL,
  pathway_instance_id UUID,
  task_id INTEGER,
  action_kind VARCHAR(40) NOT NULL,
  disposition VARCHAR(30),
  clinical_note TEXT,
  reason TEXT,
  generation_snapshot_sha256 CHAR(64) NOT NULL,
  actor_uid UUID,
  actor_role VARCHAR(80),
  downstream_resource_type VARCHAR(80),
  downstream_resource_id VARCHAR(160),
  idempotency_key VARCHAR(200) NOT NULL,
  request_sha256 CHAR(64) NOT NULL,
  predecessor_action_id UUID,
  superseding_generation_id UUID,
  release_decision JSONB,
  signature_id UUID,
  canonical_timeline_event_id UUID NOT NULL,
  canonical_audit_event_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_diagnostic_actions_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_diagnostic_actions_tenant_patient UNIQUE (tenant_id, id, patient_uid),
  CONSTRAINT ux_diagnostic_action_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_diagnostic_action_generation
    FOREIGN KEY (tenant_id, generation_id, patient_uid)
    REFERENCES diagnostic_result_generations (tenant_id, id, patient_uid)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_action_pathway
    FOREIGN KEY (tenant_id, pathway_instance_id, patient_uid)
    REFERENCES care_pathway_instances (tenant_id, id, patient_uid)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_action_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_action_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_diagnostic_action_predecessor
    FOREIGN KEY (tenant_id, predecessor_action_id, patient_uid)
    REFERENCES diagnostic_result_actions (tenant_id, id, patient_uid)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_action_superseding_generation
    FOREIGN KEY (tenant_id, superseding_generation_id, patient_uid)
    REFERENCES diagnostic_result_generations (tenant_id, id, patient_uid)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_action_signature
    FOREIGN KEY (tenant_id, signature_id)
    REFERENCES clinical_document_signatures (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_action_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_diagnostic_action_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_diagnostic_action_kind CHECK (
    action_kind IN (
      'normal_auto_closed',
      'doctor_reopened',
      'doctor_disposition',
      'generation_superseded'
    )
  ),
  CONSTRAINT chk_diagnostic_action_disposition CHECK (
    disposition IS NULL
    OR disposition IN ('treated', 'repeated', 'referred', 'no_action')
  ),
  CONSTRAINT chk_diagnostic_action_hashes CHECK (
    generation_snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_diagnostic_action_identity CHECK (
    NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
  ),
  CONSTRAINT chk_diagnostic_action_release_decision CHECK (
    release_decision IS NULL OR jsonb_typeof(release_decision) = 'object'
  ),
  CONSTRAINT chk_diagnostic_action_shape CHECK (
    (
      action_kind = 'normal_auto_closed'
      AND disposition IS NULL
      AND clinical_note IS NULL
      AND reason IS NULL
      AND actor_uid IS NULL
      AND actor_role IS NULL
      AND predecessor_action_id IS NULL
      AND superseding_generation_id IS NULL
      AND release_decision IS NOT NULL
      AND signature_id IS NULL
    )
    OR
    (
      action_kind = 'doctor_reopened'
      AND disposition IS NULL
      AND clinical_note IS NULL
      AND NULLIF(BTRIM(reason), '') IS NOT NULL
      AND actor_uid IS NOT NULL
      AND NULLIF(BTRIM(actor_role), '') IS NOT NULL
      AND predecessor_action_id IS NOT NULL
      AND superseding_generation_id IS NULL
      AND release_decision IS NULL
      AND signature_id IS NULL
    )
    OR
    (
      action_kind = 'doctor_disposition'
      AND disposition IS NOT NULL
      AND NULLIF(BTRIM(clinical_note), '') IS NOT NULL
      AND actor_uid IS NOT NULL
      AND NULLIF(BTRIM(actor_role), '') IS NOT NULL
      AND superseding_generation_id IS NULL
      AND release_decision IS NULL
      AND signature_id IS NOT NULL
      AND (
        (disposition = 'no_action'
          AND NULLIF(BTRIM(reason), '') IS NOT NULL
          AND downstream_resource_type IS NULL
          AND downstream_resource_id IS NULL)
        OR
        (disposition IN ('treated', 'repeated', 'referred')
          AND num_nonnulls(downstream_resource_type, downstream_resource_id) IN (0, 2))
      )
    )
    OR
    (
      action_kind = 'generation_superseded'
      AND disposition IS NULL
      AND clinical_note IS NULL
      AND reason IS NULL
      AND actor_uid IS NULL
      AND actor_role IS NULL
      AND superseding_generation_id IS NOT NULL
      AND release_decision IS NULL
      AND signature_id IS NULL
    )
  )
);

CREATE UNIQUE INDEX ux_diagnostic_action_normal_close
  ON diagnostic_result_actions (
    tenant_id,
    generation_id,
    ((action_kind = 'normal_auto_closed'))
  )
  WHERE action_kind = 'normal_auto_closed';
CREATE UNIQUE INDEX ux_diagnostic_action_doctor_disposition
  ON diagnostic_result_actions (
    tenant_id,
    generation_id,
    ((action_kind = 'doctor_disposition'))
  )
  WHERE action_kind = 'doctor_disposition';
CREATE UNIQUE INDEX ux_diagnostic_action_doctor_reopened
  ON diagnostic_result_actions (
    tenant_id,
    generation_id,
    ((action_kind = 'doctor_reopened'))
  )
  WHERE action_kind = 'doctor_reopened';
CREATE UNIQUE INDEX ux_diagnostic_action_generation_superseded
  ON diagnostic_result_actions (
    tenant_id,
    generation_id,
    ((action_kind = 'generation_superseded'))
  )
  WHERE action_kind = 'generation_superseded';
CREATE UNIQUE INDEX ux_diagnostic_action_signature
  ON diagnostic_result_actions (tenant_id, signature_id)
  WHERE signature_id IS NOT NULL;
CREATE INDEX idx_diagnostic_actions_pathway_time
  ON diagnostic_result_actions (tenant_id, pathway_instance_id, occurred_at DESC)
  WHERE pathway_instance_id IS NOT NULL;
CREATE INDEX idx_diagnostic_actions_task
  ON diagnostic_result_actions (tenant_id, task_id)
  WHERE task_id IS NOT NULL;

CREATE UNIQUE INDEX ux_clinical_signature_diagnostic_action
  ON clinical_document_signatures (tenant_id, document_id)
  WHERE document_type = 'diagnostic_result_action'
    AND document_table = 'diagnostic_result_actions';

CREATE OR REPLACE FUNCTION diagnostic_result_evidence_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER trg_diagnostic_generations_append_only
BEFORE UPDATE OR DELETE ON diagnostic_result_generations
FOR EACH ROW EXECUTE FUNCTION diagnostic_result_evidence_append_only();

CREATE TRIGGER trg_diagnostic_generation_items_append_only
BEFORE UPDATE OR DELETE ON diagnostic_result_generation_items
FOR EACH ROW EXECUTE FUNCTION diagnostic_result_evidence_append_only();

CREATE TRIGGER trg_diagnostic_actions_append_only
BEFORE UPDATE OR DELETE ON diagnostic_result_actions
FOR EACH ROW EXECUTE FUNCTION diagnostic_result_evidence_append_only();

CREATE OR REPLACE FUNCTION validate_diagnostic_generation_predecessor()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  predecessor RECORD;
BEGIN
  IF NEW.predecessor_generation_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT source_kind, source_episode_key, source_version, signed_at
    INTO predecessor
    FROM diagnostic_result_generations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.predecessor_generation_id
     AND patient_uid = NEW.patient_uid;
  IF NOT FOUND
     OR predecessor.source_kind IS DISTINCT FROM NEW.source_kind
     OR predecessor.source_episode_key IS DISTINCT FROM NEW.source_episode_key
     OR predecessor.source_version >= NEW.source_version
     OR predecessor.signed_at > NEW.signed_at THEN
    RAISE EXCEPTION 'invalid diagnostic generation predecessor chain'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER trg_validate_diagnostic_generation_predecessor
AFTER INSERT ON diagnostic_result_generations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_diagnostic_generation_predecessor();

CREATE OR REPLACE FUNCTION assert_diagnostic_generation_complete(
  p_tenant_id UUID,
  p_generation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  generation_record RECORD;
  actual_count INTEGER;
  aggregate_hash TEXT;
BEGIN
  SELECT item_count, snapshot_sha256
    INTO generation_record
    FROM diagnostic_result_generations
   WHERE tenant_id = p_tenant_id
     AND id = p_generation_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::integer,
         encode(digest(string_agg(item_snapshot_sha256::text, ':' ORDER BY source_ordinal, id), 'sha256'), 'hex')
    INTO actual_count, aggregate_hash
    FROM diagnostic_result_generation_items
   WHERE tenant_id = p_tenant_id
     AND generation_id = p_generation_id;

  IF actual_count <> generation_record.item_count
     OR actual_count = 0
     OR aggregate_hash IS DISTINCT FROM generation_record.snapshot_sha256::text THEN
    RAISE EXCEPTION 'diagnostic generation is incomplete or its aggregate hash is invalid'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION validate_diagnostic_generation_complete_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'diagnostic_result_generations' THEN
    PERFORM assert_diagnostic_generation_complete(NEW.tenant_id, NEW.id);
  ELSE
    PERFORM assert_diagnostic_generation_complete(NEW.tenant_id, NEW.generation_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE CONSTRAINT TRIGGER trg_validate_diagnostic_generation_complete
AFTER INSERT ON diagnostic_result_generations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_diagnostic_generation_complete_trigger();

CREATE CONSTRAINT TRIGGER trg_validate_diagnostic_generation_items_complete
AFTER INSERT ON diagnostic_result_generation_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_diagnostic_generation_complete_trigger();

CREATE OR REPLACE FUNCTION validate_diagnostic_result_action()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  generation_record RECORD;
  predecessor_record RECORD;
  signature_record RECORD;
BEGIN
  SELECT classification, snapshot_sha256, source_episode_key, source_version
    INTO generation_record
    FROM diagnostic_result_generations
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.generation_id
     AND patient_uid = NEW.patient_uid;
  IF NOT FOUND
     OR generation_record.snapshot_sha256 IS DISTINCT FROM NEW.generation_snapshot_sha256 THEN
    RAISE EXCEPTION 'diagnostic action does not attest its generation snapshot'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.action_kind = 'normal_auto_closed'
     AND generation_record.classification <> 'normal' THEN
    RAISE EXCEPTION 'only an explicitly normal generation may auto-close'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.action_kind = 'doctor_reopened' THEN
    SELECT action_kind, generation_id
      INTO predecessor_record
      FROM diagnostic_result_actions
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.predecessor_action_id
       AND patient_uid = NEW.patient_uid;
    IF NOT FOUND
       OR predecessor_record.action_kind <> 'normal_auto_closed'
       OR predecessor_record.generation_id <> NEW.generation_id THEN
      RAISE EXCEPTION 'doctor reopen must link the exact normal auto-closure'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.action_kind = 'generation_superseded' THEN
    IF NEW.predecessor_action_id IS NOT NULL THEN
      SELECT generation_id
        INTO predecessor_record
        FROM diagnostic_result_actions
       WHERE tenant_id = NEW.tenant_id
         AND id = NEW.predecessor_action_id
         AND patient_uid = NEW.patient_uid;
      IF NOT FOUND OR predecessor_record.generation_id <> NEW.generation_id THEN
        RAISE EXCEPTION 'generation supersession predecessor action is invalid'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM diagnostic_result_generations AS successor
       WHERE successor.tenant_id = NEW.tenant_id
         AND successor.id = NEW.superseding_generation_id
         AND successor.patient_uid = NEW.patient_uid
         AND successor.predecessor_generation_id = NEW.generation_id
         AND successor.source_episode_key = generation_record.source_episode_key
         AND successor.source_version > generation_record.source_version
    ) THEN
      RAISE EXCEPTION 'generation supersession does not link its exact successor'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.action_kind = 'doctor_disposition' THEN
    SELECT document_type, document_table, document_id, patient_uid,
           signer_uid, signer_role, content_hash, audit_event_id
      INTO signature_record
      FROM clinical_document_signatures
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.signature_id;
    IF NOT FOUND
       OR signature_record.document_type <> 'diagnostic_result_action'
       OR signature_record.document_table <> 'diagnostic_result_actions'
       OR signature_record.document_id <> NEW.id::text
       OR signature_record.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR signature_record.signer_uid IS DISTINCT FROM NEW.actor_uid
       OR signature_record.signer_role IS DISTINCT FROM NEW.actor_role
       OR signature_record.audit_event_id IS DISTINCT FROM NEW.canonical_audit_event_id THEN
      RAISE EXCEPTION 'doctor disposition requires one matching sealed signature'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER trg_validate_diagnostic_result_action
AFTER INSERT ON diagnostic_result_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_diagnostic_result_action();

CREATE OR REPLACE FUNCTION protect_diagnostic_result_action_signature()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.document_type = 'diagnostic_result_action'
     AND OLD.document_table = 'diagnostic_result_actions' THEN
    RAISE EXCEPTION 'diagnostic result action signatures are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_protect_diagnostic_result_action_signature
BEFORE UPDATE OR DELETE ON clinical_document_signatures
FOR EACH ROW EXECUTE FUNCTION protect_diagnostic_result_action_signature();

ALTER TABLE diagnostic_result_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnostic_result_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON diagnostic_result_generations
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

ALTER TABLE diagnostic_result_generation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnostic_result_generation_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON diagnostic_result_generation_items
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

ALTER TABLE diagnostic_result_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnostic_result_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON diagnostic_result_actions
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

COMMENT ON TABLE diagnostic_result_generations IS
  'Append-only complete signed diagnostic result episode versions consumed by the care-pathway spine.';
COMMENT ON TABLE diagnostic_result_generation_items IS
  'Append-only structured source snapshots whose ordered hashes seal one diagnostic generation.';
COMMENT ON TABLE diagnostic_result_actions IS
  'Append-only normal closure, reopen, doctor disposition and supersession evidence; not a workflow engine.';

COMMIT;
