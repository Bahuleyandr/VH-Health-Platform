/**
 * Off-critical-path scheduling for the cath-lab readiness refresh.
 *
 * Plan 3 final review, F2: the lab writers used to `await` the readiness
 * refresh inline after commit, putting ~8 queries per open case on the
 * sign-off's latency. The refresh is best-effort by design — a snapshot one
 * event behind is repaired by the next refresh — so it belongs off the
 * writer's critical path.
 *
 * What the scheduler has to keep, and what this suite pins:
 *   - the job runs AFTER the caller's continuation, never inside it;
 *   - identical (tenantId, patientUid) pairs scheduled in one tick collapse to
 *     one refresh (bounded fan-out for an ORU carrying many rows);
 *   - DISTINCT pairs do not collapse but do not run concurrently either: the
 *     writer's `await` used to serialise them, and each refresh holds a pool
 *     connection across ~10-17 statements, so the scheduler serialises them;
 *   - a failing refresh is swallowed and logged, never thrown at the writer;
 *   - `flushScheduledReadinessRefreshes()` awaits every scheduled job, so the
 *     deep tests are deterministic rather than poll-and-hope.
 */
import { jest } from '@jest/globals';

const refreshOpenCasesForPatient = jest.fn();
const warn = jest.fn();

jest.unstable_mockModule('../../services/clinical/cathLabReadinessService.js', () => ({
  refreshOpenCasesForPatient,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn, error: jest.fn(), debug: jest.fn(),
  },
}));

const {
  flushScheduledReadinessRefreshes,
  scheduleReadinessRefresh,
} = await import('../../services/clinical/cathLabReadinessHooks.js');

const TENANT = '00000000-0000-4000-8000-0000000c1a00';
const PATIENT = 'cd000000-0000-4000-8000-0000000c1a01';
const OTHER_PATIENT = 'cd000000-0000-4000-8000-0000000c1a02';

beforeEach(() => {
  refreshOpenCasesForPatient.mockReset();
  refreshOpenCasesForPatient.mockResolvedValue(1);
  warn.mockReset();
});

afterEach(async () => {
  await flushScheduledReadinessRefreshes();
});

describe('scheduleReadinessRefresh', () => {
  test('runs the refresh after the caller returns, not inside the call', async () => {
    const order = [];
    refreshOpenCasesForPatient.mockImplementation(async () => { order.push('refresh'); return 1; });

    // A lab writer's post-commit tail: schedule, then keep working. Nothing the
    // caller does after scheduling may observe the refresh having run.
    const caller = async () => {
      scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT, source: 'test' });
      order.push('scheduled');
      await Promise.resolve();
      await new Promise((resolve) => { process.nextTick(resolve); });
      order.push('caller-returned');
    };

    await caller();
    expect(refreshOpenCasesForPatient).not.toHaveBeenCalled();

    await flushScheduledReadinessRefreshes();
    expect(order).toEqual(['scheduled', 'caller-returned', 'refresh']);
    expect(refreshOpenCasesForPatient).toHaveBeenCalledWith({
      tenantId: TENANT, patientUid: PATIENT,
    });
  });

  test('collapses identical (tenantId, patientUid) pairs scheduled in one tick', async () => {
    expect(scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT })).toBe(true);
    expect(scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT })).toBe(false);
    expect(scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT, source: 'oru' })).toBe(false);
    expect(scheduleReadinessRefresh({ tenantId: TENANT, patientUid: OTHER_PATIENT })).toBe(true);

    expect(await flushScheduledReadinessRefreshes()).toBe(2);
    expect(refreshOpenCasesForPatient).toHaveBeenCalledTimes(2);
    expect(refreshOpenCasesForPatient.mock.calls.map(([arg]) => arg.patientUid).sort())
      .toEqual([PATIENT, OTHER_PATIENT].sort());
  });

  test('runs jobs for distinct pairs strictly one after another, never concurrently', async () => {
    // The inline `await` this scheduler replaced serialised the refreshes by
    // construction. An ORU carrying rows for N patients schedules N jobs in one
    // tick; without the queue they would all be mid-refresh at once, each
    // holding a pool connection across its 10-17 statements.
    const order = [];
    refreshOpenCasesForPatient.mockImplementation(async ({ patientUid }) => {
      order.push(`start:${patientUid}`);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      order.push(`end:${patientUid}`);
      return 1;
    });

    scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT });
    scheduleReadinessRefresh({ tenantId: TENANT, patientUid: OTHER_PATIENT });
    expect(await flushScheduledReadinessRefreshes()).toBe(2);

    // Interleaved starts would read start,start,end,end.
    expect(order).toEqual([
      `start:${PATIENT}`, `end:${PATIENT}`,
      `start:${OTHER_PATIENT}`, `end:${OTHER_PATIENT}`,
    ]);
  });

  test('a pair scheduled while its own job is RUNNING gets a second refresh, after the first', async () => {
    // The dedupe key is released the instant the job starts, so a lab event that
    // lands mid-refresh is not folded into a refresh that already read the DB —
    // and the queue still keeps the two from overlapping.
    const order = [];
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    let announceFirstStarted;
    const firstStarted = new Promise((resolve) => { announceFirstStarted = resolve; });
    let calls = 0;

    refreshOpenCasesForPatient.mockImplementation(async () => {
      calls += 1;
      const nth = calls;
      order.push(`start:${nth}`);
      if (nth === 1) {
        announceFirstStarted();
        await firstHeld;
      }
      order.push(`end:${nth}`);
      return 1;
    });

    expect(scheduleReadinessRefresh({
      tenantId: TENANT, patientUid: PATIENT, source: 'ingestORU',
    })).toBe(true);
    await firstStarted;

    expect(scheduleReadinessRefresh({
      tenantId: TENANT, patientUid: PATIENT, source: 'signOffResults',
    })).toBe(true);
    releaseFirst();
    await flushScheduledReadinessRefreshes();

    expect(refreshOpenCasesForPatient).toHaveBeenCalledTimes(2);
    expect(refreshOpenCasesForPatient.mock.calls.map(([arg]) => arg.patientUid))
      .toEqual([PATIENT, PATIENT]);
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  test('a pair scheduled again AFTER its job has started gets its own refresh', async () => {
    scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT });
    await flushScheduledReadinessRefreshes();
    scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT });
    await flushScheduledReadinessRefreshes();
    expect(refreshOpenCasesForPatient).toHaveBeenCalledTimes(2);
  });

  test('the same patient uid under a different tenant is a different job', async () => {
    const otherTenant = '00000000-0000-4000-8000-0000000c1aff';
    expect(scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT })).toBe(true);
    expect(scheduleReadinessRefresh({ tenantId: otherTenant, patientUid: PATIENT })).toBe(true);
    await flushScheduledReadinessRefreshes();
    expect(refreshOpenCasesForPatient).toHaveBeenCalledTimes(2);
  });

  test('swallows and logs a failing refresh; the writer never sees it', async () => {
    refreshOpenCasesForPatient.mockRejectedValue(new Error('readiness exploded'));

    expect(() => scheduleReadinessRefresh({
      tenantId: TENANT, patientUid: PATIENT, source: 'signOffResults',
    })).not.toThrow();
    await expect(flushScheduledReadinessRefreshes()).resolves.toBe(1);

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0];
    expect(message).toMatch(/readiness refresh/i);
    expect(meta).toMatchObject({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'signOffResults',
      error: 'readiness exploded',
    });
  });

  test('flush awaits the job to completion, not merely to its start', async () => {
    let finished = false;
    let release;
    const started = new Promise((resolve) => { release = resolve; });
    refreshOpenCasesForPatient.mockImplementation(async () => {
      await started;
      finished = true;
      return 1;
    });

    scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT });
    setTimeout(() => release(), 20);
    await flushScheduledReadinessRefreshes();
    expect(finished).toBe(true);
  });

  test('a job scheduled from inside a running job is still drained by the same flush', async () => {
    refreshOpenCasesForPatient.mockImplementation(async ({ patientUid }) => {
      if (patientUid === PATIENT) {
        scheduleReadinessRefresh({ tenantId: TENANT, patientUid: OTHER_PATIENT });
      }
      return 1;
    });
    scheduleReadinessRefresh({ tenantId: TENANT, patientUid: PATIENT });
    expect(await flushScheduledReadinessRefreshes()).toBe(2);
  });

  test('refuses a job with no tenant or no patient rather than scheduling a doomed refresh', async () => {
    expect(scheduleReadinessRefresh({ tenantId: TENANT, patientUid: null })).toBe(false);
    expect(scheduleReadinessRefresh({ tenantId: TENANT, patientUid: '  ' })).toBe(false);
    expect(scheduleReadinessRefresh({ tenantId: null, patientUid: PATIENT })).toBe(false);
    expect(scheduleReadinessRefresh()).toBe(false);
    expect(await flushScheduledReadinessRefreshes()).toBe(0);
    expect(refreshOpenCasesForPatient).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test('flush with nothing outstanding resolves immediately', async () => {
    await expect(flushScheduledReadinessRefreshes()).resolves.toBe(0);
  });
});
