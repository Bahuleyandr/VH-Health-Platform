// src/utils/probeDb.js
//
// The liveness/readiness DB probe behind `GET /` and `HEAD /`.
//
// It runs a real `SELECT 1` through the Prisma pool, which is the point: a pod
// whose database is gone must not report healthy. What it must NOT do is take
// longer than the kubelet is willing to wait. During the 2026-09-09 06:40Z boot
// storm the pool was saturated by the scheduled-job roster and `SELECT 1` sat
// behind 1.1-1.7 s queries; the probe request never completed inside the
// kubelet's 1 s budget, so the probe recorded "deadline exceeded" instead of a
// 503 and the pod was marked NotReady on the timeout rather than on a verdict.
//
// Giving the query its own, shorter budget turns a saturated pool into a fast,
// truthful 503: the endpoint still answers, still answers 503, and answers
// before the probe's own timeout can fire. The 503 semantics are unchanged —
// `false` here means exactly what it meant before.
export const DEFAULT_PROBE_DB_TIMEOUT_MS = 2_000;

// Resolved through the globals on every call, not captured at module load, so
// a swapped clock (jest fake timers) is honoured.
const defaultTimers = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};

/** Probe budget in ms. 0 disables the budget (pre-2026-09-09 behaviour). */
export function resolveProbeDbTimeoutMs(env = process.env) {
  const raw = env?.PROBE_DB_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_PROBE_DB_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PROBE_DB_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

/**
 * Resolve true when the Prisma pool answered `SELECT 1` within the budget,
 * false when it errored OR did not answer in time. Never throws.
 */
export async function probeDb(options = {}) {
  const { prisma: injectedPrisma, timers = defaultTimers, env } = options;
  const timeoutMs = options.timeoutMs === undefined
    ? resolveProbeDbTimeoutMs(env)
    : Math.max(0, Math.floor(Number(options.timeoutMs) || 0));

  let timer = null;
  try {
    const prisma = injectedPrisma || (await import('../lib/prisma.js')).default;
    const query = prisma.$queryRaw`SELECT 1`;

    if (timeoutMs <= 0) {
      await query;
      return true;
    }

    // The losing side of the race still settles later. Without this handler a
    // slow query that eventually rejects would surface as an unhandled
    // rejection and www.js's unhandledRejection hook would shut the pod down —
    // turning a slow probe into an outage.
    Promise.resolve(query).catch(() => {});

    const expiry = new Promise((_resolve, reject) => {
      timer = timers.setTimeout(
        () => reject(new Error(`probeDb exceeded its ${timeoutMs}ms budget`)),
        timeoutMs,
      );
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    });

    await Promise.race([query, expiry]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) {
      timers.clearTimeout(timer);
    }
  }
}

export default probeDb;
