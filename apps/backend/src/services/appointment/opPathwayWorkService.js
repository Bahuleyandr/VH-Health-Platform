import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { isClinical } from '../../utils/roleHelpers.js';
import {
  listExactOpChildSourcesTx,
  loadValidatedOpChildProjectionTx,
  OP_CHILD_RESOURCE_EVENT_TYPE,
} from './opChildResourceEventService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  CARE_PATHWAY_KEYS,
  DEFAULT_PATHWAY_MODE,
  PATHWAY_MODES,
  normalizePathwayMode,
} from '../pathways/pathwayMode.js';

const OP_PATHWAY_KEY = CARE_PATHWAY_KEYS.OP;
const OP_PENDING_RESULT_HANDOFF_STATES = Object.freeze([
  'pending',
  'result_available',
  'resolved',
]);
const LIVE_PENDING_RESULT_TASK_STATUSES = Object.freeze([
  'open',
  'in_progress',
  'blocked',
  'overdue',
]);
const PENDING_RESULT_PHYSICIAN_ROLES = Object.freeze([
  'DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'DUTY_DOCTOR',
  'SENIOR_DOCTOR',
]);
const INPATIENT_PENDING_RESULT_TYPES = Object.freeze([
  'investigation',
  'lab_result',
  'radiology_order',
  'anatomical_pathology_case',
  'diagnostic_result_generation',
]);
const MAX_FOLLOW_UP_PENDING_RESULTS = 200;

const ROUTE_BY_RESOURCE_TYPE = Object.freeze({
  appointment: 'appointments',
  admission: 'admissions',
  e_prescription: 'prescriptions',
  clinical_order: 'clinical_orders',
  investigation: 'investigations',
  lab_result: 'investigations',
  radiology_order: 'radiology',
  anatomical_pathology_case: 'anatomical_pathology',
  diagnostic_result_generation: 'diagnostic_results',
  referral: 'referrals',
  follow_up_plan: 'follow_up',
  clinical_note: 'clinical_notes',
  discharge_summary: 'discharge_hub',
  discharge_consult: 'discharge_hub',
});

function appointmentId(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest('appointment id must be a positive integer', 'APPOINTMENT_ID_INVALID');
  }
  return parsed;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function routeForResource(resourceType) {
  return ROUTE_BY_RESOURCE_TYPE[String(resourceType || '')] || null;
}

function closureEvidence(row) {
  if (!row) return null;
  return {
    id: row.id,
    revision: Number(row.evidence_revision),
    clinician_uid: row.clinician_uid,
    follow_up_required: row.follow_up_required === true,
    follow_up_plan_id: row.follow_up_plan_id == null ? null : Number(row.follow_up_plan_id),
    patient_next_steps: Array.isArray(row.patient_safe_next_steps)
      ? row.patient_safe_next_steps
      : [],
    closure_basis: row.closure_basis,
    accepted_handoff_id: row.accepted_handoff_id || null,
    source_status_history_id: row.source_status_history_id == null
      ? null
      : String(row.source_status_history_id),
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at,
  };
}

function itemIsSatisfied(item) {
  if (item.evidence_state === 'completed' || item.evidence_state === 'superseded') return true;
  if (item.evidence_state !== 'ownership_accepted') return false;
  return Boolean(item.owner_uid || item.handoff_id);
}

function blockerForItem(item, { requireAll = false } = {}) {
  if (!requireAll && !item.blocking) return null;
  if (item.configuration_issue === 'missing_source_event') {
    return {
      code: 'APPOINTMENT_PATHWAY_CHILD_SOURCE_EVENT_MISSING',
      message: `${item.resource_type} work is linked to this visit but its atomic lineage event is missing`,
      resource_type: item.resource_type,
      resource_id: item.id,
    };
  }
  if (item.configuration_issue === 'child_projection_pending') {
    return {
      code: 'APPOINTMENT_PATHWAY_CHILD_PROJECTION_PENDING',
      message: `${item.resource_type} work is linked to this visit but its pathway evidence is not projected`,
      resource_type: item.resource_type,
      resource_id: item.id,
    };
  }
  if (item.configuration_issue === 'invalid_source_event') {
    return {
      code: 'APPOINTMENT_PATHWAY_CHILD_EVENT_INVALID',
      message: `${item.resource_type} lineage event does not resolve to an exact same-visit child resource`,
      resource_type: item.resource_type,
      resource_id: item.id,
    };
  }
  if (item.configuration_issue === 'source_state_mismatch') {
    return {
      code: 'APPOINTMENT_PATHWAY_CHILD_STATE_MISMATCH',
      message: `${item.resource_type} pathway evidence is inconsistent with its authoritative source`,
      resource_type: item.resource_type,
      resource_id: item.id,
    };
  }
  if (itemIsSatisfied(item)) return null;
  if (item.evidence_state === 'ownership_accepted') {
    return {
      code: 'APPOINTMENT_PATHWAY_OWNERSHIP_EVIDENCE_MISSING',
      message: `${item.resource_type} work does not have accepted named ownership or transfer evidence`,
    };
  }
  return {
    code: 'APPOINTMENT_PATHWAY_WORK_OPEN',
    message: `${item.resource_type} work is still open`,
  };
}

async function loadAppointmentTx(tx, tenantId, id, { lock = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT a.id, a.uid, a.tenant_id, a.patient_id, patient.uid AS patient_uid,
            a.doctor_id, clinician.uid AS doctor_uid, a.status,
            a.appointment_date, a.appointment_time, a.updated_at
       FROM appointments AS a
       JOIN users AS patient
         ON patient.id = a.patient_id
        AND patient.tenant_id = a.tenant_id
       LEFT JOIN users AS clinician
         ON clinician.id = a.doctor_id
        AND clinician.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1::uuid
        AND a.id = $2::integer
      LIMIT 1
      ${lock ? 'FOR UPDATE OF a' : ''}`,
    tenantId,
    id,
  );
  if (!rows[0]) {
    throw AppError.notFound('Appointment not found', 'APPOINTMENT_NOT_FOUND');
  }
  return rows[0];
}

export async function resolveOpPathwayModeTx(tx, tenantId) {
  const tid = requireTenantId(tenantId);
  const rows = await tx.$queryRawUnsafe(
    `SELECT settings -> 'care_pathways' ->> $2::text AS mode
       FROM tenants
      WHERE id = $1::uuid
      LIMIT 1`,
    tid,
    OP_PATHWAY_KEY,
  );
  return normalizePathwayMode(rows[0]?.mode) || DEFAULT_PATHWAY_MODE;
}

async function findPathwayInstanceTx(tx, tenantId, patientUid, id) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT pathway.id, pathway.clinical_status
       FROM care_pathway_instances AS pathway
      WHERE pathway.tenant_id = $1::uuid
        AND pathway.patient_uid = $2::uuid
        AND pathway.pathway_key = $3::text
        AND (
          (
            pathway.source_episode_type = 'appointment'
            AND pathway.source_episode_id = $4::text
          )
          OR EXISTS (
            SELECT 1
              FROM care_pathway_resource_references AS source_ref
             WHERE source_ref.tenant_id = pathway.tenant_id
               AND source_ref.pathway_instance_id = pathway.id
               AND source_ref.patient_uid = pathway.patient_uid
               AND source_ref.resource_type = 'appointment'
               AND source_ref.resource_id = $4::text
               AND source_ref.evidence_state <> 'superseded'
               AND NOT EXISTS (
                 SELECT 1
                   FROM care_pathway_resource_references AS successor
                  WHERE successor.tenant_id = source_ref.tenant_id
                    AND successor.superseded_reference_id = source_ref.id
               )
          )
        )
      ORDER BY
        CASE pathway.clinical_status
          WHEN 'active' THEN 0
          WHEN 'planned' THEN 1
          WHEN 'on_hold' THEN 2
          ELSE 3
        END,
        pathway.created_at DESC,
        pathway.id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    OP_PATHWAY_KEY,
    String(id),
  );
  return rows[0] || null;
}

async function listItemsTx(tx, tenantId, patientUid, pathwayInstanceId) {
  if (!pathwayInstanceId) return [];
  const rows = await tx.$queryRawUnsafe(
    `SELECT reference.resource_type, reference.resource_id,
            reference.relationship_kind, reference.evidence_state,
            reference.accepted_owner_uid, reference.task_id, reference.handoff_id,
            reference.metadata, owner.name AS owner_name, owner.role AS owner_role
       FROM care_pathway_resource_references AS reference
       LEFT JOIN users AS owner
         ON owner.tenant_id = reference.tenant_id
        AND owner.uid = reference.accepted_owner_uid
      WHERE reference.tenant_id = $1::uuid
        AND reference.pathway_instance_id = $2::uuid
        AND reference.patient_uid = $3::uuid
        AND reference.relationship_kind = 'child_action'
        AND NOT EXISTS (
          SELECT 1
            FROM care_pathway_resource_references AS successor
           WHERE successor.tenant_id = reference.tenant_id
             AND successor.superseded_reference_id = reference.id
        )
      ORDER BY reference.recorded_at ASC, reference.id ASC`,
    tenantId,
    pathwayInstanceId,
    patientUid,
  );
  return rows.map((row) => {
    const metadata = plainObject(row.metadata);
    return {
      resource_type: row.resource_type,
      id: row.resource_id,
      relationship_kind: row.relationship_kind,
      evidence_state: row.evidence_state,
      // Child work is safety-relevant by default. A registered projector may
      // explicitly classify an item non-blocking; arbitrary route metadata is
      // never trusted for navigation or ownership.
      blocking: metadata.blocking !== false,
      owner_uid: row.accepted_owner_uid || null,
      owner_name: row.owner_name || null,
      owner_role: row.owner_role || null,
      task_id: row.task_id == null ? null : Number(row.task_id),
      handoff_id: row.handoff_id || null,
      route: routeForResource(row.resource_type),
    };
  });
}

async function listPriorAdmissionPendingResultsTx(
  tx,
  {
    tenantId,
    patientUid,
    appointmentId: currentAppointmentId,
    appointmentStatus,
    actorUid = null,
    actorRole = null,
  } = {},
) {
  if (
    ['CANCELLED', 'CANCELED', 'NO_SHOW', 'RESCHEDULED'].includes(
      String(appointmentStatus || '').trim().toUpperCase(),
    )
  ) {
    return [];
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT handoff.admission_id,
            handoff.id AS handoff_id,
            handoff.source_type,
            handoff.patient_safe_label,
            handoff.result_status,
            handoff.handoff_state,
            handoff.resolution_action_id,
            handoff.resolved_at,
            handoff.resolved_by_uid,
            owner.uid AS owner_uid,
            owner.name AS owner_name,
            owner.role AS owner_role,
            tracking_task.id AS tracking_task_id,
            tracking_task.status AS tracking_task_status,
            action_task.generation_id,
            action_task.generation_snapshot_sha256,
            action_task.diagnostic_classification,
            action_task.id AS action_task_id,
            action_task.status AS action_task_status,
            COALESCE(action_task.match_count, 0)::integer AS action_task_match_count,
            diagnostic_action.id AS diagnostic_action_id,
            diagnostic_action.action_kind AS diagnostic_action_kind,
            diagnostic_action.disposition AS diagnostic_disposition,
            diagnostic_action.occurred_at AS diagnostic_action_occurred_at,
            COALESCE(
              diagnostic_action.match_count,
              0
            )::integer AS diagnostic_action_match_count,
            (
              $7::uuid IS NOT NULL
              AND owner.uid = $7::uuid
              AND $8::text IS NOT NULL
              AND UPPER(BTRIM(owner.role)) = $8::text
              AND UPPER(BTRIM(owner.role)) = ANY($9::text[])
              AND owner.is_active = TRUE
              AND owner.status = 'active'
              AND owner.is_deleted = FALSE
              AND owner.deleted_at IS NULL
              AND handoff.handoff_state = 'result_available'
              AND handoff.resolution_action_id IS NULL
              AND handoff.resolved_at IS NULL
              AND handoff.resolved_by_uid IS NULL
              AND tracking_task.status = ANY($10::text[])
              AND action_task.status = ANY($10::text[])
              AND action_task.match_count = 1
              AND diagnostic_action.match_count = 1
              AND diagnostic_action.actor_uid IS NOT NULL
              AND diagnostic_action.actor_uid <> handoff.named_physician_uid
            ) AS can_cross_sign
       FROM discharge_pending_result_handoffs AS handoff
       JOIN admissions AS admission
         ON admission.tenant_id = handoff.tenant_id
        AND admission.id = handoff.admission_id
        AND admission.patient_uid = handoff.patient_uid
        AND admission.status IN ('discharged', 'lama')
        AND admission.discharged_at IS NOT NULL
       JOIN users AS owner
         ON owner.tenant_id = handoff.tenant_id
        AND owner.uid = handoff.named_physician_uid
       JOIN tasks AS tracking_task
         ON tracking_task.tenant_id = handoff.tenant_id
        AND tracking_task.id = handoff.task_id
        AND tracking_task.patient_uid = handoff.patient_uid
        AND tracking_task.task_kind = 'follow_up'
        AND tracking_task.related_resource_type =
            'discharge_pending_result_handoff'
        AND tracking_task.related_resource_id = handoff.id::text
        AND tracking_task.assigned_to_uid = handoff.named_physician_uid
        AND tracking_task.assigned_to_role IS NULL
        AND tracking_task.parent_task_id IS NULL
        AND tracking_task.workflow_run_id IS NULL
        AND tracking_task.workflow_step_id IS NULL
        AND tracking_task.workflow_sla_instance_id IS NULL
        AND tracking_task.sla_completion_semantics = 'none'
       LEFT JOIN LATERAL (
          SELECT owner_action.id AS owner_action_id,
                 owner_action.generation_id,
                 generation.snapshot_sha256 AS generation_snapshot_sha256,
                 generation.classification AS diagnostic_classification,
                 task.id,
                 task.status,
                 COUNT(*) OVER()::integer AS match_count
            FROM discharge_pending_result_owner_actions AS owner_action
            JOIN diagnostic_result_generations AS generation
              ON generation.tenant_id = owner_action.tenant_id
             AND generation.id = owner_action.generation_id
             AND generation.patient_uid = owner_action.patient_uid
             AND generation.admission_id = owner_action.admission_id
             AND (
               (
                 owner_action.predecessor_owner_action_id IS NULL
                 AND owner_action.predecessor_generation_id IS NULL
                 AND owner_action.predecessor_resolution_action_id IS NULL
                 AND owner_action.rearm_source_action_id IS NULL
                 AND handoff.resolution_generation_id =
                     owner_action.generation_id
               )
               OR
               (
                 owner_action.predecessor_owner_action_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM discharge_pending_result_owner_actions AS
                          predecessor_action
                    WHERE predecessor_action.tenant_id =
                          owner_action.tenant_id
                      AND predecessor_action.id =
                          owner_action.predecessor_owner_action_id
                      AND predecessor_action.handoff_id =
                          owner_action.handoff_id
                      AND predecessor_action.admission_id =
                          owner_action.admission_id
                      AND predecessor_action.patient_uid =
                          owner_action.patient_uid
                      AND (
                        (
                          owner_action.predecessor_generation_id IS NOT NULL
                          AND owner_action.rearm_source_action_id IS NULL
                          AND generation.predecessor_generation_id =
                              owner_action.predecessor_generation_id
                          AND predecessor_action.generation_id =
                              owner_action.predecessor_generation_id
                        )
                        OR
                        (
                          owner_action.predecessor_generation_id IS NULL
                          AND owner_action.predecessor_resolution_action_id
                              IS NOT NULL
                          AND owner_action.rearm_source_action_id IS NOT NULL
                          AND predecessor_action.generation_id =
                              owner_action.generation_id
                          AND EXISTS (
                            SELECT 1
                              FROM diagnostic_result_actions AS
                                   predecessor_resolution
                              JOIN diagnostic_result_actions AS rearm_action
                                ON rearm_action.tenant_id =
                                   predecessor_resolution.tenant_id
                               AND rearm_action.id =
                                   owner_action.rearm_source_action_id
                               AND rearm_action.patient_uid =
                                   predecessor_resolution.patient_uid
                               AND rearm_action.generation_id =
                                   predecessor_resolution.generation_id
                               AND rearm_action.action_kind =
                                   'doctor_reopened'
                               AND rearm_action.predecessor_action_id =
                                   predecessor_resolution.id
                             WHERE predecessor_resolution.tenant_id =
                                   owner_action.tenant_id
                               AND predecessor_resolution.id =
                                   owner_action.predecessor_resolution_action_id
                               AND predecessor_resolution.patient_uid =
                                   owner_action.patient_uid
                               AND predecessor_resolution.generation_id =
                                   owner_action.generation_id
                               AND predecessor_resolution.action_kind =
                                   'normal_auto_closed'
                          )
                        )
                      )
                 )
               )
             )
            JOIN tasks AS task
              ON task.tenant_id = owner_action.tenant_id
             AND task.id = owner_action.task_id
             AND task.patient_uid = owner_action.patient_uid
             AND task.task_kind = 'review'
             AND task.related_resource_type =
                 'discharge_pending_result_action'
             AND task.related_resource_id =
                 CASE
                   WHEN owner_action.rearm_source_action_id IS NOT NULL
                     THEN owner_action.handoff_id::text || ':' ||
                          owner_action.generation_id::text || ':' ||
                          owner_action.predecessor_owner_action_id::text
                   ELSE owner_action.handoff_id::text || ':' ||
                        owner_action.generation_id::text
                 END
             AND task.parent_task_id = handoff.task_id
             AND task.assigned_to_uid = handoff.named_physician_uid
             AND task.assigned_to_role IS NULL
             AND task.workflow_run_id IS NULL
             AND task.workflow_step_id IS NULL
             AND task.workflow_sla_instance_id IS NULL
             AND task.sla_completion_semantics = 'none'
             AND task.metadata ->> 'task_contract' =
                 'discharge_pending_result_action_v1'
             AND task.metadata ->> 'handoff_id' =
                 owner_action.handoff_id::text
             AND task.metadata ->> 'generation_id' =
                 owner_action.generation_id::text
             AND task.metadata ->> 'predecessor_generation_id'
                 IS NOT DISTINCT FROM
                 owner_action.predecessor_generation_id::text
             AND task.metadata ->> 'predecessor_owner_action_id'
                 IS NOT DISTINCT FROM
                 owner_action.predecessor_owner_action_id::text
             AND task.metadata ->> 'predecessor_resolution_action_id'
                 IS NOT DISTINCT FROM
                 owner_action.predecessor_resolution_action_id::text
             AND task.metadata ->> 'rearm_source_action_id'
                 IS NOT DISTINCT FROM
                 owner_action.rearm_source_action_id::text
           WHERE owner_action.tenant_id = handoff.tenant_id
             AND owner_action.handoff_id = handoff.id
             AND owner_action.admission_id = handoff.admission_id
             AND owner_action.patient_uid = handoff.patient_uid
             AND owner_action.owner_uid = handoff.named_physician_uid
             AND NOT EXISTS (
               SELECT 1
                 FROM discharge_pending_result_owner_actions AS successor_action
                WHERE successor_action.tenant_id = owner_action.tenant_id
                  AND successor_action.handoff_id = owner_action.handoff_id
                  AND successor_action.predecessor_owner_action_id =
                      owner_action.id
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM diagnostic_result_generations AS successor_generation
                WHERE successor_generation.tenant_id = generation.tenant_id
                  AND successor_generation.predecessor_generation_id =
                      generation.id
                  AND successor_generation.patient_uid =
                      generation.patient_uid
                  AND successor_generation.admission_id =
                      generation.admission_id
             )
           ORDER BY owner_action.recorded_at DESC, owner_action.id DESC
           LIMIT 1
       ) AS action_task
         ON handoff.resolution_generation_id IS NOT NULL
       LEFT JOIN LATERAL (
          SELECT action.id,
                 action.action_kind,
                 action.disposition,
                 action.actor_uid,
                 action.occurred_at,
                 COUNT(*) OVER()::integer AS match_count
            FROM diagnostic_result_actions AS action
           WHERE action.tenant_id = handoff.tenant_id
             AND action.patient_uid = handoff.patient_uid
             AND action.generation_id = action_task.generation_id
             AND action.action_kind = 'doctor_disposition'
             AND action.signature_id IS NOT NULL
           ORDER BY action.occurred_at DESC, action.id DESC
           LIMIT 1
       ) AS diagnostic_action
         ON action_task.generation_id IS NOT NULL
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.patient_uid = $2::uuid
        AND handoff.source_type = ANY($3::text[])
        AND handoff.handoff_state = ANY($4::text[])
        AND EXISTS (
          SELECT 1
            FROM follow_up_plans AS plan
            JOIN appointments AS follow_up_appointment
              ON follow_up_appointment.tenant_id = plan.tenant_id
             AND follow_up_appointment.id = plan.appointment_id
            JOIN users AS follow_up_patient
              ON follow_up_patient.tenant_id =
                  follow_up_appointment.tenant_id
             AND follow_up_patient.id =
                 follow_up_appointment.patient_id
             AND follow_up_patient.uid = plan.patient_uid
           WHERE plan.tenant_id = handoff.tenant_id
             AND plan.patient_uid = handoff.patient_uid
             AND plan.appointment_id = $5::integer
             AND plan.origin_kind = 'admission'
             AND plan.origin_resource_type = 'admission'
             AND plan.origin_resource_id = admission.id::text
             AND plan.status IN ('open', 'scheduled')
             AND LOWER(COALESCE(plan.appointment_status, '')) NOT IN (
               'cancelled',
               'canceled',
               'no_show',
               'rescheduled'
             )
             AND follow_up_appointment.id = $5::integer
             AND follow_up_patient.uid = $2::uuid
             AND UPPER(BTRIM(follow_up_appointment.status)) NOT IN (
               'CANCELLED',
               'CANCELED',
               'NO_SHOW',
               'RESCHEDULED'
             )
        )
      ORDER BY admission.discharged_at DESC, handoff.created_at ASC,
               handoff.id ASC
      LIMIT $6::integer`,
    tenantId,
    patientUid,
    INPATIENT_PENDING_RESULT_TYPES,
    OP_PENDING_RESULT_HANDOFF_STATES,
    currentAppointmentId,
    MAX_FOLLOW_UP_PENDING_RESULTS + 1,
    actorUid,
    String(actorRole || '').trim().toUpperCase() || null,
    PENDING_RESULT_PHYSICIAN_ROLES,
    LIVE_PENDING_RESULT_TASK_STATUSES,
  );
  if (rows.length > MAX_FOLLOW_UP_PENDING_RESULTS) {
    throw AppError.conflict(
      'Admission-origin pending-result follow-up work exceeds its bounded projection',
      'OP_FOLLOW_UP_PENDING_RESULT_LIMIT_EXCEEDED',
    );
  }
  return rows.map((row) => {
    const resultAvailable = row.handoff_state === 'result_available';
    const hasActionObligation = ['result_available', 'resolved'].includes(
      row.handoff_state,
    );
    if (
      hasActionObligation
      && Number(row.action_task_match_count || 0) !== 1
    ) {
      throw AppError.conflict(
        'Admission-origin pending-result follow-up work requires exactly one current action task',
        'OP_FOLLOW_UP_PENDING_RESULT_TASK_AMBIGUOUS',
      );
    }
    if (Number(row.diagnostic_action_match_count || 0) > 1) {
      throw AppError.conflict(
        'Admission-origin pending-result follow-up work has ambiguous signed disposition evidence',
        'OP_FOLLOW_UP_PENDING_RESULT_DISPOSITION_AMBIGUOUS',
      );
    }
    const taskId = hasActionObligation ? row.action_task_id : row.tracking_task_id;
    const taskStatus = hasActionObligation
      ? row.action_task_status
      : row.tracking_task_status;
    return {
      admission_id: Number(row.admission_id),
      handoff_id: row.handoff_id,
      source_type: row.source_type,
      patient_safe_label: row.patient_safe_label,
      result_status: row.result_status,
      handoff_state: row.handoff_state,
      requires_action: resultAvailable,
      can_cross_sign: row.can_cross_sign === true,
      named_owner: {
        uid: row.owner_uid,
        display_name: row.owner_name,
        role: row.owner_role,
      },
      generation_id: row.generation_id || null,
      generation_snapshot_sha256:
        row.generation_snapshot_sha256 || null,
      diagnostic_classification: row.diagnostic_classification || null,
      diagnostic_action_id: row.diagnostic_action_id || null,
      diagnostic_action_kind: row.diagnostic_action_kind || null,
      diagnostic_disposition: row.diagnostic_disposition || null,
      diagnostic_action_occurred_at:
        row.diagnostic_action_occurred_at || null,
      resolution_action_id: row.resolution_action_id || null,
      resolved_at: row.resolved_at || null,
      resolved_by_uid: row.resolved_by_uid || null,
      tracking_task: {
        id: Number(row.tracking_task_id),
        status: row.tracking_task_status,
      },
      action_task: row.action_task_id == null
        ? null
        : {
            id: Number(row.action_task_id),
            status: row.action_task_status,
          },
      task: taskId == null
        ? null
        : {
            id: Number(taskId),
            status: taskStatus,
          },
      route: routeForResource(row.source_type),
    };
  });
}

function resourceKey(resourceType, resourceId) {
  return `${String(resourceType || '').trim().toLowerCase()}:${String(resourceId || '').trim()}`;
}

function syntheticItem({
  resourceType,
  resourceId,
  evidenceState = 'open',
  configurationIssue,
  sourceEvidenceState = null,
} = {}) {
  return {
    resource_type: resourceType,
    id: String(resourceId),
    relationship_kind: 'child_action',
    evidence_state: evidenceState,
    blocking: true,
    owner_uid: null,
    owner_name: null,
    owner_role: null,
    task_id: null,
    handoff_id: null,
    route: routeForResource(resourceType),
    configuration_issue: configurationIssue,
    source_evidence_state: sourceEvidenceState,
  };
}

async function listChildEventsTx(tx, tenantId, patientUid, id) {
  return tx.$queryRawUnsafe(
    `SELECT event.id::text AS id,
            event.payload ->> 'resource_type' AS resource_type,
            event.payload ->> 'resource_id' AS resource_id,
            event.payload ->> 'patient_uid' AS payload_patient_uid,
            event.payload ->> 'tenant_id' AS payload_tenant_id,
            event.created_at
       FROM event_outbox AS event
      WHERE event.tenant_id = $1::uuid
        AND event.patient_uid = $2::uuid
        AND event.event_type = $3::text
        AND event.aggregate_type = 'appointment'
        AND event.aggregate_id = $4::text
        AND event.payload ->> 'appointment_id' = $4::text
      ORDER BY event.id ASC`,
    tenantId,
    patientUid,
    OP_CHILD_RESOURCE_EVENT_TYPE,
    String(id),
  );
}

async function evaluateChildCompletenessTx(tx, {
  tenantId,
  appointment: appointmentRow,
  pathwayInstance,
  projectedItems,
} = {}) {
  const childEvents = await listChildEventsTx(
    tx,
    tenantId,
    appointmentRow.patient_uid,
    appointmentRow.id,
  );
  const latestEvents = new Map();
  for (const event of childEvents) {
    const key = resourceKey(event.resource_type, event.resource_id);
    latestEvents.set(key, event);
  }

  const projectedByKey = new Map(
    projectedItems.map((item) => [resourceKey(item.resource_type, item.id), item]),
  );
  const exactSources = await listExactOpChildSourcesTx(tx, {
    tenantId,
    appointmentId: appointmentRow.id,
    patientUid: appointmentRow.patient_uid,
  });
  const exactByKey = new Map(
    exactSources.map((source) => [
      resourceKey(source.resource_type, source.resource_id),
      source,
    ]),
  );
  const validEvents = new Map();
  const invalidEvents = new Map();
  for (const [key, event] of latestEvents) {
    try {
      const linked = await loadValidatedOpChildProjectionTx(tx, {
        tenantId,
        appointmentId: appointmentRow.id,
        patientUid: appointmentRow.patient_uid,
        resourceType: event.resource_type,
        resourceId: event.resource_id,
      });
      if (
        String(event.payload_patient_uid || '').toLowerCase()
          !== String(appointmentRow.patient_uid).toLowerCase()
        || String(event.payload_tenant_id || '').toLowerCase()
          !== String(tenantId).toLowerCase()
      ) {
        throw AppError.conflict(
          'OP child event identity is inconsistent',
          'OP_CHILD_EVENT_IDENTITY_INVALID',
        );
      }
      validEvents.set(key, linked);
    } catch (error) {
      if (!(error instanceof AppError) || !String(error.code || '').startsWith('OP_CHILD_')) {
        throw error;
      }
      invalidEvents.set(key, event);
    }
  }

  const items = projectedItems.map((item) => ({ ...item }));
  const itemIndex = new Map(
    items.map((item, index) => [resourceKey(item.resource_type, item.id), index]),
  );
  let missingSourceEventCount = 0;
  let pendingProjectionCount = 0;
  let stateMismatchCount = 0;

  for (const [key, linked] of validEvents) {
    const projected = projectedByKey.get(key);
    if (!projected) {
      pendingProjectionCount += 1;
      itemIndex.set(key, items.length);
      items.push(syntheticItem({
        resourceType: linked.resource_type,
        resourceId: linked.resource_id,
        evidenceState: linked.evidence_state,
        configurationIssue: 'child_projection_pending',
        sourceEvidenceState: linked.evidence_state,
      }));
      continue;
    }
    const index = itemIndex.get(key);
    items[index].source_evidence_state = linked.evidence_state;
    if (
      projected.evidence_state === 'completed'
      && linked.evidence_state !== 'completed'
    ) {
      stateMismatchCount += 1;
      items[index].configuration_issue = 'source_state_mismatch';
    } else if (
      projected.evidence_state === 'open'
      && linked.evidence_state === 'completed'
    ) {
      pendingProjectionCount += 1;
      items[index].configuration_issue = 'child_projection_pending';
    }
  }

  for (const [key, source] of exactByKey) {
    if (validEvents.has(key) || invalidEvents.has(key)) continue;
    const linked = await loadValidatedOpChildProjectionTx(tx, {
      tenantId,
      appointmentId: appointmentRow.id,
      patientUid: appointmentRow.patient_uid,
      resourceType: source.resource_type,
      resourceId: source.resource_id,
    });
    missingSourceEventCount += 1;
    const existingIndex = itemIndex.get(key);
    if (existingIndex != null) {
      items[existingIndex].configuration_issue = 'missing_source_event';
      items[existingIndex].source_evidence_state = linked.evidence_state;
    } else {
      itemIndex.set(key, items.length);
      items.push(syntheticItem({
        resourceType: linked.resource_type,
        resourceId: linked.resource_id,
        evidenceState: linked.evidence_state,
        configurationIssue: 'missing_source_event',
        sourceEvidenceState: linked.evidence_state,
      }));
    }
  }

  for (const [key, event] of invalidEvents) {
    const existingIndex = itemIndex.get(key);
    if (existingIndex != null) {
      items[existingIndex].configuration_issue = 'invalid_source_event';
    } else {
      itemIndex.set(key, items.length);
      items.push(syntheticItem({
        resourceType: String(event.resource_type || 'unknown').toLowerCase(),
        resourceId: event.resource_id || event.id,
        configurationIssue: 'invalid_source_event',
      }));
    }
  }

  for (const [key, projected] of projectedByKey) {
    if (latestEvents.has(key) || exactByKey.has(key)) continue;
    missingSourceEventCount += 1;
    const index = itemIndex.get(key);
    items[index] = {
      ...projected,
      configuration_issue: 'missing_source_event',
    };
  }

  return {
    items,
    configuration: {
      completeness_checked: true,
      completeness_proven: (
        missingSourceEventCount === 0
        && pendingProjectionCount === 0
        && invalidEvents.size === 0
        && stateMismatchCount === 0
      ),
      exact_source_count: exactSources.length,
      child_event_count: childEvents.length,
      valid_child_event_count: validEvents.size,
      missing_source_event_count: missingSourceEventCount,
      pending_child_projection_count: pendingProjectionCount,
      invalid_child_event_count: invalidEvents.size,
      child_state_mismatch_count: stateMismatchCount,
      unsupported_historical_source_types: [],
      pathway_instance_id: pathwayInstance?.id || null,
    },
  };
}

async function latestClosureEvidenceTx(tx, tenantId, patientUid, id) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, evidence_revision, clinician_uid, follow_up_required,
            follow_up_plan_id, patient_safe_next_steps, closure_basis,
            accepted_handoff_id, source_status_history_id, occurred_at, recorded_at
       FROM op_visit_closure_evidence
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND appointment_id = $3::integer
      ORDER BY evidence_revision DESC, recorded_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    id,
  );
  return closureEvidence(rows[0]);
}

async function closureEvidenceBlockersTx(tx, {
  tenantId,
  patientUid,
  appointmentId: id,
  doctorUid,
  pathwayInstanceId,
  evidence,
} = {}) {
  if (!evidence) return [];
  const blockers = [];
  if (!Array.isArray(evidence.patient_next_steps) || evidence.patient_next_steps.length === 0) {
    blockers.push({
      code: 'APPOINTMENT_CLOSURE_NEXT_STEPS_INVALID',
      message: 'Patient-safe next steps are missing or invalid',
    });
  }

  const clinicianRows = await tx.$queryRawUnsafe(
    `SELECT uid, role, is_active
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
      LIMIT 1`,
    tenantId,
    evidence.clinician_uid,
  );
  const clinician = clinicianRows[0];
  if (!clinician || clinician.is_active !== true || !isClinical(clinician.role)) {
    blockers.push({
      code: 'APPOINTMENT_CLOSURE_CLINICIAN_INVALID',
      message: 'The named closure clinician is no longer a viable same-tenant clinician',
    });
  }

  if (evidence.follow_up_required) {
    if (!evidence.follow_up_plan_id) {
      blockers.push({
        code: 'APPOINTMENT_CLOSURE_FOLLOW_UP_REQUIRED',
        message: 'A same-patient follow-up plan is required',
      });
    } else {
      const followUpRows = await tx.$queryRawUnsafe(
        `SELECT id
           FROM follow_up_plans
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND id = $3::integer
            AND origin_kind = 'consultation'
            AND origin_resource_type = 'appointment'
            AND origin_resource_id = $4::integer::text
            AND status IN ('open', 'scheduled')
          LIMIT 1`,
        tenantId,
        patientUid,
        evidence.follow_up_plan_id,
        id,
      );
      if (!followUpRows[0]) {
        blockers.push({
          code: 'APPOINTMENT_CLOSURE_FOLLOW_UP_INVALID',
          message: 'The follow-up plan is not an open or scheduled plan originating from this appointment',
        });
      }
    }
  } else if (evidence.follow_up_plan_id) {
    blockers.push({
      code: 'APPOINTMENT_CLOSURE_FOLLOW_UP_INVALID',
      message: 'A follow-up plan cannot be attached when follow-up is not required',
    });
  }

  let exactTransfer = false;
  if (evidence.closure_basis === 'accepted_transfer') {
    if (!evidence.accepted_handoff_id) {
      blockers.push({
        code: 'APPOINTMENT_CLOSURE_TRANSFER_REQUIRED',
        message: 'Accepted transfer closure requires the exact accepted handoff',
      });
    } else {
      const transferRows = await tx.$queryRawUnsafe(
        `SELECT handoff.id
           FROM care_handoff_instances AS handoff
           JOIN care_pathway_instances AS pathway
             ON pathway.tenant_id = handoff.tenant_id
            AND pathway.id = handoff.sending_pathway_instance_id
            AND pathway.patient_uid = handoff.patient_uid
          WHERE handoff.tenant_id = $1::uuid
            AND handoff.id = $2::uuid
            AND handoff.patient_uid = $3::uuid
            AND handoff.handoff_type = 'op_to_inpatient_transfer'
            AND handoff.source_resource_type = 'appointment'
            AND handoff.source_resource_id = $4::text
            AND handoff.status = 'accepted'
            AND handoff.accepted_at IS NOT NULL
            AND handoff.sender_uid = $5::uuid
            AND handoff.intended_recipient_uid IS NOT NULL
            AND handoff.intended_recipient_uid <> $5::uuid
            AND handoff.accepted_by_uid = handoff.intended_recipient_uid
            AND pathway.pathway_key = $6::text
            AND pathway.source_episode_type = 'appointment'
            AND pathway.source_episode_id = $4::text
          LIMIT 1`,
        tenantId,
        evidence.accepted_handoff_id,
        patientUid,
        String(id),
        evidence.clinician_uid,
        OP_PATHWAY_KEY,
      );
      exactTransfer = Boolean(transferRows[0]);
      if (!exactTransfer) {
        blockers.push({
          code: 'APPOINTMENT_CLOSURE_TRANSFER_INVALID',
          message: 'The accepted transfer is not the exact OP transfer for this visit and clinician',
        });
      }
    }
  } else if (evidence.accepted_handoff_id) {
    blockers.push({
      code: 'APPOINTMENT_CLOSURE_TRANSFER_INVALID',
      message: 'Only accepted-transfer closure evidence may reference a transfer handoff',
    });
  }

  let authorizedClinician = false;
  if (pathwayInstanceId) {
    const pathwayRows = await tx.$queryRawUnsafe(
      `SELECT owning_clinician_uid
         FROM care_pathway_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND patient_uid = $3::uuid
          AND pathway_key = $4::text
          AND source_episode_type = 'appointment'
          AND source_episode_id = $5::text
        LIMIT 1`,
      tenantId,
      pathwayInstanceId,
      patientUid,
      OP_PATHWAY_KEY,
      String(id),
    );
    authorizedClinician = Boolean(
      pathwayRows[0]?.owning_clinician_uid
      && String(pathwayRows[0].owning_clinician_uid).toLowerCase()
        === String(evidence.clinician_uid).toLowerCase(),
    );
  } else {
    authorizedClinician = Boolean(
      doctorUid
      && String(doctorUid).toLowerCase() === String(evidence.clinician_uid).toLowerCase(),
    );
  }
  if (!authorizedClinician && pathwayInstanceId) {
    const coveringRows = await tx.$queryRawUnsafe(
      `SELECT handoff.id
         FROM care_handoff_instances AS handoff
        WHERE handoff.tenant_id = $1::uuid
          AND handoff.patient_uid = $2::uuid
          AND handoff.sending_pathway_instance_id = $3::uuid
          AND handoff.receiving_pathway_instance_id = $3::uuid
          AND handoff.handoff_type = 'covering_clinician_reassignment'
          AND handoff.source_resource_type = 'care_pathway_instance'
          AND handoff.source_resource_id = $3::text
          AND handoff.status = 'accepted'
          AND handoff.accepted_at IS NOT NULL
          AND handoff.intended_recipient_uid = $4::uuid
          AND handoff.accepted_by_uid = $4::uuid
        LIMIT 1`,
      tenantId,
      patientUid,
      pathwayInstanceId,
      evidence.clinician_uid,
    );
    authorizedClinician = Boolean(coveringRows[0]);
  }
  if (!authorizedClinician) {
    blockers.push({
      code: 'APPOINTMENT_CLOSURE_OWNER_INVALID',
      message: 'Closure evidence is not attributable to the current OP owner or an accepted named recipient',
    });
  }
  return blockers;
}

export async function evaluateAppointmentPathwayWorkTx({
  tx,
  tenantId,
  appointment = null,
  appointmentId: rawAppointmentId = null,
  mode: suppliedMode = null,
  lockAppointment = false,
  actorUid = null,
  actorRole = null,
} = {}) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
    throw AppError.internal(
      'Appointment pathway work requires a transaction',
      'APPOINTMENT_PATHWAY_WORK_TX_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const id = appointmentId(appointment?.id ?? rawAppointmentId);
  const appt = appointment || await loadAppointmentTx(tx, tid, id, { lock: lockAppointment });
  if (String(appt.tenant_id) !== String(tid)) {
    throw AppError.notFound('Appointment not found', 'APPOINTMENT_NOT_FOUND');
  }
  const mode = normalizePathwayMode(suppliedMode) || await resolveOpPathwayModeTx(tx, tid);

  if (mode === PATHWAY_MODES.OFF) {
    return {
      mode,
      projection_pending: false,
      configuration: {
        mode,
        projection_pending: false,
        completeness_checked: false,
        completeness_proven: false,
        exact_source_count: 0,
        child_event_count: 0,
        valid_child_event_count: 0,
        missing_source_event_count: 0,
        pending_child_projection_count: 0,
        invalid_child_event_count: 0,
        child_state_mismatch_count: 0,
        unsupported_historical_source_types: [],
        pathway_instance_id: null,
        pathway_clinical_status: null,
      },
      visit_completion: { allowed: true, blockers: [] },
      pathway_closure: { allowed: true, blockers: [] },
      items: [],
      prior_admission_pending_results: [],
      closure_evidence: null,
    };
  }

  const priorAdmissionPendingResults = await listPriorAdmissionPendingResultsTx(
    tx,
    {
      tenantId: tid,
      patientUid: appt.patient_uid,
      appointmentId: id,
      appointmentStatus: appt.status,
      actorUid,
      actorRole,
    },
  );
  const pathwayInstance = await findPathwayInstanceTx(tx, tid, appt.patient_uid, id);
  const projectedItems = await listItemsTx(
    tx,
    tid,
    appt.patient_uid,
    pathwayInstance?.id,
  );
  const completeness = await evaluateChildCompletenessTx(tx, {
    tenantId: tid,
    appointment: appt,
    pathwayInstance,
    projectedItems,
  });
  const items = completeness.items;
  const evidence = await latestClosureEvidenceTx(tx, tid, appt.patient_uid, id);
  const visitItemBlockers = items.map(blockerForItem).filter(Boolean);
  const closureItemBlockers = items
    .map(item => blockerForItem(item, { requireAll: true }))
    .filter(Boolean);
  const projectionPending = !pathwayInstance;
  const projectionBlocker = projectionPending
    ? {
        code: 'APPOINTMENT_PATHWAY_PROJECTION_PENDING',
        message: 'Appointment pathway evidence has not been projected yet',
      }
    : null;
  const completenessBlocker = !completeness.configuration.completeness_proven
    ? {
        code: 'APPOINTMENT_PATHWAY_COMPLETENESS_UNPROVEN',
        message: 'Appointment child-work completeness has not been proven',
      }
    : null;
  const visitBlockers = [
    ...(projectionBlocker ? [projectionBlocker] : []),
    ...(completenessBlocker ? [completenessBlocker] : []),
    ...visitItemBlockers,
  ];
  const closureBlockers = [
    ...(projectionBlocker ? [projectionBlocker] : []),
    ...(completenessBlocker ? [completenessBlocker] : []),
    ...closureItemBlockers,
  ];

  if (
    !['COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(
      String(appt.status || '').toUpperCase(),
    )
  ) {
    closureBlockers.push({
      code: 'APPOINTMENT_VISIT_NOT_COMPLETED',
      message: 'The appointment visit is not completed',
    });
  }
  if (!evidence) {
    closureBlockers.push({
      code: 'APPOINTMENT_CLOSURE_EVIDENCE_MISSING',
      message: 'Clinician disposition and patient next steps have not been recorded',
    });
  } else {
    const evidenceBlockers = await closureEvidenceBlockersTx(tx, {
      tenantId: tid,
      patientUid: appt.patient_uid,
      appointmentId: id,
      doctorUid: appt.doctor_uid,
      pathwayInstanceId: pathwayInstance?.id,
      evidence,
    });
    closureBlockers.push(...evidenceBlockers);
  }

  return {
    mode,
    projection_pending: projectionPending,
    configuration: {
      mode,
      projection_pending: projectionPending,
      pathway_instance_id: pathwayInstance?.id || null,
      pathway_clinical_status: pathwayInstance?.clinical_status || null,
      ...completeness.configuration,
    },
    visit_completion: {
      allowed: mode === PATHWAY_MODES.ACTIVE ? visitBlockers.length === 0 : true,
      blockers: visitBlockers,
    },
    pathway_closure: {
      allowed: closureBlockers.length === 0,
      blockers: closureBlockers,
    },
    items,
    prior_admission_pending_results: priorAdmissionPendingResults,
    closure_evidence: evidence,
  };
}

export async function getAppointmentPathwayWork({
  tenantId,
  appointmentId: rawAppointmentId,
  actorUid = null,
  actorRole = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const id = appointmentId(rawAppointmentId);
  return setTenantTx(tid, async (tx) => {
    const appointment = await loadAppointmentTx(tx, tid, id);
    return evaluateAppointmentPathwayWorkTx({
      tx,
      tenantId: tid,
      appointment,
      actorUid,
      actorRole,
    });
  });
}

export const __testing__ = Object.freeze({
  ROUTE_BY_RESOURCE_TYPE,
  blockerForItem,
  closureEvidenceBlockersTx,
  closureEvidence,
  evaluateChildCompletenessTx,
  itemIsSatisfied,
  listPriorAdmissionPendingResultsTx,
  routeForResource,
});

export default {
  evaluateAppointmentPathwayWorkTx,
  getAppointmentPathwayWork,
  resolveOpPathwayModeTx,
};
