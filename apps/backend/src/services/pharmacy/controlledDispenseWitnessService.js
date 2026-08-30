import crypto from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import { AppError } from '../../utils/AppError.js';
import { epochMsOrNull } from '../../utils/dbInstant.js';
import {
  DOCTOR,
  DUTY_DOCTOR,
  IP_INCHARGE,
  IP_STAFF_NURSE,
  MEDICAL_SUPERINTENDENT,
  NURSING_INCHARGE,
  NURSING_STAFF,
  OP_INCHARGE,
  OP_STAFF_NURSE,
  PHARMACY_INCHARGE,
  PHARMACY_STAFF,
  normalizeRole,
} from '../../utils/roles.js';
import { createApproval, recordApprovalDecision } from '../workflow/taskService.js';
import { assertPharmacyFacilityGrant } from './pharmacyFacilityAuthorityService.js';

export const CONTROLLED_DISPENSE_WITNESS_ROLES = [
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
  DOCTOR,
  DUTY_DOCTOR,
  MEDICAL_SUPERINTENDENT,
  NURSING_STAFF,
  NURSING_INCHARGE,
  IP_STAFF_NURSE,
  IP_INCHARGE,
  OP_STAFF_NURSE,
  OP_INCHARGE,
];

export const FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES = [
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
];

export const CONTROLLED_DISPENSE_APPROVAL_SCOPES = Object.freeze({
  inventory: 'inventory_controlled_dispense',
  inventoryMovement: 'inventory_controlled_movement',
  inventoryDisposal: 'pharmacy_inventory_controlled_disposal',
  pharmacyOrder: 'pharmacy_order_inventory_dispense',
  counterSale: 'pharmacy_counter_sale',
  dispenseSubstitution: 'pharmacy_dispense_substitution',
  wardIndent: 'ward_indent_controlled_handoff',
});

const APPROVAL_KIND = 'controlled_dispense_witness';
const APPROVAL_CONTRACT = 'controlled_dispense_witness_v1';
const WITNESS_ROLE_SET = new Set(CONTROLLED_DISPENSE_WITNESS_ROLES);
const FACILITY_BOUND_WITNESS_ROLE_SET = new Set(
  FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES,
);
const FACILITY_BOUND_APPROVAL_SCOPES = new Set([
  CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
  CONTROLLED_DISPENSE_APPROVAL_SCOPES.pharmacyOrder,
]);
const WITNESS_EVIDENCE = Symbol('controlled-dispense-witness-evidence');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_INT4_MAX = 2147483647;
const TRANSIENT_PAYLOAD_KEYS = new Set([
  'witness',
  'witness_uid',
  'witness_name',
  'witness_approval_id',
  'witnessApprovalId',
  'request_id',
]);

function requireUuid(value, label) {
  const uid = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_RE.test(uid)) {
    throw AppError.badRequest(
      `${label} must be a UUID`,
      'CONTROLLED_DISPENSE_WITNESS_INVALID',
    );
  }
  return uid;
}

function requireApprovalId(value) {
  const parsed = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,18}$/.test(parsed) || BigInt(parsed) > 9223372036854775807n) {
    throw AppError.badRequest(
      'witness_approval_id must be a positive integer',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID',
    );
  }
  return parsed;
}

function serializeApprovalId(row) {
  if (!row || row.id == null) return row;
  return { ...row, id: String(row.id) };
}

function requireScope(value) {
  if (!Object.values(CONTROLLED_DISPENSE_APPROVAL_SCOPES).includes(value)) {
    throw AppError.badRequest('Unsupported controlled-dispense approval scope');
  }
  return value;
}

function approvalFacilityId(scope, payload) {
  if (!FACILITY_BOUND_APPROVAL_SCOPES.has(scope)) return null;
  const facilityId = Number(payload?.facility_id);
  if (!Number.isSafeInteger(facilityId) || facilityId <= 0 || facilityId > PG_INT4_MAX) {
    throw AppError.conflict(
      'Witness approval has no exact server-authoritative pharmacy facility',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
    );
  }
  return facilityId;
}

function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function approvalPayload(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload || {}).filter(([key, value]) => (
      !TRANSIENT_PAYLOAD_KEYS.has(key) && value !== undefined
    )),
  );
}

export function controlledDispenseApprovalFingerprint({ scope, payload, requestedBy }) {
  return crypto.createHash('sha256').update(stableJson({
    contract: APPROVAL_CONTRACT,
    scope: requireScope(scope),
    requested_by: requireUuid(requestedBy, 'requested_by'),
    payload: approvalPayload(payload),
  })).digest('hex');
}

export async function assertControlledDispenseWitness(db, {
  tenantId, witnessUid, performedBy, facilityId = null, lockFacilityAuthority = false,
}) {
  const uid = requireUuid(witnessUid, 'witness.uid');
  const dispenser = requireUuid(performedBy, 'performed_by');
  if (uid === dispenser) {
    throw AppError.badRequest(
      'The dispensing staff member cannot witness their own controlled dispense',
      'CONTROLLED_DISPENSE_WITNESS_SELF',
    );
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT u.uid::text AS uid,
            COALESCE(NULLIF(BTRIM(s.name), ''), u.name) AS name,
            u.role
       FROM users u
       JOIN staff s
         ON s.tenant_id = u.tenant_id
        AND s.user_id = u.uid
      WHERE u.tenant_id = $1::uuid
        AND u.uid = $2::uuid
        AND u.is_active = true
        AND u.status = 'active'
        AND COALESCE(u.is_deleted, false) = false
        AND s.is_active = true
        AND COALESCE(s.archived, false) = false
      LIMIT 1
      FOR KEY SHARE OF u, s`,
    tenantId,
    uid,
  );
  if (!rows[0]) {
    throw AppError.badRequest(
      'Witness is not an active staff member of this tenant',
      'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND',
    );
  }
  const role = normalizeRole(rows[0].role);
  if (!role || !WITNESS_ROLE_SET.has(role)) {
    throw AppError.badRequest(
      'Witness must hold a pharmacy, medical, or nursing role',
      'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE',
      { witness_role: rows[0].role || null },
    );
  }
  if (facilityId != null && !FACILITY_BOUND_WITNESS_ROLE_SET.has(role)) {
    throw AppError.badRequest(
      'Facility-bound pharmacy custody must be witnessed by a pharmacy operator',
      'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE',
      {
        witness_role: rows[0].role || null,
        allowed_roles: FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES,
      },
    );
  }
  const name = String(rows[0].name || '').trim();
  if (!name) {
    throw AppError.badRequest(
      'Witness roster identity has no canonical display name',
      'CONTROLLED_DISPENSE_WITNESS_NAME_MISSING',
    );
  }
  let facilityGrantId = null;
  if (facilityId != null) {
    const grant = await assertPharmacyFacilityGrant(db, {
      tenantId,
      facilityId,
      actorUid: uid,
      actorRole: role,
      forUpdate: lockFacilityAuthority,
    });
    facilityGrantId = String(grant.grant_id);
  }
  return {
    uid,
    name,
    role,
    ...(facilityGrantId == null ? {} : { facility_grant_id: facilityGrantId }),
  };
}

function approvalMetadata(row) {
  return row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata
    : {};
}

async function loadApproval(db, tenantId, approvalId, { lock = false } = {}) {
  const id = requireApprovalId(approvalId);
  const rows = lock
    ? await db.$queryRawUnsafe(
      `SELECT id, approval_kind, subject_resource_type, subject_resource_id,
              status, approved_by, expires_at, decided_by, metadata,
              created_by, decided_at,
              (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_epoch_ms
         FROM approvals
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        FOR UPDATE`,
      tenantId,
      id,
    )
    : await db.$queryRawUnsafe(
      `SELECT id, approval_kind, subject_resource_type, subject_resource_id,
              status, approved_by, expires_at, decided_by, metadata,
              created_by, decided_at,
              (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_epoch_ms
         FROM approvals
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      id,
    );
  if (!rows[0]) {
    throw AppError.notFound(
      'Controlled-dispense witness approval not found',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_NOT_FOUND',
    );
  }
  return rows[0];
}

function assertApprovalContract(row, {
  scope,
  payload,
  requestedBy,
  requireApproved,
  requirePending = false,
}) {
  const metadata = approvalMetadata(row);
  const normalizedScope = requireScope(scope);
  const expectedFingerprint = payload === undefined
    ? metadata.payload_hash
    : controlledDispenseApprovalFingerprint({ scope: normalizedScope, payload, requestedBy });
  if (
    row.approval_kind !== APPROVAL_KIND
    || metadata.contract !== APPROVAL_CONTRACT
    || metadata.scope !== normalizedScope
    || row.subject_resource_type !== normalizedScope
    || row.subject_resource_id !== metadata.payload_hash
    || metadata.payload_hash !== expectedFingerprint
    || String(metadata.requested_by || '').toLowerCase() !== String(requestedBy).toLowerCase()
    || String(row.created_by || '').toLowerCase() !== String(requestedBy).toLowerCase()
  ) {
    throw AppError.conflict(
      'Witness approval does not match this exact controlled dispense',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
    );
  }
  const approvalExpiry = epochMsOrNull(row.expires_at_epoch_ms);
  if (approvalExpiry == null || approvalExpiry <= Date.now()) {
    throw AppError.conflict(
      'Witness approval has expired',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_EXPIRED',
    );
  }
  if (requirePending && row.status !== 'pending') {
    throw AppError.conflict(
      'Witness approval is not pending and cannot accept a credential decision',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_NOT_PENDING',
    );
  }
  if (requireApproved && row.status !== 'approved') {
    throw AppError.conflict(
      'Controlled dispense requires an independently approved witness request',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_REQUIRED',
      { approval_status: row.status },
    );
  }
  if (metadata.consumed_at) {
    throw AppError.conflict(
      'Witness approval has already been consumed',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_CONSUMED',
    );
  }
  return { metadata, expectedFingerprint };
}

export async function createControlledDispenseWitnessApproval({
  tenantId, scope, payload, requestedBy,
}) {
  const requestedByUid = requireUuid(requestedBy, 'requested_by');
  const normalizedScope = requireScope(scope);
  const payloadHash = controlledDispenseApprovalFingerprint({
    scope: normalizedScope,
    payload,
    requestedBy: requestedByUid,
  });
  const ttlMinutes = SECURITY_CONFIG.controlledDispenseWitness.approvalTtlMinutes;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  const approval = await setTenantTx(tenantId, (tx) => createApproval({
    tenantId,
    approvalKind: APPROVAL_KIND,
    subjectResourceType: normalizedScope,
    subjectResourceId: payloadHash,
    requiredApprovers: 1,
    expiresAt,
    createdBy: requestedByUid,
    metadata: {
      contract: APPROVAL_CONTRACT,
      scope: normalizedScope,
      payload_hash: payloadHash,
      requested_by: requestedByUid,
    },
    tx,
  }));
  return serializeApprovalId(approval);
}

export async function preflightControlledDispenseWitnessApproval({
  db = null,
  tenantId,
  approvalId,
  scope,
  payload,
  requesterUid = null,
  resolvePayload = null,
}) {
  const expectedScope = requireScope(scope);
  const run = async (tx) => {
    const row = await loadApproval(tx, tenantId, approvalId);
    const metadata = approvalMetadata(row);
    const storedRequester = requireUuid(metadata.requested_by, 'requested_by');
    assertApprovalContract(row, {
      scope: expectedScope,
      payload: undefined,
      requestedBy: storedRequester,
      requireApproved: false,
      requirePending: true,
    });
    if (
      requesterUid
      && String(storedRequester || '').toLowerCase() !== String(requesterUid).toLowerCase()
    ) {
      throw AppError.conflict(
        'Witness approval belongs to a different dispensing staff member',
        'CONTROLLED_DISPENSE_WITNESS_APPROVAL_REQUESTER_MISMATCH',
      );
    }
    const canonicalPayload = typeof resolvePayload === 'function'
      ? await resolvePayload({
        tx,
        requestedBy: storedRequester,
        scope: expectedScope,
      })
      : payload;
    assertApprovalContract(row, {
      scope: expectedScope,
      payload: canonicalPayload,
      requestedBy: storedRequester,
      requireApproved: false,
      requirePending: true,
    });
    return Object.freeze({ approval_id: String(row.id) });
  };
  return db ? run(db) : setTenantTx(tenantId, run);
}

export async function approveControlledDispenseWitnessApproval({
  tenantId,
  approvalId,
  actorUid,
  scope = null,
  payload,
  requesterUid = null,
  resolvePayload = null,
}) {
  return setTenantTx(tenantId, async (tx) => {
    const resolvesCanonicalPayload = typeof resolvePayload === 'function';
    const initialRow = await loadApproval(tx, tenantId, approvalId, {
      lock: !resolvesCanonicalPayload,
    });
    const initialMetadata = approvalMetadata(initialRow);
    const storedRequester = requireUuid(initialMetadata.requested_by, 'requested_by');
    const expectedScope = scope == null ? initialMetadata.scope : requireScope(scope);
    assertApprovalContract(initialRow, {
      scope: expectedScope,
      payload: undefined,
      requestedBy: storedRequester,
      requireApproved: false,
      requirePending: true,
    });
    if (
      requesterUid
      && storedRequester !== String(requesterUid).toLowerCase()
    ) {
      throw AppError.conflict(
        'Witness approval belongs to a different dispensing staff member',
        'CONTROLLED_DISPENSE_WITNESS_APPROVAL_REQUESTER_MISMATCH',
      );
    }
    const canonicalPayload = resolvesCanonicalPayload
      ? await resolvePayload({
        tx,
        requestedBy: storedRequester,
        scope: expectedScope,
      })
      : payload;
    const row = resolvesCanonicalPayload
      ? await loadApproval(tx, tenantId, approvalId, { lock: true })
      : initialRow;
    const lockedRequester = requireUuid(
      approvalMetadata(row).requested_by,
      'requested_by',
    );
    if (lockedRequester !== storedRequester) {
      throw AppError.conflict(
        'Witness approval requester changed during the approval ceremony',
        'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
      );
    }
    assertApprovalContract(row, {
      scope: expectedScope,
      payload: canonicalPayload,
      requestedBy: storedRequester,
      requireApproved: false,
      requirePending: true,
    });
    const facilityId = approvalFacilityId(expectedScope, canonicalPayload);
    const witness = await assertControlledDispenseWitness(tx, {
      tenantId,
      witnessUid: actorUid,
      performedBy: storedRequester,
      facilityId,
      lockFacilityAuthority: facilityId != null,
    });
    const approved = await recordApprovalDecision({
      tenantId,
      id: row.id,
      actorUid: witness.uid,
      actorRoles: [witness.role],
      decision: 'approve',
      tx,
    });
    if (facilityId != null) {
      await tx.$queryRawUnsafe(
        `UPDATE approvals
            SET metadata = metadata || jsonb_build_object(
                  'witness_facility_grant_id', $3::text,
                  'approved_witness_name', $4::text,
                  'approved_witness_role', $5::text
                ),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        tenantId,
        row.id,
        witness.facility_grant_id,
        witness.name,
        witness.role,
      );
    }
    return { ...serializeApprovalId(approved), witness };
  });
}

function assertWitnessFacilityGrantEvidence(row, witness, facilityId) {
  if (facilityId == null) return;
  const metadata = approvalMetadata(row);
  const storedGrantId = String(metadata.witness_facility_grant_id || '').trim();
  const approvedName = String(metadata.approved_witness_name || '').trim();
  const approvedRole = normalizeRole(metadata.approved_witness_role);
  if (!/^[1-9][0-9]{0,18}$/.test(storedGrantId)
      || BigInt(storedGrantId) > 9223372036854775807n
      || storedGrantId !== String(witness.facility_grant_id || '')
      || !approvedName
      || !FACILITY_BOUND_WITNESS_ROLE_SET.has(approvedRole)
      || approvedName !== witness.name
      || approvedRole !== witness.role) {
    throw AppError.conflict(
      'Witness pharmacy facility authority changed after approval',
      'CONTROLLED_DISPENSE_WITNESS_FACILITY_GRANT_MISMATCH',
    );
  }
}

function approvedWitnessUid(row) {
  const entries = Array.isArray(row.approved_by) ? row.approved_by : [];
  const uid = entries.length === 1 ? entries[0]?.uid : null;
  if (!uid || String(uid).toLowerCase() !== String(row.decided_by || '').toLowerCase()) {
    throw AppError.conflict(
      'Witness approval evidence is incomplete',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID',
    );
  }
  return uid;
}

export async function assertApprovedControlledDispenseWitness({
  db = prisma, tenantId, approvalId, scope, payload, requestedBy,
}) {
  const row = await loadApproval(db, tenantId, approvalId);
  assertApprovalContract(row, { scope, payload, requestedBy, requireApproved: true });
  const facilityId = approvalFacilityId(scope, payload);
  const witness = await assertControlledDispenseWitness(db, {
    tenantId,
    witnessUid: approvedWitnessUid(row),
    performedBy: requestedBy,
    facilityId,
  });
  assertWitnessFacilityGrantEvidence(row, witness, facilityId);
  return witness;
}

export async function consumeControlledDispenseWitnessApproval({
  tx, tenantId, approvalId, scope, payload, requestedBy,
}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'Witness approval consumption requires the dispense transaction',
      'CONTROLLED_DISPENSE_WITNESS_TRANSACTION_REQUIRED',
    );
  }
  const row = await loadApproval(tx, tenantId, approvalId, { lock: true });
  assertApprovalContract(row, { scope, payload, requestedBy, requireApproved: true });
  const facilityId = approvalFacilityId(scope, payload);
  const witness = await assertControlledDispenseWitness(tx, {
    tenantId,
    witnessUid: approvedWitnessUid(row),
    performedBy: requestedBy,
    facilityId,
    lockFacilityAuthority: facilityId != null,
  });
  assertWitnessFacilityGrantEvidence(row, witness, facilityId);
  await tx.$queryRawUnsafe(
    `UPDATE approvals
        SET metadata = metadata || jsonb_build_object(
              'consumed_at', NOW()::text,
              'consumed_by', $3::text,
              'canonical_witness_name', $4::text,
              'canonical_witness_role', $5::text,
              'witness_facility_grant_id', $6::text
            ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint`,
    tenantId,
    row.id,
    requestedBy,
    witness.name,
    witness.role,
    witness.facility_grant_id || null,
  );
  return Object.freeze({ ...witness, [WITNESS_EVIDENCE]: true });
}

export function isControlledDispenseWitnessEvidence(value) {
  return value?.[WITNESS_EVIDENCE] === true;
}
