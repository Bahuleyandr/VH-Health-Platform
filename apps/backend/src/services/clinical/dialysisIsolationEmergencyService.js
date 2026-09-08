import { setTenantTx } from '../../lib/prisma.js';
import { DIALYSIS_EMERGENCY_OVERRIDE_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import { reuseEligibilityTx } from './dialysisReuseService.js';
import { lockPatientExposureTx } from './patientExposureLock.js';

const ROUTING_CODES = Object.freeze([
  'DIALYSIS_MACHINE_UNREGISTERED',
  'DIALYSIS_ISOLATION_MACHINE_MISMATCH',
  'DIALYSIS_ISOLATION_GROUP_UNMAPPED',
  'DIALYSIS_UNKNOWN_ON_DEDICATED_GROUP',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidAuthorization() {
  return AppError.conflict('The bound isolation authorization is no longer valid', 'DIALYSIS_ISOLATION_EMERGENCY_INVALID');
}

function instant(value) {
  const parsed = typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(value)
    ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function authorityTx(tx, { tenantId, actor, approval, nowMs }) {
  if (!actor?.uid || !DIALYSIS_EMERGENCY_OVERRIDE_ROUTE_ROLES.includes(actor.role)) {
    throw AppError.forbidden('Role cannot authorize emergency isolation', 'DIALYSIS_ISOLATION_EMERGENCY_FORBIDDEN');
  }
  const approvedMs = instant(approval?.approved_at);
  if (!UUID.test(approval?.approved_by ?? '') || approval?.approved_role !== 'CONSULTANT'
    || approvedMs === null || approvedMs > nowMs
    || (actor.role === 'CONSULTANT' && actor.uid !== approval.approved_by)
    || (actor.role !== 'CONSULTANT' && actor.uid === approval.approved_by)) {
    throw AppError.conflict('A current accountable consultant approval is required', 'DIALYSIS_CONSULTANT_APPROVAL_REQUIRED');
  }
  const users = await tx.$queryRawUnsafe(
    `SELECT uid::text, role FROM users
      WHERE tenant_id = $1::uuid AND uid IN ($2::uuid, $3::uuid)
        AND is_active = TRUE AND status = 'active' AND COALESCE(is_deleted, FALSE) = FALSE AND deleted_at IS NULL
      ORDER BY uid FOR SHARE`,
    tenantId, actor.uid, approval.approved_by,
  );
  if (!users.some((user) => user.uid === actor.uid && user.role === actor.role)) {
    throw AppError.forbidden('The acting role is not currently assigned', 'DIALYSIS_ISOLATION_EMERGENCY_FORBIDDEN');
  }
  if (!users.some((user) => user.uid === approval.approved_by && user.role === 'CONSULTANT')) {
    throw AppError.conflict('A current accountable consultant approval is required', 'DIALYSIS_CONSULTANT_APPROVAL_REQUIRED');
  }
}

async function bindingTx(tx, { tenantId, patientUid, machineId }) {
  const [machine] = await tx.$queryRawUnsafe(
    `SELECT id, revision, machine_no, status FROM dialysis_machines
      WHERE tenant_id = $1::uuid AND id = $2::integer FOR SHARE`, tenantId, Number(machineId),
  );
  if (!machine || machine.status !== 'active') {
    throw AppError.conflict('The selected dialysis machine is inactive', 'DIALYSIS_MACHINE_INACTIVE');
  }
  const [settings] = await tx.$queryRawUnsafe(
    `SELECT settings.revision AS settings_revision, policy.revision AS policy_revision,
            settings.isolation_revision_id, policy.protocol_id
       FROM reprocessing_domain_settings settings
       JOIN reprocessing_domain_policies policy ON policy.tenant_id = settings.tenant_id
         AND policy.domain = settings.domain AND policy.category = 'dialyser'
      WHERE settings.tenant_id = $1::uuid AND settings.domain = 'dialysis'
        AND policy.reprocessable AND settings.isolation_revision_id IS NOT NULL
      FOR SHARE OF settings, policy`, tenantId,
  );
  if (!settings) {
    throw AppError.conflict('Approved dialysis routing configuration is required', 'DIALYSIS_ISOLATION_EMERGENCY_UNAVAILABLE');
  }
  const [protocol] = await tx.$queryRawUnsafe(
    `SELECT id, domain, category, reuse_matrix, surveillance_intervals_days, surveillance_overdue_blocks_reuse
       FROM reprocessing_protocols WHERE tenant_id = $1::uuid AND id = $2::integer AND status = 'active'`,
    tenantId, settings.protocol_id,
  );
  if (!protocol) {
    throw AppError.conflict('An active dialysis protocol is required', 'DIALYSIS_ISOLATION_EMERGENCY_UNAVAILABLE');
  }
  let fingerprint;
  await reuseEligibilityTx({
    tenantId, patientUid, db: tx, protocol,
    captureDecisionFingerprint: (value) => { fingerprint = value; },
  });
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw AppError.internal('Isolation evidence binding was not established', 'RPD_ISOLATION_DECISION_INVALID');
  }
  return { machine, settings, fingerprint };
}

async function obligationsTx(tx, { tenantId, row, actor, phase }) {
  const metadata = {
    domain: 'dialysis', authorization_id: row.id, session_id: row.bound_session_id ?? null, phase,
    approved_by: row.consultant_approved_by, approved_role: 'CONSULTANT',
    applied_by: row.applied_by, applied_role: row.applied_role,
  };
  const reviews = await tx.$queryRawUnsafe(
    `INSERT INTO medication_safety_reviews
      (tenant_id, patient_uid, review_type, severity, status, finding_code, message,
       override_required, override_reason, overridden_by, overridden_at, payload, created_by)
     VALUES ($1::uuid, $2::uuid, 'reprocessable_device_reuse', 'high', 'overridden',
       'ISOLATION_EMERGENCY_OVERRIDE', 'Emergency dialysis routing decision recorded',
       TRUE, $3, $4::uuid, clock_timestamp(), $5::jsonb, $4::uuid) RETURNING id`,
    tenantId, row.patient_uid, row.reason, actor.uid, JSON.stringify(metadata),
  );
  if (reviews.length !== 1) throw AppError.internal('Emergency review was not recorded', 'RPD_ACKNOWLEDGEMENT_WRITE_REQUIRED');
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs (tenant_id, uid, actor_uid, role, action, resource, resource_id, metadata)
     VALUES ($1::uuid, $2::uuid, $2::uuid, $3, 'dialysis.session.isolation_emergency_override',
       'dialysis_isolation_emergency_authorizations', $4, $5::jsonb)`,
    tenantId, actor.uid, actor.role, row.id, JSON.stringify(metadata),
  );
  await recordCanonicalClinicalEvent({
    tenantId, patientUid: row.patient_uid, eventType: 'dialysis.session.isolation_emergency_override',
    sourceTable: 'dialysis_isolation_emergency_authorizations', sourceId: row.id,
    actorUid: actor.uid, actorRole: actor.role, summary: 'Emergency dialysis routing decision recorded',
    visibleToPatient: false, payload: metadata,
    timelineIdempotencyKey: `dialysis-isolation-emergency:${row.id}:${phase}`,
    auditIdempotencyKey: `dialysis-isolation-emergency:${row.id}:${phase}:audit`,
  }, { db: tx });
  const officers = await tx.$queryRawUnsafe(
    `SELECT id, uid FROM users WHERE tenant_id = $1::uuid AND role = 'INFECTION_CONTROL_OFFICER'
      AND is_active = TRUE AND status = 'active' AND COALESCE(is_deleted, FALSE) = FALSE AND deleted_at IS NULL ORDER BY id`, tenantId,
  );
  if (officers.length === 0) {
    throw AppError.conflict('Configure an active infection-control notification recipient before emergency isolation',
      'DIALYSIS_INFECTION_CONTROL_RECIPIENT_REQUIRED');
  }
  for (const officer of officers) {
    const queued = await notificationOutbox.queue({
      tenantId, type: 'dialysis_isolation_emergency', channel: 'inapp', recipientId: officer.id,
      title: 'Emergency dialysis routing review', body: 'An approved emergency routing decision requires review.',
      sourceEventKey: `dialysis-isolation-emergency:${row.id}:${phase}:${officer.uid}`,
      templateVersion: 'dialysis-isolation-emergency.v1', data: metadata,
    }, { tx, strict: true });
    if (!queued) {
      throw AppError.internal('The infection-control notification was not recorded',
        'DIALYSIS_INFECTION_CONTROL_NOTIFICATION_REQUIRED');
    }
  }
}

export async function createIsolationEmergencyAuthorization(input) {
  return setTenantTx(input.tenantId, (tx) => createIsolationEmergencyAuthorizationTx(tx, input));
}

export async function createIsolationEmergencyAuthorizationTx(tx, {
  tenantId, patientUid, proposedMachineId, scheduledFor, reason, purpose,
  consultantApproval, expiresAt, actor, sessionId = null,
}) {
  const scheduledMs = instant(scheduledFor);
  if (!UUID.test(patientUid ?? '') || !Number.isSafeInteger(Number(proposedMachineId))
    || Number(proposedMachineId) < 1 || scheduledMs === null
    || typeof reason !== 'string' || !reason.trim() || typeof purpose !== 'string' || !purpose.trim()) {
    throw AppError.badRequest('Emergency isolation bindings and purpose are required', 'DIALYSIS_ISOLATION_EMERGENCY_INVALID');
  }
  await lockPatientExposureTx(tx, { tenantId, patientUid });
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':dialysis_routing', 0))::text`, tenantId,
  );
  const [{ now_ms: nowText }] = await tx.$queryRawUnsafe(
    'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS now_ms',
  );
  const nowMs = Number(nowText);
  const expiresMs = expiresAt == null ? nowMs + 4 * 3600000 : instant(expiresAt);
  if (expiresMs === null || expiresMs <= nowMs || expiresMs > nowMs + 4 * 3600000) throw invalidAuthorization();
  await authorityTx(tx, { tenantId, actor, approval: consultantApproval, nowMs });
  const binding = await bindingTx(tx, { tenantId, patientUid, machineId: proposedMachineId });
  const [row] = await tx.$queryRawUnsafe(
    `INSERT INTO dialysis_isolation_emergency_authorizations
      (tenant_id, patient_uid, machine_id, machine_revision, scheduled_for, decision_fingerprint,
       settings_revision, policy_revision, isolation_revision_id, protocol_id,
       consultant_approved_by, consultant_approved_role, consultant_approved_at,
       applied_by, applied_role, purpose, reason, created_at, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::integer, $4::bigint, $5::timestamptz, $6,
       $7::bigint, $8::bigint, $9::bigint, $10::integer, $11::uuid, 'CONSULTANT', $12::timestamptz,
       $13::uuid, $14, $15, $16, $17::timestamptz, $18::timestamptz)
     RETURNING id, patient_uid::text, consultant_approved_by::text, consultant_approved_role,
       consultant_approved_at, applied_by::text, applied_role, reason, bound_session_id, expires_at`,
    tenantId, patientUid, Number(proposedMachineId), binding.machine.revision, scheduledFor, binding.fingerprint,
    binding.settings.settings_revision, binding.settings.policy_revision,
    binding.settings.isolation_revision_id, binding.settings.protocol_id,
    consultantApproval.approved_by, consultantApproval.approved_at, actor.uid, actor.role,
    purpose.trim(), reason.trim(), new Date(nowMs).toISOString(), new Date(expiresMs).toISOString(),
  );
  if (sessionId != null) {
    await bindIsolationEmergencyTx(tx, { tenantId, authorizationId: row.id, sessionId });
    row.bound_session_id = Number(sessionId);
  }
  await obligationsTx(tx, { tenantId, row, actor, phase: 'authorized' });
  return {
    authorization_id: row.id, expires_at: new Date(expiresMs).toISOString(),
    approved_by: consultantApproval.approved_by, approved_role: 'CONSULTANT', approved_at: consultantApproval.approved_at,
  };
}

export async function boundIsolationEmergencyIdTx(tx, { tenantId, sessionId }) {
  const [row] = await tx.$queryRawUnsafe(
    `SELECT id FROM dialysis_isolation_emergency_authorizations
      WHERE tenant_id = $1::uuid AND bound_session_id = $2::integer
      ORDER BY created_at DESC, id DESC LIMIT 1`, tenantId, Number(sessionId),
  );
  return row?.id ?? null;
}

export async function validateIsolationEmergencyTx(tx, {
  tenantId, authorizationId, patientUid, machineId, scheduledFor, sessionId = null, codes = [],
}) {
  if (!UUID.test(authorizationId ?? '') || codes.some((code) => !ROUTING_CODES.includes(code))) throw invalidAuthorization();
  const [row] = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid::text, machine_id, machine_revision, decision_fingerprint,
       settings_revision, policy_revision, isolation_revision_id, protocol_id,
       consultant_approved_by::text, consultant_approved_at::text,
       applied_by::text, applied_role, reason, bound_session_id, consumed_at,
       expires_at <= clock_timestamp() AS expired,
       (EXTRACT(EPOCH FROM scheduled_for) * 1000)::bigint::text AS scheduled_ms
     FROM dialysis_isolation_emergency_authorizations
     WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`, tenantId, authorizationId,
  );
  if (!row || row.expired || row.consumed_at != null || row.patient_uid !== patientUid
    || String(row.machine_id) !== String(machineId)
    || (sessionId == null && row.bound_session_id != null)
    || (sessionId != null && Number(row.bound_session_id) !== Number(sessionId))) throw invalidAuthorization();
  if (sessionId == null) {
    if (instant(scheduledFor) !== Number(row.scheduled_ms)) throw invalidAuthorization();
  } else {
    const [session] = await tx.$queryRawUnsafe(
      `SELECT session.id FROM dialysis_sessions session
       JOIN dialysis_isolation_emergency_authorizations emergency
         ON emergency.tenant_id = session.tenant_id AND emergency.bound_session_id = session.id
       WHERE session.tenant_id = $1::uuid AND session.id = $2::integer AND emergency.id = $3::uuid
         AND session.status = 'scheduled' AND session.scheduled_start_at = emergency.scheduled_for
         AND session.session_date = emergency.scheduled_for::date`, tenantId, Number(sessionId), row.id,
    );
    if (!session) throw invalidAuthorization();
  }
  const [approver] = await tx.$queryRawUnsafe(
    `SELECT uid FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = 'CONSULTANT'
      AND is_active = TRUE AND status = 'active' AND COALESCE(is_deleted, FALSE) = FALSE AND deleted_at IS NULL FOR SHARE`,
    tenantId, row.consultant_approved_by,
  );
  if (!approver) throw invalidAuthorization();
  const binding = await bindingTx(tx, { tenantId, patientUid, machineId });
  if (String(row.machine_revision) !== String(binding.machine.revision)
    || row.decision_fingerprint !== binding.fingerprint
    || ['settings_revision', 'policy_revision', 'isolation_revision_id', 'protocol_id']
      .some((key) => String(row[key]) !== String(binding.settings[key]))) throw invalidAuthorization();
  return { reason: row.reason, by: row.applied_by, at: row.consultant_approved_at, kind: 'emergency' };
}

export async function bindIsolationEmergencyTx(tx, { tenantId, authorizationId, sessionId }) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE dialysis_isolation_emergency_authorizations emergency SET bound_session_id = $3::integer
      WHERE emergency.tenant_id = $1::uuid AND emergency.id = $2::uuid
        AND emergency.bound_session_id IS NULL AND emergency.consumed_at IS NULL
        AND emergency.expires_at > clock_timestamp()
        AND EXISTS (SELECT 1 FROM dialysis_sessions session
          WHERE session.tenant_id = emergency.tenant_id AND session.id = $3::integer
            AND session.status = 'scheduled' AND session.scheduled_start_at = emergency.scheduled_for
            AND session.session_date = emergency.scheduled_for::date)
      RETURNING emergency.id`, tenantId, authorizationId, Number(sessionId),
  );
  if (rows.length !== 1) throw invalidAuthorization();
}

export async function consumeIsolationEmergencyTx(tx, { tenantId, sessionId, authorizationId, actor }) {
  if (!UUID.test(authorizationId ?? '')) throw invalidAuthorization();
  const [row] = await tx.$queryRawUnsafe(
    `UPDATE dialysis_isolation_emergency_authorizations SET consumed_at = clock_timestamp(), consumed_by = $3::uuid
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND consumed_at IS NULL
        AND bound_session_id = $4::integer AND expires_at > clock_timestamp()
      RETURNING id, patient_uid::text, consultant_approved_by::text, applied_by::text, applied_role, reason, bound_session_id`,
    tenantId, authorizationId, actor.uid, Number(sessionId),
  );
  if (!row) throw invalidAuthorization();
  await obligationsTx(tx, { tenantId, row, actor, phase: 'consumed' });
}
