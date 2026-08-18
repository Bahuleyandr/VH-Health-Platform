/**
 * proposeShiftSwap — the "only future shifts can be swapped" gate.
 *
 * The gate reads `shift_start_at_epoch_ms`, the absolute-instant twin of the
 * computed `(roster_date + shift_start)::timestamptz`, not the driver Date
 * (PR #881). shiftSwapService had no unit tests at all, so this gate had zero
 * coverage in either direction.
 *
 * Note the shape: `shiftStartMs == null || shiftStartMs <= Date.now()` is the
 * FAIL-CLOSED form, correct for a gate — an unreadable start time refuses the
 * swap rather than allowing it. A dropped twin therefore does not open a hole,
 * it silently rejects every swap, which is why only a test can catch it.
 */

import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

const { proposeShiftSwap } = await import('../../services/staff/shiftSwapService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = { id: 11, uid: '11111111-1111-4111-8111-111111111111' };
const COLLEAGUE_ID = 22;

beforeEach(() => {
  queryRawUnsafe.mockReset();
});

/**
 * Both assignments sit on the same published housekeeping roster and differ
 * only in owner, so the future/past shift start is the sole variable.
 */
function assignment({ id, staffId, hoursFromNow }) {
  const startAt = new Date(Date.now() + hoursFromNow * 3600000);
  return {
    id,
    roster_id: 5,
    staff_id: staffId,
    staff_uid: staffId === ACTOR.id ? ACTOR.uid : '22222222-2222-4222-8222-222222222222',
    staff_role: 'HOUSEKEEPING_STAFF',
    assignment_status: 'published',
    assignment_target_label: 'Zone A',
    tenant_id: TENANT,
    department: 'housekeeping',
    roster_date: '2026-08-20',
    shift_label: 'Morning',
    shift_start: '08:00:00',
    shift_end: '16:00:00',
    board_status: 'published',
    shift_start_at: startAt.toISOString(),
    shift_start_at_epoch_ms: BigInt(startAt.getTime()),
    staff_name: staffId === ACTOR.id ? 'Actor Staff' : 'Colleague Staff',
    staff_user_role: 'HOUSEKEEPING_STAFF',
    staff_is_active: true,
  };
}

function mockRoster({ hoursFromNow, liveSwapExists = false }) {
  const mine = assignment({ id: 101, staffId: ACTOR.id, hoursFromNow });
  const theirs = assignment({ id: 202, staffId: COLLEAGUE_ID, hoursFromNow });

  queryRawUnsafe.mockImplementation(async (sql, ...params) => {
    const text = String(sql);
    if (text.includes('FROM users WHERE uid')) {
      return [{ id: ACTOR.id, uid: ACTOR.uid, name: 'Actor Staff', role: 'HOUSEKEEPING_STAFF' }];
    }
    if (text.includes('FROM staff_shift_roster_assignments a')) {
      return Number(params[0]) === 101 ? [mine] : [theirs];
    }
    if (text.includes('FROM staff_shift_swap_requests')) {
      // Reached only once the future-shift gate has passed. Returning a row
      // makes that fact observable without driving the whole write path.
      return liveSwapExists ? [{ id: 77, status: 'proposed' }] : [];
    }
    throw new Error(`Unexpected query in proposeShiftSwap unit test: ${text}`);
  });
}

// `Error.message` is not an enumerable own property, so `toMatchObject`
// silently misses it. Capture the rejection and assert on it directly.
async function rejection(promise) {
  return promise.then(
    () => { throw new Error('expected proposeShiftSwap to reject, but it resolved'); },
    (err) => err,
  );
}

const propose = () => proposeShiftSwap({
  requesterAssignmentId: 101,
  counterpartyAssignmentId: 202,
  reason: 'family commitment',
  actorUser: ACTOR,
  tenantId: TENANT,
});

test('a shift that already started cannot be swapped', async () => {
  mockRoster({ hoursFromNow: -2 });

  const err = await rejection(propose());
  expect(err.message).toBe('Only future shifts can be swapped');
  expect(err.statusCode).toBe(400);
});

test('a future shift clears the gate and proceeds to the live-swap check', async () => {
  // The distinct error proves execution passed the future-shift gate — a
  // dropped twin would have failed with "Only future shifts can be swapped".
  mockRoster({ hoursFromNow: 48, liveSwapExists: true });

  const err = await rejection(propose());
  expect(err.message).toBe('One of these shifts already has an open swap request. Cancel or resolve it first.');
  expect(err.statusCode).toBe(409);
});

test('the gate is a strict boundary — a shift starting in the past by a minute is refused', async () => {
  mockRoster({ hoursFromNow: -1 / 60 });

  const err = await rejection(propose());
  expect(err.message).toBe('Only future shifts can be swapped');
});
