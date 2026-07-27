const RECEIVER_DESTINATIONS = new Set([
  'ward',
  'icu',
  'hdu',
  'surgery',
  'external_transfer',
]);

const NON_RECEIVER_TERMINAL_STATUSES = new Set([
  'discharged',
  'left_against_advice',
  'lwbs',
  'expired',
]);

function emergencyVisitIdFromInstance(instance) {
  if (instance?.source_episode_type !== 'emergency_visit') return null;
  const parsed = Number.parseInt(instance.source_episode_id, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function loadEmergencyPathwayEvidence({ tx, tenantId, instance }) {
  const emergencyVisitId = emergencyVisitIdFromInstance(instance);
  if (!emergencyVisitId) return { emergency_visit_found: false };
  const rows = await tx.$queryRawUnsafe(
    `SELECT visit.id,
            visit.patient_uid,
            visit.encounter_id,
            visit.attending_doctor_uid,
            visit.status AS visit_status,
            visit.disposition,
            visit.disposition_at,
            visit.departure_at,
            care_pathway_named_clinician_is_viable(
              visit.tenant_id,
              visit.attending_doctor_uid
            ) AS attending_doctor_is_viable,
            handoff.id AS handoff_id,
            handoff.status AS handoff_status,
            handoff.accepted_at AS handoff_accepted_at,
            handoff.accepted_by_uid,
            handoff.intended_recipient_role,
            handoff.metadata ->> 'destination' AS destination,
            task.id AS handoff_task_id,
            task.task_kind AS handoff_task_kind,
            task.status AS handoff_task_status,
            task.encounter_id AS handoff_task_legacy_encounter_id,
            task.related_resource_type AS handoff_task_resource_type,
            task.related_resource_id AS handoff_task_resource_id,
            task.assigned_to_uid AS handoff_task_assigned_uid,
            task.assigned_to_role AS handoff_task_assigned_role,
            task.due_at AS handoff_task_due_at,
            task.workflow_sla_instance_id AS handoff_task_sla_instance_id,
            task.sla_completion_semantics AS handoff_task_sla_semantics,
            task.metadata ->> 'canonical_encounter_id'
              AS handoff_task_canonical_encounter_id,
            UPPER(BTRIM(accepter.role)) AS accepter_role,
            (
              accepter.uid IS NOT NULL
              AND accepter.is_active
              AND accepter.status = 'active'
              AND NOT accepter.is_deleted
              AND accepter.deleted_at IS NULL
            ) AS accepter_is_active,
            admission.id AS linked_admission_id,
            admission.source_pathway_instance_id,
            admission.source_handoff_id
       FROM emergency_visits AS visit
       LEFT JOIN LATERAL (
         SELECT candidate.*
           FROM care_handoff_instances AS candidate
          WHERE candidate.tenant_id = visit.tenant_id
            AND candidate.patient_uid = visit.patient_uid
            AND candidate.sending_pathway_instance_id = $3::uuid
            AND candidate.handoff_type = 'ed_destination_handoff'
            AND candidate.source_resource_type = 'emergency_visit'
            AND candidate.source_resource_id = visit.id::text
            AND candidate.status IN ('requested', 'accepted')
          ORDER BY candidate.requested_at DESC, candidate.id DESC
          LIMIT 1
       ) AS handoff ON TRUE
       LEFT JOIN tasks AS task
         ON task.tenant_id = handoff.tenant_id
        AND task.id = handoff.task_id
       LEFT JOIN users AS accepter
         ON accepter.tenant_id = handoff.tenant_id
        AND accepter.uid = handoff.accepted_by_uid
       LEFT JOIN LATERAL (
         SELECT candidate.id,
                candidate.source_pathway_instance_id,
                candidate.source_handoff_id
           FROM admissions AS candidate
          WHERE candidate.tenant_id = visit.tenant_id
            AND candidate.patient_uid = visit.patient_uid
            AND candidate.from_er_visit_id = visit.id
          ORDER BY candidate.admitted_at DESC, candidate.id DESC
          LIMIT 1
       ) AS admission ON TRUE
      WHERE visit.tenant_id = $1::uuid
        AND visit.id = $2::integer
      LIMIT 1
      FOR SHARE OF visit`,
    tenantId,
    emergencyVisitId,
    instance.id,
  );
  const row = rows[0];
  if (!row) return { emergency_visit_found: false };

  const acceptedHandoffValid = Boolean(
    row.handoff_id
    && row.handoff_status === 'accepted'
    && row.handoff_accepted_at
    && row.accepted_by_uid
    && row.intended_recipient_role
    && RECEIVER_DESTINATIONS.has(row.destination)
    && row.handoff_task_id
    && row.handoff_task_kind === 'ed_destination_handoff_review'
    && row.handoff_task_status === 'completed'
    && row.handoff_task_legacy_encounter_id === null
    && row.handoff_task_resource_type === 'care_handoff_instance'
    && String(row.handoff_task_resource_id || '').toLowerCase()
      === String(row.handoff_id).toLowerCase()
    && row.handoff_task_assigned_uid === null
    && row.handoff_task_assigned_role === row.intended_recipient_role
    && row.handoff_task_due_at === null
    && row.handoff_task_sla_instance_id === null
    && row.handoff_task_sla_semantics === 'none'
    && String(row.handoff_task_canonical_encounter_id || '').toLowerCase()
      === String(row.encounter_id).toLowerCase()
    && row.accepter_is_active === true
    && row.accepter_role === row.intended_recipient_role,
  );
  const admissionLinkValid = Boolean(
    row.linked_admission_id
    && String(row.source_pathway_instance_id || '').toLowerCase()
      === String(instance.id).toLowerCase()
    && String(row.source_handoff_id || '').toLowerCase()
      === String(row.handoff_id || '').toLowerCase(),
  );
  const nonReceiverClosureValid = Boolean(
    NON_RECEIVER_TERMINAL_STATUSES.has(row.visit_status)
    && row.disposition
    && row.disposition_at
    && row.departure_at,
  );
  const receiverClosureValid = Boolean(
    acceptedHandoffValid
    && row.disposition_at
    && (
      (
        row.visit_status === 'admitted'
        && row.disposition === 'admitted'
        && admissionLinkValid
      )
      || (
        row.visit_status === 'transferred'
        && row.disposition === 'transferred_out'
        && row.departure_at
      )
    ),
  );
  return {
    emergency_visit_found: true,
    emergency_visit_id: Number(row.id),
    patient_uid: row.patient_uid ? String(row.patient_uid) : null,
    encounter_id: row.encounter_id ? String(row.encounter_id) : null,
    attending_doctor_uid: row.attending_doctor_uid
      ? String(row.attending_doctor_uid)
      : null,
    attending_doctor_is_viable: row.attending_doctor_is_viable === true,
    visit_status: row.visit_status,
    disposition: row.disposition || null,
    disposition_recorded: Boolean(row.disposition_at),
    departure_recorded: Boolean(row.departure_at),
    handoff_id: row.handoff_id ? String(row.handoff_id) : null,
    handoff_status: row.handoff_status || null,
    destination: row.destination || null,
    intended_recipient_role: row.intended_recipient_role || null,
    accepted_by_uid: row.accepted_by_uid ? String(row.accepted_by_uid) : null,
    accepted_handoff_valid: acceptedHandoffValid,
    linked_admission_id: row.linked_admission_id == null
      ? null
      : Number(row.linked_admission_id),
    admission_link_valid: admissionLinkValid,
    non_receiver_closure_valid: nonReceiverClosureValid,
    receiver_closure_valid: receiverClosureValid,
    closure_valid: nonReceiverClosureValid || receiverClosureValid,
  };
}

export const EMERGENCY_PATHWAY_RUNTIME_HANDLERS = Object.freeze({
  arrivalOwner: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadEmergencyPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.emergency_visit_found
          && loadedEvidence.patient_uid
          && loadedEvidence.encounter_id
          && loadedEvidence.attending_doctor_uid
          && loadedEvidence.attending_doctor_is_viable
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  dispositionReadiness: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadEmergencyPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.visit_status === 'awaiting_disposition'
          || NON_RECEIVER_TERMINAL_STATUSES.has(loadedEvidence.visit_status)
          || ['admitted', 'transferred'].includes(loadedEvidence.visit_status)
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  destinationAcceptance: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadEmergencyPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.accepted_handoff_valid
          || loadedEvidence.non_receiver_closure_valid
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  destinationClosure: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadEmergencyPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.closure_valid ? 'satisfied' : 'blocked',
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

export async function loadEmergencyPathwayEvidenceV2(context) {
  const legacy = await loadEmergencyPathwayEvidence(context);
  if (!legacy.emergency_visit_found) return legacy;
  // Deferred to evaluation time so the task runtime can initialize without
  // cycling through the ED task producer and back into this handler registry.
  const { loadEdContinuityEvidenceTx } = await import(
    '../ed/edClosureRecoveryService.js'
  );
  const continuity = await loadEdContinuityEvidenceTx({
    tx: context.tx,
    tenantId: context.tenantId,
    emergencyVisitId: legacy.emergency_visit_id,
  });
  if (!continuity) return legacy;
  const continuityEvidence = {
    closure_evidence_id: continuity.closure_evidence_id
      ? String(continuity.closure_evidence_id)
      : null,
    evidence_revision: continuity.evidence_revision,
    closure_kind: continuity.closure_kind || null,
    recovery_attempt_count: continuity.recovery_attempt_count,
    latest_outcome_code: continuity.latest_outcome_code || null,
    latest_outcome_at: continuity.latest_outcome_at
      ? new Date(continuity.latest_outcome_at).toISOString()
      : null,
    accepted_handoff_valid: continuity.accepted_handoff_valid,
    latest_closure_matches_branch:
      continuity.latest_closure_matches_branch,
    recovery_complete: continuity.recovery_complete,
    death_certified: continuity.death_certified,
    mortuary_custody_recorded: continuity.mortuary_custody_recorded,
    mlc_complete: continuity.mlc_complete,
    identity_resolved_or_attested:
      continuity.identity_resolved_or_attested,
    bed_pending: continuity.bed_pending,
    branch_closure_complete: continuity.branch_closure_complete,
  };
  const internalAdmissionClosureValid = legacy.receiver_closure_valid
    && legacy.visit_status === 'admitted'
    && ['ward', 'icu', 'hdu', 'surgery'].includes(legacy.destination)
    && legacy.admission_link_valid;
  const externalTransferClosureValid = legacy.receiver_closure_valid
    && legacy.visit_status === 'transferred'
    && legacy.destination === 'external_transfer'
    && continuity.branch_closure_complete;
  const nonReceiverClosureValid = [
    'discharged',
    'left_against_advice',
    'lwbs',
    'expired',
  ].includes(legacy.visit_status)
    && continuity.branch_closure_complete;
  return {
    ...legacy,
    ...continuityEvidence,
    internal_admission_closure_valid: internalAdmissionClosureValid,
    external_transfer_closure_valid: externalTransferClosureValid,
    non_receiver_closure_valid_v2: nonReceiverClosureValid,
    closure_valid_v2:
      internalAdmissionClosureValid
      || externalTransferClosureValid
      || nonReceiverClosureValid,
  };
}

export const EMERGENCY_PATHWAY_RUNTIME_HANDLERS_V2 = Object.freeze({
  arrivalOwner: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadEmergencyPathwayEvidenceV2,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.emergency_visit_found
          && loadedEvidence.patient_uid
          && loadedEvidence.encounter_id
          && loadedEvidence.attending_doctor_uid
          && loadedEvidence.attending_doctor_is_viable
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  dispositionReadiness: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadEmergencyPathwayEvidenceV2,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.visit_status === 'awaiting_disposition'
          || [
            'admitted',
            'discharged',
            'transferred',
            'left_against_advice',
            'lwbs',
            'expired',
          ].includes(loadedEvidence.visit_status)
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  destinationAcceptance: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadEmergencyPathwayEvidenceV2,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.accepted_handoff_valid
          || [
            'discharged',
            'left_against_advice',
            'lwbs',
            'expired',
          ].includes(loadedEvidence.visit_status)
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  closureEvidence: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadEmergencyPathwayEvidenceV2,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.closure_valid_v2 ? 'satisfied' : 'blocked',
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
        closure_contract: 'emergency_closure_recovery_v2',
      };
    },
  }),
});

export default EMERGENCY_PATHWAY_RUNTIME_HANDLERS;
