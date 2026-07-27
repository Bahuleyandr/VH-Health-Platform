import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  currentCanonicalTransactionRevision,
  recordCanonicalClinicalEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  createEmergencyVisit,
  transitionEmergencyVisit,
} from './edOperationsService.js';

function positiveId(value, label) {
  const text = String(value ?? '').trim();
  const parsed = Number.parseInt(text, 10);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(parsed)) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function optionalUuid(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

async function resolveEmergencyModeTx(tx, tenantId) {
  return resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.EMERGENCY,
  });
}

async function appendEmergencyEvidenceTx(tx, {
  mode,
  tenantId,
  visit,
  prior = null,
  eventType,
  actorUid,
  actorRole,
  payload = {},
} = {}) {
  if (mode === PATHWAY_MODES.OFF) return { canonical: null, outbox: null };
  if (!visit?.patient_uid || !visit?.encounter_id) {
    throw AppError.conflict(
      'Shadow or active ED pathways require an identified patient and canonical encounter',
      'EMERGENCY_PATHWAY_IDENTITY_REQUIRED',
    );
  }
  const revision = await currentCanonicalTransactionRevision(tx);
  const basePayload = {
    tenant_id: tenantId,
    patient_uid: visit.patient_uid,
    emergency_visit_id: Number(visit.id),
    encounter_id: visit.encounter_id,
    from_status: prior?.status || null,
    to_status: visit.status,
    disposition: visit.disposition || null,
    ...payload,
  };
  const canonical = await recordCanonicalClinicalEvent({
    tenantId,
    patientUid: visit.patient_uid,
    encounterId: visit.encounter_id,
    eventType,
    eventStatus: String(visit.status || '').toLowerCase(),
    sourceTable: 'emergency_visits',
    sourceId: String(visit.id),
    resourceType: 'emergency_visit',
    resourceId: String(visit.id),
    actorUid: optionalUuid(actorUid, 'actor_uid'),
    actorRole: actorRole ? String(actorRole).trim().toUpperCase() : null,
    occurredAt: visit.updated_at || visit.created_at || null,
    summary: eventType === 'emergency.visit.created'
      ? 'Emergency visit created'
      : eventType === 'emergency.visit.destination_closed'
        ? 'Emergency destination closed'
        : `Emergency visit transitioned to ${visit.status}`,
    payload: basePayload,
    beforeState: prior
      ? {
        status: prior.status,
        disposition: prior.disposition || null,
        departure_at: prior.departure_at || null,
      }
      : null,
    afterState: {
      status: visit.status,
      disposition: visit.disposition || null,
      departure_at: visit.departure_at || null,
    },
    timelineIdempotencyKey:
      `emergency_visits:${visit.id}:${eventType}:timeline:tx:${revision}`,
    auditIdempotencyKey:
      `emergency_visits:${visit.id}:${eventType}:audit:tx:${revision}`,
  }, { db: tx, strict: true });
  if (!canonical?.timeline?.id || !canonical?.audit?.id) {
    throw AppError.internal(
      'Emergency canonical evidence was not recorded',
      'EMERGENCY_CANONICAL_EVIDENCE_REQUIRED',
    );
  }
  const outbox = await publishEvent({
    eventType,
    aggregateType: 'emergency_visit',
    aggregateId: String(visit.id),
    patientUid: visit.patient_uid,
    payload: {
      ...basePayload,
      canonical_timeline_event_id: canonical.timeline.id,
      canonical_audit_event_id: canonical.audit.id,
    },
    tx,
    tenantId,
  });
  if (!outbox) {
    throw AppError.internal(
      'Emergency outbox event was not recorded',
      'EMERGENCY_OUTBOX_REQUIRED',
    );
  }
  return { canonical, outbox };
}

async function loadVisitTx(tx, tenantId, visitId, lock = false) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, attending_doctor_uid,
            status, disposition, disposition_at, departure_at,
            created_at, updated_at
       FROM emergency_visits
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
      LIMIT 1
      ${lock ? 'FOR UPDATE' : ''}`,
    tenantId,
    visitId,
  );
  if (!rows[0]) throw AppError.notFound('Emergency visit not found');
  return rows[0];
}

export async function ensureEmergencyPatientEncounterTx(tx, {
  tenantId,
  visit,
  actorUid = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const visitId = positiveId(visit?.id, 'emergency_visit_id');
  const patientUid = optionalUuid(visit?.patient_uid, 'patient_uid');
  const encounterId = optionalUuid(visit?.encounter_id, 'encounter_id');
  const primaryDoctorUid = optionalUuid(
    visit?.attending_doctor_uid,
    'attending_doctor_uid',
  );
  const actor = optionalUuid(actorUid, 'actor_uid');
  if (!tx?.$queryRawUnsafe || !patientUid || !encounterId) {
    throw AppError.conflict(
      'The ED canonical encounter identity is unavailable',
      'EMERGENCY_PATHWAY_IDENTITY_REQUIRED',
    );
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO patient_encounters
       (id, tenant_id, patient_uid, encounter_type, status,
        primary_doctor_uid, care_team_uids, opened_at, activated_at,
        created_by, updated_by, status_history, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'er', 'active', $4::uuid,
        ARRAY(
          SELECT DISTINCT uid
            FROM unnest(ARRAY[$4::uuid, $5::uuid]) AS uid
           WHERE uid IS NOT NULL
        ),
        COALESCE($6::timestamptz, clock_timestamp()), clock_timestamp(),
        $5::uuid, $5::uuid,
        jsonb_build_array(jsonb_build_object(
          'status', 'active',
          'changed_at', clock_timestamp(),
          'changed_by', $5::uuid,
          'reason', 'emergency visit created'
        )),
        jsonb_build_object(
          'source', 'ed_pathway_domain_service',
          'emergency_visit_id', $7::integer
        ))
     ON CONFLICT (id) DO NOTHING`,
    encounterId,
    tid,
    patientUid,
    primaryDoctorUid,
    actor,
    visit.arrival_at || visit.created_at || null,
    visitId,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_type, status,
            appointment_id, admission_id, admission_encounter_id,
            primary_doctor_uid, metadata
       FROM patient_encounters
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      LIMIT 2
      FOR SHARE`,
    tid,
    encounterId,
  );
  const encounter = rows[0];
  if (
    rows.length !== 1
    || String(encounter.patient_uid).toLowerCase() !== patientUid
    || encounter.encounter_type !== 'er'
    || encounter.appointment_id !== null
    || encounter.admission_id !== null
    || encounter.admission_encounter_id !== null
    || String(encounter.primary_doctor_uid || '').toLowerCase()
      !== String(primaryDoctorUid || '').toLowerCase()
    || String(encounter.metadata?.emergency_visit_id || '') !== String(visitId)
  ) {
    throw AppError.conflict(
      'The ED visit is bound to an incompatible canonical encounter',
      'EMERGENCY_ENCOUNTER_BINDING_INVALID',
    );
  }
  return encounter;
}

async function assertAcceptedDestinationTx({
  tx,
  tenantId,
  visit,
  acceptedHandoffId,
  sourcePathwayInstanceId = null,
} = {}) {
  const handoffId = optionalUuid(acceptedHandoffId, 'accepted_handoff_id');
  const pathwayInstanceId = optionalUuid(
    sourcePathwayInstanceId,
    'source_pathway_instance_id',
  );
  if (!handoffId) {
    throw AppError.conflict(
      'The active ED destination requires its exact accepted handoff',
      'ED_DESTINATION_HANDOFF_REQUIRED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT handoff.id, handoff.sending_pathway_instance_id
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
        AND handoff.handoff_type = 'ed_destination_handoff'
        AND handoff.source_resource_type = 'emergency_visit'
        AND handoff.source_resource_id = $4::integer::text
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
              ($7::uuid)::text
        AND accepter.is_active
        AND accepter.status = 'active'
        AND NOT accepter.is_deleted
        AND accepter.deleted_at IS NULL
        AND pathway.pathway_key = $5::text
        AND pathway.source_episode_type = 'emergency_visit'
        AND pathway.source_episode_id = $4::integer::text
        AND ($6::uuid IS NULL OR pathway.id = $6::uuid)
      LIMIT 1
      FOR SHARE OF handoff, pathway, accepter, task`,
    tenantId,
    handoffId,
    visit.patient_uid,
    visit.id,
    CARE_PATHWAY_KEYS.EMERGENCY,
    pathwayInstanceId,
    visit.encounter_id,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'The ED destination handoff is not the exact accepted role handoff for this visit',
      'ED_DESTINATION_HANDOFF_INVALID',
    );
  }
  return {
    handoff_id: String(rows[0].id).toLowerCase(),
    pathway_instance_id:
      String(rows[0].sending_pathway_instance_id).toLowerCase(),
  };
}

export async function createEmergencyVisitWithPathwayEvidence(input = {}) {
  const tenantId = requireTenantId(input.tenantId);
  return setTenantTx(tenantId, async tx => {
    const mode = await resolveEmergencyModeTx(tx, tenantId);
    const visit = await createEmergencyVisit({ ...input, tenantId, tx });
    if (mode !== PATHWAY_MODES.OFF) {
      await ensureEmergencyPatientEncounterTx(tx, {
        tenantId,
        visit,
        actorUid: input.createdBy,
      });
    }
    const evidence = await appendEmergencyEvidenceTx(tx, {
      mode,
      tenantId,
      visit,
      eventType: 'emergency.visit.created',
      actorUid: input.createdBy,
      actorRole: input.actorRole,
      payload: { arrival_mode: visit.arrival_mode },
    });
    return Object.freeze({ ...visit, pathway_mode: mode, pathway_evidence: evidence });
  });
}

export async function transitionEmergencyVisitWithPathwayEvidence({
  tenantId,
  id,
  nextStatus,
  disposition = null,
  acceptedHandoffId = null,
  actorUid = null,
  actorRole = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const visitId = positiveId(id, 'emergency_visit_id');
  return setTenantTx(tid, async tx => {
    const mode = await resolveEmergencyModeTx(tx, tid);
    const prior = await loadVisitTx(tx, tid, visitId, true);
    if (mode === PATHWAY_MODES.ACTIVE && nextStatus === 'admitted') {
      throw AppError.conflict(
        'An ED admission must be completed through the admission workflow',
        'ED_ADMISSION_WORKFLOW_REQUIRED',
      );
    }
    let destination = null;
    if (mode === PATHWAY_MODES.ACTIVE && nextStatus === 'transferred') {
      destination = await assertAcceptedDestinationTx({
        tx,
        tenantId: tid,
        visit: prior,
        acceptedHandoffId,
      });
    }
    const visit = await transitionEmergencyVisit({
      tenantId: tid,
      id: visitId,
      nextStatus,
      disposition,
      tx,
    });
    const evidence = await appendEmergencyEvidenceTx(tx, {
      mode,
      tenantId: tid,
      visit,
      prior,
      eventType: 'emergency.visit.transitioned',
      actorUid,
      actorRole,
      payload: {
        accepted_handoff_id: destination?.handoff_id || null,
        source_pathway_instance_id: destination?.pathway_instance_id || null,
      },
    });
    return Object.freeze({ ...visit, pathway_mode: mode, pathway_evidence: evidence });
  });
}

export async function recordEmergencyAdmissionClosureEvidenceTx(tx, {
  tenantId,
  priorVisit,
  visit,
  admission,
  actorUid,
  actorRole,
} = {}) {
  const tid = requireTenantId(tenantId);
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'ED admission closure evidence requires the admission transaction',
      'ED_ADMISSION_CLOSURE_TX_REQUIRED',
    );
  }
  const mode = await resolveEmergencyModeTx(tx, tid);
  if (mode === PATHWAY_MODES.ACTIVE) {
    const destination = await assertAcceptedDestinationTx({
      tx,
      tenantId: tid,
      visit,
      acceptedHandoffId: admission?.source_handoff_id,
      sourcePathwayInstanceId: admission?.source_pathway_instance_id,
    });
    if (
      destination.handoff_id !==
        String(admission.source_handoff_id || '').toLowerCase()
      || destination.pathway_instance_id !==
        String(admission.source_pathway_instance_id || '').toLowerCase()
    ) {
      throw AppError.conflict(
        'Admission source does not match the accepted ED destination handoff',
        'ED_DESTINATION_ADMISSION_SOURCE_INVALID',
      );
    }
  }
  return appendEmergencyEvidenceTx(tx, {
    mode,
    tenantId: tid,
    visit,
    prior: priorVisit,
    eventType: 'emergency.visit.destination_closed',
    actorUid,
    actorRole,
    payload: {
      admission_id: Number(admission.id),
      accepted_handoff_id: admission.source_handoff_id || null,
      source_pathway_instance_id: admission.source_pathway_instance_id || null,
    },
  });
}

export default {
  createEmergencyVisitWithPathwayEvidence,
  recordEmergencyAdmissionClosureEvidenceTx,
  transitionEmergencyVisitWithPathwayEvidence,
};
