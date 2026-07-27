import { AppError } from '../../utils/AppError.js';
import {
  resolvePathwayModeTx,
} from '../pathways/pathwayRuntimePersistence.js';
import {
  CARE_PATHWAY_KEYS,
  PATHWAY_MODES,
} from '../pathways/pathwayMode.js';

const LIVE_OP_PATHWAY_STATUSES = Object.freeze(['planned', 'active', 'on_hold']);
const LIVE_ED_PATHWAY_STATUSES = Object.freeze(['planned', 'active', 'on_hold']);

export async function validateOpTransferAdmissionSourceTx({
  tx,
  tenantId,
  patientUid,
  appointmentId,
  sourcePathwayInstanceId = null,
  sourceHandoffId = null,
}) {
  if (appointmentId == null) {
    return {
      linkage_required: false,
      accepted_recipient_uid: null,
      source_pathway_instance_id: null,
    };
  }

  const advisedRows = await tx.$queryRawUnsafe(
    `SELECT appointment.id
       FROM appointments AS appointment
       JOIN users AS patient
         ON patient.tenant_id = appointment.tenant_id
        AND patient.id = appointment.patient_id
      WHERE appointment.tenant_id = $1::uuid
        AND appointment.id = $2::integer
        AND patient.uid = $3::uuid
        AND appointment.advised_for_admission_at IS NOT NULL
      LIMIT 1
      FOR SHARE OF appointment`,
    tenantId,
    appointmentId,
    patientUid,
  );

  let livePathway = null;
  if (advisedRows[0]) {
    const mode = await resolvePathwayModeTx({
      tx,
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.OP,
    });
    if (mode === PATHWAY_MODES.ACTIVE) {
      const liveRows = await tx.$queryRawUnsafe(
        `SELECT pathway.id
           FROM care_pathway_instances AS pathway
          WHERE pathway.tenant_id = $1::uuid
            AND pathway.patient_uid = $2::uuid
            AND pathway.pathway_key = $3::text
            AND pathway.source_episode_type = 'appointment'
            AND pathway.source_episode_id = $4::text
            AND pathway.clinical_status = ANY($5::text[])
            AND pathway.closed_at IS NULL
          ORDER BY pathway.created_at DESC, pathway.id DESC
          LIMIT 2
          FOR SHARE`,
        tenantId,
        patientUid,
        CARE_PATHWAY_KEYS.OP,
        String(appointmentId),
        [...LIVE_OP_PATHWAY_STATUSES],
      );
      if (liveRows.length > 1) {
        throw AppError.conflict(
          'More than one live OP pathway exists for the advised appointment',
          'INPATIENT_SOURCE_PATHWAY_AMBIGUOUS',
        );
      }
      livePathway = liveRows[0] || null;
      if (
        livePathway
        && (!sourcePathwayInstanceId || !sourceHandoffId)
      ) {
        throw AppError.conflict(
          'The active advised OP episode requires its exact accepted inpatient transfer',
          'INPATIENT_SOURCE_TRANSFER_REQUIRED',
        );
      }
      if (
        livePathway
        && String(livePathway.id).toLowerCase()
          !== String(sourcePathwayInstanceId).toLowerCase()
      ) {
        throw AppError.conflict(
          'Admission source does not match the live advised OP pathway',
          'INPATIENT_SOURCE_TRANSFER_INVALID',
        );
      }
    }
  }

  if (!sourcePathwayInstanceId || !sourceHandoffId) {
    return {
      linkage_required: Boolean(livePathway),
      accepted_recipient_uid: null,
      source_pathway_instance_id: livePathway?.id || null,
    };
  }

  const sourceRows = await tx.$queryRawUnsafe(
    `SELECT handoff.accepted_by_uid
       FROM care_handoff_instances AS handoff
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = handoff.tenant_id
        AND pathway.id = handoff.sending_pathway_instance_id
        AND pathway.patient_uid = handoff.patient_uid
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.id = $2::uuid
        AND handoff.patient_uid = $3::uuid
        AND handoff.sending_pathway_instance_id = $4::uuid
        AND handoff.handoff_type = 'op_to_inpatient_transfer'
        AND handoff.source_resource_type = 'appointment'
        AND handoff.source_resource_id = $5::text
        AND handoff.status = 'accepted'
        AND handoff.accepted_at IS NOT NULL
        AND handoff.sender_uid IS NOT NULL
        AND handoff.intended_recipient_uid IS NOT NULL
        AND handoff.sender_uid <> handoff.intended_recipient_uid
        AND handoff.accepted_by_uid = handoff.intended_recipient_uid
        AND pathway.pathway_key = $6::text
        AND pathway.source_episode_type = 'appointment'
        AND pathway.source_episode_id = $5::text
        AND care_pathway_named_clinician_is_viable(
              handoff.tenant_id,
              handoff.accepted_by_uid
            )
      LIMIT 1
      FOR SHARE OF handoff, pathway`,
    tenantId,
    sourceHandoffId,
    patientUid,
    sourcePathwayInstanceId,
    String(appointmentId),
    CARE_PATHWAY_KEYS.OP,
  );
  if (!sourceRows[0]) {
    throw AppError.conflict(
      'Admission source must be the exact accepted OP-to-inpatient transfer for this tenant, patient, and appointment',
      'INPATIENT_SOURCE_TRANSFER_INVALID',
    );
  }
  return {
    linkage_required: Boolean(livePathway),
    accepted_recipient_uid: String(sourceRows[0].accepted_by_uid).toLowerCase(),
    source_pathway_instance_id: sourcePathwayInstanceId,
  };
}

export async function validateEdHandoffAdmissionSourceTx({
  tx,
  tenantId,
  patientUid,
  emergencyVisitId,
  sourcePathwayInstanceId = null,
  sourceHandoffId = null,
}) {
  if (emergencyVisitId == null) {
    return {
      linkage_required: false,
      source_pathway_instance_id: null,
    };
  }
  const mode = await resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.EMERGENCY,
  });
  let livePathway = null;
  if (mode === PATHWAY_MODES.ACTIVE) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT pathway.id
         FROM care_pathway_instances AS pathway
        WHERE pathway.tenant_id = $1::uuid
          AND pathway.patient_uid = $2::uuid
          AND pathway.pathway_key = $3::text
          AND pathway.source_episode_type = 'emergency_visit'
          AND pathway.source_episode_id = $4::integer::text
          AND pathway.clinical_status = ANY($5::text[])
          AND pathway.closed_at IS NULL
        ORDER BY pathway.created_at DESC, pathway.id DESC
        LIMIT 2
        FOR SHARE`,
      tenantId,
      patientUid,
      CARE_PATHWAY_KEYS.EMERGENCY,
      emergencyVisitId,
      [...LIVE_ED_PATHWAY_STATUSES],
    );
    if (rows.length !== 1) {
      throw AppError.conflict(
        rows.length === 0
          ? 'The active ED pathway has not been projected or is no longer live'
          : 'More than one live ED pathway exists for this emergency visit',
        rows.length === 0
          ? 'ED_ADMISSION_SOURCE_PATHWAY_PENDING'
          : 'ED_ADMISSION_SOURCE_PATHWAY_AMBIGUOUS',
      );
    }
    livePathway = rows[0];
    if (!sourcePathwayInstanceId || !sourceHandoffId) {
      throw AppError.conflict(
        'The active ED episode requires its exact accepted destination handoff',
        'ED_ADMISSION_SOURCE_HANDOFF_REQUIRED',
      );
    }
    if (
      String(livePathway.id).toLowerCase()
      !== String(sourcePathwayInstanceId).toLowerCase()
    ) {
      throw AppError.conflict(
        'Admission source does not match the live ED pathway',
        'ED_ADMISSION_SOURCE_HANDOFF_INVALID',
      );
    }
  }

  if (!sourcePathwayInstanceId || !sourceHandoffId) {
    return {
      linkage_required: Boolean(livePathway),
      source_pathway_instance_id: livePathway?.id || null,
    };
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT handoff.id
       FROM care_handoff_instances AS handoff
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = handoff.tenant_id
        AND pathway.id = handoff.sending_pathway_instance_id
        AND pathway.patient_uid = handoff.patient_uid
       JOIN users AS accepter
         ON accepter.tenant_id = handoff.tenant_id
        AND accepter.uid = handoff.accepted_by_uid
       JOIN tasks AS task
         ON task.tenant_id = handoff.tenant_id
        AND task.id = handoff.task_id
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.id = $2::uuid
        AND handoff.patient_uid = $3::uuid
        AND handoff.sending_pathway_instance_id = $4::uuid
        AND handoff.handoff_type = 'ed_destination_handoff'
        AND handoff.source_resource_type = 'emergency_visit'
        AND handoff.source_resource_id = $5::integer::text
        AND handoff.status = 'accepted'
        AND handoff.accepted_at IS NOT NULL
        AND handoff.accepted_by_uid IS NOT NULL
        AND handoff.recipient_kind = 'role'
        AND handoff.intended_recipient_uid IS NULL
        AND handoff.intended_recipient_role = UPPER(BTRIM(accepter.role))
        AND task.task_kind = 'ed_destination_handoff_review'
        AND task.related_resource_type = 'care_handoff_instance'
        AND task.related_resource_id = handoff.id::text
        AND task.status = 'completed'
        AND task.encounter_id IS NULL
        AND task.assigned_to_uid IS NULL
        AND task.assigned_to_role = handoff.intended_recipient_role
        AND task.due_at IS NULL
        AND task.workflow_sla_instance_id IS NULL
        AND task.sla_completion_semantics = 'none'
        AND task.metadata ->> 'canonical_encounter_id' =
              pathway.encounter_id::text
        AND accepter.is_active
        AND accepter.status = 'active'
        AND NOT accepter.is_deleted
        AND accepter.deleted_at IS NULL
        AND pathway.pathway_key = $6::text
        AND pathway.source_episode_type = 'emergency_visit'
        AND pathway.source_episode_id = $5::integer::text
      LIMIT 1
      FOR SHARE OF handoff, pathway, accepter, task`,
    tenantId,
    sourceHandoffId,
    patientUid,
    sourcePathwayInstanceId,
    emergencyVisitId,
    CARE_PATHWAY_KEYS.EMERGENCY,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Admission source must be the exact accepted ED destination handoff for this tenant, patient, and visit',
      'ED_ADMISSION_SOURCE_HANDOFF_INVALID',
    );
  }
  return {
    linkage_required: Boolean(livePathway),
    source_pathway_instance_id: sourcePathwayInstanceId,
  };
}

export default {
  validateEdHandoffAdmissionSourceTx,
  validateOpTransferAdmissionSourceTx,
};
