-- 624_clinical_continuity_held_message_release.sql
-- C5.2 owner-directed held-message release executor.
--
-- Release is a receipt-backed permission transition only. It never performs a
-- network send, records transport/acknowledgement success, advances a cursor,
-- redrives a payload, or emits retrospective clinical/operational effects.

BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE UNIQUE INDEX ux_hl7_outbound_messages_tenant_id_held_release
  ON public.hl7_outbound_messages (tenant_id, id);

ALTER TABLE public.clinical_continuity_replay_receipts
  ALTER COLUMN patient_id DROP NOT NULL,
  ALTER COLUMN patient_uid DROP NOT NULL,
  ADD COLUMN reconciliation_item_id UUID,
  ADD COLUMN incident_interface_id UUID,
  ADD COLUMN subject_kind VARCHAR(48),
  ADD COLUMN subject_key VARCHAR(255),
  ADD COLUMN interface_family VARCHAR(8),
  ADD COLUMN hl7_outbound_message_id INTEGER,
  ADD COLUMN interop_message_id INTEGER,
  ADD COLUMN nhcx_message_id BIGINT,
  ADD COLUMN source_state_fingerprint CHAR(64),
  DROP CONSTRAINT chk_cc_replay_receipt_paper_source,
  DROP CONSTRAINT chk_cc_replay_receipt_action_shape,
  ADD CONSTRAINT fk_cc_replay_receipt_reconciliation_item
    FOREIGN KEY (tenant_id, facility_id, reconciliation_item_id)
    REFERENCES public.clinical_continuity_reconciliation_items(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_receipt_incident_interface
    FOREIGN KEY (tenant_id, facility_id, incident_interface_id)
    REFERENCES public.clinical_continuity_incident_interfaces(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_receipt_hl7_message
    FOREIGN KEY (tenant_id, hl7_outbound_message_id)
    REFERENCES public.hl7_outbound_messages(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_receipt_interop_message
    FOREIGN KEY (tenant_id, interop_message_id)
    REFERENCES public.interop_messages(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_receipt_nhcx_message
    FOREIGN KEY (tenant_id, nhcx_message_id)
    REFERENCES public.nhcx_messages(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT chk_cc_replay_receipt_source_shape
    CHECK (
      (
        source_kind = 'electronic_queue'
        AND patient_id IS NOT NULL AND patient_uid IS NOT NULL
        AND incident_id IS NULL AND paper_item_id IS NULL
        AND reconciliation_item_id IS NULL AND incident_interface_id IS NULL
        AND subject_kind IS NULL AND subject_key IS NULL AND interface_family IS NULL
        AND hl7_outbound_message_id IS NULL AND interop_message_id IS NULL
        AND nhcx_message_id IS NULL AND source_state_fingerprint IS NULL
      )
      OR
      (
        source_kind = 'paper_back_entry'
        AND patient_id IS NOT NULL AND patient_uid IS NOT NULL
        AND incident_id IS NOT NULL AND paper_item_id IS NOT NULL
        AND reconciliation_item_id IS NULL AND incident_interface_id IS NULL
        AND subject_kind IS NULL AND subject_key IS NULL AND interface_family IS NULL
        AND hl7_outbound_message_id IS NULL AND interop_message_id IS NULL
        AND nhcx_message_id IS NULL AND source_state_fingerprint IS NULL
      )
      OR
      (
        source_kind = 'held_message_release'
        AND patient_id IS NULL AND patient_uid IS NULL
        AND appointment_id IS NULL AND encounter_id IS NULL AND admission_id IS NULL
        AND incident_id IS NOT NULL AND paper_item_id IS NULL
        AND reconciliation_item_id IS NOT NULL AND incident_interface_id IS NOT NULL
        AND subject_kind = 'interface_held_message'
        AND subject_key IS NOT NULL AND BTRIM(subject_key) <> ''
        AND interface_family IN ('I04', 'I05', 'I19')
        AND source_state_fingerprint ~ '^[0-9a-f]{64}$'
        AND NUM_NONNULLS(
          hl7_outbound_message_id, interop_message_id, nhcx_message_id
        ) = 1
        AND (
          (interface_family = 'I04' AND hl7_outbound_message_id IS NOT NULL)
          OR (interface_family = 'I05' AND interop_message_id IS NOT NULL)
          OR (interface_family = 'I19' AND nhcx_message_id IS NOT NULL)
        )
      )
    ),
  ADD CONSTRAINT chk_cc_replay_receipt_action_shape_v2
    CHECK (
      (
        source_kind = 'electronic_queue'
        AND action_id IN ('emr.nursing_note.draft.store', 'emr.op_note.draft.store')
        AND binding_id = 'emr.note_draft.store/v1'
        AND http_method = 'PUT'
        AND encounter_id IS NULL AND admission_id IS NULL
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
      )
      OR
      (
        source_kind = 'held_message_release'
        AND action_id = 'clinical_continuity.interface_held_message.release'
        AND binding_id = 'clinical_continuity.interface_held_message.release/v1'
        AND http_method = 'POST'
        AND schema_id = 'clinical-continuity-held-message-release'
        AND schema_version = 1
        AND action_version = 1
      )
    );

CREATE UNIQUE INDEX uq_cc_replay_receipt_held_subject
  ON public.clinical_continuity_replay_receipts
    (tenant_id, interface_family, subject_key)
  WHERE source_kind = 'held_message_release';

CREATE UNIQUE INDEX uq_cc_replay_receipt_held_hl7
  ON public.clinical_continuity_replay_receipts
    (tenant_id, hl7_outbound_message_id)
  WHERE source_kind = 'held_message_release' AND interface_family = 'I04';

CREATE UNIQUE INDEX uq_cc_replay_receipt_held_interop
  ON public.clinical_continuity_replay_receipts
    (tenant_id, interop_message_id)
  WHERE source_kind = 'held_message_release' AND interface_family = 'I05';

CREATE UNIQUE INDEX uq_cc_replay_receipt_held_nhcx
  ON public.clinical_continuity_replay_receipts
    (tenant_id, nhcx_message_id)
  WHERE source_kind = 'held_message_release' AND interface_family = 'I19';

ALTER TABLE public.clinical_continuity_reconciliation_items
  ADD COLUMN incident_interface_id UUID,
  ADD COLUMN interface_item_kind VARCHAR(48),
  ADD COLUMN interface_family VARCHAR(8),
  ADD COLUMN hl7_outbound_message_id INTEGER,
  ADD COLUMN interop_message_id INTEGER,
  ADD COLUMN nhcx_message_id BIGINT,
  ADD COLUMN hold_reason_code VARCHAR(120),
  ADD COLUMN hold_safety_class VARCHAR(32),
  ADD COLUMN source_state_snapshot JSONB,
  ADD COLUMN source_state_fingerprint CHAR(64),
  ADD COLUMN release_receipt_client_event_id UUID,
  ADD COLUMN release_effect_client_event_id UUID,
  ADD CONSTRAINT fk_cc_reconciliation_incident_interface
    FOREIGN KEY (tenant_id, facility_id, incident_interface_id)
    REFERENCES public.clinical_continuity_incident_interfaces(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_reconciliation_hl7_message
    FOREIGN KEY (tenant_id, hl7_outbound_message_id)
    REFERENCES public.hl7_outbound_messages(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_reconciliation_interop_message
    FOREIGN KEY (tenant_id, interop_message_id)
    REFERENCES public.interop_messages(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_reconciliation_nhcx_message
    FOREIGN KEY (tenant_id, nhcx_message_id)
    REFERENCES public.nhcx_messages(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_reconciliation_release_receipt
    FOREIGN KEY (tenant_id, release_receipt_client_event_id)
    REFERENCES public.clinical_continuity_replay_receipts(tenant_id, client_event_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT chk_cc_reconciliation_held_shape
    CHECK (
      (
        interface_item_kind IS NULL
        AND incident_interface_id IS NULL AND interface_family IS NULL
        AND hl7_outbound_message_id IS NULL AND interop_message_id IS NULL
        AND nhcx_message_id IS NULL AND hold_reason_code IS NULL
        AND hold_safety_class IS NULL AND source_state_snapshot IS NULL
        AND source_state_fingerprint IS NULL
        AND release_receipt_client_event_id IS NULL
        AND release_effect_client_event_id IS NULL
      )
      OR
      (
        interface_item_kind = 'held_message_release'
        AND queue_type = 'interface'
        AND incident_interface_id IS NOT NULL
        AND interface_family IN ('I04', 'I05', 'I19')
        AND NUM_NONNULLS(
          hl7_outbound_message_id, interop_message_id, nhcx_message_id
        ) = 1
        AND (
          (interface_family = 'I04' AND hl7_outbound_message_id IS NOT NULL)
          OR (interface_family = 'I05' AND interop_message_id IS NOT NULL)
          OR (interface_family = 'I19' AND nhcx_message_id IS NOT NULL)
        )
        AND hold_reason_code IS NOT NULL AND BTRIM(hold_reason_code) <> ''
        AND hold_safety_class IN (
          'routine_operational', 'safety_critical', 'unclassified'
        )
        AND safety_critical = (hold_safety_class = 'safety_critical')
        AND source_state_snapshot IS NOT NULL
        AND source_state_fingerprint ~ '^[0-9a-f]{64}$'
        AND (
          (release_receipt_client_event_id IS NULL AND release_effect_client_event_id IS NULL)
          OR
          (
            disposition = 'resolved'
            AND release_receipt_client_event_id IS NOT NULL
            AND release_effect_client_event_id = release_receipt_client_event_id
          )
        )
      )
    );

CREATE UNIQUE INDEX uq_cc_reconciliation_held_hl7
  ON public.clinical_continuity_reconciliation_items
    (tenant_id, hl7_outbound_message_id)
  WHERE interface_item_kind = 'held_message_release' AND interface_family = 'I04';

CREATE UNIQUE INDEX uq_cc_reconciliation_held_interop
  ON public.clinical_continuity_reconciliation_items
    (tenant_id, interop_message_id)
  WHERE interface_item_kind = 'held_message_release' AND interface_family = 'I05';

CREATE UNIQUE INDEX uq_cc_reconciliation_held_nhcx
  ON public.clinical_continuity_reconciliation_items
    (tenant_id, nhcx_message_id)
  WHERE interface_item_kind = 'held_message_release' AND interface_family = 'I19';

ALTER TABLE public.clinical_continuity_reconciliation_decisions
  ADD COLUMN command_fingerprint CHAR(64),
  ADD COLUMN source_state_fingerprint CHAR(64),
  ADD COLUMN release_reason_code VARCHAR(64),
  ADD COLUMN release_reason_detail VARCHAR(500),
  ADD COLUMN hold_safety_class VARCHAR(32),
  ADD COLUMN intended_releaser_uid UUID,
  DROP CONSTRAINT chk_cc_reconciliation_decision,
  ADD CONSTRAINT fk_cc_reconciliation_decision_releaser
    FOREIGN KEY (tenant_id, intended_releaser_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT chk_cc_reconciliation_decision_v2
    CHECK (
      (
        decision IN ('accept', 'exclude', 'assign', 'handoff', 'reopen', 'supersede')
        AND command_fingerprint IS NULL AND source_state_fingerprint IS NULL
        AND release_reason_code IS NULL AND release_reason_detail IS NULL
        AND hold_safety_class IS NULL AND intended_releaser_uid IS NULL
      )
      OR
      (
        decision IN ('release_attestation', 'held_message_released')
        AND command_fingerprint ~ '^[0-9a-f]{64}$'
        AND source_state_fingerprint ~ '^[0-9a-f]{64}$'
        AND release_reason_code IN (
          'downstream_readiness_confirmed',
          'transport_configuration_corrected',
          'duplicate_delivery_risk_reviewed',
          'acknowledgement_uncertainty_reviewed',
          'owner_recovery_evidence_reconciled'
        )
        AND CHAR_LENGTH(BTRIM(release_reason_detail)) BETWEEN 10 AND 500
        AND release_reason_detail !~ '[[:cntrl:]]'
        AND hold_safety_class IN ('routine_operational', 'safety_critical')
        AND intended_releaser_uid IS NOT NULL
        AND (
          decision = 'held_message_released'
          OR (decision = 'release_attestation' AND hold_safety_class = 'safety_critical')
        )
      )
    );

CREATE UNIQUE INDEX uq_cc_reconciliation_release_attestation_fingerprint
  ON public.clinical_continuity_reconciliation_decisions
    (tenant_id, facility_id, reconciliation_item_id, command_fingerprint)
  WHERE decision = 'release_attestation';

CREATE UNIQUE INDEX ux_cc_reconciliation_decisions_tenant_id
  ON public.clinical_continuity_reconciliation_decisions (tenant_id, id);

ALTER TABLE public.clinical_continuity_replay_effect_evidence
  ADD COLUMN facility_id INTEGER,
  ADD COLUMN reconciliation_item_id UUID,
  ADD COLUMN release_attestation_decision_id UUID,
  ADD COLUMN interface_family VARCHAR(8),
  ADD COLUMN hl7_outbound_message_id INTEGER,
  ADD COLUMN interop_message_id INTEGER,
  ADD COLUMN nhcx_message_id BIGINT,
  ADD COLUMN original_releaser_uid UUID,
  ADD COLUMN original_releaser_role VARCHAR(64),
  ADD COLUMN release_reason_code VARCHAR(64),
  ADD COLUMN release_reason_detail VARCHAR(500),
  ADD COLUMN prior_authority_state JSONB,
  ADD COLUMN prior_authority_state_hash CHAR(64),
  ADD COLUMN next_authority_state JSONB,
  ADD COLUMN next_authority_state_hash CHAR(64),
  ADD COLUMN source_state_fingerprint CHAR(64),
  ADD COLUMN command_fingerprint CHAR(64),
  ADD COLUMN released_at TIMESTAMPTZ(6),
  ADD COLUMN release_audit_event_id UUID,
  ADD COLUMN network_send_performed BOOLEAN,
  DROP CONSTRAINT chk_cc_replay_effect_shape,
  ADD CONSTRAINT fk_cc_replay_effect_reconciliation_item
    FOREIGN KEY (tenant_id, facility_id, reconciliation_item_id)
    REFERENCES public.clinical_continuity_reconciliation_items(tenant_id, facility_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_effect_attestation
    FOREIGN KEY (tenant_id, release_attestation_decision_id)
    REFERENCES public.clinical_continuity_reconciliation_decisions(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_effect_releaser
    FOREIGN KEY (tenant_id, original_releaser_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_effect_release_audit
    FOREIGN KEY (tenant_id, release_audit_event_id)
    REFERENCES public.clinical_audit_events(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_effect_hl7_message
    FOREIGN KEY (tenant_id, hl7_outbound_message_id)
    REFERENCES public.hl7_outbound_messages(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_effect_interop_message
    FOREIGN KEY (tenant_id, interop_message_id)
    REFERENCES public.interop_messages(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT fk_cc_replay_effect_nhcx_message
    FOREIGN KEY (tenant_id, nhcx_message_id)
    REFERENCES public.nhcx_messages(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT chk_cc_replay_effect_shape_v2
    CHECK (
      (
        outcome_code = 'draft_stored'
        AND note_draft_id IS NOT NULL AND draft_revision > 0
        AND draft_updated_at IS NOT NULL
        AND retrospective_fact_id IS NULL AND paper_item_row_id IS NULL
        AND clinical_timeline_event_id IS NULL AND clinical_audit_event_id IS NULL
        AND workflow_sla_instance_id IS NULL AND notification_outbox_id IS NULL
        AND event_outbox_id IS NULL AND retrospective_event_outbox_id IS NULL
        AND effect_disposition IS NULL
        AND facility_id IS NULL AND reconciliation_item_id IS NULL
        AND interface_family IS NULL
        AND network_send_performed IS NULL
      )
      OR
      (
        outcome_code IN ('paper_fact_recorded', 'paper_fact_projection_reconciled')
        AND note_draft_id IS NULL AND draft_revision IS NULL
        AND draft_updated_at IS NULL
        AND retrospective_fact_id IS NOT NULL AND paper_item_row_id IS NOT NULL
        AND fact_resource_type IS NOT NULL AND fact_resource_id IS NOT NULL
        AND occurred_at IS NOT NULL AND recorded_at IS NOT NULL
        AND occurred_at <= recorded_at
        AND clinical_timeline_event_id IS NOT NULL
        AND clinical_audit_event_id IS NOT NULL
        AND event_outbox_id IS NULL AND retrospective_event_outbox_id IS NOT NULL
        AND workflow_sla_instance_id IS NULL AND notification_outbox_id IS NULL
        AND effect_disposition = 'late_pending_only'
        AND facility_id IS NULL AND reconciliation_item_id IS NULL
        AND interface_family IS NULL
        AND network_send_performed IS NULL
      )
      OR
      (
        outcome_code = 'held_message_send_authority_rearmed'
        AND note_draft_id IS NULL AND draft_revision IS NULL
        AND draft_updated_at IS NULL AND retrospective_fact_id IS NULL
        AND paper_item_row_id IS NULL AND fact_resource_type IS NULL
        AND fact_resource_id IS NULL AND occurred_at IS NULL
        AND recorded_at IS NULL AND reviewed_at IS NULL AND decided_at IS NULL
        AND effect_disposition IS NULL
        AND clinical_timeline_event_id IS NULL AND clinical_audit_event_id IS NULL
        AND workflow_sla_instance_id IS NULL AND notification_outbox_id IS NULL
        AND event_outbox_id IS NULL AND retrospective_event_outbox_id IS NULL
        AND facility_id IS NOT NULL AND reconciliation_item_id IS NOT NULL
        AND interface_family IN ('I04', 'I05', 'I19')
        AND NUM_NONNULLS(
          hl7_outbound_message_id, interop_message_id, nhcx_message_id
        ) = 1
        AND (
          (interface_family = 'I04' AND hl7_outbound_message_id IS NOT NULL)
          OR (interface_family = 'I05' AND interop_message_id IS NOT NULL)
          OR (interface_family = 'I19' AND nhcx_message_id IS NOT NULL)
        )
        AND original_releaser_uid IS NOT NULL
        AND original_releaser_role IS NOT NULL
        AND release_reason_code IN (
          'downstream_readiness_confirmed',
          'transport_configuration_corrected',
          'duplicate_delivery_risk_reviewed',
          'acknowledgement_uncertainty_reviewed',
          'owner_recovery_evidence_reconciled'
        )
        AND CHAR_LENGTH(BTRIM(release_reason_detail)) BETWEEN 10 AND 500
        AND release_reason_detail !~ '[[:cntrl:]]'
        AND prior_authority_state IS NOT NULL
        AND prior_authority_state_hash ~ '^[0-9a-f]{64}$'
        AND next_authority_state IS NOT NULL
        AND next_authority_state_hash ~ '^[0-9a-f]{64}$'
        AND source_state_fingerprint ~ '^[0-9a-f]{64}$'
        AND command_fingerprint ~ '^[0-9a-f]{64}$'
        AND released_at IS NOT NULL AND release_audit_event_id IS NOT NULL
        AND network_send_performed IS FALSE
      )
    );

CREATE UNIQUE INDEX uq_cc_replay_effect_held_hl7
  ON public.clinical_continuity_replay_effect_evidence
    (tenant_id, hl7_outbound_message_id)
  WHERE outcome_code = 'held_message_send_authority_rearmed';

CREATE UNIQUE INDEX uq_cc_replay_effect_held_interop
  ON public.clinical_continuity_replay_effect_evidence
    (tenant_id, interop_message_id)
  WHERE outcome_code = 'held_message_send_authority_rearmed';

CREATE UNIQUE INDEX uq_cc_replay_effect_held_nhcx
  ON public.clinical_continuity_replay_effect_evidence
    (tenant_id, nhcx_message_id)
  WHERE outcome_code = 'held_message_send_authority_rearmed';

ALTER TABLE public.clinical_continuity_reconciliation_items
  ADD CONSTRAINT fk_cc_reconciliation_release_effect
    FOREIGN KEY (tenant_id, release_effect_client_event_id)
    REFERENCES public.clinical_continuity_replay_effect_evidence(tenant_id, client_event_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE public.hl7_outbound_messages
  ADD COLUMN owner_release_client_event_id UUID,
  ADD CONSTRAINT fk_hl7_outbound_owner_release_effect
    FOREIGN KEY (tenant_id, owner_release_client_event_id)
    REFERENCES public.clinical_continuity_replay_effect_evidence(tenant_id, client_event_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE public.interop_messages
  ADD COLUMN owner_release_client_event_id UUID,
  ADD CONSTRAINT fk_interop_owner_release_effect
    FOREIGN KEY (tenant_id, owner_release_client_event_id)
    REFERENCES public.clinical_continuity_replay_effect_evidence(tenant_id, client_event_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE public.nhcx_messages
  ADD COLUMN owner_release_client_event_id UUID,
  ADD CONSTRAINT fk_nhcx_owner_release_effect
    FOREIGN KEY (tenant_id, owner_release_client_event_id)
    REFERENCES public.clinical_continuity_replay_effect_evidence(tenant_id, client_event_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE public.nhcx_messages
  DROP CONSTRAINT chk_nhcx_messages_i19_recovery_shape,
  ADD CONSTRAINT chk_nhcx_messages_i19_recovery_shape_v2
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND recovery_owner_uid IS NULL
        AND recovery_owner_reason IS NULL
        AND recovery_disposition IS NULL
        AND recovery_claimed_at IS NULL
        AND recovery_prior_status IS NULL
        AND recovery_evidence IS NULL
        AND source_partition IS NULL
        AND source_position IS NULL
        AND source_token IS NULL
        AND predecessor_token IS NULL
        AND duplicate_key IS NULL
        AND owner_release_client_event_id IS NULL
      )
      OR (
        direction = 'outbound'
        AND cycle <> 'payment_notice'
        AND recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I19'
        AND recovery_owner_uid IS NOT NULL
        AND recovery_owner_reason IS NOT NULL
        AND length(btrim(recovery_owner_reason)) > 0
        AND recovery_disposition IN (
          'investigate',
          'manual_redrive_requested',
          'cancel_requested'
        )
        AND recovery_claimed_at IS NOT NULL
        AND recovery_prior_status IN ('sent', 'failed', 'dead', 'rejected')
        AND recovery_evidence IS NOT NULL
        AND jsonb_typeof(recovery_evidence) = 'object'
        AND hcx_api_call_id IS NOT NULL
        AND length(btrim(hcx_api_call_id)) > 0
        AND payload_hash ~ '^[0-9a-f]{64}$'
        AND source_partition = 'nhcx:' || environment || ':outbound:' || endpoint
        AND source_position = id
        AND source_token IS NOT NULL
        AND length(btrim(source_token)) > 0
        AND predecessor_token IS NOT NULL
        AND length(btrim(predecessor_token)) > 0
        AND duplicate_key IS NOT NULL
        AND duplicate_key = 'i19:outbound:' || hcx_api_call_id
        AND payload_ciphertext IS NOT NULL
        AND length(payload_ciphertext) > 0
        AND (
          (
            owner_release_client_event_id IS NULL
            AND status = 'recovery_pending'
            AND next_retry_at IS NULL
          )
          OR (
            owner_release_client_event_id IS NOT NULL
            AND recovery_disposition = 'manual_redrive_requested'
            AND status IN ('pending', 'sent', 'accepted', 'failed', 'dead', 'rejected')
          )
        )
      )
    );

CREATE FUNCTION public.cc_held_release_table_owner_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  relation_owner NAME;
BEGIN
  IF TG_TABLE_NAME = 'clinical_continuity_reconciliation_decisions' THEN
    IF NEW.decision NOT IN ('release_attestation', 'held_message_released') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'clinical_continuity_replay_effect_evidence' THEN
    IF NEW.outcome_code <> 'held_message_send_authority_rearmed' THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO relation_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = TG_RELID;
  IF current_user IS DISTINCT FROM relation_owner THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'held-message release evidence requires the dedicated command';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cc_held_release_decision_insert_guard
BEFORE INSERT ON public.clinical_continuity_reconciliation_decisions
FOR EACH ROW EXECUTE FUNCTION public.cc_held_release_table_owner_only();

CREATE TRIGGER cc_held_release_effect_insert_guard
BEFORE INSERT ON public.clinical_continuity_replay_effect_evidence
FOR EACH ROW EXECUTE FUNCTION public.cc_held_release_table_owner_only();

CREATE FUNCTION public.assert_cc_held_release_item_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  relation_owner NAME;
BEGIN
  IF TG_OP = 'DELETE' OR OLD.interface_item_kind <> 'held_message_release' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF NEW.incident_interface_id IS DISTINCT FROM OLD.incident_interface_id
     OR NEW.interface_item_kind IS DISTINCT FROM OLD.interface_item_kind
     OR NEW.interface_family IS DISTINCT FROM OLD.interface_family
     OR NEW.hl7_outbound_message_id IS DISTINCT FROM OLD.hl7_outbound_message_id
     OR NEW.interop_message_id IS DISTINCT FROM OLD.interop_message_id
     OR NEW.nhcx_message_id IS DISTINCT FROM OLD.nhcx_message_id
     OR NEW.hold_reason_code IS DISTINCT FROM OLD.hold_reason_code
     OR NEW.hold_safety_class IS DISTINCT FROM OLD.hold_safety_class
     OR NEW.source_state_snapshot IS DISTINCT FROM OLD.source_state_snapshot
     OR NEW.source_state_fingerprint IS DISTINCT FROM OLD.source_state_fingerprint THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_held_release_item_identity_immutable',
      MESSAGE = 'held-message reconciliation identity is immutable';
  END IF;
  IF OLD.release_receipt_client_event_id IS NOT NULL
     AND (
       NEW.release_receipt_client_event_id IS DISTINCT FROM OLD.release_receipt_client_event_id
       OR NEW.release_effect_client_event_id IS DISTINCT FROM OLD.release_effect_client_event_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_held_release_item_outcome_immutable',
      MESSAGE = 'held-message release outcome is immutable';
  END IF;
  IF OLD.release_receipt_client_event_id IS NULL
     AND NEW.release_receipt_client_event_id IS NOT NULL THEN
    SELECT pg_catalog.pg_get_userbyid(class.relowner)
      INTO relation_owner
      FROM pg_catalog.pg_class AS class
     WHERE class.oid = TG_RELID;
    IF current_user IS DISTINCT FROM relation_owner THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'held-message release outcome requires the dedicated command';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cc_held_release_item_identity_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_reconciliation_items
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_held_release_item_identity();

CREATE FUNCTION public.cc_held_release_proof_matches(
  p_tenant_id UUID,
  p_client_event_id UUID,
  p_interface_family VARCHAR,
  p_message_id BIGINT,
  p_allow_claimed_current_tx BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.clinical_continuity_replay_receipts AS receipt
      JOIN public.clinical_continuity_replay_effect_evidence AS effect
        ON effect.tenant_id = receipt.tenant_id
       AND effect.client_event_id = receipt.client_event_id
     WHERE receipt.tenant_id = p_tenant_id
       AND receipt.client_event_id = p_client_event_id
       AND receipt.source_kind = 'held_message_release'
       AND receipt.interface_family = p_interface_family
       AND effect.outcome_code = 'held_message_send_authority_rearmed'
       AND effect.interface_family = p_interface_family
       AND effect.network_send_performed IS FALSE
       AND effect.command_fingerprint = receipt.client_command_fingerprint
       AND effect.source_state_fingerprint = receipt.source_state_fingerprint
       AND (
         (p_interface_family = 'I04'
          AND receipt.hl7_outbound_message_id = p_message_id
          AND effect.hl7_outbound_message_id = p_message_id)
         OR
         (p_interface_family = 'I05'
          AND receipt.interop_message_id = p_message_id
          AND effect.interop_message_id = p_message_id)
         OR
         (p_interface_family = 'I19'
          AND receipt.nhcx_message_id = p_message_id
          AND effect.nhcx_message_id = p_message_id)
       )
       AND (
         receipt.disposition = 'applied'
         OR (
           p_allow_claimed_current_tx
           AND receipt.disposition = 'claimed'
           AND receipt.claim_txid = txid_current()
         )
       )
  );
$$;

CREATE FUNCTION public.assert_cc_hl7_held_release_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  release_event UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.owner_release_client_event_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_hl7_outbound_held_release_immutable',
        MESSAGE = 'I04 held-release evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.owner_release_client_event_id IS NOT NULL
     AND NEW.owner_release_client_event_id IS DISTINCT FROM OLD.owner_release_client_event_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_held_release_immutable',
      MESSAGE = 'I04 held-release evidence is immutable';
  END IF;

  IF OLD.send_authority IS DISTINCT FROM NEW.send_authority
     AND NEW.send_authority = 'authorized' THEN
    release_event := NULLIF(
      current_setting('app.cc_held_release_client_event_id', true), ''
    )::uuid;
    IF OLD.ledger_version <> 1
       OR OLD.status <> 'reconciliation_required'
       OR OLD.send_authority <> 'held_owner_reconciliation'
       OR OLD.claim_token IS NOT NULL
       OR OLD.recovery_inbox_id IS NULL
       OR OLD.recovery_interface_family <> 'I04'
       OR EXISTS (
         SELECT 1
           FROM public.hl7_outbound_acknowledgements AS acknowledgement
          WHERE acknowledgement.tenant_id = OLD.tenant_id
            AND acknowledgement.message_id = OLD.id
            AND acknowledgement.subscription_id = OLD.subscription_id
            AND acknowledgement.msa_code = 'AA'
            AND acknowledgement.correlation_matches
       )
       OR NEW.status <> 'queued'
       OR NEW.owner_release_client_event_id IS DISTINCT FROM release_event
       OR NOT public.cc_held_release_proof_matches(
         NEW.tenant_id,
         NEW.owner_release_client_event_id,
         'I04',
         NEW.id,
         TRUE
       )
       OR (to_jsonb(NEW) - ARRAY[
         'status', 'send_authority', 'next_attempt_at',
         'owner_release_actor_uid', 'owner_release_reason',
         'owner_released_at', 'owner_release_client_event_id'
       ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
         'status', 'send_authority', 'next_attempt_at',
         'owner_release_actor_uid', 'owner_release_reason',
         'owner_released_at', 'owner_release_client_event_id'
       ]) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_hl7_outbound_held_release_receipt',
        MESSAGE = 'I04 held authority requires the exact C5.1 release receipt';
    END IF;
  ELSIF OLD.owner_release_client_event_id IS NULL
        AND NEW.owner_release_client_event_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hl7_outbound_held_release_receipt',
      MESSAGE = 'I04 held-release evidence cannot be attached without release';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER zz_cc_hl7_held_release_transition
BEFORE UPDATE OR DELETE ON public.hl7_outbound_messages
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_hl7_held_release_transition();

CREATE OR REPLACE FUNCTION public.validate_interop_message_recovery_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  release_event UUID;
  proof_matches BOOLEAN;
BEGIN
  IF OLD.recovery_ledger_version = 1 AND (
       NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.channel_version_id IS DISTINCT FROM OLD.channel_version_id
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.protocol IS DISTINCT FROM OLD.protocol
       OR NEW.message_type IS DISTINCT FROM OLD.message_type
       OR NEW.external_control_id IS DISTINCT FROM OLD.external_control_id
       OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
       OR NEW.raw_payload_ciphertext IS DISTINCT FROM OLD.raw_payload_ciphertext
       OR NEW.recovery_ledger_version IS DISTINCT FROM OLD.recovery_ledger_version
       OR NEW.source_position IS DISTINCT FROM OLD.source_position
       OR NEW.source_token IS DISTINCT FROM OLD.source_token
       OR NEW.predecessor_token IS DISTINCT FROM OLD.predecessor_token
       OR NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
       OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
       OR NEW.arrival_class IS DISTINCT FROM OLD.arrival_class
       OR NEW.effect_disposition IS DISTINCT FROM OLD.effect_disposition
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_message_recovery_identity_immutable',
      MESSAGE = 'I05 recovery identity and late disposition are immutable';
  END IF;

  IF OLD.owner_release_client_event_id IS NOT NULL
     AND NEW.owner_release_client_event_id IS DISTINCT FROM OLD.owner_release_client_event_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_message_held_release_immutable',
      MESSAGE = 'I05 held-release evidence is immutable';
  END IF;

  proof_matches := NEW.owner_release_client_event_id IS NOT NULL
    AND public.cc_held_release_proof_matches(
      NEW.tenant_id,
      NEW.owner_release_client_event_id,
      'I05',
      NEW.id,
      TRUE
    );

  IF OLD.send_authority = 'held'
     AND NEW.send_authority = 'owner_authorized' THEN
    release_event := NULLIF(
      current_setting('app.cc_held_release_client_event_id', true), ''
    )::uuid;
    IF OLD.recovery_ledger_version <> 1
       OR OLD.direction NOT IN ('outbound', 'bidirectional')
       OR OLD.protocol NOT IN ('hl7v2', 'csv', 'json', 'fhir_json', 'other')
       OR OLD.status <> 'quarantined'
       OR OLD.arrival_class <> 'recovery_backlog'
       OR OLD.effect_disposition <> 'late_pending_only'
       OR OLD.owner_reconciliation_required IS NOT TRUE
       OR OLD.delivery_claim_token IS NOT NULL
       OR NEW.status <> 'queued'
       OR NEW.owner_reconciliation_required IS NOT FALSE
       OR NEW.owner_release_client_event_id IS DISTINCT FROM release_event
       OR NOT proof_matches THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_interop_message_held_release_receipt',
        MESSAGE = 'I05 held authority requires the exact C5.1 release receipt';
    END IF;
  ELSIF OLD.owner_release_client_event_id IS NULL
        AND NEW.owner_release_client_event_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_message_held_release_receipt',
      MESSAGE = 'I05 held-release evidence cannot be attached without release';
  END IF;

  IF OLD.owner_release_client_event_id IS NOT NULL
     AND (
       NEW.send_authority IS DISTINCT FROM OLD.send_authority
       OR NEW.owner_reconciliation_required IS DISTINCT FROM OLD.owner_reconciliation_required
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_message_held_release_no_rewind',
      MESSAGE = 'I05 released authority cannot be rewound or granted twice';
  END IF;

  IF NEW.effect_disposition = 'late_pending_only'
     AND NEW.status IN ('queued', 'delivering', 'delivered', 'replayed')
     AND NOT proof_matches THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_interop_message_late_effect_suppression',
      MESSAGE = 'I05 late delivery requires an applied C5.1 release receipt';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_nhcx_i19_claim_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  release_event UUID;
  proof_matches BOOLEAN;
BEGIN
  IF TG_OP OPERATOR(pg_catalog.=) 'DELETE' THEN
    IF OLD.recovery_inbox_id IS NOT NULL
       OR OLD.inbound_owner_uid IS NOT NULL
       OR OLD.owner_release_client_event_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_recovery_immutable',
        MESSAGE = 'I19 owner recovery evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.owner_release_client_event_id IS NOT NULL
     AND NEW.owner_release_client_event_id IS DISTINCT FROM OLD.owner_release_client_event_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_nhcx_i19_held_release_immutable',
      MESSAGE = 'I19 held-release evidence is immutable';
  END IF;

  proof_matches := NEW.owner_release_client_event_id IS NOT NULL
    AND public.cc_held_release_proof_matches(
      NEW.tenant_id,
      NEW.owner_release_client_event_id,
      'I19',
      NEW.id,
      TRUE
    );

  IF OLD.recovery_inbox_id IS NULL AND NEW.recovery_inbox_id IS NOT NULL THEN
    IF OLD.direction IS DISTINCT FROM 'outbound'
       OR OLD.status NOT IN ('sent', 'failed', 'dead', 'rejected')
       OR NEW.recovery_prior_status IS DISTINCT FROM OLD.status
       OR NEW.status IS DISTINCT FROM 'recovery_pending' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_outbound_claim_transition',
        MESSAGE = 'only eligible outbound NHCX evidence can enter recovery review';
    END IF;
  ELSIF OLD.recovery_inbox_id IS NOT NULL AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.cycle IS DISTINCT FROM OLD.cycle
    OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
    OR NEW.hcx_api_call_id IS DISTINCT FROM OLD.hcx_api_call_id
    OR NEW.hcx_correlation_id IS DISTINCT FROM OLD.hcx_correlation_id
    OR NEW.hcx_workflow_id IS DISTINCT FROM OLD.hcx_workflow_id
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext
    OR NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
    OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
    OR NEW.recovery_owner_uid IS DISTINCT FROM OLD.recovery_owner_uid
    OR NEW.recovery_owner_reason IS DISTINCT FROM OLD.recovery_owner_reason
    OR NEW.recovery_disposition IS DISTINCT FROM OLD.recovery_disposition
    OR NEW.recovery_claimed_at IS DISTINCT FROM OLD.recovery_claimed_at
    OR NEW.recovery_prior_status IS DISTINCT FROM OLD.recovery_prior_status
    OR NEW.recovery_evidence IS DISTINCT FROM OLD.recovery_evidence
    OR NEW.source_partition IS DISTINCT FROM OLD.source_partition
    OR NEW.source_position IS DISTINCT FROM OLD.source_position
    OR NEW.source_token IS DISTINCT FROM OLD.source_token
    OR NEW.predecessor_token IS DISTINCT FROM OLD.predecessor_token
    OR NEW.duplicate_key IS DISTINCT FROM OLD.duplicate_key
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_nhcx_i19_recovery_immutable',
      MESSAGE = 'I19 outbound recovery evidence and disposition are immutable';
  END IF;

  IF OLD.direction = 'outbound'
     AND OLD.recovery_inbox_id IS NOT NULL
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.owner_release_client_event_id IS NULL THEN
      IF OLD.recovery_disposition <> 'manual_redrive_requested' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'chk_nhcx_i19_recovery_immutable',
          MESSAGE = 'I19 outbound recovery evidence and disposition are immutable';
      END IF;
      release_event := NULLIF(
        current_setting('app.cc_held_release_client_event_id', true), ''
      )::uuid;
      IF OLD.status <> 'recovery_pending'
         OR NEW.status <> 'pending'
         OR OLD.recovery_disposition <> 'manual_redrive_requested'
         OR OLD.payload_ciphertext IS NULL
         OR OLD.cycle = 'payment_notice'
         OR NEW.owner_release_client_event_id IS DISTINCT FROM release_event
         OR NOT proof_matches THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'chk_nhcx_i19_held_release_receipt',
          MESSAGE = 'I19 held authority requires the exact C5.1 release receipt';
      END IF;
    ELSIF NEW.status NOT IN ('pending', 'sent', 'accepted', 'failed', 'dead', 'rejected')
          OR NOT proof_matches THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_held_release_no_rewind',
        MESSAGE = 'I19 released authority cannot be rewound or granted twice';
    END IF;
  ELSIF OLD.owner_release_client_event_id IS NULL
        AND NEW.owner_release_client_event_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_nhcx_i19_held_release_receipt',
      MESSAGE = 'I19 held-release evidence cannot be attached without release';
  END IF;

  IF OLD.inbound_claim_token IS NULL AND NEW.inbound_claim_token IS NOT NULL THEN
    IF OLD.direction IS DISTINCT FROM 'inbound'
       OR OLD.cycle = 'payment_notice'
       OR (
         (OLD.status = 'accepted' AND NEW.status NOT IN ('processing', 'recovery_pending'))
         OR (OLD.status <> 'accepted')
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_inbound_claim_transition',
        MESSAGE = 'I19 inbound processing must be claimed atomically from an accepted envelope';
    END IF;
    IF NEW.status = 'recovery_pending'
       AND OLD.created_at > NOW() - INTERVAL '5 minutes' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_inbound_claim_not_stale',
        MESSAGE = 'I19 inbound envelope is not stale enough for owner recovery';
    END IF;
  ELSIF OLD.inbound_claim_token IS NOT NULL THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.cycle IS DISTINCT FROM OLD.cycle
       OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
       OR NEW.hcx_api_call_id IS DISTINCT FROM OLD.hcx_api_call_id
       OR NEW.hcx_correlation_id IS DISTINCT FROM OLD.hcx_correlation_id
       OR NEW.hcx_workflow_id IS DISTINCT FROM OLD.hcx_workflow_id
       OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
       OR NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext
       OR NEW.signature_verified IS DISTINCT FROM OLD.signature_verified
       OR NEW.inbound_claim_token IS DISTINCT FROM OLD.inbound_claim_token
       OR NEW.inbound_claimed_at IS DISTINCT FROM OLD.inbound_claimed_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_inbound_claim_immutable',
        MESSAGE = 'I19 inbound processing claim identity is immutable';
    END IF;

    IF OLD.status = 'processing'
       AND NEW.status IN ('processed', 'manual_review')
       AND NEW.inbound_completed_at IS NOT NULL
       AND NEW.inbound_owner_uid IS NULL THEN
      RETURN NEW;
    END IF;

    IF OLD.status = 'processing'
       AND NEW.status = 'recovery_pending'
       AND OLD.inbound_claimed_at <= NOW() - INTERVAL '5 minutes'
       AND NEW.inbound_owner_uid IS NOT NULL THEN
      RETURN NEW;
    END IF;

    IF OLD.status = 'recovery_pending' AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.inbound_owner_uid IS DISTINCT FROM OLD.inbound_owner_uid
      OR NEW.inbound_owner_reason IS DISTINCT FROM OLD.inbound_owner_reason
      OR NEW.inbound_owner_disposition IS DISTINCT FROM OLD.inbound_owner_disposition
      OR NEW.inbound_owner_claimed_at IS DISTINCT FROM OLD.inbound_owner_claimed_at
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_inbound_recovery_immutable',
        MESSAGE = 'I19 stranded inbound owner claim cannot be replayed or rewritten';
    ELSIF OLD.status IS DISTINCT FROM NEW.status
       OR NEW.inbound_completed_at IS DISTINCT FROM OLD.inbound_completed_at
       OR NEW.inbound_owner_uid IS DISTINCT FROM OLD.inbound_owner_uid
       OR NEW.inbound_owner_reason IS DISTINCT FROM OLD.inbound_owner_reason
       OR NEW.inbound_owner_disposition IS DISTINCT FROM OLD.inbound_owner_disposition
       OR NEW.inbound_owner_claimed_at IS DISTINCT FROM OLD.inbound_owner_claimed_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_nhcx_i19_inbound_claim_transition',
        MESSAGE = 'I19 inbound processing transition is not authorized';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.clinical_continuity_held_message_snapshot(
  p_tenant_id UUID,
  p_interface_family VARCHAR,
  p_message_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  snapshot JSONB;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR p_interface_family NOT IN ('I04', 'I05', 'I19')
     OR p_message_id IS NULL OR p_message_id <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'held-message snapshot context denied';
  END IF;

  IF p_interface_family = 'I04' THEN
    SELECT jsonb_build_object(
      'interface_family', 'I04',
      'message_id', message.id::text,
      'ledger_version', message.ledger_version,
      'subscription_id', message.subscription_id,
      'message_control_id', message.message_control_id,
      'status', message.status,
      'send_authority', message.send_authority,
      'transport_state', message.transport_state,
      'acknowledgement_state', message.acknowledgement_state,
      'payload_sha256', message.payload_sha256,
      'recovery_inbox_id', message.recovery_inbox_id::text,
      'recovery_interface_family', message.recovery_interface_family,
      'claim_token', message.claim_token::text,
      'claim_generation', message.claim_generation,
      'source_partition', inbox.source_partition,
      'source_position', inbox.source_position::text,
      'source_token', inbox.source_token,
      'duplicate_key', inbox.duplicate_key,
      'offset_id', inbox.offset_id::text,
      'cursor_state', cursor.state,
      'cursor_blocked_message_id', cursor.blocked_message_id::text,
      'cursor_inflight_message_id', cursor.inflight_message_id::text,
      'positive_ack_exists', EXISTS (
        SELECT 1
          FROM public.hl7_outbound_acknowledgements AS acknowledgement
         WHERE acknowledgement.tenant_id = message.tenant_id
           AND acknowledgement.message_id = message.id
           AND acknowledgement.subscription_id = message.subscription_id
           AND acknowledgement.msa_code = 'AA'
           AND acknowledgement.correlation_matches
      )
    )
      INTO snapshot
      FROM public.hl7_outbound_messages AS message
      JOIN public.pathway_projector_inbox AS inbox
        ON inbox.tenant_id = message.tenant_id
       AND inbox.inbox_id = message.recovery_inbox_id
       AND inbox.interface_family = message.recovery_interface_family
      LEFT JOIN public.hl7_outbound_delivery_cursors AS cursor
        ON cursor.tenant_id = message.tenant_id
       AND cursor.subscription_id = message.subscription_id
     WHERE message.tenant_id = p_tenant_id
       AND message.id = p_message_id::integer;
  ELSIF p_interface_family = 'I05' THEN
    SELECT jsonb_build_object(
      'interface_family', 'I05',
      'message_id', message.id::text,
      'channel_id', message.channel_id,
      'channel_version_id', message.channel_version_id,
      'channel_version_number', version.version_number,
      'channel_version_status', version.status,
      'channel_status', channel.status,
      'channel_active_version_id', channel.active_version_id,
      'connector_kind', channel.connector_kind,
      'direction', message.direction,
      'protocol', message.protocol,
      'recovery_ledger_version', message.recovery_ledger_version,
      'status', message.status,
      'arrival_class', message.arrival_class,
      'effect_disposition', message.effect_disposition,
      'send_authority', message.send_authority,
      'owner_reconciliation_required', message.owner_reconciliation_required,
      'payload_hash', message.payload_hash,
      'raw_payload_retained', message.raw_payload_retained,
      'ciphertext_sha256', encode(
        public.digest(convert_to(COALESCE(message.raw_payload_ciphertext, ''), 'UTF8'), 'sha256'),
        'hex'
      ),
      'connector_config_sha256', encode(
        public.digest(convert_to(version.connector_config::text, 'UTF8'), 'sha256'),
        'hex'
      ),
      'recovery_inbox_id', message.recovery_inbox_id::text,
      'recovery_interface_family', message.recovery_interface_family,
      'delivery_claim_token', message.delivery_claim_token::text,
      'delivery_claim_generation', message.delivery_claim_generation,
      'source_partition', inbox.source_partition,
      'source_position', inbox.source_position::text,
      'source_token', inbox.source_token,
      'duplicate_key', inbox.duplicate_key,
      'offset_id', inbox.offset_id::text
    )
      INTO snapshot
      FROM public.interop_messages AS message
      JOIN public.interop_channels AS channel
        ON channel.tenant_id = message.tenant_id
       AND channel.id = message.channel_id
      JOIN public.interop_channel_versions AS version
        ON version.tenant_id = message.tenant_id
       AND version.id = message.channel_version_id
       AND version.channel_id = message.channel_id
      JOIN public.pathway_projector_inbox AS inbox
        ON inbox.tenant_id = message.tenant_id
       AND inbox.inbox_id = message.recovery_inbox_id
       AND inbox.interface_family = message.recovery_interface_family
     WHERE message.tenant_id = p_tenant_id
       AND message.id = p_message_id::integer;
  ELSE
    SELECT jsonb_build_object(
      'interface_family', 'I19',
      'message_id', message.id::text,
      'environment', message.environment,
      'direction', message.direction,
      'cycle', message.cycle,
      'endpoint', message.endpoint,
      'hcx_api_call_id', message.hcx_api_call_id,
      'hcx_correlation_id', message.hcx_correlation_id,
      'hcx_workflow_id', message.hcx_workflow_id,
      'status', message.status,
      'attempt_count', message.attempt_count,
      'payload_hash', message.payload_hash,
      'ciphertext_sha256', encode(
        public.digest(convert_to(COALESCE(message.payload_ciphertext, ''), 'UTF8'), 'sha256'),
        'hex'
      ),
      'payload_ciphertext_present', message.payload_ciphertext IS NOT NULL,
      'profile_url', message.profile_url,
      'profile_version', message.profile_version,
      'claim_id', message.claim_id,
      'preauth_id', message.preauth_id,
      'policy_id', message.policy_id,
      'recovery_inbox_id', message.recovery_inbox_id::text,
      'recovery_interface_family', message.recovery_interface_family,
      'recovery_disposition', message.recovery_disposition,
      'recovery_prior_status', message.recovery_prior_status,
      'recovery_claimed_at', message.recovery_claimed_at,
      'source_partition', inbox.source_partition,
      'source_position', inbox.source_position::text,
      'source_token', inbox.source_token,
      'duplicate_key', inbox.duplicate_key,
      'offset_id', inbox.offset_id::text
    )
      INTO snapshot
      FROM public.nhcx_messages AS message
      JOIN public.pathway_projector_inbox AS inbox
        ON inbox.tenant_id = message.tenant_id
       AND inbox.inbox_id = message.recovery_inbox_id
       AND inbox.interface_family = message.recovery_interface_family
     WHERE message.tenant_id = p_tenant_id
       AND message.id = p_message_id;
  END IF;

  IF snapshot IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'held-message source was not found';
  END IF;
  RETURN snapshot;
END;
$$;

CREATE FUNCTION public.clinical_continuity_held_release_attest(
  p_tenant_id UUID,
  p_facility_id INTEGER,
  p_decision JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  item public.clinical_continuity_reconciliation_items%ROWTYPE;
  config public.clinical_continuity_reconciliation_config%ROWTYPE;
  existing public.clinical_continuity_reconciliation_decisions%ROWTYPE;
  source_snapshot JSONB;
  actor UUID := (p_decision ->> 'actor_uid')::uuid;
  decision_id UUID := (p_decision ->> 'id')::uuid;
  item_id UUID := (p_decision ->> 'reconciliation_item_id')::uuid;
  intended_releaser UUID := (p_decision ->> 'intended_releaser_uid')::uuid;
  expected_version INTEGER := (p_decision ->> 'expected_version')::integer;
  v_actor_role TEXT;
  releaser_role TEXT;
  reason_code TEXT := p_decision ->> 'release_reason_code';
  reason_detail TEXT := p_decision ->> 'release_reason_detail';
  command_fingerprint TEXT := p_decision ->> 'command_fingerprint';
  source_fingerprint TEXT := p_decision ->> 'source_state_fingerprint';
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR current_setting('app.current_facility_id', true) !~ '^[1-9][0-9]*$'
     OR current_setting('app.current_facility_id', true)::integer IS DISTINCT FROM p_facility_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'explicit tenant and facility context required';
  END IF;

  SELECT * INTO item
    FROM public.clinical_continuity_reconciliation_items
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id AND id = item_id
   FOR UPDATE;
  IF NOT FOUND OR item.interface_item_kind <> 'held_message_release' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'held-message item was not found';
  END IF;
  SELECT * INTO config
    FROM public.clinical_continuity_reconciliation_config
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
   FOR SHARE;
  SELECT UPPER(role) INTO v_actor_role
    FROM public.users
   WHERE tenant_id = p_tenant_id AND uid = actor
     AND is_active AND status = 'active' AND NOT is_deleted
   FOR SHARE;
  SELECT UPPER(role) INTO releaser_role
    FROM public.users
   WHERE tenant_id = p_tenant_id AND uid = intended_releaser
     AND is_active AND status = 'active' AND NOT is_deleted
   FOR SHARE;

  IF v_actor_role IS NULL
     OR releaser_role IS NULL
     OR config.clinical_safety_lead_uid IS DISTINCT FROM actor
     OR actor = intended_releaser
     OR item.assigned_to_uid IS DISTINCT FROM intended_releaser
     OR item.owner_principal IS DISTINCT FROM config.interface_owner_principal
     OR item.owner_principal = config.fallback_principal
     OR LOWER(item.owner_principal) IS DISTINCT FROM 'role:' || LOWER(releaser_role)
     OR item.hold_safety_class <> 'safety_critical'
     OR item.disposition NOT IN ('open', 'in_progress')
     OR reason_code NOT IN (
       'downstream_readiness_confirmed',
       'transport_configuration_corrected',
       'duplicate_delivery_risk_reviewed',
       'acknowledgement_uncertainty_reviewed',
       'owner_recovery_evidence_reconciled'
     )
     OR CHAR_LENGTH(BTRIM(reason_detail)) NOT BETWEEN 10 AND 500
     OR reason_detail ~ '[[:cntrl:]]'
     OR command_fingerprint !~ '^[0-9a-f]{64}$'
     OR source_fingerprint IS DISTINCT FROM item.source_state_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'held-message release attestation denied';
  END IF;

  SELECT * INTO existing
    FROM public.clinical_continuity_reconciliation_decisions
   WHERE tenant_id = p_tenant_id AND id = decision_id;
  IF FOUND THEN
    IF existing.facility_id = p_facility_id
       AND existing.reconciliation_item_id = item_id
       AND existing.decision = 'release_attestation'
       AND existing.actor_uid = actor
       AND existing.intended_releaser_uid = intended_releaser
       AND existing.command_fingerprint = command_fingerprint
       AND existing.source_state_fingerprint = source_fingerprint
       AND existing.release_reason_code = reason_code
       AND existing.release_reason_detail = reason_detail THEN
      RETURN to_jsonb(existing);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'release attestation identity drift';
  END IF;

  IF item.version <> expected_version THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'held-message item version is stale';
  END IF;
  source_snapshot := public.clinical_continuity_held_message_snapshot(
    p_tenant_id,
    item.interface_family,
    COALESCE(item.hl7_outbound_message_id, item.interop_message_id, item.nhcx_message_id)
  );
  IF source_snapshot IS DISTINCT FROM item.source_state_snapshot THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'held-message source state drifted';
  END IF;

  UPDATE public.clinical_continuity_reconciliation_items
     SET updated_by = actor,
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
     AND id = item_id AND version = expected_version;

  INSERT INTO public.clinical_continuity_reconciliation_decisions (
    id, tenant_id, facility_id, reconciliation_item_id, decision,
    reason_code, actor_uid, actor_role, prior_version, resulting_version,
    command_fingerprint, source_state_fingerprint, release_reason_code,
    release_reason_detail, hold_safety_class, intended_releaser_uid
  ) VALUES (
    decision_id, p_tenant_id, p_facility_id, item_id, 'release_attestation',
    reason_code, actor, v_actor_role, expected_version, expected_version + 1,
    command_fingerprint, source_fingerprint, reason_code,
    reason_detail, 'safety_critical', intended_releaser
  ) RETURNING * INTO existing;
  RETURN to_jsonb(existing);
END;
$$;

CREATE FUNCTION public.clinical_continuity_held_message_release(
  p_tenant_id UUID,
  p_facility_id INTEGER,
  p_command JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  item public.clinical_continuity_reconciliation_items%ROWTYPE;
  requirement public.clinical_continuity_incident_interfaces%ROWTYPE;
  config public.clinical_continuity_reconciliation_config%ROWTYPE;
  receipt public.clinical_continuity_replay_receipts%ROWTYPE;
  prior_receipt public.clinical_continuity_replay_receipts%ROWTYPE;
  effect public.clinical_continuity_replay_effect_evidence%ROWTYPE;
  attestation public.clinical_continuity_reconciliation_decisions%ROWTYPE;
  release_decision public.clinical_continuity_reconciliation_decisions%ROWTYPE;
  source_snapshot JSONB;
  prior_authority JSONB;
  next_authority JSONB;
  actor UUID := (p_command ->> 'actor_uid')::uuid;
  item_id UUID := (p_command ->> 'reconciliation_item_id')::uuid;
  release_decision_id UUID := (p_command ->> 'release_decision_id')::uuid;
  attestation_id UUID := NULLIF(p_command ->> 'release_attestation_decision_id', '')::uuid;
  expected_version INTEGER := (p_command ->> 'expected_version')::integer;
  expected_interface_version INTEGER := (p_command ->> 'expected_incident_interface_version')::integer;
  v_actor_role TEXT;
  message_id BIGINT;
  audit_id UUID;
  released_at TIMESTAMPTZ(6) := clock_timestamp();
  inserted_count INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR current_setting('app.current_facility_id', true) !~ '^[1-9][0-9]*$'
     OR current_setting('app.current_facility_id', true)::integer IS DISTINCT FROM p_facility_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'explicit tenant and facility context required';
  END IF;

  receipt := jsonb_populate_record(
    NULL::public.clinical_continuity_replay_receipts,
    p_command -> 'receipt'
  );
  effect := jsonb_populate_record(
    NULL::public.clinical_continuity_replay_effect_evidence,
    p_command -> 'effect'
  );

  SELECT req.* INTO requirement
    FROM public.clinical_continuity_incidents AS incident
    JOIN public.clinical_continuity_incident_interfaces AS req
      ON req.tenant_id = incident.tenant_id
     AND req.facility_id = incident.facility_id
     AND req.incident_id = incident.id
    JOIN public.clinical_continuity_reconciliation_items AS source_item
      ON source_item.tenant_id = incident.tenant_id
     AND source_item.facility_id = incident.facility_id
     AND source_item.incident_id = incident.id
     AND source_item.incident_interface_id = req.id
     AND source_item.interface_family = req.interface_family
   WHERE incident.tenant_id = p_tenant_id
     AND incident.facility_id = p_facility_id
     AND source_item.id = item_id
     AND incident.lifecycle_state IN ('declared', 'restored', 'reconciling')
     AND req.version = expected_interface_version
     AND req.disposition <> 'not_applicable'
   FOR SHARE OF incident, req;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'held-message release authority is stale';
  END IF;

  SELECT * INTO item
    FROM public.clinical_continuity_reconciliation_items
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id AND id = item_id
   FOR UPDATE;
  IF NOT FOUND OR item.interface_item_kind <> 'held_message_release' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'held-message item was not found';
  END IF;
  SELECT * INTO config
    FROM public.clinical_continuity_reconciliation_config
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
   FOR SHARE;
  SELECT UPPER(role) INTO v_actor_role
    FROM public.users
   WHERE tenant_id = p_tenant_id AND uid = actor
     AND is_active AND status = 'active' AND NOT is_deleted
   FOR SHARE;

  IF v_actor_role IS NULL
     OR item.assigned_to_uid IS DISTINCT FROM actor
     OR item.owner_principal IS DISTINCT FROM config.interface_owner_principal
     OR (
       item.owner_principal = config.fallback_principal
       AND (
         config.clinical_safety_lead_uid IS DISTINCT FROM actor
         OR item.hold_safety_class <> 'routine_operational'
       )
     )
     OR (
       item.owner_principal <> config.fallback_principal
       AND LOWER(item.owner_principal) IS DISTINCT FROM 'role:' || LOWER(v_actor_role)
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'held-message release actor denied';
  END IF;

  IF requirement.assigned_to_uid IS DISTINCT FROM actor THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'held-message release authority is stale';
  END IF;

  SELECT * INTO prior_receipt
    FROM public.clinical_continuity_replay_receipts AS existing
   WHERE existing.tenant_id = p_tenant_id
     AND existing.source_kind = 'held_message_release'
     AND (
       existing.client_event_id = receipt.client_event_id
       OR (
         existing.interface_family = item.interface_family
         AND (
           (item.interface_family = 'I04' AND existing.hl7_outbound_message_id = item.hl7_outbound_message_id)
           OR (item.interface_family = 'I05' AND existing.interop_message_id = item.interop_message_id)
           OR (item.interface_family = 'I19' AND existing.nhcx_message_id = item.nhcx_message_id)
         )
       )
     )
   LIMIT 1;
  IF FOUND THEN
    IF prior_receipt.client_event_id = receipt.client_event_id
       AND prior_receipt.capture_actor_uid = actor
       AND prior_receipt.capture_role = v_actor_role
       AND prior_receipt.client_command_fingerprint = receipt.client_command_fingerprint
       AND prior_receipt.receipt_fingerprint = receipt.receipt_fingerprint
       AND prior_receipt.source_state_fingerprint = receipt.source_state_fingerprint
       AND prior_receipt.disposition = 'applied'
       AND prior_receipt.outcome_code = 'held_message_send_authority_rearmed' THEN
      SELECT * INTO effect
        FROM public.clinical_continuity_replay_effect_evidence AS applied
       WHERE applied.tenant_id = p_tenant_id
         AND applied.client_event_id = prior_receipt.client_event_id;
      RETURN jsonb_build_object(
        'disposition', 'exact_duplicate',
        'receipt_id', prior_receipt.client_event_id,
        'effect_evidence_id', effect.client_event_id,
        'audit_event_id', effect.release_audit_event_id,
        'outcome_code', prior_receipt.outcome_code,
        'prior_authority_state', effect.prior_authority_state,
        'next_authority_state', effect.next_authority_state,
        'network_send_performed', FALSE
      );
    END IF;
    INSERT INTO public.clinical_continuity_replay_attempts (
      tenant_id, client_event_id, receipt_client_event_id,
      replay_actor_uid, replay_role, facility_context_id,
      facility_context_revision, request_id, attempt_class,
      reason_code, result, idempotency_key_hash
    ) VALUES (
      p_tenant_id, receipt.client_event_id, prior_receipt.client_event_id,
      actor, v_actor_role, NULLIF(p_command ->> 'facility_context_id', '')::uuid,
      NULLIF(p_command ->> 'facility_context_revision', '')::bigint,
      NULLIF(p_command ->> 'request_id', '')::uuid,
      'held_release_mismatch', 'CONTINUITY_HELD_RELEASE_FINGERPRINT_MISMATCH',
      'needs_review', encode(public.digest(convert_to(receipt.original_idempotency_key, 'UTF8'), 'sha256'), 'hex')
    );
    RETURN jsonb_build_object(
      'disposition', 'mismatch',
      'code', 'CONTINUITY_HELD_RELEASE_FINGERPRINT_MISMATCH'
    );
  END IF;

  message_id := COALESCE(
    item.hl7_outbound_message_id,
    item.interop_message_id,
    item.nhcx_message_id
  );
  source_snapshot := public.clinical_continuity_held_message_snapshot(
    p_tenant_id, item.interface_family, message_id
  );

  IF item.version <> expected_version
     OR item.disposition NOT IN ('open', 'in_progress')
     OR item.hold_safety_class = 'unclassified'
     OR item.release_receipt_client_event_id IS NOT NULL
     OR receipt.tenant_id IS DISTINCT FROM p_tenant_id
     OR receipt.facility_id IS DISTINCT FROM p_facility_id
     OR receipt.incident_id IS DISTINCT FROM item.incident_id
     OR receipt.reconciliation_item_id IS DISTINCT FROM item.id
     OR receipt.incident_interface_id IS DISTINCT FROM item.incident_interface_id
     OR receipt.source_kind <> 'held_message_release'
     OR receipt.subject_kind <> 'interface_held_message'
     OR receipt.subject_key IS DISTINCT FROM item.interface_family || ':' || message_id::text
     OR receipt.interface_family IS DISTINCT FROM item.interface_family
     OR receipt.capture_actor_uid IS DISTINCT FROM actor
     OR receipt.capture_role IS DISTINCT FROM v_actor_role
     OR receipt.action_id <> 'clinical_continuity.interface_held_message.release'
     OR receipt.binding_id <> 'clinical_continuity.interface_held_message.release/v1'
     OR receipt.http_method <> 'POST'
     OR receipt.schema_id <> 'clinical-continuity-held-message-release'
     OR receipt.schema_version <> 1
     OR receipt.action_version <> 1
     OR receipt.source_state_fingerprint IS DISTINCT FROM item.source_state_fingerprint
     OR receipt.client_command_fingerprint IS DISTINCT FROM p_command ->> 'command_fingerprint'
     OR receipt.receipt_fingerprint IS DISTINCT FROM p_command ->> 'command_fingerprint'
     OR effect.tenant_id IS DISTINCT FROM p_tenant_id
     OR effect.facility_id IS DISTINCT FROM p_facility_id
     OR effect.client_event_id IS DISTINCT FROM receipt.client_event_id
     OR effect.reconciliation_item_id IS DISTINCT FROM item.id
     OR effect.interface_family IS DISTINCT FROM item.interface_family
     OR effect.original_releaser_uid IS DISTINCT FROM actor
     OR effect.original_releaser_role IS DISTINCT FROM v_actor_role
     OR effect.source_state_fingerprint IS DISTINCT FROM item.source_state_fingerprint
     OR effect.command_fingerprint IS DISTINCT FROM receipt.client_command_fingerprint
     OR effect.command_fingerprint IS DISTINCT FROM p_command ->> 'command_fingerprint'
     OR effect.outcome_code <> 'held_message_send_authority_rearmed'
     OR effect.release_audit_event_id IS NULL
     OR effect.network_send_performed IS NOT FALSE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'held-message release command shape denied';
  END IF;

  PERFORM 1
    FROM public.clinical_continuity_incidents AS incident
   WHERE incident.tenant_id = p_tenant_id
     AND incident.facility_id = p_facility_id
     AND incident.id = item.incident_id
     AND incident.lifecycle_state IN ('declared', 'restored', 'reconciling')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'held-message incident is not active';
  END IF;
  PERFORM 1
    FROM public.clinical_continuity_incident_interfaces AS req_check
   WHERE req_check.tenant_id = p_tenant_id
     AND req_check.facility_id = p_facility_id
     AND req_check.id = item.incident_interface_id
     AND req_check.incident_id = item.incident_id
     AND req_check.interface_family = item.interface_family
     AND req_check.version = expected_interface_version
     AND req_check.disposition <> 'not_applicable'
     AND req_check.assigned_to_uid = actor
     AND req_check.offset_id::text = source_snapshot ->> 'offset_id'
     AND req_check.source_partition = source_snapshot ->> 'source_partition'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'incident-interface requirement drifted';
  END IF;
  PERFORM 1
    FROM public.tasks AS task
   WHERE task.tenant_id = p_tenant_id
     AND task.id = item.task_id
     AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND task.assigned_to_uid = actor
     AND task.sla_completion_semantics = 'none'
     AND task.workflow_sla_instance_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'held-message task is not releaseable';
  END IF;

  IF source_snapshot IS DISTINCT FROM item.source_state_snapshot THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'held-message source state drifted';
  END IF;

  IF item.interface_family = 'I04' THEN
    prior_authority := jsonb_build_object(
      'status', 'reconciliation_required',
      'send_authority', 'held_owner_reconciliation'
    );
    next_authority := jsonb_build_object('status', 'queued', 'send_authority', 'authorized');
    IF source_snapshot ->> 'status' <> 'reconciliation_required'
       OR source_snapshot ->> 'send_authority' <> 'held_owner_reconciliation'
       OR source_snapshot ->> 'ledger_version' <> '1'
       OR source_snapshot ->> 'claim_token' IS NOT NULL
       OR (source_snapshot ->> 'positive_ack_exists')::boolean
       OR receipt.hl7_outbound_message_id IS DISTINCT FROM item.hl7_outbound_message_id
       OR effect.hl7_outbound_message_id IS DISTINCT FROM item.hl7_outbound_message_id
       OR receipt.payload_hash IS DISTINCT FROM source_snapshot ->> 'payload_sha256'
       OR effect.release_reason_code NOT IN (
         'downstream_readiness_confirmed',
         'duplicate_delivery_risk_reviewed',
         'acknowledgement_uncertainty_reviewed'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'I04 held message is not releaseable';
    END IF;
  ELSIF item.interface_family = 'I05' THEN
    prior_authority := jsonb_build_object(
      'status', 'quarantined',
      'send_authority', 'held',
      'owner_reconciliation_required', TRUE
    );
    next_authority := jsonb_build_object(
      'status', 'queued',
      'send_authority', 'owner_authorized',
      'owner_reconciliation_required', FALSE
    );
    IF source_snapshot ->> 'status' <> 'quarantined'
       OR source_snapshot ->> 'send_authority' <> 'held'
       OR source_snapshot ->> 'owner_reconciliation_required' <> 'true'
       OR source_snapshot ->> 'recovery_ledger_version' <> '1'
       OR source_snapshot ->> 'arrival_class' <> 'recovery_backlog'
       OR source_snapshot ->> 'effect_disposition' <> 'late_pending_only'
       OR source_snapshot ->> 'direction' NOT IN ('outbound', 'bidirectional')
       OR source_snapshot ->> 'protocol' NOT IN ('hl7v2', 'csv', 'json', 'fhir_json', 'other')
       OR source_snapshot ->> 'delivery_claim_token' IS NOT NULL
       OR source_snapshot ->> 'channel_status' <> 'active'
       OR source_snapshot ->> 'channel_version_status' <> 'active'
       OR source_snapshot ->> 'channel_active_version_id'
          IS DISTINCT FROM source_snapshot ->> 'channel_version_id'
       OR receipt.interop_message_id IS DISTINCT FROM item.interop_message_id
       OR effect.interop_message_id IS DISTINCT FROM item.interop_message_id
       OR receipt.payload_hash IS DISTINCT FROM source_snapshot ->> 'payload_hash'
       OR effect.release_reason_code NOT IN (
         'downstream_readiness_confirmed',
         'transport_configuration_corrected',
         'duplicate_delivery_risk_reviewed',
         'owner_recovery_evidence_reconciled'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'I05 held message is not releaseable';
    END IF;
  ELSE
    prior_authority := jsonb_build_object('status', 'recovery_pending');
    next_authority := jsonb_build_object('status', 'pending');
    IF source_snapshot ->> 'status' <> 'recovery_pending'
       OR source_snapshot ->> 'direction' <> 'outbound'
       OR source_snapshot ->> 'cycle' = 'payment_notice'
       OR source_snapshot ->> 'recovery_disposition' <> 'manual_redrive_requested'
       OR (source_snapshot ->> 'payload_ciphertext_present')::boolean IS NOT TRUE
       OR receipt.nhcx_message_id IS DISTINCT FROM item.nhcx_message_id
       OR effect.nhcx_message_id IS DISTINCT FROM item.nhcx_message_id
       OR receipt.payload_hash IS DISTINCT FROM source_snapshot ->> 'payload_hash'
       OR effect.release_reason_code NOT IN (
         'downstream_readiness_confirmed',
         'transport_configuration_corrected',
         'duplicate_delivery_risk_reviewed',
         'owner_recovery_evidence_reconciled'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'I19 held message is not releaseable';
    END IF;
  END IF;

  IF effect.release_reason_code IS NULL
     OR effect.release_reason_code IS DISTINCT FROM p_command ->> 'release_reason_code'
     OR effect.release_reason_detail IS DISTINCT FROM p_command ->> 'release_reason_detail'
     OR CHAR_LENGTH(BTRIM(effect.release_reason_detail)) NOT BETWEEN 10 AND 500
     OR effect.release_reason_detail ~ '[[:cntrl:]]'
     OR effect.prior_authority_state IS DISTINCT FROM prior_authority
     OR effect.next_authority_state IS DISTINCT FROM next_authority THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'held-message release evidence drifted';
  END IF;

  IF item.hold_safety_class = 'safety_critical' THEN
    SELECT * INTO attestation
      FROM public.clinical_continuity_reconciliation_decisions
     WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
       AND id = attestation_id
       AND reconciliation_item_id = item.id
       AND decision = 'release_attestation'
     FOR SHARE;
    IF NOT FOUND
       OR attestation.actor_uid = actor
       OR attestation.intended_releaser_uid IS DISTINCT FROM actor
       OR attestation.resulting_version <> expected_version
       OR attestation.command_fingerprint IS DISTINCT FROM effect.command_fingerprint
       OR attestation.source_state_fingerprint IS DISTINCT FROM item.source_state_fingerprint
       OR attestation.release_reason_code IS DISTINCT FROM effect.release_reason_code
       OR attestation.release_reason_detail IS DISTINCT FROM effect.release_reason_detail
       OR effect.release_attestation_decision_id IS DISTINCT FROM attestation.id THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'distinct safety attestation is required';
    END IF;
  ELSIF attestation_id IS NOT NULL OR effect.release_attestation_decision_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'routine release cannot carry safety attestation';
  END IF;

  receipt.received_at := released_at;
  receipt.recorded_at := NULL;
  receipt.disposition := 'claimed';
  receipt.outcome_code := NULL;
  receipt.retention_policy_id := 'C-D10-2026-07-31';
  receipt.detailed_evidence_until := released_at + INTERVAL '365 days';
  receipt.replay_eligibility_until := receipt.expires_at;
  receipt.tombstone_until := released_at + INTERVAL '2555 days';
  receipt.claim_txid := txid_current();
  INSERT INTO public.clinical_continuity_replay_receipts SELECT receipt.*;

  SELECT audit_record.id INTO audit_id
    FROM public.clinical_audit_events AS audit_record
   WHERE audit_record.tenant_id = p_tenant_id
     AND audit_record.id = effect.release_audit_event_id
     AND audit_record.action = 'clinical_continuity.interface_held_message.release'
     AND audit_record.action_status = 'success'
     AND audit_record.actor_uid = actor
     AND audit_record.actor_role = v_actor_role
     AND audit_record.resource_type = 'clinical_continuity_reconciliation_item'
     AND audit_record.resource_table = 'clinical_continuity_reconciliation_items'
     AND audit_record.resource_id = item.id::text
     AND audit_record.before_state = prior_authority
     AND audit_record.after_state = next_authority
     AND audit_record.metadata ->> 'interface_family' = item.interface_family
     AND audit_record.metadata ->> 'receipt_client_event_id' = receipt.client_event_id::text
     AND (audit_record.metadata ->> 'network_send_performed')::boolean IS FALSE
     AND audit_record.idempotency_key = 'cc-held-release:' || receipt.client_event_id::text
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'held-message release audit evidence is invalid';
  END IF;

  effect.released_at := released_at;
  INSERT INTO public.clinical_continuity_replay_effect_evidence SELECT effect.*;

  PERFORM set_config(
    'app.cc_held_release_client_event_id', receipt.client_event_id::text, true
  );
  IF item.interface_family = 'I04' THEN
    UPDATE public.hl7_outbound_messages
       SET status = 'queued',
           send_authority = 'authorized',
           next_attempt_at = released_at,
           owner_release_actor_uid = actor,
           owner_release_reason = effect.release_reason_detail,
           owner_released_at = released_at,
           owner_release_client_event_id = receipt.client_event_id
     WHERE tenant_id = p_tenant_id AND id = item.hl7_outbound_message_id;
  ELSIF item.interface_family = 'I05' THEN
    UPDATE public.interop_messages
       SET status = 'queued',
           send_authority = 'owner_authorized',
           owner_reconciliation_required = FALSE,
           owner_release_client_event_id = receipt.client_event_id,
           updated_at = released_at
     WHERE tenant_id = p_tenant_id AND id = item.interop_message_id;
  ELSE
    UPDATE public.nhcx_messages
       SET status = 'pending',
           next_retry_at = released_at,
           owner_release_client_event_id = receipt.client_event_id,
           updated_at = released_at
     WHERE tenant_id = p_tenant_id AND id = item.nhcx_message_id;
  END IF;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'held-message source compare-and-swap failed';
  END IF;

  UPDATE public.clinical_continuity_reconciliation_items
     SET disposition = 'resolved', resolved_at = released_at,
         release_receipt_client_event_id = receipt.client_event_id,
         release_effect_client_event_id = receipt.client_event_id,
         updated_by = actor, updated_at = released_at, version = version + 1
   WHERE tenant_id = p_tenant_id AND facility_id = p_facility_id
     AND id = item.id AND version = expected_version;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'held-message item compare-and-swap failed';
  END IF;

  INSERT INTO public.clinical_continuity_reconciliation_decisions (
    id, tenant_id, facility_id, reconciliation_item_id, decision,
    reason_code, actor_uid, actor_role, prior_version, resulting_version,
    command_fingerprint, source_state_fingerprint, release_reason_code,
    release_reason_detail, hold_safety_class, intended_releaser_uid
  ) VALUES (
    release_decision_id, p_tenant_id, p_facility_id, item.id, 'held_message_released',
    effect.release_reason_code, actor, v_actor_role, expected_version, expected_version + 1,
    effect.command_fingerprint, effect.source_state_fingerprint,
    effect.release_reason_code, effect.release_reason_detail,
    item.hold_safety_class, actor
  ) RETURNING * INTO release_decision;

  UPDATE public.clinical_continuity_replay_receipts
     SET disposition = 'applied',
         outcome_code = 'held_message_send_authority_rearmed',
         recorded_at = released_at
   WHERE tenant_id = p_tenant_id
     AND client_event_id = receipt.client_event_id
     AND disposition = 'claimed'
     AND claim_txid = txid_current();
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'held-message receipt finalization failed';
  END IF;

  RETURN jsonb_build_object(
    'disposition', 'applied',
    'receipt_id', receipt.client_event_id,
    'effect_evidence_id', effect.client_event_id,
    'audit_event_id', audit_id,
    'decision_id', release_decision.id,
    'outcome_code', 'held_message_send_authority_rearmed',
    'prior_authority_state', prior_authority,
    'next_authority_state', next_authority,
    'network_send_performed', FALSE
  );
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.cc_held_release_table_owner_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_held_release_item_identity() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_hl7_held_release_transition() FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.cc_held_release_proof_matches(UUID, UUID, VARCHAR, BIGINT, BOOLEAN)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.clinical_continuity_held_message_snapshot(UUID, VARCHAR, BIGINT)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.clinical_continuity_held_release_attest(UUID, INTEGER, JSONB)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.clinical_continuity_held_message_release(UUID, INTEGER, JSONB)
  FROM PUBLIC;

DO $runtime_privileges$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_held_message_snapshot(UUID, VARCHAR, BIGINT) TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_held_release_attest(UUID, INTEGER, JSONB) TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_held_message_release(UUID, INTEGER, JSONB) TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.cc_held_release_table_owner_only() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_held_release_item_identity() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_hl7_held_release_transition() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.cc_held_release_proof_matches(UUID, UUID, VARCHAR, BIGINT, BOOLEAN) FROM %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMIT;
