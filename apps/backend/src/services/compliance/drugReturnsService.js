// src/services/compliance/drugReturnsService.js — Sprint 20
//
// Schedule H1 / X drug returns. Workflow:
//   draft → quarantined → approved → dispatched → acknowledged.
// (Or → cancelled at any pre-dispatch stage.)

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const TENANT_FALLBACK = '00000000-0000-4000-8000-000000000001';
function tenantOr(t) { return t || TENANT_FALLBACK; }
function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

// Status walk
export const STATUS_TRANSITIONS = {
  draft:        ['quarantined', 'cancelled'],
  quarantined:  ['approved',    'cancelled'],
  approved:     ['dispatched',  'cancelled'],
  dispatched:   ['acknowledged'],
  acknowledged: [],
  cancelled:    [],
};

const ALLOWED_REASONS = ['expired', 'damaged', 'recalled', 'temp_breach', 'near_expiry', 'other'];
const ALLOWED_COUNTERPARTY = ['manufacturer', 'distributor', 'sdc'];
const ALLOWED_SCHEDULES = ['H', 'H1', 'X', 'G', 'C', 'C1', 'NONE'];

async function nextSerial(tenantId) {
  // Acquire-or-create then bump in a single transaction.
  const sql = `
    INSERT INTO drug_return_serial_counter (tenant_id, next_serial)
    VALUES ($1, 2)
    ON CONFLICT (tenant_id)
    DO UPDATE SET next_serial = drug_return_serial_counter.next_serial + 1
    RETURNING next_serial - 1 AS issued`;
  const rows = await prisma.$queryRawUnsafe(sql, tenantOr(tenantId));
  const r = unwrap(rows);
  return `DRR-${String(r.issued).padStart(6, '0')}`;
}

export async function createBatch({ tenantId, ...body }) {
  if (!body.reason) throw AppError.badRequest('reason required');
  if (!ALLOWED_REASONS.includes(body.reason)) {
    throw AppError.badRequest(`reason must be one of: ${ALLOWED_REASONS.join(', ')}`);
  }
  if (!body.counterparty_kind) throw AppError.badRequest('counterparty_kind required');
  if (!ALLOWED_COUNTERPARTY.includes(body.counterparty_kind)) {
    throw AppError.badRequest(`counterparty_kind must be one of: ${ALLOWED_COUNTERPARTY.join(', ')}`);
  }
  if (!body.counterparty_name) throw AppError.badRequest('counterparty_name required');

  const serial = await nextSerial(tenantId);

  const sql = `
    INSERT INTO drug_return_batches
      (batch_serial, initiated_by, reason,
       counterparty_kind, counterparty_name, counterparty_licence_no,
       status, notes, tenant_id)
    VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    serial, body.initiated_by || null, body.reason,
    body.counterparty_kind, body.counterparty_name,
    body.counterparty_licence_no || null, body.notes || null,
    tenantOr(tenantId));
  return unwrap(rows);
}

export async function getBatch({ tenantId, id }) {
  const headRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM drug_return_batches WHERE id = $1 AND tenant_id = $2`,
    parseInt(id, 10), tenantOr(tenantId));
  const head = unwrap(headRows);
  if (!head) throw AppError.notFound('Drug return batch not found');

  const lines = await prisma.$queryRawUnsafe(
    `SELECT * FROM drug_return_lines WHERE batch_id = $1 ORDER BY id`,
    head.id);
  return { ...head, lines };
}

export async function listBatches({ tenantId, status, reason, limit = 100 }) {
  const conds = ['tenant_id = $1'];
  const args = [tenantOr(tenantId)];
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (reason) { args.push(reason); conds.push(`reason = $${args.length}`); }
  const lim = Math.min(parseInt(limit, 10) || 100, 500);

  const sql = `
    SELECT * FROM drug_return_batches
    WHERE ${conds.join(' AND ')}
    ORDER BY initiated_at DESC
    LIMIT ${lim}`;
  return prisma.$queryRawUnsafe(sql, ...args);
}

export async function addLine({ tenantId, batch_id, ...body }) {
  if (!body.drug_name) throw AppError.badRequest('drug_name required');
  if (!body.mfr_batch_no) throw AppError.badRequest('mfr_batch_no required');
  if (body.qty_units == null || body.qty_units <= 0) {
    throw AppError.badRequest('qty_units must be > 0');
  }
  if (body.schedule && !ALLOWED_SCHEDULES.includes(body.schedule)) {
    throw AppError.badRequest(`schedule must be one of: ${ALLOWED_SCHEDULES.join(', ')}`);
  }

  // Confirm batch belongs to tenant + is still mutable.
  const headRows = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM drug_return_batches WHERE id = $1 AND tenant_id = $2`,
    parseInt(batch_id, 10), tenantOr(tenantId));
  const head = unwrap(headRows);
  if (!head) throw AppError.notFound('Batch not found');
  if (!['draft', 'quarantined'].includes(head.status)) {
    throw AppError.badRequest(`Cannot add lines to batch in status: ${head.status}`);
  }

  // Schedule H1 / X / narcotics need witness for disposal — enforce at
  // line level so quarantining a mixed batch with a schedule-X drug
  // can't proceed without naming the witness.
  const isControlled = body.schedule === 'H1' || body.schedule === 'X' || body.is_narcotic;
  if (isControlled && !body.witness_name) {
    throw AppError.badRequest('Witness name required for Schedule H1 / X / narcotic returns');
  }

  const sql = `
    INSERT INTO drug_return_lines
      (batch_id, drug_name, drug_code, schedule, manufacturer,
       mfr_batch_no, mfr_date, expiry_date, qty_units, qty_uom,
       unit_cost_paise, storage_condition_at_return, is_narcotic,
       witness_uid, witness_name, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
            COALESCE($10, 'unit'), $11, $12, $13, $14, $15, $16)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    head.id, body.drug_name, body.drug_code || null, body.schedule || null,
    body.manufacturer || null, body.mfr_batch_no, body.mfr_date || null,
    body.expiry_date || null, body.qty_units, body.qty_uom || null,
    body.unit_cost_paise || null, body.storage_condition_at_return || null,
    Boolean(body.is_narcotic), body.witness_uid || null,
    body.witness_name || null, body.notes || null);
  return unwrap(rows);
}

export async function transition({ tenantId, id, to_status, set_by, ack_reference_no, disposition_method, quarantine_location }) {
  const headRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM drug_return_batches WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    parseInt(id, 10), tenantOr(tenantId));
  const head = unwrap(headRows);
  if (!head) throw AppError.notFound('Batch not found');

  const allowed = STATUS_TRANSITIONS[head.status] || [];
  if (!allowed.includes(to_status)) {
    throw AppError.invalidTransition(head.status, to_status, allowed);
  }

  // Quarantine → at least one line required (otherwise approving an
  // empty batch would let auditing slip through).
  if (to_status === 'quarantined') {
    const cntRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c FROM drug_return_lines WHERE batch_id = $1`,
      head.id);
    if (unwrap(cntRows).c === 0) {
      throw AppError.badRequest('Add at least one line before quarantining');
    }
  }

  // Acknowledged → reference is required (disposition method too)
  if (to_status === 'acknowledged') {
    if (!ack_reference_no) throw AppError.badRequest('ack_reference_no required');
    if (!disposition_method) throw AppError.badRequest('disposition_method required');
  }

  let extra = '';
  const args = [head.id, tenantOr(tenantId), to_status];
  if (to_status === 'quarantined') {
    args.push(quarantine_location || null);
    extra = `, quarantined_at = NOW(), quarantine_location = $${args.length}`;
  }
  if (to_status === 'approved') {
    args.push(set_by || null);
    extra = `, approved_at = NOW(), approved_by = $${args.length}`;
  }
  if (to_status === 'dispatched') {
    extra = `, dispatched_at = NOW()`;
  }
  if (to_status === 'acknowledged') {
    args.push(ack_reference_no);
    args.push(disposition_method);
    extra = `, acknowledged_at = NOW(),
              ack_reference_no = $${args.length - 1},
              disposition_method = $${args.length}`;
  }

  const sql = `
    UPDATE drug_return_batches
    SET status = $3, updated_at = NOW() ${extra}
    WHERE id = $1 AND tenant_id = $2
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql, ...args);
  return unwrap(rows);
}

// Pure helpers for tests
export const _internal = { STATUS_TRANSITIONS, ALLOWED_REASONS, ALLOWED_COUNTERPARTY };
