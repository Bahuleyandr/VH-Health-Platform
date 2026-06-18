import logger from '../logging/logger.js';

const routeErrors = new Map(); // key: route, value: { count, firstError, lastError, errors }
const WINDOW_MS = 60_000;
const THRESHOLD = 5;
// Cap the number of distinct route keys tracked. Without this the Map grows one
// entry per ever-seen route key and is never evicted — a slow memory leak,
// especially under path-fuzzing (req.path varies per probe when req.route is
// unmatched). Map preserves insertion order, so the first key is the
// least-recently-inserted; we touch-on-access (delete+set) to make it LRU and
// evict the oldest once over the cap.
const MAX_TRACKED_ROUTES = 1000;
const healingActions = [];

export function selfHealingMiddleware(req, res, next) {
  const originalEnd = res.end;
  res.end = function(...args) {
    if (res.statusCode >= 500) {
      recordError(req.route?.path || req.path, res.statusCode);
    }
    originalEnd.apply(res, args);
  };
  next();
}

function recordError(route, statusCode) {
  const now = Date.now();
  let entry = routeErrors.get(route);
  if (entry) {
    // Touch: re-insert so this key becomes most-recently-used (moves to the
    // back of the Map's insertion order).
    routeErrors.delete(route);
  } else {
    entry = { count: 0, firstError: now, lastError: now, errors: [] };
  }
  routeErrors.set(route, entry);

  // Evict the least-recently-used key(s) once over the cap. A while-loop keeps
  // the invariant even if MAX_TRACKED_ROUTES is ever lowered at runtime.
  while (routeErrors.size > MAX_TRACKED_ROUTES) {
    const oldestKey = routeErrors.keys().next().value;
    routeErrors.delete(oldestKey);
  }
  // Reset window if expired
  if (now - entry.firstError > WINDOW_MS) {
    entry.count = 0;
    entry.firstError = now;
    entry.errors = [];
  }
  entry.count++;
  entry.lastError = now;
  entry.errors.push({ statusCode, timestamp: now });

  if (entry.count >= THRESHOLD) {
    triggerHealing(route, entry);
  }
}

async function triggerHealing(route, entry) {
  const action = {
    route,
    errorCount: entry.count,
    triggeredAt: new Date().toISOString(),
    action: 'none',
  };

  logger.error(`🚨 Self-healing triggered for ${route}: ${entry.count} errors in ${WINDOW_MS/1000}s`);

  // DB pool-pressure check retired in batch 28 — the pg pool was consolidated
  // onto Prisma's internal pool, which doesn't expose totalCount / idleCount
  // / waitingCount. The more reliable signal for "DB under pressure" now
  // lives on the hardened Prisma client itself: `circuitBreakerStatus()`
  // from src/lib/prisma.js opens the breaker after 5 consecutive failures
  // and fail-fasts for 30s. Read that if self-healing needs to decide
  // whether to back off further.
  try {
    const { circuitBreakerStatus } = await import('../lib/prisma.js');
    const status = circuitBreakerStatus();
    if (status.open) {
      logger.warn('🔧 Self-healing: Prisma circuit breaker is open', status);
      action.action = 'db_circuit_breaker_open';
    }
  } catch (e) {
    logger.error('Self-healing DB check failed:', e.message);
  }

  healingActions.push(action);
  // Reset after healing attempt
  entry.count = 0;
  entry.firstError = Date.now();
  entry.errors = [];
}

export function getHealthReport() {
  const report = {
    routeErrors: Object.fromEntries(routeErrors),
    recentHealingActions: healingActions.slice(-20),
    monitoredRoutes: routeErrors.size,
  };
  return report;
}

// Test-only seams. Exported so the eviction cap can be asserted without
// fabricating 1000+ real 500s, and so a test can start from a clean Map.
export const __MAX_TRACKED_ROUTES = MAX_TRACKED_ROUTES;
export function __recordErrorForTest(route, statusCode = 500) {
  recordError(route, statusCode);
}
export function __resetForTest() {
  routeErrors.clear();
  healingActions.length = 0;
}
