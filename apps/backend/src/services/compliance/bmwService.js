// src/services/compliance/bmwService.js — Sprint 20
//
// Bio-medical waste log per BMW Rules 2016. Each row = one
// collection event. Monthly + annual rollups feed SPCB Form IV.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const TENANT_FALLBACK = '00000000-0000-4000-8000-000000000001';
function tenantOr(t) { return t || TENANT_FALLBACK; }
function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

const ALLOWED_DESTINATIONS = ['cssd', 'cbwtf', 'incinerator', 'return_pharma', 'autoclave'];

// Soft daily ceiling per category — rule of thumb for a 100-bed hospital.
// Real ceilings vary by category licence; this is for a "looks wrong"
// alert, not a hard block.
const DAILY_CEILING_KG = { yellow: 50, red: 25, white: 5, blue: 10 };

function checkCeiling({ yellow_kg, red_kg, white_kg, blue_kg }) {
  return (yellow_kg || 0) > DAILY_CEILING_KG.yellow ||
    (red_kg || 0) > DAILY_CEILING_KG.red ||
    (white_kg || 0) > DAILY_CEILING_KG.white ||
    (blue_kg || 0) > DAILY_CEILING_KG.blue;
}

export async function createWasteLog({ tenantId, ...body }) {
  if (!body.source_dept) throw AppError.badRequest('source_dept required');
  if (!body.destination) throw AppError.badRequest('destination required');
  if (!ALLOWED_DESTINATIONS.includes(body.destination)) {
    throw AppError.badRequest(`destination must be one of: ${ALLOWED_DESTINATIONS.join(', ')}`);
  }
  const total = (body.yellow_kg || 0) + (body.red_kg || 0) +
    (body.white_kg || 0) + (body.blue_kg || 0);
  if (total <= 0) {
    throw AppError.badRequest('At least one category must have non-zero weight');
  }

  const ceiling = checkCeiling(body);

  const sql = `
    INSERT INTO bmw_waste_log
      (log_date, log_time, source_dept, source_ward, destination,
       yellow_kg, red_kg, white_kg, blue_kg, bag_count, bag_barcodes,
       vehicle_no, cbwtf_operator, manifest_no, weighed_by, received_by,
       photo_keys, notes, ceiling_exceeded, created_by, tenant_id)
    VALUES (COALESCE($1::date, CURRENT_DATE), COALESCE($2::time, CURRENT_TIME),
            $3, $4, $5,
            COALESCE($6, 0), COALESCE($7, 0), COALESCE($8, 0), COALESCE($9, 0),
            $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    body.log_date || null, body.log_time || null,
    body.source_dept, body.source_ward || null, body.destination,
    body.yellow_kg || 0, body.red_kg || 0, body.white_kg || 0, body.blue_kg || 0,
    body.bag_count || null, body.bag_barcodes || null,
    body.vehicle_no || null, body.cbwtf_operator || null,
    body.manifest_no || null, body.weighed_by || null,
    body.received_by || null, body.photo_keys || null,
    body.notes || null, ceiling, body.created_by || null, tenantOr(tenantId));
  return unwrap(rows);
}

export async function listWasteLogs({ tenantId, from, to, source_dept, limit = 200 }) {
  const conds = ['tenant_id = $1'];
  const args = [tenantOr(tenantId)];
  if (from) { args.push(from); conds.push(`log_date >= $${args.length}::date`); }
  if (to) { args.push(to); conds.push(`log_date <= $${args.length}::date`); }
  if (source_dept) { args.push(source_dept); conds.push(`source_dept = $${args.length}`); }
  const lim = Math.min(parseInt(limit, 10) || 200, 1000);

  const sql = `
    SELECT * FROM bmw_waste_log
    WHERE ${conds.join(' AND ')}
    ORDER BY log_date DESC, log_time DESC
    LIMIT ${lim}`;
  return prisma.$queryRawUnsafe(sql, ...args);
}

export async function monthlyRollup({ tenantId, year }) {
  const y = parseInt(year, 10) || new Date().getFullYear();
  const sql = `
    SELECT * FROM bmw_monthly_rollup
    WHERE tenant_id = $1
      AND month_start >= make_date($2::int, 1, 1)
      AND month_start <  make_date(($2::int + 1), 1, 1)
    ORDER BY month_start`;
  return prisma.$queryRawUnsafe(sql, tenantOr(tenantId), y);
}

export async function annualSummary({ tenantId, year }) {
  const y = parseInt(year, 10) || new Date().getFullYear();
  const sql = `
    SELECT
      $2::int AS year,
      COUNT(*)::int                  AS total_collection_events,
      SUM(yellow_kg)::numeric(10, 2) AS yellow_kg,
      SUM(red_kg)::numeric(10, 2)    AS red_kg,
      SUM(white_kg)::numeric(10, 2)  AS white_kg,
      SUM(blue_kg)::numeric(10, 2)   AS blue_kg,
      SUM(total_kg)::numeric(10, 2)  AS total_kg
    FROM bmw_waste_log
    WHERE tenant_id = $1
      AND log_date >= make_date($2::int, 1, 1)
      AND log_date <  make_date(($2::int + 1), 1, 1)`;
  const rows = await prisma.$queryRawUnsafe(sql, tenantOr(tenantId), y);
  return unwrap(rows);
}

// Pure-compute exports for unit tests
export const _internal = { checkCeiling, DAILY_CEILING_KG, ALLOWED_DESTINATIONS };
