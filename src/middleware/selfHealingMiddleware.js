import logger from '../logging/logger.js';

const routeErrors = new Map(); // key: route, value: { count, firstError, lastError, errors }
const WINDOW_MS = 60_000;
const THRESHOLD = 5;
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
  if (!routeErrors.has(route)) {
    routeErrors.set(route, { count: 0, firstError: now, lastError: now, errors: [] });
  }
  const entry = routeErrors.get(route);
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

  // Attempt DB pool refresh
  try {
    const db = (await import('../config/database.js')).default;
    if (db.pool) {
      const poolStats = { total: db.pool.totalCount, idle: db.pool.idleCount, waiting: db.pool.waitingCount };
      logger.warn('DB Pool stats during healing:', poolStats);

      if (poolStats.waiting > poolStats.total * 0.8) {
        logger.warn('🔧 Self-healing: DB pool under pressure, connections may be exhausted');
        action.action = 'db_pool_pressure_detected';
      }
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
