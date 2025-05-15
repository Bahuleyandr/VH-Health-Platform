const express = require('express');
const router = express.Router();
const pool = require('../db');
const logger = require('../logging/logger');

// Root health check
router.get('/health', (req, res) => {
  res.json({ message: 'VH Health API is running.' });
});

// Detailed health check with database and env check
router.get('/health-check', async (req, res) => {
  try {
    let retries = 3;
    while (retries) {
      try {
        await pool.query('SELECT 1');
        break;
      } catch (err) {
        retries -= 1;
        if (!retries) throw new Error('Database unreachable');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const requiredEnv = ['API_KEY', 'DATABASE_URL', 'ALLOWED_ORIGINS'];
    const missingEnv = requiredEnv.filter(key => !process.env[key]);

    if (missingEnv.length > 0) {
      return res.status(500).json({
        status: 'error',
        message: `Missing environment variables: ${missingEnv.join(', ')}`
      });
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: { database: 'connected', environment: 'all variables present' }
    });
  } catch (err) {
    logger.error(err.stack || err.toString());
    res.status(500).json({ status: 'error', message: 'Database unreachable' });
  }
});

// App version check
router.get('/app-version', (req, res) => {
  res.json({ version: '1.0.0', updated_at: '2025-05-12' });
});

module.exports = router;
