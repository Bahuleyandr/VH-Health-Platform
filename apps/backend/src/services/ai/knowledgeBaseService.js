/**
 * Knowledge Base CRUD service.
 *
 * Phase A1 of the structural audit (docs/HEALTHCARE_AI_SPEC_AUDIT.md). The
 * existing ragService.js operates only on signed discharge summaries; this
 * service lets a hospital create knowledge bases (SOPs, antibiotic policies,
 * patient-ed material), upload source documents, and grant per-role access.
 *
 * Layout — three concerns in one file because they share the same audit
 * trail and tenant scoping:
 *   1. KB CRUD (createKnowledgeBase / listKnowledgeBases / get / update / archive)
 *   2. Access-policy grants (listAccessPolicies / grantAccess / revokeAccess)
 *   3. Retrieval gate helper (userCanAccess) — wired by ragService in PR3.
 *
 * This PR ships CRUD + access policies. Document upload + chunking +
 * embedding + retrieval land in PR2/PR3.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

export const KB_TYPES = [
  'general',
  'sop',
  'antibiotic_policy',
  'patient_education',
  'clinical_guideline',
  'formulary',
  'safety_alert',
  'training',
];

export const KB_STATUSES = ['active', 'archived'];

export const KB_PERMISSIONS = ['read', 'write', 'manage'];

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const NAME_MAX = 160;
const DESC_MAX = 2000;

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function safeText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeKbType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'general';
  if (!KB_TYPES.includes(normalized)) {
    throw AppError.badRequest(
      `kb_type must be one of: ${KB_TYPES.join(', ')}`,
    );
  }
  return normalized;
}

function normalizePermission(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'read';
  if (!KB_PERMISSIONS.includes(normalized)) {
    throw AppError.badRequest(
      `permission must be one of: ${KB_PERMISSIONS.join(', ')}`,
    );
  }
  return normalized;
}

function normalizeRole(value) {
  const text = safeText(value, 60);
  if (!text) {
    throw AppError.badRequest('role is required');
  }
  return text.toUpperCase();
}

function normalizeMetadata(value) {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('metadata must be a JSON object');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Knowledge base CRUD
// ---------------------------------------------------------------------------

export async function createKnowledgeBase({
  tenantId = null,
  name,
  description = null,
  kbType = 'general',
  createdBy = null,
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanName = safeText(name, NAME_MAX);
  if (!cleanName) {
    throw AppError.badRequest('name is required');
  }
  const cleanDescription = safeText(description, DESC_MAX);
  const normalizedType = normalizeKbType(kbType);
  const normalizedMeta = normalizeMetadata(metadata);

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO knowledge_bases
         (tenant_id, name, description, kb_type, created_by, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6::jsonb)
       RETURNING id, tenant_id, name, description, kb_type, status,
                 created_by, metadata, created_at, updated_at`,
      tid, cleanName, cleanDescription, normalizedType, createdBy, JSON.stringify(normalizedMeta),
    );
    return rows[0];
  } catch (err) {
    if (/duplicate key value/i.test(String(err?.message || ''))) {
      throw AppError.conflict(`A knowledge base named "${cleanName}" already exists for this tenant`);
    }
    throw err;
  }
}

export async function listKnowledgeBases({
  tenantId = null,
  kbType = null,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = normalizeLimit(limit);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (kbType) {
    params.push(normalizeKbType(kbType));
    filters.push(`kb_type = $${params.length}`);
  }
  if (status) {
    const normalized = String(status).trim().toLowerCase();
    if (!KB_STATUSES.includes(normalized)) {
      throw AppError.badRequest(`status must be one of: ${KB_STATUSES.join(', ')}`);
    }
    params.push(normalized);
    filters.push(`status = $${params.length}`);
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, name, description, kb_type, status, created_by,
              metadata, created_at, updated_at,
              (SELECT COUNT(*)::int
                 FROM knowledge_documents d
                WHERE d.knowledge_base_id = kb.id
                  AND d.tenant_id = kb.tenant_id) AS document_count
       FROM knowledge_bases kb
       WHERE ${filters.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { knowledge_bases: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { knowledge_bases: [], count: 0 };
    throw err;
  }
}

export async function getKnowledgeBase({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(id, 'knowledge_base id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, name, description, kb_type, status, created_by,
            metadata, created_at, updated_at,
            (SELECT COUNT(*)::int
               FROM knowledge_documents d
              WHERE d.knowledge_base_id = kb.id
                AND d.tenant_id = kb.tenant_id) AS document_count,
            (SELECT COUNT(*)::int
               FROM knowledge_chunks c
              WHERE c.knowledge_base_id = kb.id
                AND c.tenant_id = kb.tenant_id) AS chunk_count
     FROM knowledge_bases kb
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    kbId, tid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Knowledge base not found');
  }
  return rows[0];
}

export async function updateKnowledgeBase({
  tenantId = null,
  id,
  name = undefined,
  description = undefined,
  kbType = undefined,
  metadata = undefined,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(id, 'knowledge_base id');

  const updates = [];
  const params = [];
  if (name !== undefined) {
    const cleanName = safeText(name, NAME_MAX);
    if (!cleanName) throw AppError.badRequest('name cannot be empty');
    params.push(cleanName);
    updates.push(`name = $${params.length}`);
  }
  if (description !== undefined) {
    params.push(safeText(description, DESC_MAX));
    updates.push(`description = $${params.length}`);
  }
  if (kbType !== undefined) {
    params.push(normalizeKbType(kbType));
    updates.push(`kb_type = $${params.length}`);
  }
  if (metadata !== undefined) {
    params.push(JSON.stringify(normalizeMetadata(metadata)));
    updates.push(`metadata = $${params.length}::jsonb`);
  }

  if (!updates.length) {
    return getKnowledgeBase({ tenantId: tid, id: kbId });
  }

  updates.push('updated_at = NOW()');
  params.push(kbId);
  params.push(tid);

  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE knowledge_bases
       SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
       RETURNING id, tenant_id, name, description, kb_type, status, created_by,
                 metadata, created_at, updated_at`,
      ...params,
    );
    if (!rows[0]) throw AppError.notFound('Knowledge base not found');
    return rows[0];
  } catch (err) {
    if (/duplicate key value/i.test(String(err?.message || ''))) {
      throw AppError.conflict('A knowledge base with that name already exists for this tenant');
    }
    throw err;
  }
}

export async function archiveKnowledgeBase({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(id, 'knowledge_base id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE knowledge_bases
     SET status = 'archived', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid
     RETURNING id, tenant_id, name, description, kb_type, status, created_by,
               metadata, created_at, updated_at`,
    kbId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Knowledge base not found');
  return rows[0];
}

export async function unarchiveKnowledgeBase({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(id, 'knowledge_base id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE knowledge_bases
     SET status = 'active', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid
     RETURNING id, tenant_id, name, description, kb_type, status, created_by,
               metadata, created_at, updated_at`,
    kbId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Knowledge base not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Access policies
// ---------------------------------------------------------------------------

export async function listAccessPolicies({ tenantId = null, knowledgeBaseId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(knowledgeBaseId, 'knowledge_base_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, knowledge_base_id, tenant_id, role, permission,
              granted_by, granted_at, metadata
       FROM knowledge_access_policies
       WHERE knowledge_base_id = $1 AND tenant_id = $2::uuid
       ORDER BY role, permission`,
      kbId, tid,
    );
    return { policies: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { policies: [], count: 0 };
    throw err;
  }
}

export async function grantAccess({
  tenantId = null,
  knowledgeBaseId,
  role,
  permission = 'read',
  grantedBy = null,
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(knowledgeBaseId, 'knowledge_base_id');
  const normalizedRole = normalizeRole(role);
  const normalizedPermission = normalizePermission(permission);
  const normalizedMeta = normalizeMetadata(metadata);

  // Confirm the KB exists and belongs to this tenant before inserting.
  await getKnowledgeBase({ tenantId: tid, id: kbId });

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO knowledge_access_policies
       (knowledge_base_id, tenant_id, role, permission, granted_by, metadata)
     VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6::jsonb)
     ON CONFLICT (knowledge_base_id, role, permission)
     DO UPDATE SET
       granted_by = EXCLUDED.granted_by,
       metadata = EXCLUDED.metadata,
       granted_at = NOW()
     RETURNING id, knowledge_base_id, tenant_id, role, permission,
               granted_by, granted_at, metadata`,
    kbId, tid, normalizedRole, normalizedPermission, grantedBy, JSON.stringify(normalizedMeta),
  );
  return rows[0];
}

export async function revokeAccess({
  tenantId = null,
  knowledgeBaseId,
  role,
  permission = 'read',
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const kbId = normalizeId(knowledgeBaseId, 'knowledge_base_id');
  const normalizedRole = normalizeRole(role);
  const normalizedPermission = normalizePermission(permission);
  const rows = await prisma.$queryRawUnsafe(
    `DELETE FROM knowledge_access_policies
     WHERE knowledge_base_id = $1
       AND tenant_id = $2::uuid
       AND role = $3
       AND permission = $4
     RETURNING id, knowledge_base_id, role, permission`,
    kbId, tid, normalizedRole, normalizedPermission,
  );
  if (!rows[0]) {
    throw AppError.notFound('Access policy not found');
  }
  return rows[0];
}

/**
 * Permission gate. Returns true if the given role has at least the
 * requested permission on the KB. 'manage' implies 'write' implies 'read'.
 *
 * Resilient to missing schema (returns false if the table doesn't exist).
 */
export async function userCanAccess({
  tenantId = null,
  knowledgeBaseId,
  role,
  permission = 'read',
} = {}) {
  if (!knowledgeBaseId || !role) return false;
  const tid = resolveTenantId({ tenantId });
  const kbId = Number.parseInt(knowledgeBaseId, 10);
  if (!Number.isFinite(kbId) || kbId <= 0) return false;
  const normalizedRole = String(role).toUpperCase();
  const requested = normalizePermission(permission);

  // 'manage' covers everything; 'write' covers read+write; 'read' covers read.
  const permissionRank = { read: 1, write: 2, manage: 3 };
  const requestedRank = permissionRank[requested] || 1;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT permission
       FROM knowledge_access_policies
       WHERE knowledge_base_id = $1 AND tenant_id = $2::uuid AND role = $3`,
      kbId, tid, normalizedRole,
    );
    return rows.some((row) => (permissionRank[row.permission] || 0) >= requestedRank);
  } catch (err) {
    if (isMissingSchemaError(err)) return false;
    logger.warn('userCanAccess query failed', { error: err.message });
    return false;
  }
}

export default {
  KB_PERMISSIONS,
  KB_STATUSES,
  KB_TYPES,
  archiveKnowledgeBase,
  createKnowledgeBase,
  getKnowledgeBase,
  grantAccess,
  listAccessPolicies,
  listKnowledgeBases,
  revokeAccess,
  unarchiveKnowledgeBase,
  updateKnowledgeBase,
  userCanAccess,
};
