/**
 * HIPAA PHI Access Logging Middleware
 *
 * Automatically logs PHI (Protected Health Information) access for routes
 * that handle patient medical data. Applied at the route level to avoid
 * needing logPhiAccess() calls in every individual controller.
 *
 * Usage in app.js:
 *   app.use('/api/v1/records', phiAccessLogger('MEDICAL_RECORD'), recordRoutes);
 *   app.use('/api/v1/prescriptions', phiAccessLogger('PRESCRIPTION'), prescriptionRoutes);
 */

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { logPhiAccess } from '../utils/hipaaAudit.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_ONLY_PATIENT_ACCESS = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'MEDICAL_SUPERINTENDENT',
  'CMO',
  'CNO',
  'MEDICAL_RECORDS',
]);

/**
 * Derive the patient ID from the request (params, query, or body).
 */
function derivePatientId(req) {
  return req.phiContext?.patientId
    || req.phiContext?.patient_id
    || req.phiContext?.patientUid
    || req.phiContext?.patient_uid
    || req.params?.patientId
    || req.params?.patient_uid
    || req.params?.patientUid
    || req.params?.uid
    || req.query?.patient_uid
    || req.query?.patientUid
    || req.query?.patientId
    || req.query?.patient_id
    || req.query?.phone   // phone can identify a patient
    || req.query?.patient_phone
    || req.query?.patientPhone
    || req.body?.patient_uid
    || req.body?.patientUid
    || req.body?.patientId
    || req.body?.patient_id
    || req.body?.phone
    || req.body?.patient_phone
    || req.body?.patientPhone
    || null;
}

/**
 * Map HTTP method to HIPAA action.
 */
function deriveAction(method) {
  switch (method) {
    case 'GET': case 'HEAD': return 'VIEW';
    case 'POST': return 'CREATE';
    case 'PUT': case 'PATCH': return 'UPDATE';
    case 'DELETE': return 'DELETE';
    default: return 'ACCESS';
  }
}

function deriveTenantId(req) {
  return req.tenantId
    || req.user?.tenant_id
    || req.user?.tenantId
    || req.tenant?.id
    || DEFAULT_TENANT_ID;
}

function actorUidOf(req) {
  return req.acting?.actorUid ?? req.user?.uid ?? null;
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

async function resolvePatientForAccess(req) {
  const directUid = cleanUuid(
    req.phiContext?.patientUid
      || req.phiContext?.patient_uid
      || req.params?.patient_uid
      || req.params?.patientUid
      || req.params?.uid
      || req.query?.patient_uid
      || req.query?.patientUid
      || req.body?.patient_uid
      || req.body?.patientUid,
  );
  if (directUid) return { uid: directUid, id: null };

  const raw = derivePatientId(req);
  if (!raw) return null;
  const tenantId = deriveTenantId(req);
  const asId = cleanInt(raw);
  const text = String(raw).trim();
  const digits = text.replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : null;

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
    last10,
  );
  const row = rows[0];
  return row ? { id: row.id, uid: row.uid } : null;
}

async function writePatientAccessAudit(req, patientUid, decision) {
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
      deriveTenantId(req),
      patientUid,
      cleanUuid(actorUidOf(req)),
      req.acting?.actorRole ?? req.user?.role ?? 'UNKNOWN',
      decision.accessDecision,
      decision.accessSource,
      decision.reason ?? null,
      String(req.originalUrl || req.url || '').slice(0, 255),
      deriveAction(req.method),
      decision.careTeamId ?? null,
      decision.breakGlassId ?? null,
      req.id ? String(req.id) : null,
      JSON.stringify({
        record_type: decision.recordType ?? null,
        actor_id: req.user?.id ?? null,
        subject_uid: req.user?.uid ?? null,
        acting_as_dependent: req.acting != null,
      }),
    );
  } catch (err) {
    logger.warn('Patient access audit write failed', {
      path: req.originalUrl || req.url,
      error: err?.message,
    });
  }
}

async function evaluatePatientAccess(req, patient) {
  const tenantId = deriveTenantId(req);
  const role = String(req.acting?.actorRole ?? req.user?.role ?? '').toUpperCase();
  const actorUid = cleanUuid(actorUidOf(req));
  const actorId = cleanInt(req.user?.id);
  const patientUid = cleanUuid(patient?.uid);

  if (!patientUid) {
    return { allowed: true, accessDecision: 'allow', accessSource: 'unknown', reason: 'patient unresolved' };
  }

  if (ROLE_ONLY_PATIENT_ACCESS.has(role)) {
    return { allowed: true, accessDecision: 'allow', accessSource: 'role', reason: `${role} role override` };
  }

  if (role === 'PATIENT' && cleanUuid(req.user?.uid) === patientUid) {
    return { allowed: true, accessDecision: 'allow', accessSource: 'guardian', reason: 'patient self access' };
  }

  if (req.acting && cleanUuid(req.user?.uid) === patientUid) {
    return { allowed: true, accessDecision: 'allow', accessSource: 'guardian', reason: 'guardian acting-as dependent' };
  }

  if (actorUid) {
    const breakGlass = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM patient_access_break_glass
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND actor_uid = $3::uuid
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY started_at DESC
        LIMIT 1`,
      tenantId,
      patientUid,
      actorUid,
    );
    if (breakGlass[0]?.id) {
      return {
        allowed: true,
        accessDecision: 'break_glass',
        accessSource: 'break_glass',
        reason: 'active break-glass session',
        breakGlassId: breakGlass[0].id,
      };
    }
  }

  const careTeam = await prisma.$queryRawUnsafe(
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
    tenantId,
    patientUid,
    actorUid,
    actorId,
    role || null,
  );
  if (careTeam[0]?.care_team_id) {
    return {
      allowed: true,
      accessDecision: 'allow',
      accessSource: 'care_team',
      reason: 'active care-team relationship',
      careTeamId: careTeam[0].care_team_id,
    };
  }

  if (actorId || actorUid) {
    const appointment = await prisma.$queryRawUnsafe(
      `SELECT a.id
         FROM appointments a
         JOIN users p ON p.id = a.patient_id
         LEFT JOIN users d ON d.id = a.doctor_id
        WHERE a.tenant_id = $1::uuid
          AND p.uid = $2::uuid
          AND (
            ($3::int IS NOT NULL AND a.doctor_id = $3::int)
            OR ($4::uuid IS NOT NULL AND d.uid = $4::uuid)
          )
          AND COALESCE(a.status, '') NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
          AND a.appointment_date >= (CURRENT_DATE - INTERVAL '30 days')
        ORDER BY a.appointment_date DESC, a.id DESC
        LIMIT 1`,
      tenantId,
      patientUid,
      actorId,
      actorUid,
    );
    if (appointment[0]?.id) {
      return { allowed: true, accessDecision: 'allow', accessSource: 'appointment', reason: 'assigned appointment relationship' };
    }
  }

  const inpatientRelationshipRoles = [
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'ICU_NURSE',
    'DUTY_DOCTOR',
    'DOCTOR',
  ];
  if (inpatientRelationshipRoles.includes(role)) {
    const admission = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND COALESCE(status, '') NOT IN ('DISCHARGED', 'CANCELLED')
          AND (
            $4::text IN ('NURSING_STAFF', 'NURSING_INCHARGE', 'IP_STAFF_NURSE', 'IP_INCHARGE', 'ICU_NURSE')
            OR (
              $3::uuid IS NOT NULL
              AND (
                admitting_doctor = $3::uuid
                OR attending_doctor = $3::uuid
              )
            )
          )
        ORDER BY admitted_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      tenantId,
      patientUid,
      actorUid,
      role,
    );
    if (admission[0]?.id) {
      return { allowed: true, accessDecision: 'allow', accessSource: 'admission', reason: 'active admission relationship' };
    }
  }

  return {
    allowed: false,
    accessDecision: 'deny',
    accessSource: 'unknown',
    reason: 'No active role, care-team, appointment, admission, guardian, or break-glass relationship',
  };
}

export function patientAccessGuard(recordType = 'PHI') {
  return async function patientAccessGuardMiddleware(req, res, next) {
    try {
      const patient = await resolvePatientForAccess(req);
      if (!patient?.uid) return next();

      const decision = {
        ...(await evaluatePatientAccess(req, patient)),
        recordType,
      };
      req.patientAccessDecision = decision;
      req.phiContext = {
        ...(req.phiContext ?? {}),
        patientId: patient.id ?? req.phiContext?.patientId,
        patient_id: patient.id ?? req.phiContext?.patient_id,
        patientUid: patient.uid,
        patient_uid: patient.uid,
      };

      await writePatientAccessAudit(req, patient.uid, decision);

      if (!decision.allowed) {
        return res.status(403).json({
          success: false,
          message: 'Patient record access denied: no active care-team, appointment, admission, guardian, or break-glass relationship',
          code: 'PATIENT_ACCESS_DENIED',
          break_glass_available: true,
        });
      }

      return next();
    } catch (err) {
      if (err?.code === '42P01' || err?.meta?.code === '42P01') {
        logger.warn('Patient access guard skipped because governance tables are not migrated', {
          path: req.originalUrl || req.url,
        });
        return next();
      }
      logger.error('Patient access guard failed:', err);
      return res.status(500).json({
        success: false,
        message: 'Patient access check failed',
        code: 'PATIENT_ACCESS_CHECK_FAILED',
      });
    }
  };
}

/**
 * Create middleware that logs PHI access after the response is sent.
 * Fire-and-forget — never blocks the request.
 *
 * Captures both actor and subject so the acting-as delegation flow is
 * fully traceable:
 *   * userId  / accessed_by — historically the actor (kept).
 *   * actorUid              — the human pressing the button (=
 *     req.acting.actorUid when delegating, = req.user.uid otherwise).
 *   * subjectUid            — the patient whose record was accessed (=
 *     req.user.uid AFTER any acting-as rewrite).
 *   * actingAsDependent     — TRUE iff X-Acting-As-Uid was honoured.
 *
 * @param {string} recordType - PHI category: 'MEDICAL_RECORD', 'INVESTIGATION',
 *   'PRESCRIPTION', 'PHARMACY_ORDER', 'APPOINTMENT', 'ADMISSION', 'CLINICAL_NOTE',
 *   'VITAL_SIGN', 'DIAGNOSIS', 'CLINICAL_ORDER'
 * @returns {import('express').RequestHandler}
 */
export function phiAccessLogger(recordType) {
  const middleware = function phiAccessLoggerMiddleware(req, res, next) {
    // Log after response is sent (fire-and-forget)
    res.on('finish', () => {
      // Only log successful access (2xx/3xx), not auth failures or errors
      if (res.statusCode >= 400) return;

      const patientId = derivePatientId(req);
      const actorUid = req.acting?.actorUid ?? req.user?.uid ?? null;
      const subjectUid = req.user?.uid ?? null;
      const actingAsDependent = req.acting != null;

      // Use the actor (human pressing the button) for the legacy
      // accessed_by column — that preserves historical semantics, since
      // the column always meant "who initiated this access".
      const userId = actorUid || req.user?.id;

      // Skip if we can't identify who's accessing (middleware ran before auth)
      if (!userId) return;

      logPhiAccess({
        userId: String(userId),
        userRole: req.acting?.actorRole ?? req.user?.role ?? 'UNKNOWN',
        patientId: patientId ? String(patientId) : null,
        recordType,
        action: deriveAction(req.method),
        ip: req.ip,
        requestId: req.id,
        actorUid,
        subjectUid,
        actingAsDependent,
        deviceType: req.user?.deviceType ?? null,
        tenantId: deriveTenantId(req),
      });
    });

    next();
  };
  middleware.phiRecordType = recordType;
  return middleware;
}
