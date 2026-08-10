// src/services/productivity/smartPhrasesService.js
//
// Sprint 8 — smart phrases (a.k.a. dot phrases / autotext). Doctors
// type ".dmreview" into any text field and get a long boilerplate
// expansion with placeholders ({{HBA1C}}, {{BP}}, ...) the client
// substitutes from the encounter context.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

export async function listForUser({ tenantId, owner_uid, specialty, q, limit = 200 }) {
  const params = [tenantId];
  const conds = [`tenant_id = $1::uuid`, `active = true`];
  // Both private (mine) AND tenant-shared.
  if (owner_uid) {
    params.push(String(owner_uid));
    conds.push(`(scope = 'tenant_shared' OR (scope = 'private' AND owner_uid = $${params.length}::uuid))`);
  } else {
    conds.push(`scope = 'tenant_shared'`);
  }
  if (specialty) { params.push(specialty); conds.push(`specialty = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(code ILIKE $${params.length} OR title ILIKE $${params.length})`);
  }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
  return prisma.$queryRawUnsafe(
    `SELECT id, code, title, body, specialty, scope, owner_uid,
            placeholders, use_count, active, created_at
       FROM smart_phrases
      WHERE ${conds.join(' AND ')}
      ORDER BY use_count DESC, code
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function lookup({ tenantId, owner_uid, code }) {
  if (!code) throw AppError.badRequest('code is required');
  // Private overrides shared (a doctor can shadow a tenant template).
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM smart_phrases
      WHERE tenant_id = $1::uuid AND code = $2 AND active = true
        AND (scope = 'tenant_shared'
             OR (scope = 'private' AND owner_uid = $3::uuid))
      ORDER BY CASE WHEN scope = 'private' THEN 0 ELSE 1 END
      LIMIT 1`,
    tenantId, String(code),
    owner_uid ? String(owner_uid) : null,
  );
  if (!rows.length) throw AppError.notFound(`Smart phrase ${code} not found`);
  // Bump use_count, fire-and-forget (lookup still succeeds if the bump fails).
  prisma.$executeRawUnsafe(
    `UPDATE smart_phrases SET use_count = use_count + 1, updated_at = NOW() WHERE id = $1::int`,
    rows[0].id,
  ).catch((err) => {
    logger.warn('Smart phrase use_count bump failed', {
      phraseId: rows[0].id,
      code: rows[0].code,
      error: err.message,
    });
  });
  return rows[0];
}

export async function create({
  tenantId, owner_uid, code, title, body, specialty,
  scope = 'private', placeholders, notes, can_manage_shared = false,
}) {
  if (!code || !title || !body) throw AppError.badRequest('code, title, body required');
  if (!String(code).startsWith('.')) throw AppError.badRequest('code must start with "."');
  if (scope === 'private' && !owner_uid) {
    throw AppError.badRequest('private scope requires owner_uid');
  }
  if (scope === 'tenant_shared' && !can_manage_shared) {
    throw AppError.forbidden('Only admins can create tenant-shared smart phrases');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO smart_phrases
       (code, title, body, specialty, scope, owner_uid, placeholders, notes, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::text[], $8, $9::uuid)
     RETURNING *`,
    String(code), String(title), String(body),
    specialty || null, scope,
    owner_uid ? String(owner_uid) : null,
    placeholders || null, notes || null, tenantId,
  );
  return rows[0];
}

export async function update({ tenantId, id, owner_uid, can_manage_shared = false, ...patch }) {
  const allowed = ['title', 'body', 'specialty', 'placeholders', 'active', 'notes'];
  const sets = []; const params = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      params.push(patch[k]);
      sets.push(`${k} = $${params.length}${k === 'placeholders' ? '::text[]' : ''}`);
    }
  }
  if (!sets.length) return null;
  params.push(Number(id));
  params.push(tenantId);
  // Owners can edit their own private phrases. Tenant-shared phrases are
  // mutable only by their creator/owner or an explicit admin route caller.
  let where = `id = $${params.length - 1}::int AND tenant_id = $${params.length}::uuid`;
  if (owner_uid) {
    params.push(String(owner_uid));
    params.push(Boolean(can_manage_shared));
    where += ` AND (
      (scope = 'private' AND owner_uid = $${params.length - 1}::uuid)
      OR (scope = 'tenant_shared' AND owner_uid = $${params.length - 1}::uuid)
      OR (scope = 'tenant_shared' AND $${params.length}::boolean = TRUE)
    )`;
  } else if (!can_manage_shared) {
    throw AppError.forbidden('Smart phrase ownership is required');
  } else {
    params.push(Boolean(can_manage_shared));
    where += ` AND (scope = 'tenant_shared' AND $${params.length}::boolean = TRUE)`;
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE smart_phrases SET ${sets.join(', ')}, updated_at = NOW() WHERE ${where}
      RETURNING *`,
    ...params,
  );
  if (!rows.length) throw AppError.notFound('Smart phrase not found');
  return rows[0];
}

export async function remove({ tenantId, id, owner_uid, can_manage_shared = false }) {
  const canManageShared = can_manage_shared === true;
  // Soft-delete only; keep audit trail of past use.
  const params = [Number(id), tenantId];
  let where = `id = $1::int AND tenant_id = $2::uuid`;
  if (owner_uid) {
    params.push(String(owner_uid));
    params.push(canManageShared);
    where += ` AND (
      (scope = 'private' AND owner_uid = $3::uuid)
      OR (scope = 'tenant_shared' AND owner_uid = $3::uuid)
      OR (scope = 'tenant_shared' AND $4::boolean = TRUE)
    )`;
  } else if (canManageShared) {
    params.push(canManageShared);
    where += ` AND scope = 'tenant_shared' AND $3::boolean = TRUE`;
  } else {
    throw AppError.forbidden('Smart phrase ownership is required');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE smart_phrases SET active = false, updated_at = NOW()
      WHERE ${where}
      RETURNING id`,
    ...params,
  );
  if (!rows.length) throw AppError.notFound('Smart phrase not found');
  return { ok: true };
}
