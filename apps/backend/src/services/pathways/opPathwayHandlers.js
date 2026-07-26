function appointmentIdFromInstance(instance) {
  if (instance?.source_episode_type !== 'appointment') return null;
  const parsed = Number.parseInt(instance.source_episode_id, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function loadOpPathwayEvidence({ tx, tenantId, instance }) {
  const appointmentId = appointmentIdFromInstance(instance);
  if (!appointmentId) return { appointment_found: false };
  const { evaluateAppointmentPathwayWorkTx } = await import(
    '../appointment/opPathwayWorkService.js'
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT appointment.id,
            UPPER(BTRIM(appointment.status)) AS appointment_status,
            patient.uid AS patient_uid,
            COALESCE(current_pathway.owning_clinician_uid, doctor.uid) AS clinician_uid,
            encounter.id AS encounter_id,
            care_pathway_named_clinician_is_viable(
              appointment.tenant_id,
              COALESCE(current_pathway.owning_clinician_uid, doctor.uid)
            ) AS clinician_is_viable,
            EXISTS (
              SELECT 1
                FROM patient_flow_checkins AS checkin
               WHERE checkin.tenant_id = appointment.tenant_id
                 AND checkin.appointment_id = appointment.id
                 AND checkin.patient_uid = patient.uid
                 AND checkin.status = 'checked_in'
            ) AS checked_in,
            closure.id AS closure_evidence_id,
            closure.evidence_revision AS closure_evidence_revision,
            closure.clinician_uid AS closure_clinician_uid,
            closure.follow_up_required,
            closure.follow_up_plan_id,
            COALESCE(
              jsonb_typeof(closure.patient_safe_next_steps) = 'array'
              AND jsonb_array_length(closure.patient_safe_next_steps) > 0,
              FALSE
            ) AS patient_safe_next_steps_recorded,
            closure.closure_basis,
            closure.accepted_handoff_id,
            closure.source_status_history_id,
            closure.canonical_timeline_event_id,
            closure.canonical_audit_event_id,
            (NOT COALESCE(closure.follow_up_required, FALSE)
              OR follow_up.id IS NOT NULL) AS follow_up_evidence_valid,
            CASE
              WHEN closure.closure_basis = 'accepted_transfer' THEN (
                closure_handoff.id IS NOT NULL
                AND closure_handoff.status = 'accepted'
                AND closure_handoff.accepted_at IS NOT NULL
                AND closure_handoff.handoff_type = 'op_to_inpatient_transfer'
                AND closure_handoff.source_resource_type = 'appointment'
                AND closure_handoff.source_resource_id = appointment.id::text
                AND closure_handoff.sending_pathway_instance_id = current_pathway.id
                AND closure_handoff.sender_uid = closure.clinician_uid
                AND closure_handoff.intended_recipient_uid IS NOT NULL
                AND closure_handoff.intended_recipient_uid <> closure.clinician_uid
                AND closure_handoff.accepted_by_uid =
                    closure_handoff.intended_recipient_uid
              )
              ELSE closure.accepted_handoff_id IS NULL
            END AS accepted_transfer_valid,
            (
              closure.clinician_uid =
                COALESCE(current_pathway.owning_clinician_uid, doctor.uid)
              OR EXISTS (
                SELECT 1
                  FROM care_handoff_instances AS covering
                 WHERE covering.tenant_id = appointment.tenant_id
                   AND covering.patient_uid = patient.uid
                   AND covering.sending_pathway_instance_id = current_pathway.id
                   AND covering.receiving_pathway_instance_id = current_pathway.id
                   AND covering.handoff_type = 'covering_clinician_reassignment'
                   AND covering.source_resource_type = 'care_pathway_instance'
                   AND covering.source_resource_id = current_pathway.id::text
                   AND covering.status = 'accepted'
                   AND covering.accepted_at IS NOT NULL
                   AND covering.intended_recipient_uid = closure.clinician_uid
                   AND covering.accepted_by_uid = closure.clinician_uid
              )
            ) AS closure_actor_valid,
            COALESCE(reference_rollup.open_child_count, 0)::integer AS open_child_count,
            COALESCE(
              reference_rollup.invalid_ownership_count,
              0
            )::integer AS invalid_ownership_count
       FROM appointments AS appointment
       JOIN users AS patient
         ON patient.tenant_id = appointment.tenant_id
        AND patient.id = appointment.patient_id
       LEFT JOIN users AS doctor
        ON doctor.tenant_id = appointment.tenant_id
        AND doctor.id = appointment.doctor_id
       LEFT JOIN care_pathway_instances AS current_pathway
         ON current_pathway.tenant_id = appointment.tenant_id
        AND current_pathway.id = $3::uuid
        AND current_pathway.patient_uid = patient.uid
        AND current_pathway.pathway_key = 'op_contact_to_recovery'
        AND current_pathway.source_episode_type = 'appointment'
        AND current_pathway.source_episode_id = appointment.id::text
       LEFT JOIN patient_encounters AS encounter
         ON encounter.tenant_id = appointment.tenant_id
        AND encounter.appointment_id = appointment.id
        AND encounter.patient_uid = patient.uid
       LEFT JOIN LATERAL (
         SELECT evidence.id,
                evidence.evidence_revision,
                evidence.clinician_uid,
                evidence.follow_up_required,
                evidence.follow_up_plan_id,
                evidence.patient_safe_next_steps,
                evidence.closure_basis,
                evidence.accepted_handoff_id,
                evidence.source_status_history_id,
                evidence.canonical_timeline_event_id,
                evidence.canonical_audit_event_id
           FROM op_visit_closure_evidence AS evidence
          WHERE evidence.tenant_id = appointment.tenant_id
            AND evidence.appointment_id = appointment.id
            AND evidence.patient_uid = patient.uid
          ORDER BY evidence.evidence_revision DESC, evidence.recorded_at DESC
          LIMIT 1
       ) AS closure ON TRUE
       LEFT JOIN follow_up_plans AS follow_up
         ON follow_up.tenant_id = appointment.tenant_id
        AND follow_up.id = closure.follow_up_plan_id
        AND follow_up.patient_uid = patient.uid
        AND follow_up.origin_kind = 'consultation'
        AND follow_up.origin_resource_type = 'appointment'
        AND follow_up.origin_resource_id = appointment.id::text
        AND follow_up.status IN ('open', 'scheduled')
       LEFT JOIN care_handoff_instances AS closure_handoff
         ON closure_handoff.tenant_id = appointment.tenant_id
        AND closure_handoff.id = closure.accepted_handoff_id
        AND closure_handoff.patient_uid = patient.uid
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (
                  WHERE reference.evidence_state = 'open'
                ) AS open_child_count,
                COUNT(*) FILTER (
                  WHERE reference.evidence_state = 'ownership_accepted'
                    AND reference.accepted_owner_uid IS NULL
                    AND reference.handoff_id IS NULL
                ) AS invalid_ownership_count
           FROM care_pathway_resource_references AS reference
          WHERE reference.tenant_id = appointment.tenant_id
            AND reference.pathway_instance_id = $3::uuid
            AND reference.patient_uid = patient.uid
            AND reference.relationship_kind = 'child_action'
            AND reference.evidence_state <> 'superseded'
            AND NOT EXISTS (
              SELECT 1
                FROM care_pathway_resource_references AS successor
               WHERE successor.tenant_id = reference.tenant_id
                 AND successor.superseded_reference_id = reference.id
            )
       ) AS reference_rollup ON TRUE
      WHERE appointment.tenant_id = $1::uuid
        AND appointment.id = $2::integer
      LIMIT 1`,
    tenantId,
    appointmentId,
    instance.id,
  );
  const row = rows[0];
  if (!row) return { appointment_found: false };
  const closureEvidenceValid = Boolean(
    row.closure_evidence_id
    && row.closure_clinician_uid
    && row.closure_actor_valid
    && row.patient_safe_next_steps_recorded
    && row.follow_up_evidence_valid
    && row.accepted_transfer_valid
    && row.canonical_timeline_event_id
    && row.canonical_audit_event_id,
  );
  const pathwayWork = await evaluateAppointmentPathwayWorkTx({
    tx,
    tenantId,
    appointmentId,
  });
  return {
    appointment_found: true,
    appointment_id: Number(row.id),
    appointment_status: row.appointment_status,
    patient_uid: row.patient_uid ? String(row.patient_uid) : null,
    clinician_uid: row.clinician_uid ? String(row.clinician_uid) : null,
    encounter_id: row.encounter_id ? String(row.encounter_id) : null,
    clinician_is_viable: row.clinician_is_viable === true,
    checked_in: row.checked_in === true,
    closure_evidence_id: row.closure_evidence_id ? String(row.closure_evidence_id) : null,
    closure_evidence_revision: row.closure_evidence_revision == null
      ? null
      : Number(row.closure_evidence_revision),
    closure_basis: row.closure_basis || null,
    source_status_history_id: row.source_status_history_id == null
      ? null
      : String(row.source_status_history_id),
    closure_evidence_valid: closureEvidenceValid,
    open_child_count: Number(row.open_child_count || 0),
    invalid_ownership_count: Number(row.invalid_ownership_count || 0),
    pathway_closure_allowed: pathwayWork.pathway_closure.allowed,
    pathway_closure_blockers: pathwayWork.pathway_closure.blockers,
    projection_pending: pathwayWork.projection_pending,
    completeness_proven: pathwayWork.configuration.completeness_proven,
  };
}

export const OP_PATHWAY_RUNTIME_HANDLERS = Object.freeze({
  contactOwner: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadOpPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.appointment_found
          && loadedEvidence.patient_uid
          && loadedEvidence.clinician_uid
          && loadedEvidence.clinician_is_viable
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  arrivalOrRecovery: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied', 'recovery_branch']),
    loadEvidence: loadOpPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      if (['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(
        loadedEvidence.appointment_status,
      )) {
        return { decision: 'recovery_branch', evidence: loadedEvidence };
      }
      return {
        decision: loadedEvidence.checked_in
          || ['IN_PROGRESS', 'COMPLETED'].includes(loadedEvidence.appointment_status)
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  visitCompletion: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied', 'normal_visit_completed']),
    loadEvidence: loadOpPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.appointment_status === 'COMPLETED'
          ? 'normal_visit_completed'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  recoveryAction: Object.freeze({
    stepKinds: Object.freeze(['task']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadOpPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: (
          ['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(
            loadedEvidence.appointment_status,
          )
          && loadedEvidence.closure_evidence_valid === true
        )
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  closureEvidence: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadOpPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.closure_evidence_valid ? 'satisfied' : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  childWorkClosure: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadOpPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.closure_evidence_valid
          && loadedEvidence.pathway_closure_allowed
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  finalize: Object.freeze({
    stepKinds: Object.freeze(['automation']),
    async execute({ instance }) {
      return {
        finalized: true,
        source_episode_type: instance.source_episode_type,
        source_episode_id: instance.source_episode_id,
      };
    },
  }),
});

export default OP_PATHWAY_RUNTIME_HANDLERS;
