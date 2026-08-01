-- Migration 606: C5.2 paper back-entry and reconciliation workbench.
--
-- This migration is deliberately inert. It adds durable reconciliation state
-- and the paper-source extension to the C5.1 receipt authority, but it does not
-- activate downtime operation, an interface, a facility, or a policy.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE public.clinical_continuity_incident_packets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  reserved_incident_id UUID NOT NULL,
  range_prefix VARCHAR(32) NOT NULL,
  range_first BIGINT NOT NULL,
  range_last BIGINT NOT NULL,
  packet_key_id VARCHAR(128) NOT NULL,
  packet_key_version VARCHAR(80) NOT NULL,
  canonical_payload_hash CHAR(64) NOT NULL,
  signature TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'unused',
  valid_from TIMESTAMPTZ(6) NOT NULL,
  valid_until TIMESTAMPTZ(6) NOT NULL,
  revoked_at TIMESTAMPTZ(6),
  revocation_reason VARCHAR(160),
  used_at TIMESTAMPTZ(6),
  used_by UUID,
  contact_sheet_version VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_incident_packet_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_packet_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_packet_used_by
    FOREIGN KEY (tenant_id, used_by)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_incident_packet_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_cc_incident_packet_reserved_incident
    UNIQUE (tenant_id, facility_id, reserved_incident_id),
  CONSTRAINT chk_cc_incident_packet_range CHECK (range_first > 0 AND range_last >= range_first),
  CONSTRAINT chk_cc_incident_packet_hash
    CHECK (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_incident_packet_status
    CHECK (status IN ('unused', 'used', 'revoked', 'expired')),
  CONSTRAINT chk_cc_incident_packet_times
    CHECK (
      valid_from < valid_until
      AND (status <> 'used' OR (used_at IS NOT NULL AND used_by IS NOT NULL))
      AND (status <> 'revoked' OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
    )
);

CREATE TABLE public.clinical_continuity_incidents (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  packet_id UUID NOT NULL,
  canonical_incident_id UUID,
  alias_disposition VARCHAR(24) NOT NULL DEFAULT 'canonical',
  commander_uid UUID NOT NULL,
  commander_role VARCHAR(80) NOT NULL,
  lifecycle_state VARCHAR(24) NOT NULL DEFAULT 'declared',
  version INTEGER NOT NULL DEFAULT 1,
  declared_at TIMESTAMPTZ(6) NOT NULL,
  restored_at TIMESTAMPTZ(6),
  reconciliation_started_at TIMESTAMPTZ(6),
  closed_at TIMESTAMPTZ(6),
  closure_snapshot_hash CHAR(64),
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_incident_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_packet
    FOREIGN KEY (tenant_id, facility_id, packet_id)
    REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_commander
    FOREIGN KEY (tenant_id, commander_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_created_by
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_updated_by
    FOREIGN KEY (tenant_id, updated_by)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_incident_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT chk_cc_incident_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_incident_alias_disposition
    CHECK (alias_disposition IN ('canonical', 'observed_alias')),
  CONSTRAINT chk_cc_incident_state
    CHECK (lifecycle_state IN ('declared', 'restored', 'reconciling', 'closed')),
  CONSTRAINT chk_cc_incident_version CHECK (version > 0),
  CONSTRAINT chk_cc_incident_chronology
    CHECK (
      (restored_at IS NULL OR restored_at >= declared_at)
      AND (reconciliation_started_at IS NULL OR reconciliation_started_at >= declared_at)
      AND (closed_at IS NULL OR closed_at >= declared_at)
      AND (closure_snapshot_hash IS NULL OR closure_snapshot_hash ~ '^[0-9a-f]{64}$')
      AND (lifecycle_state <> 'closed' OR (closed_at IS NOT NULL AND closure_snapshot_hash IS NOT NULL))
    )
);

ALTER TABLE public.clinical_continuity_incidents
  ADD CONSTRAINT fk_cc_incident_canonical
  FOREIGN KEY (tenant_id, facility_id, canonical_incident_id)
  REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
  ON UPDATE NO ACTION ON DELETE NO ACTION;

CREATE UNIQUE INDEX uq_cc_incident_open_facility
  ON public.clinical_continuity_incidents (
    tenant_id,
    facility_id,
    (CASE
      WHEN lifecycle_state <> 'closed' AND alias_disposition = 'canonical' THEN TRUE
      ELSE NULL
    END)
  );

CREATE TABLE public.clinical_continuity_paper_ranges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  packet_id UUID NOT NULL,
  range_prefix VARCHAR(32) NOT NULL,
  range_first BIGINT NOT NULL,
  range_last BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'allocated',
  last_accounted_number BIGINT,
  loss_reported_at TIMESTAMPTZ(6),
  revoked_at TIMESTAMPTZ(6),
  reason VARCHAR(500),
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_paper_range_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_range_packet
    FOREIGN KEY (tenant_id, facility_id, packet_id)
    REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_range_created_by
    FOREIGN KEY (tenant_id, created_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_range_updated_by
    FOREIGN KEY (tenant_id, updated_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_paper_range_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_cc_paper_range_packet UNIQUE (tenant_id, facility_id, packet_id),
  CONSTRAINT chk_cc_paper_range_bounds
    CHECK (
      range_first > 0 AND range_last >= range_first
      AND (last_accounted_number IS NULL OR last_accounted_number BETWEEN range_first AND range_last)
    ),
  CONSTRAINT chk_cc_paper_range_status
    CHECK (status IN ('allocated', 'in_use', 'accounted', 'lost', 'revoked', 'exhausted')),
  CONSTRAINT chk_cc_paper_range_terminal
    CHECK (
      (status <> 'lost' OR loss_reported_at IS NOT NULL)
      AND (status <> 'revoked' OR revoked_at IS NOT NULL)
      AND version > 0
    )
);

CREATE TABLE public.clinical_continuity_incident_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  packet_id UUID NOT NULL,
  paper_range_id UUID NOT NULL,
  declaration_source VARCHAR(24) NOT NULL,
  packet_key_id VARCHAR(128) NOT NULL,
  packet_key_version VARCHAR(80) NOT NULL,
  signed_canonical_hash CHAR(64) NOT NULL,
  governed_evidence_ref VARCHAR(255),
  signer_uid UUID NOT NULL,
  signer_role VARCHAR(80) NOT NULL,
  verification_result VARCHAR(24) NOT NULL,
  conflict_disposition VARCHAR(32) NOT NULL DEFAULT 'accepted',
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  imported_by UUID NOT NULL,
  source_device_id UUID,
  source_session_id UUID,
  request_id UUID,
  CONSTRAINT fk_cc_incident_declaration_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_declaration_packet
    FOREIGN KEY (tenant_id, facility_id, packet_id)
    REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_declaration_range
    FOREIGN KEY (tenant_id, facility_id, paper_range_id)
    REFERENCES public.clinical_continuity_paper_ranges(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_declaration_signer
    FOREIGN KEY (tenant_id, signer_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_declaration_importer
    FOREIGN KEY (tenant_id, imported_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_incident_declaration_source
    CHECK (declaration_source IN ('online', 'offline_import')),
  CONSTRAINT chk_cc_incident_declaration_verification
    CHECK (verification_result IN ('verified', 'rejected')),
  CONSTRAINT chk_cc_incident_declaration_disposition
    CHECK (conflict_disposition IN ('accepted', 'duplicate', 'split_brain', 'revoked', 'expired', 'conflict')),
  CONSTRAINT chk_cc_incident_declaration_hash
    CHECK (signed_canonical_hash ~ '^[0-9a-f]{64}$' AND occurred_at <= recorded_at)
);

CREATE UNIQUE INDEX uq_cc_incident_declaration_accepted
  ON public.clinical_continuity_incident_declarations (tenant_id, facility_id, incident_id)
  WHERE verification_result = 'verified' AND conflict_disposition = 'accepted';

CREATE TABLE public.clinical_continuity_incident_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  observed_incident_id UUID NOT NULL,
  canonical_incident_id UUID NOT NULL,
  disposition VARCHAR(24) NOT NULL DEFAULT 'active',
  supersedes_alias_id UUID,
  reason_code VARCHAR(120) NOT NULL,
  decided_by UUID NOT NULL,
  decided_role VARCHAR(80) NOT NULL,
  decided_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_incident_alias_observed
    FOREIGN KEY (tenant_id, facility_id, observed_incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_alias_canonical
    FOREIGN KEY (tenant_id, facility_id, canonical_incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_incident_alias_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT fk_cc_incident_alias_supersedes
    FOREIGN KEY (tenant_id, facility_id, supersedes_alias_id)
    REFERENCES public.clinical_continuity_incident_aliases(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_alias_actor
    FOREIGN KEY (tenant_id, decided_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_incident_alias_distinct CHECK (observed_incident_id <> canonical_incident_id),
  CONSTRAINT chk_cc_incident_alias_disposition
    CHECK (disposition IN ('active', 'corrective', 'rejected'))
);

CREATE UNIQUE INDEX uq_cc_incident_alias_active_observed
  ON public.clinical_continuity_incident_aliases (tenant_id, facility_id, observed_incident_id)
  WHERE disposition = 'active';

CREATE TABLE public.clinical_continuity_paper_range_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  paper_range_id UUID NOT NULL,
  decision VARCHAR(24) NOT NULL,
  reason_code VARCHAR(120) NOT NULL,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(80) NOT NULL,
  decided_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_paper_range_decision_range
    FOREIGN KEY (tenant_id, facility_id, paper_range_id)
    REFERENCES public.clinical_continuity_paper_ranges(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_range_decision_actor
    FOREIGN KEY (tenant_id, actor_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_paper_range_decision
    CHECK (decision IN ('allocated', 'loss_reported', 'revoked', 'accounted', 'exhausted'))
);

CREATE TABLE public.clinical_continuity_temporary_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  packet_id UUID NOT NULL,
  paper_range_id UUID NOT NULL,
  paper_item_id VARCHAR(128) NOT NULL,
  display_identifier VARCHAR(128) NOT NULL,
  identity_status VARCHAR(32) NOT NULL DEFAULT 'unresolved',
  matched_patient_uid UUID,
  merge_request_id INTEGER,
  safety_critical BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_temp_identity_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_temp_identity_packet
    FOREIGN KEY (tenant_id, facility_id, packet_id)
    REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_temp_identity_range
    FOREIGN KEY (tenant_id, facility_id, paper_range_id)
    REFERENCES public.clinical_continuity_paper_ranges(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_temp_identity_patient
    FOREIGN KEY (tenant_id, matched_patient_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_temp_identity_merge
    FOREIGN KEY (merge_request_id) REFERENCES public.patient_merge_requests(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_temp_identity_created_by
    FOREIGN KEY (tenant_id, created_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_temp_identity_updated_by
    FOREIGN KEY (tenant_id, updated_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_temp_identity_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_cc_temp_identity_incident_id UNIQUE (tenant_id, facility_id, incident_id, id),
  CONSTRAINT uq_cc_temp_identity_paper
    UNIQUE (tenant_id, facility_id, incident_id, paper_item_id),
  CONSTRAINT chk_cc_temp_identity_status
    CHECK (identity_status IN ('unresolved', 'proposed', 'matched', 'retained_temporary')),
  CONSTRAINT chk_cc_temp_identity_match
    CHECK (
      version > 0
      AND (identity_status <> 'matched' OR (matched_patient_uid IS NOT NULL AND merge_request_id IS NOT NULL))
    )
);

CREATE TABLE public.clinical_continuity_paper_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  packet_id UUID NOT NULL,
  paper_range_id UUID NOT NULL,
  paper_item_id VARCHAR(128) NOT NULL,
  paper_item_number BIGINT NOT NULL,
  item_kind VARCHAR(40) NOT NULL,
  action_id VARCHAR(120),
  original_actor_uid UUID,
  original_actor_role VARCHAR(80),
  occurred_at TIMESTAMPTZ(6),
  back_entry_actor_uid UUID,
  recorded_at TIMESTAMPTZ(6),
  reviewer_uid UUID,
  reviewed_at TIMESTAMPTZ(6),
  patient_id INTEGER,
  patient_uid UUID,
  temporary_identity_id UUID,
  encounter_id UUID,
  evidence_hash CHAR(64) NOT NULL,
  payload_fingerprint CHAR(64),
  receipt_client_event_id UUID,
  fact_id UUID,
  timeline_event_id UUID,
  audit_event_id UUID,
  reconciliation_disposition VARCHAR(32) NOT NULL DEFAULT 'unentered',
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_paper_item_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_item_packet
    FOREIGN KEY (tenant_id, facility_id, packet_id)
    REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_item_range
    FOREIGN KEY (tenant_id, facility_id, paper_range_id)
    REFERENCES public.clinical_continuity_paper_ranges(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_item_patient
    FOREIGN KEY (tenant_id, patient_id, patient_uid)
    REFERENCES public.users(tenant_id, id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_item_temp_identity
    FOREIGN KEY (tenant_id, facility_id, incident_id, temporary_identity_id)
    REFERENCES public.clinical_continuity_temporary_identities(tenant_id, facility_id, incident_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_item_encounter
    FOREIGN KEY (tenant_id, encounter_id, patient_uid)
    REFERENCES public.patient_encounters(tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_item_created_by
    FOREIGN KEY (tenant_id, created_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_paper_item_updated_by
    FOREIGN KEY (tenant_id, updated_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_paper_item_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_cc_paper_item_incident_id UNIQUE (tenant_id, facility_id, incident_id, id),
  CONSTRAINT uq_cc_paper_item_external_identity
    UNIQUE (tenant_id, facility_id, incident_id, paper_item_id),
  CONSTRAINT chk_cc_paper_item_kind
    CHECK (item_kind IN ('temporary_identity', 'medication_administration', 'specimen_collection', 'transfusion_verification', 'other')),
  CONSTRAINT chk_cc_paper_item_disposition
    CHECK (reconciliation_disposition IN ('unentered', 'claimed', 'applied', 'needs_review', 'excluded', 'voided', 'lost_revoked')),
  CONSTRAINT chk_cc_paper_item_hashes
    CHECK (
      evidence_hash ~ '^[0-9a-f]{64}$'
      AND (payload_fingerprint IS NULL OR payload_fingerprint ~ '^[0-9a-f]{64}$')
      AND version > 0
    ),
  CONSTRAINT chk_cc_paper_item_patient_shape
    CHECK ((patient_id IS NULL) = (patient_uid IS NULL)),
  CONSTRAINT chk_cc_paper_item_identity_choice
    CHECK (NOT (patient_uid IS NOT NULL AND temporary_identity_id IS NOT NULL)),
  CONSTRAINT chk_cc_paper_item_number
    CHECK (paper_item_number > 0),
  CONSTRAINT chk_cc_paper_item_clocks
    CHECK (
      (occurred_at IS NULL OR recorded_at IS NULL OR occurred_at <= recorded_at)
      AND (reviewed_at IS NULL OR recorded_at IS NULL OR reviewed_at >= recorded_at)
    )
);

ALTER TABLE public.clinical_continuity_replay_receipts
  DROP CONSTRAINT chk_cc_replay_receipt_draft_shape,
  ADD CONSTRAINT chk_cc_replay_receipt_action_shape
    CHECK (
      (
        source_kind = 'electronic_queue'
        AND action_id IN ('emr.nursing_note.draft.store', 'emr.op_note.draft.store')
        AND binding_id = 'emr.note_draft.store/v1'
        AND http_method = 'PUT'
        AND encounter_id IS NULL
        AND admission_id IS NULL
        AND (
          (action_id = 'emr.nursing_note.draft.store' AND appointment_id IS NULL)
          OR action_id = 'emr.op_note.draft.store'
        )
      )
      OR
      (
        source_kind = 'paper_back_entry'
        AND (
          (
            action_id IN ('emr.nursing_note.draft.store', 'emr.op_note.draft.store')
            AND binding_id = 'emr.note_draft.store/v1'
            AND http_method = 'PUT'
          )
          OR
          (
            action_id IN (
              'mar.administration.backfill',
              'lab.specimen_collection.backfill',
              'blood.transfusion_verification.backfill'
            )
            AND binding_id = action_id || '/v1'
            AND http_method = 'POST'
          )
        )
        AND incident_id IS NOT NULL
        AND paper_item_id IS NOT NULL
      )
      OR source_kind NOT IN ('electronic_queue', 'paper_back_entry')
    );

CREATE UNIQUE INDEX ux_cc_mar_tenant_id
  ON public.medication_administrations (tenant_id, id);
CREATE UNIQUE INDEX ux_cc_investigations_tenant_id
  ON public.investigations (tenant_id, id);
CREATE UNIQUE INDEX ux_cc_blood_requests_tenant_id
  ON public.blood_requests (tenant_id, id);
CREATE UNIQUE INDEX ux_cc_blood_units_tenant_id
  ON public.blood_units (tenant_id, id);

CREATE TABLE public.clinical_continuity_retrospective_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  paper_item_row_id UUID NOT NULL,
  receipt_client_event_id UUID NOT NULL,
  action_id VARCHAR(120) NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  original_actor_uid UUID NOT NULL,
  original_actor_role VARCHAR(80) NOT NULL,
  medication_administration_id INTEGER,
  investigation_id INTEGER,
  transfusion_request_id INTEGER,
  blood_unit_id INTEGER,
  first_verifier_uid UUID,
  second_verifier_uid UUID,
  normalized_payload JSONB NOT NULL,
  payload_fingerprint CHAR(64) NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  reviewed_at TIMESTAMPTZ(6),
  decided_at TIMESTAMPTZ(6),
  effect_disposition VARCHAR(32) NOT NULL DEFAULT 'late_pending_only',
  domain_disposition VARCHAR(24) NOT NULL,
  created_by UUID NOT NULL,
  CONSTRAINT fk_cc_fact_paper_item
    FOREIGN KEY (tenant_id, facility_id, incident_id, paper_item_row_id)
    REFERENCES public.clinical_continuity_paper_items(tenant_id, facility_id, incident_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_receipt
    FOREIGN KEY (tenant_id, receipt_client_event_id)
    REFERENCES public.clinical_continuity_replay_receipts(tenant_id, client_event_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_patient
    FOREIGN KEY (tenant_id, patient_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_encounter
    FOREIGN KEY (tenant_id, encounter_id, patient_uid)
    REFERENCES public.patient_encounters(tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_created_by
    FOREIGN KEY (tenant_id, created_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_original_actor
    FOREIGN KEY (tenant_id, original_actor_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_mar
    FOREIGN KEY (tenant_id, medication_administration_id)
    REFERENCES public.medication_administrations(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_investigation
    FOREIGN KEY (tenant_id, investigation_id)
    REFERENCES public.investigations(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_transfusion_request
    FOREIGN KEY (tenant_id, transfusion_request_id)
    REFERENCES public.blood_requests(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_blood_unit
    FOREIGN KEY (tenant_id, blood_unit_id)
    REFERENCES public.blood_units(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_first_verifier
    FOREIGN KEY (tenant_id, first_verifier_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_fact_second_verifier
    FOREIGN KEY (tenant_id, second_verifier_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_fact_receipt UNIQUE (tenant_id, receipt_client_event_id),
  CONSTRAINT chk_cc_fact_action
    CHECK (action_id IN ('mar.administration.backfill', 'lab.specimen_collection.backfill', 'blood.transfusion_verification.backfill')),
  CONSTRAINT chk_cc_fact_hash
    CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$' AND evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_cc_fact_clocks
    CHECK (
      occurred_at <= recorded_at
      AND (reviewed_at IS NULL OR reviewed_at >= recorded_at)
      AND (decided_at IS NULL OR decided_at >= recorded_at)
    ),
  CONSTRAINT chk_cc_fact_late_effect
    CHECK (effect_disposition = 'late_pending_only'),
  CONSTRAINT chk_cc_fact_domain_disposition
    CHECK (domain_disposition IN ('recorded', 'projection_reconciled', 'needs_review')),
  CONSTRAINT chk_cc_fact_typed_reference
    CHECK (
      (action_id = 'mar.administration.backfill' AND medication_administration_id IS NOT NULL AND investigation_id IS NULL AND transfusion_request_id IS NULL)
      OR (action_id = 'lab.specimen_collection.backfill' AND medication_administration_id IS NULL AND investigation_id IS NOT NULL AND transfusion_request_id IS NULL)
      OR (action_id = 'blood.transfusion_verification.backfill' AND medication_administration_id IS NULL AND investigation_id IS NULL AND transfusion_request_id IS NOT NULL AND first_verifier_uid IS NOT NULL AND second_verifier_uid IS NOT NULL AND first_verifier_uid <> second_verifier_uid)
    )
);

ALTER TABLE public.clinical_continuity_paper_items
  ADD CONSTRAINT fk_cc_paper_item_fact
    FOREIGN KEY (fact_id) REFERENCES public.clinical_continuity_retrospective_facts(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_paper_item_receipt
    FOREIGN KEY (tenant_id, receipt_client_event_id)
    REFERENCES public.clinical_continuity_replay_receipts(tenant_id, client_event_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

CREATE UNIQUE INDEX ux_cc_paper_items_tenant_id
  ON public.clinical_continuity_paper_items (tenant_id, id);

ALTER TABLE public.clinical_continuity_replay_effect_evidence
  ALTER COLUMN note_draft_id DROP NOT NULL,
  ALTER COLUMN draft_revision DROP NOT NULL,
  ALTER COLUMN draft_updated_at DROP NOT NULL,
  ADD COLUMN retrospective_fact_id UUID,
  ADD COLUMN paper_item_row_id UUID,
  ADD COLUMN fact_resource_type VARCHAR(80),
  ADD COLUMN fact_resource_id VARCHAR(120),
  ADD COLUMN occurred_at TIMESTAMPTZ(6),
  ADD COLUMN recorded_at TIMESTAMPTZ(6),
  ADD COLUMN reviewed_at TIMESTAMPTZ(6),
  ADD COLUMN decided_at TIMESTAMPTZ(6),
  ADD COLUMN effect_disposition VARCHAR(32),
  ADD COLUMN retrospective_event_outbox_id BIGINT,
  DROP CONSTRAINT chk_cc_replay_effect_private_draft_only,
  ADD CONSTRAINT fk_cc_replay_effect_fact
    FOREIGN KEY (retrospective_fact_id)
    REFERENCES public.clinical_continuity_retrospective_facts(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_effect_paper_item
    FOREIGN KEY (tenant_id, paper_item_row_id)
    REFERENCES public.clinical_continuity_paper_items(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT chk_cc_replay_effect_shape
    CHECK (
      (
        outcome_code = 'draft_stored'
        AND note_draft_id IS NOT NULL
        AND draft_revision > 0
        AND draft_updated_at IS NOT NULL
        AND retrospective_fact_id IS NULL
        AND paper_item_row_id IS NULL
        AND clinical_timeline_event_id IS NULL
        AND clinical_audit_event_id IS NULL
        AND workflow_sla_instance_id IS NULL
        AND notification_outbox_id IS NULL
        AND event_outbox_id IS NULL
        AND retrospective_event_outbox_id IS NULL
        AND effect_disposition IS NULL
      )
      OR
      (
        outcome_code IN ('paper_fact_recorded', 'paper_fact_projection_reconciled')
        AND note_draft_id IS NULL
        AND draft_revision IS NULL
        AND draft_updated_at IS NULL
        AND retrospective_fact_id IS NOT NULL
        AND paper_item_row_id IS NOT NULL
        AND fact_resource_type IS NOT NULL
        AND fact_resource_id IS NOT NULL
        AND occurred_at IS NOT NULL
        AND recorded_at IS NOT NULL
        AND occurred_at <= recorded_at
        AND clinical_timeline_event_id IS NOT NULL
        AND clinical_audit_event_id IS NOT NULL
        AND event_outbox_id IS NULL
        AND retrospective_event_outbox_id IS NOT NULL
        AND workflow_sla_instance_id IS NULL
        AND notification_outbox_id IS NULL
        AND effect_disposition = 'late_pending_only'
      )
    );

CREATE TABLE public.clinical_continuity_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  queue_type VARCHAR(24) NOT NULL,
  disposition VARCHAR(32) NOT NULL DEFAULT 'open',
  reason_code VARCHAR(120) NOT NULL,
  paper_item_row_id UUID,
  temporary_identity_id UUID,
  device_offset_id UUID,
  interface_offset_id UUID,
  patient_uid UUID,
  encounter_id UUID,
  safety_critical BOOLEAN NOT NULL DEFAULT FALSE,
  owner_principal VARCHAR(120) NOT NULL,
  assigned_to_uid UUID,
  task_id INTEGER,
  handoff_actor_uid UUID,
  handoff_attested_at TIMESTAMPTZ(6),
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ(6),
  CONSTRAINT fk_cc_reconciliation_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_paper_item
    FOREIGN KEY (tenant_id, facility_id, incident_id, paper_item_row_id)
    REFERENCES public.clinical_continuity_paper_items(tenant_id, facility_id, incident_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_temp_identity
    FOREIGN KEY (tenant_id, facility_id, incident_id, temporary_identity_id)
    REFERENCES public.clinical_continuity_temporary_identities(tenant_id, facility_id, incident_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_interface_offset
    FOREIGN KEY (tenant_id, interface_offset_id)
    REFERENCES public.event_consumer_offsets(tenant_id, offset_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_task
    FOREIGN KEY (task_id) REFERENCES public.tasks(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_patient
    FOREIGN KEY (tenant_id, patient_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_assignee
    FOREIGN KEY (tenant_id, assigned_to_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_handoff_actor
    FOREIGN KEY (tenant_id, handoff_actor_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_created_by
    FOREIGN KEY (tenant_id, created_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_updated_by
    FOREIGN KEY (tenant_id, updated_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_reconciliation_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT chk_cc_reconciliation_queue
    CHECK (queue_type IN ('needs_review', 'identity', 'interface')),
  CONSTRAINT chk_cc_reconciliation_disposition
    CHECK (disposition IN ('open', 'in_progress', 'resolved', 'excluded', 'superseded')),
  CONSTRAINT chk_cc_reconciliation_owner
    CHECK (owner_principal <> '' AND version > 0),
  CONSTRAINT chk_cc_reconciliation_resolution
    CHECK ((disposition IN ('resolved', 'excluded', 'superseded')) = (resolved_at IS NOT NULL)),
  CONSTRAINT chk_cc_reconciliation_handoff
    CHECK ((handoff_actor_uid IS NULL) = (handoff_attested_at IS NULL))
);

CREATE TABLE public.clinical_continuity_reconciliation_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  fallback_principal VARCHAR(120) NOT NULL,
  clinical_safety_lead_uid UUID,
  needs_review_owner_principal VARCHAR(120) NOT NULL,
  identity_owner_principal VARCHAR(120) NOT NULL,
  interface_owner_principal VARCHAR(120) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_reconciliation_config_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_config_safety_lead
    FOREIGN KEY (tenant_id, clinical_safety_lead_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_config_created_by
    FOREIGN KEY (tenant_id, created_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_config_updated_by
    FOREIGN KEY (tenant_id, updated_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_reconciliation_config_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_cc_reconciliation_config_facility UNIQUE (tenant_id, facility_id),
  CONSTRAINT chk_cc_reconciliation_config_fallback
    CHECK (fallback_principal = 'role:clinical_safety_lead'),
  CONSTRAINT chk_cc_reconciliation_config_owners
    CHECK (
      needs_review_owner_principal <> ''
      AND identity_owner_principal <> ''
      AND interface_owner_principal <> ''
      AND version > 0
    )
);

CREATE UNIQUE INDEX uq_cc_reconciliation_open_paper
  ON public.clinical_continuity_reconciliation_items (tenant_id, paper_item_row_id, queue_type)
  WHERE paper_item_row_id IS NOT NULL AND disposition IN ('open', 'in_progress');

CREATE TABLE public.clinical_continuity_reconciliation_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  reconciliation_item_id UUID NOT NULL,
  decision VARCHAR(32) NOT NULL,
  reason_code VARCHAR(120) NOT NULL,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(80) NOT NULL,
  decided_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  prior_version INTEGER NOT NULL,
  resulting_version INTEGER NOT NULL,
  CONSTRAINT fk_cc_reconciliation_decision_item
    FOREIGN KEY (tenant_id, facility_id, reconciliation_item_id)
    REFERENCES public.clinical_continuity_reconciliation_items(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_reconciliation_decision_actor
    FOREIGN KEY (tenant_id, actor_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_reconciliation_decision
    CHECK (decision IN ('accept', 'exclude', 'assign', 'handoff', 'reopen', 'supersede')),
  CONSTRAINT chk_cc_reconciliation_decision_version
    CHECK (prior_version > 0 AND resulting_version = prior_version + 1)
);

CREATE TABLE public.clinical_continuity_device_journal_offsets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  device_id UUID NOT NULL,
  required_high_water_mark BIGINT NOT NULL,
  observed_high_water_mark BIGINT,
  disposition VARCHAR(32) NOT NULL DEFAULT 'pending',
  assigned_to_uid UUID,
  owner_principal VARCHAR(120) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_device_offset_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_offset_assignee
    FOREIGN KEY (tenant_id, assigned_to_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_device_offset_updated_by
    FOREIGN KEY (tenant_id, updated_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_device_offset_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_cc_device_offset_incident_id UNIQUE (tenant_id, facility_id, incident_id, id),
  CONSTRAINT uq_cc_device_offset_incident_device UNIQUE (tenant_id, facility_id, incident_id, device_id),
  CONSTRAINT chk_cc_device_offset_marks
    CHECK (required_high_water_mark >= 0 AND (observed_high_water_mark IS NULL OR observed_high_water_mark >= 0)),
  CONSTRAINT chk_cc_device_offset_disposition
    CHECK (disposition IN ('pending', 'reconciled', 'lost_assigned', 'not_applicable')),
  CONSTRAINT chk_cc_device_offset_owner CHECK (owner_principal <> '' AND version > 0)
);

CREATE TABLE public.clinical_continuity_incident_interfaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  offset_id UUID,
  interface_family VARCHAR(8) NOT NULL,
  direction VARCHAR(16) NOT NULL,
  source_partition VARCHAR(160) NOT NULL,
  required_generation INTEGER,
  required_high_water_position BIGINT,
  required_high_water_token VARCHAR(255),
  disposition VARCHAR(32) NOT NULL DEFAULT 'pending',
  owner_principal VARCHAR(120) NOT NULL,
  assigned_to_uid UUID,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_incident_interface_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_interface_offset
    FOREIGN KEY (tenant_id, offset_id)
    REFERENCES public.event_consumer_offsets(tenant_id, offset_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_interface_assignee
    FOREIGN KEY (tenant_id, assigned_to_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_interface_updated_by
    FOREIGN KEY (tenant_id, updated_by) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT uq_cc_incident_interface_scope_id UNIQUE (tenant_id, facility_id, id),
  CONSTRAINT uq_cc_incident_interface_requirement
    UNIQUE (tenant_id, facility_id, incident_id, interface_family, direction, source_partition),
  CONSTRAINT chk_cc_incident_interface_disposition
    CHECK (disposition IN ('pending', 'reconciled', 'not_applicable', 'assigned_gap')),
  CONSTRAINT chk_cc_incident_interface_shape
    CHECK (
      owner_principal <> '' AND version > 0
      AND ((disposition = 'not_applicable' AND offset_id IS NULL) OR (disposition <> 'not_applicable' AND offset_id IS NOT NULL))
    )
);

ALTER TABLE public.clinical_continuity_reconciliation_items
  ADD CONSTRAINT fk_cc_reconciliation_device_offset
  FOREIGN KEY (tenant_id, facility_id, incident_id, device_offset_id)
  REFERENCES public.clinical_continuity_device_journal_offsets(tenant_id, facility_id, incident_id, id)
  ON UPDATE NO ACTION ON DELETE NO ACTION;

CREATE TABLE public.clinical_continuity_incident_attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  attestation_kind VARCHAR(24) NOT NULL,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(80) NOT NULL,
  incident_version INTEGER NOT NULL,
  predicate_snapshot_hash CHAR(64) NOT NULL,
  attested_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_incident_attestation_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_incident_attestation_actor
    FOREIGN KEY (tenant_id, actor_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_incident_attestation_kind
    CHECK (attestation_kind IN ('operational', 'clinical')),
  CONSTRAINT chk_cc_incident_attestation_hash
    CHECK (incident_version > 0 AND predicate_snapshot_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX uq_cc_incident_attestation_version_kind
  ON public.clinical_continuity_incident_attestations
    (tenant_id, facility_id, incident_id, incident_version, attestation_kind);

ALTER TABLE public.patient_merge_requests
  ALTER COLUMN secondary_uid DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS chk_merge_distinct,
  ADD COLUMN continuity_facility_id INTEGER,
  ADD COLUMN continuity_incident_id UUID,
  ADD COLUMN continuity_packet_id UUID,
  ADD COLUMN continuity_paper_item_row_id UUID,
  ADD COLUMN continuity_temporary_identity_id UUID,
  ADD COLUMN requester_role VARCHAR(80),
  ADD COLUMN approver_role VARCHAR(80),
  ADD COLUMN continuity_disposition VARCHAR(32),
  ADD CONSTRAINT fk_patient_merge_continuity_incident
    FOREIGN KEY (tenant_id, continuity_facility_id, continuity_incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_patient_merge_continuity_packet
    FOREIGN KEY (tenant_id, continuity_facility_id, continuity_packet_id)
    REFERENCES public.clinical_continuity_incident_packets(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_patient_merge_continuity_paper_item
    FOREIGN KEY (tenant_id, continuity_facility_id, continuity_incident_id, continuity_paper_item_row_id)
    REFERENCES public.clinical_continuity_paper_items(tenant_id, facility_id, incident_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_patient_merge_continuity_temp_identity
    FOREIGN KEY (tenant_id, continuity_facility_id, continuity_incident_id, continuity_temporary_identity_id)
    REFERENCES public.clinical_continuity_temporary_identities(tenant_id, facility_id, incident_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT chk_patient_merge_continuity_shape
    CHECK (
      (continuity_incident_id IS NULL AND continuity_facility_id IS NULL AND continuity_packet_id IS NULL AND continuity_paper_item_row_id IS NULL AND continuity_temporary_identity_id IS NULL AND requester_role IS NULL AND approver_role IS NULL AND continuity_disposition IS NULL AND secondary_uid IS NOT NULL AND primary_uid <> secondary_uid)
      OR
      (continuity_incident_id IS NOT NULL AND continuity_facility_id IS NOT NULL AND continuity_packet_id IS NOT NULL AND continuity_paper_item_row_id IS NOT NULL AND continuity_temporary_identity_id IS NOT NULL AND requester_role IS NOT NULL AND continuity_disposition IN ('proposed', 'approved', 'conflict', 'executed') AND secondary_uid IS NULL)
    );

CREATE TABLE public.clinical_continuity_patient_merge_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID NOT NULL,
  merge_request_id INTEGER NOT NULL,
  temporary_identity_id UUID NOT NULL,
  decision VARCHAR(24) NOT NULL,
  actor_uid UUID NOT NULL,
  actor_role VARCHAR(80) NOT NULL,
  source_patient_uid UUID,
  target_patient_uid UUID NOT NULL,
  conflict_hash CHAR(64),
  decided_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cc_patient_merge_decision_incident
    FOREIGN KEY (tenant_id, facility_id, incident_id)
    REFERENCES public.clinical_continuity_incidents(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_patient_merge_decision_request
    FOREIGN KEY (merge_request_id) REFERENCES public.patient_merge_requests(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_patient_merge_decision_temp
    FOREIGN KEY (tenant_id, facility_id, incident_id, temporary_identity_id)
    REFERENCES public.clinical_continuity_temporary_identities(tenant_id, facility_id, incident_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_patient_merge_decision_actor
    FOREIGN KEY (tenant_id, actor_uid) REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_patient_merge_decision
    CHECK (decision IN ('proposed', 'approved', 'conflict', 'executed', 'rejected')),
  CONSTRAINT chk_cc_patient_merge_decision_hash
    CHECK (conflict_hash IS NULL OR conflict_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_cc_incidents_workbench
  ON public.clinical_continuity_incidents
    (tenant_id, facility_id, lifecycle_state, updated_at DESC);
CREATE INDEX idx_cc_paper_items_workbench
  ON public.clinical_continuity_paper_items
    (tenant_id, facility_id, incident_id, reconciliation_disposition, updated_at DESC);
CREATE INDEX idx_cc_reconciliation_workbench
  ON public.clinical_continuity_reconciliation_items
    (tenant_id, facility_id, incident_id, queue_type, disposition, safety_critical DESC, updated_at DESC);

-- Paper back-entry must carry a live facility context. Electronic C5.1 replay
-- keeps its already-landed tenant-only path unchanged.
CREATE POLICY cc_replay_receipt_paper_facility
  ON public.clinical_continuity_replay_receipts
  AS RESTRICTIVE
  USING (
    source_kind = 'electronic_queue'
    OR (
      current_setting('app.current_facility_id', true) ~ '^[1-9][0-9]*$'
      AND facility_id = current_setting('app.current_facility_id', true)::integer
    )
  )
  WITH CHECK (
    source_kind = 'electronic_queue'
    OR (
      current_setting('app.current_facility_id', true) ~ '^[1-9][0-9]*$'
      AND facility_id = current_setting('app.current_facility_id', true)::integer
    )
  );

DO $rls$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'clinical_continuity_incident_packets',
    'clinical_continuity_incidents',
    'clinical_continuity_paper_ranges',
    'clinical_continuity_incident_declarations',
    'clinical_continuity_incident_aliases',
    'clinical_continuity_paper_range_decisions',
    'clinical_continuity_temporary_identities',
    'clinical_continuity_paper_items',
    'clinical_continuity_retrospective_facts',
    'clinical_continuity_reconciliation_items',
    'clinical_continuity_reconciliation_config',
    'clinical_continuity_reconciliation_decisions',
    'clinical_continuity_device_journal_offsets',
    'clinical_continuity_incident_interfaces',
    'clinical_continuity_incident_attestations',
    'clinical_continuity_patient_merge_decisions'
  ]
  LOOP
    EXECUTE FORMAT('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE FORMAT('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE FORMAT(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE '
      'USING (tenant_id = public.app_current_tenant_id_uuid()) '
      'WITH CHECK (tenant_id = public.app_current_tenant_id_uuid())',
      relation_name
    );
    EXECUTE FORMAT(
      'CREATE POLICY cc_explicit_tenant_facility ON public.%I AS RESTRICTIVE '
      'USING ('
      ' current_setting(''app.current_tenant_id'', true) IS NOT NULL'
      ' AND current_setting(''app.current_tenant_id'', true) NOT IN ('''', ''bypass'')'
      ' AND tenant_id = public.app_current_tenant_id_uuid()'
      ' AND current_setting(''app.current_facility_id'', true) ~ ''^[1-9][0-9]*$'''
      ' AND facility_id = current_setting(''app.current_facility_id'', true)::integer'
      ') WITH CHECK ('
      ' current_setting(''app.current_tenant_id'', true) IS NOT NULL'
      ' AND current_setting(''app.current_tenant_id'', true) NOT IN ('''', ''bypass'')'
      ' AND tenant_id = public.app_current_tenant_id_uuid()'
      ' AND current_setting(''app.current_facility_id'', true) ~ ''^[1-9][0-9]*$'''
      ' AND facility_id = current_setting(''app.current_facility_id'', true)::integer'
      ')',
      relation_name
    );
  END LOOP;
END
$rls$;

CREATE FUNCTION public.assert_cc_reconciliation_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_cc_reconciliation_append_only',
    MESSAGE = 'clinical continuity reconciliation evidence is append-only';
END;
$$;

CREATE FUNCTION public.assert_cc_reconciliation_projection_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_reconciliation_projection_immutable',
      MESSAGE = 'clinical continuity projections cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.version IS DISTINCT FROM OLD.version + 1
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_reconciliation_projection_immutable',
      MESSAGE = 'clinical continuity projection requires immutable scope and a one-step compare-and-swap';
  END IF;
  IF TG_TABLE_NAME = 'clinical_continuity_paper_items'
     AND (
       to_jsonb(NEW) -> 'incident_id' IS DISTINCT FROM to_jsonb(OLD) -> 'incident_id'
       OR to_jsonb(NEW) -> 'packet_id' IS DISTINCT FROM to_jsonb(OLD) -> 'packet_id'
       OR to_jsonb(NEW) -> 'paper_range_id' IS DISTINCT FROM to_jsonb(OLD) -> 'paper_range_id'
       OR to_jsonb(NEW) -> 'paper_item_id' IS DISTINCT FROM to_jsonb(OLD) -> 'paper_item_id'
       OR to_jsonb(NEW) -> 'paper_item_number' IS DISTINCT FROM to_jsonb(OLD) -> 'paper_item_number'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_paper_item_identity_immutable',
      MESSAGE = 'paper item external identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.assert_cc_incident_packet_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD.status <> 'unused'
     OR NEW.status NOT IN ('used', 'revoked', 'expired')
     OR (to_jsonb(NEW) - ARRAY['status', 'used_at', 'used_by', 'revoked_at', 'revocation_reason'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status', 'used_at', 'used_by', 'revoked_at', 'revocation_reason']) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_incident_packet_immutable',
      MESSAGE = 'signed incident packets permit one terminal status transition only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cc_incident_packet_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_incident_packets
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_incident_packet_mutation();

CREATE TRIGGER cc_incident_projection_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_incidents
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_reconciliation_projection_mutation();
CREATE TRIGGER cc_paper_range_projection_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_paper_ranges
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_reconciliation_projection_mutation();
CREATE TRIGGER cc_temp_identity_projection_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_temporary_identities
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_reconciliation_projection_mutation();
CREATE TRIGGER cc_paper_item_projection_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_paper_items
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_reconciliation_projection_mutation();
CREATE TRIGGER cc_reconciliation_item_projection_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_reconciliation_items
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_reconciliation_projection_mutation();
CREATE TRIGGER cc_reconciliation_config_projection_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_reconciliation_config
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_reconciliation_projection_mutation();
CREATE TRIGGER cc_device_offset_projection_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_device_journal_offsets
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_reconciliation_projection_mutation();
CREATE TRIGGER cc_incident_interface_projection_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_incident_interfaces
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_reconciliation_projection_mutation();

DO $append_only_triggers$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'clinical_continuity_incident_declarations',
    'clinical_continuity_incident_aliases',
    'clinical_continuity_paper_range_decisions',
    'clinical_continuity_retrospective_facts',
    'clinical_continuity_reconciliation_decisions',
    'clinical_continuity_incident_attestations',
    'clinical_continuity_patient_merge_decisions'
  ]
  LOOP
    EXECUTE FORMAT(
      'CREATE TRIGGER cc_append_only_guard BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.assert_cc_reconciliation_append_only()',
      relation_name
    );
  END LOOP;
END
$append_only_triggers$;

CREATE FUNCTION public.assert_cc_incident_alias_acyclic()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cycle_found BOOLEAN;
BEGIN
  IF NEW.disposition <> 'active' THEN
    RETURN NEW;
  END IF;
  WITH RECURSIVE alias_path(incident_id) AS (
    SELECT NEW.canonical_incident_id
    UNION ALL
    SELECT edge.canonical_incident_id
      FROM public.clinical_continuity_incident_aliases AS edge
      JOIN alias_path ON edge.observed_incident_id = alias_path.incident_id
     WHERE edge.tenant_id = NEW.tenant_id
       AND edge.facility_id = NEW.facility_id
       AND edge.disposition = 'active'
  )
  SELECT EXISTS (
    SELECT 1 FROM alias_path WHERE incident_id = NEW.observed_incident_id
  ) INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_incident_alias_acyclic',
      MESSAGE = 'clinical continuity incident aliases cannot form a cycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cc_incident_alias_acyclic
BEFORE INSERT ON public.clinical_continuity_incident_aliases
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_incident_alias_acyclic();

CREATE FUNCTION public.assert_cc_closure_actor_separation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.clinical_continuity_incident_attestations AS existing
     WHERE existing.tenant_id = NEW.tenant_id
       AND existing.facility_id = NEW.facility_id
       AND existing.incident_id = NEW.incident_id
       AND existing.incident_version = NEW.incident_version
       AND existing.attestation_kind <> NEW.attestation_kind
       AND existing.actor_uid = NEW.actor_uid
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_closure_actor_separation',
      MESSAGE = 'incident commander and clinical safety lead must be distinct';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cc_closure_actor_separation
BEFORE INSERT ON public.clinical_continuity_incident_attestations
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_closure_actor_separation();

CREATE FUNCTION public.clinical_continuity_paper_receipt_claim(
  p_tenant_id UUID,
  p_facility_id INTEGER,
  p_receipt JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  candidate public.clinical_continuity_replay_receipts%ROWTYPE;
  inserted_count INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR current_setting('app.current_facility_id', true) !~ '^[1-9][0-9]*$'
     OR current_setting('app.current_facility_id', true)::integer IS DISTINCT FROM p_facility_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'explicit tenant and facility context required';
  END IF;
  candidate := pg_catalog.jsonb_populate_record(
    NULL::public.clinical_continuity_replay_receipts,
    p_receipt
  );
  IF candidate.tenant_id IS DISTINCT FROM p_tenant_id
     OR candidate.facility_id IS DISTINCT FROM p_facility_id
     OR candidate.source_kind IS DISTINCT FROM 'paper_back_entry'
     OR candidate.incident_id IS NULL
     OR candidate.paper_item_id IS NULL
     OR candidate.action_id NOT IN (
       'mar.administration.backfill',
       'lab.specimen_collection.backfill',
       'blood.transfusion_verification.backfill'
     )
     OR candidate.human_review_required IS DISTINCT FROM FALSE
     OR candidate.expires_at IS NULL
     OR candidate.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_paper_receipt_claim_eligibility',
      MESSAGE = 'paper receipt claim is not eligible';
  END IF;
  candidate.received_at := clock_timestamp();
  candidate.recorded_at := NULL;
  candidate.disposition := 'claimed';
  candidate.outcome_code := NULL;
  candidate.retention_policy_id := 'C-D10-2026-07-31';
  candidate.detailed_evidence_until := candidate.received_at + INTERVAL '365 days';
  candidate.replay_eligibility_until := candidate.expires_at;
  candidate.tombstone_until := candidate.received_at + INTERVAL '2555 days';
  candidate.claim_txid := txid_current();

  INSERT INTO public.clinical_continuity_replay_receipts
  SELECT candidate.*
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count = 1;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_reconciliation_append_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_reconciliation_projection_mutation() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_incident_packet_mutation() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_incident_alias_acyclic() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_closure_actor_separation() FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.clinical_continuity_paper_receipt_claim(UUID, INTEGER, JSONB)
  FROM PUBLIC;

DO $runtime_privileges$
DECLARE
  runtime_role TEXT;
  relation_name TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;
    FOREACH relation_name IN ARRAY ARRAY[
      'clinical_continuity_incident_packets',
      'clinical_continuity_incidents',
      'clinical_continuity_paper_ranges',
      'clinical_continuity_temporary_identities',
      'clinical_continuity_paper_items',
      'clinical_continuity_reconciliation_items',
      'clinical_continuity_reconciliation_config',
      'clinical_continuity_device_journal_offsets',
      'clinical_continuity_incident_interfaces'
    ]
    LOOP
      EXECUTE FORMAT('REVOKE DELETE, TRUNCATE ON public.%I FROM %I', relation_name, runtime_role);
      EXECUTE FORMAT('GRANT SELECT, INSERT, UPDATE ON public.%I TO %I', relation_name, runtime_role);
    END LOOP;
    FOREACH relation_name IN ARRAY ARRAY[
      'clinical_continuity_incident_declarations',
      'clinical_continuity_incident_aliases',
      'clinical_continuity_paper_range_decisions',
      'clinical_continuity_retrospective_facts',
      'clinical_continuity_reconciliation_decisions',
      'clinical_continuity_incident_attestations',
      'clinical_continuity_patient_merge_decisions'
    ]
    LOOP
      EXECUTE FORMAT('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM %I', relation_name, runtime_role);
      EXECUTE FORMAT('GRANT SELECT, INSERT ON public.%I TO %I', relation_name, runtime_role);
    END LOOP;
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_paper_receipt_claim(UUID, INTEGER, JSONB) TO %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMENT ON TABLE public.clinical_continuity_incident_declarations IS
  'C-D10 immutable incident evidence; retain with incident record through the statutory clinical-record period.';
COMMENT ON TABLE public.clinical_continuity_incident_aliases IS
  'C-D10 append-only incident alias history; never compact by rewriting edges.';
COMMENT ON TABLE public.clinical_continuity_paper_items IS
  'C-D10 paper inventory and clinical provenance; receipt detail remains 365 days and tuple tombstone 2555 days minimum.';
COMMENT ON TABLE public.clinical_continuity_retrospective_facts IS
  'Historical clinical facts with three-clock provenance; retain as part of the clinical record.';
COMMENT ON TABLE public.clinical_continuity_reconciliation_decisions IS
  'Append-only reconciliation decisions; retain with linked clinical audit and task evidence.';

COMMIT;
