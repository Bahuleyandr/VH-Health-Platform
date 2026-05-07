// src/services/productivity/smartPhrasesService.js
//
// Sprint 8 — smart phrases (a.k.a. dot phrases / autotext). Doctors
// type ".dmreview" into any text field and get a long boilerplate
// expansion with placeholders ({{HBA1C}}, {{BP}}, ...) the client
// substitutes from the encounter context.

import prisma from '../../lib/prisma.js';
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
  params.push(Number(limit));
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
  // Bump use_count, fire-and-forget.
  prisma.$executeRawUnsafe(
    `UPDATE smart_phrases SET use_count = use_count + 1, updated_at = NOW() WHERE id = $1::int`,
    rows[0].id,
  ).catch(() => {});
  return rows[0];
}

export async function create({
  tenantId, owner_uid, code, title, body, specialty,
  scope = 'private', placeholders, notes,
}) {
  if (!code || !title || !body) throw AppError.badRequest('code, title, body required');
  if (!String(code).startsWith('.')) throw AppError.badRequest('code must start with "."');
  if (scope === 'private' && !owner_uid) {
    throw AppError.badRequest('private scope requires owner_uid');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO smart_phrases
       (code, title, body, specialty, scope, owner_uid, placeholders, notes, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::text[], $8, $9::uuid)
     RETURNING *`,
    String(code), String(title), String(body),
    specialty || null, scope,
    scope === 'private' && owner_uid ? String(owner_uid) : null,
    placeholders || null, notes || null, tenantId,
  );
  return rows[0];
}

export async function update({ tenantId, id, owner_uid, ...patch }) {
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
  // Owner can edit own private; admins handle tenant-shared via routes.
  let where = `id = $${params.length - 1}::int AND tenant_id = $${params.length}::uuid`;
  if (owner_uid) {
    params.push(String(owner_uid));
    where += ` AND (scope = 'tenant_shared' OR owner_uid = $${params.length}::uuid)`;
  }
  await prisma.$executeRawUnsafe(
    `UPDATE smart_phrases SET ${sets.join(', ')}, updated_at = NOW() WHERE ${where}`,
    ...params,
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM smart_phrases WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  return rows[0] || null;
}

export async function remove({ tenantId, id, owner_uid }) {
  // Soft-delete only; keep audit trail of past use.
  await prisma.$executeRawUnsafe(
    `UPDATE smart_phrases SET active = false, updated_at = NOW()
      WHERE id = $1::int AND tenant_id = $2::uuid
        AND (scope = 'tenant_shared' OR owner_uid = $3::uuid)`,
    Number(id), tenantId,
    owner_uid ? String(owner_uid) : null,
  );
  return { ok: true };
}
