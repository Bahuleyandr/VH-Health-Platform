-- Migration 597: Unified Care Pathways S5 ED closure and recovery evidence.
--
-- Adds append-only, policy-neutral evidence for planned discharge, LAMA,
-- LWBS recovery, external transfer, and death/MLC/mortuary closure. It does
-- not activate the pathway or choose callback, SLA, escalation, visibility,
-- notification, break-glass, or retention policy.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE emergency_visits
  ADD CONSTRAINT ux_emergency_visits_tenant_id UNIQUE (tenant_id, id);

DO $s5_ed_closure_task_kind_preflight$
DECLARE
  invalid_task_kind_count INTEGER;
BEGIN
  SELECT COUNT(*)::integer
    INTO invalid_task_kind_count
    FROM tasks AS task
   WHERE task.task_kind NOT IN (
     'general', 'follow_up', 'review', 'escalation', 'verification',
     'admin', 'consent', 'investigation', 'other',
     'pathway_owner_transfer_review',
     'op_to_inpatient_transfer_review',
     'ed_destination_handoff_review',
     'ed_closure_review'
   );

  IF invalid_task_kind_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'migration 597 blocked: task kinds fall outside the S5 ED closure contract (count=%s)',
        invalid_task_kind_count
      ),
      HINT = 'Reconcile each noncanonical task kind explicitly. This migration never rewrites historical task meaning.';
  END IF;
END
$s5_ed_closure_task_kind_preflight$;

ALTER TABLE tasks
  DROP CONSTRAINT tasks_task_kind_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_task_kind_check
  CHECK (task_kind IN (
    'general', 'follow_up', 'review', 'escalation', 'verification',
    'admin', 'consent', 'investigation', 'other',
    'pathway_owner_transfer_review',
    'op_to_inpatient_transfer_review',
    'ed_destination_handoff_review',
    'ed_closure_review'
  ));

CREATE TABLE ed_closure_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  emergency_visit_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID NOT NULL,
  evidence_revision INTEGER NOT NULL,
  closure_kind VARCHAR(40) NOT NULL,
  clinician_uid UUID NOT NULL,
  follow_up_required BOOLEAN NOT NULL,
  follow_up_plan_id INTEGER,
  no_follow_up_reason TEXT,
  patient_safe_next_steps JSONB NOT NULL,
  medication_reconciliation_id UUID,
  medication_not_applicable_reason TEXT,
  risk_classification_code VARCHAR(80),
  risk_summary TEXT,
  accepted_handoff_id UUID,
  receiving_facility_name VARCHAR(240),
  receiving_facility_reference VARCHAR(160),
  receiving_confirmed_by VARCHAR(240),
  receiving_confirmed_at TIMESTAMPTZ(6),
  clinical_summary_resource_type VARCHAR(80),
  clinical_summary_resource_id VARCHAR(160),
  clinical_summary_sent_at TIMESTAMPTZ(6),
  ambulance_request_id INTEGER,
  transport_reference VARCHAR(160),
  transport_confirmed_at TIMESTAMPTZ(6),
  death_record_id INTEGER,
  mlc_record_id INTEGER,
  identity_resolution_status VARCHAR(40) NOT NULL,
  identity_resolution_reason TEXT,
  patient_merge_request_id INTEGER,
  patient_visibility_status VARCHAR(30) NOT NULL,
  canonical_timeline_event_id UUID NOT NULL,
  canonical_audit_event_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(220) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT ux_ed_closure_evidence_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ed_closure_evidence_revision
    UNIQUE (tenant_id, emergency_visit_id, evidence_revision),
  CONSTRAINT ux_ed_closure_evidence_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_ed_closure_evidence_visit
    FOREIGN KEY (tenant_id, emergency_visit_id)
    REFERENCES emergency_visits (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_clinician
    FOREIGN KEY (tenant_id, clinician_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_encounter
    FOREIGN KEY (tenant_id, encounter_id, patient_uid)
    REFERENCES patient_encounters (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_follow_up
    FOREIGN KEY (tenant_id, follow_up_plan_id, patient_uid)
    REFERENCES follow_up_plans (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_medication_reconciliation
    FOREIGN KEY (medication_reconciliation_id)
    REFERENCES medication_reconciliations (id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_handoff
    FOREIGN KEY (tenant_id, accepted_handoff_id, patient_uid)
    REFERENCES care_handoff_instances (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_ambulance
    FOREIGN KEY (ambulance_request_id)
    REFERENCES ambulance_requests (id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_death
    FOREIGN KEY (death_record_id)
    REFERENCES death_records (id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_mlc
    FOREIGN KEY (mlc_record_id)
    REFERENCES mlc_records (id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_merge
    FOREIGN KEY (patient_merge_request_id)
    REFERENCES patient_merge_requests (id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_closure_evidence_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_ed_closure_evidence_revision CHECK (
    evidence_revision > 0
  ),
  CONSTRAINT chk_ed_closure_evidence_kind CHECK (
    closure_kind IN (
      'discharge',
      'left_against_medical_advice',
      'lwbs',
      'external_transfer',
      'death'
    )
  ),
  CONSTRAINT chk_ed_closure_evidence_next_steps CHECK (
    jsonb_typeof(patient_safe_next_steps) = 'array'
    AND (
      closure_kind = 'death'
      OR jsonb_array_length(patient_safe_next_steps) > 0
    )
  ),
  CONSTRAINT chk_ed_closure_evidence_follow_up CHECK (
    (
      closure_kind = 'death'
      AND NOT follow_up_required
      AND follow_up_plan_id IS NULL
      AND no_follow_up_reason IS NULL
    )
    OR
    (
      closure_kind <> 'death'
      AND (
        (
          follow_up_required
          AND follow_up_plan_id IS NOT NULL
          AND no_follow_up_reason IS NULL
        )
        OR
        (
          NOT follow_up_required
          AND follow_up_plan_id IS NULL
          AND NULLIF(BTRIM(no_follow_up_reason), '') IS NOT NULL
        )
      )
    )
  ),
  CONSTRAINT chk_ed_closure_evidence_medication CHECK (
    (
      closure_kind = 'death'
      AND medication_reconciliation_id IS NULL
      AND medication_not_applicable_reason IS NULL
    )
    OR
    (
      closure_kind <> 'death'
      AND (
        (
          medication_reconciliation_id IS NOT NULL
          AND medication_not_applicable_reason IS NULL
        )
        OR
        (
          medication_reconciliation_id IS NULL
          AND NULLIF(BTRIM(medication_not_applicable_reason), '') IS NOT NULL
        )
      )
    )
  ),
  CONSTRAINT chk_ed_closure_evidence_risk CHECK (
    (
      closure_kind IN ('left_against_medical_advice', 'lwbs')
      AND NULLIF(BTRIM(risk_classification_code), '') IS NOT NULL
      AND NULLIF(BTRIM(risk_summary), '') IS NOT NULL
    )
    OR
    (
      closure_kind NOT IN ('left_against_medical_advice', 'lwbs')
      AND risk_classification_code IS NULL
      AND risk_summary IS NULL
    )
  ),
  CONSTRAINT chk_ed_closure_evidence_external_transfer CHECK (
    (
      closure_kind = 'external_transfer'
      AND accepted_handoff_id IS NOT NULL
      AND NULLIF(BTRIM(receiving_facility_name), '') IS NOT NULL
      AND NULLIF(BTRIM(receiving_confirmed_by), '') IS NOT NULL
      AND receiving_confirmed_at IS NOT NULL
      AND NULLIF(BTRIM(clinical_summary_resource_type), '') IS NOT NULL
      AND NULLIF(BTRIM(clinical_summary_resource_id), '') IS NOT NULL
      AND clinical_summary_sent_at IS NOT NULL
      AND (
        ambulance_request_id IS NOT NULL
        OR NULLIF(BTRIM(transport_reference), '') IS NOT NULL
      )
      AND transport_confirmed_at IS NOT NULL
    )
    OR
    (
      closure_kind <> 'external_transfer'
      AND accepted_handoff_id IS NULL
      AND receiving_facility_name IS NULL
      AND receiving_facility_reference IS NULL
      AND receiving_confirmed_by IS NULL
      AND receiving_confirmed_at IS NULL
      AND clinical_summary_resource_type IS NULL
      AND clinical_summary_resource_id IS NULL
      AND clinical_summary_sent_at IS NULL
      AND ambulance_request_id IS NULL
      AND transport_reference IS NULL
      AND transport_confirmed_at IS NULL
    )
  ),
  CONSTRAINT chk_ed_closure_evidence_death CHECK (
    (
      closure_kind = 'death'
      AND death_record_id IS NOT NULL
    )
    OR
    (
      closure_kind <> 'death'
      AND death_record_id IS NULL
      AND mlc_record_id IS NULL
    )
  ),
  CONSTRAINT chk_ed_closure_evidence_identity CHECK (
    identity_resolution_status IN (
      'verified',
      'temporary_identity_retained',
      'merge_requested',
      'merged'
    )
    AND (
      (
        identity_resolution_status = 'verified'
        AND identity_resolution_reason IS NULL
        AND patient_merge_request_id IS NULL
      )
      OR
      (
        identity_resolution_status = 'temporary_identity_retained'
        AND NULLIF(BTRIM(identity_resolution_reason), '') IS NOT NULL
        AND patient_merge_request_id IS NULL
      )
      OR
      (
        identity_resolution_status IN ('merge_requested', 'merged')
        AND patient_merge_request_id IS NOT NULL
      )
    )
  ),
  CONSTRAINT chk_ed_closure_evidence_visibility CHECK (
    patient_visibility_status IN ('hidden', 'released')
    AND (
      closure_kind IN ('discharge', 'left_against_medical_advice', 'lwbs')
      OR patient_visibility_status = 'hidden'
    )
  ),
  CONSTRAINT chk_ed_closure_evidence_nonblank CHECK (
    NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
    AND jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX idx_ed_closure_evidence_visit
  ON ed_closure_evidence (
    tenant_id,
    emergency_visit_id,
    evidence_revision DESC
  );

CREATE INDEX idx_ed_closure_evidence_patient
  ON ed_closure_evidence (
    tenant_id,
    patient_uid,
    occurred_at DESC
  );

CREATE TABLE ed_recovery_contact_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  emergency_visit_id INTEGER NOT NULL,
  closure_evidence_id UUID NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID NOT NULL,
  event_kind VARCHAR(30) NOT NULL,
  contact_channel VARCHAR(30) NOT NULL,
  outcome_code VARCHAR(80),
  patient_safe_summary TEXT,
  staff_notes TEXT,
  recorded_by_uid UUID NOT NULL,
  canonical_timeline_event_id UUID NOT NULL,
  canonical_audit_event_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(220) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT ux_ed_recovery_contact_events_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_ed_recovery_contact_events_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_ed_recovery_contact_events_visit
    FOREIGN KEY (tenant_id, emergency_visit_id)
    REFERENCES emergency_visits (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_recovery_contact_events_closure
    FOREIGN KEY (tenant_id, closure_evidence_id)
    REFERENCES ed_closure_evidence (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_recovery_contact_events_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_recovery_contact_events_encounter
    FOREIGN KEY (tenant_id, encounter_id, patient_uid)
    REFERENCES patient_encounters (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_recovery_contact_events_actor
    FOREIGN KEY (tenant_id, recorded_by_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_recovery_contact_events_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_ed_recovery_contact_events_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_ed_recovery_contact_events_kind CHECK (
    event_kind IN ('attempt', 'outcome')
  ),
  CONSTRAINT chk_ed_recovery_contact_events_channel CHECK (
    contact_channel IN (
      'phone',
      'sms',
      'email',
      'patient_portal',
      'in_person',
      'video',
      'other'
    )
  ),
  CONSTRAINT chk_ed_recovery_contact_events_outcome CHECK (
    (
      event_kind = 'attempt'
      AND outcome_code IS NULL
    )
    OR
    (
      event_kind = 'outcome'
      AND NULLIF(BTRIM(outcome_code), '') IS NOT NULL
    )
  ),
  CONSTRAINT chk_ed_recovery_contact_events_nonblank CHECK (
    NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
    AND jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX idx_ed_recovery_contact_events_visit
  ON ed_recovery_contact_events (
    tenant_id,
    emergency_visit_id,
    occurred_at DESC,
    id DESC
  );

CREATE INDEX idx_ed_recovery_contact_events_patient
  ON ed_recovery_contact_events (
    tenant_id,
    patient_uid,
    occurred_at DESC
  );

CREATE OR REPLACE FUNCTION s5_validate_ed_closure_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  visit_record RECORD;
  follow_up_record RECORD;
  medication_record RECORD;
  handoff_record RECORD;
  death_record RECORD;
  mlc_record RECORD;
  merge_record RECORD;
  timeline_record RECORD;
  audit_record RECORD;
BEGIN
  SELECT visit.patient_uid,
         visit.encounter_id,
         visit.attending_doctor_uid,
         visit.is_mlc,
         patient.is_unidentified
    INTO visit_record
    FROM emergency_visits AS visit
    JOIN users AS patient
      ON patient.tenant_id = visit.tenant_id
     AND patient.uid = visit.patient_uid
   WHERE visit.tenant_id = NEW.tenant_id
     AND visit.id = NEW.emergency_visit_id
   FOR SHARE OF visit, patient;

  IF NOT FOUND
     OR visit_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR visit_record.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR visit_record.attending_doctor_uid IS DISTINCT FROM NEW.clinician_uid
     OR NOT care_pathway_named_clinician_is_viable(
              NEW.tenant_id,
              NEW.clinician_uid
            )
  THEN
    RAISE EXCEPTION
      'ED closure evidence requires its exact visit, patient, encounter, and viable named ED clinician'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.identity_resolution_status = 'verified'
     AND visit_record.is_unidentified
  THEN
    RAISE EXCEPTION
      'verified ED identity evidence requires the patient registry identity to be resolved'
      USING ERRCODE = 'check_violation';
  ELSIF NEW.identity_resolution_status = 'temporary_identity_retained'
        AND NOT visit_record.is_unidentified
  THEN
    RAISE EXCEPTION
      'temporary identity retention is only valid for an unresolved patient registry identity'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.follow_up_plan_id IS NOT NULL THEN
    SELECT plan.origin_kind,
           plan.origin_resource_type,
           plan.origin_resource_id,
           plan.status
      INTO follow_up_record
      FROM follow_up_plans AS plan
     WHERE plan.tenant_id = NEW.tenant_id
       AND plan.id = NEW.follow_up_plan_id
       AND plan.patient_uid = NEW.patient_uid
     FOR SHARE;

    IF NOT FOUND
       OR follow_up_record.origin_kind IS DISTINCT FROM 'er_visit'
       OR follow_up_record.origin_resource_type IS DISTINCT FROM
            'emergency_visit'
       OR follow_up_record.origin_resource_id IS DISTINCT FROM
            NEW.emergency_visit_id::text
       OR follow_up_record.status NOT IN ('open', 'scheduled', 'overdue')
    THEN
      RAISE EXCEPTION
        'ED closure follow-up must be an actionable plan from the exact emergency visit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.medication_reconciliation_id IS NOT NULL THEN
    SELECT reconciliation.tenant_id,
           reconciliation.patient_uid,
           reconciliation.encounter_id,
           reconciliation.rec_type,
           reconciliation.status,
           reconciliation.completed_by,
           reconciliation.completed_at
      INTO medication_record
      FROM medication_reconciliations AS reconciliation
     WHERE reconciliation.id = NEW.medication_reconciliation_id
     FOR SHARE;

    IF NOT FOUND
       OR medication_record.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR medication_record.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR medication_record.encounter_id IS DISTINCT FROM NEW.encounter_id
       OR medication_record.rec_type IS DISTINCT FROM 'discharge'
       OR medication_record.status IS DISTINCT FROM 'completed'
       OR medication_record.completed_by IS NULL
       OR medication_record.completed_at IS NULL
    THEN
      RAISE EXCEPTION
        'ED closure medication reconciliation must be the exact completed discharge reconciliation'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.accepted_handoff_id IS NOT NULL THEN
    SELECT handoff.status,
           handoff.source_resource_type,
           handoff.source_resource_id,
           handoff.accepted_at,
           handoff.metadata ->> 'destination' AS destination
      INTO handoff_record
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.id = NEW.accepted_handoff_id
       AND handoff.patient_uid = NEW.patient_uid
     FOR SHARE;

    IF NOT FOUND
       OR handoff_record.status IS DISTINCT FROM 'accepted'
       OR handoff_record.accepted_at IS NULL
       OR handoff_record.source_resource_type IS DISTINCT FROM
            'emergency_visit'
       OR handoff_record.source_resource_id IS DISTINCT FROM
            NEW.emergency_visit_id::text
       OR handoff_record.destination IS DISTINCT FROM 'external_transfer'
    THEN
      RAISE EXCEPTION
        'external ED closure requires the exact accepted external-transfer handoff'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.ambulance_request_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM ambulance_requests AS request
        WHERE request.id = NEW.ambulance_request_id
          AND request.tenant_id = NEW.tenant_id
          AND (
            request.patient_uid IS NULL
            OR request.patient_uid = NEW.patient_uid
          )
     )
  THEN
    RAISE EXCEPTION
      'external ED closure ambulance must belong to the same tenant and patient'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.death_record_id IS NOT NULL THEN
    SELECT record.tenant_id,
           record.patient_uid,
           record.is_medicolegal
      INTO death_record
      FROM death_records AS record
     WHERE record.id = NEW.death_record_id
     FOR SHARE;

    IF NOT FOUND
       OR death_record.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR death_record.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR death_record.is_medicolegal IS DISTINCT FROM visit_record.is_mlc
    THEN
      RAISE EXCEPTION
        'ED death closure requires the exact same-patient death record and medico-legal state'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF visit_record.is_mlc AND NEW.closure_kind = 'death' THEN
    IF NEW.mlc_record_id IS NULL THEN
      RAISE EXCEPTION
        'medico-legal ED death closure requires its exact MLC record'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.mlc_record_id IS NOT NULL THEN
    RAISE EXCEPTION
      'MLC closure evidence is only valid for a medico-legal ED death'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.mlc_record_id IS NOT NULL THEN
    SELECT record.tenant_id,
           record.patient_uid,
           record.emergency_visit_id
      INTO mlc_record
      FROM mlc_records AS record
     WHERE record.id = NEW.mlc_record_id
     FOR SHARE;

    IF NOT FOUND
       OR mlc_record.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR mlc_record.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR mlc_record.emergency_visit_id IS DISTINCT FROM
            NEW.emergency_visit_id
    THEN
      RAISE EXCEPTION
        'ED death closure MLC record must belong to the exact visit and patient'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.patient_merge_request_id IS NOT NULL THEN
    SELECT request.primary_uid,
           request.secondary_uid,
           request.status
      INTO merge_record
      FROM patient_merge_requests AS request
     WHERE request.tenant_id = NEW.tenant_id
       AND request.id = NEW.patient_merge_request_id
     FOR SHARE;

    IF NOT FOUND
       OR NEW.patient_uid NOT IN (
            merge_record.primary_uid,
            merge_record.secondary_uid
          )
       OR (
         NEW.identity_resolution_status = 'merge_requested'
         AND merge_record.status NOT IN ('requested', 'approved')
       )
       OR (
         NEW.identity_resolution_status = 'merged'
         AND merge_record.status <> 'executed'
       )
    THEN
      RAISE EXCEPTION
        'ED identity evidence requires the exact patient merge request and state'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT timeline.patient_uid,
         timeline.encounter_id,
         timeline.event_type,
         timeline.source_table,
         timeline.source_id
    INTO timeline_record
    FROM clinical_timeline_events AS timeline
   WHERE timeline.tenant_id = NEW.tenant_id
     AND timeline.id = NEW.canonical_timeline_event_id
   FOR SHARE;

  SELECT audit.patient_uid,
         audit.encounter_id,
         audit.action,
         audit.resource_table,
         audit.resource_id
    INTO audit_record
    FROM clinical_audit_events AS audit
   WHERE audit.tenant_id = NEW.tenant_id
     AND audit.id = NEW.canonical_audit_event_id
   FOR SHARE;

  IF timeline_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR timeline_record.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR timeline_record.event_type <> 'emergency.closure_evidence_recorded'
     OR timeline_record.source_table <> 'ed_closure_evidence'
     OR timeline_record.source_id <> NEW.id::text
     OR audit_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR audit_record.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR audit_record.action <> 'emergency.closure_evidence_recorded'
     OR audit_record.resource_table <> 'ed_closure_evidence'
     OR audit_record.resource_id <> NEW.id::text
  THEN
    RAISE EXCEPTION
      'ED closure evidence requires exact same-patient canonical timeline and audit records'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ed_closure_evidence_validate
BEFORE INSERT ON ed_closure_evidence
FOR EACH ROW EXECUTE FUNCTION s5_validate_ed_closure_evidence();

CREATE OR REPLACE FUNCTION s5_validate_ed_recovery_contact_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  closure_record RECORD;
  timeline_record RECORD;
  audit_record RECORD;
BEGIN
  SELECT closure.emergency_visit_id,
         closure.patient_uid,
         closure.encounter_id,
         closure.closure_kind,
         closure.clinician_uid
    INTO closure_record
    FROM ed_closure_evidence AS closure
   WHERE closure.tenant_id = NEW.tenant_id
     AND closure.id = NEW.closure_evidence_id
   FOR SHARE;

  IF NOT FOUND
     OR closure_record.emergency_visit_id IS DISTINCT FROM
          NEW.emergency_visit_id
     OR closure_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR closure_record.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR closure_record.closure_kind NOT IN (
          'left_against_medical_advice',
          'lwbs'
        )
     OR closure_record.clinician_uid IS DISTINCT FROM NEW.recorded_by_uid
  THEN
    RAISE EXCEPTION
      'ED recovery evidence requires the latest exact LAMA/LWBS closure and named clinician'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM ed_closure_evidence AS successor
     WHERE successor.tenant_id = NEW.tenant_id
       AND successor.emergency_visit_id = NEW.emergency_visit_id
       AND successor.evidence_revision > (
         SELECT current.evidence_revision
           FROM ed_closure_evidence AS current
          WHERE current.tenant_id = NEW.tenant_id
            AND current.id = NEW.closure_evidence_id
       )
  ) THEN
    RAISE EXCEPTION
      'ED recovery evidence must reference the latest closure revision'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.event_kind = 'outcome'
     AND NOT EXISTS (
       SELECT 1
         FROM ed_recovery_contact_events AS attempt
        WHERE attempt.tenant_id = NEW.tenant_id
          AND attempt.emergency_visit_id = NEW.emergency_visit_id
          AND attempt.closure_evidence_id = NEW.closure_evidence_id
          AND attempt.event_kind = 'attempt'
     )
  THEN
    RAISE EXCEPTION
      'ED recovery outcome requires at least one recorded contact attempt'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT timeline.patient_uid,
         timeline.encounter_id,
         timeline.event_type,
         timeline.source_table,
         timeline.source_id
    INTO timeline_record
    FROM clinical_timeline_events AS timeline
   WHERE timeline.tenant_id = NEW.tenant_id
     AND timeline.id = NEW.canonical_timeline_event_id
   FOR SHARE;

  SELECT audit.patient_uid,
         audit.encounter_id,
         audit.action,
         audit.resource_table,
         audit.resource_id
    INTO audit_record
    FROM clinical_audit_events AS audit
   WHERE audit.tenant_id = NEW.tenant_id
     AND audit.id = NEW.canonical_audit_event_id
   FOR SHARE;

  IF timeline_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR timeline_record.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR timeline_record.event_type <> 'emergency.recovery_contact_recorded'
     OR timeline_record.source_table <> 'ed_recovery_contact_events'
     OR timeline_record.source_id <> NEW.id::text
     OR audit_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR audit_record.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR audit_record.action <> 'emergency.recovery_contact_recorded'
     OR audit_record.resource_table <> 'ed_recovery_contact_events'
     OR audit_record.resource_id <> NEW.id::text
  THEN
    RAISE EXCEPTION
      'ED recovery evidence requires exact same-patient canonical timeline and audit records'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ed_recovery_contact_events_validate
BEFORE INSERT ON ed_recovery_contact_events
FOR EACH ROW EXECUTE FUNCTION s5_validate_ed_recovery_contact_event();

CREATE OR REPLACE FUNCTION s5_ed_closure_task_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  visit_id INTEGER;
  pathway_id UUID;
  binding RECORD;
BEGIN
  IF NEW.task_kind <> 'ed_closure_review' THEN
    RETURN NEW;
  END IF;

  IF NEW.related_resource_type IS DISTINCT FROM 'emergency_visit_closure'
     OR NEW.related_resource_id !~ '^[1-9][0-9]*$'
     OR NOT pg_input_is_valid(NEW.related_resource_id, 'integer')
     OR NEW.metadata ->> 'care_pathway_instance_id' !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION
      'ED closure review task requires an exact visit and pathway binding'
      USING ERRCODE = 'check_violation';
  END IF;

  visit_id := NEW.related_resource_id::integer;
  pathway_id := (NEW.metadata ->> 'care_pathway_instance_id')::uuid;

  SELECT visit.patient_uid,
         visit.encounter_id,
         visit.attending_doctor_uid,
         pathway.id AS pathway_id,
         pathway.patient_uid AS pathway_patient_uid,
         pathway.encounter_id AS pathway_encounter_id,
         pathway.pathway_key,
         pathway.pathway_version,
         pathway.source_episode_type,
         pathway.source_episode_id,
         pathway.owning_clinician_uid
    INTO binding
    FROM emergency_visits AS visit
    LEFT JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = visit.tenant_id
     AND pathway.id = pathway_id
   WHERE visit.tenant_id = NEW.tenant_id
     AND visit.id = visit_id;

  IF NOT FOUND
     OR binding.attending_doctor_uid IS NULL
     OR binding.pathway_id IS NULL
     OR binding.pathway_key <> 'emergency_arrival_to_aftercare'
     OR binding.pathway_version <> 2
     OR binding.source_episode_type <> 'emergency_visit'
     OR binding.source_episode_id <> visit_id::text
     OR binding.pathway_patient_uid IS DISTINCT FROM binding.patient_uid
     OR binding.pathway_encounter_id IS DISTINCT FROM binding.encounter_id
     OR binding.owning_clinician_uid IS DISTINCT FROM
          binding.attending_doctor_uid
     OR NEW.patient_uid IS DISTINCT FROM binding.patient_uid
     OR NEW.encounter_id IS NOT NULL
     OR NEW.workflow_run_id IS NOT NULL
     OR NEW.workflow_step_id IS NOT NULL
     OR NEW.parent_task_id IS NOT NULL
     OR NEW.priority <> 'normal'
     OR NEW.assigned_to_uid IS DISTINCT FROM binding.attending_doctor_uid
     OR NEW.assigned_to_role IS NOT NULL
     OR NEW.due_at IS NOT NULL
     OR NEW.sla_definition_id IS NOT NULL
     OR NEW.workflow_sla_instance_id IS NOT NULL
     OR NEW.sla_completion_semantics <> 'none'
     OR NEW.sla_breached_at IS NOT NULL
     OR NEW.metadata ->> 'task_contract' IS DISTINCT FROM
          'ed_closure_review_v1'
     OR NEW.metadata ->> 'emergency_visit_id' IS DISTINCT FROM
          visit_id::text
     OR NEW.metadata ->> 'canonical_encounter_id' IS DISTINCT FROM
          binding.encounter_id::text
     OR NEW.metadata ->> 'care_pathway_instance_id' IS DISTINCT FROM
          binding.pathway_id::text
     OR NEW.metadata ->> 'created_by_system_key' IS DISTINCT FROM
          'emergency.pathway_projector.v2'
  THEN
    RAISE EXCEPTION
      'ED closure review task binding is noncanonical'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_s5_ed_closure_reserved_domain_binding
AFTER INSERT OR UPDATE ON tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s5_ed_closure_task_constraint();

CREATE OR REPLACE FUNCTION s5_enforce_ed_closure_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pathway_mode TEXT;
  required_kind TEXT;
  accepted_destination TEXT;
BEGIN
  SELECT COALESCE(
           tenant.settings #>>
             '{care_pathways,emergency_arrival_to_aftercare}',
           'off'
         )
    INTO pathway_mode
    FROM tenants AS tenant
   WHERE tenant.id = NEW.tenant_id;

  IF pathway_mode <> 'active' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'discharged' THEN
    required_kind := 'discharge';
  ELSIF NEW.status = 'left_against_advice' THEN
    required_kind := 'left_against_medical_advice';
  ELSIF NEW.status = 'transferred' THEN
    SELECT handoff.metadata ->> 'destination'
      INTO accepted_destination
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.patient_uid = NEW.patient_uid
       AND handoff.handoff_type = 'ed_destination_handoff'
       AND handoff.source_resource_type = 'emergency_visit'
       AND handoff.source_resource_id = NEW.id::text
       AND handoff.status = 'accepted'
     ORDER BY handoff.accepted_at DESC, handoff.id DESC
     LIMIT 1;

    IF accepted_destination = 'external_transfer' THEN
      required_kind := 'external_transfer';
    END IF;
  END IF;

  IF required_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM ed_closure_evidence AS evidence
     WHERE evidence.tenant_id = NEW.tenant_id
       AND evidence.emergency_visit_id = NEW.id
       AND evidence.patient_uid = NEW.patient_uid
       AND evidence.encounter_id = NEW.encounter_id
       AND evidence.closure_kind = required_kind
       AND evidence.evidence_revision = (
         SELECT MAX(latest.evidence_revision)
           FROM ed_closure_evidence AS latest
          WHERE latest.tenant_id = NEW.tenant_id
            AND latest.emergency_visit_id = NEW.id
       )
  ) THEN
    RAISE EXCEPTION
      'active ED planned closure requires the exact latest branch closure evidence'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_emergency_visits_s5_closure_evidence
AFTER INSERT OR UPDATE OF status, disposition ON emergency_visits
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s5_enforce_ed_closure_evidence();

CREATE TRIGGER trg_ed_closure_evidence_append_only
BEFORE UPDATE OR DELETE ON ed_closure_evidence
FOR EACH ROW EXECUTE FUNCTION s4_care_pathway_evidence_block_mutation();

CREATE TRIGGER trg_ed_recovery_contact_events_append_only
BEFORE UPDATE OR DELETE ON ed_recovery_contact_events
FOR EACH ROW EXECUTE FUNCTION s4_care_pathway_evidence_block_mutation();

DO $s5_ed_closure_tenant_rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ed_closure_evidence',
    'ed_recovery_contact_events'
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
$s5_ed_closure_tenant_rls$;

COMMENT ON TABLE ed_closure_evidence IS
  'Append-only revisioned clinician evidence for ED discharge, LAMA, LWBS, external transfer, and death closure.';
COMMENT ON TABLE ed_recovery_contact_events IS
  'Append-only policy-neutral LAMA/LWBS contact attempt and clinician outcome evidence; no embedded timer or attempt threshold.';

-- Preserve the migration-596 validator verbatim for version-1 replay, then
-- dispatch version-2 rows to an exact validator for the new runtime pin.
ALTER FUNCTION s5_assert_ed_destination_handoff(UUID, UUID)
  RENAME TO s5_assert_ed_destination_handoff_v1;

CREATE OR REPLACE FUNCTION s5_assert_ed_destination_handoff_v2(
  target_tenant_id UUID,
  target_handoff_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  transfer RECORD;
  actor_role TEXT;
  predecessor RECORD;
BEGIN
  SELECT handoff.*,
         pathway.id AS pathway_id,
         pathway.pathway_key,
         pathway.pathway_version,
         pathway.source_episode_type,
         pathway.source_episode_id AS pathway_visit_id,
         pathway.patient_uid AS pathway_patient_uid,
         pathway.workflow_run_id AS pathway_run_id,
         pathway.owning_clinician_uid AS pathway_owner_uid,
         run.workflow_key,
         run.workflow_version,
         step.id AS step_id,
         task.id AS bound_task_id,
         task.task_kind,
         task.patient_uid AS task_patient_uid,
         task.encounter_id AS task_encounter_id,
         task.workflow_run_id AS task_workflow_run_id,
         task.workflow_step_id AS task_workflow_step_id,
         task.related_resource_type AS task_resource_type,
         task.related_resource_id AS task_resource_id,
         task.priority AS task_priority,
         task.status AS task_status,
         task.completed_at AS task_completed_at,
         task.cancelled_at AS task_cancelled_at,
         task.cancellation_reason AS task_cancellation_reason,
         task.assigned_to_uid AS task_owner_uid,
         task.assigned_to_role AS task_owner_role,
         task.due_at AS task_due_at,
         task.sla_definition_id AS task_sla_definition_id,
         task.workflow_sla_instance_id AS task_sla_instance_id,
         task.sla_completion_semantics AS task_sla_completion_semantics,
         task.sla_breached_at AS task_sla_breached_at,
         task.metadata AS task_metadata,
         visit.patient_uid AS visit_patient_uid,
         visit.encounter_id AS visit_encounter_id,
         visit.attending_doctor_uid
    INTO transfer
    FROM care_handoff_instances AS handoff
    LEFT JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = handoff.tenant_id
     AND pathway.id = handoff.sending_pathway_instance_id
     AND pathway.patient_uid = handoff.patient_uid
     AND pathway.workflow_run_id = handoff.sending_workflow_run_id
    LEFT JOIN workflow_runs AS run
      ON run.tenant_id = pathway.tenant_id
     AND run.id = pathway.workflow_run_id
    LEFT JOIN workflow_steps AS step
      ON step.tenant_id = handoff.tenant_id
     AND step.workflow_run_id = handoff.sending_workflow_run_id
     AND step.step_key = handoff.sending_step_key
    LEFT JOIN tasks AS task
      ON task.tenant_id = handoff.tenant_id
     AND task.id = handoff.task_id
    LEFT JOIN emergency_visits AS visit
      ON visit.tenant_id = handoff.tenant_id
     AND visit.id::text = handoff.source_resource_id
   WHERE handoff.tenant_id = target_tenant_id
     AND handoff.id = target_handoff_id
     AND handoff.handoff_type = 'ed_destination_handoff';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF transfer.pathway_id IS NULL
     OR transfer.pathway_key <> 'emergency_arrival_to_aftercare'
     OR transfer.pathway_version <> 2
     OR transfer.source_episode_type <> 'emergency_visit'
     OR transfer.pathway_visit_id <> transfer.source_resource_id
     OR transfer.pathway_patient_uid IS DISTINCT FROM transfer.patient_uid
     OR transfer.pathway_run_id IS DISTINCT FROM
          transfer.sending_workflow_run_id
     OR transfer.workflow_key <> 'emergency_arrival_to_aftercare'
     OR transfer.workflow_version <> 2
     OR transfer.step_id IS NULL
     OR transfer.bound_task_id IS NULL
     OR transfer.visit_patient_uid IS DISTINCT FROM transfer.patient_uid
     OR transfer.visit_encounter_id IS NULL
     OR transfer.attending_doctor_uid IS DISTINCT FROM transfer.sender_uid
     OR transfer.pathway_owner_uid IS DISTINCT FROM transfer.sender_uid
     OR transfer.metadata ->> 'registry_version' <> '6'
  THEN
    RAISE EXCEPTION
      'ED destination handoff requires its exact version-2 pathway, visit, patient, owner, step, and review task'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.task_kind <> 'ed_destination_handoff_review'
     OR transfer.task_patient_uid IS DISTINCT FROM transfer.patient_uid
     OR transfer.task_encounter_id IS NOT NULL
     OR transfer.task_workflow_run_id IS NOT NULL
     OR transfer.task_workflow_step_id IS NOT NULL
     OR transfer.task_resource_type IS DISTINCT FROM
          'care_handoff_instance'
     OR transfer.task_resource_id IS DISTINCT FROM transfer.id::text
     OR transfer.task_priority <> 'high'
     OR transfer.task_owner_uid IS NOT NULL
     OR transfer.task_owner_role IS DISTINCT FROM
          transfer.intended_recipient_role
     OR transfer.task_due_at IS NOT NULL
     OR transfer.task_sla_definition_id IS NOT NULL
     OR transfer.task_sla_instance_id IS NOT NULL
     OR transfer.task_sla_completion_semantics <> 'none'
     OR transfer.task_sla_breached_at IS NOT NULL
     OR transfer.task_metadata ->> 'task_contract' IS DISTINCT FROM
          'ed_destination_handoff_review_v1'
     OR transfer.task_metadata ->> 'care_pathway_instance_id'
          IS DISTINCT FROM transfer.pathway_id::text
     OR transfer.task_metadata ->> 'emergency_visit_id'
          IS DISTINCT FROM transfer.source_resource_id
     OR transfer.task_metadata ->> 'canonical_encounter_id'
          IS DISTINCT FROM transfer.visit_encounter_id::text
     OR transfer.task_metadata ->> 'destination'
          IS DISTINCT FROM transfer.metadata ->> 'destination'
     OR transfer.task_metadata ->> 'request_fingerprint'
          IS DISTINCT FROM transfer.request_fingerprint
  THEN
    RAISE EXCEPTION
      'ED destination handoff review task binding is noncanonical'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.status = 'requested'
     AND transfer.task_status NOT IN (
       'open', 'in_progress', 'blocked', 'overdue'
     )
  THEN
    RAISE EXCEPTION
      'requested ED destination handoff requires an actionable role task'
      USING ERRCODE = 'check_violation';
  ELSIF transfer.status = 'accepted' THEN
    SELECT UPPER(BTRIM(role))
      INTO actor_role
      FROM users
     WHERE tenant_id = target_tenant_id
       AND uid = transfer.accepted_by_uid
       AND is_active
       AND status = 'active'
       AND NOT is_deleted
       AND deleted_at IS NULL;

    IF transfer.task_status <> 'completed'
       OR actor_role IS DISTINCT FROM transfer.intended_recipient_role
    THEN
      RAISE EXCEPTION
        'accepted ED destination handoff requires a completed task and an active exact-role accepter'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF transfer.status = 'declined'
        AND (
          transfer.task_status <> 'cancelled'
          OR NULLIF(BTRIM(transfer.task_cancellation_reason), '') IS NULL
        )
  THEN
    RAISE EXCEPTION
      'declined ED destination handoff requires a cancelled task with reason'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.metadata ? 'supersedes_handoff_id' THEN
    SELECT candidate.status,
           candidate.sender_uid,
           candidate.source_resource_id,
           candidate.reroute_reason,
           candidate.metadata ->> 'rerouted_to_handoff_id' AS successor_id
      INTO predecessor
      FROM care_handoff_instances AS candidate
     WHERE candidate.tenant_id = target_tenant_id
       AND candidate.id =
             (transfer.metadata ->> 'supersedes_handoff_id')::uuid
       AND candidate.handoff_type = 'ed_destination_handoff';

    IF NOT FOUND
       OR predecessor.status <> 'declined'
       OR predecessor.sender_uid IS DISTINCT FROM transfer.sender_uid
       OR predecessor.source_resource_id IS DISTINCT FROM
            transfer.source_resource_id
       OR NULLIF(BTRIM(predecessor.reroute_reason), '') IS NULL
       OR predecessor.successor_id IS DISTINCT FROM transfer.id::text
    THEN
      RAISE EXCEPTION
        'rerouted ED destination handoff requires its exact declined predecessor'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION s5_assert_ed_destination_handoff(
  target_tenant_id UUID,
  target_handoff_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  runtime_version INTEGER;
BEGIN
  SELECT pathway.pathway_version
    INTO runtime_version
    FROM care_handoff_instances AS handoff
    JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = handoff.tenant_id
     AND pathway.id = handoff.sending_pathway_instance_id
   WHERE handoff.tenant_id = target_tenant_id
     AND handoff.id = target_handoff_id
     AND handoff.handoff_type = 'ed_destination_handoff';

  IF NOT FOUND THEN
    RETURN;
  ELSIF runtime_version = 1 THEN
    PERFORM s5_assert_ed_destination_handoff_v1(
      target_tenant_id,
      target_handoff_id
    );
  ELSIF runtime_version = 2 THEN
    PERFORM s5_assert_ed_destination_handoff_v2(
      target_tenant_id,
      target_handoff_id
    );
  ELSE
    RAISE EXCEPTION
      'ED destination handoff runtime version is unsupported'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

ALTER TABLE care_handoff_instances
  DROP CONSTRAINT care_handoff_ed_destination_check;

ALTER TABLE care_handoff_instances
  ADD CONSTRAINT care_handoff_ed_destination_check
  CHECK (
    handoff_type <> 'ed_destination_handoff'
    OR (
      sender_uid IS NOT NULL
      AND sender_system_key IS NULL
      AND recipient_kind = 'role'
      AND intended_recipient_uid IS NULL
      AND intended_recipient_role ~ '^[A-Z][A-Z0-9_]{1,79}$'
      AND intended_team_id IS NULL
      AND external_recipient_ref IS NULL
      AND receiving_pathway_instance_id IS NULL
      AND receiving_workflow_run_id IS NULL
      AND receiving_step_key IS NULL
      AND sending_step_key = 'await_destination_acceptance'
      AND source_resource_type = 'emergency_visit'
      AND source_resource_id ~ '^[1-9][0-9]*$'
      AND pg_input_is_valid(source_resource_id, 'integer')
      AND policy_due_at IS NULL
      AND urgency_code = 'not_applicable'
      AND task_id IS NOT NULL
      AND NULLIF(BTRIM(request_reason), '') IS NOT NULL
      AND request_reason = BTRIM(request_reason)
      AND request_reason !~ '[[:cntrl:]]'
      AND request_reason !~ U&'[\0080-\009F]'
      AND request_fingerprint IS NOT NULL
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND metadata ->> 'destination' IN (
        'ward', 'icu', 'hdu', 'surgery', 'external_transfer'
      )
      AND metadata ->> 'registry_version' IN ('5', '6')
      AND request_fingerprint = encode(
        public.digest(
          convert_to(
            concat_ws(
              chr(30),
              'ed_destination_handoff_request_v1',
              'tenant_id=' || LOWER(tenant_id::text),
              'emergency_visit_id=' || source_resource_id,
              'pathway_instance_id=' ||
                LOWER(sending_pathway_instance_id::text),
              'sender_uid=' || LOWER(sender_uid::text),
              'recipient_role=' || intended_recipient_role,
              'destination=' || (metadata ->> 'destination'),
              'reason=' || BTRIM(request_reason),
              'supersedes_handoff_id=' ||
                COALESCE(metadata ->> 'supersedes_handoff_id', 'none')
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      AND status IN ('requested', 'accepted', 'declined', 'cancelled')
      AND acknowledged_at IS NULL
      AND completed_at IS NULL
      AND originator_closed_at IS NULL
      AND (
        (
          status = 'requested'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
          AND declined_at IS NULL
          AND decline_reason IS NULL
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL
          AND reroute_reason IS NULL
          AND NOT (metadata ? 'rerouted_to_handoff_id')
        )
        OR
        (
          status = 'accepted'
          AND accepted_at IS NOT NULL
          AND accepted_by_uid IS NOT NULL
          AND declined_at IS NULL
          AND decline_reason IS NULL
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL
          AND reroute_reason IS NULL
          AND NOT (metadata ? 'rerouted_to_handoff_id')
        )
        OR
        (
          status = 'declined'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
          AND declined_at IS NOT NULL
          AND NULLIF(BTRIM(decline_reason), '') IS NOT NULL
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL
          AND (
            (
              reroute_reason IS NULL
              AND NOT (metadata ? 'rerouted_to_handoff_id')
            )
            OR
            (
              NULLIF(BTRIM(reroute_reason), '') IS NOT NULL
              AND metadata ->> 'rerouted_to_handoff_id' ~
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            )
          )
        )
        OR
        (
          status = 'cancelled'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
          AND declined_at IS NULL
          AND decline_reason IS NULL
          AND cancelled_at IS NOT NULL
          AND NULLIF(BTRIM(cancellation_reason), '') IS NOT NULL
        )
      )
    )
  );

COMMIT;
