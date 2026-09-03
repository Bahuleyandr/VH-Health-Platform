import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  getClinicalAccountabilityRoleCodes,
  getRolePolicy,
  getRolePolicyHash,
  getRolePolicyVersion,
  PHI_ACCESS_LEVELS,
} from '../../config/rolePolicyGraph.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { isGovernanceSchemaMissing } from './schemaMissingGuard.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  ACCESS_POLICY_CODES,
  getAccessPolicy,
  policyCodeForRecordType,
  SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
} from './accessPolicyRegistry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const accessDecisionDbContext = new AsyncLocalStorage();

function accessDecisionDb() {
  return accessDecisionDbContext.getStore()?.db || prisma;
}

function accessDecisionUsesScopedDb() {
  return Boolean(accessDecisionDbContext.getStore()?.db);
}

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
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
]);

const MEDICAL_RECORDS_ROLES = new Set(['MEDICAL_RECORDS']);

const OPERATIONAL_ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const CLINICAL_ACCOUNTABILITY_ROLES = new Set(getClinicalAccountabilityRoleCodes());

const OPERATIONAL_ROLE_POLICIES = new Set([
  ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW,
  ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_WRITE,
  ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW,
  ACCESS_POLICY_CODES.PATIENT_ADMISSION_WRITE,
  ACCESS_POLICY_CODES.PATIENT_BED_VIEW,
  ACCESS_POLICY_CODES.PATIENT_BED_WRITE,
]);

// ---------------------------------------------------------------------------
// Administrative no-relationship grant (owner decision, 2026-08-25)
// ---------------------------------------------------------------------------
// The platform owner decided that an administrator may print a patient
// wristband without opening break-glass, and that every such print must be
// recorded for audit. This set is the ENTIRE surface of that decision: one
// policy code, used by one route (GET /api/v1/bcma/wristband/:patientUid).
//
// Three properties keep it from leaking, and each is pinned by a test in
// src/tests/bcma-wristband-admin-access.deep.test.js:
//   1. The set is keyed on policy CODE, so no other policy — above all
//      PATIENT_CLINICAL_WORKFLOW_ACCESS, which gates 27 clinical sites — can
//      match it. Adding a code here is a deliberate, reviewable act.
//   2. The grant is evaluated LAST, after every relationship check has failed.
//      An administrator who genuinely holds a care-team / authorship /
//      admission relationship is attributed to that relationship, and a live
//      break-glass session is still attributed to break_glass. The grant
//      therefore only ever fires when there is provably no care relationship,
//      which is exactly what the audit row claims.
//   3. Only ADMIN and SUPER_ADMIN qualify. Every other role that lacks a
//      relationship is still refused.
const ADMINISTRATIVE_NO_RELATIONSHIP_POLICIES = new Set([
  ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT,
]);

// Grant code written into the audit trail so "an administrator read this
// patient with no care relationship" is queryable, not inferred from prose.
export const ADMINISTRATIVE_ACCESS_GRANTS = Object.freeze({
  ADMINISTRATOR_NO_RELATIONSHIP: 'administrator_no_relationship',
});

/**
 * The last-resort administrative allow. Returns a grant code when `role` is an
 * administrator AND `policy` is one of the narrowly enumerated codes the owner
 * authorised; otherwise null. Callers must only consult it after every
 * relationship check has already failed.
 */
export function administrativeGrantForPolicy(role, policy) {
  if (!ADMINISTRATIVE_NO_RELATIONSHIP_POLICIES.has(policy?.code)) return null;
  if (!OPERATIONAL_ADMIN_ROLES.has(normalizeRole(role))) return null;
  return ADMINISTRATIVE_ACCESS_GRANTS.ADMINISTRATOR_NO_RELATIONSHIP;
}

export { ACCESS_POLICY_CODES, SAFE_PATIENT_ACCESS_DENIAL_MESSAGE };

export function deriveTenantIdFromRequest(req) {
  return requireTenantId(
    req.tenantId
    || req.user?.tenant_id
    || req.user?.tenantId
    || req.tenant?.id,
  );
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

function actorRawRoleOf(req) {
  const role = String(req?.acting?.actorRawRole ?? req?.user?.rawRole ?? '')
    .trim()
    .toUpperCase();
  return role || null;
}

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

// Postgres `integer` (int4) upper bound. A phone parsed with parseInt()
// (e.g. '9000090011' or '+91XXXXXXXXXX') yields a value far above this; binding
// it to an `id = $N::int` comparison throws 22003 "value out of range for type
// integer". No real SERIAL id can exceed int4, so rejecting out-of-range values
// here is correct AND closes the phone-as-id overflow the phone-resolution path
// below would otherwise hit.
const PG_INT4_MAX = 2147483647;

function cleanInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= PG_INT4_MAX ? parsed : null;
}

// Postgres `bigint` (int8) upper bound, for resolvers keyed on a BigInt id column
// (e.g. investigation_bookings.id). cleanInt() above is correctly int4-bounded to
// stop a phone string overflowing an `id = $N::int` comparison — but that bound
// is WRONG for a bigint id, which would silently reject any value above int4 max.
// Parse with BigInt (not parseInt → float) so ids beyond 2^53 stay precise, and
// return the canonical digit string, which binds safely to a `$N::bigint` param.
const PG_INT8_MAX = 9223372036854775807n;

function cleanBigInt(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null; // positive digits only — never a phone like '+91…'
  let parsed;
  try {
    parsed = BigInt(text);
  } catch {
    return null;
  }
  return parsed > 0n && parsed <= PG_INT8_MAX ? text : null;
}

function normalizeRole(value) {
  return String(value || '').trim().toUpperCase();
}

function namespacedPathwayOwnershipKey(req, actorUid, operation) {
  const rawHeader = typeof req?.get === 'function'
    ? req.get('Idempotency-Key')
    : req?.headers?.['idempotency-key'];
  const rawKey = typeof rawHeader === 'string' ? rawHeader.trim() : '';
  if (!rawKey || rawKey.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(rawKey)) return null;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ operation, rawKey }))
    .digest('hex');
  return `u:${actorUid}:${fingerprint}`;
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

function firstRow(rows) {
  return Array.isArray(rows) ? rows[0] || null : null;
}

function hasRequiredCapability(rolePolicy, policy) {
  const required = Array.isArray(policy?.capability_groups) ? policy.capability_groups : [];
  if (!required.length) return true;
  const groups = rolePolicy?.access?.route_capability_groups || [];
  return required.some((group) => groups.includes(group));
}

function canUseRoleOwnedOperationalAccess(role, policy) {
  if (!OPERATIONAL_ROLE_POLICIES.has(policy?.code)) return false;
  if (OPERATIONAL_ADMIN_ROLES.has(role)) return true;
  if (policy.code === ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW
    || policy.code === ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_WRITE) {
    return OP_RELATIONSHIP_ROLES.has(role) || DOCTOR_RELATIONSHIP_ROLES.has(role);
  }
  if (policy.code === ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW
    || policy.code === ACCESS_POLICY_CODES.PATIENT_ADMISSION_WRITE
    || policy.code === ACCESS_POLICY_CODES.PATIENT_BED_VIEW
    || policy.code === ACCESS_POLICY_CODES.PATIENT_BED_WRITE) {
    return ADMISSION_OPERATIONS_ROLES.has(role) || IP_RELATIONSHIP_ROLES.has(role) || DOCTOR_RELATIONSHIP_ROLES.has(role);
  }
  return false;
}

// Audit finding M3: the skip is now an exact-SQLSTATE, non-production-only
// check (see schemaMissingGuard.js). The old /does not exist/i message regex
// silently disabled the patient-access check on ANY error containing that
// phrase (renamed column, dropped function, partial migration).
function isSchemaMissing(err) {
  return isGovernanceSchemaMissing(err);
}

async function patientByIdOrUid({ tenantId, id = null, uid = null }) {
  const rows = await accessDecisionDb().$queryRawUnsafe(
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
  return firstRow(rows);
}

async function patientFromResourceQuery(req, sql, idValue) {
  const resourceId = cleanInt(idValue);
  if (!resourceId) return null;
  const rows = await accessDecisionDb().$queryRawUnsafe(
    sql,
    deriveTenantIdFromRequest(req),
    resourceId,
  );
  const row = rows[0] || null;
  return row?.uid ? { id: row.id ?? null, uid: row.uid } : null;
}

// Variant of patientFromResourceQuery for resources whose id column is a BigInt
// (e.g. investigation_bookings.id). Uses the int8-bounded cleanBigInt so ids
// above int4 max still resolve; binds the canonical digit string to the
// `$N::bigint` param in the query. Returns the same { id, uid } patient shape
// (the projected id is still the PATIENT's int4 users.id, not the bigint id).
async function patientFromBigintResourceQuery(req, sql, idValue) {
  const resourceId = cleanBigInt(idValue);
  if (!resourceId) return null;
  const rows = await accessDecisionDb().$queryRawUnsafe(
    sql,
    deriveTenantIdFromRequest(req),
    resourceId,
  );
  const row = rows[0] || null;
  return row?.uid ? { id: row.id ?? null, uid: row.uid } : null;
}

async function patientFromUuidResourceQuery(req, sql, uuidValue) {
  const resourceUid = cleanUuid(uuidValue);
  if (!resourceUid) return null;
  const rows = await accessDecisionDb().$queryRawUnsafe(
    sql,
    deriveTenantIdFromRequest(req),
    resourceUid,
  );
  const row = rows[0] || null;
  return row?.uid ? { id: row.id ?? null, uid: row.uid } : null;
}

export async function resolvePatientForResourceAccess(req, {
  resourceType,
  resourceId,
} = {}) {
  const type = String(resourceType || '').trim().toLowerCase();
  if (!type) return null;

  switch (type) {
    case 'care_pathway_instance':
      return patientFromUuidResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM care_pathway_instances cpi
           JOIN users p
             ON p.uid = cpi.patient_uid
            AND p.tenant_id = cpi.tenant_id
            AND p.role = 'PATIENT'
          WHERE cpi.tenant_id = $1::uuid
            AND cpi.id = $2::uuid
          LIMIT 1`,
        resourceId,
      );
    case 'care_handoff_instance':
      return patientFromUuidResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM care_handoff_instances chi
           JOIN users p
             ON p.uid = chi.patient_uid
            AND p.tenant_id = chi.tenant_id
            AND p.role = 'PATIENT'
          WHERE chi.tenant_id = $1::uuid
            AND chi.id = $2::uuid
          LIMIT 1`,
        resourceId,
      );
    case 'appointment':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM appointments a
           JOIN users p ON p.id = a.patient_id
          WHERE a.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND a.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'admission':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM admissions a
           JOIN users p ON p.uid = a.patient_uid
          WHERE a.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND a.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'resuscitation_event':
      // Sol Ultra LD-RRB-02 (Med): the resuscitation detail read (/events/:id)
      // returns full timeline/team/signature/medication/device/QA to the broad
      // emergency role set with no patient authorization. Resolve the event to
      // its patient so the care-team guard can run on the DETAIL read (the
      // cross-patient 'recent' alert board stays open by design).
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM resuscitation_events e
           JOIN users p ON p.uid = e.patient_uid
          WHERE e.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND e.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'prehospital_handover':
      // Sol Ultra ambulance-H1: the ED pre-hospital handover routes carry only a
      // handover id, so a plain patient guard saw no patient context and passed.
      // Resolve the handover to its patient so the care-team decision can run.
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM prehospital_handovers h
           JOIN users p ON p.uid = h.patient_uid
          WHERE h.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND h.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'emergency_visit':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM emergency_visits visit
           JOIN users p
             ON p.tenant_id = visit.tenant_id
            AND p.uid = visit.patient_uid
            AND p.role = 'PATIENT'
          WHERE visit.tenant_id = $1::uuid
            AND visit.id = $2::int
          LIMIT 1`,
        resourceId,
      );
    case 'encounter':
      return patientFromUuidResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM admissions a
           JOIN users p ON p.uid = a.patient_uid
          WHERE a.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND a.encounter_id = $2::uuid
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'bed':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM beds b
           LEFT JOIN admissions a
             ON a.tenant_id = b.tenant_id
            AND (
              (b.admission_id IS NOT NULL AND a.id = b.admission_id)
              OR (a.bed_id = b.id AND a.discharged_at IS NULL)
            )
           JOIN users p
             ON p.tenant_id = b.tenant_id
            AND p.role = 'PATIENT'
            AND (
              (b.patient_uid IS NOT NULL AND p.uid = b.patient_uid)
              OR (a.patient_uid IS NOT NULL AND p.uid = a.patient_uid)
              OR (b.patient_id IS NOT NULL AND p.id = b.patient_id)
            )
          WHERE b.tenant_id = $1::uuid
            AND b.id = $2::int
          LIMIT 1`,
        resourceId,
      );
    case 'clinical_order':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM clinical_orders co
           JOIN users p ON p.uid = co.patient_uid
          WHERE co.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND co.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'care_plan':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM care_plans cp
           JOIN users p ON p.uid = cp.patient_uid
          WHERE cp.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND cp.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'care_plan_goal':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM care_plan_goals cpg
           JOIN care_plans cp
             ON cp.id = cpg.care_plan_id
            AND cp.tenant_id = cpg.tenant_id
           JOIN users p
             ON p.uid = COALESCE(cpg.patient_uid, cp.patient_uid)
          WHERE cpg.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND cpg.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'care_plan_activity':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM care_plan_activities cpa
           JOIN care_plans cp
             ON cp.id = cpa.care_plan_id
            AND cp.tenant_id = cpa.tenant_id
           JOIN users p
             ON p.uid = COALESCE(cpa.patient_uid, cp.patient_uid)
          WHERE cpa.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND cpa.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'chemo_treatment_plan':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM chemo_treatment_plans ctp
           JOIN users p
             ON p.uid = ctp.patient_uid
            AND p.tenant_id = ctp.tenant_id
            AND p.role = 'PATIENT'
          WHERE ctp.tenant_id = $1::uuid
            AND ctp.id = $2::int
          LIMIT 1`,
        resourceId,
      );
    case 'chemo_cycle':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM chemo_cycles cc
           JOIN chemo_treatment_plans ctp
             ON ctp.id = cc.plan_id
            AND ctp.tenant_id = cc.tenant_id
           JOIN users p
             ON p.uid = ctp.patient_uid
            AND p.tenant_id = cc.tenant_id
            AND p.role = 'PATIENT'
          WHERE cc.tenant_id = $1::uuid
            AND cc.id = $2::int
          LIMIT 1`,
        resourceId,
      );
    case 'chair_booking':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM chair_bookings cb
           JOIN users p
             ON p.uid = cb.patient_uid
            AND p.tenant_id = cb.tenant_id
            AND p.role = 'PATIENT'
          WHERE cb.tenant_id = $1::uuid
            AND cb.id = $2::int
          LIMIT 1`,
        resourceId,
      );
    case 'chemo_administration':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM chemo_administrations ca
           JOIN chemo_cycles cc
             ON cc.id = ca.cycle_id
            AND cc.tenant_id = ca.tenant_id
           JOIN chemo_treatment_plans ctp
             ON ctp.id = cc.plan_id
            AND ctp.tenant_id = ca.tenant_id
           JOIN users p
             ON p.uid = ctp.patient_uid
            AND p.tenant_id = ca.tenant_id
            AND p.role = 'PATIENT'
          WHERE ca.tenant_id = $1::uuid
            AND ca.id = $2::int
          LIMIT 1`,
        resourceId,
      );
    case 'clinical_note':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM clinical_notes cn
           JOIN users p ON p.uid = cn.patient_uid
          WHERE cn.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND cn.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'diagnosis':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM diagnoses d
           JOIN users p ON p.uid = d.patient_uid
          WHERE d.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND d.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'pathology_report':
      return patientFromBigintResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM ap_reports ar
           JOIN ap_cases ac
             ON ac.id = ar.ap_case_id
            AND ac.tenant_id = ar.tenant_id
           JOIN users p
             ON p.uid = ac.patient_uid
            AND p.tenant_id = ar.tenant_id
            AND p.role = 'PATIENT'
          WHERE ar.tenant_id = $1::uuid
            AND ar.id = $2::bigint
          LIMIT 1`,
        resourceId,
      );
    case 'oncology_diagnosis':
      return patientFromBigintResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM oncology_diagnoses od
           JOIN users p
             ON p.uid = od.patient_uid
            AND p.tenant_id = od.tenant_id
            AND p.role = 'PATIENT'
          WHERE od.tenant_id = $1::uuid
            AND od.id = $2::bigint
          LIMIT 1`,
        resourceId,
      );
    case 'oncology_staging_record':
      return patientFromBigintResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM oncology_staging_records osr
           JOIN users p
             ON p.uid = osr.patient_uid
            AND p.tenant_id = osr.tenant_id
            AND p.role = 'PATIENT'
          WHERE osr.tenant_id = $1::uuid
            AND osr.id = $2::bigint
          LIMIT 1`,
        resourceId,
      );
    case 'oncology_toxicity_event':
      return patientFromBigintResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM oncology_toxicity_events ote
           JOIN users p
             ON p.uid = ote.patient_uid
            AND p.tenant_id = ote.tenant_id
            AND p.role = 'PATIENT'
          WHERE ote.tenant_id = $1::uuid
            AND ote.id = $2::bigint
          LIMIT 1`,
        resourceId,
      );
    case 'tumor_board_case':
      return patientFromBigintResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM tumor_board_cases tbc
           JOIN users p
             ON p.uid = tbc.patient_uid
            AND p.tenant_id = tbc.tenant_id
            AND p.role = 'PATIENT'
          WHERE tbc.tenant_id = $1::uuid
            AND tbc.id = $2::bigint
          LIMIT 1`,
        resourceId,
      );
    case 'tumor_board_recommendation':
      return patientFromBigintResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM tumor_board_recommendations tbr
           JOIN users p
             ON p.uid = tbr.patient_uid
            AND p.tenant_id = tbr.tenant_id
            AND p.role = 'PATIENT'
          WHERE tbr.tenant_id = $1::uuid
            AND tbr.id = $2::bigint
          LIMIT 1`,
        resourceId,
      );
    case 'patient_problem':
    case 'problem':
      return patientFromUuidResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM patient_problems pp
           JOIN users p ON p.uid = pp.patient_uid
          WHERE pp.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND pp.id = $2::uuid
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'medication_reconciliation':
    case 'med_rec':
      return patientFromUuidResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM medication_reconciliations mr
           JOIN users p ON p.uid = mr.patient_uid
          WHERE mr.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND mr.id = $2::uuid
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'patient_encounter':
    case 'canonical_encounter':
      return patientFromUuidResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM patient_encounters pe
           JOIN users p ON p.uid = pe.patient_uid
          WHERE pe.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND pe.id = $2::uuid
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'radiology_order':
    case 'pacs_order':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM radiology_orders ro
           JOIN users p ON p.uid = ro.patient_uid
          WHERE ro.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND ro.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'investigation':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM investigations i
           JOIN users p ON p.uid = i.uid
          WHERE i.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND i.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'investigation_booking':
      // CAN-017: the booking workflow handlers (/bookings/:id[/confirm|...]) address
      // the patient indirectly through the booking id (a path param the parent
      // INVESTIGATION guard can't resolve), so they ran without a relationship
      // check. Resolve the patient from the booking row itself. investigation_bookings.id
      // is a BigInt, so this MUST use the int8-bounded bigint resolver — the
      // int4-bounded cleanInt would silently drop any id above int4 max.
      return patientFromBigintResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM investigation_bookings ib
           JOIN users p ON p.id = ib.patient_id
          WHERE ib.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND ib.id = $2::bigint
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'prescription':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM prescriptions rx
           JOIN users p ON p.uid = rx.patient_uid
          WHERE rx.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND rx.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'invoice':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM invoices inv
           JOIN users p ON p.uid = inv.patient_uid
          WHERE inv.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND inv.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'cds_alert':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM cds_alerts ca
           JOIN users p ON p.uid = ca.patient_uid
          WHERE ca.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND ca.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'medication_administration':
    case 'mar':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM medication_administrations ma
           JOIN users p ON p.uid = ma.patient_uid
          WHERE ma.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND ma.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'nurse_handover':
    case 'handover':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM nurse_handovers nh
           JOIN users p ON p.uid = nh.patient_uid
          WHERE nh.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND nh.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'vitals':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM vitals_chart vc
           JOIN users p ON p.uid = vc.patient_uid
          WHERE vc.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND vc.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    case 'intake_output':
    case 'io':
      return patientFromResourceQuery(
        req,
        `SELECT p.id, p.uid
           FROM intake_output io
           JOIN users p ON p.uid = io.patient_uid
          WHERE io.tenant_id = $1::uuid
            AND p.tenant_id = $1::uuid
            AND io.id = $2::int
            AND p.role = 'PATIENT'
          LIMIT 1`,
        resourceId,
      );
    default:
      return null;
  }
}

export async function resolvePatientForAccess(req, providedPatient = undefined) {
  const tenantId = deriveTenantIdFromRequest(req);
  const providedUid = cleanUuid(providedPatient?.uid || providedPatient?.patient_uid || providedPatient?.patientUid);
  const providedId = cleanInt(providedPatient?.id || providedPatient?.patient_id || providedPatient?.patientId);
  if (providedPatient !== undefined) {
    if (!providedUid && !providedId) return null;
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
  const text = String(raw).trim();
  // A phone-shaped token must NEVER reach the int id column: cleanInt is now
  // int4-bounded, so parseInt('+91XXXXXXXXXX') / parseInt('9000090011') returns
  // null here instead of an out-of-range integer (Postgres 22003).
  const asId = cleanInt(text);
  // Phone identification: normalise to the stored E.164 +91 form and match the
  // varchar phone column directly — never cast a phone to int. normalizePhone
  // maps '9000090011', '919000090011', '+91 90000 90011' all to '+919000090011'.
  const normalizedPhone = normalizePhone(text);
  // Digits-only fallback for legacy rows stored without the +91 country code.
  const digits = text.replace(/\D/g, '');
  const phoneDigits = digits.length >= 10 ? digits.slice(-10) : null;

  const rows = await accessDecisionDb().$queryRawUnsafe(
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
    normalizedPhone,
    phoneDigits,
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

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `SELECT id, reason
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
  return firstRow(rows);
}

async function findCareTeamRelationship(req, patient) {
  const actorUid = cleanUuid(actorUidOf(req));
  const actorId = cleanInt(req?.user?.id);
  const patientUid = cleanUuid(patient?.uid);
  if (!patientUid) return null;

  // A context-free longitudinal team is governed by its own status window.
  // Episode-scoped teams must additionally point at the same tenant/patient
  // and a currently valid episode. Appointment access retains the existing
  // bounded 30-day clinical follow-up window; admission access ends as soon as
  // the admission leaves admitted/transferred. This prevents a forgotten
  // active care-team row from extending episode authority indefinitely.
  const rows = await accessDecisionDb().$queryRawUnsafe(
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
          (
            ct.appointment_id IS NULL
            AND ct.admission_id IS NULL
            AND LOWER(BTRIM(COALESCE(ct.team_kind, ''))) = 'longitudinal'
          )
          OR (
            ct.appointment_id IS NOT NULL
            AND ct.admission_id IS NULL
            AND EXISTS (
              SELECT 1
                FROM appointments appointment
                JOIN users appointment_patient
                  ON appointment_patient.tenant_id = appointment.tenant_id
                 AND appointment_patient.id = appointment.patient_id
               WHERE appointment.tenant_id = ct.tenant_id
                 AND appointment.id = ct.appointment_id
                 AND appointment_patient.uid = ct.patient_uid
                 AND UPPER(BTRIM(COALESCE(appointment.status, ''))) NOT IN (
                   'CANCELLED', 'NO_SHOW', 'RESCHEDULED'
                 )
                 AND appointment.appointment_date >= (CURRENT_DATE - INTERVAL '30 days')
                 AND appointment.appointment_date <= (CURRENT_DATE + INTERVAL '30 days')
            )
          )
          OR (
            ct.admission_id IS NOT NULL
            AND ct.appointment_id IS NULL
            AND EXISTS (
              SELECT 1
                FROM admissions admission
               WHERE admission.tenant_id = ct.tenant_id
                 AND admission.id = ct.admission_id
                 AND admission.patient_uid = ct.patient_uid
                 AND LOWER(BTRIM(COALESCE(admission.status, ''))) IN ('admitted', 'transferred')
            )
          )
        )
        AND (
          ($3::uuid IS NOT NULL AND ctm.staff_uid = $3::uuid)
          OR ($4::int IS NOT NULL AND ctm.staff_id = $4::int)
        )
      ORDER BY ctm.id DESC
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    patientUid,
    actorUid,
    actorId,
  );
  return firstRow(rows);
}

async function findReferralRelationship(req, patient, role) {
  const actorUid = cleanUuid(actorUidOf(req));
  const patientUid = cleanUuid(patient?.uid);
  if (!actorUid || !patientUid || !DOCTOR_RELATIONSHIP_ROLES.has(role)) return null;

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `WITH actor_departments AS (
       SELECT LOWER(TRIM(token)) AS token
         FROM (
           SELECT doc.department AS token
             FROM users u
             JOIN doctors doc ON doc.user_id = u.id
            WHERE COALESCE(u.tenant_id, $1::uuid) = $1::uuid
              AND u.uid = $3::uuid
           UNION ALL
           SELECT doc.specialty AS token
             FROM users u
             JOIN doctors doc ON doc.user_id = u.id
            WHERE COALESCE(u.tenant_id, $1::uuid) = $1::uuid
              AND u.uid = $3::uuid
           UNION ALL
           SELECT dept.name AS token
             FROM users u
             JOIN doctors doc ON doc.user_id = u.id
             JOIN departments dept ON dept.id = doc.department_id
            WHERE COALESCE(u.tenant_id, $1::uuid) = $1::uuid
              AND u.uid = $3::uuid
         ) tokens
        WHERE NULLIF(TRIM(token), '') IS NOT NULL
     )
     SELECT r.id, r.status, r.referred_to_department
       FROM referrals r
      WHERE r.tenant_id = $1::uuid
        AND r.patient_uid = $2::uuid
        AND COALESCE(r.status, '') = ANY($4::text[])
        AND (
          r.referred_to_doctor = $3::uuid
          OR r.accepted_by = $3::uuid
          OR r.performer_id = $3::uuid
          OR (
            r.referred_to_doctor IS NULL
            AND EXISTS (
              SELECT 1
                FROM actor_departments ad
               WHERE ad.token = LOWER(TRIM(r.referred_to_department))
            )
          )
        )
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    patientUid,
    actorUid,
    ['pending', 'accepted', 'in_progress'],
  );
  return firstRow(rows);
}

async function findClinicalAuthorshipRelationship(req, patient, policy) {
  // PATIENT_WRISTBAND_PRINT is listed because the wristband route ran on
  // PATIENT_CLINICAL_WORKFLOW_ACCESS before it was split out (owner decision
  // 2026-08-25) and a clinician who authored this patient's orders or notes
  // could print a band on that authorship alone. Omitting it here would have
  // silently REMOVED an allow path that ships today — the split must not cost
  // anyone access, it only adds the administrator grant.
  if (![
    ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
    ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
    ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT,
  ].includes(policy?.code)) {
    return null;
  }
  const actorUid = cleanUuid(actorUidOf(req));
  const patientUid = cleanUuid(patient?.uid);
  if (!actorUid || !patientUid) return null;

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `SELECT source, id
       FROM (
         SELECT 'clinical_order' AS source, id, created_at
           FROM clinical_orders
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND ordered_by = $3::uuid
         UNION ALL
         SELECT 'clinical_note' AS source, id, created_at
           FROM clinical_notes
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND (
              author_uid = $3::uuid
              OR author_id = $3::uuid
              OR created_by = $3::uuid
            )
         UNION ALL
         SELECT 'diagnosis' AS source, id, created_at
           FROM diagnoses
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND diagnosed_by = $3::uuid
         UNION ALL
         SELECT 'vitals' AS source, id, recorded_at AS created_at
           FROM vitals_chart
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND recorded_by = $3::uuid
       ) authored
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    patientUid,
    actorUid,
  );
  return firstRow(rows);
}

async function findCarePathwayOwnerRelationship(req, patient, policy, resourceContext, role) {
  if (![
    ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
    ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  ].includes(policy?.code)) {
    return null;
  }
  if (String(resourceContext?.resourceType || '').trim().toLowerCase() !== 'care_pathway_instance') {
    return null;
  }

  const pathwayInstanceId = cleanUuid(resourceContext?.resourceId);
  const patientUid = cleanUuid(patient?.uid);
  const actorUid = cleanUuid(actorUidOf(req));
  const actorRole = normalizeRole(role);
  const actorRawRole = actorRawRoleOf(req);
  if (
    !pathwayInstanceId
    || !patientUid
    || !actorUid
    || !actorRawRole
    || !CLINICAL_ACCOUNTABILITY_ROLES.has(actorRole)
  ) {
    return null;
  }

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `SELECT cpi.id
       FROM care_pathway_instances cpi
       JOIN users owner
         ON owner.tenant_id = cpi.tenant_id
        AND owner.uid = cpi.owning_clinician_uid
      WHERE cpi.tenant_id = $1::uuid
        AND cpi.id = $2::uuid
        AND cpi.patient_uid = $3::uuid
        AND cpi.owning_clinician_uid = $4::uuid
        AND UPPER(BTRIM(owner.role)) = $5::text
        AND owner.is_active = TRUE
        AND LOWER(COALESCE(owner.status, '')) = 'active'
        AND owner.is_deleted IS FALSE
        AND owner.deleted_at IS NULL
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    pathwayInstanceId,
    patientUid,
    actorUid,
    actorRawRole,
  );
  return firstRow(rows);
}

async function findCarePathwayTransferRecipientRelationship(
  req,
  patient,
  policy,
  resourceContext,
  role,
) {
  if (![
    ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
    ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
    ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_READ,
  ].includes(policy?.code)) {
    return null;
  }
  if (String(resourceContext?.resourceType || '').trim().toLowerCase() !== 'care_handoff_instance') {
    return null;
  }

  const handoffInstanceId = cleanUuid(resourceContext?.resourceId);
  const patientUid = cleanUuid(patient?.uid);
  const actorUid = cleanUuid(actorUidOf(req));
  const actorRole = normalizeRole(role);
  const actorRawRole = actorRawRoleOf(req);
  if (
    !handoffInstanceId
    || !patientUid
    || !actorUid
    || !actorRawRole
    || !CLINICAL_ACCOUNTABILITY_ROLES.has(actorRole)
  ) {
    return null;
  }

  const authorizedStateSql = policy.code === ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_READ
    ? `AND (
         (chi.status = 'requested'
          AND review_task.status IN ('open', 'in_progress', 'blocked', 'overdue')
          AND cpi.owning_clinician_uid = chi.sender_uid)
         OR
         (
           (
             (chi.status = 'accepted'
              AND chi.accepted_at IS NOT NULL
              AND chi.accepted_by_uid = chi.intended_recipient_uid
              AND review_task.status = 'completed'
              AND review_task.completed_at IS NOT NULL)
             OR
             (chi.status = 'declined'
              AND chi.declined_at IS NOT NULL
              AND NULLIF(BTRIM(chi.decline_reason), '') IS NOT NULL
              AND review_task.status = 'cancelled'
              AND review_task.cancelled_at IS NOT NULL
              AND review_task.cancellation_reason IS NOT DISTINCT FROM chi.decline_reason)
             OR
             (chi.status = 'cancelled'
              AND chi.cancelled_at IS NOT NULL
              AND NULLIF(BTRIM(chi.cancellation_reason), '') IS NOT NULL
              AND review_task.status = 'cancelled'
              AND review_task.cancelled_at IS NOT NULL
              AND review_task.cancellation_reason IS NOT DISTINCT FROM chi.cancellation_reason)
           )
           AND EXISTS (
             SELECT 1
               FROM care_pathway_transition_events evidence
              WHERE evidence.tenant_id = chi.tenant_id
                AND evidence.pathway_instance_id = cpi.id
                AND evidence.patient_uid = chi.patient_uid
                AND evidence.transition_scope = 'handoff'
                AND evidence.transition_key = CASE chi.status
                  WHEN 'accepted' THEN 'pathway_owner_transfer_accepted'
                  WHEN 'declined' THEN 'pathway_owner_transfer_declined'
                  WHEN 'cancelled' THEN 'pathway_owner_transfer_cancelled'
                END
                AND evidence.source_resource_type = 'care_handoff_instance'
                AND evidence.source_resource_id = chi.id::text
                AND evidence.actor_uid = CASE
                  WHEN chi.status IN ('accepted', 'declined')
                    THEN chi.intended_recipient_uid
                  WHEN chi.status = 'cancelled' THEN chi.sender_uid
                END
                AND evidence.system_actor_key IS NULL
                AND evidence.effect_ordinal = 0
                AND evidence.new_state ->> 'transfer_status' = chi.status
           )
         )
       )`
    : `AND (
         (chi.status = 'requested'
          AND review_task.status IN ('open', 'in_progress', 'blocked', 'overdue')
          AND cpi.owning_clinician_uid = chi.sender_uid)
         OR
         (chi.status = 'accepted'
          AND chi.accepted_by_uid = chi.intended_recipient_uid
          AND review_task.status = 'completed'
          AND cpi.owning_clinician_uid = chi.intended_recipient_uid)
       )`;

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `SELECT chi.id, cpi.id AS care_pathway_instance_id
       FROM care_handoff_instances chi
       JOIN care_pathway_instances cpi
         ON cpi.tenant_id = chi.tenant_id
        AND cpi.id = chi.sending_pathway_instance_id
        AND cpi.patient_uid = chi.patient_uid
        AND cpi.workflow_run_id = chi.sending_workflow_run_id
       JOIN users recipient
         ON recipient.tenant_id = chi.tenant_id
        AND recipient.uid = chi.intended_recipient_uid
       JOIN tasks review_task
         ON review_task.tenant_id = chi.tenant_id
        AND review_task.id = chi.task_id
        AND review_task.patient_uid = chi.patient_uid
      WHERE chi.tenant_id = $1::uuid
        AND chi.id = $2::uuid
        AND chi.patient_uid = $3::uuid
        AND chi.handoff_type = 'covering_clinician_reassignment'
        AND chi.recipient_kind = 'user'
        AND chi.intended_recipient_uid = $4::uuid
        AND chi.sender_uid IS NOT NULL
        AND chi.receiving_pathway_instance_id = chi.sending_pathway_instance_id
        AND chi.receiving_workflow_run_id = chi.sending_workflow_run_id
        AND chi.receiving_step_key = chi.sending_step_key
        AND chi.source_resource_type = 'care_pathway_instance'
        AND chi.source_resource_id = chi.sending_pathway_instance_id::text
        AND review_task.workflow_run_id IS NULL
        AND review_task.workflow_step_id IS NULL
        AND review_task.related_resource_type = 'care_handoff_instance'
        AND review_task.related_resource_id = chi.id::text
        AND review_task.assigned_to_uid = chi.intended_recipient_uid
        AND review_task.assigned_to_role IS NULL
        AND review_task.workflow_sla_instance_id IS NULL
        AND review_task.sla_completion_semantics = 'none'
        ${authorizedStateSql}
        AND UPPER(BTRIM(recipient.role)) = $5::text
        AND recipient.is_active = TRUE
        AND LOWER(COALESCE(recipient.status, '')) = 'active'
        AND recipient.is_deleted IS FALSE
        AND recipient.deleted_at IS NULL
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    handoffInstanceId,
    patientUid,
    actorUid,
    actorRawRole,
  );
  return firstRow(rows);
}

async function findCarePathwayRoleQueueClaimantRelationship(
  req,
  patient,
  policy,
  resourceContext,
  role,
) {
  if (policy?.code !== ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM) {
    return null;
  }
  if (String(resourceContext?.resourceType || '').trim().toLowerCase() !== 'care_pathway_instance') {
    return null;
  }

  const pathwayInstanceId = cleanUuid(resourceContext?.resourceId);
  const patientUid = cleanUuid(patient?.uid);
  const actorUid = cleanUuid(actorUidOf(req));
  const actorRole = normalizeRole(role);
  const actorRawRole = actorRawRoleOf(req);
  const replayKey = actorUid
    ? namespacedPathwayOwnershipKey(req, actorUid, 'claim_care_pathway_owner')
    : null;
  if (
    !pathwayInstanceId
    || !patientUid
    || !actorUid
    || !actorRawRole
    || !CLINICAL_ACCOUNTABILITY_ROLES.has(actorRole)
  ) {
    return null;
  }

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `WITH candidates AS (
     SELECT cpi.id, task.id AS task_id, 0 AS authorization_priority
       FROM care_pathway_instances cpi
       JOIN workflow_runs run
         ON run.tenant_id = cpi.tenant_id
        AND run.id = cpi.workflow_run_id
       JOIN workflow_steps step
         ON step.tenant_id = run.tenant_id
        AND step.workflow_run_id = run.id
        AND step.step_key = run.current_step_key
       JOIN tasks task
         ON task.tenant_id = cpi.tenant_id
        AND task.workflow_run_id = run.id
        AND task.workflow_step_id = step.id
        AND task.patient_uid = cpi.patient_uid
       JOIN users claimant
         ON claimant.tenant_id = cpi.tenant_id
        AND claimant.uid = $4::uuid
      WHERE cpi.tenant_id = $1::uuid
        AND cpi.id = $2::uuid
        AND cpi.patient_uid = $3::uuid
        AND cpi.owning_clinician_uid IS NULL
        AND cpi.clinical_status IN ('planned', 'active', 'on_hold')
        AND run.status IN ('started', 'running', 'blocked')
        AND step.step_kind IN ('task', 'approval')
        AND step.status IN ('pending', 'in_progress', 'blocked')
        AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
        AND task.related_resource_type = 'care_pathway_instance'
        AND task.related_resource_id = cpi.id::text
        AND task.assigned_to_uid IS NULL
        AND NULLIF(BTRIM(task.assigned_to_role), '') IS NOT NULL
        AND UPPER(BTRIM(task.assigned_to_role)) = $5::text
        AND UPPER(BTRIM(task.assigned_to_role)) = UPPER(BTRIM(COALESCE(
          NULLIF(BTRIM(step.assigned_role), ''),
          NULLIF(BTRIM(cpi.accountable_role), '')
        )))
        AND UPPER(BTRIM(claimant.role)) = $7::text
        AND claimant.is_active = TRUE
        AND LOWER(COALESCE(claimant.status, '')) = 'active'
        AND claimant.is_deleted IS FALSE
        AND claimant.deleted_at IS NULL
     UNION ALL
     SELECT cpi.id, NULL::bigint AS task_id, 1 AS authorization_priority
       FROM care_pathway_instances cpi
       JOIN care_pathway_transition_events evidence
         ON evidence.tenant_id = cpi.tenant_id
        AND evidence.pathway_instance_id = cpi.id
        AND evidence.patient_uid = cpi.patient_uid
       JOIN users claimant
         ON claimant.tenant_id = cpi.tenant_id
        AND claimant.uid = $4::uuid
      WHERE cpi.tenant_id = $1::uuid
        AND cpi.id = $2::uuid
        AND cpi.patient_uid = $3::uuid
        AND cpi.owning_clinician_uid = $4::uuid
        AND evidence.transition_scope = 'pathway'
        AND evidence.transition_key = 'pathway_owner_claimed'
        AND evidence.source_resource_type = 'care_pathway_instance'
        AND evidence.source_resource_id = cpi.id::text
        AND evidence.actor_uid = $4::uuid
        AND evidence.system_actor_key IS NULL
        AND evidence.idempotency_key = $6::text
        AND evidence.effect_ordinal = 0
        AND evidence.new_state ->> 'owning_clinician_uid' = $4::text
        AND UPPER(BTRIM(claimant.role)) = $7::text
        AND claimant.is_active = TRUE
        AND LOWER(COALESCE(claimant.status, '')) = 'active'
        AND claimant.is_deleted IS FALSE
        AND claimant.deleted_at IS NULL
     )
     SELECT id, task_id
       FROM candidates
      ORDER BY authorization_priority, task_id NULLS LAST
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    pathwayInstanceId,
    patientUid,
    actorUid,
    actorRole,
    replayKey,
    actorRawRole,
  );
  return firstRow(rows);
}

async function findCarePathwayTransferDeclineRecipientRelationship(
  req,
  patient,
  policy,
  resourceContext,
  role,
) {
  if (policy?.code !== ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_DECLINE) {
    return null;
  }
  if (String(resourceContext?.resourceType || '').trim().toLowerCase() !== 'care_handoff_instance') {
    return null;
  }

  const handoffInstanceId = cleanUuid(resourceContext?.resourceId);
  const patientUid = cleanUuid(patient?.uid);
  const actorUid = cleanUuid(actorUidOf(req));
  const actorRole = normalizeRole(role);
  const actorRawRole = actorRawRoleOf(req);
  const replayKey = actorUid
    ? namespacedPathwayOwnershipKey(req, actorUid, 'decline_care_pathway_owner_transfer')
    : null;
  if (
    !handoffInstanceId
    || !patientUid
    || !actorUid
    || !actorRawRole
    || !CLINICAL_ACCOUNTABILITY_ROLES.has(actorRole)
  ) {
    return null;
  }

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `SELECT chi.id, cpi.id AS care_pathway_instance_id, review_task.id AS task_id
       FROM care_handoff_instances chi
       JOIN care_pathway_instances cpi
         ON cpi.tenant_id = chi.tenant_id
        AND cpi.id = chi.sending_pathway_instance_id
        AND cpi.patient_uid = chi.patient_uid
        AND cpi.workflow_run_id = chi.sending_workflow_run_id
       JOIN users recipient
         ON recipient.tenant_id = chi.tenant_id
        AND recipient.uid = chi.intended_recipient_uid
       JOIN tasks review_task
         ON review_task.tenant_id = chi.tenant_id
        AND review_task.id = chi.task_id
        AND review_task.patient_uid = chi.patient_uid
      WHERE chi.tenant_id = $1::uuid
        AND chi.id = $2::uuid
        AND chi.patient_uid = $3::uuid
        AND chi.handoff_type = 'covering_clinician_reassignment'
        AND chi.recipient_kind = 'user'
        AND chi.intended_recipient_uid = $4::uuid
        AND chi.sender_uid IS NOT NULL
        AND chi.receiving_pathway_instance_id = chi.sending_pathway_instance_id
        AND chi.receiving_workflow_run_id = chi.sending_workflow_run_id
        AND chi.receiving_step_key = chi.sending_step_key
        AND chi.source_resource_type = 'care_pathway_instance'
        AND chi.source_resource_id = chi.sending_pathway_instance_id::text
        AND review_task.workflow_run_id IS NULL
        AND review_task.workflow_step_id IS NULL
        AND review_task.related_resource_type = 'care_handoff_instance'
        AND review_task.related_resource_id = chi.id::text
        AND review_task.assigned_to_uid = chi.intended_recipient_uid
        AND review_task.assigned_to_role IS NULL
        AND review_task.workflow_sla_instance_id IS NULL
        AND review_task.sla_completion_semantics = 'none'
        AND (
          (chi.status = 'requested'
           AND review_task.status IN ('open', 'in_progress', 'blocked', 'overdue')
           AND cpi.owning_clinician_uid = chi.sender_uid)
          OR
          (chi.status = 'declined'
           AND review_task.status = 'cancelled'
           AND cpi.owning_clinician_uid = chi.sender_uid
           AND EXISTS (
             SELECT 1
               FROM care_pathway_transition_events evidence
              WHERE evidence.tenant_id = chi.tenant_id
                AND evidence.pathway_instance_id = cpi.id
                AND evidence.patient_uid = chi.patient_uid
                AND evidence.transition_scope = 'handoff'
                AND evidence.transition_key = 'pathway_owner_transfer_declined'
                AND evidence.source_resource_type = 'care_handoff_instance'
                AND evidence.source_resource_id = chi.id::text
                AND evidence.actor_uid = $4::uuid
                AND evidence.system_actor_key IS NULL
                AND evidence.idempotency_key = $6::text
                AND evidence.effect_ordinal = 0
           ))
        )
        AND UPPER(BTRIM(recipient.role)) = $5::text
        AND recipient.is_active = TRUE
        AND LOWER(COALESCE(recipient.status, '')) = 'active'
        AND recipient.is_deleted IS FALSE
        AND recipient.deleted_at IS NULL
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    handoffInstanceId,
    patientUid,
    actorUid,
    actorRawRole,
    replayKey,
  );
  return firstRow(rows);
}

async function findAppointmentRelationship(req, patient, role, policy = null, resourceContext = null) {
  const actorUid = cleanUuid(actorUidOf(req));
  const actorId = cleanInt(req?.user?.id);
  const patientUid = cleanUuid(patient?.uid);
  if (!patientUid) return null;

  const doctorScoped = DOCTOR_RELATIONSHIP_ROLES.has(role);
  const operationalScoped = OP_RELATIONSHIP_ROLES.has(role);
  if (!doctorScoped && !operationalScoped) return null;
  const resourceAppointmentId = String(resourceContext?.resourceType || '').toLowerCase() === 'appointment'
    ? cleanInt(resourceContext?.resourceId)
    : null;
  const allowUnassignedDoctorAppointment =
    doctorScoped
    && resourceAppointmentId != null
    && [
      ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
    ].includes(policy?.code);

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `SELECT a.id
       FROM appointments a
       JOIN users p ON p.id = a.patient_id
       LEFT JOIN users d ON d.id = a.doctor_id
      WHERE a.tenant_id = $1::uuid
        AND p.uid = $2::uuid
        AND UPPER(BTRIM(COALESCE(a.status, ''))) NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
        AND a.appointment_date >= (CURRENT_DATE - INTERVAL '30 days')
        AND a.appointment_date <= (CURRENT_DATE + INTERVAL '30 days')
        AND ($7::int IS NULL OR a.id = $7::int)
        AND (
          $5::boolean = TRUE
          OR (
            $6::boolean = TRUE
            AND (
              ($3::int IS NOT NULL AND a.doctor_id = $3::int)
              OR ($4::uuid IS NOT NULL AND d.uid = $4::uuid)
              OR ($8::boolean = TRUE AND a.doctor_id IS NULL)
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
    resourceAppointmentId,
    allowUnassignedDoctorAppointment,
  );
  return firstRow(rows);
}

async function findAdmissionRelationship(req, patient, role, {
  recordType = null,
  policyCode = null,
} = {}) {
  const actorUid = cleanUuid(actorUidOf(req));
  const patientUid = cleanUuid(patient?.uid);
  if (!patientUid) return null;

  const nursingScoped = IP_RELATIONSHIP_ROLES.has(role)
    || (role === 'ICU_STAFF' && String(recordType || '').trim().toUpperCase() === 'MAR');
  const doctorScoped = DOCTOR_RELATIONSHIP_ROLES.has(role);
  const orderVerificationScoped = policyCode === ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_VERIFY
    && (role === 'PHARMACIST' || role === 'ICU_INCHARGE');
  const operationalScoped = ADMISSION_OPERATIONS_ROLES.has(role) || orderVerificationScoped;
  if (!nursingScoped && !doctorScoped && !operationalScoped) return null;

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `SELECT id
       FROM admissions
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND LOWER(BTRIM(COALESCE(status, ''))) IN ('admitted', 'transferred')
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
  return firstRow(rows);
}

async function findGuardianRelationship(req, patient) {
  const actorId = cleanInt(req?.user?.id);
  const patientUid = cleanUuid(patient?.uid);
  if (!actorId || !patientUid) return null;

  const rows = await accessDecisionDb().$queryRawUnsafe(
    `SELECT id, guardian_user_id
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
        AND is_active IS NOT FALSE
        AND guardian_user_id = $3::int
      LIMIT 1`,
    deriveTenantIdFromRequest(req),
    patientUid,
    actorId,
  );
  return firstRow(rows);
}

// Durable, never-throwing file fallback for the patient-access audit. The DB
// table (patient_access_audit_log.patient_uid) is NOT NULL, so two cases land
// here instead of the table: (1) the INSERT failed, and (2) the patient could
// not be resolved (a denied attempt that still must leave a trail). logger.warn
// lands in error.log/combined.log; the inner catch keeps a logger/transport
// failure from escaping. Audit §3: a patient-access decision is never lost.
function _writePatientAccessAuditToFile(req, decision, extra = {}) {
  try {
    logger.warn('Patient access audit file fallback:', {
      tenant_id: deriveTenantIdFromRequest(req),
      patient_uid: decision?.patient_uid ?? null,
      patient_id: decision?.patient_id ?? null,
      actor_uid: cleanUuid(actorUidOf(req)),
      actor_role: decision?.actor_role || 'UNKNOWN',
      access_decision: decision?.accessDecision ?? null,
      access_source: decision?.accessSource ?? null,
      reason: decision?.reason ?? null,
      route: String(req?.originalUrl || req?.url || '').slice(0, 255),
      action: decision?.action || deriveActionFromRequest(req),
      request_id: req?.id ? String(req.id) : null,
      policy_code: decision?.policy_code ?? null,
      record_type: decision?.recordType ?? null,
      shadow_mode: decision?.shadow_mode === true,
      enforced: decision?.enforced !== false,
      administrative_access: decision?.administrativeAccess === true,
      administrative_grant: decision?.administrativeGrant ?? null,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  } catch (logErr) {
    try {
      console.error(
        'PATIENT_ACCESS_AUDIT file fallback failed:',
        decision?.accessDecision,
        logErr?.message,
      );
    } catch {
      // Last resort exhausted; never throw out of the audit path.
    }
  }
}

async function writePatientAccessAudit(req, decision) {
  // The denied access attempt still happened — leave an audit trail even when
  // the patient could not be resolved. The table's patient_uid is NOT NULL, so
  // a patientless attempt is recorded in the durable file sink (marked) rather
  // than dropped.
  if (!decision?.patient_uid) {
    _writePatientAccessAuditToFile(req, decision, {
      patient_unresolved: true,
      error: 'patient context could not be resolved',
    });
    return;
  }
  try {
    await accessDecisionDb().$executeRawUnsafe(
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
        referral_id: decision.referralId ?? null,
        care_pathway_instance_id: decision.carePathwayInstanceId ?? null,
        care_handoff_instance_id: decision.careHandoffInstanceId ?? null,
        care_pathway_task_id: decision.carePathwayTaskId ?? null,
        actor_id: req?.user?.id ?? null,
        subject_uid: req?.user?.uid ?? null,
        acting_as_dependent: req?.acting != null,
        shadow_mode: decision.shadow_mode === true,
        // Owner decision 2026-08-25 — TRUE only when the allow came from the
        // administrative last-resort grant, i.e. the actor is an administrator
        // and every relationship check had already failed. A relationship-backed
        // or break-glass allow is FALSE here, so the two are distinguishable by
        // query:
        //   SELECT * FROM patient_access_audit_log
        //    WHERE metadata->>'administrative_access' = 'true';
        administrative_access: decision.administrativeAccess === true,
        administrative_grant: decision.administrativeGrant ?? null,
      }),
    );
  } catch (err) {
    if (accessDecisionUsesScopedDb()) throw err;
    // Durable fallback — carry the full decision tuple to the file sink so the
    // audit row is recoverable, not just an error line (audit §3).
    _writePatientAccessAuditToFile(req, decision, { error: err?.message });
  }
}

export async function authorizePatientAccessRequest(req, options = {}) {
  const { db = null, ...decisionOptions } = options;
  if (!db) return authorizePatientAccessRequestInContext(req, decisionOptions);
  return accessDecisionDbContext.run(
    { db },
    () => authorizePatientAccessRequestInContext(req, decisionOptions),
  );
}

function patientAccessAuditMetadata(req, decision, resourceContext = null) {
  return {
    policy_code: decision.policy_code,
    policy_version: decision.policy_version,
    policy_hash: decision.policy_hash,
    record_type: decision.recordType ?? null,
    resource_type: resourceContext?.resourceType ?? decision.resource_type ?? null,
    resource_id: resourceContext?.resourceId == null
      ? null
      : String(resourceContext.resourceId),
    phi_access_level: decision.phi_access_level ?? null,
    referral_id: decision.referralId ?? null,
    care_pathway_instance_id: decision.carePathwayInstanceId ?? null,
    care_handoff_instance_id: decision.careHandoffInstanceId ?? null,
    care_pathway_task_id: decision.carePathwayTaskId ?? null,
    actor_id: req?.user?.id ?? null,
    subject_uid: req?.user?.uid ?? null,
    acting_as_dependent: req?.acting != null,
    shadow_mode: decision.shadow_mode === true,
    administrative_access: decision.administrativeAccess === true,
    administrative_grant: decision.administrativeGrant ?? null,
  };
}

async function writePatientAccessAuditBatch(req, entries, db) {
  if (!entries.length) return;
  const tenantId = deriveTenantIdFromRequest(req);
  const actorUid = cleanUuid(actorUidOf(req));
  const rows = entries.map(({ decision, resourceContext }) => ({
    tenant_id: tenantId,
    patient_uid: decision.patient_uid,
    actor_uid: actorUid,
    actor_role: decision.actor_role || 'UNKNOWN',
    access_decision: decision.accessDecision,
    access_source: decision.accessSource,
    reason: decision.reason ?? null,
    route: String(req?.originalUrl || req?.url || '').slice(0, 255),
    action: decision.action || deriveActionFromRequest(req),
    care_team_id: decision.careTeamId ?? null,
    break_glass_id: decision.breakGlassId ?? null,
    request_id: req?.id ? String(req.id) : null,
    metadata: patientAccessAuditMetadata(req, decision, resourceContext),
  }));
  await db.$executeRawUnsafe(
    `INSERT INTO patient_access_audit_log (
       tenant_id, patient_uid, actor_uid, actor_role,
       access_decision, access_source, reason, route, action,
       care_team_id, break_glass_id, request_id, metadata,
       created_by, updated_by, created_at, updated_at
     )
     SELECT audit.tenant_id, audit.patient_uid, audit.actor_uid,
            audit.actor_role, audit.access_decision, audit.access_source,
            audit.reason, audit.route, audit.action, audit.care_team_id,
            audit.break_glass_id, audit.request_id, audit.metadata,
            audit.actor_uid, audit.actor_uid, clock_timestamp(), clock_timestamp()
       FROM jsonb_to_recordset($1::jsonb) AS audit(
         tenant_id uuid, patient_uid uuid, actor_uid uuid, actor_role text,
         access_decision text, access_source text, reason text, route text,
         action text, care_team_id integer, break_glass_id integer,
         request_id text, metadata jsonb
       )`,
    JSON.stringify(rows),
  );
}

export async function authorizeClinicalImportReconciliationAccessBatchRequest(req, {
  db,
  entries,
  policyCode = null,
  recordType = 'PHI',
  requireResolvedPatient = false,
} = {}) {
  if (!db?.$queryRawUnsafe || !db?.$executeRawUnsafe) {
    throw new TypeError('A transaction-scoped database client is required');
  }
  if (!Array.isArray(entries) || entries.length > 25) {
    throw new TypeError('Patient access batch entries must be an array of at most 25 items');
  }
  if (!entries.length) return [];
  if (actorRoleOf(req) !== 'MEDICAL_RECORDS'
    || policyCode !== ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD
    || recordType !== 'MEDICAL_RECORD'
    || requireResolvedPatient !== true) {
    throw new TypeError('The bounded access batch is restricted to Medical Records clinical-import reconciliation');
  }

  const tenantId = deriveTenantIdFromRequest(req);
  const normalized = entries.map((entry) => {
    const decisionKey = String(entry?.decisionKey || '').toLowerCase();
    const patientId = cleanInt(entry?.patient?.id);
    const patientUid = cleanUuid(entry?.patient?.uid);
    const resourceContext = entry?.resourceContext ?? null;
    if (!UUID_RE.test(decisionKey) || !patientId || !patientUid
      || resourceContext?.resourceType !== 'clinical_import_reconciliation'
      || String(resourceContext?.resourceId || '').toLowerCase() !== decisionKey) {
      throw new TypeError('Each patient access batch entry requires an exact reconciliation item key, patient id, patient uid, and item-bound resource context');
    }
    return {
      decisionKey,
      patient: { id: patientId, uid: patientUid },
      resourceContext,
    };
  });
  if (new Set(normalized.map(entry => entry.decisionKey)).size !== normalized.length) {
    throw new TypeError('Patient access batch decision keys must be unique');
  }

  const verifiedRows = await db.$queryRawUnsafe(
    `WITH requested AS (
       SELECT request.decision_key, request.patient_id, request.patient_uid
         FROM jsonb_to_recordset($2::jsonb) AS request(
           decision_key text, patient_id integer, patient_uid uuid
         )
     )
     SELECT request.decision_key, patient.id, patient.uid
       FROM requested AS request
       JOIN users AS patient
         ON patient.tenant_id=$1::uuid
        AND patient.id=request.patient_id
        AND patient.uid=request.patient_uid
        AND patient.role='PATIENT'
        AND patient.is_active=TRUE
        AND patient.status='active'
        AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL`,
    tenantId,
    JSON.stringify(normalized.map(entry => ({
      decision_key: entry.decisionKey,
      patient_id: entry.patient.id,
      patient_uid: entry.patient.uid,
    }))),
  );
  const verified = new Map(verifiedRows.map(row => [String(row.decision_key), {
    id: Number(row.id),
    uid: String(row.uid).toLowerCase(),
  }]));
  const policy = getAccessPolicy(policyCode);
  if (!policy) {
    throw new TypeError('The clinical-import reconciliation access policy is unavailable');
  }
  const rolePolicy = rolePolicyFor(actorRoleOf(req));
  const decisions = [];
  for (const entry of normalized) {
    const exactPatient = verified.get(entry.decisionKey);
    let decision;
    if (!exactPatient) {
      decision = denyDecision({
        req,
        patient: entry.patient,
        policy,
        rolePolicy,
      }, 'Patient identity did not match the exact tenant-scoped batch pair', { recordType });
      decision = {
        ...decision,
        action: deriveActionFromRequest(req, policy),
        recordType,
        shadow_mode: false,
        enforced: true,
      };
    } else {
      decision = await evaluateResolvedPatientAccessRequest(req, {
        policy,
        recordType,
        resourceContext: entry.resourceContext,
        audit: false,
        shadowMode: false,
        resolvedPatient: exactPatient,
      });
    }
    decisions.push({
      decisionKey: entry.decisionKey,
      decision,
      resourceContext: entry.resourceContext,
    });
  }
  await writePatientAccessAuditBatch(req, decisions, db);
  return decisions.map(({ decisionKey, decision }) => ({ decisionKey, decision }));
}

async function authorizePatientAccessRequestInContext(req, {
  policyCode = null,
  recordType = 'PHI',
  patient = undefined,
  resourceContext = null,
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
    const unresolvedDecision = {
      ...denyDecision({
        req,
        patient: null,
        policy,
        rolePolicy,
      }, 'Patient context could not be resolved for this access request', { recordType }),
      action: deriveActionFromRequest(req, policy),
      recordType,
      shadow_mode: shadowMode,
      enforced: shadowMode !== true,
      no_patient_context: true,
    };
    req.patientAccessDecision = unresolvedDecision;
    // A denied access attempt must leave an audit trail even when no patient
    // could be resolved (audit §3). patient_access_audit_log.patient_uid is NOT
    // NULL, so writePatientAccessAudit records this in the durable file sink
    // with an unresolved-patient marker rather than dropping it.
    if (audit && policy.audit_required !== false) {
      await writePatientAccessAudit(req, unresolvedDecision);
    }
    return shadowMode
      ? { ...unresolvedDecision, allowed: true, shadow_denied: true }
      : unresolvedDecision;
  }

  return evaluateResolvedPatientAccessRequest(req, {
    policy,
    recordType,
    resourceContext,
    audit,
    shadowMode,
    resolvedPatient,
  });
}

async function evaluateResolvedPatientAccessRequest(req, {
  policy,
  recordType,
  resourceContext,
  audit,
  shadowMode,
  resolvedPatient,
}) {
  const role = actorRoleOf(req);
  const rolePolicy = rolePolicyFor(role);
  const args = {
    req,
    patient: resolvedPatient,
    policy,
    rolePolicy,
  };
  const policyScopedPharmacistPhi = role === 'PHARMACIST'
    && policy.code === ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_VERIFY;
  let decision;

  if (!rolePolicy) {
    decision = denyDecision(args, 'Actor role is not in the policy registry');
  } else if (role === 'PATIENT' && cleanUuid(req?.user?.uid) === cleanUuid(resolvedPatient.uid)) {
    decision = allowDecision(args, 'guardian', 'patient self access');
  } else if (req?.acting && cleanUuid(req?.user?.uid) === cleanUuid(resolvedPatient.uid)) {
    decision = allowDecision(args, 'guardian', 'guardian acting-as dependent');
  } else if (role === 'PATIENT' && policy.relationship_checks.includes('guardian')) {
    const guardian = await findGuardianRelationship(req, resolvedPatient);
    if (guardian?.id) {
      decision = allowDecision(args, 'guardian', 'linked guardian-dependent relationship', {
        guardianUserId: guardian.guardian_user_id,
      });
    }
  }

  if (!decision && policy.required_phi_level === PHI_ACCESS_LEVELS.OWN_RECORD) {
    decision = denyDecision(args, 'Only the patient or an authorised guardian can perform this action');
  } else if (!decision && MEDICAL_RECORDS_ROLES.has(role) && [
    ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
    ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
    ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_VIEW,
    ACCESS_POLICY_CODES.PATIENT_TIMELINE_VIEW,
  ].includes(policy.code)) {
    decision = allowDecision(args, 'role', 'medical records office role');
  } else if (!decision
    && !policyScopedPharmacistPhi
    && [PHI_ACCESS_LEVELS.NONE, PHI_ACCESS_LEVELS.STAFF_ONLY, PHI_ACCESS_LEVELS.OPERATIONAL_ONLY]
      .includes(rolePolicy.phi?.access_level)) {
    decision = denyDecision(args, `${role} does not have a patient PHI access scope`);
  } else if (!decision && (
    rankPhiLevel(rolePolicy.phi?.access_level) >= policyMinimumRank(policy)
    && hasRequiredCapability(rolePolicy, policy)
    && canUseRoleOwnedOperationalAccess(role, policy)
  )) {
    decision = allowDecision(args, 'role', `${role} has role-owned operational workflow access for ${policy.code}`);
  } else if (!decision) {
    const breakGlass = await findActiveBreakGlass(req, resolvedPatient, policy, rolePolicy);
    if (breakGlass?.id) {
      decision = allowDecision(args, 'break_glass', 'active break-glass session', {
        breakGlassId: breakGlass.id,
        breakGlassReason: breakGlass.reason,
      });
    }
  }

  if (!decision
    && !policyScopedPharmacistPhi
    && rankPhiLevel(rolePolicy.phi?.access_level) < policyMinimumRank(policy)) {
    if (rolePolicy.phi?.access_level === PHI_ACCESS_LEVELS.ADMIN_BREAK_GLASS) {
      decision = denyDecision(args, 'Administrative PHI access requires an active break-glass session');
    } else {
      decision = denyDecision(args, `${role} does not meet the PHI level required by ${policy.code}`);
    }
  }

  if (!decision && policy.relationship_checks.includes('care_pathway_role_queue_claimant')) {
    const queueClaimant = await findCarePathwayRoleQueueClaimantRelationship(
      req,
      resolvedPatient,
      policy,
      resourceContext,
      role,
    );
    if (queueClaimant?.id) {
      decision = allowDecision(
        args,
        'care_pathway_role_queue_claimant',
        'actor currently holds the exact live care pathway role queue',
        {
          carePathwayInstanceId: queueClaimant.id,
          carePathwayTaskId: queueClaimant.task_id,
        },
      );
    }
  }

  if (!decision && policy.relationship_checks.includes('care_pathway_transfer_decline_recipient')) {
    const transferDeclineRecipient = await findCarePathwayTransferDeclineRecipientRelationship(
      req,
      resolvedPatient,
      policy,
      resourceContext,
      role,
    );
    if (transferDeclineRecipient?.id && transferDeclineRecipient?.care_pathway_instance_id) {
      decision = allowDecision(
        args,
        'care_pathway_transfer_decline_recipient',
        'actor is the exact care pathway transfer decline recipient',
        {
          careHandoffInstanceId: transferDeclineRecipient.id,
          carePathwayInstanceId: transferDeclineRecipient.care_pathway_instance_id,
          carePathwayTaskId: transferDeclineRecipient.task_id,
        },
      );
    }
  }

  if (!decision && policy.relationship_checks.includes('care_pathway_owner')) {
    const pathwayOwner = await findCarePathwayOwnerRelationship(
      req,
      resolvedPatient,
      policy,
      resourceContext,
      role,
    );
    if (pathwayOwner?.id) {
      decision = allowDecision(args, 'care_pathway_owner', 'actor is the assigned care pathway owner', {
        carePathwayInstanceId: pathwayOwner.id,
      });
    }
  }

  if (!decision && policy.relationship_checks.includes('care_pathway_transfer_recipient')) {
    const transferRecipient = await findCarePathwayTransferRecipientRelationship(
      req,
      resolvedPatient,
      policy,
      resourceContext,
      role,
    );
    if (transferRecipient?.id && transferRecipient?.care_pathway_instance_id) {
      decision = allowDecision(
        args,
        'care_pathway_transfer_recipient',
        'actor is the exact care pathway transfer recipient',
        {
          careHandoffInstanceId: transferRecipient.id,
          carePathwayInstanceId: transferRecipient.care_pathway_instance_id,
        },
      );
    }
  }

  if (!decision && !hasRequiredCapability(rolePolicy, policy)) {
    decision = denyDecision(args, `${role} is not assigned to the ${policy.code} capability group`);
  }

  if (!decision && policy.relationship_checks.includes('care_team')) {
    const careTeam = await findCareTeamRelationship(req, resolvedPatient);
    if (careTeam?.care_team_id) {
      decision = allowDecision(args, 'care_team', 'active care-team relationship', { careTeamId: careTeam.care_team_id });
    }
  }

  if (!decision && policy.relationship_checks.includes('referral')) {
    const referral = await findReferralRelationship(req, resolvedPatient, role);
    if (referral?.id) {
      decision = allowDecision(args, 'referral', 'active specialist referral relationship', { referralId: referral.id });
    }
  }

  if (!decision && policy.relationship_checks.includes('clinical_authorship')) {
    const authored = await findClinicalAuthorshipRelationship(req, resolvedPatient, policy);
    if (authored?.id) {
      decision = allowDecision(args, 'clinical_authorship', 'actor authored patient clinical workflow material', {
        clinicalAuthorship: {
          source: authored.source,
          id: authored.id,
        },
      });
    }
  }

  if (!decision && policy.relationship_checks.includes('appointment')) {
    const appointment = await findAppointmentRelationship(req, resolvedPatient, role, policy, resourceContext);
    if (appointment?.id) {
      decision = allowDecision(args, 'appointment', 'active appointment relationship', { appointmentId: appointment.id });
    }
  }

  if (!decision && policy.relationship_checks.includes('admission')) {
    const admission = await findAdmissionRelationship(req, resolvedPatient, role, {
      recordType,
      policyCode: policy.code,
    });
    if (admission?.id) {
      decision = allowDecision(args, 'admission', 'active admission relationship', { admissionId: admission.id });
    }
  }

  // Last resort, and deliberately after EVERY relationship check above. Owner
  // decision 2026-08-25: an administrator may print a patient wristband without
  // break-glass, and the print is recorded as administrative access. Reaching
  // this line proves the actor has no care-team, referral, authorship,
  // appointment, admission, guardian, care-pathway or break-glass link to the
  // patient — so `administrative_access: true` on the audit row is a verified
  // fact, not an assumption. An administrator who DOES hold one of those links
  // was already allowed above and is attributed to it instead.
  if (!decision) {
    const administrativeGrant = administrativeGrantForPolicy(role, policy);
    if (administrativeGrant) {
      decision = allowDecision(
        args,
        'role',
        `${role} holds the ${administrativeGrant} administrative grant for ${policy.code} (no care relationship to this patient)`,
        {
          administrativeAccess: true,
          administrativeGrant,
        },
      );
    }
  }

  if (!decision) {
    decision = denyDecision(args, 'No active care-team, referral, appointment, admission, guardian, or break-glass relationship');
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
