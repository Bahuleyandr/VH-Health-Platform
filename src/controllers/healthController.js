// src/controllers/healthController.js

import pool from '../db.js';
import logger from '../logging/logger.js';

/**
 * ✅ Health check with DB + ENV validation
 * Ensures required environment variables exist and DB is reachable.
 */
export async function healthCheck(req, res) {
  try {
    // ✅ Check DB connection with retry
    let retries = 3;
    while (retries) {
      try {
        await pool.query('SELECT 1');
        break;
      } catch (err) {
        retries -= 1;
        if (!retries) throw new Error('Database unreachable');
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay
      }
    }

    // ✅ Check for required environment variables
    const requiredEnv = ['API_KEY', 'DATABASE_URL', 'ALLOWED_ORIGINS'];
    const missingEnv = requiredEnv.filter(key => !process.env[key]);

    if (missingEnv.length > 0) {
      return res.status(500).json({
        status: 'error',
        message: `Missing environment variables: ${missingEnv.join(', ')}`
      });
    }

    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'connected',
        environment: 'all variables present'
      }
    });
  } catch (err) {
    logger.error('[HealthCheck]', err.stack || err.toString());
    res.status(500).json({ status: 'error', message: 'Database unreachable' });
  }
}
