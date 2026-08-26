import { createHash, randomUUID } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin, isDoctor } from '../../utils/roleHelpers.js';
import { signDocumentTx } from '../clinical/documentIntegrityService.js';
import {
  completeWorkflowSla,
  recordCanonicalClinicalEvent,
  startWorkflowSla,
} from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { publishOpChildResourceLinkedFromEncounterTx } from '../appointment/opChildResourceEventService.js';
import {
  acknowledgeTask,
  createTask,
  transitionTask,
} from '../workflow/taskService.js';
import {
  isTaskHumanOwnerRole,
  resolveCurrentHumanActorTx,
  resolvePathwayTaskOwnerTx,
} from '../workflow/workflowHumanOwnerService.js';
import { recordPatientFeedNotificationWithReceipt } from '../../utils/notifications/patientNotificationFeed.js';
import {
  PREPERSISTED_FEED_NOTIFICATION_ID_PAYLOAD_KEY,
} from '../../utils/notifications/tenantNotificationChannels.js';
import referralService from './referralService.js';
import { assertReferralFacilityUsable } from './referralFacilityService.js';

const INTERNAL_TYPE = 'internal';
const REFERRAL_RESPONSE_RULE = 'referral_response';
const RECEIVER_TASK_RESOURCE = 'referrals';
const RESPONSE_TASK_RESOURCE = 'referral_specialist_response';
const ORIGINATOR_TASK_RESOURCE = 'referral_originator_closure';
const EXTERNAL_TASK_RESOURCE = 'external_referral_coordination';
const NOTIFICATION_SETTING = 'referral_notifications';
const NOTIFICATION_KIND = 'referral_response_ready';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value, label, { required = false, max = 8000 } = {}) {
  const normalized = value == null ? '' : String(value).trim();
  if (required && !normalized) throw AppError.badRequest(`${label} is required`);
  if (normalized.length > max) throw AppError.badRequest(`${label} is too long`);
  return normalized || null;
}

function uuid(value, label, { required = false } = {}) {
  const normalized = text(value, label, { required, max: 64 });
  if (normalized && !UUID_PATTERN.test(normalized)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return normalized?.toLowerCase() || null;
}

function timestamp(value, label) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw AppError.badRequest(`${label} must be a timestamp`);
  return parsed.toISOString();
}

function referralId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id <= 0) throw AppError.badRequest('Invalid referral ID');
  return id;
}

function priorityForUrgency(value) {
  const urgency = String(value || 'routine').trim().toLowerCase();
  if (urgency === 'emergency') return 'critical';
  if (urgency === 'urgent') return 'high';
  return 'normal';
}

function requestFingerprint(input) {
  return createHash('sha256').update(JSON.stringify({
    patient_uid: input.patientUid,
    encounter_id: input.encounterId || null,
    referring_doctor: input.referringDoctor,
    referred_to_doctor: input.referredToDoctor || null,
    referred_to_department: String(input.department).trim().toLowerCase(),
    referral_type: input.referralType,
    reason: String(input.reason).trim().replace(/\s+/g, ' ').toLowerCase(),
    urgency: input.urgency,
    expires_at: input.expiresAt,
    replacement_of_referral_id: input.replacementId || null,
    repeat_reason: input.repeatReason
      ? String(input.repeatReason).trim().replace(/\s+/g, ' ').toLowerCase()
      : null,
    destination_facility_id: input.destinationFacilityId || null,
  })).digest('hex');
}

function responseFingerprint(input) {
  return createHash('sha256').update(JSON.stringify({
    assessment: input.assessment,
    recommendations: input.recommendations,
    follow_up_plan: input.followUpPlan,
    patient_summary: input.patientSummary,
    patient_instructions: input.patientInstructions,
    release_to_patient: input.releaseToPatient,
    continuing_ownership: input.continuingOwnership,
    signed_by: input.signedBy,
  })).digest('hex');
}

function authenticatedRoles(context = {}) {
  const supplied = Array.isArray(context.actorRoles)
    ? context.actorRoles
    : (context.actorRoles ? [context.actorRoles] : []);
  return [...new Set([
    context.actorRole,
    context.actorRawRole,
    ...supplied,
  ].map((role) => String(role || '').trim().toUpperCase()).filter(Boolean))];
}

async function resolveActorTx(tx, tenantId, context = {}) {
  const roles = authenticatedRoles(context);
  return resolveCurrentHumanActorTx({
    tx,
    tenantId,
    actorUid: context.actorUid,
    authenticatedRoles: roles,
    authenticatedPrimaryRole: context.actorRole,
    authenticatedRawRole: context.actorRawRole,
    rolePredicate: (role) => isTaskHumanOwnerRole(role) || isAdmin(role),
  });
}

async function referralModeTx(tx, tenantId) {
  return resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.REFERRAL,
  });
}

async function loadReferralForUpdateTx(tx, tenantId, id) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM referrals
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    referralId(id),
  );
  if (!rows[0]) throw AppError.notFound('Referral not found');
  return rows[0];
}

async function resolveNamedReceiverTx(tx, tenantId, receiverUid, department) {
  const owner = await resolvePathwayTaskOwnerTx({
    tx,
    tenantId,
    requestedUid: uuid(receiverUid, 'referred_to_doctor', { required: true }),
  });
  const rows = await tx.$queryRawUnsafe(
    `SELECT u.uid,
            LOWER(BTRIM(COALESCE(d.department, dept.name, s.department, ''))) AS department,
            LOWER(BTRIM(COALESCE(d.specialty, ''))) AS specialty
       FROM users AS u
       JOIN doctors AS d ON d.user_id = u.id AND COALESCE(d.is_active, TRUE) = TRUE
       LEFT JOIN departments AS dept ON dept.id = d.department_id
       LEFT JOIN staff AS s ON s.user_id = u.uid
      WHERE u.tenant_id = $1::uuid
        AND u.uid = $2::uuid
      LIMIT 1
      FOR SHARE OF u, d`,
    tenantId,
    owner.assignedToUid,
  );
  const receiver = rows[0];
  const requestedDepartment = String(department || '').trim().toLowerCase();
  if (
    !receiver
    || (
      requestedDepartment
      && ![receiver.department, receiver.specialty].filter(Boolean)
        .some((value) => value === requestedDepartment || value.includes(requestedDepartment))
    )
  ) {
    throw AppError.conflict(
      'Named receiving doctor is not active and route-capable for the selected service',
      'REFERRAL_RECEIVER_UNAVAILABLE',
    );
  }
  return owner.assignedToUid;
}

async function assertReceiverAuthorityTx(tx, referral, actor) {
  const actorUid = String(actor.uid);
  const receiverUids = [
    referral.referred_to_doctor,
    referral.accepted_by,
    referral.performer_id,
  ].filter(Boolean).map(String);
  if (receiverUids.includes(actorUid)) return 'named_receiver';

  if (!referral.referred_to_doctor && referral.referred_to_department) {
    const tokens = await tx.$queryRawUnsafe(
      `SELECT LOWER(BTRIM(token)) AS token
         FROM (
           SELECT d.department AS token
             FROM users u JOIN doctors d ON d.user_id = u.id
            WHERE u.tenant_id = $1::uuid AND u.uid = $2::uuid
           UNION ALL
           SELECT d.specialty AS token
             FROM users u JOIN doctors d ON d.user_id = u.id
            WHERE u.tenant_id = $1::uuid AND u.uid = $2::uuid
           UNION ALL
           SELECT dept.name AS token
             FROM users u
             JOIN doctors d ON d.user_id = u.id
             JOIN departments dept ON dept.id = d.department_id
            WHERE u.tenant_id = $1::uuid AND u.uid = $2::uuid
         ) AS candidate
        WHERE NULLIF(BTRIM(token), '') IS NOT NULL`,
      referral.tenant_id,
      actorUid,
    );
    const department = String(referral.referred_to_department).trim().toLowerCase();
    if (tokens.some((row) => row.token === department)) return 'legacy_role_queue';
  }

  throw AppError.forbidden('Not authorized to act on this referral');
}

async function assertOriginatorAuthorityTx(
  tx,
  referral,
  actor,
  overrideReason = null,
  { allowAdministrativeReroute = false } = {},
) {
  if (String(referral.referring_doctor || '') === String(actor.uid)) return 'originator';
  const reason = text(overrideReason, 'override_reason', { max: 2000 });
  if (allowAdministrativeReroute && isAdmin(actor.role) && reason) return 'admin_reroute_override';
  if (isDoctor(actor.role) && reason) {
    const coverage = await tx.$queryRawUnsafe(
      `SELECT 1
         FROM care_team_members AS member
         JOIN care_teams AS team
           ON team.tenant_id = member.tenant_id
          AND team.id = member.care_team_id
          AND team.patient_uid = member.patient_uid
        WHERE member.tenant_id = $1::uuid
          AND member.patient_uid = $2::uuid
          AND member.staff_uid = $3::uuid
          AND LOWER(member.status) = 'active'
          AND member.active_from <= NOW()
          AND (member.active_until IS NULL OR member.active_until > NOW())
          AND LOWER(team.status) = 'active'
        LIMIT 1`,
      referral.tenant_id,
      referral.patient_uid,
      actor.uid,
    );
    if (coverage[0]) return 'covering_doctor_override';
  }
  throw AppError.forbidden('Not authorized to close or reroute this referral');
}

function assertViewerAuthority(referral, actor) {
  if (isAdmin(actor.role)) return;
  const participantUids = [
    referral.referring_doctor,
    referral.referred_to_doctor,
    referral.accepted_by,
    referral.performer_id,
    referral.requester_id,
    referral.current_owner_uid,
  ].filter(Boolean).map(String);
  if (!participantUids.includes(String(actor.uid))) {
    throw AppError.forbidden('Not authorized to view this referral');
  }
}

async function recordTransitionTx({
  tx,
  tenantId,
  referral,
  eventType,
  fromStatus,
  toStatus,
  fromOwnerUid,
  toOwnerUid,
  actor,
  reason = null,
  payload = {},
}) {
  const eventId = randomUUID();
  const sequenceRows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence
       FROM referral_transition_events
      WHERE tenant_id = $1::uuid
        AND referral_id = $2::integer`,
    tenantId,
    referral.id,
  );
  const sequenceNumber = Number(sequenceRows[0]?.next_sequence || 1);
  const canonical = await recordCanonicalClinicalEvent({
    tenantId,
    patientUid: referral.patient_uid,
    encounterId: referral.encounter_id,
    eventType,
    eventStatus: toStatus,
    sourceTable: 'referral_transition_events',
    sourceId: eventId,
    resourceType: 'referral',
    resourceId: referral.id,
    actorUid: actor.uid,
    actorRole: actor.role,
    summary: `Referral ${referral.referral_number} ${eventType.split('.').at(-1).replaceAll('_', ' ')}`,
    payload: {
      referral_id: referral.id,
      referral_number: referral.referral_number,
      from_status: fromStatus,
      to_status: toStatus,
      from_owner_uid: fromOwnerUid,
      to_owner_uid: toOwnerUid,
      reason,
      ...payload,
    },
    beforeState: { status: fromStatus, current_owner_uid: fromOwnerUid },
    afterState: { status: toStatus, current_owner_uid: toOwnerUid },
    timelineIdempotencyKey: `referral_transition_events:${eventId}:timeline`,
    auditIdempotencyKey: `referral_transition_events:${eventId}:audit`,
  }, { db: tx, strict: true });
  if (!canonical?.timeline?.id || !canonical?.audit?.id) {
    throw AppError.internal('Referral canonical evidence is unavailable');
  }
  await tx.$queryRawUnsafe(
    `INSERT INTO referral_transition_events
       (id, tenant_id, referral_id, patient_uid, encounter_id, sequence_number,
        event_type, from_status, to_status, from_owner_uid, to_owner_uid,
        reason, actor_uid, actor_role, event_payload,
        canonical_timeline_event_id, canonical_audit_event_id)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid, $6::integer,
        $7::text, $8::text, $9::text, $10::uuid, $11::uuid,
        $12::text, $13::uuid, $14::text, $15::jsonb,
        $16::uuid, $17::uuid)`,
    eventId,
    tenantId,
    referral.id,
    referral.patient_uid,
    referral.encounter_id || null,
    sequenceNumber,
    eventType,
    fromStatus,
    toStatus,
    fromOwnerUid || null,
    toOwnerUid || null,
    reason,
    actor.uid,
    actor.role,
    JSON.stringify(payload || {}),
    canonical.timeline.id,
    canonical.audit.id,
  );
  await publishEvent({
    eventType,
    aggregateType: 'referral',
    aggregateId: referral.id,
    patientUid: referral.patient_uid,
    tenantId,
    tx,
    payload: {
      referral_id: referral.id,
      transition_event_id: eventId,
      sequence_number: sequenceNumber,
      status: toStatus,
      current_owner_uid: toOwnerUid || null,
    },
  });
  return { id: eventId, sequence_number: sequenceNumber };
}

async function loadActiveTaskTx(tx, tenantId, resourceType, id) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND related_resource_type = $2::text
        AND related_resource_id = $3::text
        AND status IN ('open', 'in_progress', 'blocked', 'overdue')
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    resourceType,
    String(id),
  );
  return rows[0] || null;
}

async function acknowledgeReceiverTaskTx(tx, tenantId, referral, actor, context) {
  const task = await loadActiveTaskTx(tx, tenantId, RECEIVER_TASK_RESOURCE, referral.id);
  if (!task) return null;
  let current = task;
  if (current.status !== 'in_progress') {
    current = await acknowledgeTask({
      tenantId,
      id: current.id,
      actorUid: actor.uid,
      actorRoles: authenticatedRoles(context),
      actorPrimaryRole: context.actorRole,
      actorRawRole: context.actorRawRole,
      tx,
    });
  }
  if (current.status !== 'completed') {
    current = await transitionTask({
      tenantId,
      id: current.id,
      nextStatus: 'completed',
      actorUid: actor.uid,
      tx,
    });
  }
  return current;
}

async function createReceiverTaskTx(tx, tenantId, referral, receiverUid, actorUid, sla) {
  return createTask({
    tenantId,
    tx,
    taskKind: 'review',
    title: `Acknowledge referral ${referral.referral_number}`,
    description: `Review the ${referral.urgency} referral and accept, decline, or reroute it.`,
    patientUid: referral.patient_uid,
    relatedResourceType: RECEIVER_TASK_RESOURCE,
    relatedResourceId: String(referral.id),
    priority: priorityForUrgency(referral.urgency),
    assignedToUid: receiverUid,
    createdBy: actorUid,
    workflowSlaInstanceId: sla.id,
    slaCompletionSemantics: 'acknowledgement',
    metadata: {
      referral_stage: 'receiver_acknowledgement',
      referral_number: referral.referral_number,
      encounter_uuid: referral.encounter_id || null,
    },
    onConflictResourceDoNothing: true,
  });
}

async function createResponseTaskTx(tx, tenantId, referral, receiverUid, actorUid) {
  return createTask({
    tenantId,
    tx,
    taskKind: 'review',
    title: `Complete specialist response ${referral.referral_number}`,
    description: 'Record and sign the specialist assessment, recommendations, and follow-up plan.',
    patientUid: referral.patient_uid,
    relatedResourceType: RESPONSE_TASK_RESOURCE,
    relatedResourceId: String(referral.id),
    priority: priorityForUrgency(referral.urgency),
    assignedToUid: receiverUid,
    createdBy: actorUid,
    metadata: {
      referral_stage: 'specialist_response',
      referral_number: referral.referral_number,
      encounter_uuid: referral.encounter_id || null,
    },
    onConflictResourceDoNothing: true,
  });
}

async function rearmResponseSlaTx(tx, tenantId, referral, receiverUid, reason) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, rule_id
       FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid
        AND rule_code = $2::text
        AND source_table = 'referrals'
        AND source_id = $3::text
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    REFERRAL_RESPONSE_RULE,
    String(referral.id),
  );
  const sla = rows[0];
  if (!sla) throw AppError.conflict('Referral response clock is unavailable');
  const timing = await tx.$queryRawUnsafe(
    `SELECT target_minutes
       FROM workflow_sla_rules
      WHERE id = $1::uuid
        AND enabled = TRUE
      LIMIT 1`,
    sla.rule_id,
  );
  const targetMinutes = Number(timing[0]?.target_minutes);
  if (!Number.isInteger(targetMinutes) || targetMinutes <= 0) {
    throw AppError.conflict('Referral response clock rule is unavailable');
  }
  const updated = await tx.$queryRawUnsafe(
    `UPDATE workflow_sla_instances
        SET status = 'active',
            completed_at = NULL,
            breached_at = NULL,
            escalated_at = NULL,
            assigned_user_uid = $3::uuid,
            assigned_role_codes = ARRAY[]::text[],
            started_at = NOW(),
            due_at = NOW() + ($4::integer * INTERVAL '1 minute'),
            metadata = (COALESCE(metadata, '{}'::jsonb)
              - 'completed_via' - 'completed_by_task' - 'completed_by'
              - 'acknowledged_by' - 'completion_evidence')
              || jsonb_build_object('reopened_at', NOW(), 'reopen_reason', $5::text),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      RETURNING *`,
    tenantId,
    sla.id,
    receiverUid,
    targetMinutes,
    reason,
  );
  return updated[0];
}

async function queuePatientNotificationTx(tx, tenantId, referral, responseId) {
  const mode = await resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.REFERRAL,
  });
  const settings = await tx.$queryRawUnsafe(
    `SELECT settings #>> ARRAY['care_pathways', $2::text] AS notification_mode
       FROM tenants
      WHERE id = $1::uuid
      FOR SHARE`,
    tenantId,
    NOTIFICATION_SETTING,
  );
  if (
    mode !== PATHWAY_MODES.ACTIVE
    || String(settings[0]?.notification_mode || '').trim().toLowerCase() !== 'enabled'
  ) return null;

  const patients = await tx.$queryRawUnsafe(
    `SELECT id, phone FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid
      LIMIT 1`,
    tenantId,
    referral.patient_uid,
  );
  const feedReceipt = await recordPatientFeedNotificationWithReceipt({
    client: tx,
    tenantId,
    userId: patients[0]?.id || null,
    uid: String(referral.patient_uid),
    phone: patients[0]?.phone || null,
    title: 'Referral update available',
    body: 'Open VH Health to securely view your referral update.',
    type: 'referral_response_ready',
    data: {
      referral_id: String(referral.id),
      response_id: String(responseId),
      route: '/portal/referrals',
    },
    context: 'referral-response-ready',
  });
  if (!feedReceipt.written) {
    throw new Error('Referral response notification feed insert was not confirmed');
  }
  const outbox = await tx.$queryRawUnsafe(
    `INSERT INTO notification_outbox
       (tenant_id, type, recipient_id, recipient_phone, title, body,
        payload, status, created_at)
     VALUES
       ($1::uuid, 'referral_response_ready', $2::text, $3::text,
        'Referral update available',
        'Open VH Health to securely view your referral update.',
        jsonb_build_object(
          'tenant_id', $1::text,
          'type', 'referral_response_ready',
          'route', '/portal/referrals',
          'referral_id', $4::text,
          'response_id', $5::text,
          $6::text, $7::integer
        ),
        'PENDING', NOW())
     RETURNING id`,
    tenantId,
    referral.patient_uid,
    patients[0]?.phone || null,
    String(referral.id),
    String(responseId),
    PREPERSISTED_FEED_NOTIFICATION_ID_PAYLOAD_KEY,
    feedReceipt.notificationId,
  );
  await tx.$queryRawUnsafe(
    `INSERT INTO referral_patient_notifications
       (tenant_id, response_id, patient_uid, notification_kind, notification_outbox_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer)
     ON CONFLICT (tenant_id, response_id, notification_kind) DO NOTHING`,
    tenantId,
    responseId,
    referral.patient_uid,
    NOTIFICATION_KIND,
    outbox[0].id,
  );
  return outbox[0].id;
}

export async function createClosedLoopReferral(input = {}, context = {}) {
  const tenantId = requireTenantId(input.tenant_id || context.tenantId);
  const patientUid = uuid(input.patient_uid, 'patient_uid', { required: true });
  const requesterUid = uuid(input.requester_id || context.actorUid, 'requester_id', { required: true });
  const department = text(input.referred_to_department, 'referred_to_department', { required: true, max: 200 });
  const reason = text(input.reason, 'reason', { required: true, max: 4000 });
  const referralType = String(input.referral_type || INTERNAL_TYPE).trim().toLowerCase();
  const urgency = String(input.urgency || 'routine').trim().toLowerCase();
  const expiresAt = timestamp(input.expires_at, 'expires_at');
  const replacementId = input.replacement_of_referral_id == null
    ? null
    : referralId(input.replacement_of_referral_id);
  const repeatReason = text(input.repeat_reason, 'repeat_reason', { max: 2000 });
  if (replacementId && !repeatReason) {
    throw AppError.badRequest('repeat_reason is required for a linked repeat referral');
  }
  if (!['internal', 'external'].includes(referralType)) throw AppError.badRequest('Invalid referral_type');
  if (!['routine', 'urgent', 'emergency'].includes(urgency)) throw AppError.badRequest('Invalid urgency');
  const destinationFacilityId = input.destination_facility_id == null
    ? null
    : Number.parseInt(input.destination_facility_id, 10);
  if (destinationFacilityId != null
      && (!Number.isSafeInteger(destinationFacilityId) || destinationFacilityId <= 0)) {
    throw AppError.badRequest('destination_facility_id must be a positive integer');
  }
  if (destinationFacilityId != null && referralType !== 'external') {
    throw AppError.badRequest(
      'destination_facility_id is only valid for external referrals',
      'REFERRAL_DESTINATION_FACILITY_EXTERNAL_ONLY',
    );
  }
  if (referralType === INTERNAL_TYPE && !input.referred_to_doctor) {
    throw AppError.badRequest(
      'A named receiving doctor is required for an internal referral',
      'REFERRAL_NAMED_RECEIVER_REQUIRED',
    );
  }
  await referralService._assertCanCreateForPatient({
    tenantId,
    patientUid,
    requesterUid,
    actorRole: context.actorRole,
    proposedDoctorUid: input.referring_doctor,
  });
  const referringDoctor = await referralService._resolveReferringDoctor({
    tenantId,
    patientUid,
    proposedDoctorUid: input.referring_doctor,
    requesterUid,
    actorRole: context.actorRole,
  });
  if (!referringDoctor) throw AppError.badRequest('A referring doctor is required');

  const result = await setTenantTx(tenantId, async (tx) => {
    const mode = await referralModeTx(tx, tenantId);
    if (mode === PATHWAY_MODES.OFF) {
      throw AppError.conflict(
        'Referral closed-loop writes are not enabled for this tenant',
        'REFERRAL_PATHWAY_NOT_ENABLED',
      );
    }
    const actor = await resolveActorTx(tx, tenantId, context);
    const receiverUid = referralType === INTERNAL_TYPE
      ? await resolveNamedReceiverTx(tx, tenantId, input.referred_to_doctor, department)
      : null;
    // Structured destination (migration 680): tenant ownership + active,
    // locked FOR SHARE so a concurrent deactivation cannot race the linkage.
    const destinationFacility = destinationFacilityId == null
      ? null
      : await assertReferralFacilityUsable(tx, tenantId, destinationFacilityId, { lock: true });
    const encounterId = uuid(input.encounter_id, 'encounter_id');
    const fingerprint = requestFingerprint({
      patientUid,
      encounterId,
      referringDoctor,
      referredToDoctor: receiverUid,
      department,
      referralType,
      reason,
      urgency,
      expiresAt,
      replacementId,
      repeatReason,
      destinationFacilityId,
    });
    const idempotencyKey = text(input.idempotency_key, 'idempotency_key', { max: 160 });
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0)) IS NULL AS locked`,
      `${tenantId}:referral-create:${idempotencyKey || fingerprint}`,
    );
    const replay = await tx.$queryRawUnsafe(
      `SELECT * FROM referrals
        WHERE tenant_id = $1::uuid
          AND (
            ($2::text IS NOT NULL AND idempotency_key = $2::text)
            OR (request_fingerprint = $3::char(64) AND closure_status = 'open'
                AND status IN ('pending', 'accepted', 'in_progress', 'completed'))
          )
        ORDER BY id DESC LIMIT 1`,
      tenantId,
      idempotencyKey,
      fingerprint,
    );
    if (replay[0]) {
      if (
        idempotencyKey
        && replay[0].idempotency_key === idempotencyKey
        && replay[0].request_fingerprint !== fingerprint
      ) {
        throw AppError.conflict(
          'Idempotency-Key was already used for a different referral request',
          'REFERRAL_IDEMPOTENCY_KEY_REUSED',
        );
      }
      return { referral: { ...replay[0], replayed: true }, created: false, mode };
    }
    if (replacementId) {
      const predecessor = await loadReferralForUpdateTx(tx, tenantId, replacementId);
      if (String(predecessor.patient_uid) !== patientUid) {
        throw AppError.conflict('Repeat referral must belong to the same patient');
      }
    }

    const prefix = `REF-${new Date().toISOString().slice(0, 7).replace('-', '')}-`;
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0)) IS NULL AS locked`,
      `${tenantId}:${prefix}`,
    );
    const numbers = await tx.$queryRawUnsafe(
      `SELECT referral_number FROM referrals
        WHERE tenant_id = $1::uuid AND referral_number LIKE $2::text
        ORDER BY id DESC LIMIT 1`,
      tenantId,
      `${prefix}%`,
    );
    const priorSequence = Number.parseInt(String(numbers[0]?.referral_number || '').split('-').at(-1), 10);
    const referralNumber = `${prefix}${String(Number.isFinite(priorSequence) ? priorSequence + 1 : 1).padStart(4, '0')}`;
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO referrals
         (referral_number, tenant_id, patient_uid, encounter_id,
          referring_doctor, referred_to_doctor, referred_to_department,
          referral_type, reason, urgency, priority, clinical_summary,
          requester_id, performer_id, source, request_context,
          current_owner_uid, request_fingerprint, idempotency_key,
          replacement_of_referral_id, repeat_reason, expires_at,
          destination_facility_id)
       VALUES
         ($1::text, $2::uuid, $3::uuid, $4::uuid,
          $5::uuid, $6::uuid, $7::text,
          $8::text, $9::text, $10::text, $11::text, $12::text,
          $13::uuid, $6::uuid, $14::text, $15::jsonb,
          $5::uuid, $16::char(64), $17::text, $18::integer, $19::text,
          $20::timestamptz, $21::int)
       RETURNING *`,
      referralNumber,
      tenantId,
      patientUid,
      encounterId,
      referringDoctor,
      receiverUid,
      department,
      referralType,
      reason,
      urgency,
      priorityForUrgency(urgency).toUpperCase(),
      text(input.clinical_summary, 'clinical_summary', { max: 12000 }),
      requesterUid,
      text(input.source || 'ward', 'source', { max: 50 }),
      JSON.stringify(input.request_context || {}),
      fingerprint,
      idempotencyKey,
      replacementId,
      repeatReason,
      expiresAt,
      destinationFacilityId,
    );
    const referral = inserted[0];
    await recordTransitionTx({
      tx,
      tenantId,
      referral,
      eventType: 'referral.requested',
      fromStatus: null,
      toStatus: 'pending',
      fromOwnerUid: null,
      toOwnerUid: referringDoctor,
      actor,
      payload: {
        referred_to_doctor: receiverUid,
        referred_to_department: department,
        destination_facility_id: destinationFacility ? Number(destinationFacility.id) : null,
        destination_facility_name: destinationFacility?.name || null,
      },
    });
    await publishOpChildResourceLinkedFromEncounterTx(tx, {
      tenantId,
      encounterId: referral.encounter_id,
      patientUid: referral.patient_uid,
      resourceType: 'referral',
      resourceId: referral.id,
      source: 'referrals.closed_loop_create',
    });
    if (referralType === INTERNAL_TYPE) {
      const sla = await startWorkflowSla({
        tenantId,
        ruleCode: REFERRAL_RESPONSE_RULE,
        patientUid,
        encounterId,
        sourceTable: 'referrals',
        sourceId: referral.id,
        priority: priorityForUrgency(urgency),
        assignedRoleCodes: [],
        assignedUserUid: receiverUid,
        metadata: { referral_number: referralNumber, referred_to_department: department },
      }, { db: tx, strict: true });
      if (!sla) throw AppError.conflict('Referral response clock is unavailable');
      if (mode === PATHWAY_MODES.ACTIVE) {
        const task = await createReceiverTaskTx(tx, tenantId, referral, receiverUid, actor.uid, sla);
        if (!task) throw AppError.conflict('Referral receiver task is unavailable');
      }
    } else if (mode === PATHWAY_MODES.ACTIVE) {
      await createTask({
        tenantId,
        tx,
        taskKind: 'follow_up',
        title: destinationFacility
          ? `Coordinate external referral ${referralNumber} to ${destinationFacility.name}`
          : `Coordinate external referral ${referralNumber}`,
        patientUid,
        relatedResourceType: EXTERNAL_TASK_RESOURCE,
        relatedResourceId: String(referral.id),
        priority: priorityForUrgency(urgency),
        assignedToUid: referringDoctor,
        createdBy: actor.uid,
        metadata: {
          referral_stage: 'external_coordination',
          destination_facility_id: destinationFacility ? Number(destinationFacility.id) : null,
          destination_facility_name: destinationFacility?.name || null,
          destination_facility_city: destinationFacility?.city || null,
          destination_facility_phone: destinationFacility?.phone || null,
        },
        onConflictResourceDoNothing: true,
      });
    }
    return { referral, created: true, mode };
  });

  if (result.created && result.mode === PATHWAY_MODES.ACTIVE) {
    const notifications = await referralService._notifyReferralRecipients(result.referral);
    return { ...result.referral, notifications, replayed: false };
  }
  return { ...result.referral, replayed: !result.created };
}

export async function markReferralSeenClosedLoop(id, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const actor = await resolveActorTx(tx, tenantId, context);
    const referral = await loadReferralForUpdateTx(tx, tenantId, id);
    await assertReceiverAuthorityTx(tx, referral, actor);
    if (referral.first_seen_at) return referral;
    const updated = await tx.$queryRawUnsafe(
      `UPDATE referrals
          SET first_seen_at = NOW(), first_seen_by = $3::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING *`,
      tenantId,
      referral.id,
      actor.uid,
    );
    await recordTransitionTx({
      tx, tenantId, referral: updated[0], eventType: 'referral.seen',
      fromStatus: referral.status, toStatus: referral.status,
      fromOwnerUid: referral.current_owner_uid, toOwnerUid: referral.current_owner_uid,
      actor,
    });
    return updated[0];
  });
}

export async function acceptClosedLoopReferral(id, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const mode = await referralModeTx(tx, tenantId);
    const actor = await resolveActorTx(tx, tenantId, context);
    const referral = await loadReferralForUpdateTx(tx, tenantId, id);
    const authorizationMode = await assertReceiverAuthorityTx(tx, referral, actor);
    const acceptance = await tx.$queryRawUnsafe(
      `SELECT actor_uid
         FROM referral_transition_events
        WHERE tenant_id = $1::uuid
          AND referral_id = $2::integer
          AND event_type = 'referral.accepted'
        ORDER BY sequence_number DESC
        LIMIT 1`,
      tenantId,
      referral.id,
    );
    if (
      ['accepted', 'in_progress', 'completed'].includes(referral.status)
      && (
        String(referral.accepted_by || '') === String(actor.uid)
        || String(acceptance[0]?.actor_uid || '') === String(actor.uid)
      )
      && referral.ownership_accepted_at
    ) return { ...referral, replayed: true };
    if (referral.status !== 'pending') {
      throw AppError.conflict(`Cannot accept referral with status: ${referral.status}`);
    }
    const receiverUid = referral.referred_to_doctor || actor.uid;
    if (mode === PATHWAY_MODES.ACTIVE) {
      const task = await acknowledgeReceiverTaskTx(tx, tenantId, referral, actor, context);
      if (!task) {
        throw AppError.conflict(
          'The named receiver task must exist before active-mode acceptance',
          'REFERRAL_RECEIVER_TASK_REQUIRED',
        );
      }
    } else {
      await completeWorkflowSla({
        tenantId,
        ruleCode: REFERRAL_RESPONSE_RULE,
        sourceTable: 'referrals',
        sourceId: referral.id,
        metadata: { completed_by: actor.uid, completed_by_action: 'accepted' },
      }, { db: tx });
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE referrals
          SET status = 'accepted',
              referred_to_doctor = $3::uuid,
              accepted_by = $3::uuid,
              performer_id = $3::uuid,
              accepted_at = NOW(),
              ownership_accepted_at = NOW(),
              current_owner_uid = $3::uuid,
              first_seen_at = COALESCE(first_seen_at, NOW()),
              first_seen_by = COALESCE(first_seen_by, $3::uuid),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING *`,
      tenantId,
      referral.id,
      receiverUid,
    );
    const updated = rows[0];
    if (mode === PATHWAY_MODES.ACTIVE) {
      const responseTask = await createResponseTaskTx(
        tx,
        tenantId,
        updated,
        receiverUid,
        actor.uid,
      );
      if (!responseTask) {
        throw AppError.conflict(
          'The named specialist response task is unavailable',
          'REFERRAL_RESPONSE_TASK_REQUIRED',
        );
      }
    }
    await recordTransitionTx({
      tx, tenantId, referral: updated, eventType: 'referral.accepted',
      fromStatus: referral.status, toStatus: updated.status,
      fromOwnerUid: referral.current_owner_uid, toOwnerUid: updated.current_owner_uid,
      actor,
      reason: context.overrideReason || null,
      payload: { authorization_mode: authorizationMode },
    });
    return updated;
  });
}

export async function declineClosedLoopReferral(id, input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const reason = text(input.reason || input.response_notes, 'reason', { required: true, max: 2000 });
  return setTenantTx(tenantId, async (tx) => {
    const mode = await referralModeTx(tx, tenantId);
    const actor = await resolveActorTx(tx, tenantId, context);
    const referral = await loadReferralForUpdateTx(tx, tenantId, id);
    const authorizationMode = await assertReceiverAuthorityTx(tx, referral, actor);
    if (
      referral.status === 'declined'
      && String(referral.response_notes || '').trim() === reason
    ) return { ...referral, replayed: true };
    if (referral.status !== 'pending') {
      throw AppError.conflict(`Cannot decline referral with status: ${referral.status}`);
    }
    if (mode === PATHWAY_MODES.ACTIVE) {
      const task = await acknowledgeReceiverTaskTx(tx, tenantId, referral, actor, context);
      if (!task) {
        throw AppError.conflict(
          'The named receiver task must exist before active-mode decline',
          'REFERRAL_RECEIVER_TASK_REQUIRED',
        );
      }
    } else {
      await completeWorkflowSla({
        tenantId,
        ruleCode: REFERRAL_RESPONSE_RULE,
        sourceTable: 'referrals',
        sourceId: referral.id,
        metadata: { completed_by: actor.uid, completed_by_action: 'declined' },
      }, { db: tx });
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE referrals
          SET status = 'declined', response_notes = $3::text,
              current_owner_uid = referring_doctor, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING *`,
      tenantId,
      referral.id,
      reason,
    );
    const updated = rows[0];
    await recordTransitionTx({
      tx, tenantId, referral: updated, eventType: 'referral.declined',
      fromStatus: referral.status, toStatus: updated.status,
      fromOwnerUid: referral.current_owner_uid, toOwnerUid: updated.current_owner_uid,
      actor, reason,
      payload: { authorization_mode: authorizationMode },
    });
    if (mode === PATHWAY_MODES.ACTIVE) {
      await createTask({
        tenantId,
        tx,
        taskKind: 'follow_up',
        title: `Reroute declined referral ${updated.referral_number}`,
        patientUid: updated.patient_uid,
        relatedResourceType: ORIGINATOR_TASK_RESOURCE,
        relatedResourceId: String(updated.id),
        priority: priorityForUrgency(updated.urgency),
        assignedToUid: updated.referring_doctor,
        createdBy: actor.uid,
        metadata: { referral_stage: 'reroute_after_decline', decline_reason: reason },
        onConflictResourceDoNothing: true,
      });
    }
    return updated;
  });
}

export async function rerouteClosedLoopReferral(id, input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const reason = text(input.reason, 'reason', { required: true, max: 2000 });
  const department = text(input.referred_to_department, 'referred_to_department', { required: true, max: 200 });
  return setTenantTx(tenantId, async (tx) => {
    const mode = await referralModeTx(tx, tenantId);
    const actor = await resolveActorTx(tx, tenantId, context);
    const referral = await loadReferralForUpdateTx(tx, tenantId, id);
    await assertOriginatorAuthorityTx(tx, referral, actor, context.overrideReason, {
      allowAdministrativeReroute: true,
    });
    const receiverUid = await resolveNamedReceiverTx(
      tx, tenantId, input.referred_to_doctor, department,
    );
    const priorReroute = await tx.$queryRawUnsafe(
      `SELECT reason, event_payload
         FROM referral_transition_events
        WHERE tenant_id = $1::uuid
          AND referral_id = $2::integer
          AND event_type = 'referral.rerouted'
        ORDER BY sequence_number DESC
        LIMIT 1`,
      tenantId,
      referral.id,
    );
    if (
      referral.status === 'pending'
      && String(referral.referred_to_doctor || '') === String(receiverUid)
      && String(referral.referred_to_department || '').trim().toLowerCase()
        === department.toLowerCase()
      && String(priorReroute[0]?.reason || '') === reason
      && String(priorReroute[0]?.event_payload?.new_receiver_uid || '') === String(receiverUid)
    ) return { ...referral, replayed: true };
    if (
      referral.closure_status !== 'open'
      || !['pending', 'accepted', 'in_progress', 'declined'].includes(referral.status)
    ) {
      throw AppError.conflict('Only an open referral can be rerouted');
    }
    const oldTask = await loadActiveTaskTx(tx, tenantId, RECEIVER_TASK_RESOURCE, referral.id);
    if (oldTask) {
      await completeWorkflowSla({
        tenantId,
        ruleCode: REFERRAL_RESPONSE_RULE,
        sourceTable: 'referrals',
        sourceId: referral.id,
        metadata: { completed_by: actor.uid, completed_by_action: 'rerouted' },
      }, { db: tx });
      await transitionTask({
        tenantId,
        id: oldTask.id,
        nextStatus: 'cancelled',
        cancellationReason: 'Referral rerouted to a new named receiver',
        tx,
      });
    }
    const oldResponseTask = await loadActiveTaskTx(
      tx,
      tenantId,
      RESPONSE_TASK_RESOURCE,
      referral.id,
    );
    if (oldResponseTask) {
      await transitionTask({
        tenantId,
        id: oldResponseTask.id,
        nextStatus: 'cancelled',
        cancellationReason: 'Referral rerouted before the specialist response was signed',
        tx,
      });
    }
    const sla = await rearmResponseSlaTx(tx, tenantId, referral, receiverUid, 'referral_rerouted');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE referrals
          SET status = 'pending', referred_to_doctor = $3::uuid,
              referred_to_department = $4::text,
              accepted_by = NULL, accepted_at = NULL,
              performer_id = $3::uuid,
              current_owner_uid = referring_doctor,
              ownership_accepted_at = NULL,
              response_notes = NULL,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING *`,
      tenantId,
      referral.id,
      receiverUid,
      department,
    );
    const updated = rows[0];
    if (mode === PATHWAY_MODES.ACTIVE) {
      await createReceiverTaskTx(tx, tenantId, updated, receiverUid, actor.uid, sla);
    }
    const originatorTask = await loadActiveTaskTx(
      tx, tenantId, ORIGINATOR_TASK_RESOURCE, referral.id,
    );
    if (originatorTask) {
      await transitionTask({ tenantId, id: originatorTask.id, nextStatus: 'completed', tx });
    }
    await recordTransitionTx({
      tx, tenantId, referral: updated, eventType: 'referral.rerouted',
      fromStatus: referral.status, toStatus: updated.status,
      fromOwnerUid: referral.current_owner_uid, toOwnerUid: updated.current_owner_uid,
      actor, reason,
      payload: {
        prior_receiver_uid: referral.referred_to_doctor,
        new_receiver_uid: receiverUid,
        new_department: department,
      },
    });
    return updated;
  });
}

export async function recordSignedReferralResponse(id, input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const assessment = text(input.assessment, 'assessment', { required: true, max: 12000 });
  const recommendations = text(input.recommendations, 'recommendations', { required: true, max: 12000 });
  const releaseToPatient = input.release_to_patient === true;
  const patientSummary = text(input.patient_summary, 'patient_summary', { max: 8000 });
  const patientInstructions = text(input.patient_instructions, 'patient_instructions', { max: 8000 });
  if (releaseToPatient && (!patientSummary || !patientInstructions)) {
    throw AppError.badRequest(
      'patient_summary and patient_instructions are required when releasing to the patient',
    );
  }
  const continuingOwnership = input.continuing_ownership === true;
  const followUpPlan = text(input.follow_up_plan, 'follow_up_plan', { max: 12000 });
  return setTenantTx(tenantId, async (tx) => {
    const mode = await referralModeTx(tx, tenantId);
    const actor = await resolveActorTx(tx, tenantId, context);
    const referral = await loadReferralForUpdateTx(tx, tenantId, id);
    const authorizationMode = await assertReceiverAuthorityTx(tx, referral, actor);
    const fingerprint = responseFingerprint({
      assessment,
      recommendations,
      followUpPlan,
      patientSummary,
      patientInstructions,
      releaseToPatient,
      continuingOwnership,
      signedBy: actor.uid,
    });
    const replay = await tx.$queryRawUnsafe(
      `SELECT response.*, signature.id AS signature_id,
              signature.content_hash, signature.signature_method
         FROM referral_responses AS response
         JOIN clinical_document_signatures AS signature
           ON signature.tenant_id = response.tenant_id
          AND signature.document_type = 'referral_response'
          AND signature.document_id = response.id::text
        WHERE response.tenant_id = $1::uuid
          AND response.referral_id = $2::integer
          AND response.request_fingerprint = $3::char(64)
        ORDER BY signature.signed_at DESC
        LIMIT 1
        FOR SHARE OF response, signature`,
      tenantId,
      referral.id,
      fingerprint,
    );
    if (replay[0]) {
      const { signature_id: signatureId, content_hash: contentHash,
        signature_method: signatureMethod, ...response } = replay[0];
      return {
        ...referral,
        response,
        signature: {
          id: signatureId,
          content_hash: contentHash,
          signature_method: signatureMethod,
        },
        replayed: true,
      };
    }
    if (!['accepted', 'in_progress'].includes(referral.status)) {
      throw AppError.conflict(`Cannot record a response with status: ${referral.status}`);
    }
    const responseTask = mode === PATHWAY_MODES.ACTIVE
      ? await loadActiveTaskTx(tx, tenantId, RESPONSE_TASK_RESOURCE, referral.id)
      : null;
    if (mode === PATHWAY_MODES.ACTIVE && !responseTask) {
      throw AppError.conflict(
        'The named specialist response task must exist before active-mode completion',
        'REFERRAL_RESPONSE_TASK_REQUIRED',
      );
    }
    const versions = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM referral_responses
        WHERE tenant_id = $1::uuid AND referral_id = $2::integer`,
      tenantId,
      referral.id,
    );
    const responseId = randomUUID();
    const responseRows = await tx.$queryRawUnsafe(
      `INSERT INTO referral_responses
         (id, tenant_id, referral_id, patient_uid, version,
          assessment, recommendations, follow_up_plan,
          patient_summary, patient_instructions, request_fingerprint, release_to_patient,
          continuing_ownership, signed_by, signer_role)
       VALUES
         ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::integer,
          $6::text, $7::text, $8::text,
          $9::text, $10::text, $11::char(64), $12::boolean,
          $13::boolean, $14::uuid, $15::text)
       RETURNING *`,
      responseId,
      tenantId,
      referral.id,
      referral.patient_uid,
      Number(versions[0]?.next_version || 1),
      assessment,
      recommendations,
      followUpPlan,
      patientSummary,
      patientInstructions,
      fingerprint,
      releaseToPatient,
      continuingOwnership,
      actor.uid,
      actor.role,
    );
    const response = responseRows[0];
    const signature = await signDocumentTx({
      documentType: 'referral_response',
      documentId: response.id,
      statement: text(input.signature_statement, 'signature_statement', { max: 2000 })
        || 'I attest that this structured referral response is complete and clinically accurate.',
    }, {
      actorUid: actor.uid,
      actorRole: actor.role,
      actorName: context.actorName || null,
    }, { tx });
    const nextOwner = continuingOwnership ? actor.uid : referral.referring_doctor;
    const rows = await tx.$queryRawUnsafe(
      `UPDATE referrals
          SET status = 'completed', completed_at = NOW(),
              response_notes = $3::text,
              current_owner_uid = $4::uuid,
              closure_status = CASE WHEN $5::boolean THEN 'closed' ELSE 'open' END,
              closure_reason = CASE WHEN $5::boolean THEN 'receiver_continuing_ownership' ELSE NULL END,
              closed_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
              closed_by = CASE WHEN $5::boolean THEN $4::uuid ELSE NULL END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING *`,
      tenantId,
      referral.id,
      recommendations,
      nextOwner,
      continuingOwnership,
    );
    const updated = rows[0];
    if (responseTask) {
      await transitionTask({
        tenantId,
        id: responseTask.id,
        nextStatus: 'completed',
        actorUid: actor.uid,
        tx,
      });
    }
    await recordTransitionTx({
      tx, tenantId, referral: updated, eventType: 'referral.response_signed',
      fromStatus: referral.status, toStatus: updated.status,
      fromOwnerUid: referral.current_owner_uid, toOwnerUid: updated.current_owner_uid,
      actor,
      payload: {
        response_id: response.id,
        response_version: response.version,
        signature_id: signature.id,
        authorization_mode: authorizationMode,
        continuing_ownership: continuingOwnership,
        release_to_patient: releaseToPatient,
      },
    });
    if (!continuingOwnership && mode === PATHWAY_MODES.ACTIVE) {
      await createTask({
        tenantId,
        tx,
        taskKind: 'follow_up',
        title: `Acknowledge specialist response ${updated.referral_number}`,
        description: 'Review the signed specialist response and record how it was incorporated into the care plan.',
        patientUid: updated.patient_uid,
        relatedResourceType: ORIGINATOR_TASK_RESOURCE,
        relatedResourceId: String(updated.id),
        priority: priorityForUrgency(updated.urgency),
        assignedToUid: updated.referring_doctor,
        createdBy: actor.uid,
        metadata: { referral_stage: 'originator_acknowledgement', response_id: response.id },
        onConflictResourceDoNothing: true,
      });
    }
    if (releaseToPatient) {
      await queuePatientNotificationTx(tx, tenantId, updated, response.id);
    }
    return { ...updated, response, signature };
  });
}

export async function closeReferralByOriginator(id, input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const disposition = String(input.disposition || '').trim().toLowerCase();
  const allowed = new Set(['plan_updated', 'no_further_action', 'patient_declined', 'lost_to_follow_up']);
  if (!allowed.has(disposition)) throw AppError.badRequest('Invalid closure disposition');
  const planUpdate = text(input.plan_update, 'plan_update', { required: true, max: 12000 });
  const recoveryAttempts = Array.isArray(input.recovery_attempts) ? input.recovery_attempts : [];
  if (['patient_declined', 'lost_to_follow_up'].includes(disposition) && recoveryAttempts.length === 0) {
    throw AppError.badRequest('recovery_attempts are required for this closure disposition');
  }
  return setTenantTx(tenantId, async (tx) => {
    const actor = await resolveActorTx(tx, tenantId, context);
    const referral = await loadReferralForUpdateTx(tx, tenantId, id);
    const authorizationMode = await assertOriginatorAuthorityTx(
      tx,
      referral,
      actor,
      context.overrideReason,
    );
    const priorClosure = await tx.$queryRawUnsafe(
      `SELECT event_payload
         FROM referral_transition_events
        WHERE tenant_id = $1::uuid
          AND referral_id = $2::integer
          AND event_type = 'referral.closed'
        ORDER BY sequence_number DESC
        LIMIT 1`,
      tenantId,
      referral.id,
    );
    if (
      referral.closure_status === 'closed'
      && referral.closure_reason === disposition
      && priorClosure[0]?.event_payload?.plan_update === planUpdate
      && JSON.stringify(priorClosure[0]?.event_payload?.recovery_attempts || [])
        === JSON.stringify(recoveryAttempts)
    ) return { ...referral, replayed: true };
    if (referral.status !== 'completed' || referral.closure_status !== 'open') {
      throw AppError.conflict('Referral is not awaiting originator closure');
    }
    const responseEvidence = await tx.$queryRawUnsafe(
      `SELECT response.id, signature.id AS signature_id
         FROM referral_responses AS response
         JOIN clinical_document_signatures AS signature
           ON signature.tenant_id = response.tenant_id
          AND signature.document_type = 'referral_response'
          AND signature.document_id = response.id::text
        WHERE response.tenant_id = $1::uuid
          AND response.referral_id = $2::integer
        ORDER BY response.version DESC, signature.signed_at DESC
        LIMIT 1
        FOR SHARE OF response, signature`,
      tenantId,
      referral.id,
    );
    if (!responseEvidence[0]) throw AppError.conflict('A signed specialist response is required');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE referrals
          SET closure_status = 'closed', closure_reason = $3::text,
              closed_at = NOW(), closed_by = $4::uuid,
              current_owner_uid = $4::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING *`,
      tenantId,
      referral.id,
      disposition,
      actor.uid,
    );
    const updated = rows[0];
    const task = await loadActiveTaskTx(tx, tenantId, ORIGINATOR_TASK_RESOURCE, referral.id);
    if (task) {
      if (task.status === 'blocked') {
        await transitionTask({ tenantId, id: task.id, nextStatus: 'in_progress', actorUid: actor.uid, tx });
      }
      await transitionTask({ tenantId, id: task.id, nextStatus: 'completed', actorUid: actor.uid, tx });
    }
    await recordTransitionTx({
      tx, tenantId, referral: updated, eventType: 'referral.closed',
      fromStatus: referral.status, toStatus: updated.status,
      fromOwnerUid: referral.current_owner_uid, toOwnerUid: updated.current_owner_uid,
      actor,
      reason: disposition,
      payload: {
        authorization_mode: authorizationMode,
        response_id: responseEvidence[0].id,
        signature_id: responseEvidence[0].signature_id,
        plan_update: planUpdate,
        recovery_attempts: recoveryAttempts,
      },
    });
    return updated;
  });
}

export async function linkReferralAppointment(id, input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const appointmentId = referralId(input.appointment_id);
  return setTenantTx(tenantId, async (tx) => {
    const actor = await resolveActorTx(tx, tenantId, context);
    const referral = await loadReferralForUpdateTx(tx, tenantId, id);
    if (
      ![referral.referring_doctor, referral.referred_to_doctor, referral.accepted_by]
        .filter(Boolean).map(String).includes(String(actor.uid))
      && !isAdmin(actor.role)
    ) throw AppError.forbidden('Not authorized to link this referral appointment');
    const appointments = await tx.$queryRawUnsafe(
      `SELECT appointment.id
         FROM appointments AS appointment
         JOIN users AS patient ON patient.id = appointment.patient_id
        WHERE appointment.tenant_id = $1::uuid
          AND appointment.id = $2::integer
          AND patient.uid = $3::uuid
        LIMIT 1
        FOR SHARE OF appointment`,
      tenantId,
      appointmentId,
      referral.patient_uid,
    );
    if (!appointments[0]) throw AppError.conflict('Appointment does not belong to the referral patient');
    if (Number(referral.appointment_id) === appointmentId) {
      return { ...referral, replayed: true };
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE referrals SET appointment_id = $3::integer, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer RETURNING *`,
      tenantId,
      referral.id,
      appointmentId,
    );
    await recordTransitionTx({
      tx, tenantId, referral: rows[0], eventType: 'referral.appointment_linked',
      fromStatus: referral.status, toStatus: referral.status,
      fromOwnerUid: referral.current_owner_uid, toOwnerUid: referral.current_owner_uid,
      actor,
      payload: { appointment_id: appointmentId },
    });
    return rows[0];
  });
}

/**
 * Sets or changes the structured destination facility of an EXTERNAL referral
 * (migration 680). Originator-gated with the same authority rules as closure /
 * reroute (admins and covering doctors need a recorded override reason), and
 * every change lands as a referral_transition_events row plus canonical
 * timeline + audit evidence via recordTransitionTx.
 */
export async function setReferralDestinationFacility(id, input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const nextFacilityId = Number.parseInt(input.destination_facility_id, 10);
  if (!Number.isSafeInteger(nextFacilityId) || nextFacilityId <= 0) {
    throw AppError.badRequest('destination_facility_id must be a positive integer');
  }
  return setTenantTx(tenantId, async (tx) => {
    const actor = await resolveActorTx(tx, tenantId, context);
    const referral = await loadReferralForUpdateTx(tx, tenantId, id);
    if (String(referral.referral_type || 'internal').trim().toLowerCase() !== 'external') {
      throw AppError.conflict(
        'Only an external referral can link a destination facility',
        'REFERRAL_DESTINATION_FACILITY_EXTERNAL_ONLY',
      );
    }
    await assertOriginatorAuthorityTx(tx, referral, actor, context.overrideReason, {
      allowAdministrativeReroute: true,
    });
    if (Number(referral.destination_facility_id) === nextFacilityId) {
      return { ...referral, replayed: true };
    }
    if (referral.closure_status !== 'open') {
      throw AppError.conflict('Only an open referral can change its destination facility');
    }
    const facility = await assertReferralFacilityUsable(tx, tenantId, nextFacilityId, { lock: true });
    const rows = await tx.$queryRawUnsafe(
      `UPDATE referrals
          SET destination_facility_id = $3::int, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING *`,
      tenantId,
      referral.id,
      facility.id,
    );
    const updated = rows[0];
    await recordTransitionTx({
      tx, tenantId, referral: updated, eventType: 'referral.destination_facility_changed',
      fromStatus: referral.status, toStatus: updated.status,
      fromOwnerUid: referral.current_owner_uid, toOwnerUid: updated.current_owner_uid,
      actor,
      reason: text(input.reason, 'reason', { max: 2000 }),
      payload: {
        prior_destination_facility_id: referral.destination_facility_id == null
          ? null
          : Number(referral.destination_facility_id),
        destination_facility_id: Number(facility.id),
        destination_facility_name: facility.name,
        destination_facility_city: facility.city,
      },
    });
    return updated;
  });
}

export async function getClosedLoopReferral(id, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const actor = await resolveActorTx(tx, tenantId, context);
    const rows = await tx.$queryRawUnsafe(
      `SELECT r.*,
              (SELECT jsonb_build_object(
                     'id', f.id, 'name', f.name, 'facility_type', f.facility_type,
                     'city', f.city, 'phone', f.phone, 'active', f.active)
                 FROM referral_facilities f
                WHERE f.tenant_id = r.tenant_id
                  AND f.id = r.destination_facility_id) AS destination_facility
         FROM referrals r WHERE r.tenant_id = $1::uuid AND r.id = $2::integer LIMIT 1`,
      tenantId,
      referralId(id),
    );
    const referral = rows[0];
    if (!referral) throw AppError.notFound('Referral not found');
    assertViewerAuthority(referral, actor);
    const [responses, transitions] = await Promise.all([
      tx.$queryRawUnsafe(
        `SELECT response.*,
                signature.id AS signature_id,
                signature.content_hash,
                signature.signature_method
           FROM referral_responses AS response
           LEFT JOIN LATERAL (
             SELECT id, content_hash, signature_method
               FROM clinical_document_signatures
              WHERE tenant_id = response.tenant_id
                AND document_type = 'referral_response'
                AND document_id = response.id::text
              ORDER BY signed_at DESC LIMIT 1
           ) AS signature ON TRUE
          WHERE response.tenant_id = $1::uuid AND response.referral_id = $2::integer
          ORDER BY response.version DESC`,
        tenantId,
        referral.id,
      ),
      tx.$queryRawUnsafe(
        `SELECT * FROM referral_transition_events
          WHERE tenant_id = $1::uuid AND referral_id = $2::integer
          ORDER BY sequence_number`,
        tenantId,
        referral.id,
      ),
    ]);
    return { ...referral, responses, transitions };
  });
}

export default {
  createClosedLoopReferral,
  markReferralSeenClosedLoop,
  acceptClosedLoopReferral,
  declineClosedLoopReferral,
  rerouteClosedLoopReferral,
  recordSignedReferralResponse,
  closeReferralByOriginator,
  linkReferralAppointment,
  setReferralDestinationFacility,
  getClosedLoopReferral,
};
