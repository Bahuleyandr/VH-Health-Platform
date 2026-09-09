// src/utils/schedulerBootPacing.js
//
// Boot-storm pacing for the scheduled-job roster.
//
// Incident 2026-09-09 06:40Z (dalekdefender deploy run 34319246507): a freshly
// Recreate-d backend pod became Ready at 06:39:50 and, ten seconds later, ran
// roughly twenty scheduled jobs inside the same second. 06:40 is simultaneously
// a `*/2`, `*/5` and `*/10` boundary, and scheduler.js registers 77 schedules —
// 24 of them `*/5`, 10 `*/2`, 3 `*/10`, 2 every minute — so every one of those
// handlers fired on the same tick against one database. Prisma queries that
// normally take milliseconds took 1.1-1.7 s, `GET /` (a real `SELECT 1`) could
// not answer inside the kubelet's 1 s probe budget, three consecutive readiness
// probes failed, and the deploy wrapper rolled a healthy image back.
//
// Two independent knobs live here, both env-tunable and both fail-safe (a bad
// value falls back to the default; zero disables):
//
//   1. `withBootPacing()` — per-job FIRST-RUN jitter. Every registered cron
//      handler gets a deterministic offset in [0, window) derived from its
//      registration index, applied only to its first tick after process start.
//      Subsequent ticks are untouched. Nothing is skipped: a job whose first
//      tick lands inside the window still runs, just a few seconds later. The
//      offset is additionally capped at half the job's own cadence so a
//      sub-minute schedule can never have its first tick pushed past its
//      second one.
//
//   2. `scheduleDeferredBootRun()` — defers the boot-time
//      `runAllScheduledTasksNow()` sweep until after the HTTP listener is up
//      and readiness has had several probe periods to pass. The rig's readiness
//      probe has initialDelaySeconds 15 / periodSeconds 10, so the 45 s default
//      leaves at least three probe opportunities before the sweep starts.
//
// Neither knob touches the per-job advisory locks (withJobLock) or the
// graceful-shutdown path: `cancelPendingBootPacing()` is called by
// scheduler.js's stopAllScheduledTasks(), and the deferred-run handle exposes
// `cancel()` for bin/www.js's gracefulShutdown, so no paced timer can fire a
// query against a closing Prisma pool.

export const DEFAULT_BOOT_RUN_DELAY_MS = 45_000;
export const DEFAULT_BOOT_RUN_STEP_DELAY_MS = 250;
export const DEFAULT_BOOT_JITTER_WINDOW_MS = 20_000;

// Prime step. Successive registration indices land on offsets that are spread
// across the whole window instead of clustering (gcd(7919, window) is 1 for
// every window we use, so 77 registrations get 77 distinct offsets).
const FIRST_RUN_OFFSET_STEP_MS = 7919;

// Resolved through the globals on every call, not captured at module load:
// jest's fake timers swap the globals after this module is evaluated, and a
// captured reference would silently keep using the real clock.
const defaultTimers = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};

function readNonNegativeIntEnv(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/** Delay between `listen` and the boot-time runAllScheduledTasksNow() sweep. */
export function resolveBootRunDelayMs(env = process.env) {
  return readNonNegativeIntEnv(env, 'SCHEDULER_BOOT_RUN_DELAY_MS', DEFAULT_BOOT_RUN_DELAY_MS);
}

/** Pause inserted between the individual tasks of the boot sweep. */
export function resolveBootRunStepDelayMs(env = process.env) {
  return readNonNegativeIntEnv(
    env,
    'SCHEDULER_BOOT_RUN_STEP_DELAY_MS',
    DEFAULT_BOOT_RUN_STEP_DELAY_MS,
  );
}

/** Width of the per-job first-run jitter window. 0 disables the jitter. */
export function resolveBootJitterWindowMs(env = process.env) {
  return readNonNegativeIntEnv(env, 'SCHEDULER_BOOT_JITTER_MS', DEFAULT_BOOT_JITTER_WINDOW_MS);
}

function stepFieldSeconds(field) {
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Cadence hint for a node-cron expression, in ms. Only the recurring `* / N`
 * and bare `*` forms are resolved — everything else (hourly-at-:25, daily,
 * monthly) returns Infinity, which simply means "no cadence cap needed": those
 * jobs are far enough apart that a jitter of a few seconds cannot collide with
 * their next tick.
 *
 * Accepts both the 5-field (minute-first) and 6-field (second-first) forms
 * node-cron supports; scheduler.js uses both.
 */
export function cronIntervalHintMs(expression) {
  if (typeof expression !== 'string') {
    return Number.POSITIVE_INFINITY;
  }
  const fields = expression.trim().split(/\s+/);

  if (fields.length === 6) {
    const [second, minute] = fields;
    const secondStep = stepFieldSeconds(second);
    if (secondStep !== null) {
      return secondStep * 1000;
    }
    if (second === '*') {
      return 1000;
    }
    // Fixed second (e.g. `15 * * * * *`): cadence comes from the minute field.
    const minuteStep = stepFieldSeconds(minute);
    if (minuteStep !== null) {
      return minuteStep * 60_000;
    }
    if (minute === '*') {
      return 60_000;
    }
    return Number.POSITIVE_INFINITY;
  }

  if (fields.length === 5) {
    const [minute] = fields;
    const minuteStep = stepFieldSeconds(minute);
    if (minuteStep !== null) {
      return minuteStep * 60_000;
    }
    if (minute === '*') {
      return 60_000;
    }
    return Number.POSITIVE_INFINITY;
  }

  return Number.POSITIVE_INFINITY;
}

/**
 * Deterministic first-run offset for the job registered at `index` under
 * `expression`. Always < the effective window, and always < half the job's own
 * cadence, so the delayed first tick can never overtake the second one.
 */
export function firstRunOffsetMs(index, expression, windowMs) {
  const window = Number.isFinite(windowMs) ? Math.max(0, Math.floor(windowMs)) : 0;
  if (window <= 0 || !Number.isInteger(index) || index < 0) {
    return 0;
  }
  const cadence = cronIntervalHintMs(expression);
  const cadenceCap = Number.isFinite(cadence) ? Math.floor(cadence / 2) : window;
  const effective = Math.min(window, Math.max(0, cadenceCap));
  if (effective <= 0) {
    return 0;
  }
  return (index * FIRST_RUN_OFFSET_STEP_MS) % effective;
}

// Pending first-run timers, so graceful shutdown can drop them before Prisma
// disconnects. Entries are removed as soon as their handler is released.
const pendingFirstRuns = new Set();

/**
 * Drop every first-run timer that has not fired yet. Returns how many were
 * cancelled. Called by scheduler.js stopAllScheduledTasks().
 */
export function cancelPendingBootPacing() {
  const entries = [...pendingFirstRuns];
  pendingFirstRuns.clear();
  for (const entry of entries) {
    entry.cancel();
  }
  return entries.length;
}

/** Number of first-run timers still waiting. Test/observability helper. */
export function pendingBootPacingCount() {
  return pendingFirstRuns.size;
}

/**
 * Wrap a cron handler so its FIRST invocation after boot is delayed by the
 * job's deterministic offset. Later invocations call through untouched.
 *
 * With a zero offset (jitter disabled, or index 0) the wrapper is a plain
 * pass-through — the handler still runs on the same tick, exactly as before.
 */
export function withBootPacing(index, expression, handler, options = {}) {
  const timers = options.timers || defaultTimers;
  const windowMs = options.windowMs === undefined
    ? resolveBootJitterWindowMs(options.env)
    : options.windowMs;
  const offsetMs = firstRunOffsetMs(index, expression, windowMs);

  if (offsetMs <= 0) {
    return handler;
  }

  let firstRunConsumed = false;
  return function bootPacedHandler(...args) {
    if (firstRunConsumed) {
      return handler(...args);
    }
    firstRunConsumed = true;
    return new Promise((resolve) => {
      const entry = { cancel: null };
      const timer = timers.setTimeout(() => {
        pendingFirstRuns.delete(entry);
        resolve(handler(...args));
      }, offsetMs);
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
      entry.cancel = () => {
        timers.clearTimeout(timer);
        // Resolve rather than leave the caller's promise dangling; node-cron
        // ignores the value and shutdown is already under way.
        resolve(undefined);
      };
      pendingFirstRuns.add(entry);
    });
  };
}

/**
 * Schedule the boot-time sweep to start `delayMs` after the caller (bin/www.js
 * onListening) invokes this. Never runs `run` synchronously.
 *
 * Returns `{ delayMs, completed, cancel }`. `completed` resolves with
 * `{ ran: true }` once the sweep settles (errors are reported through
 * `onError` and do not reject), or `{ ran: false, cancelled: true }` if the
 * handle was cancelled before the timer fired.
 */
export function scheduleDeferredBootRun(options = {}) {
  const {
    run,
    onError,
    env,
    timers = defaultTimers,
  } = options;
  const delayMs = options.delayMs === undefined
    ? resolveBootRunDelayMs(env)
    : Math.max(0, Math.floor(Number(options.delayMs) || 0));

  let settle;
  const completed = new Promise((resolve) => {
    settle = resolve;
  });

  const timer = timers.setTimeout(() => {
    Promise.resolve()
      .then(() => run?.())
      .then(() => settle({ ran: true }))
      .catch((err) => {
        try {
          onError?.(err);
        } catch {
          // A failing error reporter must not take the process down.
        }
        settle({ ran: true, error: err });
      });
  }, delayMs);
  if (typeof timer?.unref === 'function') {
    timer.unref();
  }

  return {
    delayMs,
    completed,
    cancel() {
      timers.clearTimeout(timer);
      settle({ ran: false, cancelled: true });
    },
  };
}
