// src/tests/unit/schedulerBootPacing.test.js
//
// Behavioural pins for the two boot-storm knobs introduced after the
// 2026-09-09 06:40Z dalekdefender incident (see utils/schedulerBootPacing.js):
//   • withBootPacing()        — per-job first-run jitter on the cron roster
//   • scheduleDeferredBootRun() — the boot sweep no longer runs at boot
import { jest } from '@jest/globals';
import {
  DEFAULT_BOOT_JITTER_WINDOW_MS,
  DEFAULT_BOOT_RUN_DELAY_MS,
  DEFAULT_BOOT_RUN_STEP_DELAY_MS,
  cancelPendingBootPacing,
  cronIntervalHintMs,
  firstRunOffsetMs,
  pendingBootPacingCount,
  resolveBootJitterWindowMs,
  resolveBootRunDelayMs,
  resolveBootRunStepDelayMs,
  scheduleDeferredBootRun,
  withBootPacing,
} from '../../utils/schedulerBootPacing.js';

describe('cron cadence hint', () => {
  it('resolves the recurring forms scheduler.js actually uses', () => {
    expect(cronIntervalHintMs('*/5 * * * *')).toBe(300_000);
    expect(cronIntervalHintMs('*/2 * * * *')).toBe(120_000);
    expect(cronIntervalHintMs('* * * * *')).toBe(60_000);
    expect(cronIntervalHintMs('*/30 * * * * *')).toBe(30_000);
    expect(cronIntervalHintMs('*/60 * * * * *')).toBe(60_000);
    expect(cronIntervalHintMs('0 * * * * *')).toBe(60_000);
    expect(cronIntervalHintMs('15 * * * * *')).toBe(60_000);
  });

  it('treats hourly and rarer schedules as uncapped', () => {
    expect(cronIntervalHintMs('0 * * * *')).toBe(Number.POSITIVE_INFINITY);
    expect(cronIntervalHintMs('0 0 * * *')).toBe(Number.POSITIVE_INFINITY);
    expect(cronIntervalHintMs('30 2 * * 1')).toBe(Number.POSITIVE_INFINITY);
    expect(cronIntervalHintMs(undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('first-run offsets', () => {
  it('gives consecutive registrations distinct offsets inside the window', () => {
    const offsets = [];
    for (let index = 0; index < 40; index += 1) {
      offsets.push(firstRunOffsetMs(index, '*/5 * * * *', DEFAULT_BOOT_JITTER_WINDOW_MS));
    }
    expect(offsets).toHaveLength(40);
    expect(new Set(offsets).size).toBe(40);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(DEFAULT_BOOT_JITTER_WINDOW_MS);
    }
  });

  it('is deterministic for a given index and expression', () => {
    expect(firstRunOffsetMs(7, '*/5 * * * *', 20_000))
      .toBe(firstRunOffsetMs(7, '*/5 * * * *', 20_000));
  });

  it('never pushes a first tick past the job’s own next tick', () => {
    // Every-30-seconds jobs: the offset must stay under half the cadence.
    for (let index = 0; index < 40; index += 1) {
      expect(firstRunOffsetMs(index, '*/30 * * * * *', DEFAULT_BOOT_JITTER_WINDOW_MS))
        .toBeLessThan(15_000);
    }
  });

  it('collapses to zero when the jitter window is disabled', () => {
    for (let index = 0; index < 10; index += 1) {
      expect(firstRunOffsetMs(index, '*/5 * * * *', 0)).toBe(0);
    }
  });

  it('reads the window from SCHEDULER_BOOT_JITTER_MS and falls back on junk', () => {
    expect(resolveBootJitterWindowMs({})).toBe(DEFAULT_BOOT_JITTER_WINDOW_MS);
    expect(resolveBootJitterWindowMs({ SCHEDULER_BOOT_JITTER_MS: '5000' })).toBe(5000);
    expect(resolveBootJitterWindowMs({ SCHEDULER_BOOT_JITTER_MS: '0' })).toBe(0);
    expect(resolveBootJitterWindowMs({ SCHEDULER_BOOT_JITTER_MS: 'later' }))
      .toBe(DEFAULT_BOOT_JITTER_WINDOW_MS);
  });
});

describe('withBootPacing', () => {
  afterEach(() => {
    cancelPendingBootPacing();
    jest.useRealTimers();
  });

  it('does not run a job on the tick that first fires it', async () => {
    jest.useFakeTimers();
    const handler = jest.fn(async () => 'ran');
    const paced = withBootPacing(3, '*/5 * * * *', handler, { windowMs: 20_000 });

    const pending = paced();
    await Promise.resolve();
    // Pre-fix, the cron handler ran synchronously on the boundary tick — 40+
    // of them in the same second at 06:40:00.
    expect(handler).not.toHaveBeenCalled();
    expect(pendingBootPacingCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toBe('ran');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(pendingBootPacingCount()).toBe(0);
  });

  it('runs every later tick immediately', async () => {
    jest.useFakeTimers();
    const handler = jest.fn(async () => 'ran');
    const paced = withBootPacing(3, '*/5 * * * *', handler, { windowMs: 20_000 });

    const first = paced();
    await jest.advanceTimersByTimeAsync(20_000);
    await first;
    expect(handler).toHaveBeenCalledTimes(1);

    await paced();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('spreads two registrations onto different instants', async () => {
    jest.useFakeTimers();
    const early = jest.fn();
    const late = jest.fn();
    // Indices 1 and 2 → 7919 ms and 15838 ms.
    const pacedEarly = withBootPacing(1, '*/5 * * * *', early, { windowMs: 20_000 });
    const pacedLate = withBootPacing(2, '*/5 * * * *', late, { windowMs: 20_000 });

    const runs = Promise.all([pacedEarly(), pacedLate()]);
    await jest.advanceTimersByTimeAsync(8000);
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(12_000);
    await runs;
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('passes the handler straight through when the offset is zero', async () => {
    const handler = jest.fn(async () => 'ran');
    const paced = withBootPacing(5, '*/5 * * * *', handler, { windowMs: 0 });
    expect(paced).toBe(handler);
    await paced();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('drops a pending first run when shutdown cancels the pacing', async () => {
    jest.useFakeTimers();
    const handler = jest.fn();
    const paced = withBootPacing(3, '*/5 * * * *', handler, { windowMs: 20_000 });

    const pending = paced();
    await Promise.resolve();
    expect(pendingBootPacingCount()).toBe(1);

    expect(cancelPendingBootPacing()).toBe(1);
    await expect(pending).resolves.toBeUndefined();

    await jest.advanceTimersByTimeAsync(60_000);
    // A cancelled first run must never reach a closing Prisma pool.
    expect(handler).not.toHaveBeenCalled();
    expect(pendingBootPacingCount()).toBe(0);
  });
});

describe('scheduleDeferredBootRun', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not run the sweep synchronously', async () => {
    jest.useFakeTimers();
    const run = jest.fn(async () => 'swept');
    const handle = scheduleDeferredBootRun({ run, delayMs: 45_000 });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(handle.delayMs).toBe(45_000);
    handle.cancel();
  });

  it('runs the sweep after the configured delay', async () => {
    jest.useFakeTimers();
    const run = jest.fn(async () => 'swept');
    const handle = scheduleDeferredBootRun({ run, delayMs: 45_000 });

    await jest.advanceTimersByTimeAsync(44_999);
    expect(run).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await expect(handle.completed).resolves.toEqual({ ran: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports a failing sweep without rejecting or crashing the process', async () => {
    jest.useFakeTimers();
    const boom = new Error('tenant discovery failed');
    const onError = jest.fn();
    const handle = scheduleDeferredBootRun({
      run: async () => { throw boom; },
      delayMs: 1000,
      onError,
    });
    await jest.advanceTimersByTimeAsync(1000);
    const outcome = await handle.completed;
    expect(outcome.ran).toBe(true);
    expect(outcome.error).toBe(boom);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('cancels cleanly when the pod shuts down inside the delay window', async () => {
    jest.useFakeTimers();
    const run = jest.fn();
    const handle = scheduleDeferredBootRun({ run, delayMs: 45_000 });
    handle.cancel();
    await expect(handle.completed).resolves.toEqual({ ran: false, cancelled: true });
    await jest.advanceTimersByTimeAsync(90_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('defaults the delay to 45 s and the inter-task pause to 250 ms, both env-tunable', () => {
    expect(DEFAULT_BOOT_RUN_DELAY_MS).toBe(45_000);
    expect(DEFAULT_BOOT_RUN_STEP_DELAY_MS).toBe(250);
    expect(resolveBootRunDelayMs({})).toBe(45_000);
    expect(resolveBootRunDelayMs({ SCHEDULER_BOOT_RUN_DELAY_MS: '10000' })).toBe(10_000);
    expect(resolveBootRunDelayMs({ SCHEDULER_BOOT_RUN_DELAY_MS: 'never' })).toBe(45_000);
    expect(resolveBootRunStepDelayMs({})).toBe(250);
    expect(resolveBootRunStepDelayMs({ SCHEDULER_BOOT_RUN_STEP_DELAY_MS: '0' })).toBe(0);
  });

  it('leaves the readiness probe several periods of head start', () => {
    // Rig manifest: readiness initialDelaySeconds 15, periodSeconds 10.
    const firstProbeMs = 15_000;
    const probePeriodMs = 10_000;
    const probesBeforeSweep = Math.floor((DEFAULT_BOOT_RUN_DELAY_MS - firstProbeMs) / probePeriodMs) + 1;
    expect(probesBeforeSweep).toBeGreaterThanOrEqual(3);
  });
});
