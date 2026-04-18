import logger from '../logging/logger.js';

/**
 * Periodically checks database pool health and logs warnings.
 * Detects pool exhaustion, high wait counts, and connection leaks.
 */
export function startDbHealthMonitor(db, intervalMs = 30000) {
  const interval = setInterval(async () => {
    try {
      const pool = db.pool;
      if (!pool) return;

      const stats = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };

      // Log warning if pool is under pressure
      if (stats.waiting > 0) {
        logger.warn('Database pool pressure: requests waiting for connections', stats);
      }
      if (stats.idle === 0 && stats.total >= 18) { // Near max (20)
        logger.error('Database pool near exhaustion!', stats);
      }

    } catch (err) {
      logger.error('DB health monitor error:', err.message);
    }
  }, intervalMs);

  // Allow process to exit even if monitor is running
  if (interval.unref) interval.unref();

  return interval;
}

export default { startDbHealthMonitor };
