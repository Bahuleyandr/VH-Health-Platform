// src/routes/debugRoutes.js
import express from 'express';
import { success } from '../utils/responseHelper.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as debugController from '../controllers/debugController.js';
import os from 'os';

const debugRouter = express.Router();

wrapAutoRBAC(debugRouter, 'debugRoutes', {
  get: [
    [
      '/ping',
      (req, res) => {
        success(res, { 
          message: 'Debug route is operational',
          timestamp: new Date().toISOString(),
          requestId: req.headers['x-request-id'] || 'unknown'
        }, 'Ping successful');
      }
    ],
    
    ['/info', debugController.getDebugInfo],
    
    // 💻 System Information
    [
      '/system',
      (req, res) => {
        const systemInfo = {
          platform: os.platform(),
          architecture: os.arch(),
          nodeVersion: process.version,
          uptime: process.uptime(),
          systemUptime: os.uptime(),
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          cpuCount: os.cpus().length,
          loadAverage: os.loadavg(),
          networkInterfaces: Object.keys(os.networkInterfaces()),
          environment: process.env.NODE_ENV || 'development'
        };

        success(res, systemInfo, 'System information retrieved');
      }
    ],

    // 🔍 Database Connection Test
    [
      '/db-test',
      async (req, res) => {
        try {
          const start = Date.now();
          const result = await pool.query('SELECT NOW() as server_time, version() as postgres_version');
          const responseTime = Date.now() - start;

          success(res, {
            connected: true,
            responseTimeMs: responseTime,
            serverTime: result.rows[0].server_time,
            postgresVersion: result.rows[0].postgres_version.split(' ')[0]
          }, 'Database connection test successful');

        } catch (err) {
          error(res, {
            connected: false,
            error: err.message,
            code: err.code
          }, 'Database connection failed');
        }
      }
    ],

    // 🔥 Trigger Sentry Error (Testing)
    [
      '/debug-sentry',
      (req, res, next) => {
        try {
          throw new Error('Sentry debug trigger: Test error for monitoring!');
        } catch (err) {
          next(err);
        }
      }
    ]
  ]
});