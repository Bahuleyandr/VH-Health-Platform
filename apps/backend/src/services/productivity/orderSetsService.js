// src/services/productivity/orderSetsService.js
//
// Sprint 8 — order-set bundles. Doctor picks a set ("Pneumonia adult
// IP order set"), reviews/edits the items, and records what they
// applied for the audit trail. Item objects are JSONB so each kind
// (med/lab/radiology/diet/etc.) carries the shape it needs.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

export async function listSets({ tenantId, specialty, q, includeInactive = false, limit = 200 }) {
  const params = [tenantId];
  const conds = [`tenant_id = $1::uuid`];
  if (!includeInactive) conds.push(`active = true`);
  if (specialty) { params.push(specialty); conds.push(`specialty = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(title ILIKE $${params.length} OR code ILIKE $${params.length})`);
  }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT id, code, title, specialty, condition_codes, description,
            active, created_at,
            (SELECT COUNT(*)::int FROM clinical_order_set_items i
              WHERE i.order_set_id = s.id) AS item_count
       FROM clinical_order_sets s
      WHERE ${conds.join(' AND ')}
      ORDER BY specialty, title
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function getSet({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM clinical_order_sets WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Order set not found');
  const items = await prisma.$queryRawUnsafe(
    `SELECT id, display_order, kind, payload, default_selected
       FROM clinical_order_set_items
      WHERE order_set_id = $1::int
      ORDER BY display_order`,
    Number(id),
  );
  return { ...rows[0], items };
}

export async function getSetByCode({ tenantId, code }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM clinical_order_sets WHERE code = $1 AND tenant_id = $2::uuid`,
    String(code), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Order set not found');
  return getSet({ tenantId, id: rows[0].id });
}

export async function createSet({
  tenantId, code, title, specialty, condition_codes, description,
  items = [], created_by,
}) {
  if (!code || !title) throw AppError.badRequest('code and title required');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_order_sets
       (code, title, specialty, condition_codes, description, created_by, tenant_id)
     VALUES ($1, $2, $3, $4::text[], $5, $6::uuid, $7::uuid)
     RETURNING *`,
    String(code), String(title), specialty || null,
    condition_codes || null, description || null,
    created_by ? String(created_by) : null, tenantId,
  );
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (!it?.kind || !it?.payload) continue;
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_order_set_items
         (order_set_id, display_order, kind, payload, default_selected)
       VALUES ($1::int, $2::int, $3, $4::jsonb, $5)`,
      rows[0].id, Number(it.display_order ?? i + 1),
      String(it.kind), JSON.stringify(it.payload),
      it.default_selected !== false,
    );
  }
  return getSet({ tenantId, id: rows[0].id });
}

export async function applySet({
  tenantId, order_set_id, encounter_id, patient_uid,
  applied_by, items_applied = [], items_skipped = [], notes,
}) {
  if (!order_set_id) throw AppError.badRequest('order_set_id is required');
  // Touch the set (does it exist in this tenant?)
  await getSet({ tenantId, id: order_set_id });

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_order_set_applications
       (order_set_id, encounter_id, patient_uid, applied_by,
        items_applied, items_skipped, notes, tenant_id)
     VALUES ($1::int, $2::int, $3::uuid, $4::uuid,
             $5::jsonb, $6::jsonb, $7, $8::uuid)
     RETURNING *`,
    Number(order_set_id),
    encounter_id ? Number(encounter_id) : null,
    patient_uid ? String(patient_uid) : null,
    applied_by ? String(applied_by) : null,
    JSON.stringify(items_applied),
    JSON.stringify(items_skipped),
    notes || null,
    tenantId,
  );
  return rows[0];
}

export async function listApplicationsForEncounter({ tenantId, encounter_id }) {
  return prisma.$queryRawUnsafe(
    `SELECT a.*, s.code, s.title
       FROM clinical_order_set_applications a
       JOIN clinical_order_sets s ON s.id = a.order_set_id
      WHERE a.tenant_id = $1::uuid AND a.encounter_id = $2::int
      ORDER BY a.applied_at DESC`,
    tenantId, Number(encounter_id),
  );
}
