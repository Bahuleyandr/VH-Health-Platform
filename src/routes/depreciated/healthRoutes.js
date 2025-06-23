// src/routes/healthRoutes.js

import express from 'express';
import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { wrapRoutes } from '../config/routeWrapper.js';

const router = express.Router();

/**
 * ✅ Public Health Routes (No RBAC, No UID/Phone validation)
 * - GET /               : Lightweight ping
 * - GET /health-check   : DB + Env checks
 * - GET /app-version    : API version
 */
wrapRoutes(
  router,
  [],
  {
    get: [
      [
        '/',
        (req, res) => {
          success(res, { message: 'VH Health API is running.' }, 'Service reachable');
        }
      ],
      [
        '/health-check',
        async (req, res) => {
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
              return error(res, `Missing environment variables: ${missingEnv.join(', ')}`, 500);
            }

            success(
              res,
              {
                status: 'ok',
                timestamp: new Date().toISOString(),
                checks: {
                  database: 'connected',
                  environment: 'all variables present'
                }
              },
              'Detailed health check passed'
            );
          } catch (err) {
            logger.error(err.stack || err.toString());
            error(res, 'Database unreachable', 500);
          }
        }
      ],
      [
        '/app-version',
        (req, res) => {
          success(
            res,
            {
              version: '1.0.0',
              updated_at: '2025-05-12',
              message: 'VH Health API Version 1.0.0 - Initial Release'
            },
            'App version fetched successfully'
          );
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;
