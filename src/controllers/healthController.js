// controllers/healthController.js
const pool = require('../db');
const logger = require('../logging/logger');

exports.healthCheck = async (req, res) => {
  try {
    // Validate DB Connection
    const checkDatabaseConnection = async () => {
      let retries = 3;
      while (retries) {
        try {
          await pool.query('SELECT 1');
          return true;
        } catch (err) {
          retries -= 1;
          if (!retries) throw new Error('Database unreachable');
          await new Promise((resolve) => setTimeout(resolve, 1000)); // wait 1 second
        }
      }
    };

    await checkDatabaseConnection();

    // Validate Required Environment Variables
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
      checks: {
        database: 'connected',
        environment: 'all variables present'
      }
    });

  } catch (err) {
    logger.error(err.stack || err.toString());
    res.status(500).json({ status: 'error', message: 'Database unreachable' });
  }
};
