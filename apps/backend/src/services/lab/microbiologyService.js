// src/services/lab/microbiologyService.js
//
// Sprint 17 — Microbiology orders + isolates + antibiogram. Separate
// from the biochemistry lab path (Sprint 3) because micro has its own
// data shape.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const VALID_SPECIMEN = [
  'blood', 'urine', 'sputum', 'pus', 'csf', 'stool',
  'wound', 'et_secretion', 'tip', 'other',
];

const VALID_TEST_KIND = [
  'culture_sensitivity', 'gram_stain', 'afb_smear', 'afb_culture',
  'fungal_culture', 'mrsa_screen', 'esbl_screen', 'cre_screen', 'kpc_screen',
];

const VALID_GROWTH = [
  'no_growth', 'normal_flora', 'pathogen_isolated', 'mixed_growth', 'contaminated',
];

const VALID_RESULT = ['S', 'I', 'R', 'SDD', 'NS'];

// ── Orders ──────────────────────────────────────────────────────────

export async function createOrder({
  tenantId, patient_uid, admission_id, ordered_by, ordered_by_name,
  specimen_type, specimen_site, collected_at, collected_by,
  test_kind = 'culture_sensitivity', clinical_notes,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!specimen_type) throw AppError.badRequest('specimen_type is required');
  if (!VALID_SPECIMEN.includes(specimen_type)) {
    throw AppError.badRequest(`specimen_type must be one of: ${VALID_SPECIMEN.join(', ')}`);
  }
  if (!VALID_TEST_KIND.includes(test_kind)) {
    throw AppError.badRequest(`test_kind must be one of: ${VALID_TEST_KIND.join(', ')}`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO micro_orders
       (patient_uid, admission_id, ordered_by, ordered_by_name,
        specimen_type, specimen_site, collected_at, collected_by,
        test_kind, clinical_notes, status, tenant_id)
     VALUES ($1::uuid, $2::int, $3::uuid, $4, $5, $6, $7::timestamptz, $8::uuid,
             $9, $10, 'pending', $11::uuid)
     RETURNING *`,
    String(patient_uid),
    admission_id ? Number(admission_id) : null,
    ordered_by ? String(ordered_by) : null,
    ordered_by_name || null,
    specimen_type, specimen_site || null,
    collected_at || null,
    collected_by ? String(collected_by) : null,
    test_kind, clinical_notes || null,
    tenantId,
  );
  return rows[0];
}

export async function getOrder({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM micro_orders WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Microbiology order not found');
  const isolates = await prisma.$queryRawUnsafe(
    `SELECT i.*
       FROM micro_isolates i
       JOIN micro_orders o ON o.id = i.order_id
      WHERE i.order_id = $1::int
        AND o.tenant_id = $2::uuid
      ORDER BY i.id`,
    rows[0].id, tenantId,
  );
  for (const iso of isolates) {
    iso.sensitivities = await prisma.$queryRawUnsafe(
      `SELECT s.id, s.antibiotic_code, s.antibiotic_name, s.result, s.mic_value,
              mic_unit, zone_diameter_mm, method, notes
         FROM micro_sensitivities s
         JOIN micro_isolates i ON i.id = s.isolate_id
         JOIN micro_orders o ON o.id = i.order_id
        WHERE s.isolate_id = $1::int
          AND o.tenant_id = $2::uuid
        ORDER BY s.antibiotic_name`,
      iso.id, tenantId,
    );
  }
  return { ...rows[0], isolates };
}

const ALLOWED_TRANSITIONS = {
  pending: ['collected', 'cancelled'],
  collected: ['received', 'cancelled'],
  received: ['in_progress', 'cancelled'],
  in_progress: ['preliminary', 'final', 'cancelled'],
  preliminary: ['final', 'cancelled'],
  final: [],
  cancelled: [],
};

export async function transitionOrder({
  tenantId, id, status, growth_status, comments, finalised_by, finalised_by_name,
}) {
  const order = await getOrder({ tenantId, id });
  const allowed = ALLOWED_TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(status)) {
    throw AppError.invalidTransition(order.status, status, allowed);
  }
  if (status === 'final' && growth_status && !VALID_GROWTH.includes(growth_status)) {
    throw AppError.badRequest(`growth_status must be one of: ${VALID_GROWTH.join(', ')}`);
  }

  const sets = ['status = $1', 'updated_at = NOW()'];
  const params = [status];
  function set(col, value) {
    if (value === undefined || value === null) return;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  set('growth_status', growth_status || null);
  set('comments', comments || null);

  if (status === 'received') sets.push('received_at = NOW()');
  if (status === 'preliminary') sets.push('preliminary_at = NOW()');
  if (status === 'final') {
    sets.push('finalised_at = NOW()');
    set('finalised_by', finalised_by ? String(finalised_by) : null);
    set('finalised_by_name', finalised_by_name || null);
  }

  params.push(Number(id), tenantId);
  await prisma.$executeRawUnsafe(
    `UPDATE micro_orders SET ${sets.join(', ')}
      WHERE id = $${params.length - 1}::int AND tenant_id = $${params.length}::uuid`,
    ...params,
  );
  return getOrder({ tenantId, id });
}

// ── Isolates ────────────────────────────────────────────────────────

export async function addIsolate({
  tenantId,
  order_id, organism_name, organism_code, colony_count,
  is_mrsa, is_esbl, is_amp_c, is_carbapenemase, is_vre, is_xdr, comments,
}) {
  if (!order_id) throw AppError.badRequest('order_id is required');
  if (!organism_name) throw AppError.badRequest('organism_name is required');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO micro_isolates
       (order_id, organism_name, organism_code, colony_count,
        is_mrsa, is_esbl, is_amp_c, is_carbapenemase, is_vre, is_xdr, comments)
     SELECT o.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       FROM micro_orders o
      WHERE o.id = $1::int
        AND o.tenant_id = $12::uuid
     RETURNING *`,
    Number(order_id), String(organism_name),
    organism_code || null, colony_count || null,
    !!is_mrsa, !!is_esbl, !!is_amp_c, !!is_carbapenemase, !!is_vre, !!is_xdr,
    comments || null, tenantId,
  );
  if (!rows.length) throw AppError.notFound('Microbiology order not found');
  return rows[0];
}

// ── Sensitivities ───────────────────────────────────────────────────

export async function addSensitivity({
  tenantId,
  isolate_id, antibiotic_code, antibiotic_name, result,
  mic_value, mic_unit, zone_diameter_mm, method, notes,
}) {
  if (!isolate_id) throw AppError.badRequest('isolate_id is required');
  if (!antibiotic_code) throw AppError.badRequest('antibiotic_code is required');
  if (!VALID_RESULT.includes(result)) {
    throw AppError.badRequest(`result must be one of: ${VALID_RESULT.join(', ')}`);
  }
  const isolateRows = await prisma.$queryRawUnsafe(
    `SELECT i.id
       FROM micro_isolates i
       JOIN micro_orders o ON o.id = i.order_id
      WHERE i.id = $1::int
        AND o.tenant_id = $2::uuid
      LIMIT 1`,
    Number(isolate_id), tenantId,
  );
  if (!isolateRows.length) throw AppError.notFound('Microbiology isolate not found');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO micro_sensitivities
       (isolate_id, antibiotic_code, antibiotic_name, result,
        mic_value, mic_unit, zone_diameter_mm, method, notes)
     VALUES ($1::int, $2, $3, $4, $5::numeric, $6, $7::int, $8, $9)
     ON CONFLICT (isolate_id, antibiotic_code) DO UPDATE SET
       antibiotic_name = EXCLUDED.antibiotic_name,
       result = EXCLUDED.result,
       mic_value = EXCLUDED.mic_value,
       mic_unit = EXCLUDED.mic_unit,
       zone_diameter_mm = EXCLUDED.zone_diameter_mm,
       method = EXCLUDED.method,
       notes = EXCLUDED.notes
     RETURNING *`,
    Number(isolate_id), String(antibiotic_code), String(antibiotic_name),
    String(result),
    mic_value != null ? Number(mic_value) : null,
    mic_unit || 'mg/L',
    zone_diameter_mm != null ? Number(zone_diameter_mm) : null,
    method || null, notes || null,
  );
  return rows[0];
}

// ── Listings ────────────────────────────────────────────────────────

export async function listOrders({
  tenantId, status, patient_uid, limit = 100,
}) {
  const params = [tenantId];
  const conds = ['tenant_id = $1::uuid'];
  if (status) { params.push(status); conds.push(`status = $${params.length}`); }
  if (patient_uid) {
    params.push(String(patient_uid));
    conds.push(`patient_uid = $${params.length}::uuid`);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 200));
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, specimen_type, specimen_site, test_kind,
            status, growth_status, ordered_by_name, finalised_at, created_at
       FROM micro_orders
      WHERE ${conds.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function antibiogram90d({ tenantId, organism, antibiotic, limit = 200 }) {
  const params = [tenantId];
  const conds = ['tenant_id = $1::uuid', 'total_tested >= 5']; // suppress small-sample noise
  if (organism) {
    params.push(String(organism));
    conds.push(`organism_name ILIKE '%' || $${params.length} || '%'`);
  }
  if (antibiotic) {
    params.push(String(antibiotic));
    conds.push(`antibiotic_name ILIKE '%' || $${params.length} || '%'`);
  }
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
  return prisma.$queryRawUnsafe(
    `SELECT organism_name, antibiotic_code, antibiotic_name,
            total_tested, susceptible_count, susceptible_pct
       FROM antibiogram_90d
      WHERE ${conds.join(' AND ')}
      ORDER BY organism_name, susceptible_pct DESC NULLS LAST
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function listResistantIsolates({ tenantId, limit = 50 }) {
  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.order_id, i.organism_name, i.colony_count,
            i.is_mrsa, i.is_esbl, i.is_amp_c, i.is_carbapenemase, i.is_vre, i.is_xdr,
            o.patient_uid, o.specimen_type, o.specimen_site, o.created_at
       FROM micro_isolates i
       JOIN micro_orders o ON o.id = i.order_id
      WHERE o.tenant_id = $1::uuid
        AND (i.is_mrsa OR i.is_esbl OR i.is_amp_c OR i.is_carbapenemase OR i.is_vre OR i.is_xdr)
        AND o.created_at > NOW() - INTERVAL '30 days'
      ORDER BY o.created_at DESC
      LIMIT $2::int`,
    tenantId, Math.min(Math.max(Number(limit) || 50, 1), 200),
  );
}
