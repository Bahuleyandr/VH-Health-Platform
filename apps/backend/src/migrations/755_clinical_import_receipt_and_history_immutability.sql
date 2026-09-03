BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE clinical_import_document_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  patient_id integer NOT NULL,
  patient_uid uuid NOT NULL,
  source_facility_id integer NOT NULL,
  actor_uid uuid NOT NULL,
  actor_role varchar(80) NOT NULL,
  ingestion_mode varchar(40) NOT NULL,
  document_format varchar(30) NOT NULL,
  source_system varchar(255) NOT NULL,
  source_document_id varchar(255) NOT NULL,
  asserted_source_signature_sha256 char(64) NOT NULL,
  source_payload_sha256 char(64) NOT NULL,
  source_identity_sha256 char(64) NOT NULL,
  idempotency_key_sha256 char(64) NOT NULL,
  resource_manifest_sha256 char(64) NOT NULL,
  resource_manifest jsonb NOT NULL,
  result jsonb NOT NULL,
  status varchar(40) NOT NULL,
  request_id varchar(120),
  canonical_timeline_event_id uuid NOT NULL,
  canonical_audit_event_id uuid NOT NULL,
  contract_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_clinical_import_document_actor_role_755
    CHECK (actor_role = 'MEDICAL_RECORDS'),
  CONSTRAINT ck_clinical_import_document_mode_755
    CHECK (ingestion_mode = 'manual_medical_records'),
  CONSTRAINT ck_clinical_import_document_format_755
    CHECK (document_format IN ('fhir_bundle', 'ccda')),
  CONSTRAINT ck_clinical_import_document_status_755
    CHECK (status IN ('completed', 'completed_with_errors')),
  CONSTRAINT ck_clinical_import_document_hashes_755
    CHECK (
      asserted_source_signature_sha256 ~ '^[0-9a-f]{64}$'
      AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
      AND source_identity_sha256 ~ '^[0-9a-f]{64}$'
      AND idempotency_key_sha256 ~ '^[0-9a-f]{64}$'
      AND resource_manifest_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT ck_clinical_import_document_json_755
    CHECK (
      jsonb_typeof(resource_manifest) = 'array'
      AND jsonb_array_length(resource_manifest) > 0
      AND jsonb_typeof(result) = 'object'
    ),
  CONSTRAINT ck_clinical_import_document_contract_755
    CHECK (contract_version = 1),
  CONSTRAINT ux_clinical_import_document_tenant_id_755
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_clinical_import_document_tenant_id_patient_755
    UNIQUE (tenant_id, id, patient_uid),
  CONSTRAINT ux_clinical_import_document_source_755
    UNIQUE (tenant_id, source_identity_sha256),
  CONSTRAINT ux_clinical_import_document_logical_source_755
    UNIQUE (tenant_id, source_system, source_document_id, document_format),
  CONSTRAINT ux_clinical_import_document_idempotency_755
    UNIQUE (tenant_id, idempotency_key_sha256),
  CONSTRAINT ux_clinical_import_document_timeline_755
    UNIQUE (tenant_id, canonical_timeline_event_id),
  CONSTRAINT ux_clinical_import_document_audit_755
    UNIQUE (tenant_id, canonical_audit_event_id),
  CONSTRAINT fk_clinical_import_document_patient_755
    FOREIGN KEY (tenant_id, patient_id, patient_uid)
    REFERENCES users(tenant_id, id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_document_actor_755
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users(tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_document_facility_755
    FOREIGN KEY (tenant_id, source_facility_id)
    REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_document_timeline_755
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_document_audit_755
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE clinical_import_resource_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_receipt_id uuid NOT NULL,
  patient_uid uuid NOT NULL,
  source_resource_type varchar(120) NOT NULL,
  source_resource_id varchar(255),
  source_resource_index integer NOT NULL,
  source_identity_sha256 char(64) NOT NULL,
  payload_sha256 char(64) NOT NULL,
  outcome varchar(30) NOT NULL,
  target_table varchar(120),
  target_id varchar(160),
  canonical_timeline_event_id uuid,
  canonical_audit_event_id uuid,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  contract_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_clinical_import_resource_index_755
    CHECK (source_resource_index >= 0),
  CONSTRAINT ck_clinical_import_resource_hashes_755
    CHECK (
      source_identity_sha256 ~ '^[0-9a-f]{64}$'
      AND payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT ck_clinical_import_resource_outcome_755
    CHECK (outcome IN ('imported', 'deduplicated', 'skipped', 'failed')),
  CONSTRAINT ck_clinical_import_resource_target_755
    CHECK (
      (outcome IN ('imported', 'deduplicated') AND target_table IS NOT NULL AND target_id IS NOT NULL)
      OR (outcome IN ('skipped', 'failed') AND target_table IS NULL AND target_id IS NULL)
    ),
  CONSTRAINT ck_clinical_import_resource_canonical_pair_755
    CHECK (
      (canonical_timeline_event_id IS NULL) = (canonical_audit_event_id IS NULL)
    ),
  CONSTRAINT ck_clinical_import_resource_medication_canonical_755
    CHECK (
      target_table <> 'e_prescriptions'
      OR outcome NOT IN ('imported', 'deduplicated')
      OR (
        canonical_timeline_event_id IS NOT NULL
        AND canonical_audit_event_id IS NOT NULL
      )
    ),
  CONSTRAINT ck_clinical_import_resource_evidence_755
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT ck_clinical_import_resource_contract_755
    CHECK (contract_version = 1),
  CONSTRAINT ux_clinical_import_resource_tenant_id_755
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_clinical_import_resource_position_755
    UNIQUE (tenant_id, document_receipt_id, source_resource_index),
  CONSTRAINT ux_clinical_import_resource_identity_755
    UNIQUE (tenant_id, document_receipt_id, source_identity_sha256),
  CONSTRAINT fk_clinical_import_resource_document_755
    FOREIGN KEY (tenant_id, document_receipt_id, patient_uid)
    REFERENCES clinical_import_document_receipts(tenant_id, id, patient_uid) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_resource_patient_755
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users(tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_resource_timeline_755
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_resource_audit_755
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_clinical_import_document_patient_755
  ON clinical_import_document_receipts (tenant_id, patient_uid, created_at DESC);
CREATE INDEX idx_clinical_import_document_source_document_755
  ON clinical_import_document_receipts (tenant_id, source_system, source_document_id);
CREATE INDEX idx_clinical_import_resource_target_755
  ON clinical_import_resource_receipts (tenant_id, target_table, target_id)
  WHERE target_table IS NOT NULL;

CREATE OR REPLACE FUNCTION clinical_import_receipt_append_only_755()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; corrections require a new source document', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER clinical_import_document_receipt_append_only_755
BEFORE UPDATE OR DELETE ON clinical_import_document_receipts
FOR EACH ROW EXECUTE FUNCTION clinical_import_receipt_append_only_755();

CREATE TRIGGER clinical_import_resource_receipt_append_only_755
BEFORE UPDATE OR DELETE ON clinical_import_resource_receipts
FOR EACH ROW EXECUTE FUNCTION clinical_import_receipt_append_only_755();

CREATE OR REPLACE FUNCTION clinical_import_document_authority_guard_755()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM users AS patient
      JOIN users AS actor
        ON actor.tenant_id = patient.tenant_id
       AND actor.uid = NEW.actor_uid
       AND actor.role = 'MEDICAL_RECORDS'
       AND actor.is_active = TRUE
       AND actor.status = 'active'
       AND actor.is_deleted = FALSE
       AND actor.merged_into_uid IS NULL
      JOIN facilities AS facility
        ON facility.tenant_id = patient.tenant_id
       AND facility.id = NEW.source_facility_id
       AND facility.status = 'active'
     WHERE patient.tenant_id = NEW.tenant_id
       AND patient.id = NEW.patient_id
       AND patient.uid = NEW.patient_uid
       AND patient.role = 'PATIENT'
       AND patient.is_active = TRUE
       AND patient.status = 'active'
       AND patient.is_deleted = FALSE
       AND patient.merged_into_uid IS NULL
  ) THEN
    RAISE EXCEPTION 'clinical import patient, actor, or facility authority is unavailable'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM clinical_timeline_events AS timeline
      JOIN clinical_audit_events AS audit
        ON audit.tenant_id = timeline.tenant_id
       AND audit.id = NEW.canonical_audit_event_id
       AND audit.patient_uid = NEW.patient_uid
       AND audit.actor_uid = NEW.actor_uid
       AND audit.action = 'clinical_document.imported'
       AND audit.resource_table = 'clinical_import_document_receipts'
       AND audit.resource_id = NEW.id::text
     WHERE timeline.tenant_id = NEW.tenant_id
       AND timeline.id = NEW.canonical_timeline_event_id
       AND timeline.patient_uid = NEW.patient_uid
       AND timeline.actor_uid = NEW.actor_uid
       AND timeline.event_type = 'clinical_document.imported'
       AND timeline.source_table = 'clinical_import_document_receipts'
       AND timeline.source_id = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'clinical import receipt canonical evidence is missing or mismatched'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_import_document_authority_guard_755
BEFORE INSERT ON clinical_import_document_receipts
FOR EACH ROW EXECUTE FUNCTION clinical_import_document_authority_guard_755();

CREATE OR REPLACE FUNCTION clinical_import_resource_authority_guard_755()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  document_row clinical_import_document_receipts%ROWTYPE;
  manifest_entry jsonb;
  target_exists boolean := FALSE;
BEGIN
  SELECT document.*
    INTO document_row
    FROM clinical_import_document_receipts AS document
   WHERE document.tenant_id = NEW.tenant_id
     AND document.id = NEW.document_receipt_id
     AND document.patient_uid = NEW.patient_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinical import resource has no matching document receipt'
      USING ERRCODE = '23503';
  END IF;

  manifest_entry := document_row.resource_manifest -> NEW.source_resource_index;
  IF manifest_entry IS NULL
     OR manifest_entry ->> 'source_resource_type' IS DISTINCT FROM NEW.source_resource_type
     OR manifest_entry ->> 'source_resource_id' IS DISTINCT FROM NEW.source_resource_id
     OR (manifest_entry ->> 'source_resource_index')::integer IS DISTINCT FROM NEW.source_resource_index
     OR manifest_entry ->> 'source_identity_sha256' IS DISTINCT FROM NEW.source_identity_sha256
     OR manifest_entry ->> 'payload_sha256' IS DISTINCT FROM NEW.payload_sha256
     OR NEW.contract_version <> document_row.contract_version THEN
    RAISE EXCEPTION 'clinical import resource receipt does not match its immutable manifest'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.outcome IN ('imported', 'deduplicated') THEN
    CASE NEW.target_table
      WHEN 'users' THEN
        SELECT EXISTS (
          SELECT 1 FROM users
           WHERE tenant_id = NEW.tenant_id
             AND id = NEW.target_id::integer
             AND uid = NEW.patient_uid
             AND role = 'PATIENT'
        ) INTO target_exists;
      WHEN 'e_prescriptions' THEN
        SELECT EXISTS (
          SELECT 1
            FROM e_prescriptions AS prescription
            CROSS JOIN LATERAL (
              SELECT prescription.medications -> 0 -> 'import_receipt' AS receipt
            ) AS imported
           WHERE prescription.tenant_id = NEW.tenant_id
             AND prescription.id = NEW.target_id::integer
             AND prescription.patient_uid = NEW.patient_uid
             AND prescription.patient_id = document_row.patient_id
             AND prescription.lifecycle_status = 'imported_history'
             AND CASE
               WHEN jsonb_typeof(prescription.medications) = 'array'
                 THEN jsonb_array_length(prescription.medications)
               ELSE -1
             END = 1
             AND jsonb_typeof(imported.receipt) = 'object'
             AND imported.receipt ->> 'contract_version' = 'clinical-import-resource-v1'
             AND imported.receipt ->> 'source_system' = document_row.source_system
             AND imported.receipt ->> 'source_document_id' = document_row.source_document_id
             AND imported.receipt ->> 'source_facility_id' = document_row.source_facility_id::text
             AND imported.receipt ->> 'asserted_source_signature_sha256'
                   = document_row.asserted_source_signature_sha256
             AND imported.receipt ->> 'source_payload_sha256'
                   = document_row.source_payload_sha256
             AND imported.receipt ->> 'source_resource_type' = NEW.source_resource_type
             AND imported.receipt ->> 'source_resource_id'
                   IS NOT DISTINCT FROM NEW.source_resource_id
             AND imported.receipt ->> 'source_identity_sha256'
                   = NEW.source_identity_sha256
             AND imported.receipt ->> 'payload_sha256' = NEW.payload_sha256
             AND imported.receipt ->> 'document_source_identity_sha256'
                   = document_row.source_identity_sha256
             AND imported.receipt ->> 'resource_manifest_sha256'
                   = document_row.resource_manifest_sha256
             AND imported.receipt ->> 'idempotency_key_sha256'
                   = document_row.idempotency_key_sha256
             AND imported.receipt ->> 'imported_by_uid' = document_row.actor_uid::text
             AND imported.receipt ->> 'actor_role' = document_row.actor_role
             AND imported.receipt ->> 'ingestion_mode' = document_row.ingestion_mode
        ) INTO target_exists;
      WHEN 'vitals_chart' THEN
        SELECT EXISTS (
          SELECT 1 FROM vitals_chart
           WHERE tenant_id = NEW.tenant_id
             AND id = NEW.target_id::integer
             AND patient_uid = NEW.patient_uid
             AND source = 'fhir'
        ) INTO target_exists;
      WHEN 'diagnoses' THEN
        SELECT EXISTS (
          SELECT 1 FROM diagnoses
           WHERE tenant_id = NEW.tenant_id
             AND id = NEW.target_id::integer
             AND patient_uid = NEW.patient_uid
        ) INTO target_exists;
      WHEN 'allergies' THEN
        SELECT EXISTS (
          SELECT 1 FROM allergies
           WHERE tenant_id = NEW.tenant_id
             AND id = NEW.target_id::integer
             AND patient_uid = NEW.patient_uid
        ) INTO target_exists;
      ELSE
        target_exists := FALSE;
    END CASE;
    IF NOT target_exists THEN
      RAISE EXCEPTION 'clinical import resource target is missing or outside the patient authority'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.target_table = 'e_prescriptions'
     AND NEW.outcome IN ('imported', 'deduplicated')
     AND (
       NEW.canonical_timeline_event_id IS NULL
       OR NEW.canonical_audit_event_id IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM clinical_timeline_events AS timeline
           JOIN clinical_audit_events AS audit
             ON audit.tenant_id = timeline.tenant_id
            AND audit.id = NEW.canonical_audit_event_id
            AND audit.patient_uid = document_row.patient_uid
            AND audit.actor_uid = document_row.actor_uid
            AND audit.actor_role = document_row.actor_role
            AND audit.action = 'medication.history_imported'
            AND audit.action_status = 'success'
            AND audit.resource_type = 'medication_history'
            AND audit.resource_table = 'e_prescriptions'
            AND audit.resource_id = NEW.target_id
          WHERE timeline.tenant_id = document_row.tenant_id
            AND timeline.id = NEW.canonical_timeline_event_id
            AND timeline.patient_uid = document_row.patient_uid
            AND timeline.actor_uid = document_row.actor_uid
            AND timeline.actor_role = document_row.actor_role
            AND timeline.event_type = 'medication.history_imported'
            AND timeline.source_table = 'e_prescriptions'
            AND timeline.source_id = NEW.target_id
            AND timeline.resource_type = 'medication_history'
            AND timeline.resource_id = NEW.target_id
       )
     ) THEN
    RAISE EXCEPTION 'clinical import medication resource requires canonical evidence bound to its document authority'
      USING ERRCODE = '23514';
  ELSIF NEW.canonical_timeline_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM clinical_timeline_events AS timeline
      JOIN clinical_audit_events AS audit
        ON audit.tenant_id = timeline.tenant_id
       AND audit.id = NEW.canonical_audit_event_id
       AND audit.patient_uid = NEW.patient_uid
       AND audit.resource_table = NEW.target_table
       AND audit.resource_id = NEW.target_id
     WHERE timeline.tenant_id = NEW.tenant_id
       AND timeline.id = NEW.canonical_timeline_event_id
       AND timeline.patient_uid = NEW.patient_uid
       AND timeline.source_table = NEW.target_table
       AND timeline.source_id = NEW.target_id
  ) THEN
    RAISE EXCEPTION 'clinical import resource canonical evidence is mismatched'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_import_resource_authority_guard_755
BEFORE INSERT ON clinical_import_resource_receipts
FOR EACH ROW EXECUTE FUNCTION clinical_import_resource_authority_guard_755();

CREATE OR REPLACE FUNCTION clinical_import_document_completeness_guard_755()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  manifest_count integer;
  child_count bigint;
  imported_count bigint;
  deduplicated_count bigint;
  skipped_count bigint;
  failed_count bigint;
BEGIN
  manifest_count := jsonb_array_length(NEW.resource_manifest);

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.resource_manifest)
           WITH ORDINALITY AS manifest(entry, ordinal)
     WHERE CASE
             WHEN COALESCE(manifest.entry ->> 'source_resource_index', '')
                    ~ '^(0|[1-9][0-9]*)$'
               THEN (manifest.entry ->> 'source_resource_index')::bigint
             ELSE -1
           END <> manifest.ordinal - 1
  ) THEN
    RAISE EXCEPTION 'clinical import manifest positions must be contiguous and zero-based'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE outcome = 'imported'),
         COUNT(*) FILTER (WHERE outcome = 'deduplicated'),
         COUNT(*) FILTER (WHERE outcome = 'skipped'),
         COUNT(*) FILTER (WHERE outcome = 'failed')
    INTO child_count,
         imported_count,
         deduplicated_count,
         skipped_count,
         failed_count
    FROM clinical_import_resource_receipts
   WHERE tenant_id = NEW.tenant_id
     AND document_receipt_id = NEW.id;

  IF child_count <> manifest_count
     OR EXISTS (
       SELECT 1
         FROM generate_series(0, manifest_count - 1) AS expected(position)
        WHERE NOT EXISTS (
          SELECT 1
            FROM clinical_import_resource_receipts AS resource
           WHERE resource.tenant_id = NEW.tenant_id
             AND resource.document_receipt_id = NEW.id
             AND resource.source_resource_index = expected.position
        )
     ) THEN
    RAISE EXCEPTION 'clinical import document requires exactly one resource receipt per manifest position'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(NEW.result -> 'imported') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW.result -> 'deduplicated') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW.result -> 'skipped') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW.result -> 'failed') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW.result -> 'errors') IS DISTINCT FROM 'array'
     OR COALESCE(NEW.result ->> 'imported', '') !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(NEW.result ->> 'deduplicated', '') !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(NEW.result ->> 'skipped', '') !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(NEW.result ->> 'failed', '') !~ '^(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'clinical import result counts are missing or invalid'
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.result ->> 'imported')::bigint <> imported_count
     OR (NEW.result ->> 'deduplicated')::bigint <> deduplicated_count
     OR (NEW.result ->> 'skipped')::bigint <> skipped_count
     OR (NEW.result ->> 'failed')::bigint <> failed_count
     OR jsonb_array_length(NEW.result -> 'errors') <> failed_count
     OR NEW.status IS DISTINCT FROM (
       CASE
         WHEN failed_count > 0 THEN 'completed_with_errors'
         ELSE 'completed'
       END
     ) THEN
    RAISE EXCEPTION 'clinical import result counts or status do not match resource outcomes'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER clinical_import_document_completeness_guard_755
AFTER INSERT ON clinical_import_document_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION clinical_import_document_completeness_guard_755();

CREATE OR REPLACE FUNCTION clinical_import_patient_merge_lock_held_755(
  target_tenant_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH merge_key AS (
    SELECT hashtextextended(
      'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
      0
    ) AS lock_key
  )
  SELECT EXISTS (
    SELECT 1
      FROM pg_locks AS held_lock
      CROSS JOIN merge_key
     WHERE held_lock.locktype = 'advisory'
       AND held_lock.pid = pg_backend_pid()
       AND held_lock.classid::bigint =
           ((merge_key.lock_key >> 32) & 4294967295)::bigint
       AND held_lock.objid::bigint =
           (merge_key.lock_key & 4294967295)::bigint
       AND held_lock.objsubid = 1
       AND held_lock.granted
       AND held_lock.mode = 'ExclusiveLock'
  );
$$;

CREATE OR REPLACE FUNCTION clinical_import_history_immutable_755()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.lifecycle_status = 'imported_history' THEN
    IF TG_OP = 'UPDATE'
       AND current_setting('app.patient_merge_execution', true) = 'on'
       AND current_setting('app.patient_merge_tenant_id', true) = NEW.tenant_id::text
       AND public.clinical_import_patient_merge_lock_held_755(NEW.tenant_id)
       AND (to_jsonb(NEW) - 'patient_id' - 'patient_uid')
             IS NOT DISTINCT FROM (to_jsonb(OLD) - 'patient_id' - 'patient_uid')
       AND (NEW.patient_id IS DISTINCT FROM OLD.patient_id
            OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid)
       AND EXISTS (
         SELECT 1
           FROM patient_merge_requests AS request
           JOIN users AS secondary
             ON secondary.tenant_id = request.tenant_id
            AND secondary.uid = request.secondary_uid
           JOIN users AS primary_patient
             ON primary_patient.tenant_id = request.tenant_id
            AND primary_patient.uid = request.primary_uid
          WHERE request.id::text = current_setting('app.patient_merge_request_id', true)
            AND request.tenant_id = NEW.tenant_id
            AND request.status = 'approved'
            AND request.continuity_disposition IS NULL
            AND request.secondary_uid::text
                  = current_setting('app.patient_merge_from_uid', true)
            AND request.primary_uid::text
                  = current_setting('app.patient_merge_to_uid', true)
            AND OLD.patient_id IN (secondary.id, primary_patient.id)
            AND NEW.patient_id = primary_patient.id
            AND OLD.patient_uid IN (secondary.uid, primary_patient.uid)
            AND NEW.patient_uid IN (secondary.uid, primary_patient.uid)
            AND NOT (
              OLD.patient_uid = primary_patient.uid
              AND NEW.patient_uid = secondary.uid
            )
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'imported medication history is immutable; import a corrected source document'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.lifecycle_status = 'imported_history' THEN
    RAISE EXCEPTION 'an existing prescription cannot be converted into imported history'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_import_history_update_immutable_755
BEFORE UPDATE ON e_prescriptions
FOR EACH ROW
WHEN (OLD.lifecycle_status = 'imported_history' OR NEW.lifecycle_status = 'imported_history')
EXECUTE FUNCTION clinical_import_history_immutable_755();

CREATE TRIGGER clinical_import_history_delete_immutable_755
BEFORE DELETE ON e_prescriptions
FOR EACH ROW
WHEN (OLD.lifecycle_status = 'imported_history')
EXECUTE FUNCTION clinical_import_history_immutable_755();

CREATE OR REPLACE FUNCTION clinical_import_history_receipt_guard_755()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  import_receipt jsonb;
  current_history e_prescriptions%ROWTYPE;
BEGIN
  SELECT prescription.*
    INTO current_history
    FROM e_prescriptions AS prescription
   WHERE prescription.id = NEW.id
     AND prescription.tenant_id = NEW.tenant_id;
  IF NOT FOUND OR current_history.lifecycle_status <> 'imported_history' THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(current_history.medications) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'imported medication history requires exactly one medication entry with receipt evidence'
      USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(current_history.medications) <> 1
     OR jsonb_typeof(current_history.medications -> 0 -> 'import_receipt') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'imported medication history requires exactly one medication entry with receipt evidence'
      USING ERRCODE = '23514';
  END IF;
  IF current_history.patient_id IS NULL
     OR current_history.patient_uid IS NULL
     OR current_history.pharmacy_order_id IS NOT NULL
     OR current_history.pharmacy_opted IS DISTINCT FROM FALSE
     OR current_history.appointment_id IS NOT NULL
     OR current_history.admission_id IS NOT NULL
     OR current_history.signed_at IS NOT NULL
     OR current_history.signed_by IS NOT NULL
     OR current_history.locked_at IS NOT NULL
     OR current_history.locked_by IS NOT NULL THEN
    RAISE EXCEPTION 'imported medication history cannot carry local ordering authority and requires receipt evidence'
      USING ERRCODE = '23514';
  END IF;
  import_receipt := current_history.medications -> 0 -> 'import_receipt';
  IF COALESCE(import_receipt ->> 'source_identity_sha256', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(import_receipt ->> 'payload_sha256', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(import_receipt ->> 'document_source_identity_sha256', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(import_receipt ->> 'resource_manifest_sha256', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(import_receipt ->> 'idempotency_key_sha256', '') !~ '^[0-9a-f]{64}$'
     OR import_receipt ? 'idempotency_key' THEN
    RAISE EXCEPTION 'imported medication history receipt hashes are incomplete or expose a raw idempotency key'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM clinical_import_resource_receipts AS resource
      JOIN clinical_import_document_receipts AS document
        ON document.tenant_id = resource.tenant_id
       AND document.id = resource.document_receipt_id
       AND document.patient_uid = resource.patient_uid
     WHERE resource.tenant_id = current_history.tenant_id
       AND resource.outcome IN ('imported', 'deduplicated')
       AND resource.target_table = 'e_prescriptions'
       AND resource.target_id = current_history.id::text
       AND resource.source_identity_sha256 = import_receipt ->> 'source_identity_sha256'
       AND resource.payload_sha256 = import_receipt ->> 'payload_sha256'
       AND EXISTS (
         SELECT 1
           FROM users AS source_patient
          WHERE source_patient.tenant_id = document.tenant_id
            AND source_patient.id = document.patient_id
            AND source_patient.uid = document.patient_uid
            AND (
              source_patient.uid = current_history.patient_uid
              OR source_patient.merged_into_uid = current_history.patient_uid
            )
       )
       AND document.source_identity_sha256 = import_receipt ->> 'document_source_identity_sha256'
       AND document.resource_manifest_sha256 = import_receipt ->> 'resource_manifest_sha256'
       AND document.idempotency_key_sha256 = import_receipt ->> 'idempotency_key_sha256'
  ) THEN
    RAISE EXCEPTION 'imported medication history has no matching immutable document and resource receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER clinical_import_history_receipt_guard_755
AFTER INSERT OR UPDATE ON e_prescriptions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION clinical_import_history_receipt_guard_755();

REVOKE EXECUTE ON FUNCTION public.clinical_import_receipt_append_only_755() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_document_authority_guard_755() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_resource_authority_guard_755() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_document_completeness_guard_755() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_patient_merge_lock_held_755(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_history_immutable_755() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_history_receipt_guard_755() FROM PUBLIC;

ALTER TABLE clinical_import_document_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_import_document_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE clinical_import_resource_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_import_resource_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_import_document_runtime_access_755
ON clinical_import_document_receipts
AS PERMISSIVE
USING (
  tenant_id::text = current_setting('app.current_tenant_id', true)
)
WITH CHECK (
  tenant_id::text = current_setting('app.current_tenant_id', true)
);

CREATE POLICY tenant_isolation
ON clinical_import_document_receipts
AS RESTRICTIVE
USING (
  current_setting('app.current_tenant_id', true) IS NOT NULL
  AND current_setting('app.current_tenant_id', true) <> ''
  AND current_setting('app.current_tenant_id', true) <> 'bypass'
  AND tenant_id::text = current_setting('app.current_tenant_id', true)
)
WITH CHECK (
  current_setting('app.current_tenant_id', true) IS NOT NULL
  AND current_setting('app.current_tenant_id', true) <> ''
  AND current_setting('app.current_tenant_id', true) <> 'bypass'
  AND tenant_id::text = current_setting('app.current_tenant_id', true)
);

CREATE POLICY clinical_import_resource_runtime_access_755
ON clinical_import_resource_receipts
AS PERMISSIVE
USING (
  tenant_id::text = current_setting('app.current_tenant_id', true)
)
WITH CHECK (
  tenant_id::text = current_setting('app.current_tenant_id', true)
);

CREATE POLICY tenant_isolation
ON clinical_import_resource_receipts
AS RESTRICTIVE
USING (
  current_setting('app.current_tenant_id', true) IS NOT NULL
  AND current_setting('app.current_tenant_id', true) <> ''
  AND current_setting('app.current_tenant_id', true) <> 'bypass'
  AND tenant_id::text = current_setting('app.current_tenant_id', true)
)
WITH CHECK (
  current_setting('app.current_tenant_id', true) IS NOT NULL
  AND current_setting('app.current_tenant_id', true) <> ''
  AND current_setting('app.current_tenant_id', true) <> 'bypass'
  AND tenant_id::text = current_setting('app.current_tenant_id', true)
);

DO $clinical_import_receipt_runtime_acl_755$
DECLARE
  runtime_role text;
  guarded_function text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::text[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN CONTINUE; END IF;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_document_receipts FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_resource_receipts FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.clinical_import_document_receipts TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT ON TABLE public.clinical_import_resource_receipts TO %I',
      runtime_role
    );
    FOREACH guarded_function IN ARRAY ARRAY[
      'clinical_import_receipt_append_only_755()',
      'clinical_import_document_authority_guard_755()',
      'clinical_import_resource_authority_guard_755()',
      'clinical_import_document_completeness_guard_755()',
      'clinical_import_patient_merge_lock_held_755(uuid)',
      'clinical_import_history_immutable_755()',
      'clinical_import_history_receipt_guard_755()'
    ]::text[]
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.%s FROM %I',
        guarded_function,
        runtime_role
      );
    END LOOP;
  END LOOP;
END;
$clinical_import_receipt_runtime_acl_755$;

COMMENT ON TABLE clinical_import_document_receipts IS
  'Immutable authority and replay receipt for one governed manual FHIR or C-CDA document import.';
COMMENT ON TABLE clinical_import_resource_receipts IS
  'Immutable per-resource outcome evidence bound to a clinical import document manifest.';

COMMIT;
