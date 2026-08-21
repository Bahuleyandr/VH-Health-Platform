// src/services/staff/credentialingService.js
//
// N6-5 credentialing and privileging registry: credential catalog, grant
// approvals, document proof, expiry alerts, and inert enforcement seams.

import crypto from 'crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { normalizeUploadMimeType } from '../../middleware/uploadMiddleware.js';
import { screenUploadBuffer } from '../security/fileScanService.js';
import { uploadFileToR2 } from '../../utils/r2Storage.js';
import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { requireTenantId } from '../tenant/tenantService.js';

const TYPES = ['registration', 'qualification', 'privilege', 'training', 'immunization'];
const CREDENTIAL_STATUSES = ['active', 'suspended', 'revoked'];
const CATALOG_STATUSES = ['active', 'paused', 'retired'];
const ALERT_STATUSES = ['open', 'acknowledged', 'resolved', 'cancelled'];
const ALERT_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const APPROVAL_KIND = 'credential_privilege_grant';

const PRIVILEGE_ALIASES = new Map([
  ['chemo_administer', 'chemo_administration'],
  ['chemo_admin', 'chemo_administration'],
  ['anesthetist', 'anesthesia_finalize'],
  ['anaesthetist', 'anesthesia_finalize'],
  ['anesthesia_record_finalize', 'anesthesia_finalize'],
  ['anaesthesia_finalize', 'anesthesia_finalize'],
  ['controlled_substance_erx', 'controlled_substance_prescribe'],
]);

function tenantOr(value) {
  return requireTenantId(value);
}

function cleanText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeDate(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${label} must be a YYYY-MM-DD date`);
  }
  return text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeInt(value, label, { fallback = null, min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeStringArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array`);
  return value.map((item) => cleanText(item, 80)).filter(Boolean);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

export function privilegeKey(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return PRIVILEGE_ALIASES.get(normalized) || normalized;
}

export function severityForDaysRemaining(days) {
  if (days <= 7) return 'critical';
  if (days <= 30) return 'high';
  if (days <= 60) return 'medium';
  return 'low';
}

export function isGateEnabled(envName) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[envName] || '').trim().toLowerCase());
}

async function assertStaffInTenant(staffUid, tenantId) {
  const staff = await prisma.$queryRawUnsafe(
    `SELECT uid, id, name, role
       FROM users
      WHERE uid = $1::uuid
        AND tenant_id = $2::uuid
      LIMIT 1`,
    maybeUuid(staffUid, 'staff_uid'), tenantId,
  );
  if (!staff.length) throw AppError.notFound('Staff member not found', 'CRED_STAFF_NOT_FOUND');
  return staff[0];
}

async function resolveCatalog({ tenantId, privilegeCatalogId = null, name = null, required = false } = {}) {
  const tid = tenantOr(tenantId);
  let rows = [];
  if (privilegeCatalogId) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, privilege_key, display_name, description,
              required_credential_types, review_cadence_days, enforcement_scope,
              status, metadata, created_at, updated_at
         FROM privilege_catalog
        WHERE id = $1 AND tenant_id = $2::uuid
        LIMIT 1`,
      normalizeId(privilegeCatalogId, 'privilege_catalog_id'), tid,
    );
  } else if (name) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, privilege_key, display_name, description,
              required_credential_types, review_cadence_days, enforcement_scope,
              status, metadata, created_at, updated_at
         FROM privilege_catalog
        WHERE tenant_id = $1::uuid
          AND privilege_key = $2
        LIMIT 1`,
      tid, privilegeKey(name),
    );
  }
  if (!rows[0] && required) {
    throw AppError.badRequest('Privilege must exist in the catalog before it can be granted', 'CRED_PRIVILEGE_NOT_CATALOGED');
  }
  if (rows[0]?.status && rows[0].status !== 'active') {
    throw AppError.conflict('Privilege catalog entry is not active', 'CRED_PRIVILEGE_INACTIVE');
  }
  return rows[0] || null;
}

const CREDENTIAL_RETURNING = `c.id, c.tenant_id, c.staff_uid, u.name AS staff_name, u.role AS staff_role,
  c.credential_type, c.name, c.issuing_body, c.registration_number,
  c.valid_from, c.valid_until, c.status, c.document_ref,
  c.document_storage_key, c.document_storage_url, c.document_mime_type,
  c.document_file_size, c.document_sha256_hash, c.document_uploaded_at,
  c.verified_by, c.verified_at, c.notes, c.metadata, c.created_by,
  c.requested_by, c.approved_by, c.approved_at,
  c.privilege_catalog_id, pc.privilege_key, pc.display_name AS privilege_display_name,
  pc.review_cadence_days AS catalog_review_cadence_days,
  c.review_cadence_days, c.renewal_due_at, c.renewal_status,
  c.renewal_requested_at, c.renewal_completed_at,
  c.created_at, c.updated_at,
  (c.valid_until IS NOT NULL AND c.valid_until < CURRENT_DATE) AS expired`;

export async function listPrivilegeCatalog({ tenantId = null, status = null, q = null } = {}) {
  const params = [tenantOr(tenantId)];
  const filters = ['tenant_id = $1::uuid'];
  if (status) {
    if (!CATALOG_STATUSES.includes(status)) throw AppError.badRequest('bad catalog status');
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  if (q) {
    params.push(`%${String(q).trim()}%`);
    filters.push(`(privilege_key ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, privilege_key, display_name, description,
            required_credential_types, review_cadence_days, enforcement_scope,
            status, metadata, created_at, updated_at
       FROM privilege_catalog
      WHERE ${filters.join(' AND ')}
      ORDER BY status, enforcement_scope NULLS LAST, display_name`,
    ...params,
  );
  return { catalog: rows, count: rows.length };
}

export async function upsertPrivilegeCatalog({
  tenantId = null, id = null, privilegeKey: rawKey = null, displayName = null,
  description = null, requiredCredentialTypes = null, reviewCadenceDays = 365,
  enforcementScope = null, status = 'active', metadata = null, createdBy = null,
} = {}) {
  const tid = tenantOr(tenantId);
  const key = privilegeKey(rawKey || displayName);
  if (!/^[a-z0-9][a-z0-9_]{1,118}[a-z0-9]$/.test(key)) {
    throw AppError.badRequest('privilege_key must be lowercase snake_case and 3-120 characters');
  }
  const name = cleanText(displayName, 200) || key;
  const cadence = normalizeInt(reviewCadenceDays, 'review_cadence_days', { fallback: 365, min: 1, max: 3650 });
  const cleanStatus = status || 'active';
  if (!CATALOG_STATUSES.includes(cleanStatus)) {
    throw AppError.badRequest(`status must be one of: ${CATALOG_STATUSES.join(', ')}`);
  }
  const args = [
    tid, key, name, cleanText(description), normalizeStringArray(requiredCredentialTypes, 'required_credential_types'),
    cadence, cleanText(enforcementScope, 80), cleanStatus,
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];
  if (id) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE privilege_catalog
          SET privilege_key = $2,
              display_name = $3,
              description = $4,
              required_credential_types = $5::text[],
              review_cadence_days = $6,
              enforcement_scope = $7,
              status = $8,
              metadata = $9::jsonb,
              updated_at = NOW()
        WHERE id = $10 AND tenant_id = $1::uuid
        RETURNING id, tenant_id, privilege_key, display_name, description,
                  required_credential_types, review_cadence_days, enforcement_scope,
                  status, metadata, created_at, updated_at`,
      ...args, normalizeId(id),
    );
    if (!rows[0]) throw AppError.notFound('Privilege catalog entry not found');
    return rows[0];
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO privilege_catalog
       (tenant_id, privilege_key, display_name, description, required_credential_types,
        review_cadence_days, enforcement_scope, status, metadata, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::text[], $6, $7, $8, $9::jsonb, $10::uuid)
     ON CONFLICT (tenant_id, privilege_key) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       required_credential_types = EXCLUDED.required_credential_types,
       review_cadence_days = EXCLUDED.review_cadence_days,
       enforcement_scope = EXCLUDED.enforcement_scope,
       status = EXCLUDED.status,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, tenant_id, privilege_key, display_name, description,
               required_credential_types, review_cadence_days, enforcement_scope,
               status, metadata, created_at, updated_at`,
    ...args, maybeUuid(createdBy, 'created_by'),
  );
  return rows[0];
}

export async function addCredential({
  staffUid, credentialType, name, issuingBody = null, registrationNumber = null,
  validFrom = null, validUntil = null, documentRef = null, notes = null,
  tenantId = null, metadata = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  if (!staffUid) throw AppError.badRequest('staff_uid required', 'CRED_STAFF_REQUIRED');
  if (!TYPES.includes(credentialType)) {
    throw AppError.badRequest(`credential_type must be one of ${TYPES.join(', ')}`, 'CRED_BAD_TYPE');
  }
  // Two-person credentialing: a privilege (the thing clinical gates check) may
  // NOT be recorded directly as an active grant. It must flow through
  // requestPrivilegeGrant → decidePrivilegeApproval so a second, independent
  // approver signs it off. Ordinary evidence (registration, qualification,
  // training, immunization) is still direct-entry.
  if (credentialType === 'privilege') {
    throw AppError.badRequest(
      'Privileges cannot be recorded directly. Submit a privilege request (POST /credentials/privilege-requests) and have an independent approver decide it.',
      'CRED_PRIVILEGE_REQUIRES_APPROVAL',
    );
  }
  await assertStaffInTenant(staffUid, tid);
  const cleanName = cleanText(name, 200);
  if (!cleanName) throw AppError.badRequest('name required', 'CRED_NAME_REQUIRED');
  // Non-privilege evidence has no catalog-driven renewal cadence.
  const renewalDueAt = null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO staff_credentials
         (tenant_id, staff_uid, credential_type, name, issuing_body, registration_number,
          valid_from, valid_until, document_ref, notes, created_by, requested_by,
          privilege_catalog_id, review_cadence_days, renewal_due_at, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::date, $9, $10,
               $11::uuid, $11::uuid, $12, $13, $14::date, $15::jsonb)
       RETURNING *`,
      tid, staffUid, credentialType, cleanName, cleanText(issuingBody, 200),
      cleanText(registrationNumber, 120), normalizeDate(validFrom, 'valid_from'),
      normalizeDate(validUntil, 'valid_until'), cleanText(documentRef, 255),
      cleanText(notes, 400), maybeUuid(context.actorUid, 'actorUid'),
      null, null, renewalDueAt,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (String(err?.message || '').includes('uq_staff_credentials_active_privilege')) {
      throw AppError.conflict(`Staff member already holds active privilege '${cleanName}'`, 'CRED_PRIVILEGE_EXISTS');
    }
    throw err;
  }
}

export async function requestPrivilegeGrant({
  staffUid, privilegeCatalogId = null, privilege = null,
  issuingBody = null, registrationNumber = null, validFrom = null, validUntil = null,
  documentRef = null, notes = null, tenantId = null, metadata = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertStaffInTenant(staffUid, tid);
  const catalog = await resolveCatalog({ tenantId: tid, privilegeCatalogId, name: privilege, required: true });
  const actorUid = maybeUuid(context.actorUid, 'actorUid');
  const renewalDueAt = validUntil
    ? new Date(new Date(validUntil).getTime() - catalog.review_cadence_days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null;

  return setTenantTx(tid, async (tx) => {
    const credentialRows = await tx.$queryRawUnsafe(
      `INSERT INTO staff_credentials
         (tenant_id, staff_uid, credential_type, name, issuing_body, registration_number,
          valid_from, valid_until, status, document_ref, notes, created_by, requested_by,
          privilege_catalog_id, review_cadence_days, renewal_due_at, renewal_status, metadata)
       VALUES ($1::uuid, $2::uuid, 'privilege', $3, $4, $5, $6::date, $7::date,
               'suspended', $8, $9, $10::uuid, $10::uuid, $11, $12, $13::date,
               'requested', $14::jsonb)
       RETURNING *`,
      tid, staffUid, catalog.privilege_key, cleanText(issuingBody, 200),
      cleanText(registrationNumber, 120), normalizeDate(validFrom, 'valid_from'),
      normalizeDate(validUntil, 'valid_until'), cleanText(documentRef, 255),
      cleanText(notes, 400), actorUid, catalog.id, catalog.review_cadence_days,
      renewalDueAt, JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    const credential = credentialRows[0];
    const approvalRows = await tx.$queryRawUnsafe(
      `INSERT INTO approvals
         (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
          required_approvers, required_role, status, metadata)
       VALUES ($1::uuid, $2, 'staff_credential', $3, 1, 'MEDICAL_SUPERINTENDENT',
               'pending', $4::jsonb)
       RETURNING id, tenant_id, approval_kind, subject_resource_type,
                 subject_resource_id, required_approvers, required_role,
                 status, approved_by, rejection_reason, expires_at,
                 decided_at, metadata, created_at, updated_at`,
      tid, APPROVAL_KIND, String(credential.id), JSON.stringify({
        staff_uid: staffUid,
        privilege_key: catalog.privilege_key,
        requested_by: actorUid,
      }),
    );
    return { credential, approval: approvalRows[0] };
  });
}

export async function decidePrivilegeApproval({
  approvalId, decision, reason = null, tenantId = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  const cleanDecision = String(decision || '').trim().toLowerCase();
  if (!['approved', 'rejected'].includes(cleanDecision)) {
    throw AppError.badRequest('decision must be approved or rejected');
  }
  const actorUid = maybeUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const approvals = await tx.$queryRawUnsafe(
      `SELECT id, subject_resource_id, status, metadata
         FROM approvals
        WHERE id = $1 AND tenant_id = $2::uuid
          AND approval_kind = $3
        FOR UPDATE`,
      normalizeId(approvalId, 'approval_id'), tid, APPROVAL_KIND,
    );
    if (!approvals[0]) throw AppError.notFound('Privilege approval not found');
    if (approvals[0].status !== 'pending') {
      throw AppError.conflict('Privilege approval is no longer pending');
    }
    // Two-person integrity: the approver must be a different person from the
    // requester, and cannot approve a grant made out to themselves.
    if (cleanDecision === 'approved') {
      const meta = approvals[0].metadata && typeof approvals[0].metadata === 'object'
        ? approvals[0].metadata
        : (() => { try { return JSON.parse(approvals[0].metadata || '{}'); } catch { return {}; } })();
      const approver = actorUid ? String(actorUid) : null;
      const requestedBy = meta.requested_by ? String(meta.requested_by) : null;
      const granteeUid = meta.staff_uid ? String(meta.staff_uid) : null;
      if (approver && requestedBy && approver === requestedBy) {
        throw AppError.forbidden(
          'You cannot approve a privilege grant you requested — an independent approver is required.',
          'CRED_SELF_APPROVAL_FORBIDDEN',
        );
      }
      if (approver && granteeUid && approver === granteeUid) {
        throw AppError.forbidden(
          'You cannot approve a privilege grant made out to yourself.',
          'CRED_SELF_GRANT_APPROVAL_FORBIDDEN',
        );
      }
    }
    const credentialId = normalizeId(approvals[0].subject_resource_id, 'subject_resource_id');
    const approvalRows = await tx.$queryRawUnsafe(
      `UPDATE approvals
          SET status = $1::varchar,
              approved_by = CASE WHEN $1::text = 'approved'
                THEN COALESCE(approved_by, '[]'::jsonb)
                  || jsonb_build_array(jsonb_build_object('uid', $2::text, 'at', NOW()))
                ELSE approved_by
              END,
              rejection_reason = CASE WHEN $1::text = 'rejected' THEN $3 ELSE rejection_reason END,
              decided_at = NOW(),
              updated_at = NOW()
        WHERE id = $4 AND tenant_id = $5::uuid
        RETURNING id, tenant_id, approval_kind, subject_resource_type,
                  subject_resource_id, required_approvers, required_role,
                  status, approved_by, rejection_reason, expires_at,
                  decided_at, metadata, created_at, updated_at`,
      cleanDecision, actorUid, cleanText(reason), approvals[0].id, tid,
    );
    const credentialRows = await tx.$queryRawUnsafe(
      `UPDATE staff_credentials
          SET status = CASE WHEN $1::text = 'approved' THEN 'active' ELSE 'revoked' END,
              approved_by = CASE WHEN $1::text = 'approved' THEN $2::uuid ELSE approved_by END,
              approved_at = CASE WHEN $1::text = 'approved' THEN NOW() ELSE approved_at END,
              verified_by = CASE WHEN $1::text = 'approved' THEN $2::uuid ELSE verified_by END,
              verified_at = CASE WHEN $1::text = 'approved' THEN NOW() ELSE verified_at END,
              renewal_status = CASE WHEN $1::text = 'approved' THEN 'current' ELSE renewal_status END,
              notes = COALESCE($3, notes),
              updated_at = NOW()
        WHERE id = $4 AND tenant_id = $5::uuid
        RETURNING *`,
      cleanDecision, actorUid, cleanText(reason, 400), credentialId, tid,
    );
    if (!credentialRows[0]) throw AppError.notFound('Requested credential not found');
    return { approval: approvalRows[0], credential: credentialRows[0] };
  });
}

export async function listPrivilegeApprovals({ tenantId = null, status = 'pending', limit = 50 } = {}) {
  const params = [tenantOr(tenantId), APPROVAL_KIND];
  const filters = ['a.tenant_id = $1::uuid', 'a.approval_kind = $2'];
  if (status) {
    params.push(String(status));
    filters.push(`a.status = $${params.length}`);
  }
  const safeLimit = normalizeInt(limit, 'limit', { fallback: 50, min: 1, max: 200 });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.tenant_id, a.approval_kind, a.subject_resource_type,
            a.subject_resource_id, a.required_approvers, a.required_role,
            a.status, a.approved_by, a.rejection_reason, a.expires_at,
            a.decided_at, a.metadata, a.created_at, a.updated_at,
            c.staff_uid, c.name AS privilege_key, u.name AS staff_name, u.role AS staff_role
       FROM approvals a
       LEFT JOIN staff_credentials c
         ON c.id::text = a.subject_resource_id
        AND c.tenant_id = a.tenant_id
       LEFT JOIN users u
         ON u.uid = c.staff_uid
        AND u.tenant_id = c.tenant_id
      WHERE ${filters.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT $${params.length + 1}`,
    ...params, safeLimit,
  );
  return { approvals: rows, count: rows.length };
}

export async function listCredentials(staffUid, { type = null, tenantId = null } = {}) {
  const params = [tenantOr(tenantId), maybeUuid(staffUid, 'staff_uid')];
  let where = 'c.tenant_id = $1::uuid AND c.staff_uid = $2::uuid';
  if (type) {
    if (!TYPES.includes(type)) throw AppError.badRequest('bad credential_type filter', 'CRED_BAD_TYPE');
    params.push(type);
    where += ` AND c.credential_type = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT ${CREDENTIAL_RETURNING}
       FROM staff_credentials c
       LEFT JOIN privilege_catalog pc
         ON pc.id = c.privilege_catalog_id
       LEFT JOIN users u
         ON u.uid = c.staff_uid
        AND u.tenant_id = c.tenant_id
      WHERE ${where}
      ORDER BY c.credential_type, c.valid_until NULLS LAST`,
    ...params,
  );
}

export async function updateCredentialStatus(id, { status, notes = null, tenantId = null } = {}, context = {}) {
  if (!CREDENTIAL_STATUSES.includes(status)) {
    throw AppError.badRequest('status must be active|suspended|revoked', 'CRED_BAD_STATUS');
  }
  const tid = tenantOr(tenantId);
  const credId = normalizeId(id);
  // Two-person credentialing: this endpoint may suspend or revoke a privilege,
  // but it must NOT be a back door to activating one — that only happens through
  // an independently-approved grant (decidePrivilegeApproval).
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, credential_type FROM staff_credentials WHERE id = $1 AND tenant_id = $2::uuid`,
    credId, tid,
  );
  if (!existing.length) throw AppError.notFound('Credential not found');
  if (existing[0].credential_type === 'privilege' && status === 'active') {
    throw AppError.forbidden(
      'A privilege cannot be activated through a status change. Activate it via an independently-approved privilege request; this endpoint may only suspend or revoke.',
      'CRED_PRIVILEGE_ACTIVATION_VIA_APPROVAL',
    );
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE staff_credentials SET
       status = $2, notes = COALESCE($3, notes),
       verified_by = $4::uuid, verified_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $5::uuid RETURNING *`,
    credId, status, cleanText(notes, 400), maybeUuid(context.actorUid, 'actorUid'), tid,
  );
  if (!rows.length) throw AppError.notFound('Credential not found');
  return rows[0];
}

export async function uploadCredentialDocument({
  credentialId, file, tenantId = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  if (!file?.buffer) throw AppError.badRequest('Credential document file is required');
  const [credential] = await prisma.$queryRawUnsafe(
    `SELECT id, staff_uid, credential_type, name
       FROM staff_credentials
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(credentialId, 'credential_id'), tid,
  );
  if (!credential) throw AppError.notFound('Credential not found');
  const mimeType = normalizeUploadMimeType(file) || 'application/octet-stream';
  const versionRows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM credential_document_uploads
      WHERE tenant_id = $1::uuid
        AND staff_credential_id = $2`,
    tid, credential.id,
  );
  const version = Number(versionRows[0]?.version || 1);
  const originalName = cleanText(file.originalname, 180) || 'credential-document';
  const safeName = originalName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'credential-document';
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const storageKey = [
    'staff-credentials',
    tid,
    String(credential.staff_uid),
    String(credential.id),
    `v${version}_${Date.now()}_${safeName}`,
  ].join('/');
  // Screen BEFORE anything is stored (FILE_SCAN_POLICY, shared with every
  // ingest path). Refusals throw 422/503 AppErrors and nothing is written.
  await screenUploadBuffer(file.buffer, {
    subject: 'Credential document',
    context: { credentialId: credential.id, tenantId: tid, route: 'staff-credential-document' },
  });
  const storageUrl = await uploadFileToR2(file.buffer, storageKey, mimeType);
  const actorUid = maybeUuid(context.actorUid, 'actorUid');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO credential_document_uploads
       (tenant_id, staff_credential_id, staff_uid, version,
        storage_key, storage_url, mime_type, file_size, sha256_hash,
        uploaded_by, metadata)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::uuid, $11::jsonb)
     RETURNING id, tenant_id, staff_credential_id, staff_uid, version,
               storage_key, storage_url, mime_type, file_size, sha256_hash,
               uploaded_by, uploaded_at, metadata`,
    tid, credential.id, credential.staff_uid, version,
    storageKey, storageUrl, mimeType, file.size, hash, actorUid,
    JSON.stringify({ original_name: originalName }),
  );
  await prisma.$queryRawUnsafe(
    `UPDATE staff_credentials
        SET document_ref = $1,
            document_storage_key = $1,
            document_storage_url = $2,
            document_mime_type = $3,
            document_file_size = $4,
            document_sha256_hash = $5,
            document_uploaded_at = NOW(),
            updated_at = NOW()
      WHERE id = $6 AND tenant_id = $7::uuid`,
    storageKey, storageUrl, mimeType, file.size, hash, credential.id, tid,
  );
  return rows[0];
}

/** Expiry radar: active credentials expiring within `days` (or expired). */
export async function listExpiring({ days = 60, tenantId = null } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT c.*, u.name AS staff_name, u.role AS staff_role,
            (c.valid_until < CURRENT_DATE) AS expired,
            (c.valid_until - CURRENT_DATE)::int AS days_remaining
       FROM staff_credentials c
       JOIN users u ON u.uid = c.staff_uid AND u.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1::uuid
        AND c.status = 'active' AND c.valid_until IS NOT NULL
        AND c.valid_until <= CURRENT_DATE + $2::int
      ORDER BY c.valid_until ASC`,
    tenantOr(tenantId),
    normalizeInt(days, 'days', { fallback: 60, min: 1, max: 365 }),
  );
}

export async function scanCredentialExpiryAlerts({ tenantId = null, days = 60 } = {}) {
  const tid = tenantOr(tenantId);
  const lookahead = normalizeInt(days, 'days', { fallback: 60, min: 1, max: 365 });
  const candidates = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.staff_uid, c.name, c.valid_until, c.renewal_due_at,
            u.id AS staff_user_id, u.name AS staff_name
       FROM staff_credentials c
       JOIN users u ON u.uid = c.staff_uid AND u.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1::uuid
        AND c.status = 'active'
        AND (
          (c.valid_until IS NOT NULL AND c.valid_until <= CURRENT_DATE + $2::int)
          OR (c.renewal_due_at IS NOT NULL AND c.renewal_due_at <= CURRENT_DATE + $2::int)
        )`,
    tid, lookahead,
  );
  let created = 0;
  for (const row of candidates) {
    const targets = [];
    if (row.valid_until) targets.push({ kind: 'credential_expiry', date: row.valid_until });
    if (row.renewal_due_at) targets.push({ kind: 'renewal_due', date: row.renewal_due_at });
    for (const target of targets) {
      const due = new Date(target.date);
      const today = new Date(new Date().toDateString());
      const daysRemaining = Math.ceil((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      const severity = severityForDaysRemaining(daysRemaining);
      const inserted = await prisma.$queryRawUnsafe(
        `INSERT INTO credential_expiry_alerts
           (tenant_id, staff_credential_id, staff_uid, alert_kind, due_date,
            days_remaining, severity, status, metadata)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5::date, $6, $7, 'open', $8::jsonb)
         ON CONFLICT (tenant_id, staff_credential_id, alert_kind, due_date)
           WHERE status = 'open'
         DO UPDATE SET days_remaining = EXCLUDED.days_remaining,
                       severity = EXCLUDED.severity,
                       updated_at = NOW()
         RETURNING (xmax = 0) AS inserted, id`,
        tid, row.id, row.staff_uid, target.kind, target.date,
        daysRemaining, severity, JSON.stringify({ credential_name: row.name }),
      );
      if (inserted[0]?.inserted) {
        created += 1;
        if (row.staff_user_id) {
          await notificationOutbox.queue({
            type: 'push',
            recipientId: row.staff_user_id,
            title: 'Credential review due',
            body: `${row.name} is ${daysRemaining < 0 ? 'overdue' : `due in ${daysRemaining} day(s)`}.`,
            data: {
              kind: 'credential_expiry_alert',
              credential_id: row.id,
              alert_kind: target.kind,
            },
          });
        }
      }
    }
  }
  return { scanned: candidates.length, created, lookahead_days: lookahead };
}

export async function listCredentialExpiryAlerts({
  tenantId = null, status = 'open', severity = null, limit = 100,
} = {}) {
  const params = [tenantOr(tenantId)];
  const filters = ['a.tenant_id = $1::uuid'];
  if (status) {
    if (!ALERT_STATUSES.includes(status)) throw AppError.badRequest('bad alert status');
    params.push(status);
    filters.push(`a.status = $${params.length}`);
  }
  if (severity) {
    if (!ALERT_SEVERITIES.includes(severity)) throw AppError.badRequest('bad alert severity');
    params.push(severity);
    filters.push(`a.severity = $${params.length}`);
  }
  const safeLimit = normalizeInt(limit, 'limit', { fallback: 100, min: 1, max: 500 });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.tenant_id, a.staff_credential_id, a.staff_uid,
            a.alert_kind, a.due_date, a.days_remaining, a.severity,
            a.status, a.acknowledged_by, a.acknowledged_at, a.resolution,
            a.resolved_at, a.metadata, a.created_at, a.updated_at,
            c.credential_type, c.name AS credential_name,
            u.name AS staff_name, u.role AS staff_role
       FROM credential_expiry_alerts a
       JOIN staff_credentials c
         ON c.id = a.staff_credential_id
        AND c.tenant_id = a.tenant_id
       LEFT JOIN users u
         ON u.uid = a.staff_uid
        AND u.tenant_id = a.tenant_id
      WHERE ${filters.join(' AND ')}
      ORDER BY a.due_date ASC, a.severity DESC, a.created_at DESC
      LIMIT $${params.length + 1}`,
    ...params, safeLimit,
  );
  return { alerts: rows, count: rows.length };
}

export async function acknowledgeCredentialExpiryAlert({
  tenantId = null, id, acknowledgedBy, resolution = null,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE credential_expiry_alerts
        SET status = 'acknowledged',
            acknowledged_by = $1::uuid,
            acknowledged_at = NOW(),
            resolution = $2,
            updated_at = NOW()
      WHERE id = $3 AND tenant_id = $4::uuid AND status = 'open'
      RETURNING *`,
    maybeUuid(acknowledgedBy, 'acknowledged_by'), cleanText(resolution, 120),
    normalizeId(id, 'alert_id'), tenantOr(tenantId),
  );
  if (!rows[0]) throw AppError.notFound('Credential alert not found or not open');
  return rows[0];
}

/**
 * The privilege gate other domains call: active, in-date privilege row of this
 * catalog key or legacy name. Returns { allowed, reason }.
 */
export async function hasActivePrivilege(staffUid, privilegeName, { tenantId = null } = {}) {
  if (!staffUid || !privilegeName) return { allowed: false, reason: 'missing_input' };
  const key = privilegeKey(privilegeName);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.valid_until, pc.privilege_key
       FROM staff_credentials c
       LEFT JOIN privilege_catalog pc
         ON pc.id = c.privilege_catalog_id
      WHERE c.tenant_id = $1::uuid
        AND c.staff_uid = $2::uuid
        AND c.credential_type = 'privilege'
        AND c.status = 'active'
        AND (
          pc.privilege_key = $3
          OR lower(regexp_replace(c.name, '[^a-zA-Z0-9]+', '_', 'g')) = $3
          OR UPPER(c.name) = UPPER($4)
        )
      LIMIT 1`,
    tenantOr(tenantId), maybeUuid(staffUid, 'staff_uid'), key, String(privilegeName).trim(),
  );
  if (!rows.length) return { allowed: false, reason: 'privilege_not_held', privilege_key: key };
  if (rows[0].valid_until && new Date(rows[0].valid_until) < new Date(new Date().toDateString())) {
    return { allowed: false, reason: 'privilege_expired', privilege_key: key };
  }
  return { allowed: true, reason: null, privilege_key: rows[0].privilege_key || key };
}

export async function assertPrivilegeForGate({
  staffUid, privilegeName, tenantId = null, gate = 'credential_gate', enabled = false,
} = {}) {
  const key = privilegeKey(privilegeName);
  if (!enabled) return { enforced: false, allowed: true, reason: 'flag_disabled', privilege_key: key };
  const verdict = await hasActivePrivilege(staffUid, key, { tenantId });
  if (!verdict.allowed) {
    throw AppError.forbidden(
      `Staff member does not hold an active ${key} privilege`,
      'CLINICAL_PRIVILEGE_REQUIRED',
      { gate, privilege_key: key, reason: verdict.reason },
    );
  }
  return { enforced: true, ...verdict };
}

/** Daily radar job: persists expiring credential alerts and notifies staff. */
export async function expiryRadarSweep() {
  const result = await scanCredentialExpiryAlerts({ days: 30 });
  if (result.created === 0) return { expiring: result.scanned, created: 0 };
  logger.warn(`Credential expiry radar: ${result.created} alert(s) created`, result);
  return { expiring: result.scanned, created: result.created };
}

export const __testing__ = {
  privilegeKey,
  severityForDaysRemaining,
  isGateEnabled,
};

export default {
  addCredential,
  listCredentials,
  updateCredentialStatus,
  listExpiring,
  hasActivePrivilege,
  expiryRadarSweep,
  listPrivilegeCatalog,
  upsertPrivilegeCatalog,
  requestPrivilegeGrant,
  decidePrivilegeApproval,
  listPrivilegeApprovals,
  uploadCredentialDocument,
  scanCredentialExpiryAlerts,
  listCredentialExpiryAlerts,
  acknowledgeCredentialExpiryAlert,
  assertPrivilegeForGate,
};
