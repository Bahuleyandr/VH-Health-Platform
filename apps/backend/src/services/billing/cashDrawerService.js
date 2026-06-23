// src/services/billing/cashDrawerService.js
//
// Wave-2 fix — cashier shift-close / cash-drawer reconciliation. Pairs
// with migration 198_cash_drawer_sessions.sql. Surfaced via the
// billingV2 routes. Findings:
//   2026-05-09-inpatient-admission-billing-no-cashier-shift-reconciliation
//   2026-05-10-inpatient-admission-billing-cash-drawer-reconciliation-missing

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const SESSION_RETURNING = `id, tenant_id, cashier_uid, shift,
  opened_at, opening_float,
  closed_at, counted_total, counted_denominations,
  system_total, variance, short_count, over_count,
  requires_review, variance_reason, status,
  reviewed_by, reviewed_at, review_notes,
  created_at, updated_at`;

const VALID_SHIFTS = ['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT', 'GENERAL'];

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Below this absolute variance, the session is auto-marked 'reviewed'
// at close-time. Above it, requires_review stays true until a
// FINANCE_INCHARGE / ADMIN signs it off.
export const VARIANCE_TOLERANCE = envNumber(
  'CASH_DRAWER_VARIANCE_TOLERANCE',
  1,
);

function toFixed2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function requireUuid(value, label) {
  if (!value) throw AppError.badRequest(`${label} is required`);
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeShift(value) {
  if (!value) throw AppError.badRequest('shift is required');
  const text = String(value).trim().toUpperCase();
  if (!VALID_SHIFTS.includes(text)) {
    throw AppError.badRequest(`shift must be one of ${VALID_SHIFTS.join(', ')}`);
  }
  return text;
}

function sumDenominations(denoms) {
  if (denoms === null || denoms === undefined) return 0;
  if (typeof denoms !== 'object' || Array.isArray(denoms)) {
    throw AppError.badRequest('counted_denominations must be a JSON object of { denomination: count }');
  }
  let total = 0;
  for (const [face, count] of Object.entries(denoms)) {
    const f = Number(face);
    const c = Number(count);
    if (!Number.isFinite(f) || f <= 0) {
      throw AppError.badRequest(`Invalid denomination face value: ${face}`);
    }
    if (!Number.isFinite(c) || c < 0 || !Number.isInteger(c)) {
      throw AppError.badRequest(`Invalid note/coin count for ₹${face}: ${count}`);
    }
    total += f * c;
  }
  return toFixed2(total);
}

export async function openSession({
  tenantId, cashier_uid, shift, opening_float = 0,
}) {
  const tid = requireUuid(tenantId, 'tenant_id');
  const uid = requireUuid(cashier_uid, 'cashier_uid');
  const normalizedShift = normalizeShift(shift);
  const floatAmount = toFixed2(Number(opening_float) || 0);
  if (floatAmount < 0) throw AppError.badRequest('opening_float cannot be negative');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO cash_drawer_sessions
         (tenant_id, cashier_uid, shift, opening_float)
       VALUES ($1::uuid, $2::uuid, $3, $4::numeric)
       RETURNING ${SESSION_RETURNING}`,
      tid, uid, normalizedShift, floatAmount,
    );
    return rows[0];
  } catch (err) {
    if (/duplicate key|unique constraint/i.test(err.message || '')) {
      throw AppError.conflict(
        'An open cash-drawer session already exists for this cashier/shift',
        'CASH_DRAWER_SESSION_OPEN',
      );
    }
    throw err;
  }
}

export async function closeSession({
  tenantId, id, cashier_uid, counted_denominations, variance_reason,
}) {
  const tid = requireUuid(tenantId, 'tenant_id');
  const actorUid = requireUuid(cashier_uid, 'cashier_uid');
  const sessionId = Number.parseInt(id, 10);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    throw AppError.badRequest('session id must be a positive integer');
  }

  const [session] = await prisma.$queryRawUnsafe(
    `SELECT id, cashier_uid, shift, opened_at, opening_float, status
       FROM cash_drawer_sessions
      WHERE id = $1 AND tenant_id = $2::uuid`,
    sessionId, tid,
  );
  if (!session) throw AppError.notFound('Cash-drawer session not found');
  if (String(session.cashier_uid) !== String(actorUid)) {
    throw AppError.forbidden('Only the cashier who opened the session can close it');
  }
  if (session.status !== 'open') {
    throw AppError.badRequest(
      `Cannot close a session that is already ${session.status}`,
      'CASH_DRAWER_SESSION_NOT_OPEN',
    );
  }

  const countedTotal = sumDenominations(counted_denominations);
  // Reconciliation window — system_total = every non-reversed CASH payment by
  // this cashier, this shift, collected at/after the session opened. The lower
  // bound has NO matching upper bound by design, and that is SOUND (not the
  // "cross-session double-count" that audit M5 conjectured — verified a false
  // positive 2026-06-23). The soundness is load-bearing on two invariants:
  //   1. `uq_cash_drawer_sessions_open` UNIQUE (tenant_id, cashier_uid, shift)
  //      WHERE status='open' (migration 198) ⇒ at most ONE open session per
  //      (cashier, shift), so two sessions that could both match a payment are
  //      strictly SEQUENTIAL — the earlier must close before the later opens.
  //   2. `billing_payments.collected_at` is insert-time CURRENT_TIMESTAMP
  //      (collectPaymentTx never sets it) ⇒ a later same-(cashier,shift)
  //      session's payments have collected_at > the earlier session's close
  //      time, so they did not exist at the earlier (one-and-only) close; and
  //      the earlier session's payments are < the later opened_at, excluded
  //      here by `collected_at >= opened_at`. Hence no payment is summed twice.
  // If you ever relax invariant 1 (e.g. shared multi-cashier drawers) you MUST
  // add explicit per-payment session membership (a cash_drawer_session_id stamp)
  // before trusting this window. Caveat: a CASH payment with NULL collected_by
  // or NULL shift matches no session and is invisible here (an under-count, the
  // separate residual the M5 verifiers flagged) — collectPayment requires shift
  // for CASH; a collected_by audit query can surface any legacy orphans.
  const [systemRow] = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(CASE WHEN reversed THEN 0 ELSE amount END), 0)::numeric AS system_total
       FROM billing_payments
      WHERE tenant_id = $1::uuid
        AND mode = 'CASH'
        AND collected_by = $2::uuid
        AND shift = $3
        AND collected_at >= $4::timestamptz`,
    tid, actorUid, session.shift, session.opened_at,
  );
  const systemTotal = toFixed2(Number(systemRow?.system_total || 0));
  const expectedCounted = toFixed2(systemTotal + Number(session.opening_float || 0));
  const variance = toFixed2(countedTotal - expectedCounted);
  const shortCount = variance < 0;
  const overCount = variance > 0;
  const absVariance = Math.abs(variance);
  const withinTolerance = absVariance <= VARIANCE_TOLERANCE;
  const newStatus = withinTolerance ? 'reviewed' : 'closed';
  const requiresReview = !withinTolerance;
  const reason = variance_reason ? String(variance_reason).slice(0, 500) : null;
  if (requiresReview && !reason) {
    throw AppError.badRequest(
      `variance_reason is required when |variance| > ${VARIANCE_TOLERANCE}`,
      'CASH_DRAWER_VARIANCE_REASON_REQUIRED',
      { variance, tolerance: VARIANCE_TOLERANCE },
    );
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE cash_drawer_sessions
        SET closed_at = NOW(),
            counted_total = $1::numeric,
            counted_denominations = $2::jsonb,
            system_total = $3::numeric,
            variance = $4::numeric,
            short_count = $5,
            over_count = $6,
            requires_review = $7,
            variance_reason = $8,
            status = $9,
            reviewed_at = CASE WHEN $7 = FALSE THEN NOW() ELSE NULL END,
            reviewed_by = CASE WHEN $7 = FALSE THEN $10::uuid ELSE NULL END,
            updated_at = NOW()
      WHERE id = $11 AND tenant_id = $12::uuid AND status = 'open'
      RETURNING ${SESSION_RETURNING}`,
    countedTotal,
    JSON.stringify(counted_denominations || {}),
    systemTotal,
    variance,
    shortCount,
    overCount,
    requiresReview,
    reason,
    newStatus,
    actorUid,
    sessionId,
    tid,
  );
  if (!rows[0]) throw AppError.conflict('Session state changed; reload and retry');
  return rows[0];
}

export async function reviewSession({
  tenantId, id, reviewer_uid, review_notes,
}) {
  const tid = requireUuid(tenantId, 'tenant_id');
  const reviewerUid = requireUuid(reviewer_uid, 'reviewer_uid');
  const sessionId = Number.parseInt(id, 10);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    throw AppError.badRequest('session id must be a positive integer');
  }
  const notes = review_notes ? String(review_notes).slice(0, 500) : null;
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE cash_drawer_sessions
        SET status = 'reviewed',
            reviewed_by = $1::uuid,
            reviewed_at = NOW(),
            review_notes = $2,
            requires_review = FALSE,
            updated_at = NOW()
      WHERE id = $3 AND tenant_id = $4::uuid AND status = 'closed'
      RETURNING ${SESSION_RETURNING}`,
    reviewerUid, notes, sessionId, tid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Session not found or not in closed state');
  }
  return rows[0];
}

export async function listSessions({
  tenantId, cashier_uid, shift, status, requires_review, limit = 100,
}) {
  const tid = requireUuid(tenantId, 'tenant_id');
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (cashier_uid) {
    params.push(requireUuid(cashier_uid, 'cashier_uid'));
    filters.push(`cashier_uid = $${params.length}::uuid`);
  }
  if (shift) {
    params.push(normalizeShift(shift));
    filters.push(`shift = $${params.length}`);
  }
  if (status) {
    const s = String(status).toLowerCase();
    if (!['open', 'closed', 'reviewed'].includes(s)) {
      throw AppError.badRequest('status must be one of open, closed, reviewed');
    }
    params.push(s);
    filters.push(`status = $${params.length}`);
  }
  if (requires_review !== undefined && requires_review !== null) {
    const r = requires_review === true || requires_review === 'true'
      || requires_review === 1 || requires_review === '1';
    params.push(r);
    filters.push(`requires_review = $${params.length}`);
  }
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  params.push(safeLimit);
  return prisma.$queryRawUnsafe(
    `SELECT ${SESSION_RETURNING}
       FROM cash_drawer_sessions
      WHERE ${filters.join(' AND ')}
      ORDER BY opened_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function getSession({ tenantId, id }) {
  const tid = requireUuid(tenantId, 'tenant_id');
  const sessionId = Number.parseInt(id, 10);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    throw AppError.badRequest('session id must be a positive integer');
  }
  const [row] = await prisma.$queryRawUnsafe(
    `SELECT ${SESSION_RETURNING}
       FROM cash_drawer_sessions
      WHERE id = $1 AND tenant_id = $2::uuid`,
    sessionId, tid,
  );
  if (!row) throw AppError.notFound('Cash-drawer session not found');
  return row;
}
