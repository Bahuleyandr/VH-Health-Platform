// Device payloads stay with NL-7; cath-lab stores only case-scoped links.

import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { addInvoiceItem, createDraftInvoice } from '../billing/billingV2Service.js';
import { recordMovementTx } from '../pharmacy/inventoryV2Service.js';
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
    `SELECT id, tenant_id, patient_uid, encounter_id, requested_procedure,
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
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases
         (tenant_id, patient_uid, encounter_id, appointment_id, requested_procedure,
          indication, urgency, lab_room, status, planned_start_at, planned_end_at,
          team, sla_rule_code, created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5,
               $6, $7, $8, $9, $10::timestamptz, $11::timestamptz,
               $12::jsonb, $13, $14::uuid, $14::uuid, $15::jsonb)
       RETURNING *`,
      tenantId,
      patientUid,
      maybeUuid(input.encounter_id || input.encounterId, 'encounter_id'),
      input.appointment_id ? normalizeId(input.appointment_id, 'appointment_id') : null,
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
            metadata: { requested_procedure: requestedProcedure, urgency }
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
            c.encounter_id, c.appointment_id, c.requested_procedure, c.indication,
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
  c.id, c.tenant_id, c.inventory_item_id, c.item_name, c.category,
  c.manufacturer, c.model, c.is_implant, c.batch_tracked,
  c.default_unit_cost_reference, c.billing_item_code, c.status,
  c.retired_at, c.created_by, c.updated_by, c.created_at, c.updated_at,
  c.metadata, i.sku_code AS inventory_sku, i.display_name AS inventory_item_name,
  i.unit_label AS inventory_unit_label`;

async function catalogItemById(db, tenantId, catalogItemId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${CATH_CONSUMABLE_CATALOG_SELECT}
       FROM cath_consumable_catalog c
       LEFT JOIN pharmacy_inventory_items i
         ON i.id = c.inventory_item_id
        AND i.tenant_id = c.tenant_id
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
  limit = 100,
  db = prisma
} = {}) {
  const tid = tenantOr(tenantId);
  const params = [tid];
  const clauses = ['c.tenant_id = $1::uuid'];
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
      && inventoryItemId !== existingInventoryItemId
    ) {
      const usage = await tx.$queryRawUnsafe(
        `SELECT 1
           FROM cath_case_consumable_usage
          WHERE tenant_id = $1::uuid
            AND catalog_item_id = $2::bigint
          LIMIT 1`,
        tenantId,
        existing.id
      );
      if (usage.length) {
        throw AppError.conflict(
          'Inventory link cannot be changed after cath usage has been recorded; retire this item and create a new catalog entry',
          'CATH_CONSUMABLE_INVENTORY_LINK_IMMUTABLE'
        );
      }
    }
    if (inventoryItemId) {
      const inventory = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id
           FROM pharmacy_inventory_items
          WHERE id = $1::int
            AND tenant_id = $2::uuid
          LIMIT 1`,
        inventoryItemId,
        tenantId
      );
      if (!inventory.length) {
        throw AppError.badRequest(
          'Linked inventory item was not found in this tenant',
          'CATH_CONSUMABLE_INVENTORY_ITEM_INVALID'
        );
      }
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
    const actorUid = maybeUuid(context.actorUid, 'actorUid');
    let savedId;
    if (existing) {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE cath_consumable_catalog
            SET inventory_item_id = $3::int,
                item_name = $4,
                category = $5,
                manufacturer = $6,
                model = $7,
                is_implant = $8,
                batch_tracked = $9,
                default_unit_cost_reference = $10::numeric,
                billing_item_code = $11,
                status = $12::varchar(20),
                retired_at = CASE
                  WHEN $12::varchar(20) = 'retired' THEN COALESCE(retired_at, NOW())
                  ELSE NULL
                END,
                updated_by = $13::uuid,
                updated_at = NOW(),
                metadata = $14::jsonb
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
        RETURNING id`,
        tenantId,
        existing.id,
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
        actorUid,
        JSON.stringify(metadata)
      );
      savedId = rows[0].id;
    } else {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO cath_consumable_catalog
           (tenant_id, inventory_item_id, item_name, category, manufacturer, model,
            is_implant, batch_tracked, default_unit_cost_reference, billing_item_code,
            status, retired_at, created_by, updated_by, metadata)
         VALUES ($1::uuid, $2::int, $3, $4, $5, $6,
                 $7, $8, $9::numeric, $10, $11::varchar(20),
                 CASE WHEN $11::varchar(20) = 'retired' THEN NOW() ELSE NULL END,
                 $12::uuid, $12::uuid, $13::jsonb)
         RETURNING id`,
        tenantId,
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
        actorUid,
        JSON.stringify(metadata)
      );
      savedId = rows[0].id;
    }
    return catalogItemById(tx, tenantId, savedId);
  });
}

export async function listCatalogBatches(catalogItemId, { tenantId, db = prisma } = {}) {
  const item = await catalogItemById(db, tenantId, catalogItemId);
  if (!item.inventory_item_id) return [];
  const rows = await db.$queryRawUnsafe(
    `SELECT b.id, b.inventory_item_id, b.batch_number, b.lot_number,
            b.expiry_date, b.remaining_quantity, b.status,
            b.unit_cost_minor, b.mrp_minor
       FROM pharmacy_inventory_batches b
      WHERE b.tenant_id = $1::uuid
        AND b.inventory_item_id = $2::int
        AND b.status = 'in_stock'
        AND b.remaining_quantity > 0
        AND b.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY b.expiry_date, b.id`,
    tenantOr(tenantId),
    Number(item.inventory_item_id)
  );
  return normalizeRows(rows);
}

const CATH_CONSUMABLE_USAGE_SELECT = `
  u.id, u.tenant_id, u.case_id, u.procedure_log_id, u.catalog_item_id,
  u.patient_uid, u.inventory_batch_id, u.quantity, u.batch_tracked,
  u.is_implant, u.batch_number, u.lot_number, u.expiry_date,
  u.serial_number, u.unit_cost_snapshot, u.used_by, u.used_at,
  u.wasted, u.waste_reason, u.inventory_decrement_status,
  u.inventory_movement_id, u.inventory_warning, u.timeline_event_id,
  u.audit_event_id, u.idempotency_key, u.created_at, u.updated_at, u.metadata,
  c.item_name, c.category, c.manufacturer, c.model, c.billing_item_code,
  c.inventory_item_id, i.sku_code AS inventory_sku,
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
         ON i.id = c.inventory_item_id
        AND i.tenant_id = c.tenant_id
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
         ON i.id = c.inventory_item_id
        AND i.tenant_id = c.tenant_id
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

async function cathUsageInventoryRowTx(tx, tenantId, usageId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT usage.id, usage.tenant_id, usage.case_id, usage.patient_uid,
            usage.catalog_item_id, usage.inventory_batch_id, usage.quantity,
            usage.batch_tracked, usage.batch_number, usage.lot_number,
            usage.expiry_date, usage.wasted, usage.waste_reason, usage.used_by,
            usage.inventory_decrement_status, usage.inventory_movement_id,
            usage.inventory_warning, usage.metadata,
            catalog.item_name, catalog.inventory_item_id,
            cath_case.encounter_id,
            inventory_item.schedule_class, inventory_item.is_narcotic
       FROM cath_case_consumable_usage usage
       JOIN cath_consumable_catalog catalog
         ON catalog.tenant_id = usage.tenant_id
        AND catalog.id = usage.catalog_item_id
       JOIN cath_lab_cases cath_case
         ON cath_case.tenant_id = usage.tenant_id
        AND cath_case.id = usage.case_id
        AND cath_case.patient_uid = usage.patient_uid
       LEFT JOIN pharmacy_inventory_items inventory_item
         ON inventory_item.tenant_id = usage.tenant_id
        AND inventory_item.id = catalog.inventory_item_id
      WHERE usage.tenant_id = $1::uuid
        AND usage.id = $2::bigint
      LIMIT 1
      FOR UPDATE OF usage`,
    tenantId,
    normalizeId(usageId, 'usage_id')
  );
  if (!rows[0]) {
    throw AppError.notFound('Cath consumable usage not found', 'CATH_CONSUMABLE_USAGE_NOT_FOUND');
  }
  return normalizeDbValue(rows[0]);
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

async function cathShortfallNotificationRecipientTx(tx, tenantId) {
  const routine = await tx.$queryRawUnsafe(
    `SELECT id, uid, phone, preferred_language, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND is_active = TRUE
        AND status = 'active'
        AND COALESCE(is_deleted, FALSE) = FALSE
        AND role = ANY($2::text[])
      ORDER BY CASE role
                 WHEN 'PHARMACIST' THEN 0
                 WHEN 'PHARMACY_INCHARGE' THEN 1
                 ELSE 2
               END,
               last_sign_in_at DESC NULLS LAST,
               id
      LIMIT 1`,
    tenantId,
    CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES
  );
  if (routine[0]) return { ...routine[0], coverageGap: false, deliveryCoverage: 'direct' };
  const coverage = await tx.$queryRawUnsafe(
    `SELECT id, uid, phone, preferred_language, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND is_active = TRUE
        AND status = 'active'
        AND COALESCE(is_deleted, FALSE) = FALSE
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
      inventory_shortfall_intended_role_codes: intendedRoleCodes
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
      inventory_item_id: String(usage.inventory_item_id)
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
  const recipient = await cathShortfallNotificationRecipientTx(tx, usage.tenant_id);
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
      deep_link: deepLink,
      retry_path: retryPath,
      action_label_key: CATH_INVENTORY_SHORTFALL_ACTION_LABEL_KEY,
      coverage_gap: recipient.coverageGap,
      delivery_coverage: recipient.deliveryCoverage,
      intended_role_codes: intendedRoleCodes,
      recipient_uid: recipient.uid,
      recipient_role: recipient.role,
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
  if (usage.inventory_batch_id) {
    return tx.$queryRawUnsafe(
      `SELECT id, inventory_item_id, batch_number, lot_number, expiry_date,
              remaining_quantity, status,
              (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid
          AND inventory_item_id = $2::int
          AND id = $3::int
        LIMIT 1
        FOR UPDATE`,
      usage.tenant_id,
      Number(usage.inventory_item_id),
      Number(usage.inventory_batch_id)
    );
  }
  return tx.$queryRawUnsafe(
    `SELECT id, inventory_item_id, batch_number, lot_number, expiry_date,
            remaining_quantity, status, FALSE AS is_expired
       FROM pharmacy_inventory_batches
      WHERE tenant_id = $1::uuid
        AND inventory_item_id = $2::int
        AND status = 'in_stock'
        AND remaining_quantity > 0
        AND expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY expiry_date, id
      FOR UPDATE`,
    usage.tenant_id,
    Number(usage.inventory_item_id)
  );
}

async function applyConsumableInventoryDecrement(usage) {
  const tenantId = tenantOr(usage.tenant_id);
  return setTenantTx(tenantId, async tx => {
    const current = await cathUsageInventoryRowTx(tx, tenantId, usage.id);
    if (current.inventory_decrement_status !== 'pending') {
      return consumableUsageById(tx, tenantId, current.id);
    }
    if (!current.inventory_item_id) {
      await updateCathInventoryOutcomeTx(tx, current, { status: 'not_linked' });
      return consumableUsageById(tx, tenantId, current.id);
    }
    const lockedInventoryItems = await tx.$queryRawUnsafe(
      `SELECT schedule_class, is_narcotic
         FROM pharmacy_inventory_items
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1
        FOR UPDATE`,
      tenantId,
      Number(current.inventory_item_id)
    );
    if (!lockedInventoryItems[0]) {
      throw AppError.conflict(
        'Cath consumable inventory item changed before decrement',
        'CATH_INVENTORY_ITEM_CHANGED'
      );
    }
    current.schedule_class = lockedInventoryItems[0].schedule_class;
    current.is_narcotic = lockedInventoryItems[0].is_narcotic;
    if (current.batch_tracked && !current.inventory_batch_id) {
      await updateCathInventoryOutcomeTx(tx, current, {
        status: 'error',
        warning: current.inventory_warning
          || 'Exact inventory batch could not be resolved; clinical usage was saved without a stock decrement'
      });
      return consumableUsageById(tx, tenantId, current.id);
    }
    if (
      ['H', 'H1', 'X'].includes(String(current.schedule_class || '').toUpperCase())
      || current.is_narcotic === true
    ) {
      await updateCathInventoryOutcomeTx(tx, current, {
        status: 'error',
        warning: 'Controlled stock requires the statutory dispensing workflow; no Cath inventory movement was recorded'
      });
      return consumableUsageById(tx, tenantId, current.id);
    }
    const documentedUnits = quantityUnits(current.quantity);
    const existing = await cathMovementEvidenceTx(tx, current);
    if (existing.decrementedUnits > documentedUnits) {
      throw AppError.conflict(
        'Cath consumable movements exceed the documented quantity',
        'CATH_INVENTORY_MOVEMENT_OVER_DECREMENT'
      );
    }
    if (existing.decrementedUnits === documentedUnits) {
      await updateCathInventoryOutcomeTx(tx, current, {
        status: 'decremented',
        movementId: existing.finalMovementId,
        warning: null
      });
      return consumableUsageById(tx, tenantId, current.id);
    }
    if (existing.decrementedUnits > 0) {
      const warning = `Insufficient stock: documented ${quantityFromUnits(documentedUnits)}, decremented ${quantityFromUnits(existing.decrementedUnits)}`;
      await materializeCathInventoryShortfallTx(tx, current, {
        decrementedUnits: existing.decrementedUnits,
        finalMovementId: existing.finalMovementId,
        warning
      });
      return consumableUsageById(tx, tenantId, current.id);
    }
    const batches = await initialCathInventoryBatchesTx(tx, current);
    if (current.inventory_batch_id) {
      const exact = batches[0];
      if (!exact || batchLineageMismatch(exact, {
        batchNumber: current.batch_number,
        lotNumber: current.lot_number,
        expiryDate: current.expiry_date
      })) {
        await updateCathInventoryOutcomeTx(tx, current, {
          status: 'error',
          warning: 'Inventory batch lineage changed before decrement; clinical usage was saved without a stock decrement'
        });
        return consumableUsageById(tx, tenantId, current.id);
      }
      if (exact.is_expired || !['in_stock', 'depleted'].includes(String(exact.status))) {
        await updateCathInventoryOutcomeTx(tx, current, {
          status: 'error',
          warning: exact.is_expired
            ? 'Exact inventory batch is expired; clinical usage was saved without a stock decrement'
            : 'Exact inventory batch is unavailable; clinical usage was saved without a stock decrement'
        });
        return consumableUsageById(tx, tenantId, current.id);
      }
    }
    let remainingUnits = documentedUnits;
    let decrementedUnits = 0;
    let finalMovementId = null;
    const movementKind = current.wasted ? 'dispose' : 'issue';
    const notes = current.wasted
      ? `Cath usage #${current.id}: opened but not used${current.waste_reason ? ` — ${current.waste_reason}` : ''}`
      : `Cath usage #${current.id}: documented for case #${current.case_id}`;
    for (const batch of batches) {
      if (remainingUnits <= 0) break;
      const availableUnits = Math.max(
        0,
        Math.round(Number(batch.remaining_quantity || 0) * QUANTITY_SCALE)
      );
      const takeUnits = Math.min(remainingUnits, availableUnits);
      if (takeUnits <= 0) continue;
      const result = await recordMovementTx(tx, {
        tenantId,
        inventory_item_id: current.inventory_item_id,
        inventory_batch_id: batch.id,
        movement_kind: movementKind,
        quantity: quantityFromUnits(takeUnits),
        reference_type: 'cath_consumable_usage',
        reference_id: String(current.id),
        performed_by: current.used_by,
        notes,
        require_usable_batch: true,
        expected_batch_number: batch.batch_number,
        expected_lot_number: batch.lot_number,
        expected_expiry_date: batch.expiry_date
      });
      decrementedUnits += takeUnits;
      remainingUnits -= takeUnits;
      finalMovementId = result.movement?.id || finalMovementId;
    }
    if (remainingUnits === 0) {
      await updateCathInventoryOutcomeTx(tx, current, {
        status: 'decremented',
        movementId: finalMovementId,
        warning: null
      });
    } else {
      const warning = `Insufficient stock: documented ${quantityFromUnits(documentedUnits)}, decremented ${quantityFromUnits(decrementedUnits)}`;
      await materializeCathInventoryShortfallTx(tx, current, {
        decrementedUnits,
        finalMovementId,
        warning
      });
    }
    return consumableUsageById(tx, tenantId, current.id);
  });
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
            catalog.inventory_item_id,
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
              AND task_assignee.role = ANY($6::text[]),
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
       JOIN cath_consumable_catalog catalog
         ON catalog.tenant_id = usage.tenant_id
        AND catalog.id = usage.catalog_item_id
       JOIN pharmacy_inventory_items inventory_item
         ON inventory_item.tenant_id = usage.tenant_id
        AND inventory_item.id = catalog.inventory_item_id
       JOIN tasks task
         ON task.tenant_id = usage.tenant_id
        AND task.related_resource_type = 'cath_case_consumable_usage'
        AND task.related_resource_id = usage.id::text
        AND task.metadata->>'task_contract' = $4::text
       JOIN workflow_sla_instances sla
         ON sla.tenant_id = usage.tenant_id
        AND sla.id = task.workflow_sla_instance_id
        AND sla.rule_code = $5::text
         AND sla.source_table = 'cath_case_consumable_usage'
         AND sla.source_id = usage.id::text
       LEFT JOIN users task_assignee
         ON task_assignee.tenant_id = task.tenant_id
        AND task_assignee.uid = task.assigned_to_uid
       LEFT JOIN notification_outbox outbox
         ON outbox.tenant_id = usage.tenant_id
        AND outbox.type = 'cath_inventory_shortfall'
        AND outbox.source_event_key = 'cath-inventory-shortfall:' || usage.id::text
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
             FROM users available_operator
            WHERE available_operator.tenant_id = usage.tenant_id
              AND available_operator.is_active = TRUE
              AND available_operator.status = 'active'
              AND COALESCE(available_operator.is_deleted, FALSE) = FALSE
              AND available_operator.role = ANY($6::text[])
         ) AS operator_available
       ) operator_state ON TRUE
      WHERE usage.tenant_id = $1::uuid
        AND usage.case_id = $2::bigint
        AND usage.id = $3::bigint
        AND usage.metadata->>'inventory_shortfall_contract' = $4::text
      LIMIT 1
      ${lock ? 'FOR UPDATE OF usage, task, sla, inventory_item' : ''}`,
    tenantId,
    normalizeId(caseId, 'case_id'),
    normalizeId(usageId, 'usage_id'),
    CATH_INVENTORY_SHORTFALL_TASK_CONTRACT,
    CATH_INVENTORY_SHORTFALL_SLA_RULE,
    CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES
  );
  if (!rows[0]) {
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
  command,
  requestedUnits,
  takeUnits
}) {
  const quantity = quantityFromUnits(takeUnits);
  const updated = await tx.$queryRawUnsafe(
    `UPDATE pharmacy_inventory_batches
        SET remaining_quantity = remaining_quantity - $4::numeric,
            status = CASE
              WHEN remaining_quantity - $4::numeric <= 0 THEN 'depleted'
              ELSE status
            END,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND inventory_item_id = $3::int
        AND status = 'in_stock'
        AND expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND remaining_quantity >= $4::numeric
      RETURNING id`,
    usage.tenant_id,
    Number(batch.id),
    Number(usage.inventory_item_id),
    quantity
  );
  if (!updated[0]) {
    throw AppError.conflict(
      'Cath inventory batch changed before reconciliation movement',
      'CATH_INVENTORY_RECONCILIATION_BATCH_CONFLICT'
    );
  }
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
    actor_role: actorRole,
    ...(command.requestId ? { request_id: command.requestId } : {})
  };
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_stock_movements
       (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
        quantity_delta, reference_type, reference_id, performed_by, notes, metadata,
        created_at)
     VALUES ($1::uuid, $2::int, $3::int, $4::text,
             -$5::numeric, 'cath_consumable_reconciliation', $6::text,
             $7::uuid, $8::text, $9::jsonb,
             date_trunc('milliseconds', clock_timestamp()))
     RETURNING id, created_at`,
    usage.tenant_id,
    Number(usage.inventory_item_id),
    Number(batch.id),
    usage.wasted ? 'dispose' : 'issue',
    quantity,
    command.commandKeySha256,
    command.actor,
    `Cath consumable usage #${String(usage.usage_id)} inventory reconciliation`,
    JSON.stringify(metadata)
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Cath inventory reconciliation movement was not persisted',
      'CATH_INVENTORY_RECONCILIATION_MOVEMENT_MISSING'
    );
  }
  return rows[0];
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
        AND task.metadata->>'movement_kind' IN ('issue', 'dispose')
        AND task.assigned_to_uid IS NOT NULL
        AND task.assigned_to_role IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM users current_owner
           WHERE current_owner.tenant_id = task.tenant_id
             AND current_owner.uid = task.assigned_to_uid
             AND current_owner.is_active = TRUE
             AND LOWER(COALESCE(current_owner.status, '')) = 'active'
             AND COALESCE(current_owner.is_deleted, FALSE) = FALSE
             AND current_owner.deleted_at IS NULL
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

async function nextCathInventoryRecoveryOwnerTx(tx, tenantId, staleUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid::text AS uid, UPPER(BTRIM(role)) AS role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid IS DISTINCT FROM $2::uuid
        AND is_active = TRUE
        AND LOWER(COALESCE(status, '')) = 'active'
        AND COALESCE(is_deleted, FALSE) = FALSE
        AND deleted_at IS NULL
        AND role = ANY($3::text[])
      ORDER BY CASE UPPER(BTRIM(role))
                 WHEN 'PHARMACY_INCHARGE' THEN 0
                 WHEN 'PHARMACIST' THEN 1
                 ELSE 2
               END,
               uid
      LIMIT 1
      FOR SHARE`,
    tenantId,
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
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
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
    let inventoryDecrementStatus = catalog.inventory_item_id ? 'pending' : 'not_linked';
    let inventoryWarning = catalog.inventory_item_id
      ? null
      : 'Catalog item is not linked to inventory; clinical usage was saved without a stock decrement';

    if (inventoryBatchValue && catalog.inventory_item_id) {
      const requestedInventoryBatchId = normalizeId(
        inventoryBatchValue,
        'inventory_batch_id'
      );
      const batches = await tx.$queryRawUnsafe(
        `SELECT id, batch_number, lot_number, expiry_date, remaining_quantity,
                status,
                (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
           FROM pharmacy_inventory_batches
          WHERE tenant_id = $1::uuid
            AND inventory_item_id = $2::int
            AND id = $3::int
          LIMIT 1`,
        tenantId,
        Number(catalog.inventory_item_id),
        requestedInventoryBatchId
      );
      const batch = unwrap(batches);
      if (!batch) {
        inventoryDecrementStatus = 'error';
        inventoryWarning = 'Selected inventory batch is outside this tenant or catalog item; clinical usage was saved without a stock decrement';
      } else if (batchLineageMismatch(batch, { batchNumber, lotNumber, expiryDate })) {
        inventoryDecrementStatus = 'error';
        inventoryWarning = 'Documented batch/lot/expiry does not match the selected inventory batch; clinical usage was saved without a stock decrement';
      } else {
        inventoryBatchId = requestedInventoryBatchId;
        batchNumber = cleanText(batch.batch_number, 120);
        lotNumber = cleanText(batch.lot_number, 120);
        expiryDate = optionalDate(batch.expiry_date, 'expiry_date');
        const outcome = evaluateCathInventoryBatch(batch, quantity);
        inventoryDecrementStatus = outcome.status;
        inventoryWarning = outcome.warning;
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
        inventoryDecrementStatus = 'error';
        inventoryWarning = 'Documented inventory lineage is incomplete; clinical usage was saved without a stock decrement';
      } else {
        const batches = await tx.$queryRawUnsafe(
          `SELECT id, batch_number, lot_number, expiry_date, remaining_quantity,
                  status,
                  (expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
             FROM pharmacy_inventory_batches
            WHERE tenant_id = $1::uuid
              AND inventory_item_id = $2::int
              AND expiry_date = $3::date
              AND ($4::text IS NULL OR batch_number = $4::text)
              AND ($5::text IS NULL OR lot_number = $5::text)
            ORDER BY id
            LIMIT 2`,
          tenantId,
          Number(catalog.inventory_item_id),
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
          inventoryDecrementStatus = outcome.status;
          inventoryWarning = outcome.warning;
        } else {
          inventoryDecrementStatus = 'error';
          inventoryWarning = batches.length > 1
            ? 'Documented batch/lot/expiry matches multiple inventory batches; clinical usage was saved without a stock decrement'
            : 'Documented batch/lot/expiry was not found in inventory; clinical usage was saved without a stock decrement';
        }
      }
    } else if (inventoryBatchValue) {
      inventoryWarning = 'Catalog item is not linked to inventory; selected batch was recorded as manual lineage without a stock decrement';
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
    const actorUid = maybeUuid(context.actorUid, 'actorUid');
    const metadata = normalizeJson(input.metadata, 'metadata', {});
    const idempotencyKey = cleanText(
      context.idempotencyKey || input.idempotency_key || input.idempotencyKey,
      200
    );
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_case_consumable_usage
         (tenant_id, case_id, procedure_log_id, catalog_item_id, patient_uid,
           inventory_batch_id, quantity, batch_tracked, is_implant, batch_number,
           lot_number, expiry_date, serial_number, unit_cost_snapshot, used_by,
           used_at, wasted, waste_reason, inventory_decrement_status,
           inventory_warning, metadata, idempotency_key)
        VALUES ($1::uuid, $2::bigint, $3::bigint, $4::bigint, $5::uuid,
                $6::int, $7::numeric, $8, $9, $10,
                $11, $12::date, $13, $14::numeric, $15::uuid,
                COALESCE($16::timestamptz, NOW()), $17, $18, $19, $20,
                $21::jsonb, $22)
       ON CONFLICT (tenant_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING *`,
      tenantId,
      cathCase.id,
      procedureLogId,
      catalog.id,
      cathCase.patient_uid,
      inventoryBatchId,
      quantity,
      catalog.batch_tracked,
      catalog.is_implant,
      batchNumber,
      lotNumber,
      expiryDate,
      serialNumber,
      catalog.default_unit_cost_reference,
      actorUid,
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
        actorUid,
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
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `${wasted ? 'Cath consumable wasted' : 'Cath consumable recorded'}: ${catalog.item_name}`,
      payload: {
        case_id: normalizeDbValue(cathCase.id),
        procedure_log_id: procedureLogId,
        catalog_item_id: catalog.id,
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
    return {
      usage: await consumableUsageById(tx, tenantId, usage.id),
      caseStatus: cathCase.status
    };
  });
  if (committed.replayed) {
    const replayedUsage = committed.usage.inventory_decrement_status === 'pending'
      ? await applyConsumableInventoryDecrement(committed.usage)
      : committed.usage;
    const billingHook = committed.caseStatus === 'completed'
      ? await maybeEmitCathBillingLines({ tenantId, caseId, actorUid: context.actorUid || null })
      : null;
    return billingHook
      ? { ...replayedUsage, idempotent_replay: true, billing_hook: billingHook }
      : { ...replayedUsage, idempotent_replay: true };
  }
  const usage = await applyConsumableInventoryDecrement(committed.usage);
  const billingHook = committed.caseStatus === 'completed'
    ? await maybeEmitCathBillingLines({ tenantId, caseId, actorUid: context.actorUid || null })
    : null;
  return billingHook ? { ...usage, billing_hook: billingHook } : usage;
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
  applyConsumableInventoryDecrement,
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
