-- Migration 594: referral request-to-closure clinical truth.
--
-- Existing referrals remain readable. New writes gain an explicit owner,
-- replay-safe request identity, append-only transitions, immutable signed
-- specialist responses, patient-release receipts, and a distinct closure
-- state. The migration queues no notifications and changes no referral mode.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_referrals_tenant_id
  ON referrals (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_tenant_id
  ON appointments (tenant_id, id);

ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS current_owner_uid UUID,
  ADD COLUMN IF NOT EXISTS closure_status VARCHAR(20) NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS closure_reason VARCHAR(80),
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS closed_by UUID,
  ADD COLUMN IF NOT EXISTS appointment_id INTEGER,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64),
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(160),
  ADD COLUMN IF NOT EXISTS replacement_of_referral_id INTEGER,
  ADD COLUMN IF NOT EXISTS repeat_reason TEXT,
  ADD COLUMN IF NOT EXISTS ownership_accepted_at TIMESTAMPTZ(6);

UPDATE referrals
   SET current_owner_uid = referring_doctor
 WHERE current_owner_uid IS NULL
   AND EXISTS (
     SELECT 1
       FROM users
      WHERE users.tenant_id = referrals.tenant_id
        AND users.uid = referrals.referring_doctor
   );

ALTER TABLE referrals
  DROP CONSTRAINT IF EXISTS chk_referrals_closure_status,
  ADD CONSTRAINT chk_referrals_closure_status
    CHECK (closure_status IN ('open', 'closed')),
  DROP CONSTRAINT IF EXISTS chk_referrals_closure_shape,
  ADD CONSTRAINT chk_referrals_closure_shape CHECK (
    (closure_status = 'open' AND closed_at IS NULL AND closed_by IS NULL)
    OR
    (closure_status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL
      AND NULLIF(BTRIM(closure_reason), '') IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS chk_referrals_request_fingerprint,
  ADD CONSTRAINT chk_referrals_request_fingerprint CHECK (
    request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  DROP CONSTRAINT IF EXISTS chk_referrals_repeat_reason,
  ADD CONSTRAINT chk_referrals_repeat_reason CHECK (
    replacement_of_referral_id IS NULL
    OR NULLIF(BTRIM(repeat_reason), '') IS NOT NULL
  ),
  DROP CONSTRAINT IF EXISTS fk_referrals_current_owner,
  ADD CONSTRAINT fk_referrals_current_owner
    FOREIGN KEY (tenant_id, current_owner_uid)
    REFERENCES users (tenant_id, uid) ON UPDATE NO ACTION ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS fk_referrals_closed_by,
  ADD CONSTRAINT fk_referrals_closed_by
    FOREIGN KEY (tenant_id, closed_by)
    REFERENCES users (tenant_id, uid) ON UPDATE NO ACTION ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS fk_referrals_appointment,
  ADD CONSTRAINT fk_referrals_appointment
    FOREIGN KEY (tenant_id, appointment_id)
    REFERENCES appointments (tenant_id, id) ON UPDATE NO ACTION ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS fk_referrals_replacement,
  ADD CONSTRAINT fk_referrals_replacement
    FOREIGN KEY (tenant_id, replacement_of_referral_id)
    REFERENCES referrals (tenant_id, id) ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_referrals_tenant_idempotency
  ON referrals (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_referrals_active_request_fingerprint
  ON referrals (tenant_id, request_fingerprint)
  WHERE request_fingerprint IS NOT NULL
    AND closure_status = 'open'
    AND status IN ('pending', 'accepted', 'in_progress', 'completed');

CREATE INDEX IF NOT EXISTS idx_referrals_tenant_owner_open
  ON referrals (tenant_id, current_owner_uid, created_at DESC)
  WHERE closure_status = 'open';

CREATE INDEX IF NOT EXISTS idx_referrals_tenant_appointment
  ON referrals (tenant_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

-- Referral response is an acknowledgement obligation with the same exact
-- task/SLA source binding used by critical results and cold-chain excursions.
-- Extend both the write-time compatibility trigger and the deferred invariant
-- assertion without weakening their resource-type/resource-id equality checks.
DO $$
DECLARE
  function_signatures REGPROCEDURE[] := ARRAY[
    'tasks_sync_workflow_sla_compat()'::regprocedure,
    'care_pathway_assert_task_sla_source_binding(uuid,integer)'::regprocedure,
    'care_pathway_assert_actionable_task_owner(uuid,integer)'::regprocedure
  ];
  expected_match_counts INTEGER[] := ARRAY[3, 1, 1];
  function_index INTEGER;
  function_signature REGPROCEDURE;
  function_definition TEXT;
  match_count INTEGER;
  rule_pair_pattern TEXT :=
    $pattern$'critical_result_ack',[[:space:]]*'cold_chain_excursion_ack'$pattern$;
  extended_rule_pair TEXT :=
    $rules$'critical_result_ack', 'cold_chain_excursion_ack', 'referral_response'$rules$;
BEGIN
  FOR function_index IN 1..array_length(function_signatures, 1)
  LOOP
    function_signature := function_signatures[function_index];
    SELECT pg_get_functiondef(function_signature)
      INTO function_definition;
    IF POSITION('referral_response' IN function_definition) = 0 THEN
      SELECT COUNT(*)::integer
        INTO match_count
        FROM regexp_matches(function_definition, rule_pair_pattern, 'g');
      IF match_count IS DISTINCT FROM expected_match_counts[function_index] THEN
        RAISE EXCEPTION
          'Cannot extend task/SLA contract in %: expected % acknowledgement rule anchors, found %',
          function_signature,
          expected_match_counts[function_index],
          match_count;
      END IF;
      function_definition := regexp_replace(
        function_definition,
        rule_pair_pattern,
        extended_rule_pair,
        'g'
      );
      EXECUTE function_definition;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE tasks
  ADD CONSTRAINT chk_tasks_referral_response_resource
  CHECK (
    COALESCE(
      NULLIF(BTRIM(metadata->>'requested_sla_key'), ''),
      NULLIF(BTRIM(metadata->>'sla_key'), '')
    ) IS DISTINCT FROM 'referral_response'
    OR related_resource_type IS NOT DISTINCT FROM 'referrals'
  )
  NOT VALID;

ALTER TABLE tasks
  VALIDATE CONSTRAINT chk_tasks_referral_response_resource;

CREATE TABLE referral_transition_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  referral_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  sequence_number INTEGER NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  from_status VARCHAR(40),
  to_status VARCHAR(40) NOT NULL,
  from_owner_uid UUID,
  to_owner_uid UUID,
  reason TEXT,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  actor_uid UUID,
  actor_role VARCHAR(80),
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  canonical_timeline_event_id UUID NOT NULL,
  canonical_audit_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_referral_transition_events_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_referral_transition_events_sequence
    UNIQUE (tenant_id, referral_id, sequence_number),
  CONSTRAINT fk_referral_transition_events_referral
    FOREIGN KEY (tenant_id, referral_id)
    REFERENCES referrals (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_transition_events_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_transition_events_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_transition_events_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_transition_events_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT chk_referral_transition_events_sequence CHECK (sequence_number > 0),
  CONSTRAINT chk_referral_transition_events_payload CHECK (
    jsonb_typeof(event_payload) = 'object'
  )
);

CREATE INDEX idx_referral_transition_events_referral_time
  ON referral_transition_events
     (tenant_id, referral_id, occurred_at, sequence_number);

CREATE INDEX idx_referral_transition_events_patient_time
  ON referral_transition_events
     (tenant_id, patient_uid, occurred_at DESC);

CREATE TABLE referral_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  referral_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  assessment TEXT NOT NULL,
  recommendations TEXT NOT NULL,
  follow_up_plan TEXT,
  patient_summary TEXT,
  patient_instructions TEXT,
  request_fingerprint CHAR(64) NOT NULL,
  release_to_patient BOOLEAN NOT NULL DEFAULT FALSE,
  continuing_ownership BOOLEAN NOT NULL DEFAULT FALSE,
  signed_by UUID NOT NULL,
  signer_role VARCHAR(80),
  signed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_referral_responses_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_referral_responses_tenant_id_patient UNIQUE (tenant_id, id, patient_uid),
  CONSTRAINT ux_referral_responses_version UNIQUE (tenant_id, referral_id, version),
  CONSTRAINT ux_referral_responses_request
    UNIQUE (tenant_id, referral_id, request_fingerprint),
  CONSTRAINT fk_referral_responses_referral
    FOREIGN KEY (tenant_id, referral_id)
    REFERENCES referrals (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_responses_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_responses_signer
    FOREIGN KEY (tenant_id, signed_by)
    REFERENCES users (tenant_id, uid) ON DELETE RESTRICT,
  CONSTRAINT chk_referral_responses_version CHECK (version > 0),
  CONSTRAINT chk_referral_responses_request_fingerprint CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_referral_responses_clinical_content CHECK (
    NULLIF(BTRIM(assessment), '') IS NOT NULL
    AND NULLIF(BTRIM(recommendations), '') IS NOT NULL
  ),
  CONSTRAINT chk_referral_responses_patient_release CHECK (
    release_to_patient = FALSE
    OR (
      NULLIF(BTRIM(patient_summary), '') IS NOT NULL
      AND NULLIF(BTRIM(patient_instructions), '') IS NOT NULL
    )
  )
);

CREATE INDEX idx_referral_responses_referral_time
  ON referral_responses (tenant_id, referral_id, version DESC);

CREATE INDEX idx_referral_responses_patient_release
  ON referral_responses (tenant_id, patient_uid, signed_at DESC)
  WHERE release_to_patient = TRUE;

CREATE TABLE referral_patient_notifications (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  response_id UUID NOT NULL,
  patient_uid UUID NOT NULL,
  notification_kind VARCHAR(40) NOT NULL,
  notification_outbox_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_referral_patient_notifications_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT ux_referral_patient_notifications_response_kind
    UNIQUE (tenant_id, response_id, notification_kind),
  CONSTRAINT fk_referral_patient_notifications_response
    FOREIGN KEY (tenant_id, response_id, patient_uid)
    REFERENCES referral_responses (tenant_id, id, patient_uid),
  CONSTRAINT fk_referral_patient_notifications_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid),
  CONSTRAINT fk_referral_patient_notifications_outbox
    FOREIGN KEY (tenant_id, notification_outbox_id)
    REFERENCES notification_outbox (tenant_id, id),
  CONSTRAINT chk_referral_patient_notifications_kind CHECK (
    notification_kind = 'referral_response_ready'
  )
);

CREATE INDEX idx_referral_patient_notifications_patient_time
  ON referral_patient_notifications (tenant_id, patient_uid, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION referral_evidence_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.audit_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    '% is append-only: % is not allowed without authorized maintenance bypass',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER trg_referral_transition_events_append_only
BEFORE UPDATE OR DELETE ON referral_transition_events
FOR EACH ROW EXECUTE FUNCTION referral_evidence_block_mutation();

CREATE TRIGGER trg_referral_responses_append_only
BEFORE UPDATE OR DELETE ON referral_responses
FOR EACH ROW EXECUTE FUNCTION referral_evidence_block_mutation();

CREATE TRIGGER trg_referral_patient_notifications_append_only
BEFORE UPDATE OR DELETE ON referral_patient_notifications
FOR EACH ROW EXECUTE FUNCTION referral_evidence_block_mutation();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'referral_transition_events',
    'referral_responses',
    'referral_patient_notifications'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$
      CREATE POLICY tenant_isolation ON %I
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
        )
    $policy$, table_name);
  END LOOP;
END
$$;

COMMENT ON TABLE referral_transition_events IS
  'Append-only, sequence-numbered referral lifecycle transitions linked to canonical timeline and audit evidence.';
COMMENT ON TABLE referral_responses IS
  'Immutable structured specialist responses; integrity signatures are stored in clinical_document_signatures.';
COMMENT ON COLUMN referrals.closure_status IS
  'Closed-loop state distinct from specialist work status; completed does not imply originator closure.';

COMMIT;
