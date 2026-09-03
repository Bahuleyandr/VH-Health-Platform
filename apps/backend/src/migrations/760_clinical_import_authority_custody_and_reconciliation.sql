BEGIN;

-- SUPERSEDED is a reserved terminal evidence shape, not runtime authority.
-- The application exposes no supersession command until the named
-- CLINICAL_IMPORT_SUPERSESSION_OWNER gate and its evidence contract exist.
-- Raw-artifact decrypt, retrieval, and key rewrap remain unavailable until the
-- CLINICAL_IMPORT_CUSTODY_KEY_MANAGEMENT_LEGAL_OWNER gate, append-only rotation
-- evidence contract, and operator ceremony are approved. Immutability is not a
-- substitute for that authority and must not be weakened to create one.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE public.clinical_import_authority_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  grant_id uuid NOT NULL,
  event_type varchar(20) NOT NULL,
  patient_uid uuid NOT NULL,
  facility_id integer NOT NULL,
  actor_uid uuid NOT NULL,
  actor_role varchar(80) NOT NULL,
  source_system varchar(255) NOT NULL,
  document_formats text[] NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  owner_evidence_ref varchar(1000) NOT NULL,
  owner_evidence_sha256 char(64) NOT NULL,
  recorded_by uuid NOT NULL,
  reason varchar(1000) NOT NULL,
  idempotency_key_sha256 char(64) NOT NULL,
  contract_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_clinical_import_authority_event_type_760
    CHECK (event_type IN ('GRANTED', 'REVOKED')),
  CONSTRAINT ck_clinical_import_authority_actor_role_760
    CHECK (actor_role = 'MEDICAL_RECORDS'),
  CONSTRAINT ck_clinical_import_authority_formats_760
    CHECK (
      cardinality(document_formats) > 0
      AND document_formats <@ ARRAY['fhir_bundle', 'ccda']::text[]
      AND array_position(document_formats, NULL) IS NULL
    ),
  CONSTRAINT ck_clinical_import_authority_validity_760
    CHECK (valid_until > valid_from),
  CONSTRAINT ck_clinical_import_authority_evidence_760
    CHECK (
      length(btrim(owner_evidence_ref)) BETWEEN 1 AND 1000
      AND owner_evidence_sha256 ~ '^[0-9a-f]{64}$'
      AND idempotency_key_sha256 ~ '^[0-9a-f]{64}$'
      AND length(btrim(reason)) BETWEEN 10 AND 1000
    ),
  CONSTRAINT ck_clinical_import_authority_contract_760
    CHECK (contract_version = 1),
  CONSTRAINT ux_clinical_import_authority_tenant_id_760
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_clinical_import_authority_grant_event_760
    UNIQUE (tenant_id, grant_id, event_type),
  CONSTRAINT ux_clinical_import_authority_idempotency_760
    UNIQUE (tenant_id, idempotency_key_sha256),
  CONSTRAINT fk_clinical_import_authority_patient_760
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES public.users(tenant_id, uid) ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_clinical_import_authority_facility_760
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_authority_actor_760
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES public.users(tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_authority_recorder_760
    FOREIGN KEY (tenant_id, recorded_by)
    REFERENCES public.users(tenant_id, uid) ON DELETE RESTRICT
);

CREATE INDEX idx_clinical_import_authority_active_760
  ON public.clinical_import_authority_events
    (tenant_id, grant_id, patient_uid, facility_id, actor_uid)
  WHERE event_type = 'GRANTED';

CREATE TABLE public.clinical_import_raw_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  authority_grant_id uuid NOT NULL,
  patient_uid uuid NOT NULL,
  source_facility_id integer NOT NULL,
  actor_uid uuid NOT NULL,
  actor_role varchar(80) NOT NULL,
  source_system varchar(255) NOT NULL,
  source_document_id varchar(255) NOT NULL,
  document_format varchar(30) NOT NULL,
  raw_payload_sha256 char(64) NOT NULL,
  raw_payload_bytes bigint NOT NULL,
  raw_content_type varchar(160) NOT NULL,
  raw_payload_ciphertext text NOT NULL,
  encryption_key_id varchar(255) NOT NULL,
  canonicalization_version varchar(120) NOT NULL,
  canonical_payload_sha256 char(64) NOT NULL,
  asserted_source_signature_sha256 char(64) NOT NULL,
  signature_verification_status varchar(40) NOT NULL,
  source_author_evidence jsonb NOT NULL,
  source_author_evidence_sha256 char(64)
    GENERATED ALWAYS AS (
      encode(public.digest(source_author_evidence::text, 'sha256'), 'hex')
    ) STORED,
  recorded_by uuid NOT NULL,
  contract_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_clinical_import_raw_actor_role_760
    CHECK (actor_role = 'MEDICAL_RECORDS'),
  CONSTRAINT ck_clinical_import_raw_format_760
    CHECK (document_format IN ('fhir_bundle', 'ccda')),
  CONSTRAINT ck_clinical_import_raw_hashes_760
    CHECK (
      raw_payload_sha256 ~ '^[0-9a-f]{64}$'
      AND canonical_payload_sha256 ~ '^[0-9a-f]{64}$'
      AND asserted_source_signature_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT ck_clinical_import_raw_bytes_760
    CHECK (raw_payload_bytes BETWEEN 1 AND 5242880),
  CONSTRAINT ck_clinical_import_raw_content_type_760
    CHECK (
      (document_format = 'fhir_bundle'
        AND raw_content_type IN ('application/fhir+json', 'application/json'))
      OR
      (document_format = 'ccda'
        AND raw_content_type IN (
          'application/xml', 'text/xml', 'application/hl7-v3+xml', 'application/json'
        ))
    ),
  CONSTRAINT ck_clinical_import_raw_ciphertext_760
    CHECK (
      raw_payload_ciphertext LIKE 'enc:v2:%'
      AND octet_length(raw_payload_ciphertext) > 7
      AND length(btrim(encryption_key_id)) BETWEEN 1 AND 255
      AND length(btrim(canonicalization_version)) BETWEEN 1 AND 120
    ),
  CONSTRAINT ck_clinical_import_raw_signature_status_760
    CHECK (
      signature_verification_status IN (
        'verified', 'asserted_unverified', 'not_present', 'failed'
      )
    ),
  CONSTRAINT ck_clinical_import_raw_source_author_760
    CHECK (
      jsonb_typeof(source_author_evidence) = 'object'
      AND source_author_evidence <> '{}'::jsonb
    ),
  CONSTRAINT ck_clinical_import_raw_contract_760
    CHECK (contract_version = 1),
  CONSTRAINT ux_clinical_import_raw_tenant_id_760
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_clinical_import_raw_logical_source_760
    UNIQUE (tenant_id, source_system, source_document_id, document_format),
  CONSTRAINT fk_clinical_import_raw_patient_760
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES public.users(tenant_id, uid) ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_clinical_import_raw_facility_760
    FOREIGN KEY (tenant_id, source_facility_id)
    REFERENCES public.facilities(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_raw_actor_760
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES public.users(tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_raw_recorder_760
    FOREIGN KEY (tenant_id, recorded_by)
    REFERENCES public.users(tenant_id, uid) ON DELETE RESTRICT
);

ALTER TABLE public.clinical_import_document_receipts
  ADD COLUMN authority_grant_id uuid NOT NULL,
  ADD COLUMN raw_artifact_id uuid NOT NULL,
  ADD COLUMN patient_identifier_ids integer[] NOT NULL,
  ADD COLUMN patient_identity_binding_sha256 char(64) NOT NULL,
  ADD COLUMN access_decision_evidence jsonb NOT NULL,
  ADD COLUMN access_decision_evidence_sha256 char(64)
    GENERATED ALWAYS AS (
      encode(public.digest(access_decision_evidence::text, 'sha256'), 'hex')
    ) STORED,
  ADD COLUMN source_author_evidence jsonb NOT NULL,
  ADD COLUMN source_author_evidence_sha256 char(64)
    GENERATED ALWAYS AS (
      encode(public.digest(source_author_evidence::text, 'sha256'), 'hex')
    ) STORED,
  ADD CONSTRAINT ck_clinical_import_document_provenance_hashes_760
    CHECK (patient_identity_binding_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_clinical_import_document_identifiers_760
    CHECK (
      cardinality(patient_identifier_ids) >= 0
      AND array_position(patient_identifier_ids, NULL) IS NULL
    ),
  ADD CONSTRAINT ck_clinical_import_document_provenance_json_760
    CHECK (
      jsonb_typeof(access_decision_evidence) = 'object'
      AND access_decision_evidence <> '{}'::jsonb
      AND jsonb_typeof(source_author_evidence) = 'object'
      AND source_author_evidence <> '{}'::jsonb
    ),
  ADD CONSTRAINT ux_clinical_import_document_raw_artifact_760
    UNIQUE (tenant_id, raw_artifact_id),
  ADD CONSTRAINT fk_clinical_import_document_raw_artifact_760
    FOREIGN KEY (tenant_id, raw_artifact_id)
    REFERENCES public.clinical_import_raw_artifacts(tenant_id, id)
    ON DELETE RESTRICT;

-- Patient merges update the survivor and its dependent receipt graph inside one
-- transaction, so every composite patient identity edge must be deferrable.
ALTER TABLE public.clinical_import_document_receipts
  ALTER CONSTRAINT fk_clinical_import_document_patient_755
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.clinical_import_resource_receipts
  ALTER CONSTRAINT fk_clinical_import_resource_document_755
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.clinical_import_resource_receipts
  ALTER CONSTRAINT fk_clinical_import_resource_patient_755
  DEFERRABLE INITIALLY IMMEDIATE;

-- Keep operational imported medication history movable only inside the
-- approved patient-merge transaction. The explicit negative merge guard lets
-- the runtime preflight prove that its identity-only sweep cannot trip either
-- immutable-history exception; every other mutation remains fail-closed.
CREATE OR REPLACE FUNCTION clinical_import_history_immutable_755()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.lifecycle_status = 'imported_history' THEN
    IF current_setting('app.patient_merge_execution', true) IS DISTINCT FROM 'on'
       OR current_setting('app.patient_merge_tenant_id', true) IS DISTINCT FROM NEW.tenant_id::text
       OR NULLIF(current_setting('app.patient_merge_from_uid', true), '') IS NULL
       OR NULLIF(current_setting('app.patient_merge_to_uid', true), '') IS NULL
       OR NOT public.clinical_import_patient_merge_lock_held_755(NEW.tenant_id)
       OR (to_jsonb(NEW) - 'patient_id' - 'patient_uid')
            IS DISTINCT FROM (to_jsonb(OLD) - 'patient_id' - 'patient_uid')
       OR NOT (NEW.patient_id IS DISTINCT FROM OLD.patient_id
               OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid)
       OR NOT EXISTS (
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
      RAISE EXCEPTION 'imported medication history is immutable; import a corrected source document'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.lifecycle_status = 'imported_history' THEN
    IF current_setting('app.patient_merge_execution', true) IS DISTINCT FROM 'on'
       OR current_setting('app.patient_merge_tenant_id', true) IS DISTINCT FROM NEW.tenant_id::text
       OR NULLIF(current_setting('app.patient_merge_from_uid', true), '') IS NULL
       OR NULLIF(current_setting('app.patient_merge_to_uid', true), '') IS NULL
       OR NOT public.clinical_import_patient_merge_lock_held_755(NEW.tenant_id)
       OR OLD.lifecycle_status IS DISTINCT FROM NEW.lifecycle_status THEN
      RAISE EXCEPTION 'an existing prescription cannot be converted into imported history'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public.clinical_import_reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  resource_receipt_id uuid NOT NULL,
  document_receipt_id uuid NOT NULL,
  patient_uid uuid NOT NULL,
  facility_id integer NOT NULL,
  owner_actor_uid uuid NOT NULL,
  owner_actor_role varchar(80) NOT NULL,
  reason varchar(1000) NOT NULL,
  idempotency_key_sha256 char(64) NOT NULL,
  contract_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_clinical_import_reconciliation_owner_role_760
    CHECK (owner_actor_role = 'MEDICAL_RECORDS'),
  CONSTRAINT ck_clinical_import_reconciliation_item_reason_760
    CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  CONSTRAINT ck_clinical_import_reconciliation_item_hash_760
    CHECK (idempotency_key_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_clinical_import_reconciliation_item_contract_760
    CHECK (contract_version = 1),
  CONSTRAINT ux_clinical_import_reconciliation_item_tenant_id_760
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_clinical_import_reconciliation_item_resource_binding_760
    UNIQUE (tenant_id, id, resource_receipt_id),
  CONSTRAINT ux_clinical_import_reconciliation_item_receipt_760
    UNIQUE (tenant_id, resource_receipt_id),
  CONSTRAINT ux_clinical_import_reconciliation_item_idempotency_760
    UNIQUE (tenant_id, idempotency_key_sha256),
  CONSTRAINT ux_clinical_import_reconciliation_item_binding_760
    UNIQUE (
      tenant_id, id, resource_receipt_id, document_receipt_id,
      patient_uid, facility_id
    ),
  CONSTRAINT fk_clinical_import_reconciliation_item_resource_760
    FOREIGN KEY (tenant_id, resource_receipt_id)
    REFERENCES public.clinical_import_resource_receipts(tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_reconciliation_item_document_760
    FOREIGN KEY (tenant_id, document_receipt_id, patient_uid)
    REFERENCES public.clinical_import_document_receipts(tenant_id, id, patient_uid)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_clinical_import_reconciliation_item_facility_760
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_reconciliation_item_owner_760
    FOREIGN KEY (tenant_id, owner_actor_uid)
    REFERENCES public.users(tenant_id, uid) ON DELETE RESTRICT
);

CREATE INDEX idx_clinical_import_reconciliation_owner_760
  ON public.clinical_import_reconciliation_items
    (tenant_id, owner_actor_uid, created_at, id);

CREATE INDEX idx_clinical_import_reconciliation_worklist_760
  ON public.clinical_import_reconciliation_items
    (tenant_id, created_at, id);

CREATE TABLE public.clinical_import_reconciliation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  reconciliation_item_id uuid NOT NULL,
  resource_receipt_id uuid NOT NULL,
  document_receipt_id uuid NOT NULL,
  patient_uid uuid NOT NULL,
  facility_id integer NOT NULL,
  event_type varchar(30) NOT NULL,
  actor_uid uuid NOT NULL,
  actor_role varchar(80) NOT NULL,
  reason varchar(1000) NOT NULL,
  predecessor_event_id uuid,
  replacement_resource_receipt_id uuid,
  idempotency_key_sha256 char(64) NOT NULL,
  evidence jsonb NOT NULL,
  evidence_sha256 char(64)
    GENERATED ALWAYS AS (
      encode(public.digest(evidence::text, 'sha256'), 'hex')
    ) STORED,
  contract_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_clinical_import_reconciliation_event_type_760
    CHECK (
      event_type IN ('OPENED', 'RETRY_REQUESTED', 'RESOLVED')
    ),
  CONSTRAINT ck_clinical_import_reconciliation_event_actor_role_760
    CHECK (actor_role = 'MEDICAL_RECORDS'),
  CONSTRAINT ck_clinical_import_reconciliation_event_reason_760
    CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  CONSTRAINT ck_clinical_import_reconciliation_event_hash_760
    CHECK (idempotency_key_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_clinical_import_reconciliation_event_evidence_760
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT ck_clinical_import_reconciliation_event_predecessor_760
    CHECK (
      (event_type = 'OPENED' AND predecessor_event_id IS NULL)
      OR (event_type <> 'OPENED' AND predecessor_event_id IS NOT NULL)
    ),
  CONSTRAINT ck_clinical_import_reconciliation_event_replacement_760
    CHECK (
      (event_type = 'RESOLVED' AND replacement_resource_receipt_id IS NOT NULL)
      OR (event_type <> 'RESOLVED' AND replacement_resource_receipt_id IS NULL)
    ),
  CONSTRAINT ck_clinical_import_reconciliation_event_contract_760
    CHECK (contract_version = 1),
  CONSTRAINT ux_clinical_import_reconciliation_event_tenant_id_760
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_clinical_import_reconciliation_event_stream_id_760
    UNIQUE (tenant_id, reconciliation_item_id, id),
  CONSTRAINT ux_clinical_import_reconciliation_event_idempotency_760
    UNIQUE (tenant_id, idempotency_key_sha256),
  CONSTRAINT fk_clinical_import_reconciliation_event_item_760
    FOREIGN KEY (
      tenant_id, reconciliation_item_id, resource_receipt_id,
      document_receipt_id, patient_uid, facility_id
    ) REFERENCES public.clinical_import_reconciliation_items(
      tenant_id, id, resource_receipt_id,
      document_receipt_id, patient_uid, facility_id
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fk_clinical_import_reconciliation_event_actor_760
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES public.users(tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_reconciliation_event_predecessor_760
    FOREIGN KEY (tenant_id, reconciliation_item_id, predecessor_event_id)
    REFERENCES public.clinical_import_reconciliation_events(
      tenant_id, reconciliation_item_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_clinical_import_reconciliation_event_replacement_760
    FOREIGN KEY (tenant_id, replacement_resource_receipt_id)
    REFERENCES public.clinical_import_resource_receipts(tenant_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_clinical_import_reconciliation_event_stream_760
  ON public.clinical_import_reconciliation_events
    (tenant_id, reconciliation_item_id, created_at, id);

CREATE UNIQUE INDEX ux_clinical_import_reconciliation_replacement_760
  ON public.clinical_import_reconciliation_events
    (tenant_id, replacement_resource_receipt_id)
  WHERE event_type = 'RESOLVED';

CREATE UNIQUE INDEX ux_clinical_import_reconciliation_resolved_item_760
  ON public.clinical_import_reconciliation_events
    (tenant_id, reconciliation_item_id)
  WHERE event_type = 'RESOLVED';

ALTER TABLE public.clinical_import_resource_receipts
  ADD COLUMN correction_reconciliation_item_id uuid,
  ADD COLUMN correction_original_resource_receipt_id uuid,
  ADD COLUMN correction_retry_event_id uuid,
  ADD CONSTRAINT ck_clinical_import_resource_correction_binding_760
    CHECK (
      num_nonnulls(
        correction_reconciliation_item_id,
        correction_original_resource_receipt_id,
        correction_retry_event_id
      ) IN (0, 3)
      AND (
        correction_original_resource_receipt_id IS NULL
        OR correction_original_resource_receipt_id <> id
      )
    ),
  ADD CONSTRAINT fk_clinical_import_resource_correction_item_760
    FOREIGN KEY (
      tenant_id,
      correction_reconciliation_item_id,
      correction_original_resource_receipt_id
    ) REFERENCES public.clinical_import_reconciliation_items(
      tenant_id,
      id,
      resource_receipt_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_clinical_import_resource_correction_retry_760
    FOREIGN KEY (
      tenant_id,
      correction_reconciliation_item_id,
      correction_retry_event_id
    ) REFERENCES public.clinical_import_reconciliation_events(
      tenant_id,
      reconciliation_item_id,
      id
    ) ON DELETE RESTRICT;

CREATE UNIQUE INDEX ux_clinical_import_resource_correction_item_760
  ON public.clinical_import_resource_receipts
    (tenant_id, correction_reconciliation_item_id)
  WHERE correction_reconciliation_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.clinical_import_append_only_guard_760()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_import_authority_event_guard_760()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  granted public.clinical_import_authority_events%ROWTYPE;
  canonical_formats text[];
BEGIN
  SELECT array_agg(value ORDER BY value)
    INTO canonical_formats
    FROM (SELECT DISTINCT unnest(NEW.document_formats) AS value) AS formats;
  IF NEW.document_formats IS DISTINCT FROM canonical_formats THEN
    RAISE EXCEPTION 'clinical import authority document formats must be sorted and distinct'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.users AS recorder
     WHERE recorder.tenant_id = NEW.tenant_id
       AND recorder.uid = NEW.recorded_by
       AND recorder.is_active = TRUE
       AND recorder.status = 'active'
       AND recorder.is_deleted = FALSE
       AND recorder.merged_into_uid IS NULL
  ) THEN
    RAISE EXCEPTION 'clinical import authority recorder is unavailable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.event_type = 'GRANTED' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.users AS patient
        JOIN public.users AS actor
          ON actor.tenant_id = patient.tenant_id
         AND actor.uid = NEW.actor_uid
         AND actor.role = 'MEDICAL_RECORDS'
         AND actor.is_active = TRUE
         AND actor.status = 'active'
         AND actor.is_deleted = FALSE
         AND actor.merged_into_uid IS NULL
        JOIN public.facilities AS facility
          ON facility.tenant_id = patient.tenant_id
         AND facility.id = NEW.facility_id
         AND facility.status = 'active'
       WHERE patient.tenant_id = NEW.tenant_id
         AND patient.uid = NEW.patient_uid
         AND patient.role = 'PATIENT'
         AND patient.is_active = TRUE
         AND patient.status = 'active'
         AND patient.is_deleted = FALSE
         AND patient.merged_into_uid IS NULL
    ) THEN
      RAISE EXCEPTION 'clinical import grant patient, actor, or facility is unavailable'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  SELECT authority.*
    INTO granted
    FROM public.clinical_import_authority_events AS authority
   WHERE authority.tenant_id = NEW.tenant_id
     AND authority.grant_id = NEW.grant_id
     AND authority.event_type = 'GRANTED'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinical import authority revocation has no matching grant'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.patient_uid IS DISTINCT FROM granted.patient_uid
     OR NEW.facility_id IS DISTINCT FROM granted.facility_id
     OR NEW.actor_uid IS DISTINCT FROM granted.actor_uid
     OR NEW.actor_role IS DISTINCT FROM granted.actor_role
     OR NEW.source_system IS DISTINCT FROM granted.source_system
     OR NEW.document_formats IS DISTINCT FROM granted.document_formats
     OR NEW.valid_from IS DISTINCT FROM granted.valid_from
     OR NEW.valid_until IS DISTINCT FROM granted.valid_until
     OR NEW.owner_evidence_ref IS DISTINCT FROM granted.owner_evidence_ref
     OR NEW.owner_evidence_sha256 IS DISTINCT FROM granted.owner_evidence_sha256
     OR NEW.contract_version IS DISTINCT FROM granted.contract_version
     OR NEW.created_at < granted.created_at THEN
    RAISE EXCEPTION 'clinical import authority revocation does not exactly bind its grant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_import_raw_artifact_guard_760()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  granted public.clinical_import_authority_events%ROWTYPE;
BEGIN
  SELECT authority.*
    INTO granted
    FROM public.clinical_import_authority_events AS authority
   WHERE authority.tenant_id = NEW.tenant_id
     AND authority.grant_id = NEW.authority_grant_id
     AND authority.event_type = 'GRANTED'
   FOR UPDATE;
  IF NOT FOUND
     OR NEW.patient_uid IS DISTINCT FROM granted.patient_uid
     OR NEW.source_facility_id IS DISTINCT FROM granted.facility_id
     OR NEW.actor_uid IS DISTINCT FROM granted.actor_uid
     OR NEW.actor_role IS DISTINCT FROM granted.actor_role
     OR NEW.source_system IS DISTINCT FROM granted.source_system
     OR NOT (NEW.document_format = ANY(granted.document_formats))
     OR clock_timestamp() < granted.created_at
     OR clock_timestamp() < granted.valid_from
     OR clock_timestamp() >= granted.valid_until
     OR EXISTS (
       SELECT 1
         FROM public.clinical_import_authority_events AS revoked
        WHERE revoked.tenant_id = NEW.tenant_id
          AND revoked.grant_id = NEW.authority_grant_id
          AND revoked.event_type = 'REVOKED'
     ) THEN
    RAISE EXCEPTION 'clinical import raw artifact lacks active exact authority'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.recorded_by IS DISTINCT FROM NEW.actor_uid THEN
    RAISE EXCEPTION 'clinical import raw artifact recorder must be its authorized actor'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.lock_clinical_import_authority_760(
  target_tenant_id uuid,
  target_grant_id uuid,
  target_patient_uid uuid,
  target_facility_id integer,
  target_actor_uid uuid,
  target_source_system text,
  target_document_format text
)
RETURNS char(64)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  granted public.clinical_import_authority_events%ROWTYPE;
  tenant_context text := current_setting('app.current_tenant_id', true);
BEGIN
  IF target_tenant_id IS NULL
     OR tenant_context IS NULL
     OR tenant_context = ''
     OR tenant_context = 'bypass'
     OR target_tenant_id::text IS DISTINCT FROM tenant_context THEN
    RAISE EXCEPTION 'clinical import authority tenant context is unavailable or mismatched'
      USING ERRCODE = '42501';
  END IF;
  SELECT authority.*
    INTO granted
    FROM public.clinical_import_authority_events AS authority
   WHERE authority.tenant_id = target_tenant_id
     AND authority.grant_id = target_grant_id
     AND authority.event_type = 'GRANTED'
   FOR UPDATE;
  IF NOT FOUND
     OR granted.patient_uid IS DISTINCT FROM target_patient_uid
     OR granted.facility_id IS DISTINCT FROM target_facility_id
     OR granted.actor_uid IS DISTINCT FROM target_actor_uid
     OR granted.actor_role IS DISTINCT FROM 'MEDICAL_RECORDS'
     OR granted.source_system IS DISTINCT FROM target_source_system
     OR NOT (target_document_format = ANY(granted.document_formats))
     OR clock_timestamp() < granted.valid_from
     OR clock_timestamp() >= granted.valid_until
     OR EXISTS (
       SELECT 1
         FROM public.clinical_import_authority_events AS revoked
        WHERE revoked.tenant_id = target_tenant_id
          AND revoked.grant_id = target_grant_id
          AND revoked.event_type = 'REVOKED'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.users AS patient
         JOIN public.users AS actor
           ON actor.tenant_id = patient.tenant_id
          AND actor.uid = target_actor_uid
          AND actor.role = 'MEDICAL_RECORDS'
          AND actor.is_active = TRUE
          AND actor.status = 'active'
          AND actor.is_deleted = FALSE
          AND actor.merged_into_uid IS NULL
         JOIN public.facilities AS facility
           ON facility.tenant_id = patient.tenant_id
          AND facility.id = target_facility_id
          AND facility.status = 'active'
        WHERE patient.tenant_id = target_tenant_id
          AND patient.uid = target_patient_uid
          AND patient.role = 'PATIENT'
          AND patient.is_active = TRUE
          AND patient.status = 'active'
          AND patient.is_deleted = FALSE
          AND patient.merged_into_uid IS NULL
     ) THEN
    RAISE EXCEPTION 'clinical import authority is unavailable or outside the exact requested scope'
      USING ERRCODE = '42501';
  END IF;
  RETURN granted.owner_evidence_sha256;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_import_document_authority_guard_755()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  granted public.clinical_import_authority_events%ROWTYPE;
  artifact public.clinical_import_raw_artifacts%ROWTYPE;
  canonical_identifier_ids integer[];
  expected_identity_binding_sha256 text;
BEGIN
  SELECT authority.*
    INTO granted
    FROM public.clinical_import_authority_events AS authority
   WHERE authority.tenant_id = NEW.tenant_id
     AND authority.grant_id = NEW.authority_grant_id
     AND authority.event_type = 'GRANTED'
   FOR UPDATE;
  IF NOT FOUND
     OR NEW.patient_uid IS DISTINCT FROM granted.patient_uid
     OR NEW.source_facility_id IS DISTINCT FROM granted.facility_id
     OR NEW.actor_uid IS DISTINCT FROM granted.actor_uid
     OR NEW.actor_role IS DISTINCT FROM granted.actor_role
     OR NEW.source_system IS DISTINCT FROM granted.source_system
     OR NOT (NEW.document_format = ANY(granted.document_formats))
     OR clock_timestamp() < granted.created_at
     OR clock_timestamp() < granted.valid_from
     OR clock_timestamp() >= granted.valid_until
     OR EXISTS (
       SELECT 1
         FROM public.clinical_import_authority_events AS revoked
        WHERE revoked.tenant_id = NEW.tenant_id
          AND revoked.grant_id = NEW.authority_grant_id
          AND revoked.event_type = 'REVOKED'
     ) THEN
    RAISE EXCEPTION 'clinical import document lacks active exact owner authority'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.users AS patient
      JOIN public.users AS actor
        ON actor.tenant_id = patient.tenant_id
       AND actor.uid = NEW.actor_uid
       AND actor.role = 'MEDICAL_RECORDS'
       AND actor.is_active = TRUE
       AND actor.status = 'active'
       AND actor.is_deleted = FALSE
       AND actor.merged_into_uid IS NULL
      JOIN public.facilities AS facility
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

  SELECT array_agg(identifier_id ORDER BY identifier_id)
    INTO canonical_identifier_ids
    FROM (SELECT DISTINCT unnest(NEW.patient_identifier_ids) AS identifier_id) AS identifiers;
  canonical_identifier_ids := COALESCE(canonical_identifier_ids, ARRAY[]::integer[]);
  IF NEW.patient_identifier_ids IS DISTINCT FROM canonical_identifier_ids
     OR (
       SELECT COUNT(*)
         FROM public.patient_identifiers AS identifier
         WHERE identifier.tenant_id = NEW.tenant_id
           AND identifier.id = ANY(NEW.patient_identifier_ids)
           AND (identifier.expires_at IS NULL OR identifier.expires_at > clock_timestamp())
           AND (
            (
              identifier.status = 'active'
              AND identifier.patient_uid = NEW.patient_uid
            )
            OR
            (
              identifier.status = 'merged_into'
              AND identifier.merged_into_uid = NEW.patient_uid
            )
          )
     ) <> cardinality(NEW.patient_identifier_ids) THEN
    RAISE EXCEPTION 'clinical import patient identifiers are not the exact active patient binding'
      USING ERRCODE = '23514';
  END IF;

  expected_identity_binding_sha256 := encode(
    public.digest(
      convert_to(
        'clinical-import-patient-identity-v1|'
        || NEW.tenant_id::text || '|'
        || NEW.patient_id::text || '|'
        || NEW.patient_uid::text || '|'
        || array_to_string(NEW.patient_identifier_ids, ','),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF NEW.patient_identity_binding_sha256 IS DISTINCT FROM expected_identity_binding_sha256 THEN
    RAISE EXCEPTION 'clinical import patient identity binding hash is mismatched'
      USING ERRCODE = '23514';
  END IF;

  SELECT raw.*
    INTO artifact
    FROM public.clinical_import_raw_artifacts AS raw
   WHERE raw.tenant_id = NEW.tenant_id
     AND raw.id = NEW.raw_artifact_id
   FOR SHARE;
  IF NOT FOUND
     OR artifact.authority_grant_id IS DISTINCT FROM NEW.authority_grant_id
     OR artifact.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR artifact.source_facility_id IS DISTINCT FROM NEW.source_facility_id
     OR artifact.actor_uid IS DISTINCT FROM NEW.actor_uid
     OR artifact.actor_role IS DISTINCT FROM NEW.actor_role
     OR artifact.source_system IS DISTINCT FROM NEW.source_system
     OR artifact.source_document_id IS DISTINCT FROM NEW.source_document_id
     OR artifact.document_format IS DISTINCT FROM NEW.document_format
     OR NEW.created_at < artifact.created_at
     OR artifact.canonical_payload_sha256 IS DISTINCT FROM NEW.source_payload_sha256
     OR artifact.asserted_source_signature_sha256
          IS DISTINCT FROM NEW.asserted_source_signature_sha256
     OR artifact.source_author_evidence IS DISTINCT FROM NEW.source_author_evidence
     OR artifact.source_author_evidence_sha256
          IS DISTINCT FROM encode(
            public.digest(NEW.source_author_evidence::text, 'sha256'),
            'hex'
          ) THEN
    RAISE EXCEPTION 'clinical import raw artifact does not exactly bind the document receipt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.access_decision_evidence ->> 'contract_version'
       IS DISTINCT FROM 'clinical-import-access-decision-v1'
     OR NEW.access_decision_evidence ->> 'decision' IS DISTINCT FROM 'allow'
     OR NEW.access_decision_evidence ->> 'authority_grant_id'
          IS DISTINCT FROM NEW.authority_grant_id::text
     OR NEW.access_decision_evidence ->> 'patient_uid'
          IS DISTINCT FROM NEW.patient_uid::text
     OR NEW.access_decision_evidence ->> 'actor_uid'
          IS DISTINCT FROM NEW.actor_uid::text
     OR NEW.access_decision_evidence ->> 'source_facility_id'
          IS DISTINCT FROM NEW.source_facility_id::text
     OR NEW.access_decision_evidence ->> 'source_system'
          IS DISTINCT FROM NEW.source_system
     OR NEW.access_decision_evidence ->> 'document_format'
          IS DISTINCT FROM NEW.document_format
     OR NEW.access_decision_evidence ->> 'patient_identity_binding_sha256'
          IS DISTINCT FROM NEW.patient_identity_binding_sha256
     OR NEW.access_decision_evidence ->> 'owner_evidence_sha256'
          IS DISTINCT FROM granted.owner_evidence_sha256 THEN
    RAISE EXCEPTION 'clinical import access decision does not exactly bind its authority and patient identity'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.clinical_timeline_events AS timeline
      JOIN public.clinical_audit_events AS audit
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

CREATE OR REPLACE FUNCTION public.clinical_import_reconciliation_item_guard_760()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'clinical import reconciliation items are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.clinical_import_resource_receipts AS resource
      JOIN public.clinical_import_document_receipts AS document
        ON document.tenant_id = resource.tenant_id
       AND document.id = resource.document_receipt_id
       AND document.patient_uid = resource.patient_uid
      JOIN public.users AS owner_actor
        ON owner_actor.tenant_id = document.tenant_id
       AND owner_actor.uid = NEW.owner_actor_uid
       AND owner_actor.role = 'MEDICAL_RECORDS'
       AND owner_actor.is_active = TRUE
       AND owner_actor.status = 'active'
       AND owner_actor.is_deleted = FALSE
       AND owner_actor.merged_into_uid IS NULL
     WHERE resource.tenant_id = NEW.tenant_id
       AND resource.id = NEW.resource_receipt_id
       AND resource.document_receipt_id = NEW.document_receipt_id
       AND resource.patient_uid = NEW.patient_uid
       AND resource.outcome = 'failed'
       AND document.source_facility_id = NEW.facility_id
       AND NEW.created_at >= resource.created_at
  ) THEN
    RAISE EXCEPTION 'clinical import reconciliation item is not bound to a failed resource and active MEDICAL_RECORDS owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_import_active_patient_survivor_760(
  target_tenant_id uuid,
  target_patient_uid uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH RECURSIVE patient_chain AS (
    SELECT patient.uid, patient.merged_into_uid, patient.role,
           patient.is_active, patient.status, patient.is_deleted,
           ARRAY[patient.uid]::uuid[] AS path,
           FALSE AS cycle,
           0 AS depth
      FROM public.users AS patient
     WHERE patient.tenant_id = target_tenant_id
       AND patient.uid = target_patient_uid
       AND patient.role = 'PATIENT'
    UNION ALL
    SELECT survivor.uid, survivor.merged_into_uid, survivor.role,
           survivor.is_active, survivor.status, survivor.is_deleted,
           chain.path || survivor.uid,
           survivor.uid = ANY(chain.path) AS cycle,
           chain.depth + 1
      FROM patient_chain AS chain
      JOIN public.users AS survivor
        ON survivor.tenant_id = target_tenant_id
       AND survivor.uid = chain.merged_into_uid
       AND survivor.role = 'PATIENT'
     WHERE chain.cycle = FALSE
       AND chain.depth < 32
  ), terminal AS (
    SELECT chain.*
      FROM patient_chain AS chain
     ORDER BY chain.depth DESC
     LIMIT 1
  )
  SELECT terminal.uid
    FROM terminal
   WHERE terminal.cycle = FALSE
     AND terminal.merged_into_uid IS NULL
     AND terminal.role = 'PATIENT'
     AND terminal.is_active = TRUE
     AND terminal.status = 'active'
     AND terminal.is_deleted = FALSE
     AND NOT EXISTS (SELECT 1 FROM patient_chain WHERE cycle = TRUE);
$$;

CREATE OR REPLACE FUNCTION public.clinical_import_resource_correction_guard_760()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF num_nonnulls(
       NEW.correction_reconciliation_item_id,
       NEW.correction_original_resource_receipt_id,
       NEW.correction_retry_event_id
     ) = 0 THEN
    RETURN NEW;
  END IF;
  IF num_nonnulls(
       NEW.correction_reconciliation_item_id,
       NEW.correction_original_resource_receipt_id,
       NEW.correction_retry_event_id
     ) <> 3 THEN
    RAISE EXCEPTION 'clinical import correction receipt has a partial causal binding'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.clinical_import_reconciliation_items AS item
      JOIN public.clinical_import_resource_receipts AS original
        ON original.tenant_id = item.tenant_id
       AND original.id = item.resource_receipt_id
       AND original.id = NEW.correction_original_resource_receipt_id
       AND original.document_receipt_id = item.document_receipt_id
       AND original.patient_uid = item.patient_uid
       AND original.outcome = 'failed'
      JOIN public.clinical_import_document_receipts AS source_document
        ON source_document.tenant_id = item.tenant_id
       AND source_document.id = item.document_receipt_id
       AND source_document.patient_uid = item.patient_uid
      JOIN public.clinical_import_reconciliation_events AS retry
        ON retry.tenant_id = item.tenant_id
       AND retry.reconciliation_item_id = item.id
       AND retry.id = NEW.correction_retry_event_id
       AND retry.event_type = 'RETRY_REQUESTED'
      JOIN public.clinical_import_document_receipts AS replacement_document
        ON replacement_document.tenant_id = NEW.tenant_id
       AND replacement_document.id = NEW.document_receipt_id
       AND replacement_document.patient_uid = NEW.patient_uid
     WHERE item.tenant_id = NEW.tenant_id
       AND item.id = NEW.correction_reconciliation_item_id
       AND NEW.outcome IN ('imported', 'deduplicated')
       AND public.clinical_import_active_patient_survivor_760(
             item.tenant_id,
             item.patient_uid
           ) = NEW.patient_uid
       AND item.facility_id = replacement_document.source_facility_id
       AND source_document.source_system = replacement_document.source_system
       AND source_document.document_format = replacement_document.document_format
       AND retry.actor_uid = replacement_document.actor_uid
       AND retry.actor_role = replacement_document.actor_role
       AND retry.evidence #>> '{request,authority_grant_id}'
             = replacement_document.authority_grant_id::text
       AND original.source_resource_type = NEW.source_resource_type
       AND (
         (
           original.source_resource_id IS NOT NULL
           AND original.source_resource_id = NEW.source_resource_id
         )
         OR
         (
           original.source_resource_id IS NULL
           AND original.source_resource_index = NEW.source_resource_index
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.clinical_import_reconciliation_events AS later
          WHERE later.tenant_id = retry.tenant_id
            AND later.reconciliation_item_id = retry.reconciliation_item_id
            AND (later.created_at, later.id) > (retry.created_at, retry.id)
       )
  ) THEN
    RAISE EXCEPTION 'clinical import correction receipt lacks the current exact retry binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_import_reconciliation_event_guard_760()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  item public.clinical_import_reconciliation_items%ROWTYPE;
  previous public.clinical_import_reconciliation_events%ROWTYPE;
  source_document public.clinical_import_document_receipts%ROWTYPE;
  active_patient_uid uuid;
  authority_grant_id_text text;
  previous_found boolean;
BEGIN
  SELECT reconciliation.*
    INTO item
    FROM public.clinical_import_reconciliation_items AS reconciliation
   WHERE reconciliation.tenant_id = NEW.tenant_id
     AND reconciliation.id = NEW.reconciliation_item_id
   FOR UPDATE;
  IF NOT FOUND
     OR NEW.resource_receipt_id IS DISTINCT FROM item.resource_receipt_id
     OR NEW.document_receipt_id IS DISTINCT FROM item.document_receipt_id
     OR NEW.patient_uid IS DISTINCT FROM item.patient_uid
     OR NEW.facility_id IS DISTINCT FROM item.facility_id
     OR NEW.created_at < item.created_at THEN
    RAISE EXCEPTION 'clinical import reconciliation event does not exactly bind its owned item'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.users AS actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.uid = NEW.actor_uid
       AND actor.role = 'MEDICAL_RECORDS'
       AND actor.is_active = TRUE
       AND actor.status = 'active'
       AND actor.is_deleted = FALSE
       AND actor.merged_into_uid IS NULL
  ) THEN
    RAISE EXCEPTION 'clinical import reconciliation actor is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT document.*
    INTO source_document
    FROM public.clinical_import_document_receipts AS document
   WHERE document.tenant_id = NEW.tenant_id
     AND document.id = NEW.document_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinical import reconciliation source document is unavailable'
      USING ERRCODE = '23514';
  END IF;

  SELECT event.*
    INTO previous
    FROM public.clinical_import_reconciliation_events AS event
   WHERE event.tenant_id = NEW.tenant_id
     AND event.reconciliation_item_id = NEW.reconciliation_item_id
   ORDER BY event.created_at DESC, event.id DESC
   LIMIT 1;
  previous_found := FOUND;
  IF NEW.event_type = 'OPENED' THEN
    IF previous_found
       OR NEW.reason IS DISTINCT FROM item.reason
       OR NEW.idempotency_key_sha256 IS DISTINCT FROM item.idempotency_key_sha256 THEN
      RAISE EXCEPTION 'clinical import reconciliation requires one exact initial OPENED event'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  active_patient_uid := public.clinical_import_active_patient_survivor_760(
    NEW.tenant_id,
    NEW.patient_uid
  );
  authority_grant_id_text := NEW.evidence #>> '{request,authority_grant_id}';
  IF active_patient_uid IS NULL
     OR authority_grant_id_text IS NULL
     OR authority_grant_id_text !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR NEW.evidence ->> 'contract_version'
          IS DISTINCT FROM 'clinical-import-reconciliation-event-v1'
     OR NEW.evidence #>> '{request,event_type}' IS DISTINCT FROM NEW.event_type
     OR NEW.evidence #>> '{request,reason}' IS DISTINCT FROM NEW.reason
     OR NEW.evidence #>> '{custody,historical_patient_uid}'
          IS DISTINCT FROM NEW.patient_uid::text
     OR NEW.evidence #>> '{custody,active_survivor_patient_uid}'
          IS DISTINCT FROM active_patient_uid::text THEN
    RAISE EXCEPTION 'clinical import reconciliation action evidence is invalid or stale'
      USING ERRCODE = '23514';
  END IF;
  PERFORM public.lock_clinical_import_authority_760(
    NEW.tenant_id,
    authority_grant_id_text::uuid,
    active_patient_uid,
    NEW.facility_id,
    NEW.actor_uid,
    source_document.source_system,
    source_document.document_format
  );
  IF NOT previous_found
     OR NEW.predecessor_event_id IS DISTINCT FROM previous.id
     OR NEW.created_at <= previous.created_at
     OR previous.event_type = 'RESOLVED'
     OR (NEW.event_type = 'RETRY_REQUESTED'
          AND previous.event_type NOT IN ('OPENED', 'RETRY_REQUESTED'))
     OR (NEW.event_type = 'RESOLVED'
          AND previous.event_type <> 'RETRY_REQUESTED') THEN
    RAISE EXCEPTION 'clinical import reconciliation event transition is invalid or stale'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'RETRY_REQUESTED'
     AND EXISTS (
       SELECT 1
         FROM public.clinical_import_resource_receipts AS replacement
        WHERE replacement.tenant_id = NEW.tenant_id
          AND replacement.correction_reconciliation_item_id = item.id
     ) THEN
    RAISE EXCEPTION 'a committed clinical import correction must be resolved before another retry'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'RESOLVED'
     AND NOT EXISTS (
       SELECT 1
         FROM public.clinical_import_resource_receipts AS replacement
         JOIN public.clinical_import_document_receipts AS replacement_document
           ON replacement_document.tenant_id = replacement.tenant_id
          AND replacement_document.id = replacement.document_receipt_id
          AND replacement_document.patient_uid = replacement.patient_uid
         JOIN public.clinical_import_resource_receipts AS original
           ON original.tenant_id = item.tenant_id
          AND original.id = item.resource_receipt_id
        WHERE replacement.tenant_id = NEW.tenant_id
          AND replacement.id = NEW.replacement_resource_receipt_id
          AND replacement.outcome IN ('imported', 'deduplicated')
          AND replacement.created_at > previous.created_at
          AND replacement.correction_reconciliation_item_id = item.id
          AND replacement.correction_original_resource_receipt_id = item.resource_receipt_id
          AND replacement.correction_retry_event_id = previous.id
          AND replacement.patient_uid = active_patient_uid
          AND replacement.source_resource_type = original.source_resource_type
          AND (
            (original.source_resource_id IS NOT NULL
              AND replacement.source_resource_id = original.source_resource_id)
            OR
            (original.source_resource_id IS NULL
              AND replacement.source_resource_index = original.source_resource_index)
          )
          AND replacement_document.source_system = source_document.source_system
          AND replacement_document.document_format = source_document.document_format
          AND replacement_document.source_facility_id = NEW.facility_id
          AND NEW.evidence #>> '{request,replacement_resource_receipt_id}'
                = replacement.id::text
          AND NEW.evidence #>> '{replacement_receipt,resource_receipt_id}'
                = replacement.id::text
          AND NEW.evidence #>> '{replacement_receipt,correction_reconciliation_item_id}'
                = item.id::text
          AND NEW.evidence #>> '{replacement_receipt,correction_original_resource_receipt_id}'
                = item.resource_receipt_id::text
          AND NEW.evidence #>> '{replacement_receipt,correction_retry_event_id}'
                = previous.id::text
      ) THEN
    RAISE EXCEPTION 'clinical import reconciliation resolution lacks an exact newer replacement receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.clinical_import_failed_receipt_reconciliation_guard_760()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  exact_initial_count bigint;
BEGIN
  SELECT COUNT(*)
    INTO exact_initial_count
    FROM public.clinical_import_reconciliation_items AS item
    JOIN public.clinical_import_reconciliation_events AS event
      ON event.tenant_id = item.tenant_id
     AND event.reconciliation_item_id = item.id
     AND event.resource_receipt_id = item.resource_receipt_id
     AND event.document_receipt_id = item.document_receipt_id
     AND event.patient_uid = item.patient_uid
     AND event.facility_id = item.facility_id
     AND event.actor_uid = item.owner_actor_uid
     AND event.actor_role = item.owner_actor_role
     AND event.reason = item.reason
     AND event.idempotency_key_sha256 = item.idempotency_key_sha256
     AND event.event_type = 'OPENED'
     AND event.predecessor_event_id IS NULL
   WHERE item.tenant_id = NEW.tenant_id
     AND item.resource_receipt_id = NEW.id
     AND item.document_receipt_id = NEW.document_receipt_id
     AND item.patient_uid = NEW.patient_uid;
  IF exact_initial_count <> 1 THEN
    RAISE EXCEPTION 'failed clinical import resource requires exactly one owned reconciliation item and OPENED event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_import_authority_event_validate_760
BEFORE INSERT ON public.clinical_import_authority_events
FOR EACH ROW EXECUTE FUNCTION public.clinical_import_authority_event_guard_760();

CREATE TRIGGER clinical_import_authority_event_append_only_760
BEFORE UPDATE OR DELETE ON public.clinical_import_authority_events
FOR EACH ROW EXECUTE FUNCTION public.clinical_import_append_only_guard_760();

CREATE TRIGGER clinical_import_raw_artifact_validate_760
BEFORE INSERT ON public.clinical_import_raw_artifacts
FOR EACH ROW EXECUTE FUNCTION public.clinical_import_raw_artifact_guard_760();

CREATE TRIGGER clinical_import_raw_artifact_append_only_760
BEFORE UPDATE OR DELETE ON public.clinical_import_raw_artifacts
FOR EACH ROW EXECUTE FUNCTION public.clinical_import_append_only_guard_760();

CREATE TRIGGER clinical_import_reconciliation_item_validate_760
BEFORE INSERT OR UPDATE OR DELETE ON public.clinical_import_reconciliation_items
FOR EACH ROW EXECUTE FUNCTION public.clinical_import_reconciliation_item_guard_760();

CREATE TRIGGER clinical_import_reconciliation_event_validate_760
BEFORE INSERT ON public.clinical_import_reconciliation_events
FOR EACH ROW EXECUTE FUNCTION public.clinical_import_reconciliation_event_guard_760();

CREATE TRIGGER clinical_import_resource_correction_validate_760
BEFORE INSERT ON public.clinical_import_resource_receipts
FOR EACH ROW EXECUTE FUNCTION public.clinical_import_resource_correction_guard_760();

CREATE TRIGGER clinical_import_reconciliation_event_append_only_760
BEFORE UPDATE OR DELETE ON public.clinical_import_reconciliation_events
FOR EACH ROW EXECUTE FUNCTION public.clinical_import_append_only_guard_760();

CREATE CONSTRAINT TRIGGER clinical_import_failed_receipt_reconciliation_760
AFTER INSERT ON public.clinical_import_resource_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.outcome = 'failed')
EXECUTE FUNCTION public.clinical_import_failed_receipt_reconciliation_guard_760();

REVOKE EXECUTE ON FUNCTION public.clinical_import_append_only_guard_760() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_authority_event_guard_760() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_raw_artifact_guard_760() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.lock_clinical_import_authority_760(
  uuid, uuid, uuid, integer, uuid, text, text
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_document_authority_guard_755() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_reconciliation_item_guard_760() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_active_patient_survivor_760(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_resource_correction_guard_760() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_reconciliation_event_guard_760() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.clinical_import_failed_receipt_reconciliation_guard_760() FROM PUBLIC;

ALTER TABLE public.clinical_import_authority_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_import_authority_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_import_raw_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_import_raw_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_import_reconciliation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_import_reconciliation_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_import_reconciliation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_import_reconciliation_events FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_import_authority_runtime_access_760
ON public.clinical_import_authority_events
AS PERMISSIVE
USING (tenant_id::text = current_setting('app.current_tenant_id', true))
WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation
ON public.clinical_import_authority_events
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

CREATE POLICY clinical_import_raw_runtime_access_760
ON public.clinical_import_raw_artifacts
AS PERMISSIVE
USING (tenant_id::text = current_setting('app.current_tenant_id', true))
WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation
ON public.clinical_import_raw_artifacts
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

CREATE POLICY clinical_import_reconciliation_item_runtime_access_760
ON public.clinical_import_reconciliation_items
AS PERMISSIVE
USING (tenant_id::text = current_setting('app.current_tenant_id', true))
WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation
ON public.clinical_import_reconciliation_items
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

CREATE POLICY clinical_import_reconciliation_event_runtime_access_760
ON public.clinical_import_reconciliation_events
AS PERMISSIVE
USING (tenant_id::text = current_setting('app.current_tenant_id', true))
WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation
ON public.clinical_import_reconciliation_events
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

DO $clinical_import_custody_runtime_acl_760$
DECLARE
  runtime_role text;
  guarded_function text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::text[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN CONTINUE; END IF;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_authority_events FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.clinical_import_authority_events TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_raw_artifacts FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (id, tenant_id, authority_grant_id, patient_uid, source_facility_id, actor_uid, actor_role, source_system, source_document_id, document_format, raw_payload_sha256, raw_payload_bytes, raw_content_type, raw_payload_ciphertext, encryption_key_id, canonicalization_version, canonical_payload_sha256, asserted_source_signature_sha256, signature_verification_status, source_author_evidence, recorded_by, contract_version) ON TABLE public.clinical_import_raw_artifacts TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT (id, tenant_id, authority_grant_id, patient_uid, source_facility_id, actor_uid, actor_role, source_system, source_document_id, document_format, raw_payload_sha256, raw_payload_bytes, raw_content_type, canonicalization_version, canonical_payload_sha256, asserted_source_signature_sha256, signature_verification_status, source_author_evidence_sha256, recorded_by, contract_version, created_at) ON TABLE public.clinical_import_raw_artifacts TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_reconciliation_items FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.clinical_import_reconciliation_items TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (id, tenant_id, resource_receipt_id, document_receipt_id, patient_uid, facility_id, owner_actor_uid, owner_actor_role, reason, idempotency_key_sha256, contract_version) ON TABLE public.clinical_import_reconciliation_items TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_reconciliation_events FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.clinical_import_reconciliation_events TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (id, tenant_id, reconciliation_item_id, resource_receipt_id, document_receipt_id, patient_uid, facility_id, event_type, actor_uid, actor_role, reason, predecessor_event_id, replacement_resource_receipt_id, idempotency_key_sha256, evidence, contract_version) ON TABLE public.clinical_import_reconciliation_events TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE INSERT ON TABLE public.clinical_import_document_receipts FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (id, tenant_id, patient_id, patient_uid, source_facility_id, authority_grant_id, raw_artifact_id, patient_identifier_ids, patient_identity_binding_sha256, access_decision_evidence, source_author_evidence, actor_uid, actor_role, ingestion_mode, document_format, source_system, source_document_id, asserted_source_signature_sha256, source_payload_sha256, source_identity_sha256, idempotency_key_sha256, resource_manifest_sha256, resource_manifest, result, status, request_id, canonical_timeline_event_id, canonical_audit_event_id, contract_version) ON TABLE public.clinical_import_document_receipts TO %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE INSERT ON TABLE public.clinical_import_resource_receipts FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT INSERT (id, tenant_id, document_receipt_id, patient_uid, source_resource_type, source_resource_id, source_resource_index, source_identity_sha256, payload_sha256, outcome, target_table, target_id, canonical_timeline_event_id, canonical_audit_event_id, evidence, correction_reconciliation_item_id, correction_original_resource_receipt_id, correction_retry_event_id, contract_version) ON TABLE public.clinical_import_resource_receipts TO %I',
      runtime_role
    );
    FOREACH guarded_function IN ARRAY ARRAY[
      'clinical_import_append_only_guard_760()',
      'clinical_import_authority_event_guard_760()',
      'clinical_import_raw_artifact_guard_760()',
      'clinical_import_document_authority_guard_755()',
      'clinical_import_reconciliation_item_guard_760()',
      'clinical_import_active_patient_survivor_760(uuid,uuid)',
      'clinical_import_resource_correction_guard_760()',
      'clinical_import_reconciliation_event_guard_760()',
      'clinical_import_failed_receipt_reconciliation_guard_760()'
    ]::text[]
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.%s FROM %I',
        guarded_function,
        runtime_role
      );
    END LOOP;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.lock_clinical_import_authority_760(uuid,uuid,uuid,integer,uuid,text,text) FROM %I',
      runtime_role
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.lock_clinical_import_authority_760(uuid,uuid,uuid,integer,uuid,text,text) TO %I',
      runtime_role
    );
  END LOOP;
END;
$clinical_import_custody_runtime_acl_760$;

COMMENT ON TABLE public.clinical_import_authority_events IS
  'Owner-managed append-only clinical import grant/revocation roster. Runtime receives SELECT only; no grants are bootstrapped.';
COMMENT ON TABLE public.clinical_import_raw_artifacts IS
  'Encrypted append-only exact source bytes and provenance for a governed clinical document import.';
COMMENT ON COLUMN public.clinical_import_document_receipts.patient_identity_binding_sha256 IS
  'SHA-256 of clinical-import-patient-identity-v1|tenant_id|patient_id|patient_uid|sorted comma-separated patient_identifier_ids.';

-- ---------------------------------------------------------------------------
-- BI reader privileges.
--
-- Migration 157 sets ALTER DEFAULT PRIVILEGES so the read-only analytics roles
-- inherit SELECT on every new public table. That is right for operational
-- tables and wrong for these six: clinical_import_raw_artifacts holds
-- raw_payload_ciphertext (the exact encrypted source document), and the receipt
-- and reconciliation tables carry patient identity bindings, authority-grant
-- evidence and custody internals. Measured on a database built from this
-- migration chain: metabase_readonly held SELECT on all six, including the
-- ciphertext table.
--
-- Same guarded shape as migration 631: skip a role that does not exist, so this
-- is a no-op on a deployment that never provisioned the BI readers.
-- ---------------------------------------------------------------------------
DO $clinical_import_bi_privileges$
DECLARE
  readonly_role TEXT;
  target_table TEXT;
BEGIN
  FOREACH readonly_role IN ARRAY ARRAY['metabase_readonly', 'vhhealth_readonly']::TEXT[] LOOP
    IF pg_catalog.to_regrole(readonly_role) IS NULL THEN
      CONTINUE;
    END IF;
    FOREACH target_table IN ARRAY ARRAY[
      'clinical_import_raw_artifacts',
      'clinical_import_document_receipts',
      'clinical_import_resource_receipts',
      'clinical_import_authority_events',
      'clinical_import_reconciliation_items',
      'clinical_import_reconciliation_events'
    ]::TEXT[] LOOP
      IF pg_catalog.to_regclass('public.' || target_table) IS NULL THEN
        CONTINUE;
      END IF;
      EXECUTE FORMAT(
        'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
        target_table, readonly_role
      );
    END LOOP;
  END LOOP;
END
$clinical_import_bi_privileges$;

COMMIT;
