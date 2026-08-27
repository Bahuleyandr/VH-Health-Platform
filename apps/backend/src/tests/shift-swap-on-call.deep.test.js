// Shift swap + on-call roster (migration 682) — full lifecycle against a real
// DB: propose -> counterparty accept -> reviewer approve with the atomic
// assignment exchange, plus the wrong-party / past-shift / cross-tenant
// rejections, the expiry sweep, on-call CRUD + overlap exclusion +
// who-is-on-call, and the escalation recipient-ordering seam.
import request from 'supertest';
import app from '../app.js';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { waitForAuditLogDrain } from '../middleware/auditLog.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';
import { expireStaleShiftSwapRequests } from '../services/staff/shiftSwapService.js';
import { __testing__ as escalationTesting } from '../services/workflow/escalationEngineService.js';

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');

const REQUESTER_UID = '11111111-2222-4333-8444-000000682001';
const COUNTERPARTY_UID = '11111111-2222-4333-8444-000000682002';
const INCHARGE_UID = '11111111-2222-4333-8444-000000682003';
const OUTSIDER_UID = '11111111-2222-4333-8444-000000682004';
const FOREIGN_UID = '11111111-2222-4333-8444-000000682005';
const ONCALL_DOC_UID = '11111111-2222-4333-8444-000000682006';
const ONCALL_DOC2_UID = '11111111-2222-4333-8444-000000682007';
const ADMIN682_UID = '11111111-2222-4333-8444-000000682008';
const FOREIGN_INCHARGE_UID = '11111111-2222-4333-8444-000000682009';

const FOREIGN_TENANT = 'd6820000-0000-4000-8000-0000006820aa';
const ESCALATION_TENANT = 'd6820000-0000-4000-8000-0000006820ab';
const ONCALL_ESC_UID_A = `c6820000-0000-4000-8000-${SUFFIX}0000001`;
const ONCALL_ESC_UID_B = `c6820000-0000-4000-8000-${SUFFIX}0000002`;

const HOOK_TIMEOUT_MS = 180000;

function authed(role, uid, id) {
  const token = generateTestToken(role, { uid, id });
  return {
    get: path =>
      request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: path =>
      request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
  };
}

function dateOffset(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function createBoard({ rosterDate, shiftLabel, tenantId = null, status = 'published' }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO staff_shift_roster_boards
       (department, roster_date, shift_label, shift_start, shift_end, status,
        published_at, updated_at${tenantId ? ', tenant_id' : ''})
     VALUES ('nursing', $1::date, $2, '08:00:00'::time, '16:00:00'::time, $3::text,
             CASE WHEN $3::text = 'published' THEN NOW() ELSE NULL END, NOW()${tenantId ? ', $4::uuid' : ''})
     RETURNING id, tenant_id`,
    ...(tenantId
      ? [rosterDate, shiftLabel, status, tenantId]
      : [rosterDate, shiftLabel, status])
  );
  return rows[0];
}

async function createAssignment({ boardId, staffId, staffUid, tenantId = null, status = 'published' }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO staff_shift_roster_assignments
       (roster_id, staff_id, staff_uid, staff_role, assignment_target_type,
        assignment_target_id, assignment_target_label, status, updated_at${tenantId ? ', tenant_id' : ''})
     VALUES ($1::int, $2::int, $3::uuid, 'NURSING_STAFF', 'ward', 1, 'Test Ward', $4,
             NOW()${tenantId ? ', $5::uuid' : ''})
     RETURNING id, tenant_id`,
    ...(tenantId
      ? [boardId, staffId, staffUid, status, tenantId]
      : [boardId, staffId, staffUid, status])
  );
  return rows[0];
}

describe('shift swap + on-call roster', () => {
  let requesterId;
  let counterpartyId;
  let inchargeId;
  let outsiderId;
  let foreignId;
  let foreignInchargeId;
  let oncallDocId;
  let oncallDoc2Id;
  let adminId;
  const boardIds = [];
  const label = suffix => `SwapTest ${STAMP} ${suffix}`;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'swap-foreign-682', 'Swap Foreign Tenant', 'IN', 'DPDP', 'active'),
              ($2::uuid, 'swap-escalation-682', 'Swap Escalation Tenant', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      FOREIGN_TENANT,
      ESCALATION_TENANT
    );

    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2, 'Swap Requester [test]', 'NURSING_STAFF', true, NOW()),
         ($3::uuid, $4, 'Swap Counterparty [test]', 'NURSING_STAFF', true, NOW()),
         ($5::uuid, $6, 'Swap Incharge [test]', 'NURSING_INCHARGE', true, NOW()),
         ($7::uuid, $8, 'Swap Outsider [test]', 'NURSING_STAFF', true, NOW()),
         ($9::uuid, $10, 'On-call Doctor [test]', 'DUTY_DOCTOR', true, NOW()),
         ($11::uuid, $12, 'On-call Doctor Two [test]', 'DUTY_DOCTOR', true, NOW()),
         ($13::uuid, $14, 'Swap Roster Admin [test]', 'ADMIN', true, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET is_active = EXCLUDED.is_active, role = EXCLUDED.role, updated_at = NOW()
       RETURNING id, uid`,
      REQUESTER_UID, `97${STAMP.slice(-8)}1`,
      COUNTERPARTY_UID, `97${STAMP.slice(-8)}2`,
      INCHARGE_UID, `97${STAMP.slice(-8)}3`,
      OUTSIDER_UID, `97${STAMP.slice(-8)}4`,
      ONCALL_DOC_UID, `97${STAMP.slice(-8)}5`,
      ONCALL_DOC2_UID, `97${STAMP.slice(-8)}6`,
      ADMIN682_UID, `97${STAMP.slice(-8)}7`
    );
    const byUid = new Map(users.map(u => [u.uid, u.id]));
    requesterId = byUid.get(REQUESTER_UID);
    counterpartyId = byUid.get(COUNTERPARTY_UID);
    inchargeId = byUid.get(INCHARGE_UID);
    outsiderId = byUid.get(OUTSIDER_UID);
    oncallDocId = byUid.get(ONCALL_DOC_UID);
    oncallDoc2Id = byUid.get(ONCALL_DOC2_UID);
    adminId = byUid.get(ADMIN682_UID);

    const foreign = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Swap Foreign Nurse [test]', 'NURSING_STAFF', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'Swap Foreign Incharge [test]', 'NURSING_INCHARGE', true, $3::uuid, NOW())
       ON CONFLICT (uid) DO UPDATE SET is_active = true, updated_at = NOW()
       RETURNING id, uid`,
      FOREIGN_UID, `97${STAMP.slice(-8)}8`, FOREIGN_TENANT,
      FOREIGN_INCHARGE_UID, `97${STAMP.slice(-8)}9`
    );
    foreignId = foreign.find(row => row.uid === FOREIGN_UID).id;
    foreignInchargeId = foreign.find(row => row.uid === FOREIGN_INCHARGE_UID).id;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await waitForAuditLogDrain();
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM audit_log WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      FOREIGN_TENANT,
      ESCALATION_TENANT
    );
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM audit_logs WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      FOREIGN_TENANT,
      ESCALATION_TENANT
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM staff_shift_swap_request_audit WHERE swap_request_id IN (
         SELECT id FROM staff_shift_swap_requests
          WHERE requester_id = ANY($1::int[]) OR counterparty_id = ANY($1::int[]))`,
      [requesterId, counterpartyId, outsiderId, foreignId].filter(Boolean)
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM staff_shift_swap_requests
        WHERE requester_id = ANY($1::int[]) OR counterparty_id = ANY($1::int[])`,
      [requesterId, counterpartyId, outsiderId, foreignId].filter(Boolean)
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM staff_on_call_assignments
        WHERE staff_id = ANY($1::int[])
           OR tenant_id IN ($2::uuid, $3::uuid)`,
      [oncallDocId, oncallDoc2Id, requesterId, counterpartyId].filter(Boolean),
      FOREIGN_TENANT, ESCALATION_TENANT
    );
    if (boardIds.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM staff_shift_roster_assignment_audit WHERE roster_id = ANY($1::int[])`,
        boardIds
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM staff_shift_roster_boards WHERE id = ANY($1::int[])`,
        boardIds
      );
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM notifications WHERE type IN ('SHIFT_SWAP', 'ON_CALL')
        AND user_id = ANY($1::int[])`,
      [requesterId, counterpartyId, inchargeId, outsiderId, oncallDocId, oncallDoc2Id].filter(Boolean)
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      FOREIGN_TENANT, ESCALATION_TENANT
    );
    const fixtureUids = [REQUESTER_UID, COUNTERPARTY_UID, INCHARGE_UID, OUTSIDER_UID,
      ONCALL_DOC_UID, ONCALL_DOC2_UID, ADMIN682_UID];
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
      fixtureUids
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
      FOREIGN_TENANT, ESCALATION_TENANT
    );
  }, HOOK_TIMEOUT_MS);

  describe('swap lifecycle', () => {
    let requesterAssignmentId;
    let counterpartyAssignmentId;
    let swapId;

    beforeAll(async () => {
      const board1 = await createBoard({ rosterDate: dateOffset(7), shiftLabel: label('A') });
      const board2 = await createBoard({ rosterDate: dateOffset(8), shiftLabel: label('B') });
      boardIds.push(board1.id, board2.id);
      const a1 = await createAssignment({
        boardId: board1.id, staffId: requesterId, staffUid: REQUESTER_UID
      });
      const a2 = await createAssignment({
        boardId: board2.id, staffId: counterpartyId, staffUid: COUNTERPARTY_UID
      });
      requesterAssignmentId = a1.id;
      counterpartyAssignmentId = a2.id;
    }, HOOK_TIMEOUT_MS);

    it('rejects proposing with someone else\'s shift as your own', async () => {
      const res = await authed('NURSING_STAFF', OUTSIDER_UID, outsiderId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({
          requester_assignment_id: requesterAssignmentId,
          counterparty_assignment_id: counterpartyAssignmentId
        });
      expect(res.status).toBe(403);
    });

    it('lists the colleague\'s published future shift as a swap candidate', async () => {
      const res = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .get('/api/v1/staff/roster-board/swaps/candidates');
      expect(res.status).toBe(200);
      const candidate = res.body.data.find(row => row.assignment_id === counterpartyAssignmentId);
      expect(candidate).toBeTruthy();
      expect(candidate.staff_id).toBe(counterpartyId);
      // Own shifts are never candidates.
      expect(res.body.data.some(row => row.assignment_id === requesterAssignmentId)).toBe(false);
    });

    it('proposes a swap between two future published assignments', async () => {
      const res = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({
          requester_assignment_id: requesterAssignmentId,
          counterparty_assignment_id: counterpartyAssignmentId,
          reason: 'Family function'
        });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('proposed');
      expect(res.body.data.department).toBe('nursing');
      swapId = res.body.data.id;

      const notif = await prisma.$queryRawUnsafe(
        `SELECT id FROM notifications
          WHERE type = 'SHIFT_SWAP' AND user_id = $1::int
            AND (data->>'swap_request_id')::int = $2::int`,
        counterpartyId, swapId
      );
      expect(notif.length).toBe(1);
    });

    it('drops an assignment with a live swap from the candidate list', async () => {
      const res = await authed('NURSING_STAFF', OUTSIDER_UID, outsiderId)
        .get('/api/v1/staff/roster-board/swaps/candidates');
      expect(res.status).toBe(200);
      expect(res.body.data.some(row => row.assignment_id === counterpartyAssignmentId)).toBe(false);
    });

    it('blocks a second live swap referencing the same assignment', async () => {
      const res = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({
          requester_assignment_id: requesterAssignmentId,
          counterparty_assignment_id: counterpartyAssignmentId
        });
      expect(res.status).toBe(409);
    });

    it('rejects a response from anyone but the counterparty', async () => {
      const asRequester = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/respond`)
        .send({ decision: 'accept' });
      expect(asRequester.status).toBe(403);

      const asOutsider = await authed('NURSING_STAFF', OUTSIDER_UID, outsiderId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/respond`)
        .send({ decision: 'accept' });
      expect(asOutsider.status).toBe(403);
    });

    it('refuses approval before the counterparty accepts', async () => {
      const res = await authed('NURSING_INCHARGE', INCHARGE_UID, inchargeId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/review`)
        .send({ decision: 'approved' });
      expect(res.status).toBe(409);
    });

    it('lets the counterparty accept', async () => {
      const res = await authed('NURSING_STAFF', COUNTERPARTY_UID, counterpartyId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/respond`)
        .send({ decision: 'accept', note: 'Happy to help' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('counterparty_accepted');
      expect(res.body.data.counterparty_responded_at).toBeTruthy();
    });

    it('refuses review by a non-reviewer', async () => {
      const res = await authed('NURSING_STAFF', OUTSIDER_UID, outsiderId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/review`)
        .send({ decision: 'approved' });
      expect(res.status).toBe(403);
    });

    it('lists the swap for department reviewers', async () => {
      const res = await authed('NURSING_INCHARGE', INCHARGE_UID, inchargeId)
        .get('/api/v1/staff/roster-board/departments/nursing/swaps?status=counterparty_accepted');
      expect(res.status).toBe(200);
      const found = res.body.data.find(row => row.id === swapId);
      expect(found).toBeTruthy();
      expect(found.requester_name).toContain('Swap Requester');
    });

    it('approves and atomically exchanges the two assignments', async () => {
      const res = await authed('NURSING_INCHARGE', INCHARGE_UID, inchargeId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/review`)
        .send({ decision: 'approved', notes: 'Coverage holds' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('approved');
      expect(res.body.data.exchanged).toBe(true);
      expect(res.body.data.decided_by).toBe(inchargeId);

      const swappedIds = [requesterAssignmentId, counterpartyAssignmentId];
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, staff_id, staff_uid
           FROM staff_shift_roster_assignments
          WHERE id = ANY($1::int[]) ORDER BY id`,
        swappedIds
      );
      const byId = new Map(rows.map(row => [row.id, row]));
      expect(byId.get(requesterAssignmentId).staff_id).toBe(counterpartyId);
      expect(byId.get(requesterAssignmentId).staff_uid).toBe(COUNTERPARTY_UID);
      expect(byId.get(counterpartyAssignmentId).staff_id).toBe(requesterId);
      expect(byId.get(counterpartyAssignmentId).staff_uid).toBe(REQUESTER_UID);

      const swapAudit = await prisma.$queryRawUnsafe(
        `SELECT action FROM staff_shift_swap_request_audit
          WHERE swap_request_id = $1::int ORDER BY id`,
        swapId
      );
      expect(swapAudit.map(row => row.action))
        .toEqual(['proposed', 'counterparty_accepted', 'approved']);

      const rosterAudit = await prisma.$queryRawUnsafe(
        `SELECT assignment_id FROM staff_shift_roster_assignment_audit
          WHERE action = 'swap_exchanged' AND assignment_id = ANY($1::int[])`,
        swappedIds
      );
      expect(rosterAudit.length).toBe(2);

      const notif = await prisma.$queryRawUnsafe(
        `SELECT user_id FROM notifications
          WHERE type = 'SHIFT_SWAP'
            AND (data->>'source') = 'shift_swap_approved'
            AND (data->>'swap_request_id')::int = $1::int`,
        swapId
      );
      expect(new Set(notif.map(row => row.user_id)))
        .toEqual(new Set([requesterId, counterpartyId]));
    });

    it('shows both directions in /swaps/my', async () => {
      const res = await authed('NURSING_STAFF', COUNTERPARTY_UID, counterpartyId)
        .get('/api/v1/staff/roster-board/swaps/my');
      expect(res.status).toBe(200);
      expect(res.body.data.some(row => row.id === swapId)).toBe(true);
    });
  });

  describe('swap rejections', () => {
    it('rejects a past shift', async () => {
      const pastBoard = await createBoard({ rosterDate: dateOffset(-1), shiftLabel: label('Past') });
      const futureBoard = await createBoard({ rosterDate: dateOffset(9), shiftLabel: label('Fut') });
      boardIds.push(pastBoard.id, futureBoard.id);
      const pastMine = await createAssignment({
        boardId: pastBoard.id, staffId: requesterId, staffUid: REQUESTER_UID
      });
      const futureTheirs = await createAssignment({
        boardId: futureBoard.id, staffId: counterpartyId, staffUid: COUNTERPARTY_UID
      });
      const res = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({
          requester_assignment_id: pastMine.id,
          counterparty_assignment_id: futureTheirs.id
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/future/i);
    });

    it('rejects a cross-tenant counterparty assignment as not found', async () => {
      const myBoard = await createBoard({ rosterDate: dateOffset(10), shiftLabel: label('Mine') });
      const foreignBoard = await createBoard({
        rosterDate: dateOffset(10), shiftLabel: label('Foreign'), tenantId: FOREIGN_TENANT
      });
      boardIds.push(myBoard.id, foreignBoard.id);
      const mine = await createAssignment({
        boardId: myBoard.id, staffId: requesterId, staffUid: REQUESTER_UID
      });
      const foreign = await createAssignment({
        boardId: foreignBoard.id, staffId: foreignId, staffUid: FOREIGN_UID,
        tenantId: FOREIGN_TENANT
      });
      const res = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({
          requester_assignment_id: mine.id,
          counterparty_assignment_id: foreign.id
        });
      expect(res.status).toBe(404);
    });

    it('rejects a draft-board assignment', async () => {
      const draftBoard = await createBoard({
        rosterDate: dateOffset(11), shiftLabel: label('Draft'), status: 'draft'
      });
      const pubBoard = await createBoard({ rosterDate: dateOffset(11), shiftLabel: label('Pub') });
      boardIds.push(draftBoard.id, pubBoard.id);
      const mine = await createAssignment({
        boardId: pubBoard.id, staffId: requesterId, staffUid: REQUESTER_UID
      });
      const draftTheirs = await createAssignment({
        boardId: draftBoard.id, staffId: counterpartyId, staffUid: COUNTERPARTY_UID,
        status: 'planned'
      });
      const res = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({
          requester_assignment_id: mine.id,
          counterparty_assignment_id: draftTheirs.id
        });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/published/i);
    });
  });

  describe('expiry sweep', () => {
    it('expires still-live requests past their deadline', async () => {
      const b1 = await createBoard({ rosterDate: dateOffset(12), shiftLabel: label('Exp1') });
      const b2 = await createBoard({ rosterDate: dateOffset(13), shiftLabel: label('Exp2') });
      boardIds.push(b1.id, b2.id);
      const mine = await createAssignment({
        boardId: b1.id, staffId: requesterId, staffUid: REQUESTER_UID
      });
      const theirs = await createAssignment({
        boardId: b2.id, staffId: counterpartyId, staffUid: COUNTERPARTY_UID
      });
      const res = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({
          requester_assignment_id: mine.id,
          counterparty_assignment_id: theirs.id
        });
      expect(res.status).toBe(201);
      const staleSwapId = res.body.data.id;

      await prisma.$executeRawUnsafe(
        `UPDATE staff_shift_swap_requests
            SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1::int`,
        staleSwapId
      );
      const result = await expireStaleShiftSwapRequests({});
      expect(result.expired).toBeGreaterThanOrEqual(1);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT status FROM staff_shift_swap_requests WHERE id = $1::int`,
        staleSwapId
      );
      expect(rows[0].status).toBe('expired');

      const late = await authed('NURSING_STAFF', COUNTERPARTY_UID, counterpartyId)
        .post(`/api/v1/staff/roster-board/swaps/${staleSwapId}/respond`)
        .send({ decision: 'accept' });
      expect(late.status).toBe(409);
    });
  });

  describe('cross-tenant swap isolation', () => {
    let swapId;
    let mineId;
    let theirsId;

    beforeAll(async () => {
      const b1 = await createBoard({ rosterDate: dateOffset(16), shiftLabel: label('XT1') });
      const b2 = await createBoard({ rosterDate: dateOffset(17), shiftLabel: label('XT2') });
      boardIds.push(b1.id, b2.id);
      const mine = await createAssignment({
        boardId: b1.id, staffId: requesterId, staffUid: REQUESTER_UID
      });
      const theirs = await createAssignment({
        boardId: b2.id, staffId: counterpartyId, staffUid: COUNTERPARTY_UID
      });
      mineId = mine.id;
      theirsId = theirs.id;
      const proposed = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({ requester_assignment_id: mineId, counterparty_assignment_id: theirsId });
      expect(proposed.status).toBe(201);
      swapId = proposed.body.data.id;
      const accepted = await authed('NURSING_STAFF', COUNTERPARTY_UID, counterpartyId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/respond`)
        .send({ decision: 'accept' });
      expect(accepted.status).toBe(200);
    }, HOOK_TIMEOUT_MS);

    it('hides another tenant\'s assignments from the candidate list', async () => {
      const res = await authed('NURSING_STAFF', FOREIGN_UID, foreignId)
        .get('/api/v1/staff/roster-board/swaps/candidates');
      expect(res.status).toBe(200);
      expect(res.body.data.some(row => [mineId, theirsId].includes(row.assignment_id))).toBe(false);
    });

    it('rejects a review by an incharge from another tenant as not found', async () => {
      const res = await authed('NURSING_INCHARGE', FOREIGN_INCHARGE_UID, foreignInchargeId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/review`)
        .send({ decision: 'rejected', notes: 'cross-tenant attack' });
      expect(res.status).toBe(404);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT status FROM staff_shift_swap_requests WHERE id = $1::int`,
        swapId
      );
      expect(rows[0].status).toBe('counterparty_accepted');
    });

    it('does not list another tenant\'s swaps for a foreign department reviewer', async () => {
      const res = await authed('NURSING_INCHARGE', FOREIGN_INCHARGE_UID, foreignInchargeId)
        .get('/api/v1/staff/roster-board/departments/nursing/swaps');
      expect(res.status).toBe(200);
      expect(res.body.data.some(row => row.id === swapId)).toBe(false);
    });

    it('rejects respond/cancel from another tenant as not found', async () => {
      const respond = await authed('NURSING_STAFF', FOREIGN_UID, foreignId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/respond`)
        .send({ decision: 'decline' });
      expect(respond.status).toBe(404);

      const cancel = await authed('NURSING_STAFF', FOREIGN_UID, foreignId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/cancel`)
        .send({});
      expect(cancel.status).toBe(404);
    });

    it('still lets the same-tenant incharge review the swap', async () => {
      const res = await authed('NURSING_INCHARGE', INCHARGE_UID, inchargeId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/review`)
        .send({ decision: 'rejected', notes: 'Coverage does not hold' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('rejected');
    });
  });

  describe('approval-time eligibility re-validation', () => {
    let swapId;

    beforeAll(async () => {
      const b1 = await createBoard({ rosterDate: dateOffset(18), shiftLabel: label('EL1') });
      const b2 = await createBoard({ rosterDate: dateOffset(19), shiftLabel: label('EL2') });
      boardIds.push(b1.id, b2.id);
      const mine = await createAssignment({
        boardId: b1.id, staffId: requesterId, staffUid: REQUESTER_UID
      });
      const theirs = await createAssignment({
        boardId: b2.id, staffId: counterpartyId, staffUid: COUNTERPARTY_UID
      });
      const proposed = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({ requester_assignment_id: mine.id, counterparty_assignment_id: theirs.id });
      expect(proposed.status).toBe(201);
      swapId = proposed.body.data.id;
      const accepted = await authed('NURSING_STAFF', COUNTERPARTY_UID, counterpartyId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/respond`)
        .send({ decision: 'accept' });
      expect(accepted.status).toBe(200);
    }, HOOK_TIMEOUT_MS);

    it('refuses approval when a party was deactivated after proposing', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1::int`,
        counterpartyId
      );
      try {
        const res = await authed('NURSING_INCHARGE', INCHARGE_UID, inchargeId)
          .post(`/api/v1/staff/roster-board/swaps/${swapId}/review`)
          .send({ decision: 'approved' });
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/active/i);
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE users SET is_active = true, updated_at = NOW() WHERE id = $1::int`,
          counterpartyId
        );
      }
    });

    it('refuses approval when a party\'s role is no longer roster-eligible', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE users SET role = 'PHARMACY_STAFF', updated_at = NOW() WHERE id = $1::int`,
        counterpartyId
      );
      try {
        const res = await authed('NURSING_INCHARGE', INCHARGE_UID, inchargeId)
          .post(`/api/v1/staff/roster-board/swaps/${swapId}/review`)
          .send({ decision: 'approved' });
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/eligible/i);
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE users SET role = 'NURSING_STAFF', updated_at = NOW() WHERE id = $1::int`,
          counterpartyId
        );
      }
    });

    it('approves once both parties are active and eligible again', async () => {
      const res = await authed('NURSING_INCHARGE', INCHARGE_UID, inchargeId)
        .post(`/api/v1/staff/roster-board/swaps/${swapId}/review`)
        .send({ decision: 'approved', notes: 'Re-validated' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('approved');
      expect(res.body.data.exchanged).toBe(true);
    });
  });

  describe('swap evidence survives roster rewrites', () => {
    let boardOneId;
    let boardTwoId;
    let mineId;
    let theirsId;
    let swapId;
    const rwDateOne = dateOffset(20);
    const rwDateTwo = dateOffset(21);

    async function saveNursingBoard({ rosterDate, shiftLabel, staffId }) {
      return authed('NURSING_INCHARGE', INCHARGE_UID, inchargeId)
        .post('/api/v1/staff/roster-board/departments/nursing/boards')
        .send({
          roster_date: rosterDate,
          shift_label: shiftLabel,
          assignments: [{
            staff_id: staffId,
            assignment_target_type: 'ward',
            assignment_target_id: 1,
            assignment_target_label: 'Test Ward'
          }]
        });
    }

    async function assignmentIdFor(rosterId) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id FROM staff_shift_roster_assignments WHERE roster_id = $1::int ORDER BY id DESC LIMIT 1`,
        rosterId
      );
      return rows[0].id;
    }

    beforeAll(async () => {
      const incharge = authed('NURSING_INCHARGE', INCHARGE_UID, inchargeId);
      const savedOne = await saveNursingBoard({
        rosterDate: rwDateOne, shiftLabel: label('RW1'), staffId: requesterId
      });
      expect(savedOne.status).toBe(200);
      boardOneId = savedOne.body.data.id;
      const savedTwo = await saveNursingBoard({
        rosterDate: rwDateTwo, shiftLabel: label('RW2'), staffId: counterpartyId
      });
      expect(savedTwo.status).toBe(200);
      boardTwoId = savedTwo.body.data.id;
      boardIds.push(boardOneId, boardTwoId);

      for (const id of [boardOneId, boardTwoId]) {
        const published = await incharge
          .post(`/api/v1/staff/roster-board/boards/${id}/publish`)
          .send({ reason: 'Publish for swap rewrite test' });
        expect(published.status).toBe(200);
      }
      mineId = await assignmentIdFor(boardOneId);
      theirsId = await assignmentIdFor(boardTwoId);

      const proposed = await authed('NURSING_STAFF', REQUESTER_UID, requesterId)
        .post('/api/v1/staff/roster-board/swaps')
        .send({ requester_assignment_id: mineId, counterparty_assignment_id: theirsId });
      expect(proposed.status).toBe(201);
      swapId = proposed.body.data.id;
    }, HOOK_TIMEOUT_MS);

    it('fails closed on a direct assignment delete under a live swap', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM staff_shift_roster_assignments WHERE id = $1::int`,
          mineId
        )
      ).rejects.toThrow(/chk_staff_shift_swap_live_assignment_refs|23514/);
    });

    it('re-saving the board cancels the live swap and keeps the audit trail', async () => {
      const resaved = await saveNursingBoard({
        rosterDate: rwDateOne, shiftLabel: label('RW1'), staffId: requesterId
      });
      expect(resaved.status).toBe(200);

      const swaps = await prisma.$queryRawUnsafe(
        `SELECT status, requester_assignment_id, counterparty_assignment_id,
                requester_shift_snapshot, counterparty_shift_snapshot
           FROM staff_shift_swap_requests WHERE id = $1::int`,
        swapId
      );
      expect(swaps.length).toBe(1);
      expect(swaps[0].status).toBe('cancelled');
      // The rewritten board's assignment reference was nulled by the FK…
      expect(swaps[0].requester_assignment_id).toBeNull();
      // …the untouched board keeps its reference…
      expect(swaps[0].counterparty_assignment_id).toBe(theirsId);
      // …and the proposal-time snapshot preserves what was offered.
      expect(swaps[0].requester_shift_snapshot.shift_label).toBe(label('RW1'));
      expect(swaps[0].requester_shift_snapshot.roster_date).toBe(rwDateOne);

      const audit = await prisma.$queryRawUnsafe(
        `SELECT action FROM staff_shift_swap_request_audit
          WHERE swap_request_id = $1::int ORDER BY id`,
        swapId
      );
      expect(audit.map(row => row.action)).toEqual(['proposed', 'cancelled']);

      const notif = await prisma.$queryRawUnsafe(
        `SELECT user_id FROM notifications
          WHERE type = 'SHIFT_SWAP'
            AND (data->>'source') = 'shift_swap_cancelled_roster_resave'
            AND (data->>'swap_request_id')::int = $1::int`,
        swapId
      );
      expect(new Set(notif.map(row => row.user_id)))
        .toEqual(new Set([requesterId, counterpartyId]));
    });

    it('keeps the settled request and audit rows when assignments are deleted outright', async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM staff_shift_roster_assignments WHERE id = $1::int`,
        theirsId
      );
      const swaps = await prisma.$queryRawUnsafe(
        `SELECT status, counterparty_assignment_id, counterparty_shift_snapshot
           FROM staff_shift_swap_requests WHERE id = $1::int`,
        swapId
      );
      expect(swaps.length).toBe(1);
      expect(swaps[0].counterparty_assignment_id).toBeNull();
      expect(swaps[0].counterparty_shift_snapshot.shift_label).toBe(label('RW2'));

      const audit = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM staff_shift_swap_request_audit WHERE swap_request_id = $1::int`,
        swapId
      );
      expect(audit[0].n).toBe(2);
    });
  });

  describe('on-call roster', () => {
    let onCallId;

    it('refuses creation by a non-manager of the department', async () => {
      const res = await authed('NURSING_STAFF', OUTSIDER_UID, outsiderId)
        .post('/api/v1/staff/roster-board/departments/medical/on-call')
        .send({
          staff_id: oncallDocId,
          start_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          end_at: new Date(Date.now() + 13 * 60 * 60 * 1000).toISOString()
        });
      expect(res.status).toBe(403);
    });

    it('refuses to put another tenant\'s staff member on call', async () => {
      const res = await authed('ADMIN', ADMIN682_UID, adminId)
        .post('/api/v1/staff/roster-board/departments/nursing/on-call')
        .send({
          staff_id: foreignId,
          start_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          end_at: new Date(Date.now() + 13 * 60 * 60 * 1000).toISOString()
        });
      expect(res.status).toBe(404);
    });

    it('lets a department manager create an on-call stint', async () => {
      const res = await authed('ADMIN', ADMIN682_UID, adminId)
        .post('/api/v1/staff/roster-board/departments/medical/on-call')
        .send({
          staff_id: oncallDocId,
          tier: 1,
          specialty: 'cardiology',
          start_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          end_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
          notes: 'Night cover'
        });
      expect(res.status).toBe(201);
      expect(res.body.data.department).toBe('medical');
      expect(res.body.data.tier).toBe(1);
      onCallId = res.body.data.id;

      const notif = await prisma.$queryRawUnsafe(
        `SELECT id FROM notifications
          WHERE type = 'ON_CALL' AND user_id = $1::int
            AND (data->>'on_call_assignment_id')::int = $2::int`,
        oncallDocId, onCallId
      );
      expect(notif.length).toBe(1);
    });

    it('rejects an overlapping active stint for the same dept/specialty/tier', async () => {
      const res = await authed('ADMIN', ADMIN682_UID, adminId)
        .post('/api/v1/staff/roster-board/departments/medical/on-call')
        .send({
          staff_id: oncallDoc2Id,
          tier: 1,
          specialty: 'cardiology',
          start_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          end_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
        });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/overlap/i);
    });

    it('allows the same window on a different tier', async () => {
      const res = await authed('ADMIN', ADMIN682_UID, adminId)
        .post('/api/v1/staff/roster-board/departments/medical/on-call')
        .send({
          staff_id: oncallDoc2Id,
          tier: 2,
          specialty: 'cardiology',
          start_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          end_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
        });
      expect(res.status).toBe(201);
    });

    it('answers who-is-on-call now filtered by department and tier', async () => {
      const res = await authed('NURSING_STAFF', OUTSIDER_UID, outsiderId)
        .get('/api/v1/staff/roster-board/on-call/now?department=medical&tier=1');
      expect(res.status).toBe(200);
      const mine = res.body.data.filter(row => row.staff_id === oncallDocId);
      expect(mine.length).toBe(1);
      expect(mine[0].staff_name).toContain('On-call Doctor');
      expect(res.body.data.some(row => row.staff_id === oncallDoc2Id)).toBe(false);
    });

    it('shows the stint in /on-call/my for the assigned doctor', async () => {
      const res = await authed('DUTY_DOCTOR', ONCALL_DOC_UID, oncallDocId)
        .get('/api/v1/staff/roster-board/on-call/my');
      expect(res.status).toBe(200);
      expect(res.body.data.some(row => row.id === onCallId)).toBe(true);
    });

    it('lists the department roster for managers and blocks plain staff', async () => {
      const ok = await authed('ADMIN', ADMIN682_UID, adminId)
        .get('/api/v1/staff/roster-board/departments/medical/on-call');
      expect(ok.status).toBe(200);
      expect(ok.body.data.some(row => row.id === onCallId)).toBe(true);

      const blocked = await authed('NURSING_STAFF', OUTSIDER_UID, outsiderId)
        .get('/api/v1/staff/roster-board/departments/medical/on-call');
      expect(blocked.status).toBe(403);
    });

    it('ends a stint early with evidence and drops it from now-lookup', async () => {
      const res = await authed('ADMIN', ADMIN682_UID, adminId)
        .post(`/api/v1/staff/roster-board/on-call/${onCallId}/end`)
        .send({ reason: 'Doctor unwell' });
      expect(res.status).toBe(200);
      expect(res.body.data.is_active).toBe(false);
      expect(res.body.data.ended_at).toBeTruthy();
      expect(res.body.data.end_reason).toBe('Doctor unwell');

      const now = await authed('NURSING_STAFF', OUTSIDER_UID, outsiderId)
        .get('/api/v1/staff/roster-board/on-call/now?department=medical&tier=1');
      expect(now.status).toBe(200);
      expect(now.body.data.some(row => row.id === onCallId)).toBe(false);
    });
  });

  describe('escalation recipient ordering seam', () => {
    it('sorts an actively on-call clinician ahead of a more recently signed-in one', async () => {
      // Two DUTY_DOCTORs in an isolated tenant: A signed in a minute ago, B a
      // day ago. Without an on-call stint A leads; with B on call, B leads.
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at, last_sign_in_at)
         VALUES ($1::uuid, $2, 'Esc Doc A [test]', 'DUTY_DOCTOR', true, $3::uuid, NOW(), NOW() - INTERVAL '1 minute'),
                ($4::uuid, $5, 'Esc Doc B [test]', 'DUTY_DOCTOR', true, $3::uuid, NOW(), NOW() - INTERVAL '1 day')
         ON CONFLICT (uid) DO NOTHING`,
        ONCALL_ESC_UID_A, `+96${SUFFIX}200001`, ESCALATION_TENANT,
        ONCALL_ESC_UID_B, `+96${SUFFIX}200002`
      );
      const escUids = [ONCALL_ESC_UID_A, ONCALL_ESC_UID_B];
      const ids = await prisma.$queryRawUnsafe(
        `SELECT id, uid FROM users WHERE uid = ANY($1::uuid[])`,
        escUids
      );
      const idA = ids.find(row => row.uid === ONCALL_ESC_UID_A).id;
      const idB = ids.find(row => row.uid === ONCALL_ESC_UID_B).id;

      const before = await setTenantTx(ESCALATION_TENANT, tx =>
        escalationTesting.resolveRecipientsForRole(tx, ESCALATION_TENANT, 'DUTY_DOCTOR'));
      expect(before.map(row => row.id)).toEqual([idA, idB]);

      await prisma.$executeRawUnsafe(
        `INSERT INTO staff_on_call_assignments
           (tenant_id, department, tier, staff_id, staff_uid, staff_role,
            start_at, end_at, updated_at)
         VALUES ($1::uuid, 'medical', 1, $2::int, $3::uuid, 'DUTY_DOCTOR',
                 NOW() - INTERVAL '1 hour', NOW() + INTERVAL '8 hours', NOW())`,
        ESCALATION_TENANT, idB, ONCALL_ESC_UID_B
      );

      const after = await setTenantTx(ESCALATION_TENANT, tx =>
        escalationTesting.resolveRecipientsForRole(tx, ESCALATION_TENANT, 'DUTY_DOCTOR'));
      expect(after.map(row => row.id)).toEqual([idB, idA]);
    });
  });
});
