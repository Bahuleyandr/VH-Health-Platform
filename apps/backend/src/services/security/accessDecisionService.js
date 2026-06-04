import {
  getRolePolicy,
  getRolePolicyHash,
  getRolePolicyVersion,
  PHI_ACCESS_LEVELS,
} from '../../config/rolePolicyGraph.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import {
  ACCESS_POLICY_CODES,
  getAccessPolicy,
  policyCodeForRecordType,
  SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
} from './accessPolicyRegistry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PHI_LEVEL_RANK = {
  [PHI_ACCESS_LEVELS.NONE]: 0,
  [PHI_ACCESS_LEVELS.OPERATIONAL_ONLY]: 1,
  [PHI_ACCESS_LEVELS.STAFF_ONLY]: 1,
  [PHI_ACCESS_LEVELS.BASIC_PATIENT_CONTEXT]: 2,
  [PHI_ACCESS_LEVELS.PATIENT_RELATIONSHIP]: 3,
  [PHI_ACCESS_LEVELS.CLINICAL_LEADERSHIP]: 3,
  [PHI_ACCESS_LEVELS.ADMIN_BREAK_GLASS]: 4,
  [PHI_ACCESS_LEVELS.OWN_RECORD]: 5,
};

const DOCTOR_RELATIONSHIP_ROLES = new Set([
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'ANAESTHETIST',
  'ANESTHETIST',
]);

const OP_RELATIONSHIP_ROLES = new Set([
  'RECEPTIONIST',
  'RECEPTION_INCHARGE',
  'OP_STAFF_NURSE',
  'OP_INCHARGE',
  'BILLING_STAFF',
  'BILLING_INCHARGE',
  'FINANCE_INCHARGE',
  'INSURANCE_COORDINATOR',
]);

const IP_RELATIONSHIP_ROLES = new Set([
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'ICU_NURSE',
]);

const ADMISSION_OPERATIONS_ROLES = new Set([
  'ADMISSION_OFFICER',
  'IPD_COUNSELLOR',
  'RECEPTIONIST',
  'RECEPTION_INCHARGE',
  'BILLING_STAFF',
  'BILLING_INCHARGE',
  'FINANCE_INCHARGE',
  'INSURANCE_COORDINATOR',
]);

const MEDICAL_RECORDS_ROLES = new Set(['MEDICAL_RECORDS']);

export { ACCESS_POLICY_CODES, SAFE_PATIENT_ACCESS_DENIAL_MESSAGE };

export function deriveTenantIdFromRequest(req) {
  return req.tenantId
    || req.user?.tenant_id
    || req.user?.tenantId
    || req.tenant?.id
    || DEFAULT_TENANT_ID;
}

export function deriveActionFromRequest(req, policy = null) {
  if (policy?.action) return policy.action;
  switch (req?.method) {
    case 'GET':
    case 'HEAD':
      return 'VIEW';
    case 'POST':
      return 'CREATE';
    case 'PUT':
    case 'PATCH':
      return 'UPDATE';
    case 'DELETE':
      return 'DELETE';
    default:
      return 'ACCESS';
  }
}

function actorUidOf(req) {
  return req?.acting?.actorUid ?? req?.user?.uid ?? null;
}

function actorRoleOf(req) {
  return normalizeRole(req?.acting?.actorRole ?? req?.user?.role);
}

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

function cleanInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRole(value) {
  return String(value || '').trim().toUpperCase();
}

function requestedPatientToken(req) {
  return req?.phiContext?.patientId
    || req?.phiContext?.patient_id
    || req?.phiContext?.patientUid
    || req?.phiContext?.patient_uid
    || req?.params?.patientId
    || req?.params?.patient_id
    || req?.params?.patient_uid
    || req?.params?.patientUid
    || req?.params?.uid
    || req?.query?.patient_uid
    || req?.query?.patientUid
    || req?.query?.patientId
    || req?.query?.patient_id
    || req?.query?.phone
    || req?.query?.patient_phone
    || req?.query?.patientPhone
    || req?.body?.patient_uid
    || req?.body?.patientUid
    || req?.body?.patientId
    || req?.body?.patient_id
    || req?.body?.phone
    || req?.body?.patient_phone
    || req?.body?.patientPhone
    || null;
}

function rolePolicyFor(roleCode) {
  return getRolePolicy().roles.find((role) => role.role_code === normalizeRole(roleCode)) || null;
}

function rankPhiLevel(level) {
  return PHI_LEVEL_RANK[level] ?? 0;
}

function policyMinimumRank(policy) {
  if (!policy?.required_phi_level) return 0;
  return rankPhiLevel(policy.required_phi_level);
}

function hasRequiredCapability(rolePolicy, policy) {
  const required = Array.isArray(policy?.capability_groups) ? policy.capability_groups : [];
  if (!required.length) return true;
  const groups = rolePolicy?.access?.route_capability_groups || [];
  return required.some((group) => groups.includes(group));
}

function isSchemaMissing(err) {
  return err?.code === '42P01'
    || err?.meta?.code === '42P01'
    || /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

async function patientByIdOrUid({ tenantId, id = null, uid = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND role = 'PATIENT'
        AND (
          ($2::int IS NOT NULL AND id = $2::int)
          OR ($3::uuid IS NOT NULL AND uid = $3::uuid)
        )
      ORDER BY registered_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    tenantId,
    cleanInt(id),
    cleanUuid(uid),
  );
  return rows[0] || null;
}

export async function resolvePatientForAccess(req, providedPatient = null) {
  const tenantId = deriveTenantIdFromRequest(req);
  const providedUid = cleanUuid(providedPatient?.uid || providedPatient?.patient_uid || providedPatient?.patientUid);
  const providedId = cleanInt(providedPatient?.id || providedPatient?.patient_id || providedPatient?.patientId);
  if (providedUid || providedId) {
    const row = await patientByIdOrUid({ tenantId, id: providedId, uid: providedUid });
    return row ? { id: row.id ?? providedId, uid: row.uid ?? providedUid } : null;
  }

  const directUid = cleanUuid(
    req?.phiContext?.patientUid
      || req?.phiContext?.patient_uid
      || req?.params?.patient_uid
      || req?.params?.patientUid
      || req?.params?.uid
      || req?.query?.patient_uid
      || req?.query?.patientUid
      || req?.body?.patient_uid
      || req?.body?.patientUid,
  );
  const directId = cleanInt(
    req?.phiContext?.patientId
      || req?.phiContext?.patient_id
      || req?.params?.patientId
      || req?.params?.patient_id
      || req?.query?.patientId
      || req?.query?.patient_id
      || req?.body?.patientId
      || req?.body?.patient_id,
  );
  if (directUid || directId) {
    const row = await patientByIdOrUid({ tenantId, id: directId, uid: directUid });
    return row ? { id: row.id ?? directId, uid: row.uid ?? directUid } : null;
  }

  const raw = requestedPatientToken(req);
  if (!raw) return null;
  const asId = cleanInt(raw);
  const text = String(raw).trim();
  const digits = text.replace(/\D/g, '');
  const normalizedPhone = digits.length >= 10 ? digits.slice(-10) : null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND role = 'PATIENT'
        AND (
          ($2::int IS NOT NULL AND id = $2::int)
          OR ($3::uuid IS NOT NULL AND uid = $3::uuid)
          OR ($4::text IS NOT NULL AND phone = $4::text)
          OR ($5::text IS NOT NULL AND REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $5::text)
        )
      ORDER BY registered_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    tenantId,
    asId,
    cleanUuid(text),
    text || null,
    normalizedPhone,
  );
  const row = rows[0];
  return row ? { id: row.id, uid: row.uid } : null;
}

function baseDecision({ req, patient, policy, rolePolicy, allowed, accessDecision, accessSource, reason, extras = {} }) {
  return {
    allowed,
    accessDecision,
    accessSource,
    reason,
    policy_code: policy?.code || null,
    policy_title: policy?.title || null,
    policy_version: getRolePolicyVersion(),
    policy_hash: getRolePolicyHash(),
    safe_reason_code: policy?.safe_denial_code || 'PATIENT_ACCESS_DENIED',
    safe_denial_message: policy?.safe_denial_message || SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
    break_glass_available: Boolean(rolePolicy?.phi?.can_break_glass && policy?.break_glass_allowed),
    resource_type: policy?.resource_type || 'patient',
    patient_id: patient?.id ?? null,
    patient_uid: patient?.uid ?? null,
    actor_uid: cleanUuid(actorUidOf(req)),
    actor_id: cleanInt(req?.user?.id),
    actor_role: actorRoleOf(req) || 'UNKNOWN',
    phi_access_level: rolePolicy?.phi?.access_level || PHI_ACCESS_LEVELS.NONE,
    recordType: extras.recordType || null,
    ...extras,
  };
}

function allowDecision(args, accessSource, reason, extras = {}) {
  return baseDecision({
    ...args,
    allowed: true,
    accessDecision: accessSource === 'break_glass' ? 'break_glass' : 'allow',
    accessSource,
    reason,
    extras,
  });
}

function denyDecision(args, reason, extras = {}) {
  return baseDecision({
    ...args,
    allowed: false,
    accessDecision: 'deny',
    accessSource: 'unknown',
    reason,
    extras,
  });
}

async function findActiveBreakGlass(req, patient, policy, rolePolicy) {
  if (!rolePolicy?.phi?.can_break_glass || !policy?.break_glass_allowed) return null;
  const actorUid = cleanUuid(actorUidOf(req));
  const patientUid = cleanUuid(patient?.uid);
  if (!actorUid || !patientUid) return null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM patient_access_break_glass
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND actor_uid = $3::uuid
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY started_at DESC
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    patientUid,
    actorUid,
  );
  return rows[0] || null;
}

async function findCareTeamRelationship(req, patient, role) {
  const actorUid = cleanUuid(actorUidOf(req));
  const actorId = cleanInt(req?.user?.id);
  const patientUid = cleanUuid(patient?.uid);
  if (!patientUid) return null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT ctm.id, ctm.care_team_id
       FROM care_team_members ctm
       JOIN care_teams ct ON ct.id = ctm.care_team_id
      WHERE ctm.tenant_id = $1::uuid
        AND ct.tenant_id = $1::uuid
        AND ct.patient_uid = $2::uuid
        AND ct.status = 'active'
        AND ctm.status = 'active'
        AND ctm.active_from <= NOW()
        AND (ctm.active_until IS NULL OR ctm.active_until >= NOW())
        AND (
          ($3::uuid IS NOT NULL AND ctm.staff_uid = $3::uuid)
          OR ($4::int IS NOT NULL AND ctm.staff_id = $4::int)
          OR ($5::text IS NOT NULL AND UPPER(COALESCE(ctm.staff_role, '')) = $5)
        )
      ORDER BY ctm.id DESC
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    patientUid,
    actorUid,
    actorId,
    role || null,
  );
  return rows[0] || null;
}

async function findAppointmentRelationship(req, patient, role) {
  const actorUid = cleanUuid(actorUidOf(req));
  const actorId = cleanInt(req?.user?.id);
  const patientUid = cleanUuid(patient?.uid);
  if (!patientUid) return null;

  const doctorScoped = DOCTOR_RELATIONSHIP_ROLES.has(role);
  const operationalScoped = OP_RELATIONSHIP_ROLES.has(role);
  if (!doctorScoped && !operationalScoped) return null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id
       FROM appointments a
       JOIN users p ON p.id = a.patient_id
       LEFT JOIN users d ON d.id = a.doctor_id
      WHERE a.tenant_id = $1::uuid
        AND p.uid = $2::uuid
        AND COALESCE(a.status, '') NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
        AND a.appointment_date >= (CURRENT_DATE - INTERVAL '30 days')
        AND a.appointment_date <= (CURRENT_DATE + INTERVAL '30 days')
        AND (
          $5::boolean = TRUE
          OR (
            $6::boolean = TRUE
            AND (
              ($3::int IS NOT NULL AND a.doctor_id = $3::int)
              OR ($4::uuid IS NOT NULL AND d.uid = $4::uuid)
            )
          )
        )
      ORDER BY a.appointment_date DESC, a.id DESC
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    patientUid,
    actorId,
    actorUid,
    operationalScoped,
    doctorScoped,
  );
  return rows[0] || null;
}

async function findAdmissionRelationship(req, patient, role) {
  const actorUid = cleanUuid(actorUidOf(req));
  const patientUid = cleanUuid(patient?.uid);
  if (!patientUid) return null;

  const nursingScoped = IP_RELATIONSHIP_ROLES.has(role);
  const doctorScoped = DOCTOR_RELATIONSHIP_ROLES.has(role);
  const operationalScoped = ADMISSION_OPERATIONS_ROLES.has(role);
  if (!nursingScoped && !doctorScoped && !operationalScoped) return null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM admissions
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND COALESCE(status, '') NOT IN ('DISCHARGED', 'CANCELLED')
        AND (
          $4::boolean = TRUE
          OR $5::boolean = TRUE
          OR (
            $6::boolean = TRUE
            AND $3::uuid IS NOT NULL
            AND (
              admitting_doctor = $3::uuid
              OR attending_doctor = $3::uuid
            )
          )
        )
      ORDER BY admitted_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    patientUid,
    actorUid,
    nursingScoped,
    operationalScoped,
    doctorScoped,
  );
  return rows[0] || null;
}

async function writePatientAccessAudit(req, decision) {
  if (!decision?.patient_uid) return;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_access_audit_log (
         tenant_id, patient_uid, actor_uid, actor_role,
         access_decision, access_source, reason, route, action,
         care_team_id, break_glass_id, request_id, metadata,
         created_by, updated_by, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4,
         $5, $6, $7, $8, $9,
         $10::int, $11::int, $12, $13::jsonb,
         $3::uuid, $3::uuid, NOW(), NOW()
       )`,
      deriveTenantIdFromRequest(req),
      decision.patient_uid,
      cleanUuid(actorUidOf(req)),
      decision.actor_role || 'UNKNOWN',
      decision.accessDecision,
      decision.accessSource,
      decision.reason ?? null,
      String(req?.originalUrl || req?.url || '').slice(0, 255),
      decision.action || deriveActionFromRequest(req),
      decision.careTeamId ?? null,
      decision.breakGlassId ?? null,
      req?.id ? String(req.id) : null,
      JSON.stringify({
        policy_code: decision.policy_code,
        policy_version: decision.policy_version,
        policy_hash: decision.policy_hash,
        record_type: decision.recordType ?? null,
        resource_type: decision.resource_type ?? null,
        phi_access_level: decision.phi_access_level ?? null,
        actor_id: req?.user?.id ?? null,
        subject_uid: req?.user?.uid ?? null,
        acting_as_dependent: req?.acting != null,
        shadow_mode: decision.shadow_mode === true,
      }),
    );
  } catch (err) {
    logger.warn('Patient access audit write failed', {
      path: req?.originalUrl || req?.url,
      error: err?.message,
    });
  }
}

export async function authorizePatientAccessRequest(req, {
  policyCode = null,
  recordType = 'PHI',
  patient = null,
  audit = true,
  shadowMode = false,
  requireResolvedPatient = false,
} = {}) {
  const policy = getAccessPolicy(policyCode || policyCodeForRecordType(recordType));
  if (!policy) {
    return {
      allowed: false,
      accessDecision: 'deny',
      accessSource: 'unknown',
      reason: `Unknown access policy: ${policyCode || recordType}`,
      policy_code: policyCode || null,
      safe_reason_code: 'UNKNOWN_ACCESS_POLICY',
      safe_denial_message: 'Access policy is not configured for this request',
      break_glass_available: false,
      policy_version: getRolePolicyVersion(),
      policy_hash: getRolePolicyHash(),
      shadow_mode: shadowMode,
    };
  }

  const resolvedPatient = await resolvePatientForAccess(req, patient);
  if (!resolvedPatient?.uid) {
    if (!requireResolvedPatient) return { allowed: true, no_patient_context: true, policy_code: policy.code };
    const rolePolicy = rolePolicyFor(actorRoleOf(req));
    return denyDecision({
      req,
      patient: null,
      policy,
      rolePolicy,
    }, 'Patient context could not be resolved for this access request', { recordType });
  }

  const role = actorRoleOf(req);
  const rolePolicy = rolePolicyFor(role);
  const args = {
    req,
    patient: resolvedPatient,
    policy,
    rolePolicy,
  };
  let decision;

  if (!rolePolicy) {
    decision = denyDecision(args, 'Actor role is not in the policy registry');
  } else if (role === 'PATIENT' && cleanUuid(req?.user?.uid) === cleanUuid(resolvedPatient.uid)) {
    decision = allowDecision(args, 'guardian', 'patient self access');
  } else if (req?.acting && cleanUuid(req?.user?.uid) === cleanUuid(resolvedPatient.uid)) {
    decision = allowDecision(args, 'guardian', 'guardian acting-as dependent');
  } else if (policy.required_phi_level === PHI_ACCESS_LEVELS.OWN_RECORD) {
    decision = denyDecision(args, 'Only the patient or an authorised guardian can perform this action');
  } else if (MEDICAL_RECORDS_ROLES.has(role) && [
    ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
    ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
    ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_VIEW,
    ACCESS_POLICY_CODES.PATIENT_TIMELINE_VIEW,
  ].includes(policy.code)) {
    decision = allowDecision(args, 'role', 'medical records office role');
  } else if ([PHI_ACCESS_LEVELS.NONE, PHI_ACCESS_LEVELS.STAFF_ONLY, PHI_ACCESS_LEVELS.OPERATIONAL_ONLY].includes(rolePolicy.phi?.access_level)) {
    decision = denyDecision(args, `${role} does not have a patient PHI access scope`);
  } else {
    const breakGlass = await findActiveBreakGlass(req, resolvedPatient, policy, rolePolicy);
    if (breakGlass?.id) {
      decision = allowDecision(args, 'break_glass', 'active break-glass session', { breakGlassId: breakGlass.id });
    }
  }

  if (!decision && rankPhiLevel(rolePolicy.phi?.access_level) < policyMinimumRank(policy)) {
    if (rolePolicy.phi?.access_level === PHI_ACCESS_LEVELS.ADMIN_BREAK_GLASS) {
      decision = denyDecision(args, 'Administrative PHI access requires an active break-glass session');
    } else {
      decision = denyDecision(args, `${role} does not meet the PHI level required by ${policy.code}`);
    }
  }

  if (!decision && !hasRequiredCapability(rolePolicy, policy)) {
    decision = denyDecision(args, `${role} is not assigned to the ${policy.code} capability group`);
  }

  if (!decision && policy.relationship_checks.includes('care_team')) {
    const careTeam = await findCareTeamRelationship(req, resolvedPatient, role);
    if (careTeam?.care_team_id) {
      decision = allowDecision(args, 'care_team', 'active care-team relationship', { careTeamId: careTeam.care_team_id });
    }
  }

  if (!decision && policy.relationship_checks.includes('appointment')) {
    const appointment = await findAppointmentRelationship(req, resolvedPatient, role);
    if (appointment?.id) {
      decision = allowDecision(args, 'appointment', 'active appointment relationship', { appointmentId: appointment.id });
    }
  }

  if (!decision && policy.relationship_checks.includes('admission')) {
    const admission = await findAdmissionRelationship(req, resolvedPatient, role);
    if (admission?.id) {
      decision = allowDecision(args, 'admission', 'active admission relationship', { admissionId: admission.id });
    }
  }

  if (!decision) {
    decision = denyDecision(args, 'No active care-team, appointment, admission, guardian, or break-glass relationship');
  }

  decision = {
    ...decision,
    action: deriveActionFromRequest(req, policy),
    recordType,
    shadow_mode: shadowMode,
    enforced: shadowMode !== true,
  };

  req.patientAccessDecision = decision;
  req.phiContext = {
    ...(req.phiContext ?? {}),
    patientId: resolvedPatient.id ?? req.phiContext?.patientId,
    patient_id: resolvedPatient.id ?? req.phiContext?.patient_id,
    patientUid: resolvedPatient.uid,
    patient_uid: resolvedPatient.uid,
  };

  if (audit && policy.audit_required !== false) {
    await writePatientAccessAudit(req, decision);
  }

  return shadowMode && !decision.allowed
    ? { ...decision, allowed: true, shadow_denied: true }
    : decision;
}

export function patientAccessErrorPayload(decision) {
  return {
    success: false,
    message: decision?.safe_denial_message || SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
    code: decision?.safe_reason_code || 'PATIENT_ACCESS_DENIED',
    break_glass_available: Boolean(decision?.break_glass_available),
    policy_code: decision?.policy_code || null,
    policy_version: decision?.policy_version || getRolePolicyVersion(),
    policy_hash: decision?.policy_hash || getRolePolicyHash(),
  };
}

export function shouldSkipAccessCheckError(err) {
  return isSchemaMissing(err);
}
