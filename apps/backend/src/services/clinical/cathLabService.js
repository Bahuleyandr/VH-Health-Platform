// Device payloads stay with NL-7; cath-lab stores only case-scoped links.

import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { addInvoiceItem, createDraftInvoice } from '../billing/billingV2Service.js';
import { recordMovementTx } from '../pharmacy/inventoryV2Service.js';
import { assertPharmacyFacilityGrant } from '../pharmacy/pharmacyFacilityAuthorityService.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import {
  claimInboxTask,
  completeTaskFromDomainEvidence,
  createCathInventoryShortfallTaskTx,
  recoverCathInventoryShortfallTaskAssignmentTx
} from '../workflow/taskService.js';
import { emitCathProcedureCompletionFollowUps } from './cathQuickWinsService.js';
import {
  cancelWorkflowSla,
  completeWorkflowSla,
  recordCanonicalClinicalEvent,
  startWorkflowSla
} from './canonicalClinicalPlatformService.js';
import {
  assertPrivilegeForGate,
  isGateEnabled,
  privilegeKey
} from '../staff/credentialingService.js';
import { deriveComplicationRegistryRows } from './cathSchedulingRegistryService.js';

const tenantOr = value => requireTenantId(value);

export const READINESS_TYPES = Object.freeze([
  'consent',
  'labs',
  'allergy_renal_risk',
  'anticoagulation',
  'blood_bank',
  'equipment',
  'implants_device_rep',
  'timeout'
]);

export const READINESS_CLEAR_STATES = Object.freeze(['pass', 'waived', 'not_applicable']);
export const CASE_STATUSES = Object.freeze([
  'requested',
  'scheduled',
  'readiness_pending',
  'ready',
  'in_progress',
  'completed',
  'cancelled'
]);

export const CASE_TRANSITIONS = Object.freeze({
  requested: ['scheduled', 'cancelled'],
  scheduled: ['readiness_pending', 'ready', 'cancelled'],
  readiness_pending: ['ready', 'cancelled'],
  ready: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
});

export const CATH_CONSUMABLE_CATEGORIES = Object.freeze([
  'stent',
  'balloon',
  'guidewire',
  'catheter',
  'sheath',
  'closure_device',
  'pacemaker',
  'lead',
  'other'
]);

export const CATH_CONSUMABLE_STATUSES = Object.freeze(['active', 'retired']);
const CATH_CONSUMABLE_USE_STATUSES = new Set(['in_progress', 'completed']);
const CATH_CONSUMABLE_WASTAGE_STATUSES = new Set([
  'ready',
  'in_progress',
  'completed',
  'cancelled'
]);
const CATH_INVENTORY_SHORTFALL_TASK_CONTRACT = 'cath_inventory_shortfall_v1';
const CATH_INVENTORY_RECONCILIATION_COMMAND_CONTRACT =
  'cath_inventory_reconciliation_v1';
const CATH_INVENTORY_SHORTFALL_SLA_RULE = 'cath_consumable_inventory_reconciliation';
const CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES = Object.freeze([
  'PHARMACIST',
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE'
]);
const CATH_INVENTORY_SHORTFALL_COVERAGE_ROLES = Object.freeze([
  'ADMIN',
  'SUPER_ADMIN'
]);
const CATH_INVENTORY_SHORTFALL_ACTION_LABEL_KEY = 'clinical_inbox.open_workflow';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]+$/;
const QUANTITY_SCALE = 10_000;

export const CATH_INVENTORY_SHORTFALL_PRESENTATIONS = Object.freeze({
  en: Object.freeze({
    title: 'Reconcile Cath consumable stock',
    body: 'Documented Cath consumable stock is incomplete. Replenish and retry the exact remaining quantity.'
  }),
  hi: Object.freeze({
    title: 'कैथ उपभोग्य स्टॉक का मिलान करें',
    body: 'दर्ज कैथ उपभोग्य स्टॉक अधूरा है। स्टॉक भरें और केवल शेष मात्रा का पुनः प्रयास करें।'
  }),
  ta: Object.freeze({
    title: 'கேத் நுகர்பொருள் இருப்பை சரிசெய்யவும்',
    body: 'பதிவுசெய்த கேத் நுகர்பொருள் இருப்பு முழுமையில்லை. இருப்பை நிரப்பி மீதமுள்ள அளவை மட்டும் மீண்டும் முயலவும்.'
  }),
  te: Object.freeze({
    title: 'క్యాథ్ వినియోగ వస్తు నిల్వను సరిపోల్చండి',
    body: 'నమోదైన క్యాథ్ వినియోగ వస్తు నిల్వ అసంపూర్ణంగా ఉంది. నిల్వను నింపి మిగిలిన పరిమాణాన్ని మాత్రమే మళ్లీ ప్రయత్నించండి.'
  }),
  ml: Object.freeze({
    title: 'കാത്ത് ഉപഭോഗവസ്തു സ്റ്റോക്ക് പൊരുത്തപ്പെടുത്തുക',
    body: 'രേഖപ്പെടുത്തിയ കാത്ത് ഉപഭോഗവസ്തു സ്റ്റോക്ക് അപൂർണ്ണമാണ്. സ്റ്റോക്ക് നിറച്ച് ശേഷിക്കുന്ന അളവ് മാത്രം വീണ്ടും ശ്രമിക്കുക.'
  })
});

const CONTRAST_FIELDS = [
  'contrast_volume_ml',
  'fluoroscopy_time_min',
  'dose_area_product_gy_cm2',
  'air_kerma_mgy'
];

function cleanText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function providedInput(input, ...keys) {
  const key = keys.find(candidate => Object.hasOwn(input, candidate));
  return key === undefined
    ? { provided: false, value: undefined }
    : { provided: true, value: input[key] };
}

function canRecordConsumableForCaseStatus(status, wasted) {
  const normalized = cleanText(status, 40)?.toLowerCase();
  return (wasted ? CATH_CONSUMABLE_WASTAGE_STATUSES : CATH_CONSUMABLE_USE_STATUSES)
    .has(normalized);
}

function normalizeId(value, label = 'id') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  }
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  }
  const parsed = BigInt(text);
  if (parsed <= 0n || parsed > 9_223_372_036_854_775_807n) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  }
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : text;
}

function normalizeCathReconciliationId(value, label) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw AppError.badRequest(`${label} must be a canonical positive integer`, 'CATH_LAB_BAD_ID');
  }
  const parsed = BigInt(text);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw AppError.badRequest(`${label} exceeds the signed 64-bit range`, 'CATH_LAB_BAD_ID');
  }
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : text;
}

function sourceReferenceId(value, label = 'source_id') {
  return normalizeId(value, label);
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'CATH_LAB_BAD_UUID');
  }
  return text;
}

function normalizeJson(value, label, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'object') {
    throw AppError.badRequest(`${label} must be JSON`, 'CATH_LAB_BAD_JSON');
  }
  return value;
}

function optionalNumber(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw AppError.badRequest(`${label} must be a non-negative number`, 'CATH_LAB_BAD_NUMBER');
  }
  return number;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw AppError.badRequest(`${label} must be greater than zero`, 'CATH_CONSUMABLE_BAD_QUANTITY');
  }
  return number;
}

function quantityUnits(value, label = 'quantity') {
  const number = Number(value);
  const units = Math.round(number * QUANTITY_SCALE);
  if (
    !Number.isFinite(number)
    || number <= 0
    || !Number.isSafeInteger(units)
    || Math.abs(number - units / QUANTITY_SCALE) > 1e-9
  ) {
    throw AppError.badRequest(
      `${label} must be a positive quantity with at most four decimal places`,
      'CATH_CONSUMABLE_BAD_QUANTITY'
    );
  }
  return units;
}

function quantityFromUnits(units) {
  return (Number(units) / QUANTITY_SCALE).toFixed(4);
}

function normalizeCathInventoryOperatorRole(role) {
  const normalized = String(role || '').trim().toUpperCase();
  return CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES.includes(normalized)
    ? normalized
    : null;
}

export function canViewCathInventoryReconciliationRole(role) {
  const normalized = String(role || '').trim().toUpperCase();
  return Boolean(normalizeCathInventoryOperatorRole(normalized))
    || CATH_INVENTORY_SHORTFALL_COVERAGE_ROLES.includes(normalized);
}

export function canMutateCathInventoryReconciliationRole(role) {
  return Boolean(normalizeCathInventoryOperatorRole(role));
}

function cathInventoryShortfallPresentation(locale) {
  const normalized = cathInventoryShortfallPresentationLocale(locale);
  return CATH_INVENTORY_SHORTFALL_PRESENTATIONS[normalized]
    || CATH_INVENTORY_SHORTFALL_PRESENTATIONS.en;
}

function cathInventoryShortfallPresentationLocale(locale) {
  const normalized = String(locale || '').trim().toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(CATH_INVENTORY_SHORTFALL_PRESENTATIONS, normalized)
    ? normalized
    : 'en';
}

function cathInventoryReconciliationPath(caseId, usageId) {
  return `/api/v1/cath-lab/cases/${String(caseId)}`
    + `/consumables/${String(usageId)}/inventory-reconcile`;
}

function cathInventoryShortfallDeepLink(caseId, usageId) {
  return '/pharmacy/cath-inventory-reconciliation'
    + `?case_id=${String(caseId)}&consumable_usage_id=${String(usageId)}`;
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function cathInventoryReconciliationRequestFingerprint(caseId, usageId) {
  return sha256(JSON.stringify({
    case_id: String(caseId),
    usage_id: String(usageId)
  }));
}

function normalizeCathInventoryReconciliationCommand({
  tenantId,
  caseId,
  usageId,
  actorUid,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId = null
}) {
  const actor = maybeUuid(actorUid, 'actorUid')?.toLowerCase();
  const canonicalTenantId = maybeUuid(tenantId, 'tenantId')?.toLowerCase();
  const key = String(commandKey || '');
  const fingerprint = String(requestFingerprint || '').trim().toLowerCase();
  const claimId = Number(httpIdempotencyClaimId);
  const expectedFingerprint = cathInventoryReconciliationRequestFingerprint(caseId, usageId);
  if (
    !actor
    || !Number.isSafeInteger(claimId)
    || claimId <= 0
    || key.length < 1
    || key.length > 200
    || key !== key.trim()
    || !IDEMPOTENCY_KEY_PATTERN.test(key)
    || !SHA256_PATTERN.test(fingerprint)
  ) {
    throw AppError.badRequest(
      'Cath inventory reconciliation idempotency identity is invalid',
      'CATH_INVENTORY_RECONCILIATION_IDEMPOTENCY_INVALID'
    );
  }
  if (fingerprint !== expectedFingerprint) {
    throw AppError.unprocessable(
      'Idempotency-Key is bound to a different Cath inventory reconciliation command',
      'CATH_INVENTORY_RECONCILIATION_COMMAND_MISMATCH'
    );
  }
  return Object.freeze({
    actor,
    claimId,
    commandKey: key,
    requestFingerprint: fingerprint,
    requestPath: cathInventoryReconciliationPath(caseId, usageId),
    commandKeySha256: sha256(
      `${canonicalTenantId}:${actor}:cath-inventory-shortfall:${String(usageId)}:${key}`
    ),
    requestId: requestId ? String(requestId) : null
  });
}

function cathInventoryAuthenticatedRoles(context = {}) {
  return [
    context.rawRole,
    context.actorRole,
    ...(Array.isArray(context.actorRoles) ? context.actorRoles : [])
  ]
    .map(role => String(role || '').trim().toUpperCase())
    .filter(Boolean);
}

async function cathCanonicalActorTx(tx, tenantId, context = {}) {
  const actorUid = maybeUuid(context.actorUid, 'actorUid');
  if (!actorUid) {
    throw AppError.forbidden(
      'Cath clinical writes require a canonical authenticated actor',
      'CATH_CANONICAL_ACTOR_REQUIRED'
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, role, name
       FROM users
      WHERE tenant_id=$1::uuid
        AND uid=$2::uuid
        AND is_active=TRUE
        AND status='active'
        AND COALESCE(is_deleted, FALSE)=FALSE
        AND merged_into_uid IS NULL
      LIMIT 1
      FOR SHARE`,
    tenantId,
    actorUid
  );
  const actor = rows[0];
  const canonicalRole = String(actor?.role || '').trim().toUpperCase();
  const authenticatedRoles = cathInventoryAuthenticatedRoles(context);
  if (
    !actor?.uid
    || (authenticatedRoles.length > 0 && !authenticatedRoles.includes(canonicalRole))
  ) {
    throw AppError.forbidden(
      'Cath clinical write actor does not match an active same-tenant identity',
      'CATH_CANONICAL_ACTOR_REQUIRED'
    );
  }
  return Object.freeze({
    uid: String(actor.uid),
    role: canonicalRole,
    name: actor.name || null
  });
}

async function cathInventoryReconciliationActorTx(tx, tenantId, context = {}) {
  const actorUid = maybeUuid(context.actorUid, 'actorUid');
  if (!actorUid) {
    throw AppError.forbidden(
      'Cath inventory reconciliation requires an authenticated operator',
      'CATH_INVENTORY_RECONCILIATION_FORBIDDEN'
    );
  }
  const authenticatedRoles = cathInventoryAuthenticatedRoles(context);
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
         AND status = 'active'
         AND COALESCE(is_deleted, FALSE) = FALSE
         AND merged_into_uid IS NULL
         AND role = ANY($3::text[])
      LIMIT 1`,
    tenantId,
    actorUid,
    [
      ...CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES,
      ...CATH_INVENTORY_SHORTFALL_COVERAGE_ROLES
    ]
  );
  const actor = rows[0];
  const role = String(actor?.role || '').trim().toUpperCase();
  if (!actor?.uid || !authenticatedRoles.includes(role)) {
    throw AppError.forbidden(
      'Cath inventory reconciliation requires an authorized pharmacy operator',
      'CATH_INVENTORY_RECONCILIATION_FORBIDDEN'
    );
  }
  return Object.freeze({
    uid: String(actor.uid),
    role,
    routine: Boolean(normalizeCathInventoryOperatorRole(role)),
    coverage: CATH_INVENTORY_SHORTFALL_COVERAGE_ROLES.includes(role)
  });
}

function cathInventoryReconciliationResponseBody(result, requestId = null) {
  return {
    success: true,
    message: 'Cath consumable inventory reconciliation',
    data: result,
    ...(requestId ? { requestId } : {})
  };
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  throw AppError.badRequest('Boolean field is invalid', 'CATH_CONSUMABLE_BAD_BOOLEAN');
}

function optionalDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = value instanceof Date
    ? (Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10))
    : String(value).trim().slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00.000Z`)
    : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw AppError.badRequest(`${label} must be a valid date`, 'CATH_CONSUMABLE_BAD_DATE');
  }
  return text;
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${label} must be a valid timestamp`, 'CATH_LAB_BAD_TIMESTAMP');
  }
  return date.toISOString();
}

function normalizeStatus(value, allowed, label) {
  const status = cleanText(value, 60);
  if (!status || !allowed.includes(status)) {
    throw AppError.badRequest(
      `${label} must be one of: ${allowed.join(', ')}`,
      'CATH_LAB_BAD_STATUS'
    );
  }
  return status;
}

function normalizeDbValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER)
      && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(normalizeDbValue);
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeDbValue(item)])
    );
  }
  return value;
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeDbValue) : normalizeDbValue(rows);
}

function unwrap(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

export function evaluateReadinessGate(checks = []) {
  const byType = new Map(checks.map(check => [check.check_type, check]));
  const blocking = [];
  for (const type of READINESS_TYPES) {
    const check = byType.get(type);
    if (!check) {
      blocking.push({ check_type: type, reason: 'missing' });
      continue;
    }
    if (check.required === false) continue;
    if (!READINESS_CLEAR_STATES.includes(check.status)) {
      blocking.push({ check_type: type, reason: check.status || 'pending' });
    }
  }
  return {
    ready: blocking.length === 0,
    blocking,
    total: checks.length,
    cleared: checks.filter(check => READINESS_CLEAR_STATES.includes(check.status)).length
  };
}

export function validateCaseTransition(from, to) {
  const target = normalizeStatus(to, CASE_STATUSES, 'status');
  const allowed = CASE_TRANSITIONS[from] || [];
  if (!allowed.includes(target)) {
    throw AppError.invalidTransition(from, target, allowed);
  }
  return target;
}

export function validateContrastRadiationInput(input = {}) {
  const normalized = {};
  for (const field of CONTRAST_FIELDS) {
    normalized[field] = optionalNumber(input[field], field);
  }
  if (
    normalized.contrast_volume_ml === null &&
    normalized.fluoroscopy_time_min === null &&
    normalized.dose_area_product_gy_cm2 === null &&
    normalized.air_kerma_mgy === null
  ) {
    throw AppError.badRequest(
      'At least one contrast, fluoroscopy, or dose value is required',
      'CATH_LAB_DOSE_SUMMARY_REQUIRED'
    );
  }
  return normalized;
}

export function cathLabPrivilegeGateConfig() {
  const key = privilegeKey(
    process.env.CATH_LAB_PRIVILEGE_KEY || 'cath_lab_owner_supplied_privilege'
  );
  return {
    key,
    enabled: isGateEnabled('CATH_LAB_PRIVILEGE_GATE_ENABLED')
  };
}

async function assertPatient(tenantId, patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    maybeUuid(patientUid, 'patient_uid')
  );
  if (!rows.length) throw AppError.notFound('Patient not found', 'CATH_LAB_PATIENT_NOT_FOUND');
}

async function caseById(db, tenantId, caseId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, facility_id, requested_procedure,
            indication, urgency, lab_room, status, planned_start_at, planned_end_at,
            actual_start_at, actual_end_at, team, sla_rule_code, sla_instance_id
       FROM cath_lab_cases
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    normalizeId(caseId, 'case_id'),
    tenantOr(tenantId)
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return row;
}

async function readinessForCase(db, tenantId, caseId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, check_type, status, required, completed_by, completed_at,
            evidence_owner, source_name, source_version, attachment_ref, notes, metadata
       FROM cath_lab_readiness_checks
      WHERE tenant_id = $1::uuid
        AND case_id = $2::bigint
      ORDER BY array_position($3::text[], check_type), check_type`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id'),
    READINESS_TYPES
  );
  return normalizeRows(rows);
}

async function assertReadinessComplete(db, tenantId, caseId) {
  const checks = await readinessForCase(db, tenantId, caseId);
  const gate = evaluateReadinessGate(checks);
  if (!gate.ready) {
    throw AppError.badRequest(
      'Cath-lab readiness checks must be cleared before procedure start',
      'CATH_LAB_READINESS_BLOCKED',
      { blocking: gate.blocking }
    );
  }
  return gate;
}

async function writeCanonicalEvent(
  db,
  {
    tenantId,
    patientUid,
    encounterId = null,
    eventType,
    eventStatus = null,
    sourceTable,
    sourceId,
    actorUid = null,
    actorRole = null,
    summary,
    payload = {},
    beforeState = null,
    afterState = null
  }
) {
  return recordCanonicalClinicalEvent(
    {
      tenantId,
      patientUid,
      encounterId,
      eventType,
      eventStatus,
      sourceTable,
      sourceId,
      resourceType: sourceTable,
      resourceId: sourceId,
      actorUid,
      actorRole,
      summary,
      payload,
      beforeState,
      afterState,
      tags: ['cath_lab', 'nl13_p1']
    },
    { db }
  );
}

function requireCanonicalEvent(event) {
  if (!event?.timeline?.id || !event?.audit?.id) {
    throw AppError.internal(
      'Cath consumable usage requires canonical timeline and audit events',
      'CATH_CONSUMABLE_CANONICAL_EVENT_REQUIRED'
    );
  }
  return event;
}

async function updateCaseCanonicalRefs(db, { tenantId, caseId, event, sla = null }) {
  await db.$queryRawUnsafe(
    `UPDATE cath_lab_cases
        SET timeline_event_id = COALESCE($3::uuid, timeline_event_id),
            audit_event_id = COALESCE($4::uuid, audit_event_id),
            sla_instance_id = COALESCE($5::uuid, sla_instance_id),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id'),
    event?.timeline?.id || null,
    event?.audit?.id || null,
    sla?.id || null
  );
}

export async function createCase(input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const patientUid = maybeUuid(input.patient_uid || input.patientUid, 'patient_uid');
  const encounterId = maybeUuid(input.encounter_id || input.encounterId, 'encounter_id');
  const requestedFacilityValue = input.facility_id ?? input.facilityId;
  const requestedFacilityId = requestedFacilityValue == null || requestedFacilityValue === ''
    ? null
    : normalizeId(requestedFacilityValue, 'facility_id');
  await assertPatient(tenantId, patientUid);
  const requestedProcedure = cleanText(input.requested_procedure || input.requestedProcedure, 160);
  if (!requestedProcedure) {
    throw AppError.badRequest('requested_procedure is required', 'CATH_LAB_PROCEDURE_REQUIRED');
  }
  const urgency = input.urgency
    ? normalizeStatus(input.urgency, ['elective', 'routine', 'urgent', 'emergency'], 'urgency')
    : 'routine';
  const status = input.status
    ? normalizeStatus(input.status, CASE_STATUSES, 'status')
    : 'scheduled';
  const team = normalizeJson(input.team, 'team', {});
  const metadata = normalizeJson(input.metadata, 'metadata', {});
  const plannedStartAt = optionalTimestamp(
    input.planned_start_at || input.plannedStartAt,
    'planned_start_at'
  );
  const plannedEndAt = optionalTimestamp(
    input.planned_end_at || input.plannedEndAt,
    'planned_end_at'
  );
  const slaRuleCode = cleanText(input.sla_rule_code || input.slaRuleCode, 100);

  return setTenantTx(tenantId, async tx => {
    let facilityId = requestedFacilityId;
    if (encounterId) {
      const encounters = await tx.$queryRawUnsafe(
        `SELECT encounter.id, encounter.patient_uid,
                CASE WHEN encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
                     THEN (encounter.metadata->>'facility_id')::int ELSE NULL END
                  AS facility_id
           FROM patient_encounters encounter
          WHERE encounter.tenant_id=$1::uuid
            AND encounter.id=$2::uuid
            AND encounter.patient_uid=$3::uuid
          FOR KEY SHARE OF encounter`,
        tenantId,
        encounterId,
        patientUid
      );
      if (encounters.length !== 1) {
        throw AppError.conflict(
          'Cath-lab encounter must belong to the exact same-tenant patient',
          'CATH_LAB_CASE_ENCOUNTER_INVALID'
        );
      }
      if (encounters[0].facility_id == null) {
        throw AppError.conflict(
          'Cath-lab encounter has no exact facility authority',
          'CATH_LAB_CASE_FACILITY_REQUIRED'
        );
      }
      const encounterFacilityId = Number(encounters[0].facility_id);
      if (requestedFacilityId != null && encounterFacilityId !== requestedFacilityId) {
        throw AppError.conflict(
          'Cath-lab case facility must match the encounter facility authority',
          'CATH_LAB_CASE_FACILITY_MISMATCH'
        );
      }
      facilityId = encounterFacilityId;
      const facilities = await tx.$queryRawUnsafe(
        `SELECT id
           FROM facilities
          WHERE tenant_id=$1::uuid AND id=$2::int AND status='active'
          FOR KEY SHARE`,
        tenantId,
        facilityId
      );
      if (facilities.length !== 1) {
        throw AppError.conflict(
          'Cath-lab encounter facility authority is not active',
          'CATH_LAB_CASE_FACILITY_REQUIRED'
        );
      }
    } else {
      if (facilityId == null) {
        throw AppError.badRequest(
          'facility_id is required when a Cath-lab case has no encounter',
          'CATH_LAB_CASE_FACILITY_REQUIRED'
        );
      }
      const facilities = await tx.$queryRawUnsafe(
        `SELECT id
           FROM facilities
          WHERE tenant_id=$1::uuid AND id=$2::int AND status='active'
          FOR KEY SHARE`,
        tenantId,
        facilityId
      );
      if (facilities.length !== 1) {
        throw AppError.conflict(
          'Cath-lab cases require one exact active facility',
          'CATH_LAB_CASE_FACILITY_REQUIRED'
        );
      }
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases
         (tenant_id, patient_uid, encounter_id, appointment_id, facility_id, requested_procedure,
          indication, urgency, lab_room, status, planned_start_at, planned_end_at,
          team, sla_rule_code, created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5::int, $6,
               $7, $8, $9, $10, $11::timestamptz, $12::timestamptz,
               $13::jsonb, $14, $15::uuid, $15::uuid, $16::jsonb)
       RETURNING *`,
      tenantId,
      patientUid,
      encounterId,
      input.appointment_id ? normalizeId(input.appointment_id, 'appointment_id') : null,
      facilityId,
      requestedProcedure,
      cleanText(input.indication),
      urgency,
      cleanText(input.lab_room || input.labRoom, 120),
      status,
      plannedStartAt,
      plannedEndAt,
      JSON.stringify(team),
      slaRuleCode,
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(metadata)
    );
    const cathCase = unwrap(rows);
    for (const checkType of READINESS_TYPES) {
      await tx.$queryRawUnsafe(
        `INSERT INTO cath_lab_readiness_checks
           (tenant_id, case_id, check_type, status, required)
         VALUES ($1::uuid, $2::bigint, $3, 'pending', TRUE)
         ON CONFLICT (tenant_id, case_id, check_type) DO NOTHING`,
        tenantId,
        cathCase.id,
        checkType
      );
    }
    const event = await writeCanonicalEvent(tx, {
      tenantId,
      patientUid,
      encounterId: cathCase.encounter_id,
      eventType: 'cath_lab.case_created',
      eventStatus: cathCase.status,
      sourceTable: 'cath_lab_cases',
      sourceId: cathCase.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Cath-lab case created: ${requestedProcedure}`,
      payload: {
        facility_id: facilityId,
        requested_procedure: requestedProcedure,
        urgency,
        lab_room: cathCase.lab_room
      },
      afterState: cathCase
    });
    const sla = slaRuleCode
      ? await startWorkflowSla(
          {
            tenantId,
            ruleCode: slaRuleCode,
            patientUid,
            encounterId: cathCase.encounter_id,
            sourceTable: 'cath_lab_cases',
            sourceId: String(cathCase.id),
            assignedRoleCodes: ['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF'],
            metadata: { facility_id: facilityId, requested_procedure: requestedProcedure, urgency }
          },
          { db: tx }
        )
      : null;
    await updateCaseCanonicalRefs(tx, { tenantId, caseId: cathCase.id, event, sla });
    return getCase(cathCase.id, { tenantId, db: tx });
  });
}

export async function listCases({ tenantId, date = null, status = null, limit = 100 } = {}) {
  const tid = tenantOr(tenantId);
  const params = [tid];
  const clauses = ['c.tenant_id = $1::uuid'];
  if (date) {
    params.push(String(date).slice(0, 10));
    clauses.push(`DATE(c.planned_start_at AT TIME ZONE 'Asia/Kolkata') = $${params.length}::date`);
  }
  if (status) {
    params.push(normalizeStatus(status, CASE_STATUSES, 'status'));
    clauses.push(`c.status = $${params.length}`);
  }
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.tenant_id, c.patient_uid, u.name AS patient_name,
            c.encounter_id, c.facility_id, c.appointment_id,
            c.requested_procedure, c.indication,
            c.urgency, c.lab_room, c.status, c.planned_start_at, c.planned_end_at,
            c.actual_start_at, c.actual_end_at, c.team, c.sla_rule_code,
            c.sla_instance_id, c.created_at, c.updated_at,
            report_tat.procedure_to_signed_minutes AS report_tat_minutes,
            (
              SELECT COUNT(*)::int
                FROM cath_procedure_reports report_count
               WHERE report_count.tenant_id = c.tenant_id
                 AND report_count.case_id = c.id
                 AND report_count.status = 'signed'
            ) AS signed_report_count,
            (
              SELECT COUNT(*)::int
                FROM cath_lab_readiness_checks r
               WHERE r.tenant_id = c.tenant_id
                 AND r.case_id = c.id
            ) AS readiness_total,
            (
              SELECT COUNT(*)::int
                FROM cath_lab_readiness_checks r
               WHERE r.tenant_id = c.tenant_id
                 AND r.case_id = c.id
                 AND r.status IN ('pass', 'waived', 'not_applicable')
            ) AS readiness_cleared,
            (
              SELECT COUNT(*)::int
                FROM cath_procedure_logs p
               WHERE p.tenant_id = c.tenant_id
                 AND p.case_id = c.id
            ) AS procedure_count,
            (
              SELECT COUNT(*)::int
                FROM cath_contrast_radiation_records d
               WHERE d.tenant_id = c.tenant_id
                 AND d.case_id = c.id
            ) AS dose_record_count,
            (
              SELECT COUNT(*)::int
                FROM cath_post_procedure_orders o
               WHERE o.tenant_id = c.tenant_id
                 AND o.case_id = c.id
                 AND o.order_status IN ('draft', 'active')
            ) AS active_post_order_count,
            (
              SELECT COUNT(*)::int
                FROM cath_device_links l
               WHERE l.tenant_id = c.tenant_id
                 AND l.case_id = c.id
            ) AS device_link_count
       FROM cath_lab_cases c
       LEFT JOIN users u
         ON u.uid = c.patient_uid
        AND u.tenant_id = c.tenant_id
       LEFT JOIN LATERAL (
         SELECT tat.procedure_to_signed_minutes
           FROM cath_report_tat_metrics tat
          WHERE tat.tenant_id = c.tenant_id
            AND tat.case_id = c.id
            AND tat.signed_at IS NOT NULL
          ORDER BY tat.signed_at DESC, tat.report_id DESC
          LIMIT 1
       ) report_tat ON TRUE
      WHERE ${clauses.join(' AND ')}
      ORDER BY c.planned_start_at NULLS LAST, c.created_at DESC
      LIMIT $${params.length + 1}::int`,
    ...params,
    safeLimit
  );
  return normalizeRows(rows);
}

export async function getCase(caseId, { tenantId, db = prisma } = {}) {
  const cathCase = await caseById(db, tenantId, caseId);
  const readiness = await readinessForCase(db, tenantId, caseId);
  const procedures = await db.$queryRawUnsafe(
    `SELECT * FROM cath_procedure_logs
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
      ORDER BY created_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const hemodynamics = await db.$queryRawUnsafe(
    `SELECT * FROM cath_hemodynamic_summaries
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
      ORDER BY recorded_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const contrastRadiation = await db.$queryRawUnsafe(
    `SELECT * FROM cath_contrast_radiation_records
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
      ORDER BY recorded_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const postOrders = await db.$queryRawUnsafe(
    `SELECT * FROM cath_post_procedure_orders
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
      ORDER BY ordered_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const deviceLinks = await db.$queryRawUnsafe(
    `SELECT l.*, d.device_registry_id, d.channel, d.started_at AS association_started_at
       FROM cath_device_links l
       JOIN device_patient_associations d
         ON d.id = l.device_patient_association_id
      WHERE l.tenant_id = $1::uuid
        AND l.case_id = $2::bigint
      ORDER BY l.attached_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const consumableUsage = await listCaseConsumableUsage(caseId, { tenantId, db });
  const normalizedReadiness = normalizeRows(readiness);
  return normalizeDbValue({
    ...cathCase,
    readiness: normalizedReadiness,
    readiness_gate: evaluateReadinessGate(normalizedReadiness),
    procedures,
    hemodynamics,
    contrast_radiation: contrastRadiation,
    post_orders: postOrders,
    device_links: deviceLinks,
    consumable_usage: consumableUsage
  });
}

export async function updateReadinessCheck(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const checkType = normalizeStatus(
    input.check_type || input.checkType,
    READINESS_TYPES,
    'check_type'
  );
  const status = normalizeStatus(
    input.status || 'pending',
    ['pending', 'pass', 'fail', 'waived', 'not_applicable'],
    'status'
  );
  return setTenantTx(tenantId, async tx => {
    await caseById(tx, tenantId, caseId, { lock: true });
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_lab_readiness_checks
         (tenant_id, case_id, check_type, status, required, completed_by, completed_at,
          evidence_owner, source_name, source_version, attachment_ref, notes, metadata)
       VALUES ($1::uuid, $2::bigint, $3, $4::text, COALESCE($5, TRUE), $6::uuid,
               CASE WHEN $4::text = 'pending' THEN NULL ELSE COALESCE($7::timestamptz, NOW()) END,
               $8, $9, $10, $11, $12, $13::jsonb)
       ON CONFLICT (tenant_id, case_id, check_type) DO UPDATE SET
          status = EXCLUDED.status,
          required = EXCLUDED.required,
          completed_by = EXCLUDED.completed_by,
          completed_at = EXCLUDED.completed_at,
          evidence_owner = EXCLUDED.evidence_owner,
          source_name = EXCLUDED.source_name,
          source_version = EXCLUDED.source_version,
          attachment_ref = EXCLUDED.attachment_ref,
          notes = EXCLUDED.notes,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
       RETURNING *`,
      tenantId,
      normalizeId(caseId, 'case_id'),
      checkType,
      status,
      input.required ?? true,
      maybeUuid(context.actorUid, 'actorUid'),
      optionalTimestamp(input.completed_at || input.completedAt, 'completed_at'),
      cleanText(input.evidence_owner || input.evidenceOwner, 160),
      cleanText(input.source_name || input.sourceName, 160),
      cleanText(input.source_version || input.sourceVersion, 80),
      cleanText(input.attachment_ref || input.attachmentRef),
      cleanText(input.notes),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    const checks = await readinessForCase(tx, tenantId, caseId);
    const gate = evaluateReadinessGate(checks);
    const nextStatus = gate.ready ? 'ready' : 'readiness_pending';
    await tx.$queryRawUnsafe(
      `UPDATE cath_lab_cases
          SET status = CASE
                WHEN status IN ('scheduled', 'readiness_pending', 'ready') THEN $3
                ELSE status
              END,
              updated_by = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      normalizeId(caseId, 'case_id'),
      nextStatus,
      maybeUuid(context.actorUid, 'actorUid')
    );
    return normalizeDbValue({ check: unwrap(rows), readiness_gate: gate });
  });
}

export async function transitionCaseStatus(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const updated = await setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    const target = validateCaseTransition(cathCase.status, input.status);
    if (target === 'in_progress') {
      await assertReadinessComplete(tx, tenantId, cathCase.id);
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE cath_lab_cases
          SET status = $3::varchar(40),
              actual_start_at = CASE
                WHEN $3::varchar(40) = 'in_progress' THEN COALESCE(actual_start_at, NOW())
                ELSE actual_start_at
              END,
              actual_end_at = CASE
                WHEN $3::varchar(40) IN ('completed', 'cancelled') THEN COALESCE(actual_end_at, NOW())
                ELSE actual_end_at
              END,
              updated_by = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        RETURNING *`,
      tenantId,
      cathCase.id,
      target,
      maybeUuid(context.actorUid, 'actorUid')
    );
    const updated = unwrap(rows);
    const event = await writeCanonicalEvent(tx, {
      tenantId,
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: `cath_lab.case_${target}`,
      eventStatus: target,
      sourceTable: 'cath_lab_cases',
      sourceId: updated.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Cath-lab case ${target}: ${updated.requested_procedure}`,
      payload: { status: target, reason: cleanText(input.reason) },
      beforeState: { status: cathCase.status },
      afterState: { status: target }
    });
    if (target === 'completed' && updated.sla_rule_code) {
      await completeWorkflowSla(
        {
          tenantId,
          ruleCode: updated.sla_rule_code,
          sourceTable: 'cath_lab_cases',
          sourceId: String(updated.id),
          metadata: { completed_by: context.actorUid || null }
        },
        { db: tx }
      );
    } else if (target === 'cancelled' && updated.sla_rule_code) {
      // A cancelled case has no obligation left to meet — stop its clock as
      // 'cancelled' (never 'completed'), mirroring the STEMI stand-down
      // cancel. Without this every cancelled case left its SLA instance
      // 'active' forever (CASE_TRANSITIONS allows 'cancelled' from every
      // non-terminal status).
      await cancelWorkflowSla(
        {
          tenantId,
          ruleCode: updated.sla_rule_code,
          sourceTable: 'cath_lab_cases',
          sourceId: String(updated.id),
          metadata: {
            cancel_reason: cleanText(input.reason),
            cancelled_by: context.actorUid || null
          }
        },
        { db: tx }
      );
    }
    await updateCaseCanonicalRefs(tx, { tenantId, caseId: updated.id, event });
    return normalizeDbValue(updated);
  });
  if (updated.status !== 'completed') return updated;
  const billingHook = await maybeEmitCathBillingLines({
    tenantId,
    caseId: updated.id,
    actorUid: context.actorUid || null
  });
  return { ...updated, billing_hook: billingHook };
}

export async function recordProcedureLog(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const gate = cathLabPrivilegeGateConfig();
  await assertPrivilegeForGate({
    staffUid: context.actorUid,
    privilegeName: gate.key,
    tenantId,
    gate: 'cath_lab_procedure_log',
    enabled: gate.enabled
  });
  const recorded = await setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    await assertReadinessComplete(tx, tenantId, cathCase.id);
    const procedureType = cleanText(input.procedure_type || input.procedureType, 120);
    if (!procedureType)
      throw AppError.badRequest('procedure_type is required', 'CATH_LAB_PROCEDURE_TYPE_REQUIRED');
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_procedure_logs
         (tenant_id, case_id, patient_uid, encounter_id, procedure_type, access_site,
          operators, sedation_anesthesia_ref, devices, findings_summary, complications,
          status, started_at, ended_at, logged_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid, $5, $6,
               $7::jsonb, $8, $9::jsonb, $10, $11::jsonb,
               $12, $13::timestamptz, $14::timestamptz, $15::uuid, $16::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      cathCase.patient_uid,
      cathCase.encounter_id,
      procedureType,
      cleanText(input.access_site || input.accessSite, 120),
      JSON.stringify(normalizeJson(input.operators, 'operators', [])),
      cleanText(input.sedation_anesthesia_ref || input.sedationAnesthesiaRef, 160),
      JSON.stringify(normalizeJson(input.devices, 'devices', [])),
      cleanText(input.findings_summary || input.findingsSummary),
      JSON.stringify(normalizeJson(input.complications, 'complications', [])),
      input.status
        ? normalizeStatus(input.status, ['draft', 'finalized', 'amended'], 'status')
        : 'finalized',
      optionalTimestamp(input.started_at || input.startedAt, 'started_at'),
      optionalTimestamp(input.ended_at || input.endedAt, 'ended_at'),
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    const procedure = unwrap(rows);
    if (cathCase.status !== 'in_progress') {
      await tx.$queryRawUnsafe(
        `UPDATE cath_lab_cases
            SET status = 'in_progress',
                actual_start_at = COALESCE(actual_start_at, NOW()),
                updated_by = $3::uuid,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        tenantId,
        cathCase.id,
        maybeUuid(context.actorUid, 'actorUid')
      );
    }
    const event = await writeCanonicalEvent(tx, {
      tenantId,
      patientUid: procedure.patient_uid,
      encounterId: procedure.encounter_id,
      eventType: 'cath_lab.procedure_logged',
      eventStatus: procedure.status,
      sourceTable: 'cath_procedure_logs',
      sourceId: procedure.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Cath procedure logged: ${procedureType}`,
      payload: {
        case_id: cathCase.id,
        procedure_type: procedureType,
        access_site: procedure.access_site,
        privilege_gate: { key: gate.key, enforced: gate.enabled }
      },
      afterState: procedure
    });
    await tx.$queryRawUnsafe(
      `UPDATE cath_procedure_logs
          SET timeline_event_id = $3::uuid,
              audit_event_id = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      procedure.id,
      event?.timeline?.id || null,
      event?.audit?.id || null
    );
    // NL13-P1f: structured complication-registry rows derive atomically from
    // the log's complications JSONB (same tx — registry, timeline, audit land
    // together or not at all).
    await deriveComplicationRegistryRows(
      tx,
      {
        tenantId,
        caseId: cathCase.id,
        procedureLogId: procedure.id,
        patientUid: procedure.patient_uid,
        encounterId: procedure.encounter_id,
        complications: normalizeJson(input.complications, 'complications', []),
        occurredAt: procedure.ended_at || procedure.started_at || null
      },
      context
    );
    return normalizeDbValue(procedure);
  });
  // NL-13 P1e Phase-1.5 seam: finalized procedure logs emit their completion
  // fact to the NL9-P3 follow-up rails post-commit, best-effort. Owner
  // templates in tenants.settings decide whether anything triggers; failure
  // here never blocks the procedure log itself.
  if (recorded?.status === 'finalized') {
    try {
      await emitCathProcedureCompletionFollowUps({
        tenantId,
        procedureLogId: recorded.id,
        actorUid: context.actorUid
      });
    } catch (err) {
      logger.warn(
        `Cath follow-up loop emission failed for procedure_log=${recorded.id}: ${err.message}`
      );
    }
  }
  return recorded;
}

export async function addHemodynamicSummary(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  return setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_hemodynamic_summaries
         (tenant_id, case_id, procedure_log_id, patient_uid, summary_text,
          observations, file_refs, device_refs, source_system, source_version,
          recorded_by, recorded_at, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5,
               $6::jsonb, $7::jsonb, $8::jsonb, $9, $10,
               $11::uuid, COALESCE($12::timestamptz, NOW()), $13::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      input.procedure_log_id ? normalizeId(input.procedure_log_id, 'procedure_log_id') : null,
      cathCase.patient_uid,
      cleanText(input.summary_text || input.summaryText),
      JSON.stringify(normalizeJson(input.observations, 'observations', {})),
      JSON.stringify(normalizeJson(input.file_refs || input.fileRefs, 'file_refs', [])),
      JSON.stringify(normalizeJson(input.device_refs || input.deviceRefs, 'device_refs', [])),
      cleanText(input.source_system || input.sourceSystem, 160),
      cleanText(input.source_version || input.sourceVersion, 80),
      maybeUuid(context.actorUid, 'actorUid'),
      optionalTimestamp(input.recorded_at || input.recordedAt, 'recorded_at'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    return normalizeDbValue(unwrap(rows));
  });
}

export async function addContrastRadiationRecord(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const dose = validateContrastRadiationInput(input);
  return setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_contrast_radiation_records
         (tenant_id, case_id, procedure_log_id, patient_uid, contrast_agent,
          contrast_volume_ml, fluoroscopy_time_min, dose_area_product_gy_cm2,
          air_kerma_mgy, dose_document_ref, dose_document_storage_key,
          aerb_evidence_owner, aerb_source_name, aerb_source_version,
          aerb_evidence_attachment_ref, equipment_qa_reference, recorded_by,
          recorded_at, notes, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5,
               $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10, $11,
               $12, $13, $14, $15, $16, $17::uuid,
               COALESCE($18::timestamptz, NOW()), $19, $20::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      input.procedure_log_id ? normalizeId(input.procedure_log_id, 'procedure_log_id') : null,
      cathCase.patient_uid,
      cleanText(input.contrast_agent || input.contrastAgent, 160),
      dose.contrast_volume_ml,
      dose.fluoroscopy_time_min,
      dose.dose_area_product_gy_cm2,
      dose.air_kerma_mgy,
      cleanText(input.dose_document_ref || input.doseDocumentRef),
      cleanText(input.dose_document_storage_key || input.doseDocumentStorageKey),
      cleanText(input.aerb_evidence_owner || input.aerbEvidenceOwner, 160),
      cleanText(input.aerb_source_name || input.aerbSourceName, 160),
      cleanText(input.aerb_source_version || input.aerbSourceVersion, 80),
      cleanText(input.aerb_evidence_attachment_ref || input.aerbEvidenceAttachmentRef),
      cleanText(input.equipment_qa_reference || input.equipmentQaReference),
      maybeUuid(context.actorUid, 'actorUid'),
      optionalTimestamp(input.recorded_at || input.recordedAt, 'recorded_at'),
      cleanText(input.notes),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    return normalizeDbValue(unwrap(rows));
  });
}

export async function addPostProcedureOrder(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  return setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_post_procedure_orders
         (tenant_id, case_id, procedure_log_id, patient_uid, recovery_location,
          sheath_management, vascular_closure, vitals_frequency, antiplatelet_plan,
          anticoagulation_plan, complication_watch, order_status, ordered_by,
          ordered_at, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5,
               $6, $7, $8, $9, $10, $11::jsonb, $12, $13::uuid,
               COALESCE($14::timestamptz, NOW()), $15::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      input.procedure_log_id ? normalizeId(input.procedure_log_id, 'procedure_log_id') : null,
      cathCase.patient_uid,
      cleanText(input.recovery_location || input.recoveryLocation, 160),
      cleanText(input.sheath_management || input.sheathManagement),
      cleanText(input.vascular_closure || input.vascularClosure),
      cleanText(input.vitals_frequency || input.vitalsFrequency, 120),
      cleanText(input.antiplatelet_plan || input.antiplateletPlan),
      cleanText(input.anticoagulation_plan || input.anticoagulationPlan),
      JSON.stringify(
        normalizeJson(input.complication_watch || input.complicationWatch, 'complication_watch', [])
      ),
      input.order_status
        ? normalizeStatus(
            input.order_status,
            ['draft', 'active', 'completed', 'cancelled'],
            'order_status'
          )
        : 'active',
      maybeUuid(context.actorUid, 'actorUid'),
      optionalTimestamp(input.ordered_at || input.orderedAt, 'ordered_at'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    const order = unwrap(rows);
    const event = await writeCanonicalEvent(tx, {
      tenantId,
      patientUid: order.patient_uid,
      encounterId: cathCase.encounter_id,
      eventType: 'cath_lab.post_orders_created',
      eventStatus: order.order_status,
      sourceTable: 'cath_post_procedure_orders',
      sourceId: order.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Cath post-procedure orders: ${order.recovery_location || 'recovery plan'}`,
      payload: {
        case_id: cathCase.id,
        vitals_frequency: order.vitals_frequency,
        complication_watch: order.complication_watch
      },
      afterState: order
    });
    await tx.$queryRawUnsafe(
      `UPDATE cath_post_procedure_orders
          SET timeline_event_id = $3::uuid,
              audit_event_id = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      order.id,
      event?.timeline?.id || null,
      event?.audit?.id || null
    );
    return normalizeDbValue(order);
  });
}

export async function addDeviceLink(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  return setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId);
    const assocRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, ended_at
         FROM device_patient_associations
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND patient_uid = $3::uuid
          AND ended_at IS NULL
        LIMIT 1`,
      tenantId,
      normalizeId(
        input.device_patient_association_id || input.devicePatientAssociationId,
        'device_patient_association_id'
      ),
      cathCase.patient_uid
    );
    const association = unwrap(assocRows);
    if (!association) {
      throw AppError.badRequest(
        'Cath device links require an active NL-7 device-patient association for the same patient',
        'CATH_LAB_DEVICE_ASSOCIATION_INACTIVE'
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_device_links
         (tenant_id, case_id, procedure_log_id, patient_uid, device_patient_association_id,
          link_type, external_system, external_accession_id, inbound_document_id,
          summary, attached_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::int,
               $6, $7, $8, $9, $10, $11::uuid, $12::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      input.procedure_log_id ? normalizeId(input.procedure_log_id, 'procedure_log_id') : null,
      cathCase.patient_uid,
      association.id,
      input.link_type
        ? normalizeStatus(
            input.link_type,
            [
              'hemodynamic_summary',
              'angiography_accession',
              'ep_system',
              'tavr_device',
              'dose_document',
              'summary',
              'other'
            ],
            'link_type'
          )
        : 'summary',
      cleanText(input.external_system || input.externalSystem, 160),
      cleanText(input.external_accession_id || input.externalAccessionId, 160),
      cleanText(input.inbound_document_id || input.inboundDocumentId, 160),
      cleanText(input.summary),
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    return normalizeDbValue(unwrap(rows));
  });
}

const CATH_CONSUMABLE_CATALOG_SELECT = `
  c.id, c.tenant_id, c.facility_id, c.inventory_item_id, c.item_name, c.category,
  c.manufacturer, c.model, c.is_implant, c.batch_tracked,
  c.default_unit_cost_reference, c.billing_item_code, c.status,
  c.retired_at, c.created_by, c.updated_by, c.created_at, c.updated_at,
  c.metadata, i.sku_code AS inventory_sku, i.display_name AS inventory_item_name,
  i.unit_label AS inventory_unit_label, i.status AS inventory_item_status,
  i.facility_id AS inventory_facility_id, f.status AS inventory_facility_status`;

async function catalogItemById(db, tenantId, catalogItemId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${CATH_CONSUMABLE_CATALOG_SELECT}
       FROM cath_consumable_catalog c
       LEFT JOIN pharmacy_inventory_items i
         ON i.id = c.inventory_item_id
        AND i.tenant_id = c.tenant_id
       LEFT JOIN facilities f
         ON f.tenant_id = c.tenant_id
        AND f.id = c.facility_id
      WHERE c.tenant_id = $1::uuid
        AND c.id = $2::bigint
      ${lock ? 'FOR UPDATE OF c' : ''}
      LIMIT 1`,
    tenantOr(tenantId),
    normalizeId(catalogItemId, 'catalog_item_id')
  );
  const item = unwrap(rows);
  if (!item) {
    throw AppError.notFound('Cath consumable catalog item not found', 'CATH_CONSUMABLE_NOT_FOUND');
  }
  return normalizeDbValue(item);
}

export async function listConsumableCatalog({
  tenantId,
  q = null,
  search = null,
  scan = null,
  category = null,
  status = 'active',
  mapped = null,
  caseId = null,
  facilityId = null,
  limit = 100,
  db = prisma
} = {}) {
  const tid = tenantOr(tenantId);
  let exactFacilityId = facilityId == null || facilityId === ''
    ? null
    : normalizeId(facilityId, 'facility_id');
  if (caseId != null && caseId !== '') {
    const cathCase = await caseById(db, tid, caseId);
    if (cathCase.facility_id == null) {
      throw AppError.conflict(
        'Cath-lab case has no exact facility authority',
        'CATH_LAB_CASE_FACILITY_UNRESOLVED'
      );
    }
    exactFacilityId = Number(cathCase.facility_id);
  }
  if (exactFacilityId == null) {
    throw AppError.badRequest(
      'case_id or facility_id is required for facility-scoped Cath catalog access',
      'CATH_CONSUMABLE_FACILITY_SCOPE_REQUIRED'
    );
  }
  const params = [tid, exactFacilityId];
  const clauses = ['c.tenant_id = $1::uuid', 'c.facility_id = $2::int'];
  if (caseId != null && caseId !== '') {
    clauses.push(
      "c.status = 'active'",
      "i.status = 'active'",
      'i.facility_id = c.facility_id',
      "f.status = 'active'"
    );
  }
  const query = cleanText(q || search, 160);
  if (query) {
    params.push(`%${query.toLowerCase()}%`);
    clauses.push(`(
      LOWER(c.item_name) LIKE $${params.length}
      OR LOWER(COALESCE(c.manufacturer, '')) LIKE $${params.length}
      OR LOWER(COALESCE(c.model, '')) LIKE $${params.length}
      OR LOWER(COALESCE(c.billing_item_code, '')) LIKE $${params.length}
      OR LOWER(COALESCE(i.sku_code, '')) LIKE $${params.length}
      OR LOWER(COALESCE(i.display_name, '')) LIKE $${params.length}
    )`);
  }
  const scanValue = cleanText(scan, 160);
  if (scanValue) {
    params.push(scanValue.toLowerCase());
    clauses.push(`(
      LOWER(COALESCE(i.sku_code, '')) = $${params.length}
      OR LOWER(c.item_name) = $${params.length}
    )`);
  }
  if (category) {
    params.push(normalizeStatus(category, CATH_CONSUMABLE_CATEGORIES, 'category'));
    clauses.push(`c.category = $${params.length}`);
  }
  if (status) {
    params.push(normalizeStatus(status, CATH_CONSUMABLE_STATUSES, 'status'));
    clauses.push(`c.status = $${params.length}`);
  }
  if (mapped !== null && mapped !== undefined && mapped !== '') {
    const isMapped = booleanValue(mapped);
    clauses.push(`c.billing_item_code IS ${isMapped ? 'NOT ' : ''}NULL`);
  }
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
  params.push(safeLimit);
  const rows = await db.$queryRawUnsafe(
    `SELECT ${CATH_CONSUMABLE_CATALOG_SELECT}
       FROM cath_consumable_catalog c
       LEFT JOIN pharmacy_inventory_items i
         ON i.id = c.inventory_item_id
        AND i.tenant_id = c.tenant_id
       LEFT JOIN facilities f
         ON f.tenant_id = c.tenant_id
        AND f.id = c.facility_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY c.status, c.item_name, c.id
      LIMIT $${params.length}::int`,
    ...params
  );
  return normalizeRows(rows);
}

export async function upsertConsumableCatalogItem(input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const itemId = input.id ? normalizeId(input.id, 'catalog_item_id') : null;
  return setTenantTx(tenantId, async tx => {
    const existing = itemId
      ? await catalogItemById(tx, tenantId, itemId, { lock: true })
      : null;
    if (existing) {
      const recovery = await tx.$queryRawUnsafe(
        `SELECT id
           FROM pharmacy_inventory_authority_recovery_worklist
          WHERE tenant_id=$1::uuid
            AND entity_type='cath_consumable_catalog'
            AND entity_id=$2::bigint
            AND status='OPEN'
          LIMIT 1
          FOR UPDATE`,
        tenantId,
        existing.id
      );
      if (recovery.length) {
        throw AppError.conflict(
          'Unresolved Cath catalog authority requires the governed recovery command',
          'CATH_CONSUMABLE_RECOVERY_COMMAND_REQUIRED',
          { recovery_worklist_id: String(recovery[0].id) }
        );
      }
    }
    const itemName = cleanText(input.item_name ?? input.itemName ?? existing?.item_name, 255);
    if (!itemName) {
      throw AppError.badRequest('item_name is required', 'CATH_CONSUMABLE_NAME_REQUIRED');
    }
    const category = normalizeStatus(
      input.category ?? existing?.category ?? 'other',
      CATH_CONSUMABLE_CATEGORIES,
      'category'
    );
    const alwaysImplant = ['stent', 'pacemaker', 'lead'].includes(category);
    const isImplant = booleanValue(
      input.is_implant ?? input.isImplant,
      existing?.is_implant ?? alwaysImplant
    );
    if (alwaysImplant && !isImplant) {
      throw AppError.badRequest(
        'Stents, pacemakers, and leads must remain implant tracked',
        'CATH_CONSUMABLE_IMPLANT_TRACKING_REQUIRED'
      );
    }
    const batchTracked = booleanValue(
      input.batch_tracked ?? input.batchTracked,
      existing?.batch_tracked ?? (category === 'stent' || isImplant)
    );
    if ((category === 'stent' || isImplant) && !batchTracked) {
      throw AppError.badRequest(
        'Stents and implants must remain batch tracked',
        'CATH_CONSUMABLE_BATCH_TRACKING_REQUIRED'
      );
    }
    const status = normalizeStatus(
      input.status ?? existing?.status ?? 'active',
      CATH_CONSUMABLE_STATUSES,
      'status'
    );
    const inventoryInputProvided = Object.hasOwn(input, 'inventory_item_id')
      || Object.hasOwn(input, 'inventoryItemId');
    const inventoryValue = Object.hasOwn(input, 'inventory_item_id')
      ? input.inventory_item_id
      : input.inventoryItemId;
    const inventoryItemId = !inventoryInputProvided
      ? (existing?.inventory_item_id ?? null)
      : (inventoryValue ? normalizeId(inventoryValue, 'inventory_item_id') : null);
    const existingInventoryItemId = existing?.inventory_item_id == null
      ? null
      : Number(existing.inventory_item_id);
    if (
      existing
      && inventoryInputProvided
      && String(inventoryItemId ?? '') !== String(existingInventoryItemId ?? '')
    ) {
      throw AppError.conflict(
        'Cath catalog facility/item authority is immutable; retire this item and create a new catalog entry',
        'CATH_CONSUMABLE_INVENTORY_LINK_IMMUTABLE'
      );
    }
    let inventoryFacilityId = existing?.facility_id == null
      ? null
      : Number(existing.facility_id);
    if (inventoryItemId) {
      const inventory = await tx.$queryRawUnsafe(
        `SELECT item.id, item.tenant_id, item.facility_id,
                item.status AS inventory_item_status,
                facility.status AS facility_status
           FROM pharmacy_inventory_items item
           JOIN facilities facility
             ON facility.tenant_id=item.tenant_id
            AND facility.id=item.facility_id
          WHERE item.id = $1::int
            AND item.tenant_id = $2::uuid
            AND item.status = 'active'
            AND facility.status = 'active'
          LIMIT 1
          FOR UPDATE OF item, facility`,
        inventoryItemId,
        tenantId
      );
      if (!inventory.length || inventory[0].facility_id == null) {
        throw AppError.badRequest(
          'Linked inventory item must belong to one active facility in this tenant',
          'CATH_CONSUMABLE_INVENTORY_ITEM_INVALID'
        );
      }
      inventoryFacilityId = Number(inventory[0].facility_id);
    } else if (status === 'active') {
      throw AppError.conflict(
        'An active Cath catalog item must map to one active facility inventory item',
        'CATH_CONSUMABLE_FACILITY_MAPPING_REQUIRED',
        { recovery_action: 'map_or_retire_cath_consumable_catalog_item' }
      );
    }
    const canonicalActor = await cathCanonicalActorTx(tx, tenantId, context);
    if (inventoryFacilityId != null) {
      await assertPharmacyFacilityGrant(tx, {
        tenantId,
        facilityId: inventoryFacilityId,
        actorUid: canonicalActor.uid,
        actorRole: canonicalActor.role,
        forUpdate: true
      });
    }
    const manufacturerInput = providedInput(input, 'manufacturer');
    const manufacturer = manufacturerInput.provided
      ? cleanText(manufacturerInput.value, 255)
      : cleanText(existing?.manufacturer, 255);
    const modelInput = providedInput(input, 'model');
    const model = modelInput.provided
      ? cleanText(modelInput.value, 160)
      : cleanText(existing?.model, 160);
    const costInput = providedInput(
      input,
      'default_unit_cost_reference',
      'defaultUnitCostReference'
    );
    const unitCost = costInput.provided
      ? optionalNumber(costInput.value, 'default_unit_cost_reference')
      : (existing?.default_unit_cost_reference ?? null);
    const billingCodeInput = providedInput(input, 'billing_item_code', 'billingItemCode');
    const billingCode = billingCodeInput.provided
      ? cleanText(billingCodeInput.value, 50)
      : (existing?.billing_item_code ?? null);
    const metadata = normalizeJson(input.metadata, 'metadata', existing?.metadata || {});
    let savedId;
    if (existing) {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE cath_consumable_catalog
            SET facility_id = $3::int,
                inventory_item_id = $4::int,
                item_name = $5,
                category = $6,
                manufacturer = $7,
                model = $8,
                is_implant = $9,
                batch_tracked = $10,
                default_unit_cost_reference = $11::numeric,
                billing_item_code = $12,
                status = $13::varchar(20),
                retired_at = CASE
                  WHEN $13::varchar(20) = 'retired' THEN COALESCE(retired_at, NOW())
                  ELSE NULL
                END,
                updated_by = $14::uuid,
                updated_at = NOW(),
                metadata = $15::jsonb
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
        RETURNING id`,
        tenantId,
        existing.id,
        inventoryFacilityId,
        inventoryItemId,
        itemName,
        category,
        manufacturer,
        model,
        isImplant,
        batchTracked,
        unitCost,
        billingCode,
        status,
        canonicalActor.uid,
        JSON.stringify(metadata)
      );
      savedId = rows[0].id;
    } else {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO cath_consumable_catalog
           (tenant_id, facility_id, inventory_item_id, item_name, category, manufacturer, model,
            is_implant, batch_tracked, default_unit_cost_reference, billing_item_code,
            status, retired_at, created_by, updated_by, metadata)
         VALUES ($1::uuid, $2::int, $3::int, $4, $5, $6, $7,
                 $8, $9, $10::numeric, $11, $12::varchar(20),
                 CASE WHEN $12::varchar(20) = 'retired' THEN NOW() ELSE NULL END,
                 $13::uuid, $13::uuid, $14::jsonb)
         RETURNING id`,
        tenantId,
        inventoryFacilityId,
        inventoryItemId,
        itemName,
        category,
        manufacturer,
        model,
        isImplant,
        batchTracked,
        unitCost,
        billingCode,
        status,
        canonicalActor.uid,
        JSON.stringify(metadata)
      );
      savedId = rows[0].id;
    }
    return catalogItemById(tx, tenantId, savedId);
  });
}

function normalizeCathRecoveryJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeCathRecoveryJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, normalizeCathRecoveryJson(value[key])])
    );
  }
  return value;
}

function cathRecoveryCommandEvidence({ commandKey, requestFingerprint, resolution, note }) {
  const key = String(commandKey || '').trim();
  const requestSha256 = String(requestFingerprint || '').trim().toLowerCase();
  if (!key || !SHA256_PATTERN.test(requestSha256)) {
    throw AppError.badRequest(
      'A durable Idempotency-Key and request fingerprint are required for Cath recovery',
      'CATH_AUTHORITY_RECOVERY_COMMAND_EVIDENCE_REQUIRED'
    );
  }
  const normalizedResolution = normalizeCathRecoveryJson(resolution || {});
  return Object.freeze({
    commandKeySha256: sha256(key),
    requestSha256,
    requestPayload: normalizeCathRecoveryJson({
      resolution: normalizedResolution,
      resolution_note: String(note || '').trim()
    }),
    resolutionPayload: normalizedResolution
  });
}

async function cathRecoveryTargetSnapshotTx(tx, tenantId, recovery) {
  const table = recovery.entity_type === 'cath_consumable_catalog'
    ? 'cath_consumable_catalog'
    : recovery.entity_type === 'cath_consumable_usage'
      ? 'cath_case_consumable_usage'
      : recovery.entity_type === 'cath_lab_case'
        ? 'cath_lab_cases'
        : null;
  if (!table) {
    throw AppError.conflict(
      'Recovery item is not a Cath authority target',
      'CATH_AUTHORITY_RECOVERY_TARGET_INVALID'
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT to_jsonb(target) AS snapshot
       FROM ${table} target
      WHERE target.tenant_id=$1::uuid AND target.id=$2::bigint
      FOR UPDATE`,
    tenantId,
    String(recovery.entity_id)
  );
  if (!rows[0]?.snapshot) {
    throw AppError.conflict(
      'Cath authority recovery target no longer exists',
      'CATH_AUTHORITY_RECOVERY_TARGET_MISSING'
    );
  }
  return normalizeCathRecoveryJson(rows[0].snapshot);
}

async function setCathRecoveryEvidenceTx(tx, {
  actorUid,
  requestId,
  command,
  targetIdentity,
  targetBefore,
  targetAfter
}) {
  await tx.$queryRawUnsafe(
    `SELECT
       set_config('app.pharmacy_recovery_actor_uid', $1, TRUE) AS actor_uid,
       set_config('app.pharmacy_recovery_request_id', $2, TRUE) AS request_id,
       set_config('app.pharmacy_recovery_command_key_sha256', $3, TRUE) AS command_sha,
       set_config('app.pharmacy_recovery_request_sha256', $4, TRUE) AS request_sha,
       set_config('app.pharmacy_recovery_request_payload', $5, TRUE) AS request_payload,
       set_config('app.pharmacy_recovery_resolution_payload', $6, TRUE) AS resolution_payload,
       set_config('app.pharmacy_recovery_target_identity', $7, TRUE) AS target_identity,
       set_config('app.pharmacy_recovery_target_before', $8, TRUE) AS target_before,
       set_config('app.pharmacy_recovery_target_after', $9, TRUE) AS target_after`,
    actorUid,
    String(requestId || '').slice(0, 200),
    command.commandKeySha256,
    command.requestSha256,
    JSON.stringify(command.requestPayload),
    JSON.stringify(command.resolutionPayload),
    JSON.stringify(normalizeCathRecoveryJson(targetIdentity)),
    JSON.stringify(targetBefore),
    JSON.stringify(targetAfter)
  );
}

async function reattachCathUsageAuthorityTx(tx, tenantId, recovery, resolution, actor) {
  const facilityId = normalizeId(resolution.facility_id, 'resolution.facility_id');
  const inventoryItemId = normalizeId(
    resolution.inventory_item_id,
    'resolution.inventory_item_id'
  );
  const inventoryBatchId = normalizeId(
    resolution.inventory_batch_id,
    'resolution.inventory_batch_id'
  );
  const usageRows = await tx.$queryRawUnsafe(
    `SELECT usage.*, cath_case.facility_id AS case_facility_id,
            cath_case.encounter_id, catalog.facility_id AS catalog_facility_id,
            catalog.inventory_item_id AS catalog_inventory_item_id,
            timeline.id AS exact_timeline_event_id,
            timeline.payload->>'facility_id' AS timeline_facility_id,
            timeline.payload->>'inventory_item_id' AS timeline_inventory_item_id,
            timeline.payload->>'inventory_batch_id' AS timeline_inventory_batch_id,
            clinical_audit.id AS exact_audit_event_id
       FROM cath_case_consumable_usage usage
       JOIN cath_lab_cases cath_case
         ON cath_case.tenant_id=usage.tenant_id AND cath_case.id=usage.case_id
        AND cath_case.patient_uid=usage.patient_uid
       JOIN cath_consumable_catalog catalog
         ON catalog.tenant_id=usage.tenant_id AND catalog.id=usage.catalog_item_id
       LEFT JOIN clinical_timeline_events timeline
         ON timeline.tenant_id=usage.tenant_id
        AND timeline.id=usage.timeline_event_id
        AND timeline.patient_uid=usage.patient_uid
        AND timeline.encounter_id IS NOT DISTINCT FROM cath_case.encounter_id
        AND timeline.source_table='cath_case_consumable_usage'
        AND timeline.source_id=usage.id::text
        AND timeline.resource_type='cath_case_consumable_usage'
        AND timeline.resource_id=usage.id::text
        AND timeline.actor_uid IS NOT DISTINCT FROM usage.used_by
        AND timeline.event_type=CASE WHEN usage.wasted
          THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
       LEFT JOIN clinical_audit_events clinical_audit
         ON clinical_audit.tenant_id=usage.tenant_id
        AND clinical_audit.id=usage.audit_event_id
        AND clinical_audit.patient_uid IS NOT DISTINCT FROM usage.patient_uid
        AND clinical_audit.encounter_id IS NOT DISTINCT FROM cath_case.encounter_id
        AND clinical_audit.resource_table='cath_case_consumable_usage'
        AND clinical_audit.resource_id=usage.id::text
        AND clinical_audit.actor_uid IS NOT DISTINCT FROM usage.used_by
        AND clinical_audit.action=CASE WHEN usage.wasted
          THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
      WHERE usage.tenant_id=$1::uuid AND usage.id=$2::bigint
      FOR UPDATE OF usage, cath_case, catalog`,
    tenantId,
    String(recovery.entity_id)
  );
  const usage = usageRows[0];
  if (!usage
      || Number(usage.catalog_facility_id) !== facilityId
      || Number(usage.catalog_inventory_item_id) !== inventoryItemId) {
    throw AppError.conflict(
      'Cath usage recovery must use the exact current catalog facility/item authority',
      'CATH_AUTHORITY_RECOVERY_MAPPING_INVALID'
    );
  }
  if (!usage.timeline_event_id || !usage.audit_event_id
      || !usage.exact_timeline_event_id || !usage.exact_audit_event_id
      || Number(usage.timeline_facility_id) !== facilityId
      || Number(usage.timeline_inventory_item_id) !== inventoryItemId
      || Number(usage.timeline_inventory_batch_id) !== inventoryBatchId) {
    throw AppError.conflict(
      'Cath usage without canonical clinical provenance cannot be reattached to inventory custody',
      'CATH_AUTHORITY_RECOVERY_CANONICAL_PROVENANCE_REQUIRED',
      { recovery_actions: ['PRESERVE', 'CANCEL'] }
    );
  }
  if (usage.case_facility_id == null) {
    throw AppError.conflict(
      'Cath usage cannot be reattached until the case facility recovery is resolved',
      'CATH_LAB_CASE_FACILITY_UNRESOLVED',
      { recovery_action: 'resolve_cath_lab_case_facility_authority_worklist' }
    );
  }
  if (Number(usage.case_facility_id) !== facilityId) {
    throw AppError.conflict(
      'Cath usage recovery facility does not match the pinned case facility',
      'CATH_LAB_CASE_FACILITY_MISMATCH'
    );
  }
  const movements = await tx.$queryRawUnsafe(
    `SELECT id
       FROM pharmacy_stock_movements
      WHERE tenant_id=$1::uuid
        AND (
          (reference_type='cath_consumable_usage' AND reference_id=$2::text)
          OR (reference_type='cath_consumable_reconciliation'
              AND metadata->>'cath_consumable_usage_id'=$2::text)
        )
      LIMIT 1
      FOR SHARE`,
    tenantId,
    String(recovery.entity_id)
  );
  if (movements.length) {
    throw AppError.conflict(
      'Existing Cath stock movement custody cannot be rebound by changing clinical usage authority',
      'CATH_AUTHORITY_RECOVERY_MOVEMENT_EXISTS'
    );
  }
  const batches = await tx.$queryRawUnsafe(
    `SELECT batch.id, batch.batch_number, batch.lot_number, batch.expiry_date,
            batch.remaining_quantity, batch.status
       FROM pharmacy_inventory_batches batch
       JOIN pharmacy_inventory_items item
         ON item.tenant_id=batch.tenant_id AND item.id=batch.inventory_item_id
        AND item.facility_id=batch.facility_id AND item.status='active'
       JOIN facilities facility
         ON facility.tenant_id=batch.tenant_id AND facility.id=batch.facility_id
        AND facility.status='active'
      WHERE batch.tenant_id=$1::uuid AND batch.facility_id=$2::int
        AND batch.inventory_item_id=$3::int AND batch.id=$4::int
      FOR UPDATE OF batch, item, facility`,
    tenantId,
    facilityId,
    inventoryItemId,
    inventoryBatchId
  );
  if (batches.length !== 1) {
    throw AppError.conflict(
      'Cath usage recovery batch is outside the exact active facility/item authority',
      'CATH_AUTHORITY_RECOVERY_BATCH_INVALID'
    );
  }
  const updated = await tx.$queryRawUnsafe(
    `UPDATE cath_case_consumable_usage
        SET facility_id=$3::int, inventory_item_id=$4::int,
            inventory_batch_id=$5::int, batch_number=$6, lot_number=$7,
            expiry_date=$8::date, inventory_decrement_status='pending',
            inventory_movement_id=NULL,
            inventory_warning='Recovered exact facility inventory authority; pharmacy reconciliation is required',
            metadata=COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
            updated_at=NOW()
      WHERE tenant_id=$1::uuid AND id=$2::bigint
      RETURNING *`,
    tenantId,
    String(recovery.entity_id),
    facilityId,
    inventoryItemId,
    inventoryBatchId,
    batches[0].batch_number,
    batches[0].lot_number,
    batches[0].expiry_date,
    JSON.stringify({
      authority_recovery: {
        action: 'REATTACH',
        recovery_id: String(recovery.id),
        actor_uid: actor.uid
      }
    })
  );
  const recovered = normalizeDbValue(updated[0]);
  await materializeCathInventoryShortfallTx(tx, {
    ...recovered,
    encounter_id: usage.encounter_id
  }, {
    decrementedUnits: 0,
    finalMovementId: null,
    warning: recovered.inventory_warning
  });
}

export async function resolveCathConsumableAuthorityRecovery({
  tenantId,
  recoveryId,
  resolution = {},
  actorUid,
  actorRole,
  actorRoles = [],
  requestId = null,
  commandKey,
  requestFingerprint,
  note
} = {}) {
  const tid = tenantOr(tenantId);
  const id = String(recoveryId ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw AppError.badRequest(
      'recovery_id must be a positive integer',
      'CATH_AUTHORITY_RECOVERY_INPUT_INVALID'
    );
  }
  const resolutionNote = String(note || '').trim();
  if (resolutionNote.length < 3 || resolutionNote.length > 500) {
    throw AppError.badRequest(
      'resolution_note must contain 3 to 500 characters',
      'CATH_AUTHORITY_RECOVERY_NOTE_REQUIRED'
    );
  }
  const action = String(resolution?.action || '').trim().toUpperCase();
  if (!['REATTACH', 'PRESERVE', 'CANCEL', 'RETIRE'].includes(action)) {
    throw AppError.badRequest(
      'resolution.action must be REATTACH, PRESERVE, CANCEL, or RETIRE',
      'CATH_AUTHORITY_RECOVERY_ACTION_REQUIRED'
    );
  }
  const command = cathRecoveryCommandEvidence({
    commandKey,
    requestFingerprint,
    resolution: { ...resolution, action },
    note: resolutionNote
  });
  return setTenantTx(tid, async tx => {
    const actor = await cathCanonicalActorTx(tx, tid, {
      actorUid,
      actorRole,
      actorRoles
    });
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, entity_type, entity_id, inventory_item_id, facility_id,
              reason_code, authority_snapshot, status, resolved_by, resolved_at,
              resolution_note
         FROM pharmacy_inventory_authority_recovery_worklist
        WHERE tenant_id=$1::uuid AND id=$2::bigint
          AND entity_type IN (
            'cath_consumable_catalog', 'cath_consumable_usage', 'cath_lab_case'
          )
        FOR UPDATE`,
      tid,
      id
    );
    const recovery = rows[0];
    if (!recovery) {
      throw AppError.notFound(
        'Cath authority recovery item not found',
        'CATH_AUTHORITY_RECOVERY_NOT_FOUND'
      );
    }
    const expectedReason = {
      cath_consumable_catalog: 'CATH_CATALOG_FACILITY_UNRESOLVED',
      cath_consumable_usage: 'CATH_USAGE_AUTHORITY_UNRESOLVED',
      cath_lab_case: 'CATH_CASE_FACILITY_UNRESOLVED'
    }[recovery.entity_type];
    if (recovery.reason_code !== expectedReason) {
      throw AppError.conflict(
        'Cath authority recovery reason does not match its governed resolver',
        'CATH_AUTHORITY_RECOVERY_REASON_INVALID'
      );
    }
    const priorCommands = await tx.$queryRawUnsafe(
      `SELECT recovery_id, request_sha256, actor_uid
         FROM pharmacy_inventory_authority_recovery_events
        WHERE tenant_id=$1::uuid AND command_key_sha256=$2
        LIMIT 1`,
      tid,
      command.commandKeySha256
    );
    if (priorCommands[0]
        && (String(priorCommands[0].recovery_id) !== id
          || priorCommands[0].request_sha256 !== command.requestSha256
          || String(priorCommands[0].actor_uid || '').toLowerCase() !== actor.uid.toLowerCase())) {
      throw AppError.conflict(
        'Idempotency-Key was already used for a different Cath recovery command',
        'CATH_AUTHORITY_RECOVERY_REPLAY_CONFLICT'
      );
    }
    const facilityId = normalizeId(resolution.facility_id, 'resolution.facility_id');
    const facilities = await tx.$queryRawUnsafe(
      `SELECT id
         FROM facilities
        WHERE tenant_id=$1::uuid AND id=$2::int AND status='active'
        FOR UPDATE`,
      tid,
      facilityId
    );
    if (facilities.length !== 1) {
      throw AppError.conflict(
        'Cath authority recovery requires one exact active facility',
        'CATH_AUTHORITY_RECOVERY_FACILITY_INVALID'
      );
    }
    await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId,
      actorUid: actor.uid,
      actorRole: actor.role,
      forUpdate: true
    });
    if (recovery.status === 'RESOLVED') {
      if (priorCommands[0]) return { ...normalizeDbValue(recovery), replayed: true };
      throw AppError.conflict(
        'Cath authority recovery was already resolved by another command',
        'CATH_AUTHORITY_RECOVERY_ALREADY_RESOLVED'
      );
    }
    await tx.$queryRawUnsafe(
      `SELECT
         set_config('app.pharmacy_recovery_command_key_sha256', $1::text, TRUE)
           AS command_sha,
         set_config('app.pharmacy_recovery_actor_uid', $2::text, TRUE)
           AS actor_uid`,
      command.commandKeySha256,
      actor.uid
    );
    const targetBefore = await cathRecoveryTargetSnapshotTx(tx, tid, recovery);
    if (recovery.entity_type === 'cath_consumable_catalog') {
      if (action === 'REATTACH') {
        const inventoryItemId = normalizeId(
          resolution.inventory_item_id,
          'resolution.inventory_item_id'
        );
        const authority = await tx.$queryRawUnsafe(
          `SELECT item.id
             FROM pharmacy_inventory_items item
             JOIN facilities facility
               ON facility.tenant_id=item.tenant_id AND facility.id=item.facility_id
              AND facility.status='active'
            WHERE item.tenant_id=$1::uuid AND item.facility_id=$2::int
              AND item.id=$3::int AND item.status='active'
            FOR UPDATE OF item, facility`,
          tid,
          facilityId,
          inventoryItemId
        );
        if (authority.length !== 1) {
          throw AppError.conflict(
            'Cath catalog recovery requires one exact active facility inventory item',
            'CATH_AUTHORITY_RECOVERY_MAPPING_INVALID'
          );
        }
        await tx.$executeRawUnsafe(
          `UPDATE cath_consumable_catalog
              SET facility_id=$3::int, inventory_item_id=$4::int, status='active',
                  retired_at=NULL, updated_by=$5::uuid,
                  metadata=COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
                  updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::bigint`,
          tid,
          String(recovery.entity_id),
          facilityId,
          inventoryItemId,
          actor.uid,
          JSON.stringify({
            authority_recovery: {
              action,
              recovery_id: id,
              actor_uid: actor.uid
            }
          })
        );
      } else if (['PRESERVE', 'CANCEL', 'RETIRE'].includes(action)) {
        await tx.$executeRawUnsafe(
          `UPDATE cath_consumable_catalog
              SET status='retired', retired_at=COALESCE(retired_at, NOW()),
                  updated_by=$3::uuid,
                  metadata=COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                  updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::bigint`,
          tid,
          String(recovery.entity_id),
          actor.uid,
          JSON.stringify({
            authority_recovery: {
              action,
              recovery_id: id,
              actor_uid: actor.uid,
              preserved_snapshot: targetBefore
            }
          })
        );
      }
    } else if (recovery.entity_type === 'cath_consumable_usage') {
      const usageCaseAuthority = await tx.$queryRawUnsafe(
        `SELECT cath_case.facility_id, cath_case.encounter_id,
                CASE
                  WHEN encounter.metadata->>'facility_id' ~ '^[1-9][0-9]*$'
                  THEN (encounter.metadata->>'facility_id')::int
                  ELSE NULL
                END AS encounter_facility_id,
                EXISTS (
                  SELECT 1
                    FROM pharmacy_inventory_authority_recovery_worklist case_recovery
                   WHERE case_recovery.tenant_id=cath_case.tenant_id
                     AND case_recovery.entity_type='cath_lab_case'
                     AND case_recovery.entity_id=cath_case.id
                     AND case_recovery.reason_code='CATH_CASE_FACILITY_UNRESOLVED'
                     AND case_recovery.status='OPEN'
                ) AS case_recovery_open
           FROM cath_case_consumable_usage usage
           JOIN cath_lab_cases cath_case
             ON cath_case.tenant_id=usage.tenant_id
            AND cath_case.id=usage.case_id
            AND cath_case.patient_uid=usage.patient_uid
           LEFT JOIN patient_encounters encounter
             ON encounter.tenant_id=cath_case.tenant_id
            AND encounter.id=cath_case.encounter_id
            AND encounter.patient_uid=cath_case.patient_uid
          WHERE usage.tenant_id=$1::uuid AND usage.id=$2::bigint
          FOR KEY SHARE OF cath_case`,
        tid,
        String(recovery.entity_id)
      );
      const caseAuthority = usageCaseAuthority[0];
      const terminalAgainstRecoveringCase = ['PRESERVE', 'CANCEL'].includes(action)
        && caseAuthority?.case_recovery_open === true
        && (
          caseAuthority?.encounter_id == null
          || Number(caseAuthority?.encounter_facility_id) === facilityId
        );
      if (caseAuthority?.facility_id == null && !terminalAgainstRecoveringCase) {
        throw AppError.conflict(
          'Cath usage recovery requires the case facility authority to be resolved first',
          'CATH_LAB_CASE_FACILITY_UNRESOLVED',
          { recovery_action: 'resolve_cath_lab_case_facility_authority_worklist' }
        );
      }
      if (Number(caseAuthority?.facility_id) !== facilityId && !terminalAgainstRecoveringCase) {
        throw AppError.conflict(
          'Cath usage recovery must be governed by the exact pinned case facility',
          'CATH_LAB_CASE_FACILITY_MISMATCH'
        );
      }
      if (action === 'REATTACH') {
        await reattachCathUsageAuthorityTx(tx, tid, recovery, {
          ...resolution,
          facility_id: facilityId
        }, actor);
      } else if (['PRESERVE', 'CANCEL'].includes(action)) {
        const movements = await tx.$queryRawUnsafe(
          `SELECT id
             FROM pharmacy_stock_movements
            WHERE tenant_id=$1::uuid
              AND (
                (reference_type='cath_consumable_usage' AND reference_id=$2::text)
                OR (reference_type='cath_consumable_reconciliation'
                    AND metadata->>'cath_consumable_usage_id'=$2::text)
              )
            LIMIT 1
            FOR SHARE`,
          tid,
          String(recovery.entity_id)
        );
        if (movements.length) {
          throw AppError.conflict(
            'Existing Cath inventory movement evidence must be reattached, not discarded',
            'CATH_AUTHORITY_RECOVERY_MOVEMENT_EXISTS'
          );
        }
        const claimedNotifications = await tx.$queryRawUnsafe(
          `SELECT id
             FROM notification_outbox
            WHERE tenant_id=$1::uuid
              AND type='cath_inventory_shortfall'
              AND source_event_key='cath-inventory-shortfall:' || $2::text
              AND status='CLAIMED'
            LIMIT 1
            FOR UPDATE`,
          tid,
          String(recovery.entity_id)
        );
        if (claimedNotifications.length) {
          throw AppError.conflict(
            'Cath recovery cannot close while its pharmacy notification is claimed for delivery',
            'CATH_AUTHORITY_RECOVERY_NOTIFICATION_CLAIMED'
          );
        }
        await tx.$executeRawUnsafe(
          `UPDATE cath_case_consumable_usage
              SET facility_id=NULL, inventory_item_id=NULL, inventory_batch_id=NULL,
                  inventory_decrement_status='not_applicable',
                  inventory_movement_id=NULL,
                  inventory_warning=$3,
                  metadata=COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                  updated_at=NOW()
            WHERE tenant_id=$1::uuid AND id=$2::bigint`,
          tid,
          String(recovery.entity_id),
          action === 'PRESERVE'
            ? 'Historical clinical usage preserved without inferred inventory custody'
            : 'Inventory reconciliation cancelled without altering clinical history',
          JSON.stringify({
            authority_recovery: {
              action,
              recovery_id: id,
              actor_uid: actor.uid,
              governing_facility_id: facilityId,
              preserved_snapshot: targetBefore
            }
          })
        );
        await tx.$executeRawUnsafe(
          `UPDATE tasks
              SET status='cancelled', cancelled_at=COALESCE(cancelled_at, NOW()),
                  cancellation_reason=$4,
                  metadata=COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
                  updated_at=NOW()
            WHERE tenant_id=$1::uuid
              AND related_resource_type='cath_case_consumable_usage'
              AND related_resource_id=$2::text
              AND metadata->>'task_contract'=$3::text
              AND status IN ('open','in_progress','blocked','overdue')`,
          tid,
          String(recovery.entity_id),
          CATH_INVENTORY_SHORTFALL_TASK_CONTRACT,
          `Governed Cath authority recovery ${action.toLowerCase()}`,
          JSON.stringify({
            authority_recovery_terminal: {
              action,
              recovery_id: id,
              actor_uid: actor.uid
            }
          })
        );
        await tx.$executeRawUnsafe(
          `UPDATE workflow_sla_instances
              SET status='cancelled',
                  metadata=COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                  updated_at=NOW()
            WHERE tenant_id=$1::uuid
              AND rule_code=$2::text
              AND source_table='cath_case_consumable_usage'
              AND source_id=$3::text
              AND completed_at IS NULL
              AND status IN ('active','breached','escalated')`,
          tid,
          CATH_INVENTORY_SHORTFALL_SLA_RULE,
          String(recovery.entity_id),
          JSON.stringify({
            authority_recovery_terminal: {
              action,
              recovery_id: id,
              actor_uid: actor.uid
            }
          })
        );
        await tx.$executeRawUnsafe(
          `UPDATE notification_outbox
              SET status='SUPPRESSED',
                  failure_reason=$3
            WHERE tenant_id=$1::uuid
              AND type='cath_inventory_shortfall'
              AND source_event_key='cath-inventory-shortfall:' || $2::text
              AND status IN ('PENDING','FAILED')`,
          tid,
          String(recovery.entity_id),
          `Governed Cath authority recovery ${action.toLowerCase()}`
        );
      } else {
        throw AppError.badRequest(
          'Cath usage recovery supports REATTACH, PRESERVE, or CANCEL',
          'CATH_AUTHORITY_RECOVERY_ACTION_REQUIRED'
        );
      }
    } else if (action === 'REATTACH') {
      const conflictingUsage = await tx.$queryRawUnsafe(
        `SELECT id
           FROM cath_case_consumable_usage
          WHERE tenant_id=$1::uuid AND case_id=$2::bigint
            AND facility_id IS NOT NULL AND facility_id<>$3::int
          LIMIT 1
          FOR SHARE`,
        tid,
        String(recovery.entity_id),
        facilityId
      );
      if (conflictingUsage.length) {
        throw AppError.conflict(
          'Cath case contains conflicting historical facility authority',
          'CATH_LAB_CASE_FACILITY_AMBIGUOUS'
        );
      }
      if (targetBefore.encounter_id) {
        const encounter = await tx.$queryRawUnsafe(
          `SELECT CASE
                    WHEN metadata->>'facility_id' ~ '^[1-9][0-9]*$'
                    THEN (metadata->>'facility_id')::int ELSE NULL
                  END AS facility_id
             FROM patient_encounters
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND patient_uid=$3::uuid
            FOR KEY SHARE`,
          tid,
          targetBefore.encounter_id,
          targetBefore.patient_uid
        );
        if (encounter.length !== 1) {
          throw AppError.conflict(
            'Cath case recovery encounter no longer matches its same-tenant patient',
            'CATH_LAB_CASE_ENCOUNTER_INVALID'
          );
        }
        if (encounter[0].facility_id == null) {
          throw AppError.conflict(
            'Cath case recovery encounter has no exact facility authority',
            'CATH_LAB_CASE_FACILITY_REQUIRED'
          );
        }
        if (Number(encounter[0].facility_id) !== facilityId) {
          throw AppError.conflict(
            'Cath case recovery facility must match the encounter facility authority',
            'CATH_LAB_CASE_FACILITY_MISMATCH'
          );
        }
      }
      const repaired = await tx.$queryRawUnsafe(
        `UPDATE cath_lab_cases
            SET facility_id=$3::int, updated_by=$4::uuid,
                metadata=COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
                updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::bigint
            AND facility_id IS NOT DISTINCT FROM $5::int
          RETURNING id, facility_id`,
        tid,
        String(recovery.entity_id),
        facilityId,
        actor.uid,
        targetBefore.facility_id == null ? null : Number(targetBefore.facility_id),
        JSON.stringify({
          authority_recovery: {
            action: 'REATTACH',
            recovery_id: id,
            actor_uid: actor.uid
          }
        })
      );
      if (repaired.length !== 1 || Number(repaired[0].facility_id) !== facilityId) {
        throw AppError.conflict(
          'Cath case facility authority changed before governed recovery completed',
          'CATH_AUTHORITY_RECOVERY_STATE_CHANGED'
        );
      }
    } else {
      throw AppError.badRequest(
        'Cath case facility recovery supports REATTACH only',
        'CATH_AUTHORITY_RECOVERY_ACTION_REQUIRED'
      );
    }
    const targetAfter = await cathRecoveryTargetSnapshotTx(tx, tid, recovery);
    const targetIdentity = {
      entity_type: recovery.entity_type,
      entity_id: String(recovery.entity_id),
      recovery_id: id,
      reason_code: recovery.reason_code,
      governing_facility_id: facilityId,
      case_id: targetAfter.case_id == null ? null : String(targetAfter.case_id),
      catalog_item_id: targetAfter.catalog_item_id == null
        ? null
        : String(targetAfter.catalog_item_id),
      inventory_item_id: targetAfter.inventory_item_id == null
        ? null
        : Number(targetAfter.inventory_item_id),
      inventory_batch_id: targetAfter.inventory_batch_id == null
        ? null
        : Number(targetAfter.inventory_batch_id)
    };
    await setCathRecoveryEvidenceTx(tx, {
      actorUid: actor.uid,
      requestId,
      command,
      targetIdentity,
      targetBefore,
      targetAfter
    });
    const resolved = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_inventory_authority_recovery_worklist
          SET status='RESOLVED', resolved_by=$3::uuid, resolved_at=NOW(),
              resolution_note=$4, updated_at=NOW(), facility_id=$5::int,
              inventory_item_id=$6::int
        WHERE tenant_id=$1::uuid AND id=$2::bigint AND status='OPEN'
        RETURNING id, entity_type, entity_id, inventory_item_id, facility_id,
                  reason_code, authority_snapshot, status, resolved_by,
                  resolved_at, resolution_note, created_at, updated_at`,
      tid,
      id,
      actor.uid,
      resolutionNote,
      facilityId,
      targetIdentity.inventory_item_id
    );
    if (resolved.length !== 1) {
      throw AppError.conflict(
        'Cath authority recovery state changed before resolution',
        'CATH_AUTHORITY_RECOVERY_STATE_CHANGED'
      );
    }
    return normalizeDbValue(resolved[0]);
  });
}

export async function listCatalogBatches(
  catalogItemId,
  { tenantId, caseId, db = prisma } = {}
) {
  const cathCase = await caseById(db, tenantId, caseId);
  if (cathCase.facility_id == null) {
    throw AppError.conflict(
      'Cath-lab case has no exact facility authority',
      'CATH_LAB_CASE_FACILITY_UNRESOLVED'
    );
  }
  const item = await catalogItemById(db, tenantId, catalogItemId);
  if (Number(item.facility_id) !== Number(cathCase.facility_id)) {
    throw AppError.forbidden(
      'Cath consumable catalog item belongs to another facility',
      'CATH_CONSUMABLE_FACILITY_SCOPE_MISMATCH'
    );
  }
  if (
    item.status !== 'active'
    || !item.inventory_item_id
    || Number(item.inventory_facility_id) !== Number(item.facility_id)
    || item.inventory_item_status !== 'active'
    || item.inventory_facility_status !== 'active'
  ) {
    throw AppError.conflict(
      'Cath batch access requires one exact active facility catalog and inventory mapping',
      'CATH_CONSUMABLE_FACILITY_MAPPING_UNRESOLVED',
      { recovery_action: 'resolve_cath_consumable_catalog_authority_worklist' }
    );
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT b.id, b.inventory_item_id, b.batch_number, b.lot_number,
            b.facility_id, b.expiry_date, b.remaining_quantity, b.status,
            b.unit_cost_minor, b.mrp_minor
       FROM pharmacy_inventory_batches b
      WHERE b.tenant_id = $1::uuid
        AND b.inventory_item_id = $2::int
        AND b.facility_id = $3::int
        AND b.status = 'in_stock'
        AND b.remaining_quantity > 0
        AND b.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY b.expiry_date, b.id`,
    tenantOr(tenantId),
    Number(item.inventory_item_id),
    Number(item.facility_id)
  );
  return normalizeRows(rows);
}

const CATH_CONSUMABLE_USAGE_SELECT = `
  u.id, u.tenant_id, u.case_id, u.procedure_log_id, u.catalog_item_id,
  u.patient_uid, u.facility_id, u.inventory_item_id, u.inventory_batch_id,
  u.quantity, u.batch_tracked,
  u.is_implant, u.batch_number, u.lot_number, u.expiry_date,
  u.serial_number, u.unit_cost_snapshot, u.used_by, u.used_at,
  u.wasted, u.waste_reason, u.inventory_decrement_status,
  u.inventory_movement_id, u.inventory_warning, u.timeline_event_id,
  u.audit_event_id, u.idempotency_key, u.created_at, u.updated_at, u.metadata,
  c.item_name, c.category, c.manufacturer, c.model, c.billing_item_code,
  c.facility_id AS catalog_facility_id,
  c.inventory_item_id AS catalog_inventory_item_id, i.sku_code AS inventory_sku,
  i.display_name AS inventory_item_name, i.unit_label AS inventory_unit_label,
  clinician.name AS used_by_name,
  si.id AS implant_record_id`;

async function consumableUsageById(db, tenantId, usageId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${CATH_CONSUMABLE_USAGE_SELECT}
       FROM cath_case_consumable_usage u
       JOIN cath_consumable_catalog c
         ON c.id = u.catalog_item_id
        AND c.tenant_id = u.tenant_id
       LEFT JOIN pharmacy_inventory_items i
         ON i.id = u.inventory_item_id
        AND i.facility_id = u.facility_id
        AND i.tenant_id = u.tenant_id
       LEFT JOIN users clinician
         ON clinician.uid = u.used_by
        AND clinician.tenant_id = u.tenant_id
       LEFT JOIN surgical_implants si
         ON si.cath_usage_id = u.id
        AND si.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid
        AND u.id = $2::bigint
      LIMIT 1`,
    tenantOr(tenantId),
    normalizeId(usageId, 'usage_id')
  );
  const usage = unwrap(rows);
  if (!usage) {
    throw AppError.notFound('Cath consumable usage not found', 'CATH_CONSUMABLE_USAGE_NOT_FOUND');
  }
  return normalizeDbValue(usage);
}

export async function listCaseConsumableUsage(caseId, { tenantId, db = prisma } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${CATH_CONSUMABLE_USAGE_SELECT}
       FROM cath_case_consumable_usage u
       JOIN cath_consumable_catalog c
         ON c.id = u.catalog_item_id
        AND c.tenant_id = u.tenant_id
       LEFT JOIN pharmacy_inventory_items i
         ON i.id = u.inventory_item_id
        AND i.facility_id = u.facility_id
        AND i.tenant_id = u.tenant_id
       LEFT JOIN users clinician
         ON clinician.uid = u.used_by
        AND clinician.tenant_id = u.tenant_id
       LEFT JOIN surgical_implants si
         ON si.cath_usage_id = u.id
        AND si.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid
        AND u.case_id = $2::bigint
      ORDER BY u.used_at DESC, u.id DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  return normalizeRows(rows);
}

function batchLineageMismatch(batch, { batchNumber, lotNumber, expiryDate }) {
  const actualBatch = cleanText(batch.batch_number, 120);
  const actualLot = cleanText(batch.lot_number, 120);
  const actualExpiry = optionalDate(batch.expiry_date, 'inventory_batch.expiry_date');
  const expectedBatch = cleanText(batchNumber, 120);
  const expectedLot = cleanText(lotNumber, 120);
  const expectedExpiry = optionalDate(expiryDate, 'documented.expiry_date');
  return Boolean(
    (expectedBatch && expectedBatch !== actualBatch)
    || (expectedLot && expectedLot !== actualLot)
    || (expectedExpiry && expectedExpiry !== actualExpiry)
  );
}

function evaluateCathInventoryBatch(batch, quantity) {
  const status = cleanText(batch?.status, 30);
  if (status !== 'in_stock') {
    return {
      status: 'error',
      warning: `Exact inventory batch is ${status || 'unavailable'}; clinical usage was saved without a stock decrement`
    };
  }
  if (batch.is_expired) {
    return {
      status: 'error',
      warning: 'Exact inventory batch is expired; clinical usage was saved without a stock decrement'
    };
  }
  const remaining = Number(normalizeDbValue(batch.remaining_quantity));
  if (!Number.isFinite(remaining)) {
    return {
      status: 'error',
      warning: 'Exact inventory batch quantity is invalid; clinical usage was saved without a stock decrement'
    };
  }
  if (remaining < quantity) {
    return {
      status: 'pending',
      warning: `Insufficient stock in exact batch: requested ${quantity}, available ${remaining}; inventory reconciliation will be materialized after the clinical record commits`
    };
  }
  return { status: 'pending', warning: null };
}

async function cathMovementEvidenceTx(tx, usage) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(-movement.quantity_delta), 0::numeric) AS decremented_quantity,
            (ARRAY_AGG(movement.id ORDER BY movement.created_at DESC, movement.id DESC)
              FILTER (WHERE movement.id IS NOT NULL))[1] AS final_movement_id
       FROM pharmacy_stock_movements movement
      WHERE movement.tenant_id = $1::uuid
        AND (
          (movement.reference_type = 'cath_consumable_usage'
           AND movement.reference_id = $2::text)
          OR
          (movement.reference_type = 'cath_consumable_reconciliation'
           AND movement.metadata->>'cath_consumable_usage_id' = $2::text)
        )`,
    usage.tenant_id,
    String(usage.id)
  );
  return {
    decrementedUnits: Math.round(Number(rows[0]?.decremented_quantity || 0) * QUANTITY_SCALE),
    finalMovementId: rows[0]?.final_movement_id || null
  };
}

async function updateCathInventoryOutcomeTx(tx, usage, {
  status,
  movementId = null,
  warning = null,
  metadata = null
}) {
  await tx.$queryRawUnsafe(
    `UPDATE cath_case_consumable_usage
        SET inventory_decrement_status = $3,
            inventory_movement_id = $4::int,
            inventory_warning = $5,
            metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint`,
    usage.tenant_id,
    normalizeId(usage.id, 'usage_id'),
    status,
    movementId,
    warning,
    JSON.stringify(metadata || {})
  );
}

async function cathShortfallNotificationRecipientTx(tx, tenantId, facilityId) {
  const routine = await tx.$queryRawUnsafe(
    `SELECT actor.id, actor.uid, actor.phone, actor.preferred_language, actor.role,
            facility_grant.id AS facility_grant_id
       FROM users actor
       JOIN staff actor_staff
         ON actor_staff.tenant_id=actor.tenant_id
        AND actor_staff.user_id=actor.uid
        AND actor_staff.is_active=TRUE
        AND actor_staff.archived=FALSE
       JOIN pharmacy_staff_facility_grants facility_grant
         ON facility_grant.tenant_id=actor.tenant_id
        AND facility_grant.staff_uid=actor.uid
        AND facility_grant.facility_id=$3::int
        AND facility_grant.status='active'
        AND facility_grant.revoked_at IS NULL
      WHERE actor.tenant_id = $1::uuid
        AND actor.is_active = TRUE
        AND actor.status = 'active'
        AND COALESCE(actor.is_deleted, FALSE) = FALSE
        AND actor.merged_into_uid IS NULL
        AND actor.role = ANY($2::text[])
      ORDER BY CASE actor.role
                 WHEN 'PHARMACIST' THEN 0
                 WHEN 'PHARMACY_INCHARGE' THEN 1
                 ELSE 2
               END,
               actor.last_sign_in_at DESC NULLS LAST,
               actor.id
      LIMIT 1`,
    tenantId,
    CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES,
    Number(facilityId)
  );
  if (routine[0]) return { ...routine[0], coverageGap: false, deliveryCoverage: 'direct' };
  const coverage = await tx.$queryRawUnsafe(
    `SELECT id, uid, phone, preferred_language, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND is_active = TRUE
        AND status = 'active'
         AND COALESCE(is_deleted, FALSE) = FALSE
         AND merged_into_uid IS NULL
         AND role = ANY($2::text[])
      ORDER BY CASE role WHEN 'SUPER_ADMIN' THEN 0 ELSE 1 END,
               last_sign_in_at DESC NULLS LAST,
               id
      LIMIT 1`,
    tenantId,
    CATH_INVENTORY_SHORTFALL_COVERAGE_ROLES
  );
  if (coverage[0]) {
    return { ...coverage[0], coverageGap: true, deliveryCoverage: 'operator_recovery' };
  }
  return {
    id: null,
    uid: null,
    phone: null,
    preferred_language: 'en',
    role: null,
    coverageGap: true,
    deliveryCoverage: 'unassigned'
  };
}

async function materializeCathInventoryShortfallTx(tx, usage, {
  decrementedUnits,
  finalMovementId,
  warning
}) {
  const deepLink = cathInventoryShortfallDeepLink(usage.case_id, usage.id);
  const retryPath = cathInventoryReconciliationPath(usage.case_id, usage.id);
  const intendedRoleCodes = [...CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES];
  await updateCathInventoryOutcomeTx(tx, usage, {
    status: 'insufficient_stock',
    movementId: finalMovementId,
    warning,
    metadata: {
      inventory_shortfall_contract: CATH_INVENTORY_SHORTFALL_TASK_CONTRACT,
      inventory_shortfall_deep_link: deepLink,
      inventory_shortfall_retry_path: retryPath,
      inventory_shortfall_intended_role_codes: intendedRoleCodes,
      inventory_facility_id: Number(usage.facility_id)
    }
  });
  const sla = await startWorkflowSla({
    tenantId: usage.tenant_id,
    ruleCode: CATH_INVENTORY_SHORTFALL_SLA_RULE,
    patientUid: usage.patient_uid,
    encounterId: usage.encounter_id,
    sourceTable: 'cath_case_consumable_usage',
    sourceId: String(usage.id),
    priority: 'high',
    assignedRoleCodes: intendedRoleCodes,
    metadata: {
      task_contract: CATH_INVENTORY_SHORTFALL_TASK_CONTRACT,
      cath_case_id: String(usage.case_id),
      cath_consumable_usage_id: String(usage.id),
      inventory_item_id: String(usage.inventory_item_id),
      inventory_batch_id: String(usage.inventory_batch_id),
      inventory_facility_id: Number(usage.facility_id)
    }
  }, { db: tx, strict: true });
  if (!sla?.id) {
    throw AppError.internal(
      'Cath inventory shortfall SLA was not materialized',
      'CATH_INVENTORY_SHORTFALL_SLA_MISSING'
    );
  }
  const taskMetadata = {
    cath_consumable_usage_id: String(usage.id),
    cath_case_id: String(usage.case_id),
    inventory_item_id: String(usage.inventory_item_id),
    inventory_batch_id: String(usage.inventory_batch_id),
    facility_id: Number(usage.facility_id),
    movement_kind: usage.wasted ? 'dispose' : 'issue',
    deep_link: deepLink,
    retry_path: retryPath,
    action_label_key: CATH_INVENTORY_SHORTFALL_ACTION_LABEL_KEY,
    presentation_key: 'cath_inventory_shortfall',
    presentations: CATH_INVENTORY_SHORTFALL_PRESENTATIONS,
    documented_quantity: quantityFromUnits(quantityUnits(usage.quantity)),
    decremented_quantity: quantityFromUnits(decrementedUnits)
  };
  let task = await createCathInventoryShortfallTaskTx({
    tenantId: usage.tenant_id,
    title: CATH_INVENTORY_SHORTFALL_PRESENTATIONS.en.title,
    description: CATH_INVENTORY_SHORTFALL_PRESENTATIONS.en.body,
    patientUid: usage.patient_uid,
    encounterId: usage.encounter_id,
    relatedResourceId: String(usage.id),
    createdBy: usage.used_by,
    workflowSlaInstanceId: sla.id,
    stageOccurrenceKey: `cath-inventory-shortfall:usage:${String(usage.id)}`,
    metadata: taskMetadata,
    tx
  });
  if (!task) {
    const existing = await tx.$queryRawUnsafe(
      `SELECT *
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'cath_case_consumable_usage'
          AND related_resource_id = $2::text
          AND metadata->>'task_contract' = $3::text
        LIMIT 1
        FOR UPDATE`,
      usage.tenant_id,
      String(usage.id),
      CATH_INVENTORY_SHORTFALL_TASK_CONTRACT
    );
    task = existing[0] || null;
  }
  if (!task?.id || String(task.workflow_sla_instance_id) !== String(sla.id)) {
    throw AppError.conflict(
      'Cath inventory shortfall task changed before materialization',
      'CATH_INVENTORY_SHORTFALL_TASK_CONFLICT'
    );
  }
  const recipient = await cathShortfallNotificationRecipientTx(
    tx,
    usage.tenant_id,
    usage.facility_id
  );
  const presentation = cathInventoryShortfallPresentation(recipient.preferred_language);
  const outbox = await notificationOutbox.queue({
    tenantId: usage.tenant_id,
    type: 'cath_inventory_shortfall',
    channel: 'inapp',
    recipientId: recipient.id,
    recipientPhone: null,
    title: presentation.title,
    body: presentation.body,
    sourceEventKey: `cath-inventory-shortfall:${String(usage.id)}`,
    templateVersion: 'cath-inventory-shortfall.v1',
    data: {
      kind: 'cath_inventory_shortfall',
      task_id: String(task.id),
      cath_case_id: String(usage.case_id),
      cath_consumable_usage_id: String(usage.id),
      inventory_item_id: String(usage.inventory_item_id),
      inventory_batch_id: String(usage.inventory_batch_id),
      facility_id: Number(usage.facility_id),
      deep_link: deepLink,
      retry_path: retryPath,
      action_label_key: CATH_INVENTORY_SHORTFALL_ACTION_LABEL_KEY,
      coverage_gap: recipient.coverageGap,
      delivery_coverage: recipient.deliveryCoverage,
      intended_role_codes: intendedRoleCodes,
      recipient_uid: recipient.uid,
      recipient_role: recipient.role,
      recipient_facility_grant_id: recipient.facility_grant_id == null
        ? null
        : String(recipient.facility_grant_id),
      recipient_status_snapshot: recipient.id ? 'active' : null,
      recipient_not_deleted_snapshot: recipient.id ? true : null,
      presentation_key: 'cath_inventory_shortfall',
      presentation_locale: cathInventoryShortfallPresentationLocale(
        recipient.preferred_language
      ),
      presentation_copy_version: 'cath-inventory-shortfall.v1',
      presentations: CATH_INVENTORY_SHORTFALL_PRESENTATIONS
    }
  }, { tx, strict: true });
  if (!outbox?.id) {
    throw AppError.internal(
      'Cath inventory shortfall notification intent was not persisted',
      'CATH_INVENTORY_SHORTFALL_NOTIFICATION_MISSING'
    );
  }
  await updateCathInventoryOutcomeTx(tx, usage, {
    status: 'insufficient_stock',
    movementId: finalMovementId,
    warning,
    metadata: {
      inventory_shortfall_contract: CATH_INVENTORY_SHORTFALL_TASK_CONTRACT,
      inventory_shortfall_task_id: String(task.id),
      inventory_shortfall_sla_instance_id: String(sla.id),
      inventory_shortfall_notification_outbox_id: String(outbox.id),
      inventory_shortfall_notification_delivery: recipient.deliveryCoverage
    }
  });
  return { task, sla, outbox };
}

async function initialCathInventoryBatchesTx(tx, usage) {
  return tx.$queryRawUnsafe(
    `SELECT id, inventory_item_id, facility_id, batch_number, lot_number, expiry_date,
            remaining_quantity, status,
            (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
       FROM pharmacy_inventory_batches
      WHERE tenant_id = $1::uuid
        AND inventory_item_id = $2::int
        AND facility_id = $3::int
        AND id = $4::int
      LIMIT 1
      FOR UPDATE`,
    usage.tenant_id,
    Number(usage.inventory_item_id),
    Number(usage.facility_id),
    Number(usage.inventory_batch_id)
  );
}

async function cathInventoryReconciliationRowTx(tx, tenantId, caseId, usageId, {
  lock = false
} = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT usage.id AS usage_id,
            usage.tenant_id,
            usage.case_id,
            usage.patient_uid,
            usage.catalog_item_id,
            usage.facility_id,
            usage.inventory_item_id,
            usage.inventory_batch_id,
            usage.batch_number,
            usage.lot_number,
            usage.expiry_date,
            usage.quantity::numeric(14,4)::text AS documented_quantity,
            usage.inventory_decrement_status,
            usage.inventory_movement_id,
            usage.inventory_warning,
            usage.wasted,
            usage.used_by,
            usage.metadata AS usage_metadata,
            catalog.item_name,
            inventory_item.schedule_class,
            inventory_item.is_narcotic,
            cath_case.encounter_id,
            task.id AS task_id,
            task.status AS task_status,
            task.assigned_to_uid AS task_assigned_to_uid,
            task.assigned_to_role AS task_assigned_to_role,
            COALESCE(
              task_assignee.uid IS NOT NULL
              AND task_assignee.is_active = TRUE
              AND task_assignee.status = 'active'
              AND COALESCE(task_assignee.is_deleted, FALSE) = FALSE
              AND task_assignee.merged_into_uid IS NULL
              AND task_assignee.role = ANY($6::text[])
              AND task_assignee_staff.id IS NOT NULL
              AND task_assignee_grant.id IS NOT NULL,
              FALSE
            ) AS task_assignee_active,
            task.workflow_sla_instance_id,
            task.completed_at AS task_completed_at,
            task.metadata AS task_metadata,
            sla.status AS sla_status,
            sla.started_at AS sla_started_at,
            sla.due_at,
            sla.completed_at AS sla_completed_at,
            sla.assigned_user_uid AS sla_assigned_user_uid,
            sla.assigned_role_codes AS sla_assigned_role_codes,
            outbox.payload AS notification_payload,
            COALESCE(evidence.decremented_quantity, 0::numeric)::numeric(14,4)::text
              AS decremented_quantity,
            evidence.final_movement_id,
            evidence.final_movement_reference_type,
            COALESCE(operator_state.operator_available, FALSE) AS operator_available
       FROM cath_case_consumable_usage usage
       JOIN cath_lab_cases cath_case
         ON cath_case.tenant_id = usage.tenant_id
        AND cath_case.id = usage.case_id
        AND cath_case.patient_uid = usage.patient_uid
        AND cath_case.facility_id = usage.facility_id
       JOIN cath_consumable_catalog catalog
         ON catalog.tenant_id = usage.tenant_id
        AND catalog.facility_id = usage.facility_id
        AND catalog.id = usage.catalog_item_id
        AND catalog.inventory_item_id = usage.inventory_item_id
        AND catalog.status = 'active'
       JOIN pharmacy_inventory_items inventory_item
         ON inventory_item.tenant_id = usage.tenant_id
        AND inventory_item.facility_id = usage.facility_id
        AND inventory_item.id = usage.inventory_item_id
        AND inventory_item.status = 'active'
       JOIN pharmacy_inventory_batches inventory_batch
         ON inventory_batch.tenant_id = usage.tenant_id
        AND inventory_batch.facility_id = usage.facility_id
        AND inventory_batch.id = usage.inventory_batch_id
        AND inventory_batch.inventory_item_id = usage.inventory_item_id
        AND inventory_batch.batch_number IS NOT DISTINCT FROM usage.batch_number
        AND inventory_batch.lot_number IS NOT DISTINCT FROM usage.lot_number
        AND inventory_batch.expiry_date IS NOT DISTINCT FROM usage.expiry_date
       JOIN facilities inventory_facility
         ON inventory_facility.tenant_id=usage.tenant_id
        AND inventory_facility.id=usage.facility_id
        AND inventory_facility.status='active'
       JOIN clinical_timeline_events timeline
         ON timeline.tenant_id=usage.tenant_id
        AND timeline.id=usage.timeline_event_id
        AND timeline.patient_uid=usage.patient_uid
        AND timeline.encounter_id IS NOT DISTINCT FROM cath_case.encounter_id
        AND timeline.source_table='cath_case_consumable_usage'
        AND timeline.source_id=usage.id::text
        AND timeline.resource_type='cath_case_consumable_usage'
        AND timeline.resource_id=usage.id::text
        AND timeline.actor_uid IS NOT DISTINCT FROM usage.used_by
        AND timeline.event_type=CASE WHEN usage.wasted
          THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
        AND timeline.payload->>'facility_id'=usage.facility_id::text
        AND timeline.payload->>'inventory_item_id'=usage.inventory_item_id::text
        AND timeline.payload->>'inventory_batch_id'=usage.inventory_batch_id::text
       JOIN clinical_audit_events clinical_audit
         ON clinical_audit.tenant_id=usage.tenant_id
        AND clinical_audit.id=usage.audit_event_id
        AND clinical_audit.patient_uid IS NOT DISTINCT FROM usage.patient_uid
        AND clinical_audit.encounter_id IS NOT DISTINCT FROM cath_case.encounter_id
        AND clinical_audit.resource_table='cath_case_consumable_usage'
        AND clinical_audit.resource_id=usage.id::text
        AND clinical_audit.actor_uid IS NOT DISTINCT FROM usage.used_by
        AND clinical_audit.action=CASE WHEN usage.wasted
          THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
       JOIN tasks task
         ON task.tenant_id = usage.tenant_id
        AND task.related_resource_type = 'cath_case_consumable_usage'
        AND task.related_resource_id = usage.id::text
        AND task.metadata->>'task_contract' = $4::text
        AND task.patient_uid = usage.patient_uid
        AND task.metadata->>'cath_consumable_usage_id' = usage.id::text
        AND task.metadata->>'cath_case_id' = usage.case_id::text
        AND task.metadata->>'facility_id' = usage.facility_id::text
        AND task.metadata->>'inventory_item_id' = usage.inventory_item_id::text
        AND task.metadata->>'inventory_batch_id' = usage.inventory_batch_id::text
       JOIN workflow_sla_instances sla
         ON sla.tenant_id = usage.tenant_id
        AND sla.id = task.workflow_sla_instance_id
        AND sla.rule_code = $5::text
         AND sla.source_table = 'cath_case_consumable_usage'
         AND sla.source_id = usage.id::text
         AND sla.patient_uid = usage.patient_uid
         AND sla.encounter_id IS NOT DISTINCT FROM cath_case.encounter_id
         AND sla.metadata->>'cath_case_id' = usage.case_id::text
         AND sla.metadata->>'inventory_facility_id' = usage.facility_id::text
         AND sla.metadata->>'inventory_item_id' = usage.inventory_item_id::text
         AND sla.metadata->>'inventory_batch_id' = usage.inventory_batch_id::text
       LEFT JOIN users task_assignee
         ON task_assignee.tenant_id = task.tenant_id
        AND task_assignee.uid = task.assigned_to_uid
       LEFT JOIN pharmacy_staff_facility_grants task_assignee_grant
         ON task_assignee_grant.tenant_id=task.tenant_id
        AND task_assignee_grant.staff_uid=task.assigned_to_uid
        AND task_assignee_grant.facility_id=usage.facility_id
        AND task_assignee_grant.status='active'
        AND task_assignee_grant.revoked_at IS NULL
       LEFT JOIN staff task_assignee_staff
         ON task_assignee_staff.tenant_id=task.tenant_id
        AND task_assignee_staff.user_id=task.assigned_to_uid
        AND task_assignee_staff.is_active=TRUE
        AND task_assignee_staff.archived=FALSE
       JOIN notification_outbox outbox
         ON outbox.tenant_id = usage.tenant_id
        AND outbox.type = 'cath_inventory_shortfall'
        AND outbox.source_event_key = 'cath-inventory-shortfall:' || usage.id::text
        AND outbox.payload->>'cath_consumable_usage_id' = usage.id::text
        AND outbox.payload->>'cath_case_id' = usage.case_id::text
        AND outbox.payload->>'facility_id' = usage.facility_id::text
        AND outbox.payload->>'inventory_item_id' = usage.inventory_item_id::text
        AND outbox.payload->>'inventory_batch_id' = usage.inventory_batch_id::text
        AND (
          outbox.payload->>'delivery_coverage' IS DISTINCT FROM 'direct'
          OR (
            outbox.payload->>'recipient_facility_grant_id' ~ '^[1-9][0-9]*$'
            AND EXISTS (
              SELECT 1
                FROM pharmacy_staff_facility_grants recipient_grant
                JOIN users recipient
                  ON recipient.tenant_id=recipient_grant.tenant_id
                 AND recipient.uid=recipient_grant.staff_uid
                JOIN staff recipient_staff
                  ON recipient_staff.tenant_id=recipient.tenant_id
                 AND recipient_staff.user_id=recipient.uid
               WHERE recipient_grant.tenant_id=usage.tenant_id
                 AND recipient_grant.id::text=
                       outbox.payload->>'recipient_facility_grant_id'
                 AND recipient_grant.facility_id=usage.facility_id
                 AND recipient_grant.staff_uid::text=outbox.payload->>'recipient_uid'
                 AND recipient.id::text=outbox.recipient_id
                 AND outbox.payload->>'recipient_status_snapshot'='active'
                 AND outbox.payload->>'recipient_not_deleted_snapshot'='true'
                 AND recipient_grant.granted_at <= outbox.created_at
                 AND (recipient_grant.revoked_at IS NULL
                      OR recipient_grant.revoked_at >= outbox.created_at)
            )
          )
        )
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(-movement.quantity_delta), 0::numeric)
                  AS decremented_quantity,
                (ARRAY_AGG(movement.id ORDER BY movement.created_at DESC, movement.id DESC)
                  FILTER (WHERE movement.id IS NOT NULL))[1] AS final_movement_id,
                (ARRAY_AGG(movement.reference_type
                  ORDER BY movement.created_at DESC, movement.id DESC)
                  FILTER (WHERE movement.id IS NOT NULL))[1]
                  AS final_movement_reference_type
           FROM pharmacy_stock_movements movement
          WHERE movement.tenant_id = usage.tenant_id
            AND (
              (movement.reference_type = 'cath_consumable_usage'
               AND movement.reference_id = usage.id::text)
              OR
              (movement.reference_type = 'cath_consumable_reconciliation'
               AND movement.metadata->>'cath_consumable_usage_id' = usage.id::text)
            )
       ) evidence ON TRUE
       LEFT JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1
             FROM pharmacy_stock_movements movement
            WHERE movement.tenant_id=usage.tenant_id
              AND (
                (movement.reference_type='cath_consumable_usage'
                 AND movement.reference_id=usage.id::text)
                OR (movement.reference_type='cath_consumable_reconciliation'
                 AND movement.metadata->>'cath_consumable_usage_id'=usage.id::text)
              )
              AND (
                movement.inventory_item_id IS DISTINCT FROM usage.inventory_item_id
                OR movement.inventory_batch_id IS DISTINCT FROM usage.inventory_batch_id
                OR movement.movement_kind IS DISTINCT FROM
                     CASE WHEN usage.wasted THEN 'dispose' ELSE 'issue' END
                OR movement.quantity_delta >= 0
                OR movement.metadata->>'facility_id' IS DISTINCT FROM usage.facility_id::text
                OR movement.performed_by::text
                     IS DISTINCT FROM movement.metadata->>'canonical_actor_uid'
                OR movement.metadata->>'actor_facility_grant_id' !~ '^[1-9][0-9]*$'
                OR NOT EXISTS (
                  SELECT 1
                    FROM pharmacy_staff_facility_grants movement_grant
                   WHERE movement_grant.tenant_id=movement.tenant_id
                     AND movement_grant.id::text=
                           movement.metadata->>'actor_facility_grant_id'
                     AND movement_grant.staff_uid=movement.performed_by
                     AND movement_grant.facility_id=usage.facility_id
                     AND movement_grant.granted_at <= movement.created_at
                     AND (movement_grant.revoked_at IS NULL
                          OR movement_grant.revoked_at >= movement.created_at)
                )
              )
         ) AS invalid_movement
       ) movement_authority ON TRUE
       LEFT JOIN LATERAL (
          SELECT EXISTS (
            SELECT 1
              FROM users available_operator
              JOIN staff available_operator_staff
                ON available_operator_staff.tenant_id=available_operator.tenant_id
               AND available_operator_staff.user_id=available_operator.uid
               AND available_operator_staff.is_active=TRUE
               AND available_operator_staff.archived=FALSE
              JOIN pharmacy_staff_facility_grants available_grant
                ON available_grant.tenant_id=available_operator.tenant_id
               AND available_grant.staff_uid=available_operator.uid
               AND available_grant.facility_id=usage.facility_id
               AND available_grant.status='active'
               AND available_grant.revoked_at IS NULL
            WHERE available_operator.tenant_id = usage.tenant_id
              AND available_operator.is_active = TRUE
              AND available_operator.status = 'active'
               AND COALESCE(available_operator.is_deleted, FALSE) = FALSE
               AND available_operator.merged_into_uid IS NULL
               AND available_operator.role = ANY($6::text[])
         ) AS operator_available
       ) operator_state ON TRUE
      WHERE usage.tenant_id = $1::uuid
        AND usage.case_id = $2::bigint
        AND usage.id = $3::bigint
        AND usage.metadata->>'inventory_shortfall_contract' = $4::text
        AND COALESCE(movement_authority.invalid_movement, FALSE)=FALSE
      LIMIT 1
      ${lock ? `FOR UPDATE OF usage, cath_case, catalog, inventory_item,
                              inventory_batch, task, sla` : ''}`,
    tenantId,
    normalizeId(caseId, 'case_id'),
    normalizeId(usageId, 'usage_id'),
    CATH_INVENTORY_SHORTFALL_TASK_CONTRACT,
    CATH_INVENTORY_SHORTFALL_SLA_RULE,
    CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES
  );
  if (!rows[0]) {
    const unresolved = await tx.$queryRawUnsafe(
      `SELECT usage.id AS usage_id, usage.facility_id, usage.inventory_item_id,
              recovery.id AS recovery_id, recovery.reason_code
         FROM cath_case_consumable_usage usage
         LEFT JOIN pharmacy_inventory_authority_recovery_worklist recovery
           ON recovery.tenant_id=usage.tenant_id
          AND recovery.entity_type='cath_consumable_usage'
          AND recovery.entity_id=usage.id
          AND recovery.status='OPEN'
        WHERE usage.tenant_id=$1::uuid
          AND usage.case_id=$2::bigint
          AND usage.id=$3::bigint
        LIMIT 1`,
      tenantId,
      normalizeId(caseId, 'case_id'),
      normalizeId(usageId, 'usage_id')
    );
    if (unresolved[0]) {
      throw AppError.conflict(
        'Cath usage inventory authority is unresolved and cannot be inferred',
        'CATH_INVENTORY_RECONCILIATION_AUTHORITY_UNRESOLVED',
        {
          recovery_worklist_id: unresolved[0].recovery_id == null
            ? null
            : String(unresolved[0].recovery_id),
          reason_code: unresolved[0].reason_code || 'CATH_USAGE_AUTHORITY_UNRESOLVED',
          recovery_action: 'resolve_cath_consumable_usage_authority_worklist'
        }
      );
    }
    throw AppError.notFound(
      'Cath inventory reconciliation was not found',
      'CATH_INVENTORY_RECONCILIATION_NOT_FOUND'
    );
  }
  return normalizeDbValue(rows[0]);
}

function assertCathInventoryReconciliationAccess(record, actor, { mutation = false } = {}) {
  const assignedUid = String(record.task_assigned_to_uid || '').trim().toLowerCase();
  const assignedRole = String(record.task_assigned_to_role || '').trim().toUpperCase();
  const queueAccess = !assignedUid && assignedRole === 'PHARMACIST';
  const assignedAccess = assignedUid && assignedUid === actor.uid.toLowerCase();
  const staleRecoveryAccess = actor.routine
    && assignedUid
    && record.task_assignee_active !== true;
  const coverageGap = record.notification_payload?.coverage_gap === true
    || record.operator_available !== true;
  const coverageAccess = actor.coverage
    && coverageGap
    && record.operator_available !== true
    && !mutation;
  if (
    (actor.routine && (queueAccess || assignedAccess || staleRecoveryAccess))
    || (!mutation && coverageAccess)
  ) {
    return;
  }
  throw AppError.forbidden(
    mutation
      ? 'Cath inventory reconciliation mutations require the assigned pharmacy operator'
      : 'Not authorized to view this Cath inventory reconciliation',
    'CATH_INVENTORY_RECONCILIATION_FORBIDDEN'
  );
}

function cathInventoryReconciliationView(record, actor) {
  const documentedUnits = quantityUnits(record.documented_quantity, 'documented_quantity');
  const decrementedUnits = Math.round(Number(record.decremented_quantity || 0) * QUANTITY_SCALE);
  const remainingUnits = Math.max(0, documentedUnits - decrementedUnits);
  const taskActionable = ['open', 'in_progress', 'blocked', 'overdue']
    .includes(String(record.task_status || '').toLowerCase());
  const slaActionable = !record.sla_completed_at
    && ['active', 'breached', 'escalated'].includes(
      String(record.sla_status || '').toLowerCase()
    );
  const actionable = actor.routine
    && record.inventory_decrement_status === 'insufficient_stock'
    && remainingUnits > 0
    && taskActionable
    && slaActionable;
  const effectiveSlaStatus = record.sla_completed_at
    ? 'completed'
    : String(record.sla_status || 'unknown');
  return Object.freeze({
    case_id: String(record.case_id),
    usage_id: String(record.usage_id),
    patient_uid: String(record.patient_uid),
    item_name: String(record.item_name || ''),
    catalog_item_id: String(record.catalog_item_id),
    facility_id: Number(record.facility_id),
    inventory_item_id: String(record.inventory_item_id),
    inventory_batch_id: record.inventory_batch_id == null
      ? null
      : String(record.inventory_batch_id),
    batch_number: record.batch_number || null,
    documented_quantity: quantityFromUnits(documentedUnits),
    decremented_quantity: quantityFromUnits(decrementedUnits),
    remaining_quantity: quantityFromUnits(remainingUnits),
    inventory_decrement_status: String(record.inventory_decrement_status),
    inventory_warning: String(record.inventory_warning || ''),
    task_id: String(record.task_id),
    task_status: String(record.task_status),
    workflow_sla_instance_id: String(record.workflow_sla_instance_id),
    sla_status: effectiveSlaStatus,
    sla_recorded_status: String(record.sla_status),
    due_at: record.due_at || null,
    actionable,
    coverage_gap: record.notification_payload?.coverage_gap === true
      || record.operator_available !== true,
    deep_link: cathInventoryShortfallDeepLink(record.case_id, record.usage_id),
    retry_path: cathInventoryReconciliationPath(record.case_id, record.usage_id)
  });
}

async function lockCathInventoryReconciliationClaimTx(tx, tenantId, command) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, status
       FROM idempotency_keys
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND user_uid = $3::uuid
        AND request_key = $4::text
        AND request_body_hash = $5::char(64)
        AND request_method = 'POST'
        AND request_path = $6::text
      FOR UPDATE`,
    command.claimId,
    tenantId,
    command.actor,
    command.commandKey,
    command.requestFingerprint,
    command.requestPath
  );
  if (!rows[0] || rows[0].status !== 'in_flight') {
    throw AppError.conflict(
      'Cath inventory reconciliation idempotency claim changed before execution',
      'CATH_INVENTORY_RECONCILIATION_IDEMPOTENCY_CHANGED'
    );
  }
}

async function finaliseCathInventoryReconciliationClaimTx(tx, tenantId, command, result) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE idempotency_keys
        SET status = 'complete',
            response_status = 200,
            response_body = $6::jsonb,
            expires_at = 'infinity'::timestamptz,
            updated_at = NOW()
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND user_uid = $3::uuid
        AND request_key = $4::text
        AND request_body_hash = $5::char(64)
        AND request_method = 'POST'
        AND request_path = $7::text
        AND status = 'in_flight'
      RETURNING id`,
    command.claimId,
    tenantId,
    command.actor,
    command.commandKey,
    command.requestFingerprint,
    JSON.stringify(cathInventoryReconciliationResponseBody(result, command.requestId)),
    command.requestPath
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Cath inventory reconciliation idempotency claim changed before commit',
      'CATH_INVENTORY_RECONCILIATION_IDEMPOTENCY_CHANGED'
    );
  }
}

async function recordCathReconciliationMovementTx(tx, usage, batch, {
  actorRole,
  actorAuthority,
  command,
  requestedUnits,
  takeUnits
}) {
  const quantity = quantityFromUnits(takeUnits);
  const metadata = {
    command_contract: CATH_INVENTORY_RECONCILIATION_COMMAND_CONTRACT,
    command_key_sha256: command.commandKeySha256,
    request_fingerprint: command.requestFingerprint,
    http_idempotency_claim_id: String(command.claimId),
    cath_consumable_usage_id: String(usage.usage_id),
    source_reference_type: 'cath_case_consumable_usage',
    source_reference_id: String(usage.usage_id),
    requested_quantity: quantityFromUnits(requestedUnits),
    quantity_taken: quantity,
    inventory_batch_id: String(batch.id),
    facility_id: Number(usage.facility_id),
    actor_role: actorRole,
    actor_facility_grant_id: String(actorAuthority.grant_id),
    canonical_actor_uid: actorAuthority.actor_uid,
    canonical_actor_role: actorAuthority.actor_role,
    canonical_actor_name: actorAuthority.actor_name,
    ...(command.requestId ? { request_id: command.requestId } : {})
  };
  const result = await recordMovementTx(tx, {
    tenantId: usage.tenant_id,
    inventory_item_id: Number(usage.inventory_item_id),
    inventory_batch_id: Number(batch.id),
    movement_kind: usage.wasted ? 'dispose' : 'issue',
    quantity,
    reference_type: 'cath_consumable_reconciliation',
    reference_id: command.commandKeySha256,
    performed_by: actorAuthority.actor_uid,
    notes: `Cath consumable usage #${String(usage.usage_id)} inventory reconciliation`,
    expected_facility_id: Number(usage.facility_id),
    require_usable_batch: true,
    expected_batch_number: batch.batch_number,
    expected_lot_number: batch.lot_number,
    expected_expiry_date: batch.expiry_date,
    metadata
  });
  if (!result?.movement?.id) {
    throw AppError.conflict(
      'Cath inventory reconciliation movement was not persisted',
      'CATH_INVENTORY_RECONCILIATION_MOVEMENT_MISSING'
    );
  }
  return result.movement;
}

export async function getCathConsumableInventoryReconciliation(
  caseId,
  usageId,
  { tenantId, ...context } = {}
) {
  const tid = tenantOr(tenantId);
  const normalizedCaseId = normalizeCathReconciliationId(caseId, 'case_id');
  const normalizedUsageId = normalizeCathReconciliationId(usageId, 'usage_id');
  return setTenantTx(tid, async tx => {
    const actor = await cathInventoryReconciliationActorTx(tx, tid, context);
    const record = await cathInventoryReconciliationRowTx(
      tx,
      tid,
      normalizedCaseId,
      normalizedUsageId
    );
    await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId: Number(record.facility_id),
      actorUid: actor.uid,
      actorRole: actor.role,
      forUpdate: false
    });
    assertCathInventoryReconciliationAccess(record, actor);
    return cathInventoryReconciliationView(record, actor);
  });
}

function boundedCathAssignmentRecoveryLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 25;
  return Math.max(1, Math.min(parsed, 100));
}

async function cathInventoryStaleAssignmentCandidatesTx(tx, tenantId, limit) {
  return tx.$queryRawUnsafe(
    `SELECT task.id::text AS task_id,
            usage.id::text AS usage_id,
            usage.facility_id::text AS facility_id,
            task.assigned_to_uid::text AS stale_uid
       FROM tasks task
       JOIN cath_case_consumable_usage usage
         ON usage.tenant_id = task.tenant_id
        AND usage.id::text = task.related_resource_id
        AND usage.patient_uid = task.patient_uid
        AND usage.inventory_decrement_status = 'insufficient_stock'
        AND usage.metadata->>'inventory_shortfall_contract' = $3::text
       JOIN workflow_sla_instances sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
        AND sla.rule_code = $4::text
        AND sla.source_table = 'cath_case_consumable_usage'
        AND sla.source_id = usage.id::text
        AND sla.patient_uid = usage.patient_uid
        AND sla.assigned_user_uid = task.assigned_to_uid
        AND sla.completed_at IS NULL
        AND sla.status IN ('active', 'breached', 'escalated')
      WHERE task.tenant_id = $1::uuid
        AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
        AND task.task_kind = 'review'
        AND task.sla_completion_semantics = 'domain_evidence'
        AND task.related_resource_type = 'cath_case_consumable_usage'
        AND task.related_resource_id = task.metadata->>'cath_consumable_usage_id'
        AND task.metadata->>'task_contract' = $3::text
        AND task.metadata->>'sla_key' = $4::text
        AND task.metadata->>'cath_case_id' = usage.case_id::text
        AND task.metadata->>'inventory_item_id' ~ '^[1-9][0-9]*$'
        AND task.metadata->>'facility_id' = usage.facility_id::text
        AND task.metadata->>'movement_kind' IN ('issue', 'dispose')
        AND task.assigned_to_uid IS NOT NULL
        AND task.assigned_to_role IS NULL
        AND NOT EXISTS (
           SELECT 1
             FROM users current_owner
             JOIN staff current_owner_staff
               ON current_owner_staff.tenant_id=current_owner.tenant_id
              AND current_owner_staff.user_id=current_owner.uid
              AND current_owner_staff.is_active=TRUE
              AND current_owner_staff.archived=FALSE
             JOIN pharmacy_staff_facility_grants current_grant
               ON current_grant.tenant_id=current_owner.tenant_id
              AND current_grant.staff_uid=current_owner.uid
              AND current_grant.facility_id=usage.facility_id
              AND current_grant.status='active'
              AND current_grant.revoked_at IS NULL
            WHERE current_owner.tenant_id = task.tenant_id
             AND current_owner.uid = task.assigned_to_uid
             AND current_owner.is_active = TRUE
             AND LOWER(COALESCE(current_owner.status, '')) = 'active'
             AND COALESCE(current_owner.is_deleted, FALSE) = FALSE
              AND current_owner.deleted_at IS NULL
              AND current_owner.merged_into_uid IS NULL
             AND current_owner.role = ANY($5::text[])
        )
      ORDER BY task.updated_at ASC, task.id ASC
      LIMIT $2::int`,
    tenantId,
    limit,
    CATH_INVENTORY_SHORTFALL_TASK_CONTRACT,
    CATH_INVENTORY_SHORTFALL_SLA_RULE,
    CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES
  );
}

async function nextCathInventoryRecoveryOwnerTx(tx, tenantId, facilityId, staleUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT actor.uid::text AS uid, UPPER(BTRIM(actor.role)) AS role
       FROM users actor
       JOIN staff actor_staff
         ON actor_staff.tenant_id=actor.tenant_id
        AND actor_staff.user_id=actor.uid
        AND actor_staff.is_active=TRUE
        AND actor_staff.archived=FALSE
       JOIN pharmacy_staff_facility_grants facility_grant
         ON facility_grant.tenant_id=actor.tenant_id
        AND facility_grant.staff_uid=actor.uid
        AND facility_grant.facility_id=$2::int
        AND facility_grant.status='active'
        AND facility_grant.revoked_at IS NULL
      WHERE actor.tenant_id = $1::uuid
        AND actor.uid IS DISTINCT FROM $3::uuid
        AND actor.is_active = TRUE
        AND LOWER(COALESCE(actor.status, '')) = 'active'
        AND COALESCE(actor.is_deleted, FALSE) = FALSE
        AND actor.deleted_at IS NULL
        AND actor.merged_into_uid IS NULL
        AND actor.role = ANY($4::text[])
      ORDER BY CASE UPPER(BTRIM(actor.role))
                 WHEN 'PHARMACY_INCHARGE' THEN 0
                 WHEN 'PHARMACIST' THEN 1
                 ELSE 2
               END,
               uid
      LIMIT 1
      FOR SHARE`,
    tenantId,
    Number(facilityId),
    staleUid,
    CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES
  );
  return rows[0] || null;
}

export async function sweepCathInventoryShortfallAssignments({
  tenantId,
  limit = 25
} = {}) {
  const tid = tenantOr(tenantId);
  const boundedLimit = boundedCathAssignmentRecoveryLimit(limit);
  const candidates = await setTenantTx(tid, tx => (
    cathInventoryStaleAssignmentCandidatesTx(tx, tid, boundedLimit)
  ));
  const summary = {
    tenant_id: tid,
    scanned: candidates.length,
    recovered: 0,
    coverage_gaps: 0,
    skipped: 0,
    failed: 0,
    recovered_task_ids: [],
    coverage_gap_task_ids: [],
    limit: boundedLimit
  };

  for (const candidate of candidates) {
    try {
      const outcome = await setTenantTx(tid, async tx => {
        const owner = await nextCathInventoryRecoveryOwnerTx(
          tx,
          tid,
          candidate.facility_id,
          String(candidate.stale_uid)
        );
        if (!owner) return { kind: 'coverage_gap' };
        const recoveryKey = `cath-stale-assignment:${candidate.task_id}:${candidate.stale_uid}`;
        const task = await recoverCathInventoryShortfallTaskAssignmentTx({
          tenantId: tid,
          id: candidate.task_id,
          actorUid: owner.uid,
          actorRoles: [owner.role],
          actorPrimaryRole: owner.role,
          actorRawRole: owner.role,
          idempotencyKey: recoveryKey,
          tx
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs
             (uid, role, action, resource, resource_id, metadata, tenant_id, created_at)
           VALUES
             (NULL, 'system', 'CATH_INVENTORY_SHORTFALL_ASSIGNMENT_RECOVERED',
              'task', $2::text, $3::jsonb, $1::uuid, NOW())`,
          tid,
          String(candidate.task_id),
          JSON.stringify({
            recovery_source: 'cath-inventory-shortfall-assignment-recovery.v1',
            consumable_usage_id: String(candidate.usage_id),
            previous_assigned_to_uid: String(candidate.stale_uid),
            recovered_assigned_to_uid: String(owner.uid),
            recovered_assigned_to_role: String(owner.role),
            task_status: String(task.status)
          })
        );
        return { kind: 'recovered' };
      });
      if (outcome.kind === 'coverage_gap') {
        summary.coverage_gaps += 1;
        summary.coverage_gap_task_ids.push(String(candidate.task_id));
      } else {
        summary.recovered += 1;
        summary.recovered_task_ids.push(String(candidate.task_id));
      }
    } catch (error) {
      if ([403, 404, 409].includes(Number(error?.statusCode))) {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        logger.warn('Cath inventory shortfall assignment recovery failed', {
          tenantId: tid,
          taskId: String(candidate.task_id),
          error: error?.message
        });
      }
    }
  }
  return summary;
}

export async function reconcileCathConsumableInventory(
  caseId,
  usageId,
  { tenantId, ...context } = {}
) {
  const tid = tenantOr(tenantId);
  const normalizedCaseId = normalizeCathReconciliationId(caseId, 'case_id');
  const normalizedUsageId = normalizeCathReconciliationId(usageId, 'usage_id');
  const command = normalizeCathInventoryReconciliationCommand({
    tenantId: tid,
    caseId: normalizedCaseId,
    usageId: normalizedUsageId,
    actorUid: context.actorUid,
    commandKey: context.idempotencyKey,
    requestFingerprint: context.requestFingerprint,
    httpIdempotencyClaimId: context.httpIdempotencyClaimId,
    requestId: context.requestId
  });
  return setTenantTx(tid, async tx => {
    const actor = await cathInventoryReconciliationActorTx(tx, tid, context);
    if (!actor.routine) {
      throw AppError.forbidden(
        'Only a pharmacy operator may reconcile Cath inventory',
        'CATH_INVENTORY_RECONCILIATION_PHARMACY_ROLE_REQUIRED'
      );
    }
    await lockCathInventoryReconciliationClaimTx(tx, tid, command);
    await cathInventoryReconciliationRowTx(
      tx,
      tid,
      normalizedCaseId,
      normalizedUsageId,
      { lock: true }
    );
    let record = await cathInventoryReconciliationRowTx(
      tx,
      tid,
      normalizedCaseId,
      normalizedUsageId
    );
    assertCathInventoryReconciliationAccess(record, actor, { mutation: true });
    const actorAuthority = await assertPharmacyFacilityGrant(tx, {
      tenantId: tid,
      facilityId: Number(record.facility_id),
      actorUid: actor.uid,
      actorRole: actor.role,
      forUpdate: true
    });

    if (record.inventory_decrement_status === 'decremented') {
      const reconciliation = cathInventoryReconciliationView(record, actor);
      const result = Object.freeze({ outcome: 'completed', reconciliation });
      await finaliseCathInventoryReconciliationClaimTx(tx, tid, command, result);
      return result;
    }
    if (record.inventory_decrement_status !== 'insufficient_stock') {
      throw AppError.conflict(
        'Cath consumable usage is not in an inventory-shortfall state',
        'CATH_INVENTORY_RECONCILIATION_NOT_ACTIONABLE'
      );
    }
    if (
      ['H', 'H1', 'X'].includes(String(record.schedule_class || '').toUpperCase())
      || record.is_narcotic === true
    ) {
      throw AppError.conflict(
        'Controlled stock requires the statutory dispensing workflow',
        'CATH_INVENTORY_RECONCILIATION_CONTROLLED_STOCK_FORBIDDEN'
      );
    }
    if (!record.inventory_batch_id) {
      throw AppError.conflict(
        'Legacy Cath usage has no exact facility inventory batch and cannot be auto-selected',
        'CATH_INVENTORY_RECONCILIATION_BATCH_UNRESOLVED',
        { recovery_action: 'resolve_cath_consumable_usage_authority_worklist' }
      );
    }

    if (
      record.task_assigned_to_uid
      && String(record.task_assigned_to_uid).toLowerCase() !== actor.uid.toLowerCase()
      && actor.routine
      && record.task_assignee_active !== true
    ) {
      await recoverCathInventoryShortfallTaskAssignmentTx({
        tenantId: tid,
        id: record.task_id,
        actorUid: actor.uid,
        actorRoles: [actor.role],
        actorPrimaryRole: actor.role,
        actorRawRole: actor.role,
        idempotencyKey: command.commandKey,
        tx
      });
      record = await cathInventoryReconciliationRowTx(
        tx,
        tid,
        normalizedCaseId,
        normalizedUsageId,
        { lock: true }
      );
      assertCathInventoryReconciliationAccess(record, actor, { mutation: true });
    } else if (!record.task_assigned_to_uid) {
      await claimInboxTask({
        tenantId: tid,
        id: record.task_id,
        actorUid: actor.uid,
        actorRoles: [actor.role],
        actorPrimaryRole: actor.role,
        actorRawRole: actor.role,
        idempotencyKey: command.commandKey,
        tx
      });
      record = await cathInventoryReconciliationRowTx(
        tx,
        tid,
        normalizedCaseId,
        normalizedUsageId,
        { lock: true }
      );
      assertCathInventoryReconciliationAccess(record, actor, { mutation: true });
    }

    const documentedUnits = quantityUnits(record.documented_quantity, 'documented_quantity');
    const existing = await cathMovementEvidenceTx(tx, {
      tenant_id: tid,
      id: record.usage_id
    });
    if (existing.decrementedUnits > documentedUnits) {
      throw AppError.conflict(
        'Cath consumable movements exceed the documented quantity',
        'CATH_INVENTORY_MOVEMENT_OVER_DECREMENT'
      );
    }
    const requestedUnits = documentedUnits - existing.decrementedUnits;
    let remainingUnits = requestedUnits;
    let finalMovementId = existing.finalMovementId;
    const batches = await initialCathInventoryBatchesTx(tx, {
      tenant_id: tid,
      facility_id: record.facility_id,
      inventory_item_id: record.inventory_item_id,
      inventory_batch_id: record.inventory_batch_id
    });
    if (record.inventory_batch_id && batches[0] && batchLineageMismatch(batches[0], {
      batchNumber: record.batch_number,
      lotNumber: record.lot_number,
      expiryDate: record.expiry_date
    })) {
      throw AppError.conflict(
        'Cath inventory batch lineage changed before reconciliation',
        'CATH_INVENTORY_RECONCILIATION_BATCH_LINEAGE_MISMATCH'
      );
    }
    for (const batch of batches) {
      if (remainingUnits <= 0) break;
      if (batch.is_expired || String(batch.status) !== 'in_stock') continue;
      const availableUnits = Math.max(
        0,
        Math.round(Number(batch.remaining_quantity || 0) * QUANTITY_SCALE)
      );
      const takeUnits = Math.min(remainingUnits, availableUnits);
      if (takeUnits <= 0) continue;
      const movement = await recordCathReconciliationMovementTx(tx, record, batch, {
        actorRole: actor.role,
        actorAuthority,
        command,
        requestedUnits,
        takeUnits
      });
      remainingUnits -= takeUnits;
      finalMovementId = movement.id;
    }

    const totalDecrementedUnits = documentedUnits - remainingUnits;
    if (remainingUnits > 0) {
      await updateCathInventoryOutcomeTx(tx, {
        tenant_id: tid,
        id: record.usage_id
      }, {
        status: 'insufficient_stock',
        movementId: finalMovementId,
        warning: `Insufficient stock: documented ${quantityFromUnits(documentedUnits)}, decremented ${quantityFromUnits(totalDecrementedUnits)}`
      });
    } else {
      await updateCathInventoryOutcomeTx(tx, {
        tenant_id: tid,
        id: record.usage_id
      }, {
        status: 'decremented',
        movementId: finalMovementId,
        warning: null
      });
      await completeTaskFromDomainEvidence({
        tenantId: tid,
        id: record.task_id,
        evidenceKind: 'cath_consumable_inventory_reconciled',
        evidenceResourceType: 'pharmacy_stock_movement',
        evidenceResourceId: finalMovementId,
        actorUid: actor.uid,
        tx
      });
    }

    record = await cathInventoryReconciliationRowTx(
      tx,
      tid,
      normalizedCaseId,
      normalizedUsageId,
      { lock: true }
    );
    const reconciliation = cathInventoryReconciliationView(record, actor);
    const result = Object.freeze({
      outcome: remainingUnits === 0 ? 'completed' : 'still_insufficient',
      reconciliation
    });
    await finaliseCathInventoryReconciliationClaimTx(tx, tid, command, result);
    return result;
  });
}

export async function recordConsumableUsage(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const catalogItemId = normalizeId(
    input.catalog_item_id || input.catalogItemId,
    'catalog_item_id'
  );
  const quantity = positiveNumber(input.quantity, 'quantity');
  const wasted = booleanValue(input.wasted, false);
  const wasteReason = cleanText(input.waste_reason || input.wasteReason);
  if (wasted && !wasteReason) {
    throw AppError.badRequest(
      'waste_reason is required when usage is marked wasted',
      'CATH_CONSUMABLE_WASTE_REASON_REQUIRED'
    );
  }
  const committed = await setTenantTx(tenantId, async tx => {
    const canonicalActor = await cathCanonicalActorTx(tx, tenantId, context);
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    if (cathCase.facility_id == null) {
      throw AppError.conflict(
        'Cath-lab case facility authority is unresolved',
        'CATH_LAB_CASE_FACILITY_UNRESOLVED',
        { recovery_action: 'resolve_cath_lab_case_facility_authority_worklist' }
      );
    }
    if (!canRecordConsumableForCaseStatus(cathCase.status, wasted)) {
      throw AppError.conflict(
        wasted
          ? `Wastage can only be recorded for ready, in-progress, completed, or cancelled cases (current: ${cathCase.status})`
          : `Consumable use can only be recorded for in-progress or completed cases (current: ${cathCase.status})`,
        'CATH_CONSUMABLE_CASE_STATUS_INVALID'
      );
    }
    const catalog = await catalogItemById(tx, tenantId, catalogItemId, { lock: true });
    if (catalog.status !== 'active') {
      throw AppError.badRequest(
        'Retired catalog items cannot be added to new usage',
        'CATH_CONSUMABLE_RETIRED'
      );
    }
    if (
      catalog.inventory_item_id == null
      || catalog.facility_id == null
      || Number(catalog.facility_id) !== Number(cathCase.facility_id)
      || Number(catalog.inventory_facility_id) !== Number(catalog.facility_id)
      || catalog.inventory_item_status !== 'active'
      || catalog.inventory_facility_status !== 'active'
    ) {
      throw AppError.conflict(
        'Cath consumable usage requires one exact active facility catalog and inventory mapping',
        'CATH_CONSUMABLE_FACILITY_MAPPING_UNRESOLVED',
        {
          catalog_item_id: String(catalog.id),
          recovery_action: 'resolve_cath_consumable_catalog_authority_worklist'
        }
      );
    }
    const lockedAuthority = await tx.$queryRawUnsafe(
      `SELECT item.id, item.facility_id
         FROM pharmacy_inventory_items item
         JOIN facilities facility
           ON facility.tenant_id=item.tenant_id
          AND facility.id=item.facility_id
          AND facility.status='active'
        WHERE item.tenant_id=$1::uuid
          AND item.facility_id=$2::int
          AND item.id=$3::int
          AND item.status='active'
        FOR UPDATE OF item, facility`,
      tenantId,
      Number(cathCase.facility_id),
      Number(catalog.inventory_item_id)
    );
    if (lockedAuthority.length !== 1) {
      throw AppError.conflict(
        'Cath consumable facility inventory authority changed before usage capture',
        'CATH_CONSUMABLE_FACILITY_MAPPING_CHANGED'
      );
    }
    const procedureLogIdValue = input.procedure_log_id || input.procedureLogId;
    let procedureLogId = null;
    if (procedureLogIdValue) {
      procedureLogId = normalizeId(procedureLogIdValue, 'procedure_log_id');
      const procedure = await tx.$queryRawUnsafe(
        `SELECT id
           FROM cath_procedure_logs
          WHERE tenant_id = $1::uuid
            AND case_id = $2::bigint
            AND id = $3::bigint
          LIMIT 1`,
        tenantId,
        cathCase.id,
        procedureLogId
      );
      if (!procedure.length) {
        throw AppError.badRequest(
          'procedure_log_id does not belong to this cath case',
          'CATH_CONSUMABLE_PROCEDURE_MISMATCH'
        );
      }
    }
    const inventoryBatchValue = input.inventory_batch_id || input.inventoryBatchId;
    let inventoryBatchId = null;
    let batchNumber = cleanText(input.batch_number || input.batchNumber, 120);
    let lotNumber = cleanText(input.lot_number || input.lotNumber, 120);
    let expiryDate = optionalDate(input.expiry_date || input.expiryDate, 'expiry_date');
    const inventoryDecrementStatus = 'pending';
    let inventoryWarning = 'Clinical usage recorded; exact facility pharmacy reconciliation is required';

    if (inventoryBatchValue && catalog.inventory_item_id) {
      const requestedInventoryBatchId = normalizeId(
        inventoryBatchValue,
        'inventory_batch_id'
      );
      const batches = await tx.$queryRawUnsafe(
        `SELECT id, facility_id, batch_number, lot_number, expiry_date, remaining_quantity,
                status,
                (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
           FROM pharmacy_inventory_batches
          WHERE tenant_id = $1::uuid
            AND inventory_item_id = $2::int
            AND facility_id = $3::int
            AND id = $4::int
          LIMIT 1`,
        tenantId,
        Number(catalog.inventory_item_id),
        Number(cathCase.facility_id),
        requestedInventoryBatchId
      );
      const batch = unwrap(batches);
      if (!batch) {
        throw AppError.conflict(
          'Selected inventory batch is outside the exact Cath facility and inventory mapping',
          'CATH_CONSUMABLE_BATCH_AUTHORITY_MISMATCH'
        );
      } else if (batchLineageMismatch(batch, { batchNumber, lotNumber, expiryDate })) {
        throw AppError.conflict(
          'Documented batch/lot/expiry does not match the exact selected inventory batch',
          'CATH_CONSUMABLE_BATCH_LINEAGE_MISMATCH'
        );
      } else {
        inventoryBatchId = requestedInventoryBatchId;
        batchNumber = cleanText(batch.batch_number, 120);
        lotNumber = cleanText(batch.lot_number, 120);
        expiryDate = optionalDate(batch.expiry_date, 'expiry_date');
        const outcome = evaluateCathInventoryBatch(batch, quantity);
        inventoryWarning = outcome.warning || inventoryWarning;
      }
    } else if (
      catalog.inventory_item_id
      && (catalog.batch_tracked || batchNumber || lotNumber || expiryDate)
    ) {
      if ((!batchNumber && !lotNumber) || !expiryDate) {
        if (catalog.batch_tracked) {
          throw AppError.badRequest(
            'Batch/lot number and expiry_date are required for this catalog item',
            'CATH_CONSUMABLE_BATCH_EXPIRY_REQUIRED'
          );
        }
        throw AppError.badRequest(
          'Exact batch/lot/expiry lineage is required for Cath inventory reconciliation',
          'CATH_CONSUMABLE_BATCH_AUTHORITY_REQUIRED'
        );
      } else {
        const batches = await tx.$queryRawUnsafe(
          `SELECT id, facility_id, batch_number, lot_number, expiry_date, remaining_quantity,
                  status,
                  (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
             FROM pharmacy_inventory_batches
            WHERE tenant_id = $1::uuid
              AND inventory_item_id = $2::int
              AND facility_id = $3::int
              AND expiry_date = $4::date
              AND ($5::text IS NULL OR batch_number = $5::text)
              AND ($6::text IS NULL OR lot_number = $6::text)
            ORDER BY id
            LIMIT 2`,
          tenantId,
          Number(catalog.inventory_item_id),
          Number(cathCase.facility_id),
          expiryDate,
          batchNumber,
          lotNumber
        );
        if (batches.length === 1) {
          const batch = batches[0];
          inventoryBatchId = normalizeId(batch.id, 'inventory_batch_id');
          batchNumber = cleanText(batch.batch_number, 120);
          lotNumber = cleanText(batch.lot_number, 120);
          expiryDate = optionalDate(batch.expiry_date, 'expiry_date');
          const outcome = evaluateCathInventoryBatch(batch, quantity);
          inventoryWarning = outcome.warning || inventoryWarning;
        } else {
          throw AppError.conflict(
            batches.length > 1
              ? 'Documented batch/lot/expiry matches multiple facility inventory batches'
              : 'Documented batch/lot/expiry was not found in the exact facility inventory',
            'CATH_CONSUMABLE_BATCH_AUTHORITY_UNRESOLVED'
          );
        }
      }
    } else {
      throw AppError.badRequest(
        'inventory_batch_id or exact batch/lot/expiry lineage is required for Cath inventory reconciliation',
        'CATH_CONSUMABLE_BATCH_AUTHORITY_REQUIRED'
      );
    }
    if (catalog.batch_tracked && (!batchNumber && !lotNumber || !expiryDate)) {
      throw AppError.badRequest(
        'Batch/lot number and expiry_date are required for this catalog item',
        'CATH_CONSUMABLE_BATCH_EXPIRY_REQUIRED'
      );
    }
    const serialNumber = cleanText(input.serial_number || input.serialNumber, 160);
    if (catalog.is_implant && !serialNumber) {
      throw AppError.badRequest(
        'serial_number is required for implants',
        'CATH_CONSUMABLE_IMPLANT_SERIAL_REQUIRED'
      );
    }
    const usedAt = optionalTimestamp(input.used_at || input.usedAt, 'used_at');
    const metadata = {
      ...normalizeJson(input.metadata, 'metadata', {}),
      inventory_authority: {
        facility_id: Number(cathCase.facility_id),
        catalog_item_id: String(catalog.id),
        inventory_item_id: Number(catalog.inventory_item_id),
        inventory_batch_id: Number(inventoryBatchId),
        mapping_contract: 'cath_facility_catalog_inventory_v1',
        canonical_actor_uid: canonicalActor.uid,
        canonical_actor_role: canonicalActor.role,
        canonical_actor_name: canonicalActor.name
      }
    };
    const idempotencyKey = cleanText(
      context.idempotencyKey || input.idempotency_key || input.idempotencyKey,
      200
    );
    const rows = await tx.$queryRawUnsafe(
       `INSERT INTO cath_case_consumable_usage
          (tenant_id, case_id, procedure_log_id, catalog_item_id, patient_uid,
            facility_id, inventory_item_id, inventory_batch_id,
            quantity, batch_tracked, is_implant, batch_number,
            lot_number, expiry_date, serial_number, unit_cost_snapshot, used_by,
            used_at, wasted, waste_reason, inventory_decrement_status,
            inventory_warning, metadata, idempotency_key)
         VALUES ($1::uuid, $2::bigint, $3::bigint, $4::bigint, $5::uuid,
                 $6::int, $7::int, $8::int, $9::numeric, $10, $11, $12,
                 $13, $14::date, $15, $16::numeric, $17::uuid,
                 COALESCE($18::timestamptz, NOW()), $19, $20, $21, $22,
                 $23::jsonb, $24)
       ON CONFLICT (tenant_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING *`,
      tenantId,
      cathCase.id,
      procedureLogId,
      catalog.id,
      cathCase.patient_uid,
      Number(cathCase.facility_id),
      Number(catalog.inventory_item_id),
      inventoryBatchId,
      quantity,
      catalog.batch_tracked,
      catalog.is_implant,
      batchNumber,
      lotNumber,
      expiryDate,
      serialNumber,
      catalog.default_unit_cost_reference,
      canonicalActor.uid,
      usedAt,
      wasted,
      wasteReason,
      inventoryDecrementStatus,
      inventoryWarning,
      JSON.stringify(metadata),
      idempotencyKey
    );
    const usage = unwrap(rows);
    if (!usage) {
      const replayRows = await tx.$queryRawUnsafe(
        `SELECT id, case_id
           FROM cath_case_consumable_usage
          WHERE tenant_id = $1::uuid
            AND idempotency_key = $2
          LIMIT 1`,
        tenantId,
        idempotencyKey
      );
      const replay = unwrap(replayRows);
      if (!replay || String(replay.case_id) !== String(cathCase.id)) {
        throw AppError.conflict(
          'Cath consumable usage could not be recorded idempotently',
          'CATH_CONSUMABLE_IDEMPOTENCY_CONFLICT'
        );
      }
      return {
        usage: await consumableUsageById(tx, tenantId, replay.id),
        caseStatus: cathCase.status,
        replayed: true
      };
    }
    const normalizedUsage = normalizeDbValue(usage);
    if (catalog.is_implant && !wasted) {
      await tx.$queryRawUnsafe(
        `INSERT INTO surgical_implants
           (tenant_id, ot_schedule_id, cath_case_id, cath_usage_id, patient_uid,
            implant_type, manufacturer, product_name, reference_number,
            lot_number, serial_number, expiry_date, implanted_by, implanted_at,
            status, notes, metadata)
         VALUES ($1::uuid, NULL, $2::bigint, $3::bigint, $4::uuid,
                 $5, $6, $7, $8,
                 $9, $10, $11::date, $12::uuid, $13::timestamptz,
                 'in_situ', $14, $15::jsonb)`,
        tenantId,
        cathCase.id,
        usage.id,
        cathCase.patient_uid,
        catalog.category,
        catalog.manufacturer,
        catalog.item_name,
        catalog.model,
        lotNumber || batchNumber,
        serialNumber,
        expiryDate,
        canonicalActor.uid,
        usage.used_at,
        wasted ? `Opened but not used: ${wasteReason}` : 'Recorded from cath consumable usage',
        JSON.stringify({ cath_usage_id: String(usage.id), source: 'nl13_p1d' })
      );
    }
    const event = requireCanonicalEvent(await writeCanonicalEvent(tx, {
      tenantId,
      patientUid: cathCase.patient_uid,
      encounterId: cathCase.encounter_id,
      eventType: wasted ? 'cath_lab.consumable_wasted' : 'cath_lab.consumable_used',
      eventStatus: wasted ? 'wasted' : 'recorded',
      sourceTable: 'cath_case_consumable_usage',
      sourceId: normalizedUsage.id,
      actorUid: canonicalActor.uid,
      actorRole: canonicalActor.role,
      summary: `${wasted ? 'Cath consumable wasted' : 'Cath consumable recorded'}: ${catalog.item_name}`,
      payload: {
        case_id: normalizeDbValue(cathCase.id),
        procedure_log_id: procedureLogId,
        catalog_item_id: catalog.id,
        facility_id: Number(cathCase.facility_id),
        inventory_item_id: Number(catalog.inventory_item_id),
        inventory_batch_id: Number(inventoryBatchId),
        item_name: catalog.item_name,
        category: catalog.category,
        quantity,
        batch_number: batchNumber,
        lot_number: lotNumber,
        expiry_date: expiryDate,
        serial_number: serialNumber,
        wasted,
        waste_reason: wasteReason
      },
      afterState: normalizedUsage
    }));
    await tx.$queryRawUnsafe(
      `UPDATE cath_case_consumable_usage
          SET timeline_event_id = $3::uuid,
              audit_event_id = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      usage.id,
      event?.timeline?.id || null,
      event?.audit?.id || null
    );
    await materializeCathInventoryShortfallTx(tx, {
      ...normalizedUsage,
      encounter_id: cathCase.encounter_id,
      facility_id: Number(cathCase.facility_id),
      inventory_item_id: Number(catalog.inventory_item_id)
    }, {
      decrementedUnits: 0,
      finalMovementId: null,
      warning: inventoryWarning
    });
    return {
      usage: await consumableUsageById(tx, tenantId, usage.id),
      caseStatus: cathCase.status
    };
  });
  if (committed.replayed) {
    const billingHook = committed.caseStatus === 'completed'
      ? await maybeEmitCathBillingLines({ tenantId, caseId, actorUid: context.actorUid || null })
      : null;
    return billingHook
      ? { ...committed.usage, idempotent_replay: true, billing_hook: billingHook }
      : { ...committed.usage, idempotent_replay: true };
  }
  const billingHook = committed.caseStatus === 'completed'
    ? await maybeEmitCathBillingLines({ tenantId, caseId, actorUid: context.actorUid || null })
    : null;
  return billingHook ? { ...committed.usage, billing_hook: billingHook } : committed.usage;
}

export async function getCathConsumablesBillingSettings({ tenantId, db = prisma } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT tenant_id, charge_enabled, procedure_billing_code,
            procedure_unit_price, gst_rate, finance_reviewed_at,
            finance_reviewed_by, acceptance_snapshot, created_at, updated_at
       FROM cath_consumables_billing_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    tenantOr(tenantId)
  );
  return normalizeDbValue(unwrap(rows) || {
    tenant_id: tenantOr(tenantId),
    charge_enabled: false,
    procedure_billing_code: null,
    procedure_unit_price: null,
    gst_rate: 0,
    finance_reviewed_at: null,
    finance_reviewed_by: null,
    acceptance_snapshot: null
  });
}

export async function upsertCathConsumablesBillingSettings(input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const existing = await getCathConsumablesBillingSettings({ tenantId });
  const chargeEnabled = booleanValue(
    input.charge_enabled ?? input.chargeEnabled,
    existing.charge_enabled
  );
  const procedureCodeInput = providedInput(
    input,
    'procedure_billing_code',
    'procedureBillingCode'
  );
  const procedureCode = procedureCodeInput.provided
    ? cleanText(procedureCodeInput.value, 50)
    : existing.procedure_billing_code;
  const procedurePriceInput = providedInput(
    input,
    'procedure_unit_price',
    'procedureUnitPrice'
  );
  const procedurePrice = procedurePriceInput.provided
    ? optionalNumber(procedurePriceInput.value, 'procedure_unit_price')
    : existing.procedure_unit_price;
  if ((procedureCode === null) !== (procedurePrice === null)) {
    throw AppError.badRequest(
      'Procedure billing code and unit price must be mapped together',
      'CATH_BILLING_PROCEDURE_MAPPING_INCOMPLETE'
    );
  }
  const gstValue = input.gst_rate ?? input.gstRate;
  const gstRate = gstValue === undefined
    ? Number(existing.gst_rate || 0)
    : optionalNumber(gstValue, 'gst_rate');
  if (gstRate > 28) {
    throw AppError.badRequest('gst_rate must not exceed 28', 'CATH_BILLING_GST_INVALID');
  }
  const actorUid = maybeUuid(context.actorUid, 'actorUid');
  const reviewedAt = chargeEnabled
    ? (optionalTimestamp(
        input.finance_reviewed_at || input.financeReviewedAt,
        'finance_reviewed_at'
      ) || existing.finance_reviewed_at || new Date().toISOString())
    : null;
  const acceptanceSnapshot = normalizeJson(
    input.acceptance_snapshot || input.acceptanceSnapshot,
    'acceptance_snapshot',
    {
      owner_action: chargeEnabled ? 'enabled' : 'disabled',
      procedure_billing_code: procedureCode,
      procedure_unit_price: procedurePrice,
      reviewed_by: actorUid
    }
  );
  return setTenantTx(tenantId, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_consumables_billing_settings
         (tenant_id, charge_enabled, procedure_billing_code,
          procedure_unit_price, gst_rate, finance_reviewed_at,
          finance_reviewed_by, acceptance_snapshot)
       VALUES ($1::uuid, $2, $3, $4::numeric, $5::numeric,
               $6::timestamptz, $7::uuid, $8::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET
          charge_enabled = EXCLUDED.charge_enabled,
          procedure_billing_code = EXCLUDED.procedure_billing_code,
          procedure_unit_price = EXCLUDED.procedure_unit_price,
          gst_rate = EXCLUDED.gst_rate,
          finance_reviewed_at = EXCLUDED.finance_reviewed_at,
          finance_reviewed_by = EXCLUDED.finance_reviewed_by,
          acceptance_snapshot = EXCLUDED.acceptance_snapshot,
          updated_at = NOW()
       RETURNING tenant_id, charge_enabled, procedure_billing_code,
                 procedure_unit_price, gst_rate, finance_reviewed_at,
                 finance_reviewed_by, acceptance_snapshot, created_at, updated_at`,
      tenantId,
      chargeEnabled,
      procedureCode,
      procedurePrice,
      gstRate,
      reviewedAt,
      chargeEnabled ? actorUid : null,
      JSON.stringify(acceptanceSnapshot)
    );
    return normalizeDbValue(rows[0]);
  });
}

async function cathBillingContext(tenantId, caseId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.patient_uid, c.encounter_id, c.requested_procedure,
            c.status AS case_status, u.name AS patient_name, u.phone AS patient_phone,
            e.encounter_type, e.admission_id,
            p.id AS procedure_log_id, p.procedure_type, p.status AS procedure_status
       FROM cath_lab_cases c
       JOIN users u
         ON u.uid = c.patient_uid
        AND u.tenant_id = c.tenant_id
       LEFT JOIN patient_encounters e
         ON e.id = c.encounter_id
        AND e.tenant_id = c.tenant_id
       LEFT JOIN LATERAL (
         SELECT cp.id, cp.procedure_type, cp.status
           FROM cath_procedure_logs cp
          WHERE cp.tenant_id = c.tenant_id
            AND cp.case_id = c.id
            AND cp.status IN ('finalized', 'amended')
          ORDER BY cp.created_at DESC, cp.id DESC
          LIMIT 1
       ) p ON TRUE
      WHERE c.tenant_id = $1::uuid
        AND c.id = $2::bigint
      LIMIT 1`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const context = unwrap(rows);
  if (!context) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return context;
}

async function findOrCreateCathDraftInvoice(context, tenantId, actorUid) {
  const tid = tenantOr(tenantId);
  return setTenantTx(tid, async tx => {
    const lockedPatients = await tx.$queryRawUnsafe(
      `SELECT uid
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
        FOR UPDATE`,
      tid,
      context.patient_uid
    );
    if (!lockedPatients.length) {
      throw AppError.notFound('Cath-lab patient not found', 'CATH_LAB_PATIENT_NOT_FOUND');
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT id
         FROM billing_invoices
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND department = 'Cath Lab'
          AND status = 'DRAFT'
          AND admission_id IS NOT DISTINCT FROM $3::int
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      tid,
      context.patient_uid,
      context.admission_id || null
    );
    if (rows.length) return rows[0];
    return createDraftInvoice({
      tenantId: tid,
      patient_uid: context.patient_uid,
      patient_name: context.patient_name || null,
      patient_phone: context.patient_phone || null,
      admission_id: context.admission_id || null,
      department: 'Cath Lab',
      invoice_type: context.admission_id ? 'IP' : 'OP',
      notes: 'Auto-created by cath completion hook; draft only until finance issues invoice.',
      created_by: actorUid
    }, { db: tx });
  });
}

export async function maybeEmitCathBillingLines({ tenantId, caseId, actorUid = null } = {}) {
  const tid = tenantOr(tenantId);
  const settings = await getCathConsumablesBillingSettings({ tenantId: tid });
  if (!settings.charge_enabled) return { status: 'disabled', emitted: 0, unmapped: 0 };
  if (!settings.finance_reviewed_at) {
    return { status: 'finance_review_required', emitted: 0, unmapped: 0 };
  }
  const context = await cathBillingContext(tid, caseId);
  if (context.case_status !== 'completed' || !context.procedure_log_id) {
    return { status: 'procedure_not_completed', emitted: 0, unmapped: 0 };
  }
  try {
    const procedureMappingConfigured = Boolean(
      settings.procedure_billing_code && settings.procedure_unit_price != null
    );
    const procedureCodeRows = procedureMappingConfigured
      ? await prisma.$queryRawUnsafe(
          `SELECT id
             FROM billing_service_master
            WHERE tenant_id = $1::uuid
              AND code = $2
              AND is_active = TRUE
            LIMIT 1`,
          tid,
          settings.procedure_billing_code
        )
      : [];
    const procedureMappingActive = procedureCodeRows.length > 0;
    const invoice = await findOrCreateCathDraftInvoice(context, tid, actorUid);
    const procedureSourceId = sourceReferenceId(context.procedure_log_id, 'procedure_log_id');
    const existingRows = await prisma.$queryRawUnsafe(
      `SELECT id, source_ref_type, source_ref_id
       FROM billing_invoice_items
        WHERE tenant_id = $2::uuid
          AND source_ref_active = TRUE
          AND source_ref_type IN ('cath_procedure_log', 'cath_consumable_usage')
          AND (
            (source_ref_type = 'cath_procedure_log' AND source_ref_id = $1::bigint)
            OR (
              source_ref_type = 'cath_consumable_usage'
              AND source_ref_id IN (
                SELECT id
                  FROM cath_case_consumable_usage
                 WHERE tenant_id = $2::uuid AND case_id = $3::bigint
              )
            )
          )`,
      procedureSourceId,
      tid,
      normalizeId(context.id, 'case_id')
    );
    const existing = new Set(
      existingRows.map(row => `${row.source_ref_type}:${String(row.source_ref_id)}`)
    );
    const emitted = [];
    const unmapped = [];
    const failed = [];
    const procedureKey = `cath_procedure_log:${String(procedureSourceId)}`;
    if (procedureMappingConfigured && procedureMappingActive) {
      if (!existing.has(procedureKey)) {
        try {
          const line = await addInvoiceItem(invoice.id, {
            tenantId: tid,
            service_code: settings.procedure_billing_code,
            description: `Cath procedure: ${context.procedure_type || context.requested_procedure}`,
            category: 'procedure',
            quantity: 1,
            unit_price: Number(settings.procedure_unit_price),
            gst_rate: Number(settings.gst_rate || 0),
            notes: 'Finance-reviewed cath procedure package emitted on case completion.',
            source_ref_type: 'cath_procedure_log',
            source_ref_id: procedureSourceId
          });
          emitted.push({ type: 'procedure', source_id: procedureSourceId, line_id: line.id });
        } catch (err) {
          failed.push({ type: 'procedure', source_id: procedureSourceId });
          logger.error('Cath procedure billing line failed', {
            tenantId: tid,
            caseId: context.id,
            procedureLogId: context.procedure_log_id,
            error: err?.message
          });
        }
      }
    } else {
      unmapped.push({
        type: 'procedure',
        source_id: procedureSourceId,
        reason: procedureMappingConfigured ? 'billing_code_invalid' : 'billing_code_not_mapped'
      });
    }
    const usageRows = await prisma.$queryRawUnsafe(
      `SELECT u.id, u.quantity, u.wasted, u.is_implant,
              c.item_name, c.billing_item_code,
              bsm.id AS billing_service_id
         FROM cath_case_consumable_usage u
         JOIN cath_consumable_catalog c
           ON c.id = u.catalog_item_id
          AND c.tenant_id = u.tenant_id
         LEFT JOIN billing_service_master bsm
           ON bsm.tenant_id = u.tenant_id
          AND bsm.code = c.billing_item_code
          AND bsm.is_active = TRUE
        WHERE u.tenant_id = $1::uuid
          AND u.case_id = $2::bigint
        ORDER BY u.id`,
      tid,
      normalizeId(context.id, 'case_id')
    );
    for (const usage of usageRows) {
      const sourceId = sourceReferenceId(usage.id, 'usage_id');
      const key = `cath_consumable_usage:${String(sourceId)}`;
      if (existing.has(key)) continue;
      if (usage.wasted || !usage.billing_item_code || !usage.billing_service_id) {
        unmapped.push({
          type: 'consumable',
          source_id: sourceId,
          reason: usage.wasted
            ? 'wastage_review_required'
            : (usage.billing_item_code ? 'billing_code_invalid' : 'billing_code_not_mapped')
        });
        continue;
      }
      try {
        const line = await addInvoiceItem(invoice.id, {
          tenantId: tid,
          service_code: usage.billing_item_code,
          description: usage.item_name,
          category: usage.is_implant ? 'implants' : 'procedure',
          quantity: Number(usage.quantity),
          // Inventory cost references are not patient tariffs. The active,
          // tenant-scoped billing master remains authoritative for price.
          unit_price: null,
          gst_rate: null,
          notes: 'Cath consumable emitted from documented per-case usage.',
          source_ref_type: 'cath_consumable_usage',
          source_ref_id: sourceId
        });
        emitted.push({ type: 'consumable', source_id: sourceId, line_id: line.id });
      } catch (err) {
        failed.push({ type: 'consumable', source_id: sourceId });
        logger.error('Cath consumable billing line failed', {
          tenantId: tid,
          caseId: context.id,
          usageId: sourceId,
          error: err?.message
        });
      }
    }
    return {
      status: failed.length ? 'partial' : 'emitted',
      invoice_id: invoice.id,
      emitted: emitted.length,
      unmapped: unmapped.length,
      failed: failed.length,
      emitted_lines: emitted,
      unmapped_items: unmapped,
      failed_items: failed
    };
  } catch (err) {
    logger.error('Cath billing hook failed', {
      tenantId: tid,
      caseId,
      error: err?.message
    });
    return {
      status: 'error',
      emitted: 0,
      unmapped: 0,
      message: 'Billing hook failed; unbilled usage review required'
    };
  }
}

export async function listUnbilledConsumableUsage({
  tenantId,
  date_from = null,
  date_to = null,
  category = null,
  case_id = null,
  page = 1,
  limit = 50,
  db = prisma
} = {}) {
  const tid = tenantOr(tenantId);
  const params = [tid];
  const clauses = [
    'u.tenant_id = $1::uuid',
    'bii.id IS NULL'
  ];
  if (date_from) {
    params.push(optionalDate(date_from, 'date_from'));
    clauses.push(`DATE(u.used_at AT TIME ZONE 'Asia/Kolkata') >= $${params.length}::date`);
  }
  if (date_to) {
    params.push(optionalDate(date_to, 'date_to'));
    clauses.push(`DATE(u.used_at AT TIME ZONE 'Asia/Kolkata') <= $${params.length}::date`);
  }
  if (category) {
    params.push(normalizeStatus(category, CATH_CONSUMABLE_CATEGORIES, 'category'));
    clauses.push(`c.category = $${params.length}`);
  }
  if (case_id) {
    params.push(normalizeId(case_id, 'case_id'));
    clauses.push(`u.case_id = $${params.length}::bigint`);
  }
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
  const fromAndWhere = `
       FROM cath_case_consumable_usage u
       JOIN cath_consumable_catalog c
         ON c.id = u.catalog_item_id
        AND c.tenant_id = u.tenant_id
       JOIN cath_lab_cases cath_case
         ON cath_case.id = u.case_id
        AND cath_case.tenant_id = u.tenant_id
       JOIN users patient
         ON patient.uid = u.patient_uid
        AND patient.tenant_id = u.tenant_id
       LEFT JOIN cath_consumables_billing_settings settings
         ON settings.tenant_id = u.tenant_id
       LEFT JOIN billing_service_master bsm
         ON bsm.tenant_id = u.tenant_id
        AND bsm.code = c.billing_item_code
        AND bsm.is_active = TRUE
        LEFT JOIN billing_invoice_items bii
          ON bii.source_ref_type = 'cath_consumable_usage'
         AND bii.source_ref_id = u.id
         AND bii.tenant_id = u.tenant_id
         AND bii.source_ref_active = TRUE
      WHERE ${clauses.join(' AND ')}`;
  const countRows = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total ${fromAndWhere}`,
    ...params
  );
  const total = Number(countRows[0]?.total || 0);
  const offset = (safePage - 1) * safeLimit;
  const listParams = [...params, safeLimit, offset];
  const rows = await db.$queryRawUnsafe(
    `SELECT u.id AS usage_id, u.case_id, u.procedure_log_id, u.patient_uid,
            patient.name AS patient_name, c.item_name, c.category,
            u.quantity, u.wasted, u.waste_reason, u.used_at,
            c.billing_item_code, u.inventory_decrement_status,
            CASE
              WHEN cath_case.status <> 'completed' THEN 'procedure_not_completed'
              WHEN u.wasted THEN 'wastage_review_required'
              WHEN c.billing_item_code IS NULL THEN 'billing_code_not_mapped'
              WHEN bsm.id IS NULL THEN 'billing_code_invalid'
              WHEN COALESCE(settings.charge_enabled, FALSE) = FALSE THEN 'billing_disabled'
              ELSE 'billing_pending_or_failed'
            END AS billing_gap_reason
      ${fromAndWhere}
      ORDER BY u.used_at DESC, u.id DESC
      LIMIT $${params.length + 1}::int
     OFFSET $${params.length + 2}::int`,
    ...listParams
  );
  return {
    items: normalizeRows(rows),
    count: rows.length,
    total,
    page: safePage,
    limit: safeLimit
  };
}

export const __testing__ = {
  canRecordConsumableForCaseStatus,
  normalizeId,
  normalizeDbValue,
  cathInventoryReconciliationRequestFingerprint,
  normalizeCathInventoryReconciliationCommand,
  cathInventoryReconciliationView,
  optionalDate,
  batchLineageMismatch,
  evaluateCathInventoryBatch,
  requireCanonicalEvent
};

export default {
  createCase,
  listCases,
  getCase,
  updateReadinessCheck,
  transitionCaseStatus,
  recordProcedureLog,
  addHemodynamicSummary,
  addContrastRadiationRecord,
  addPostProcedureOrder,
  addDeviceLink,
  listConsumableCatalog,
  upsertConsumableCatalogItem,
  resolveCathConsumableAuthorityRecovery,
  listCatalogBatches,
  listCaseConsumableUsage,
  recordConsumableUsage,
  getCathConsumableInventoryReconciliation,
  sweepCathInventoryShortfallAssignments,
  reconcileCathConsumableInventory,
  getCathConsumablesBillingSettings,
  upsertCathConsumablesBillingSettings,
  maybeEmitCathBillingLines,
  listUnbilledConsumableUsage
};
