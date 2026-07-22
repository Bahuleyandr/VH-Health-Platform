-- Migration 591: structured Radiology/AP diagnostic generations and addenda.
--
-- Clinical classification is recorded only from an authenticated specialist's
-- explicit declaration. This migration performs no clinical backfill and does
-- not change any tenant pathway mode.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_radiology_orders_tenant_id
  ON radiology_orders (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_radiology_orders_tenant_id_patient
  ON radiology_orders (tenant_id, id, patient_uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_reports_tenant_id
  ON ap_reports (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_report_addenda_tenant_id
  ON ap_report_addenda (tenant_id, id);

ALTER TABLE radiology_orders
  ADD COLUMN result_classification VARCHAR(20),
  ADD COLUMN classification_basis JSONB,
  ADD COLUMN report_generation_version BIGINT,
  ADD COLUMN classification_signed_by UUID,
  ADD COLUMN classification_signed_at TIMESTAMPTZ(6),
  ADD COLUMN signoff_idempotency_key VARCHAR(200),
  ADD COLUMN signoff_request_sha256 CHAR(64),
  ADD CONSTRAINT fk_radiology_classification_signer
    FOREIGN KEY (tenant_id, classification_signed_by)
    REFERENCES users (tenant_id, uid),
  ADD CONSTRAINT chk_radiology_structured_classification CHECK (
    (
      result_classification IS NULL
      AND classification_basis IS NULL
      AND report_generation_version IS NULL
      AND classification_signed_by IS NULL
      AND classification_signed_at IS NULL
      AND signoff_idempotency_key IS NULL
      AND signoff_request_sha256 IS NULL
    )
    OR
    (
      result_classification IN ('critical', 'abnormal', 'normal', 'indeterminate')
      AND jsonb_typeof(classification_basis) = 'object'
      AND classification_basis <> '{}'::jsonb
      AND pg_column_size(classification_basis) <= 16384
      AND report_generation_version = 1
      AND classification_signed_by IS NOT NULL
      AND classification_signed_at IS NOT NULL
      AND signoff_idempotency_key ~ '^[A-Za-z0-9_.:-]{1,200}$'
      AND signoff_request_sha256 ~ '^[0-9a-f]{64}$'
      AND report_signed_off_by IS NOT DISTINCT FROM classification_signed_by
      AND report_signed_off_at IS NOT DISTINCT FROM classification_signed_at
    )
  );

ALTER TABLE ap_reports
  ADD COLUMN result_classification VARCHAR(20),
  ADD COLUMN classification_basis JSONB,
  ADD COLUMN report_generation_version BIGINT,
  ADD COLUMN classification_signed_by UUID,
  ADD COLUMN signoff_idempotency_key VARCHAR(200),
  ADD COLUMN signoff_request_sha256 CHAR(64),
  ADD CONSTRAINT fk_ap_report_classification_signer
    FOREIGN KEY (tenant_id, classification_signed_by)
    REFERENCES users (tenant_id, uid),
  ADD CONSTRAINT chk_ap_report_structured_classification CHECK (
    (
      result_classification IS NULL
      AND classification_basis IS NULL
      AND report_generation_version IS NULL
      AND classification_signed_by IS NULL
      AND signoff_idempotency_key IS NULL
      AND signoff_request_sha256 IS NULL
    )
    OR
    (
      result_classification IN ('critical', 'abnormal', 'normal', 'indeterminate')
      AND jsonb_typeof(classification_basis) = 'object'
      AND classification_basis <> '{}'::jsonb
      AND pg_column_size(classification_basis) <= 16384
      AND report_generation_version = 1
      AND classification_signed_by IS NOT NULL
      AND signoff_idempotency_key ~ '^[A-Za-z0-9_.:-]{1,200}$'
      AND signoff_request_sha256 ~ '^[0-9a-f]{64}$'
      AND signed_by IS NOT DISTINCT FROM classification_signed_by
      AND signed_at IS NOT NULL
    )
  );

CREATE TABLE radiology_report_addenda (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  radiology_order_id INTEGER NOT NULL,
  generation_version BIGINT NOT NULL,
  addendum_text TEXT NOT NULL,
  previous_classification VARCHAR(20) NOT NULL,
  result_classification VARCHAR(20) NOT NULL,
  classification_basis JSONB NOT NULL,
  clinical_significance VARCHAR(30) NOT NULL,
  signed_by UUID NOT NULL,
  signed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(200) NOT NULL,
  request_sha256 CHAR(64) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_radiology_report_addenda_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_radiology_report_addenda_version
    UNIQUE (tenant_id, radiology_order_id, generation_version),
  CONSTRAINT ux_radiology_report_addenda_idempotency
    UNIQUE (tenant_id, radiology_order_id, idempotency_key),
  CONSTRAINT fk_radiology_report_addenda_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT fk_radiology_report_addenda_order
    FOREIGN KEY (tenant_id, radiology_order_id)
    REFERENCES radiology_orders (tenant_id, id),
  CONSTRAINT fk_radiology_report_addenda_signer
    FOREIGN KEY (tenant_id, signed_by)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT chk_radiology_report_addendum_version CHECK (generation_version >= 2),
  CONSTRAINT chk_radiology_report_addendum_text CHECK (
    NULLIF(BTRIM(addendum_text), '') IS NOT NULL
  ),
  CONSTRAINT chk_radiology_report_addendum_classifications CHECK (
    previous_classification IN ('critical', 'abnormal', 'normal', 'indeterminate')
    AND result_classification IN ('critical', 'abnormal', 'normal', 'indeterminate')
  ),
  CONSTRAINT chk_radiology_report_addendum_basis CHECK (
    jsonb_typeof(classification_basis) = 'object'
    AND classification_basis <> '{}'::jsonb
    AND pg_column_size(classification_basis) <= 16384
  ),
  CONSTRAINT chk_radiology_report_addendum_significance CHECK (
    clinical_significance IN ('unchanged', 'new_finding', 'worsened', 'improved', 'corrected')
  ),
  CONSTRAINT chk_radiology_report_addendum_idempotency CHECK (
    idempotency_key ~ '^[A-Za-z0-9_.:-]{1,200}$'
    AND request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_radiology_report_addendum_metadata CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX idx_radiology_report_addenda_order
  ON radiology_report_addenda
     (tenant_id, radiology_order_id, generation_version DESC);

ALTER TABLE ap_report_addenda
  ADD COLUMN generation_version BIGINT,
  ADD COLUMN previous_classification VARCHAR(20),
  ADD COLUMN result_classification VARCHAR(20),
  ADD COLUMN classification_basis JSONB,
  ADD COLUMN clinical_significance VARCHAR(30),
  ADD COLUMN idempotency_key VARCHAR(200),
  ADD COLUMN request_sha256 CHAR(64),
  ADD CONSTRAINT fk_ap_report_addendum_signer
    FOREIGN KEY (tenant_id, addendum_by)
    REFERENCES users (tenant_id, uid),
  ADD CONSTRAINT ux_ap_report_addenda_version
    UNIQUE (tenant_id, ap_report_id, generation_version),
  ADD CONSTRAINT chk_ap_report_addendum_structured_evidence CHECK (
    (
      generation_version IS NULL
      AND previous_classification IS NULL
      AND result_classification IS NULL
      AND classification_basis IS NULL
      AND clinical_significance IS NULL
      AND idempotency_key IS NULL
      AND request_sha256 IS NULL
    )
    OR
    (
      generation_version >= 2
      AND previous_classification IN ('critical', 'abnormal', 'normal', 'indeterminate')
      AND result_classification IN ('critical', 'abnormal', 'normal', 'indeterminate')
      AND jsonb_typeof(classification_basis) = 'object'
      AND classification_basis <> '{}'::jsonb
      AND pg_column_size(classification_basis) <= 16384
      AND clinical_significance IN ('unchanged', 'new_finding', 'worsened', 'improved', 'corrected')
      AND addendum_by IS NOT NULL
      AND idempotency_key ~ '^[A-Za-z0-9_.:-]{1,200}$'
      AND request_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX ux_ap_report_addenda_idempotency
  ON ap_report_addenda (tenant_id, ap_report_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_signed_radiology_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.report_signed_off_at IS NOT NULL THEN
    RAISE EXCEPTION 'signed radiology report is append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.report_signed_off_at IS NOT NULL
     AND (
       OLD.report IS DISTINCT FROM NEW.report
       OR OLD.structured_report IS DISTINCT FROM NEW.structured_report
       OR OLD.report_completed_at IS DISTINCT FROM NEW.report_completed_at
       OR OLD.report_signed_off_at IS DISTINCT FROM NEW.report_signed_off_at
       OR OLD.report_signed_off_by IS DISTINCT FROM NEW.report_signed_off_by
       OR OLD.result_classification IS DISTINCT FROM NEW.result_classification
       OR OLD.classification_basis IS DISTINCT FROM NEW.classification_basis
       OR OLD.report_generation_version IS DISTINCT FROM NEW.report_generation_version
       OR OLD.classification_signed_by IS DISTINCT FROM NEW.classification_signed_by
       OR OLD.classification_signed_at IS DISTINCT FROM NEW.classification_signed_at
       OR OLD.signoff_idempotency_key IS DISTINCT FROM NEW.signoff_idempotency_key
       OR OLD.signoff_request_sha256 IS DISTINCT FROM NEW.signoff_request_sha256
     ) THEN
    RAISE EXCEPTION 'signed radiology report is append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_protect_signed_radiology_report
BEFORE UPDATE OR DELETE ON radiology_orders
FOR EACH ROW EXECUTE FUNCTION protect_signed_radiology_report();

CREATE OR REPLACE FUNCTION protect_signed_ap_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'signed anatomic pathology report is append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.signed_at IS NOT NULL
     AND (
       OLD.gross_text IS DISTINCT FROM NEW.gross_text
       OR OLD.microscopic_text IS DISTINCT FROM NEW.microscopic_text
       OR OLD.diagnosis_text IS DISTINCT FROM NEW.diagnosis_text
       OR OLD.synoptic_fields IS DISTINCT FROM NEW.synoptic_fields
       OR OLD.malignancy_flag IS DISTINCT FROM NEW.malignancy_flag
       OR OLD.report_author_uid IS DISTINCT FROM NEW.report_author_uid
       OR OLD.signed_at IS DISTINCT FROM NEW.signed_at
       OR OLD.signed_by IS DISTINCT FROM NEW.signed_by
       OR OLD.result_classification IS DISTINCT FROM NEW.result_classification
       OR OLD.classification_basis IS DISTINCT FROM NEW.classification_basis
       OR OLD.report_generation_version IS DISTINCT FROM NEW.report_generation_version
       OR OLD.classification_signed_by IS DISTINCT FROM NEW.classification_signed_by
       OR OLD.signoff_idempotency_key IS DISTINCT FROM NEW.signoff_idempotency_key
       OR OLD.signoff_request_sha256 IS DISTINCT FROM NEW.signoff_request_sha256
     ) THEN
    RAISE EXCEPTION 'signed anatomic pathology report is append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_protect_signed_ap_report
BEFORE UPDATE OR DELETE ON ap_reports
FOR EACH ROW EXECUTE FUNCTION protect_signed_ap_report();

CREATE TRIGGER trg_radiology_report_addenda_append_only
BEFORE UPDATE OR DELETE ON radiology_report_addenda
FOR EACH ROW EXECUTE FUNCTION diagnostic_result_evidence_append_only();

CREATE TRIGGER trg_ap_report_addenda_append_only
BEFORE UPDATE OR DELETE ON ap_report_addenda
FOR EACH ROW EXECUTE FUNCTION diagnostic_result_evidence_append_only();

ALTER TABLE diagnostic_result_generations
  ADD COLUMN radiology_order_id INTEGER,
  ADD COLUMN radiology_addendum_id BIGINT,
  ADD COLUMN ap_report_id BIGINT,
  ADD COLUMN ap_addendum_id BIGINT,
  ADD COLUMN critical_acknowledgement_task_id INTEGER,
  ADD COLUMN critical_acknowledgement_sla_id UUID,
  ADD CONSTRAINT fk_diagnostic_generation_radiology_order
    FOREIGN KEY (tenant_id, radiology_order_id, patient_uid)
    REFERENCES radiology_orders (tenant_id, id, patient_uid)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_diagnostic_generation_radiology_addendum
    FOREIGN KEY (tenant_id, radiology_addendum_id)
    REFERENCES radiology_report_addenda (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_diagnostic_generation_ap_report
    FOREIGN KEY (tenant_id, ap_report_id)
    REFERENCES ap_reports (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_diagnostic_generation_ap_addendum
    FOREIGN KEY (tenant_id, ap_addendum_id)
    REFERENCES ap_report_addenda (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_diagnostic_generation_critical_task
    FOREIGN KEY (tenant_id, critical_acknowledgement_task_id)
    REFERENCES tasks (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_diagnostic_generation_critical_sla
    FOREIGN KEY (tenant_id, critical_acknowledgement_sla_id)
    REFERENCES workflow_sla_instances (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE diagnostic_result_generations
  DROP CONSTRAINT chk_diagnostic_generation_source_kind,
  ADD CONSTRAINT chk_diagnostic_generation_source_kind CHECK (
    source_kind IN (
      'lab_panel',
      'shared_investigation',
      'radiology_report',
      'anatomical_pathology_report'
    )
  ),
  DROP CONSTRAINT chk_diagnostic_generation_source_shape,
  ADD CONSTRAINT chk_diagnostic_generation_source_shape CHECK (
    (
      source_kind = 'lab_panel'
      AND source_table = 'lab_pathologist_signoffs'
      AND lab_signoff_id IS NOT NULL
      AND radiology_order_id IS NULL
      AND radiology_addendum_id IS NULL
      AND ap_report_id IS NULL
      AND ap_addendum_id IS NULL
    )
    OR
    (
      source_kind = 'shared_investigation'
      AND source_table = 'investigations'
      AND investigation_id IS NOT NULL
      AND lab_signoff_id IS NULL
      AND radiology_order_id IS NULL
      AND radiology_addendum_id IS NULL
      AND ap_report_id IS NULL
      AND ap_addendum_id IS NULL
    )
    OR
    (
      source_kind = 'radiology_report'
      AND radiology_order_id IS NOT NULL
      AND lab_signoff_id IS NULL
      AND investigation_id IS NULL
      AND ap_report_id IS NULL
      AND ap_addendum_id IS NULL
      AND (
        (source_version = 1 AND source_table = 'radiology_orders' AND radiology_addendum_id IS NULL)
        OR
        (source_version >= 2 AND source_table = 'radiology_report_addenda' AND radiology_addendum_id IS NOT NULL)
      )
    )
    OR
    (
      source_kind = 'anatomical_pathology_report'
      AND ap_report_id IS NOT NULL
      AND lab_signoff_id IS NULL
      AND investigation_id IS NULL
      AND radiology_order_id IS NULL
      AND radiology_addendum_id IS NULL
      AND (
        (source_version = 1 AND source_table = 'ap_reports' AND ap_addendum_id IS NULL)
        OR
        (source_version >= 2 AND source_table = 'ap_report_addenda' AND ap_addendum_id IS NOT NULL)
      )
    )
  ),
  ADD CONSTRAINT chk_diagnostic_generation_critical_ack_shape CHECK (
    (
      critical_acknowledgement_task_id IS NULL
      AND critical_acknowledgement_sla_id IS NULL
    )
    OR
    (
      source_kind IN ('radiology_report', 'anatomical_pathology_report')
      AND classification = 'critical'
      AND critical_acknowledgement_task_id IS NOT NULL
      AND critical_acknowledgement_sla_id IS NOT NULL
    )
  );

ALTER TABLE diagnostic_result_generation_items
  DROP CONSTRAINT chk_diagnostic_generation_item_source,
  ADD CONSTRAINT chk_diagnostic_generation_item_source CHECK (
    source_table IN (
      'lab_results',
      'investigations',
      'radiology_orders',
      'radiology_report_addenda',
      'ap_reports',
      'ap_report_addenda'
    )
    AND NULLIF(BTRIM(source_row_id), '') IS NOT NULL
    AND NULLIF(BTRIM(source_version), '') IS NOT NULL
    AND source_ordinal > 0
    AND NULLIF(BTRIM(item_name), '') IS NOT NULL
  );

CREATE OR REPLACE FUNCTION validate_structured_diagnostic_generation_source()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  source_record RECORD;
  task_record RECORD;
  tenant_mode TEXT;
BEGIN
  IF NEW.source_kind = 'radiology_report' THEN
    IF NEW.radiology_addendum_id IS NULL THEN
      SELECT ro.patient_uid, ro.result_classification AS classification,
             ro.report_generation_version AS generation_version,
             ro.classification_signed_by AS signer_uid,
             ro.classification_signed_at AS signed_at
        INTO source_record
        FROM radiology_orders ro
       WHERE ro.tenant_id = NEW.tenant_id
         AND ro.id = NEW.radiology_order_id;
    ELSE
      SELECT ro.patient_uid, addendum.result_classification AS classification,
             addendum.generation_version,
             addendum.signed_by AS signer_uid,
             addendum.signed_at
        INTO source_record
        FROM radiology_report_addenda addendum
        JOIN radiology_orders ro
          ON ro.tenant_id = addendum.tenant_id
         AND ro.id = addendum.radiology_order_id
       WHERE addendum.tenant_id = NEW.tenant_id
         AND addendum.id = NEW.radiology_addendum_id
         AND addendum.radiology_order_id = NEW.radiology_order_id;
    END IF;
  ELSIF NEW.source_kind = 'anatomical_pathology_report' THEN
    IF NEW.ap_addendum_id IS NULL THEN
      SELECT ap_case.patient_uid, report.result_classification AS classification,
             report.report_generation_version AS generation_version,
             report.classification_signed_by AS signer_uid,
             report.signed_at
        INTO source_record
        FROM ap_reports report
        JOIN ap_cases ap_case
          ON ap_case.tenant_id = report.tenant_id
         AND ap_case.id = report.ap_case_id
       WHERE report.tenant_id = NEW.tenant_id
         AND report.id = NEW.ap_report_id;
    ELSE
      SELECT ap_case.patient_uid, addendum.result_classification AS classification,
             addendum.generation_version,
             addendum.addendum_by AS signer_uid,
             addendum.addendum_at AS signed_at
        INTO source_record
        FROM ap_report_addenda addendum
        JOIN ap_reports report
          ON report.tenant_id = addendum.tenant_id
         AND report.id = addendum.ap_report_id
        JOIN ap_cases ap_case
          ON ap_case.tenant_id = report.tenant_id
         AND ap_case.id = report.ap_case_id
       WHERE addendum.tenant_id = NEW.tenant_id
         AND addendum.id = NEW.ap_addendum_id
         AND addendum.ap_report_id = NEW.ap_report_id;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF NOT FOUND
     OR source_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR source_record.classification IS DISTINCT FROM NEW.classification
     OR source_record.generation_version IS DISTINCT FROM NEW.source_version
     OR source_record.signer_uid IS DISTINCT FROM NEW.signer_uid
     OR source_record.signed_at IS DISTINCT FROM NEW.signed_at THEN
    RAISE EXCEPTION 'structured diagnostic generation source evidence mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT LOWER(COALESCE(
           settings #>> ARRAY['care_pathways', 'diagnostics_order_to_action'],
           'off'
         ))
    INTO tenant_mode
    FROM tenants
   WHERE id = NEW.tenant_id;

  IF tenant_mode = 'active'
     AND NEW.classification IN ('critical', 'abnormal', 'indeterminate')
     AND NEW.ordering_owner_uid IS NULL THEN
    RAISE EXCEPTION 'active actionable structured generation requires its named ordering owner'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.classification = 'critical' AND tenant_mode = 'active' THEN
    IF NEW.critical_acknowledgement_task_id IS NULL
       OR NEW.critical_acknowledgement_sla_id IS NULL THEN
      RAISE EXCEPTION 'active critical structured generation requires acknowledgement work'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.critical_acknowledgement_task_id IS NOT NULL THEN
    SELECT task.id
      INTO task_record
      FROM tasks task
      JOIN workflow_sla_instances sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.tenant_id = NEW.tenant_id
       AND task.id = NEW.critical_acknowledgement_task_id
       AND task.patient_uid = NEW.patient_uid
       AND task.related_resource_type = 'diagnostic_result_generation'
       AND task.related_resource_id = NEW.id::text
       AND task.sla_completion_semantics = 'acknowledgement'
       AND task.workflow_sla_instance_id = NEW.critical_acknowledgement_sla_id
       AND task.assigned_to_uid = NEW.ordering_owner_uid
       AND task.assigned_to_role IS NULL
       AND sla.rule_code = 'critical_result_ack'
       AND sla.source_table = 'diagnostic_result_generation'
       AND sla.source_id = NEW.id::text;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'structured critical acknowledgement evidence mismatch'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER trg_validate_structured_diagnostic_generation_source
AFTER INSERT ON diagnostic_result_generations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.source_kind IN ('radiology_report', 'anatomical_pathology_report'))
EXECUTE FUNCTION validate_structured_diagnostic_generation_source();

ALTER TABLE radiology_report_addenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiology_report_addenda FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON radiology_report_addenda
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

COMMENT ON TABLE radiology_report_addenda IS
  'Append-only specialist-signed Radiology report amendments; raw text never enters pathway events.';
COMMENT ON COLUMN radiology_orders.result_classification IS
  'Explicit specialist-signed classification; never inferred from report text, priority, TAT or AI.';
COMMENT ON COLUMN ap_reports.result_classification IS
  'Explicit pathologist-signed classification; legacy NULL is a reconciliation/backfill blocker.';
COMMENT ON COLUMN diagnostic_result_generations.critical_acknowledgement_task_id IS
  'Generation-specific acknowledgement obligation for active critical Radiology/AP results.';

COMMIT;
