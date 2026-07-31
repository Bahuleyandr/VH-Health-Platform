-- Migration 605: C5.1 immutable clinical-continuity replay receipts.
--
-- Electronic queue replay is the only writer in this slice. `source_kind` is
-- deliberately a validated string rather than a closed enum so the approved
-- paper back-entry source can be added without replacing this receipt model.

BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER TABLE public.note_drafts
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_note_drafts_revision CHECK (revision > 0);

CREATE UNIQUE INDEX ux_note_drafts_tenant_id
  ON public.note_drafts (tenant_id, id);

CREATE UNIQUE INDEX ux_users_tenant_id_id_uid_for_cc_replay
  ON public.users (tenant_id, id, uid);

CREATE UNIQUE INDEX ux_appointments_tenant_id_id_patient_for_cc_replay
  ON public.appointments (tenant_id, id, patient_id);

CREATE TABLE public.clinical_continuity_replay_receipts (
  tenant_id UUID NOT NULL,
  client_event_id UUID NOT NULL,
  source_kind VARCHAR(64) NOT NULL,
  facility_id INTEGER NOT NULL,
  incident_id UUID,
  paper_item_id VARCHAR(128),
  original_idempotency_key VARCHAR(200) NOT NULL,
  action_id VARCHAR(120) NOT NULL,
  binding_id VARCHAR(120) NOT NULL,
  http_method VARCHAR(8) NOT NULL,
  schema_id VARCHAR(160) NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_checksum CHAR(64) NOT NULL,
  client_command_fingerprint CHAR(64) NOT NULL,
  receipt_fingerprint CHAR(64) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  capture_actor_uid UUID NOT NULL,
  capture_role VARCHAR(64) NOT NULL,
  patient_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  appointment_id INTEGER,
  encounter_id UUID,
  admission_id INTEGER,
  unit_id VARCHAR(128),
  device_id UUID NOT NULL,
  device_posture VARCHAR(32) NOT NULL,
  capture_session_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  captured_at TIMESTAMPTZ(6) NOT NULL,
  queued_at TIMESTAMPTZ(6) NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  clock_evidence_hash CHAR(64) NOT NULL,
  cached_sources_hash CHAR(64) NOT NULL,
  source_cache_version VARCHAR(80),
  app_version VARCHAR(80) NOT NULL,
  envelope_schema_version INTEGER NOT NULL,
  queue_schema_version INTEGER NOT NULL,
  action_version INTEGER NOT NULL,
  action_checksum CHAR(64) NOT NULL,
  policy_id UUID NOT NULL,
  policy_version VARCHAR(80) NOT NULL,
  policy_checksum CHAR(64) NOT NULL,
  policy_signing_key_id VARCHAR(128) NOT NULL,
  policy_effective_from TIMESTAMPTZ(6) NOT NULL,
  policy_effective_until TIMESTAMPTZ(6) NOT NULL,
  policy_supersedes_id UUID,
  policy_revocation_epoch VARCHAR(80) NOT NULL,
  registry_version VARCHAR(80) NOT NULL,
  registry_checksum CHAR(64) NOT NULL,
  minimum_app_version VARCHAR(80) NOT NULL,
  base_revision BIGINT NOT NULL,
  base_etag VARCHAR(256),
  ordering_key TEXT NOT NULL,
  ordering_key_digest CHAR(64) NOT NULL,
  sequence_no BIGINT NOT NULL,
  predecessor_client_event_id UUID,
  supersession_generation INTEGER NOT NULL,
  human_review_required BOOLEAN NOT NULL,
  received_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  recorded_at TIMESTAMPTZ(6),
  disposition VARCHAR(24) NOT NULL DEFAULT 'claimed',
  outcome_code VARCHAR(100),
  retention_policy_id VARCHAR(100) NOT NULL,
  detailed_evidence_until TIMESTAMPTZ(6) NOT NULL,
  replay_eligibility_until TIMESTAMPTZ(6) NOT NULL,
  tombstone_until TIMESTAMPTZ(6) NOT NULL,
  claim_txid BIGINT NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (tenant_id, client_event_id),
  CONSTRAINT fk_cc_replay_receipt_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_replay_receipt_facility
    FOREIGN KEY (tenant_id, facility_id)
    REFERENCES public.facilities(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_replay_receipt_capture_actor
    FOREIGN KEY (tenant_id, capture_actor_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_replay_receipt_patient
    FOREIGN KEY (tenant_id, patient_id, patient_uid)
    REFERENCES public.users(tenant_id, id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_replay_receipt_appointment
    FOREIGN KEY (tenant_id, appointment_id, patient_id)
    REFERENCES public.appointments(tenant_id, id, patient_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_replay_receipt_encounter
    FOREIGN KEY (tenant_id, encounter_id, patient_uid)
    REFERENCES public.patient_encounters(tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_replay_receipt_admission
    FOREIGN KEY (tenant_id, admission_id, patient_uid)
    REFERENCES public.admissions(tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_replay_receipt_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_replay_receipt_source
    CHECK (source_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT chk_cc_replay_receipt_paper_source
    CHECK (
      (source_kind = 'electronic_queue' AND paper_item_id IS NULL)
      OR
      (source_kind <> 'electronic_queue' AND incident_id IS NOT NULL AND paper_item_id IS NOT NULL)
    ),
  CONSTRAINT chk_cc_replay_receipt_hashes
    CHECK (
      schema_checksum ~ '^[0-9a-f]{64}$'
      AND client_command_fingerprint ~ '^[0-9a-f]{64}$'
      AND receipt_fingerprint ~ '^[0-9a-f]{64}$'
      AND payload_hash ~ '^[0-9a-f]{64}$'
      AND clock_evidence_hash ~ '^[0-9a-f]{64}$'
      AND cached_sources_hash ~ '^[0-9a-f]{64}$'
      AND action_checksum ~ '^[0-9a-f]{64}$'
      AND policy_checksum ~ '^[0-9a-f]{64}$'
      AND registry_checksum ~ '^[0-9a-f]{64}$'
      AND ordering_key_digest ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT chk_cc_replay_receipt_method
    CHECK (http_method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  CONSTRAINT chk_cc_replay_receipt_versions
    CHECK (
      schema_version > 0
      AND envelope_schema_version > 0
      AND queue_schema_version > 0
      AND action_version > 0
      AND base_revision >= 0
      AND sequence_no > 0
      AND supersession_generation >= 0
    ),
  CONSTRAINT chk_cc_replay_receipt_times
    CHECK (
      occurred_at <= captured_at
      AND captured_at <= queued_at
      AND queued_at <= expires_at
      AND expires_at <= captured_at + INTERVAL '7 days'
      AND policy_effective_from <= captured_at
      AND captured_at < policy_effective_until
      AND replay_eligibility_until = expires_at
      AND detailed_evidence_until >= received_at
      AND tombstone_until >= detailed_evidence_until
    ),
  CONSTRAINT chk_cc_replay_receipt_disposition
    CHECK (
      (disposition = 'claimed' AND recorded_at IS NULL AND outcome_code IS NULL)
      OR
      (disposition IN ('applied', 'needs_review') AND recorded_at IS NOT NULL AND outcome_code IS NOT NULL)
    ),
  CONSTRAINT chk_cc_replay_receipt_draft_shape
    CHECK (
      action_id IN ('emr.nursing_note.draft.store', 'emr.op_note.draft.store')
      AND binding_id = 'emr.note_draft.store/v1'
      AND http_method = 'PUT'
      AND encounter_id IS NULL
      AND admission_id IS NULL
      AND (
        (action_id = 'emr.nursing_note.draft.store' AND appointment_id IS NULL)
        OR action_id = 'emr.op_note.draft.store'
      )
    )
);

CREATE UNIQUE INDEX uq_cc_replay_receipt_fingerprint
  ON public.clinical_continuity_replay_receipts
    (tenant_id, client_event_id, original_idempotency_key, receipt_fingerprint);

CREATE UNIQUE INDEX uq_cc_replay_receipt_paper_identity
  ON public.clinical_continuity_replay_receipts
    (tenant_id, facility_id, incident_id, paper_item_id)
  WHERE paper_item_id IS NOT NULL;

CREATE INDEX idx_cc_replay_receipt_patient
  ON public.clinical_continuity_replay_receipts
    (tenant_id, patient_uid, recorded_at DESC);

CREATE TABLE public.clinical_continuity_replay_effect_evidence (
  tenant_id UUID NOT NULL,
  client_event_id UUID NOT NULL,
  note_draft_id BIGINT NOT NULL,
  outcome_code VARCHAR(100) NOT NULL,
  draft_revision BIGINT NOT NULL,
  draft_updated_at TIMESTAMPTZ(6) NOT NULL,
  clinical_timeline_event_id UUID,
  clinical_audit_event_id UUID,
  workflow_sla_instance_id UUID,
  notification_outbox_id UUID,
  event_outbox_id UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, client_event_id),
  CONSTRAINT fk_cc_replay_effect_receipt
    FOREIGN KEY (tenant_id, client_event_id)
    REFERENCES public.clinical_continuity_replay_receipts(tenant_id, client_event_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_replay_effect_draft
    FOREIGN KEY (tenant_id, note_draft_id)
    REFERENCES public.note_drafts(tenant_id, id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_replay_effect_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_replay_effect_private_draft_only
    CHECK (
      outcome_code = 'draft_stored'
      AND draft_revision > 0
      AND clinical_timeline_event_id IS NULL
      AND clinical_audit_event_id IS NULL
      AND workflow_sla_instance_id IS NULL
      AND notification_outbox_id IS NULL
      AND event_outbox_id IS NULL
    )
);

CREATE TABLE public.clinical_continuity_replay_attempts (
  id BIGSERIAL,
  tenant_id UUID NOT NULL,
  client_event_id UUID NOT NULL,
  receipt_client_event_id UUID,
  replay_actor_uid UUID,
  replay_role VARCHAR(64),
  facility_context_id UUID,
  facility_context_revision BIGINT,
  request_id UUID,
  attempted_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  attempt_class VARCHAR(64) NOT NULL,
  reason_code VARCHAR(120) NOT NULL,
  result VARCHAR(32) NOT NULL,
  idempotency_key_hash CHAR(64),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT fk_cc_replay_attempt_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_replay_attempt_receipt
    FOREIGN KEY (tenant_id, receipt_client_event_id)
    REFERENCES public.clinical_continuity_replay_receipts(tenant_id, client_event_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_cc_replay_attempt_actor
    FOREIGN KEY (tenant_id, replay_actor_uid)
    REFERENCES public.users(tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_cc_replay_attempt_non_default_tenant
    CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
  CONSTRAINT chk_cc_replay_attempt_result
    CHECK (result IN ('applied', 'duplicate', 'needs_review', 'denied', 'failed')),
  CONSTRAINT chk_cc_replay_attempt_hash
    CHECK (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_cc_replay_attempt_event
  ON public.clinical_continuity_replay_attempts
    (tenant_id, client_event_id, attempted_at DESC);

ALTER TABLE public.clinical_continuity_replay_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_replay_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_replay_effect_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_replay_effect_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_replay_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_continuity_replay_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.clinical_continuity_replay_receipts
  AS PERMISSIVE
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());

CREATE POLICY cc_replay_receipt_explicit_tenant
  ON public.clinical_continuity_replay_receipts
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

CREATE POLICY tenant_isolation
  ON public.clinical_continuity_replay_effect_evidence
  AS PERMISSIVE
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());

CREATE POLICY cc_replay_effect_explicit_tenant
  ON public.clinical_continuity_replay_effect_evidence
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

CREATE POLICY tenant_isolation
  ON public.clinical_continuity_replay_attempts
  AS PERMISSIVE
  USING (tenant_id = public.app_current_tenant_id_uuid())
  WITH CHECK (tenant_id = public.app_current_tenant_id_uuid());

CREATE POLICY cc_replay_attempt_explicit_tenant
  ON public.clinical_continuity_replay_attempts
  AS RESTRICTIVE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND current_setting('app.current_tenant_id', true) <> ''
    AND current_setting('app.current_tenant_id', true) <> 'bypass'
    AND tenant_id = public.app_current_tenant_id_uuid()
  );

CREATE FUNCTION public.assert_cc_replay_receipt_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_replay_receipt_immutable',
      MESSAGE = 'clinical continuity replay receipts cannot be deleted';
  END IF;
  IF OLD.disposition <> 'claimed'
     OR NEW.disposition NOT IN ('applied', 'needs_review')
     OR OLD.claim_txid <> txid_current()
     OR (to_jsonb(NEW) - ARRAY['disposition', 'recorded_at', 'outcome_code'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['disposition', 'recorded_at', 'outcome_code']) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_replay_receipt_immutable',
      MESSAGE = 'clinical continuity replay receipt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cc_replay_receipt_mutation_guard
BEFORE UPDATE OR DELETE ON public.clinical_continuity_replay_receipts
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_replay_receipt_mutation();

CREATE FUNCTION public.assert_cc_replay_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = 'chk_cc_replay_append_only',
    MESSAGE = 'clinical continuity replay evidence is append-only';
END;
$$;

CREATE TRIGGER cc_replay_effect_append_only
BEFORE UPDATE OR DELETE ON public.clinical_continuity_replay_effect_evidence
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_replay_append_only();

CREATE TRIGGER cc_replay_attempt_append_only
BEFORE UPDATE OR DELETE ON public.clinical_continuity_replay_attempts
FOR EACH ROW EXECUTE FUNCTION public.assert_cc_replay_append_only();

CREATE FUNCTION public.clinical_continuity_replay_receipt_claim(
  p_tenant_id UUID,
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
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'explicit tenant context required';
  END IF;
  candidate := pg_catalog.jsonb_populate_record(
    NULL::public.clinical_continuity_replay_receipts,
    p_receipt
  );
  IF candidate.tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'receipt tenant mismatch';
  END IF;
  IF candidate.source_kind IS DISTINCT FROM 'electronic_queue'
     OR candidate.expires_at IS NULL
     OR candidate.expires_at <= clock_timestamp()
     OR candidate.human_review_required IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_cc_replay_claim_eligibility',
      MESSAGE = 'receipt claim is not electronically replay eligible';
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
  ON CONFLICT (tenant_id, client_event_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count = 1;
END;
$$;

CREATE FUNCTION public.clinical_continuity_replay_receipt_finalize(
  p_tenant_id UUID,
  p_client_event_id UUID,
  p_disposition VARCHAR,
  p_outcome_code VARCHAR
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id', true) IS NULL
     OR current_setting('app.current_tenant_id', true) IN ('', 'bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM p_tenant_id
     OR p_disposition NOT IN ('applied', 'needs_review')
     OR p_outcome_code IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'receipt finalization denied';
  END IF;
  UPDATE public.clinical_continuity_replay_receipts
     SET disposition = p_disposition,
         outcome_code = p_outcome_code,
         recorded_at = clock_timestamp()
   WHERE tenant_id = p_tenant_id
     AND client_event_id = p_client_event_id
     AND disposition = 'claimed'
     AND claim_txid = txid_current();
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_replay_receipt_mutation() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_replay_append_only() FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.clinical_continuity_replay_receipt_claim(UUID, JSONB)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.clinical_continuity_replay_receipt_finalize(UUID, UUID, VARCHAR, VARCHAR)
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
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.clinical_continuity_replay_receipts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT ON public.clinical_continuity_replay_receipts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.clinical_continuity_replay_effect_evidence FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.clinical_continuity_replay_effect_evidence TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.clinical_continuity_replay_attempts FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT SELECT, INSERT ON public.clinical_continuity_replay_attempts TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT USAGE, SELECT ON SEQUENCE public.clinical_continuity_replay_attempts_id_seq TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_replay_receipt_claim(UUID, JSONB) TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'GRANT EXECUTE ON FUNCTION public.clinical_continuity_replay_receipt_finalize(UUID, UUID, VARCHAR, VARCHAR) TO %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_replay_receipt_mutation() FROM %I',
      runtime_role
    );
    EXECUTE FORMAT(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_cc_replay_append_only() FROM %I',
      runtime_role
    );
  END LOOP;
END
$runtime_privileges$;

COMMIT;
