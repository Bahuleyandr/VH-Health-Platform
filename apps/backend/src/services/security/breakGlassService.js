// src/services/security/breakGlassService.js
//
// CareTeam ABAC — PHI-access break-glass activation lifecycle (design §5).
//
// The ABAC engine (accessDecisionService.js) already RECOGNISES an active
// `patient_access_break_glass` row as relationship-chain step 4
// (`findActiveBreakGlass`) and stamps every subsequent PHI hit as
// access_source='break_glass'. What was missing — and what this service adds —
// is the LIFECYCLE: a way to ACTIVATE a break-glass override, REVOKE it, and
// SWEEP expired ones to a terminal state for audit cleanliness.
//
// This is the control that makes `enforce` mode usable: a break-glass-eligible
// clinician who is genuinely locked out of a patient's chart in an emergency
// can audibly override, with a mandatory reason, a time-boxed window, and a
// LOUD security alert (Slack/PagerDuty + audit_log) — break-glass must never be
// silent.
//
// Conventions (apps/backend/CLAUDE.md):
//   * One atomic transaction per state change via setTenantTx (tenant-scoped
//     RLS GUC active), writing the break-glass row + its status-history row
//     together so the audit trail can never diverge from the live row.
//   * Reason ≥8 chars is validated in-app (mirrors the table CHECK
//     chk_break_glass_reason_minimum, migration 260) so the caller gets a clean
//     400 instead of a 23514 leak.
//   * expires_at = NOW() + 2h default, capped 24h — mirrors the AI break-glass
//     pattern (clinicalAiWorkflowService.startBreakGlass).
//   * AppError for typed failures; raw params spread (never an array); bare
//     params inside jsonb_build_object cast with ::type (lint:raw-params).

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { logSecurityEvent } from '../../utils/securityAuditLogger.js';
import { sendSecurityWebhook } from '../../utils/securityWebhook.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getRolePolicy } from '../../config/rolePolicyGraph.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Minimum reason length — mirrors the DB CHECK (migration 260:254-255) so a
// too-short reason fails as a clean 400 before it can hit the constraint.
export const BREAK_GLASS_REASON_MIN_LENGTH = 8;

// Time-box defaults — mirror the AI break-glass pattern
// (clinicalAiWorkflowService.startBreakGlass: 2h default, 24h cap).
export const BREAK_GLASS_DEFAULT_HOURS = 2;
export const BREAK_GLASS_MAX_HOURS = 24;

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

function normalizeRole(value) {
  return String(value || '').trim().toUpperCase();
}

function clampHours(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return BREAK_GLASS_DEFAULT_HOURS;
  if (parsed < 1) return 1;
  if (parsed > BREAK_GLASS_MAX_HOURS) return BREAK_GLASS_MAX_HOURS;
  return parsed;
}

/**
 * Is this role permitted to break glass at all? Authoritative source is the
 * role→PHI policy graph's `phi.can_break_glass` flag (rolePolicyGraph.js:1389
 * — currently SUPER_ADMIN / ADMIN / CMO / MEDICAL_SUPERINTENDENT). The route
 * layer also gates via wrapAutoRBAC, but the service re-checks so it is safe to
 * call from any context (cron, internal job, future surfaces) and so the
 * eligibility decision lives in exactly one place.
 *
 * NOTE (governance follow-up): widening this set to front-line clinical roles
 * (DOCTOR tiers, charge nurses) is a clinical-governance decision and is
 * deliberately NOT done here — see design §8 open-question 1. Until then,
 * front-line clinicians rely on the explicit relationship chain (care-team,
 * authorship, appointment, admission) for access.
 */
export function roleCanBreakGlass(role) {
  const code = normalizeRole(role);
  if (!code) return false;
  const policy = getRolePolicy().roles.find((r) => r.role_code === code);
  return Boolean(policy?.phi?.can_break_glass);
}

function mapBreakGlassRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    patient_uid: row.patient_uid,
    actor_uid: row.actor_uid,
    actor_role: row.actor_role,
    reason: row.reason,
    status: row.status,
    started_at: row.started_at,
    expires_at: row.expires_at,
    ended_at: row.ended_at ?? null,
    ended_by: row.ended_by ?? null,
    created_at: row.created_at,
  };
}

/**
 * Emit the LOUD security signal for a break-glass lifecycle event. Break-glass
 * must never be silent — this fires BOTH the external webhook (Slack/PagerDuty)
 * AND the persistent security audit log. Both are fire-and-forget and must
 * never throw into the caller's transaction path.
 *
 * @param {'ACTIVATED'|'REVOKED'} action
 */
function alertBreakGlass(action, row, actorUid) {
  const eventType = action === 'REVOKED'
    ? 'PHI_BREAK_GLASS_REVOKED'
    : 'PHI_BREAK_GLASS_ACTIVATED';
  try {
    // External webhook — routed to the critical channel. SUSPICIOUS_ACTIVITY is
    // in securityWebhook's CRITICAL_EVENTS set; this event name is bespoke, so
    // we pass a clearly-critical-shaped payload (the helper still delivers it).
    sendSecurityWebhook(eventType, {
      userId: actorUid || row?.actor_uid || null,
      path: `/api/v1/patient-access/break-glass${action === 'REVOKED' ? `/${row?.id}` : ''}`,
      reason: row?.reason
        ? `patient=${row.patient_uid} role=${row.actor_role || 'UNKNOWN'} expires=${row.expires_at || 'n/a'} :: ${row.reason}`
        : `patient=${row?.patient_uid}`,
    });
  } catch (err) {
    logger.warn('break-glass webhook alert failed', { eventType, error: err?.message });
  }
  // Persistent audit — survives even when webhooks are disabled.
  logSecurityEvent(eventType, {
    userId: actorUid || row?.actor_uid || null,
    userRole: row?.actor_role || null,
    path: '/api/v1/patient-access/break-glass',
    method: action === 'REVOKED' ? 'DELETE' : 'POST',
    statusCode: action === 'REVOKED' ? 200 : 201,
    reason: `PHI break-glass ${action.toLowerCase()} for patient ${row?.patient_uid} (break_glass_id=${row?.id})`,
  });
  logger.warn(`SECURITY: PHI break-glass ${action.toLowerCase()}`, {
    breakGlassId: row?.id,
    patientUid: row?.patient_uid,
    actorUid: actorUid || row?.actor_uid,
    actorRole: row?.actor_role,
    expiresAt: row?.expires_at,
  });
}

/**
 * Activate a PHI-access break-glass override for one patient by one actor.
 *
 * Writes a `patient_access_break_glass` row (status 'active') AND its first
 * `patient_access_break_glass_status_history` row in a single tenant-scoped
 * transaction, then emits the loud security signal. The engine immediately
 * recognises the active row on the actor's next PHI request.
 *
 * @param {object} args
 * @param {string} args.tenantId       Authenticated tenant (req.tenantId).
 * @param {string} args.patientUid     Patient the override applies to.
 * @param {string} args.actorUid       Clinician activating (the glass-breaker).
 * @param {string} [args.actorRole]    Actor role (for audit + eligibility).
 * @param {string} args.reason         Free-text justification, ≥8 chars.
 * @param {number} [args.expiresInHours] 1–24, default 2.
 * @returns {Promise<object>} the created break-glass row.
 */
export async function activateBreakGlass({
  tenantId,
  patientUid,
  actorUid,
  actorRole,
  reason,
  expiresInHours,
} = {}) {
  const tid = requireTenantId(cleanUuid(tenantId));
  const patient = cleanUuid(patientUid);
  const actor = cleanUuid(actorUid);
  const role = normalizeRole(actorRole);
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';

  if (!patient) throw AppError.badRequest('patient_uid must be a valid UUID', 'INVALID_PATIENT_UID');
  if (!actor) throw AppError.badRequest('actor_uid must be a valid UUID', 'INVALID_ACTOR_UID');
  if (cleanReason.length < BREAK_GLASS_REASON_MIN_LENGTH) {
    throw AppError.badRequest(
      `reason must be at least ${BREAK_GLASS_REASON_MIN_LENGTH} characters`,
      'BREAK_GLASS_REASON_TOO_SHORT',
    );
  }
  if (!roleCanBreakGlass(role)) {
    // Defense-in-depth behind the route RBAC gate — never let an ineligible
    // role create an override even if it somehow reaches this service.
    throw AppError.forbidden('This role is not permitted to break glass', 'BREAK_GLASS_ROLE_INELIGIBLE');
  }

  const hours = clampHours(expiresInHours);

  const row = await setTenantTx(tid, async (tx) => {
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO patient_access_break_glass (
         tenant_id, patient_uid, actor_uid, actor_role, reason, status,
         started_at, expires_at, metadata, created_by, updated_by, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, 'active',
         NOW(), NOW() + ($6::int * INTERVAL '1 hour'),
         jsonb_build_object('expires_in_hours', $6::int, 'source', 'patient_access_break_glass_endpoint'),
         $3::uuid, $3::uuid, NOW(), NOW()
       )
       RETURNING id, tenant_id::text AS tenant_id, patient_uid::text AS patient_uid,
                 actor_uid::text AS actor_uid, actor_role, reason, status,
                 started_at, expires_at, ended_at, ended_by, created_at`,
      tid,
      patient,
      actor,
      role || null,
      cleanReason,
      hours,
    );
    const created = inserted[0];

    await tx.$executeRawUnsafe(
      `INSERT INTO patient_access_break_glass_status_history (
         tenant_id, break_glass_id, patient_uid, actor_uid,
         from_status, to_status, reason, changed_by, metadata,
         created_by, updated_by, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::int, $3::uuid, $4::uuid,
         NULL, 'active', $5, $4::uuid,
         jsonb_build_object('expires_at', $6::text),
         $4::uuid, $4::uuid, NOW(), NOW()
       )`,
      tid,
      created.id,
      patient,
      actor,
      cleanReason,
      created.expires_at ? new Date(created.expires_at).toISOString() : null,
    );

    return created;
  });

  alertBreakGlass('ACTIVATED', row, actor);
  return mapBreakGlassRow(row);
}

/**
 * Revoke an active break-glass override before it expires.
 *
 * Flips the row to status 'revoked' (terminal) and records the transition in
 * status history, in one tenant-scoped transaction. Only an 'active' row can be
 * revoked — a missing/already-terminal row throws notFound so the caller gets a
 * clean 404 rather than silently succeeding.
 *
 * @param {object} args
 * @param {number|string} args.id     break-glass row id.
 * @param {string} args.tenantId      Authenticated tenant.
 * @param {string} args.actorUid      Who is revoking (for audit columns).
 * @returns {Promise<object>} the revoked break-glass row.
 */
export async function revokeBreakGlass({ id, tenantId, actorUid } = {}) {
  const tid = requireTenantId(cleanUuid(tenantId));
  const actor = cleanUuid(actorUid);
  const bgId = Number.parseInt(id, 10);
  if (!Number.isInteger(bgId) || bgId <= 0) {
    throw AppError.badRequest('break-glass id must be a positive integer', 'INVALID_BREAK_GLASS_ID');
  }

  const row = await setTenantTx(tid, async (tx) => {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE patient_access_break_glass
          SET status = 'revoked',
              ended_at = NOW(),
              ended_by = $3::uuid,
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE id = $1::int
          AND tenant_id = $2::uuid
          AND status = 'active'
        RETURNING id, tenant_id::text AS tenant_id, patient_uid::text AS patient_uid,
                  actor_uid::text AS actor_uid, actor_role, reason, status,
                  started_at, expires_at, ended_at, ended_by, created_at`,
      bgId,
      tid,
      actor,
    );
    const revoked = updated[0];
    if (!revoked) {
      // Either not found, wrong tenant, or already terminal — all surface as a
      // 404 to the caller (no row to revoke). Abort the tx so nothing is written.
      throw AppError.notFound('Active break-glass session not found', 'BREAK_GLASS_NOT_FOUND');
    }

    await tx.$executeRawUnsafe(
      `INSERT INTO patient_access_break_glass_status_history (
         tenant_id, break_glass_id, patient_uid, actor_uid,
         from_status, to_status, reason, changed_by, metadata,
         created_by, updated_by, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::int, $3::uuid, $4::uuid,
         'active', 'revoked', 'Manually revoked', $4::uuid,
         jsonb_build_object('revoked_by', $4::text),
         $4::uuid, $4::uuid, NOW(), NOW()
       )`,
      tid,
      revoked.id,
      revoked.patient_uid,
      actor,
    );

    return revoked;
  });

  alertBreakGlass('REVOKED', row, actor);
  return mapBreakGlassRow(row);
}

/**
 * List ACTIVE (non-expired) break-glass overrides for the tenant, optionally
 * scoped to one patient. Read-only — no history write, no alert.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} [args.patientUid]  Optional patient filter.
 * @param {number} [args.limit]       1–200, default 100.
 * @returns {Promise<object[]>}
 */
export async function listActiveBreakGlass({ tenantId, patientUid, limit = 100 } = {}) {
  const tid = requireTenantId(cleanUuid(tenantId));
  const patient = cleanUuid(patientUid);
  const cappedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id::text AS tenant_id, patient_uid::text AS patient_uid,
            actor_uid::text AS actor_uid, actor_role, reason, status,
            started_at, expires_at, ended_at, ended_by, created_at
       FROM patient_access_break_glass
      WHERE tenant_id = $1::uuid
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
        AND ($2::uuid IS NULL OR patient_uid = $2::uuid)
      ORDER BY started_at DESC
      LIMIT $3::int`,
    tid,
    patient,
    cappedLimit,
  );
  return rows.map(mapBreakGlassRow);
}

/**
 * Sweep `active` break-glass rows whose `expires_at` has passed, flipping them
 * to the terminal `expired` status and recording the transition in history.
 * Audit-cleanliness only: the engine ALREADY treats an expired-by-time row as
 * inactive (`findActiveBreakGlass` filters `expires_at > NOW()`), so this never
 * changes an access decision — it just stops stale rows lingering in 'active'.
 *
 * Cross-tenant aggregator: invoked from the scheduler inside runWithSuperAdmin
 * (GUC='bypass'), so it sweeps every tenant in one pass. Bounded per run to
 * avoid a runaway batch. Best-effort and idempotent.
 *
 * @param {object} [options]
 * @param {number} [options.limit] Max rows to expire per run (default 500).
 * @returns {Promise<{expired:number}>}
 */
export async function sweepExpiredBreakGlass({ limit = 500 } = {}) {
  const cappedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 5000);
  try {
    const expired = await prisma.$queryRawUnsafe(
      `WITH due AS (
         SELECT id
           FROM patient_access_break_glass
          WHERE status = 'active'
            AND expires_at IS NOT NULL
            AND expires_at <= NOW()
          ORDER BY expires_at ASC
          LIMIT $1::int
       ),
       flipped AS (
         UPDATE patient_access_break_glass bg
            SET status = 'expired',
                ended_at = COALESCE(bg.ended_at, bg.expires_at),
                updated_at = NOW()
           FROM due
          WHERE bg.id = due.id
        RETURNING bg.id, bg.tenant_id, bg.patient_uid, bg.actor_uid
       )
       INSERT INTO patient_access_break_glass_status_history (
         tenant_id, break_glass_id, patient_uid, actor_uid,
         from_status, to_status, reason, metadata, created_at, updated_at
       )
       SELECT f.tenant_id, f.id, f.patient_uid, f.actor_uid,
              'active', 'expired', 'Expired by sweeper',
              jsonb_build_object('swept_at', NOW()::text), NOW(), NOW()
         FROM flipped f
       RETURNING break_glass_id`,
      cappedLimit,
    );
    const count = Array.isArray(expired) ? expired.length : 0;
    if (count > 0) {
      logger.info(`break-glass sweeper: expired ${count} stale active override(s)`);
    }
    return { expired: count };
  } catch (err) {
    logger.warn('break-glass sweeper failed', { error: err?.message });
    return { expired: 0 };
  }
}

export default {
  activateBreakGlass,
  revokeBreakGlass,
  listActiveBreakGlass,
  sweepExpiredBreakGlass,
  roleCanBreakGlass,
  BREAK_GLASS_REASON_MIN_LENGTH,
  BREAK_GLASS_DEFAULT_HOURS,
  BREAK_GLASS_MAX_HOURS,
};
