// Shift-for-shift swap requests over published roster assignments.
//
// A swap is a two-party request object (migration 682): the requester offers
// one of their own published staff_shift_roster_assignments rows and names a
// colleague's published assignment in the same department. The counterparty
// accepts or declines; a department request reviewer (the same authority that
// reviews duty_preference / coverage_request rows) then approves or rejects.
// Approval atomically exchanges the person fields (staff_id / staff_uid /
// staff_role) between the two assignment rows in one transaction, with audit
// rows on both roster boards and in-app notifications to both parties.
//
// Slot attributes (target zone/ward, is_lead, notes) stay with the slot —
// swapping people does not move leadership flags or duty targets.
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  ROSTER_DEPARTMENT_POLICIES,
  canReviewRosterDepartmentRequest,
  getRosterDepartmentPolicy,
} from '../../config/rosterDepartmentConfig.js';

const LIVE_STATUSES = ['proposed', 'counterparty_accepted'];

function httpError(message, statusCode, details) {
  return Object.assign(new Error(message), { statusCode, details });
}

function parseId(value, label) {
  const id = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(`${label} must be a valid id`, 400);
  }
  return id;
}

function normalizeSnapshot(value) {
  if (value == null) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

async function resolveActor(client, user) {
  if (user?.uid) {
    const rows = await client.$queryRawUnsafe(
      `SELECT id, uid, name, role FROM users WHERE uid = $1::uuid LIMIT 1`,
      user.uid
    );
    if (rows.length) return rows[0];
  }
  const id = Number.parseInt(String(user?.id ?? ''), 10);
  if (Number.isInteger(id) && id > 0) {
    const rows = await client.$queryRawUnsafe(
      `SELECT id, uid, name, role FROM users WHERE id = $1::int LIMIT 1`,
      id
    );
    if (rows.length) return rows[0];
  }
  throw httpError('Unable to resolve the requesting staff member', 401);
}

// Load an assignment + its board + the assignee. `forUpdate` locks only the
// assignment row (boards are read; board rewrites cascade-delete swaps anyway).
async function loadSwapAssignment(client, assignmentId, { forUpdate = false } = {}) {
  if (forUpdate) {
    await client.$queryRawUnsafe(
      `SELECT id FROM staff_shift_roster_assignments WHERE id = $1::int FOR UPDATE`,
      assignmentId
    );
  }
  const rows = await client.$queryRawUnsafe(
    `SELECT a.id,
            a.roster_id,
            a.staff_id,
            a.staff_uid,
            a.staff_role,
            a.status AS assignment_status,
            a.assignment_target_label,
            a.tenant_id,
            b.department,
            b.roster_date::text AS roster_date,
            b.shift_label,
            b.shift_start::text AS shift_start,
            b.shift_end::text AS shift_end,
            b.status AS board_status,
            (b.roster_date + b.shift_start)::timestamptz AS shift_start_at,
            u.name AS staff_name,
            u.role AS staff_user_role,
            u.is_active AS staff_is_active
       FROM staff_shift_roster_assignments a
       JOIN staff_shift_roster_boards b ON b.id = a.roster_id
       LEFT JOIN users u ON u.id = a.staff_id
      WHERE a.id = $1::int
      LIMIT 1`,
    assignmentId
  );
  return rows[0] || null;
}

async function auditSwap(tx, { swapId, tenantId, actor, action, reason, before, after }) {
  await tx.$executeRawUnsafe(
    `INSERT INTO staff_shift_swap_request_audit
       (tenant_id, swap_request_id, actor_id, actor_uid, action, reason,
        before_snapshot, after_snapshot)
     VALUES ($1::uuid,$2::int,$3::int,$4::uuid,$5,$6,$7::jsonb,$8::jsonb)`,
    tenantId,
    swapId,
    actor.id || null,
    actor.uid || null,
    action,
    reason || null,
    JSON.stringify(normalizeSnapshot(before)),
    JSON.stringify(normalizeSnapshot(after))
  );
}

// In-app notifications for swap lifecycle events (the roster notification
// idiom — direct `notifications` rows, same as rosterDeadlineService).
async function notifySwapParties(tx, { userIds, title, body, data }) {
  const ids = [...new Set(userIds.filter(id => Number.isInteger(Number(id)) && Number(id) > 0))];
  if (!ids.length) return 0;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO notifications
       (uid, user_id, phone, title, body, type, priority, data, is_read,
        created_at, updated_at, recipient_role)
     SELECT u.uid, u.id, COALESCE(u.phone, ''), $1, $2, 'SHIFT_SWAP', 'HIGH', $3::jsonb,
            false, NOW(), NOW(), u.role
       FROM users u
      WHERE u.id = ANY($4::int[])
      RETURNING id`,
    title,
    body,
    JSON.stringify(normalizeSnapshot(data)),
    ids.map(Number)
  );
  return rows.length;
}

function describeAssignment(row) {
  return `${row.shift_label} on ${row.roster_date}`;
}

async function assertNoLiveSwapForAssignments(client, assignmentIds) {
  const rows = await client.$queryRawUnsafe(
    `SELECT id, requester_assignment_id, counterparty_assignment_id, status
       FROM staff_shift_swap_requests
      WHERE status = ANY($2::text[])
        AND (requester_assignment_id = ANY($1::int[])
             OR counterparty_assignment_id = ANY($1::int[]))
      LIMIT 1`,
    assignmentIds,
    LIVE_STATUSES
  );
  if (rows.length) {
    throw httpError(
      'One of these shifts already has an open swap request. Cancel or resolve it first.',
      409,
      { swap_request_id: rows[0].id }
    );
  }
}

export async function proposeShiftSwap({
  requesterAssignmentId,
  counterpartyAssignmentId,
  reason,
  actorUser,
  tenantId = null,
}) {
  const myAssignmentId = parseId(requesterAssignmentId, 'requester_assignment_id');
  const theirAssignmentId = parseId(counterpartyAssignmentId, 'counterparty_assignment_id');
  if (myAssignmentId === theirAssignmentId) {
    throw httpError('Pick two different shifts to swap', 400);
  }

  const actor = await resolveActor(prisma, actorUser);
  const mine = await loadSwapAssignment(prisma, myAssignmentId);
  const theirs = await loadSwapAssignment(prisma, theirAssignmentId);
  if (!mine || !theirs) {
    throw httpError('Roster assignment not found', 404);
  }
  if (tenantId && (String(mine.tenant_id) !== String(tenantId) || String(theirs.tenant_id) !== String(tenantId))) {
    throw httpError('Roster assignment not found', 404);
  }
  if (String(mine.tenant_id) !== String(theirs.tenant_id)) {
    throw httpError('Roster assignment not found', 404);
  }
  if (Number(mine.staff_id) !== Number(actor.id)) {
    throw httpError('You can only offer one of your own rostered shifts', 403);
  }
  if (Number(theirs.staff_id) === Number(actor.id)) {
    throw httpError('The other shift must belong to a colleague', 400);
  }
  if (mine.department !== theirs.department) {
    throw httpError('Shift swaps must stay within the same roster department', 400);
  }
  const policy = getRosterDepartmentPolicy(mine.department);
  if (!policy) {
    throw httpError('Roster department is not configured', 404);
  }
  for (const row of [mine, theirs]) {
    if (row.board_status !== 'published' || row.assignment_status !== 'published') {
      throw httpError('Both shifts must be on a published roster', 409);
    }
    if (!row.staff_is_active) {
      throw httpError('Both staff members must be active', 409);
    }
    if (!policy.staffRoles.includes(String(row.staff_user_role || '').toUpperCase())) {
      throw httpError('Both staff members must be eligible for this roster department', 409);
    }
    if (new Date(row.shift_start_at).getTime() <= Date.now()) {
      throw httpError('Only future shifts can be swapped', 400);
    }
  }
  await assertNoLiveSwapForAssignments(prisma, [myAssignmentId, theirAssignmentId]);

  const expiresAt = new Date(Math.min(
    new Date(mine.shift_start_at).getTime(),
    new Date(theirs.shift_start_at).getTime()
  ));

  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO staff_shift_swap_requests
         (tenant_id, department, requester_id, requester_uid, requester_assignment_id,
          counterparty_id, counterparty_uid, counterparty_assignment_id,
          status, reason, expires_at, updated_at)
       VALUES ($1::uuid,$2,$3::int,$4::uuid,$5::int,$6::int,$7::uuid,$8::int,
               'proposed',$9,$10::timestamptz,NOW())
       RETURNING *`,
      mine.tenant_id,
      mine.department,
      mine.staff_id,
      mine.staff_uid || null,
      myAssignmentId,
      theirs.staff_id,
      theirs.staff_uid || null,
      theirAssignmentId,
      reason || null,
      expiresAt.toISOString()
    );
    const created = rows[0];
    await auditSwap(tx, {
      swapId: created.id,
      tenantId: mine.tenant_id,
      actor,
      action: 'proposed',
      reason,
      before: {},
      after: created,
    });
    await notifySwapParties(tx, {
      userIds: [theirs.staff_id],
      title: 'Shift swap proposed',
      body: `${actor.name || 'A colleague'} wants to swap their ${describeAssignment(mine)} for your ${describeAssignment(theirs)}.`,
      data: {
        swap_request_id: created.id,
        department: mine.department,
        requester_shift: describeAssignment(mine),
        counterparty_shift: describeAssignment(theirs),
        source: 'shift_swap_proposed',
      },
    });
    return created;
  });
}

const SWAP_LIST_SELECT = `
  SELECT s.*,
         ru.name AS requester_name,
         cu.name AS counterparty_name,
         du.name AS decided_by_name,
         rb.roster_date::text AS requester_roster_date,
         rb.shift_label AS requester_shift_label,
         rb.shift_start::text AS requester_shift_start,
         rb.shift_end::text AS requester_shift_end,
         cb.roster_date::text AS counterparty_roster_date,
         cb.shift_label AS counterparty_shift_label,
         cb.shift_start::text AS counterparty_shift_start,
         cb.shift_end::text AS counterparty_shift_end
    FROM staff_shift_swap_requests s
    LEFT JOIN users ru ON ru.id = s.requester_id
    LEFT JOIN users cu ON cu.id = s.counterparty_id
    LEFT JOIN users du ON du.id = s.decided_by
    LEFT JOIN staff_shift_roster_assignments ra ON ra.id = s.requester_assignment_id
    LEFT JOIN staff_shift_roster_boards rb ON rb.id = ra.roster_id
    LEFT JOIN staff_shift_roster_assignments ca ON ca.id = s.counterparty_assignment_id
    LEFT JOIN staff_shift_roster_boards cb ON cb.id = ca.roster_id`;

// Published future assignments of COLLEAGUES in the requester's own roster
// department — the pick-list for proposing a swap. Deliberately narrower than
// the manager-only department snapshot: only published board rows (the roster
// staff already see on the notice board), only the requester's department,
// and only rows without a live swap already attached.
export async function listSwapCandidates({ actorUser, limit = 100 }) {
  const actor = await resolveActor(prisma, actorUser);
  const role = String(actor.role || '').trim().toUpperCase();
  let department = null;
  for (const [key, policy] of Object.entries(ROSTER_DEPARTMENT_POLICIES)) {
    if (policy.staffRoles.includes(role)) {
      department = key;
      break;
    }
  }
  if (!department) {
    throw httpError('Your role is not part of a roster department', 404);
  }
  return prisma.$queryRawUnsafe(
    `SELECT a.id AS assignment_id,
            a.staff_id,
            a.staff_uid,
            u.name AS staff_name,
            u.role AS staff_role,
            b.department,
            b.roster_date::text AS roster_date,
            b.shift_label,
            b.shift_start::text AS shift_start,
            b.shift_end::text AS shift_end,
            a.assignment_target_label
       FROM staff_shift_roster_assignments a
       JOIN staff_shift_roster_boards b ON b.id = a.roster_id
       JOIN users u ON u.id = a.staff_id
      WHERE b.department = $1
        AND b.status = 'published'
        AND a.status = 'published'
        AND a.staff_id <> $2::int
        AND u.is_active = true
        AND (b.roster_date + b.shift_start)::timestamptz > NOW()
        AND NOT EXISTS (
          SELECT 1 FROM staff_shift_swap_requests s
           WHERE s.status = ANY($4::text[])
             AND (s.requester_assignment_id = a.id OR s.counterparty_assignment_id = a.id)
        )
      ORDER BY b.roster_date ASC, b.shift_start ASC, u.name ASC
      LIMIT $3::int`,
    department,
    actor.id,
    Math.min(Math.max(Number(limit) || 100, 1), 200),
    LIVE_STATUSES
  );
}

export async function listMyShiftSwaps({ actorUser, limit = 50 }) {
  const actor = await resolveActor(prisma, actorUser);
  return prisma.$queryRawUnsafe(
    `${SWAP_LIST_SELECT}
      WHERE s.requester_id = $1::int OR s.counterparty_id = $1::int
      ORDER BY
        CASE WHEN s.status = ANY($3::text[]) THEN 0 ELSE 1 END,
        s.created_at DESC
      LIMIT $2::int`,
    actor.id,
    Math.min(Math.max(Number(limit) || 50, 1), 100),
    LIVE_STATUSES
  );
}

export async function listDepartmentShiftSwaps({ department, status = null, actorUser, limit = 100 }) {
  const policy = getRosterDepartmentPolicy(department);
  if (!policy) {
    throw httpError('Roster department is not configured', 404);
  }
  if (!canReviewRosterDepartmentRequest(actorUser, policy.department)) {
    throw httpError('You are not allowed to review swap requests for this department', 403);
  }
  const cleanStatus = status ? String(status).trim().toLowerCase() : null;
  return prisma.$queryRawUnsafe(
    `${SWAP_LIST_SELECT}
      WHERE s.department = $1
        AND ($2::text IS NULL OR s.status = $2)
      ORDER BY
        CASE s.status
          WHEN 'counterparty_accepted' THEN 0
          WHEN 'proposed' THEN 1
          ELSE 2
        END,
        s.created_at DESC
      LIMIT $3::int`,
    policy.department,
    cleanStatus,
    Math.min(Math.max(Number(limit) || 100, 1), 200)
  );
}

async function lockSwap(tx, swapId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT * FROM staff_shift_swap_requests WHERE id = $1::int FOR UPDATE`,
    swapId
  );
  if (!rows.length) {
    throw httpError('Swap request not found', 404);
  }
  return rows[0];
}

async function expireIfPastDeadline(tx, swap, actor) {
  if (!LIVE_STATUSES.includes(swap.status)) return false;
  if (new Date(swap.expires_at).getTime() > Date.now()) return false;
  const rows = await tx.$queryRawUnsafe(
    `UPDATE staff_shift_swap_requests
        SET status = 'expired', updated_at = NOW()
      WHERE id = $1::int
      RETURNING *`,
    swap.id
  );
  await auditSwap(tx, {
    swapId: swap.id,
    tenantId: swap.tenant_id,
    actor,
    action: 'expired',
    reason: 'Shift start time passed before the swap was completed',
    before: swap,
    after: rows[0],
  });
  return true;
}

export async function respondToShiftSwap({ swapId, decision, note, actorUser }) {
  const id = parseId(swapId, 'swap request id');
  const clean = String(decision || '').trim().toLowerCase();
  if (!['accept', 'decline'].includes(clean)) {
    throw httpError('decision must be accept or decline', 400);
  }
  const actor = await resolveActor(prisma, actorUser);

  return prisma.$transaction(async tx => {
    const swap = await lockSwap(tx, id);
    if (Number(swap.counterparty_id) !== Number(actor.id)) {
      throw httpError('Only the invited colleague can respond to this swap request', 403);
    }
    if (swap.status !== 'proposed') {
      throw httpError(`Swap request is ${swap.status} and can no longer be answered`, 409);
    }
    if (await expireIfPastDeadline(tx, swap, actor)) {
      throw httpError('Swap request expired: the shift has already started', 409);
    }
    const nextStatus = clean === 'accept' ? 'counterparty_accepted' : 'counterparty_declined';
    const rows = await tx.$queryRawUnsafe(
      `UPDATE staff_shift_swap_requests
          SET status = $2,
              counterparty_note = $3,
              counterparty_responded_at = NOW(),
              updated_at = NOW()
        WHERE id = $1::int
        RETURNING *`,
      id,
      nextStatus,
      note || null
    );
    const after = rows[0];
    await auditSwap(tx, {
      swapId: id,
      tenantId: swap.tenant_id,
      actor,
      action: nextStatus,
      reason: note,
      before: swap,
      after,
    });
    await notifySwapParties(tx, {
      userIds: [swap.requester_id],
      title: clean === 'accept' ? 'Shift swap accepted' : 'Shift swap declined',
      body: clean === 'accept'
        ? `${actor.name || 'Your colleague'} accepted your shift swap. It now awaits department approval.`
        : `${actor.name || 'Your colleague'} declined your shift swap request.`,
      data: { swap_request_id: id, department: swap.department, source: 'shift_swap_response' },
    });
    return after;
  });
}

export async function cancelShiftSwap({ swapId, actorUser }) {
  const id = parseId(swapId, 'swap request id');
  const actor = await resolveActor(prisma, actorUser);

  return prisma.$transaction(async tx => {
    const swap = await lockSwap(tx, id);
    if (Number(swap.requester_id) !== Number(actor.id)) {
      throw httpError('Only the requester can cancel this swap request', 403);
    }
    if (!LIVE_STATUSES.includes(swap.status)) {
      throw httpError(`Swap request is ${swap.status} and can no longer be cancelled`, 409);
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE staff_shift_swap_requests
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1::int
        RETURNING *`,
      id
    );
    const after = rows[0];
    await auditSwap(tx, {
      swapId: id,
      tenantId: swap.tenant_id,
      actor,
      action: 'cancelled',
      reason: null,
      before: swap,
      after,
    });
    await notifySwapParties(tx, {
      userIds: [swap.counterparty_id],
      title: 'Shift swap cancelled',
      body: `${actor.name || 'Your colleague'} withdrew their shift swap request.`,
      data: { swap_request_id: id, department: swap.department, source: 'shift_swap_cancelled' },
    });
    return after;
  });
}

// One-shift-per-day + approved-leave re-validation for the two incoming staff
// (mirrors assertNoExistingRosterDayConflicts / the leave conflict query in
// rosterBoardService, scoped to a single staff member and target date).
async function assertExchangeTargetClear(tx, { staffId, staffName, rosterDate, excludeAssignmentIds }) {
  const conflicts = await tx.$queryRawUnsafe(
    `SELECT b.department, b.shift_label
       FROM staff_shift_roster_assignments a
       JOIN staff_shift_roster_boards b ON b.id = a.roster_id
      WHERE a.staff_id = $1::int
        AND b.roster_date = $2::date
        AND b.status <> 'archived'
        AND a.status <> 'cancelled'
        AND a.id <> ALL($3::int[])
      LIMIT 1`,
    staffId,
    rosterDate,
    excludeAssignmentIds
  );
  if (conflicts.length) {
    throw httpError(
      `Cannot approve swap: ${staffName || 'staff'} is already assigned to ${conflicts[0].shift_label} (${conflicts[0].department}) on ${rosterDate}.`,
      409
    );
  }
  const leave = await tx.$queryRawUnsafe(
    `SELECT la.leave_type, la.start_date::text AS start_date, la.end_date::text AS end_date
       FROM leave_applications la
      WHERE la.staff_id = $1::int
        AND la.start_date <= $2::date
        AND la.end_date >= $2::date
        AND LOWER(la.status) = 'approved'
      LIMIT 1`,
    staffId,
    rosterDate
  );
  if (leave.length) {
    throw httpError(
      `Cannot approve swap: ${staffName || 'staff'} is on approved ${leave[0].leave_type || 'leave'} from ${leave[0].start_date} to ${leave[0].end_date}.`,
      409
    );
  }
}

async function auditRosterAssignmentExchange(tx, { rosterId, assignmentId, actor, reason, before, after }) {
  await tx.$executeRawUnsafe(
    `INSERT INTO staff_shift_roster_assignment_audit
       (roster_id, assignment_id, actor_id, actor_uid, action, reason, before_snapshot, after_snapshot)
     VALUES ($1::int,$2::int,$3::int,$4::uuid,'swap_exchanged',$5,$6::jsonb,$7::jsonb)`,
    rosterId,
    assignmentId,
    actor.id || null,
    actor.uid || null,
    reason || null,
    JSON.stringify(normalizeSnapshot(before)),
    JSON.stringify(normalizeSnapshot(after))
  );
}

export async function reviewShiftSwap({ swapId, decision, notes, actorUser }) {
  const id = parseId(swapId, 'swap request id');
  const clean = String(decision || '').trim().toLowerCase();
  if (!['approved', 'rejected'].includes(clean)) {
    throw httpError('decision must be approved or rejected', 400);
  }
  const actor = await resolveActor(prisma, actorUser);

  return prisma.$transaction(async tx => {
    const swap = await lockSwap(tx, id);
    if (!canReviewRosterDepartmentRequest(actorUser, swap.department)) {
      throw httpError('You are not allowed to review swap requests for this department', 403);
    }
    if (clean === 'rejected') {
      if (!LIVE_STATUSES.includes(swap.status)) {
        throw httpError(`Swap request is ${swap.status} and can no longer be reviewed`, 409);
      }
      const rows = await tx.$queryRawUnsafe(
        `UPDATE staff_shift_swap_requests
            SET status = 'rejected',
                decided_by = $2::int,
                decided_by_uid = $3::uuid,
                decided_at = NOW(),
                decision_notes = $4,
                counterparty_responded_at = COALESCE(counterparty_responded_at, NOW()),
                updated_at = NOW()
          WHERE id = $1::int
          RETURNING *`,
        id,
        actor.id,
        actor.uid || null,
        notes || null
      );
      const after = rows[0];
      await auditSwap(tx, {
        swapId: id, tenantId: swap.tenant_id, actor, action: 'rejected', reason: notes,
        before: swap, after,
      });
      await notifySwapParties(tx, {
        userIds: [swap.requester_id, swap.counterparty_id],
        title: 'Shift swap rejected',
        body: `${actor.name || 'The department reviewer'} rejected the proposed shift swap.`,
        data: { swap_request_id: id, department: swap.department, source: 'shift_swap_rejected' },
      });
      return after;
    }

    // Approval path — requires prior counterparty acceptance.
    if (swap.status !== 'counterparty_accepted') {
      throw httpError('Swap can only be approved after the colleague has accepted it', 409);
    }
    if (await expireIfPastDeadline(tx, swap, actor)) {
      throw httpError('Swap request expired: the shift has already started', 409);
    }

    // Lock both assignment rows in a deterministic order, then re-validate.
    const orderedIds = [swap.requester_assignment_id, swap.counterparty_assignment_id]
      .map(Number)
      .sort((a, b) => a - b);
    for (const assignmentId of orderedIds) {
      await tx.$queryRawUnsafe(
        `SELECT id FROM staff_shift_roster_assignments WHERE id = $1::int FOR UPDATE`,
        assignmentId
      );
    }
    const mine = await loadSwapAssignment(tx, swap.requester_assignment_id);
    const theirs = await loadSwapAssignment(tx, swap.counterparty_assignment_id);
    if (!mine || !theirs) {
      throw httpError('One of the rostered shifts no longer exists', 409);
    }
    if (Number(mine.staff_id) !== Number(swap.requester_id)
      || Number(theirs.staff_id) !== Number(swap.counterparty_id)) {
      throw httpError('The roster changed since this swap was proposed. Ask for a fresh request.', 409);
    }
    for (const row of [mine, theirs]) {
      if (row.board_status !== 'published' || row.assignment_status !== 'published') {
        throw httpError('Both shifts must still be on a published roster', 409);
      }
      if (new Date(row.shift_start_at).getTime() <= Date.now()) {
        throw httpError('Only future shifts can be swapped', 409);
      }
    }
    const excludeIds = [Number(mine.id), Number(theirs.id)];
    await assertExchangeTargetClear(tx, {
      staffId: swap.requester_id,
      staffName: mine.staff_name,
      rosterDate: theirs.roster_date,
      excludeAssignmentIds: excludeIds,
    });
    await assertExchangeTargetClear(tx, {
      staffId: swap.counterparty_id,
      staffName: theirs.staff_name,
      rosterDate: mine.roster_date,
      excludeAssignmentIds: excludeIds,
    });

    // The atomic exchange: person fields trade places, slots stay put.
    await tx.$executeRawUnsafe(
      `UPDATE staff_shift_roster_assignments
          SET staff_id = $2::int, staff_uid = $3::uuid, staff_role = $4, updated_at = NOW()
        WHERE id = $1::int`,
      mine.id,
      theirs.staff_id,
      theirs.staff_uid || null,
      theirs.staff_role || theirs.staff_user_role || null
    );
    await tx.$executeRawUnsafe(
      `UPDATE staff_shift_roster_assignments
          SET staff_id = $2::int, staff_uid = $3::uuid, staff_role = $4, updated_at = NOW()
        WHERE id = $1::int`,
      theirs.id,
      mine.staff_id,
      mine.staff_uid || null,
      mine.staff_role || mine.staff_user_role || null
    );

    const rows = await tx.$queryRawUnsafe(
      `UPDATE staff_shift_swap_requests
          SET status = 'approved',
              decided_by = $2::int,
              decided_by_uid = $3::uuid,
              decided_at = NOW(),
              decision_notes = $4,
              updated_at = NOW()
        WHERE id = $1::int
        RETURNING *`,
      id,
      actor.id,
      actor.uid || null,
      notes || null
    );
    const after = rows[0];

    await auditSwap(tx, {
      swapId: id, tenantId: swap.tenant_id, actor, action: 'approved', reason: notes,
      before: swap, after,
    });
    const exchangeReason = `Shift swap #${id} approved`;
    await auditRosterAssignmentExchange(tx, {
      rosterId: mine.roster_id,
      assignmentId: mine.id,
      actor,
      reason: exchangeReason,
      before: { staff_id: mine.staff_id, staff_uid: mine.staff_uid, staff_role: mine.staff_role },
      after: { staff_id: theirs.staff_id, staff_uid: theirs.staff_uid, staff_role: theirs.staff_role },
    });
    await auditRosterAssignmentExchange(tx, {
      rosterId: theirs.roster_id,
      assignmentId: theirs.id,
      actor,
      reason: exchangeReason,
      before: { staff_id: theirs.staff_id, staff_uid: theirs.staff_uid, staff_role: theirs.staff_role },
      after: { staff_id: mine.staff_id, staff_uid: mine.staff_uid, staff_role: mine.staff_role },
    });
    await notifySwapParties(tx, {
      userIds: [swap.requester_id, swap.counterparty_id],
      title: 'Shift swap approved',
      body: `Your shift swap was approved: ${describeAssignment(mine)} <-> ${describeAssignment(theirs)}.`,
      data: {
        swap_request_id: id,
        department: swap.department,
        requester_shift: describeAssignment(mine),
        counterparty_shift: describeAssignment(theirs),
        source: 'shift_swap_approved',
      },
    });
    return { ...after, exchanged: true };
  });
}

// Scheduler sweep: any still-live swap whose earliest shift has started can
// never be completed — flip it to expired so it stops blocking new proposals
// on the same assignments (the live partial unique indexes).
export async function expireStaleShiftSwapRequests({ tenantId = null } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE staff_shift_swap_requests
        SET status = 'expired', updated_at = NOW()
      WHERE status = ANY($1::text[])
        AND expires_at <= NOW()
        AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
      RETURNING id, tenant_id, requester_id, counterparty_id, department`,
    LIVE_STATUSES,
    tenantId
  );
  for (const row of rows) {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO staff_shift_swap_request_audit
           (tenant_id, swap_request_id, action, reason, before_snapshot, after_snapshot)
         VALUES ($1::uuid,$2::int,'expired','Expiry sweep: shift start time passed','{}'::jsonb,'{}'::jsonb)`,
        row.tenant_id,
        row.id
      );
    } catch (err) {
      logger.warn('Shift swap expiry audit insert failed', { swapId: row.id, error: err.message });
    }
  }
  if (rows.length) {
    logger.info(`Shift swap expiry sweep expired ${rows.length} request(s)`);
  }
  return { expired: rows.length };
}
