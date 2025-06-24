// src/routes/debugRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import { success, error } from '../utils/responseHelper.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as debugController from '../controllers/debugController.js';
import db from '../config/database.js';
import logger from '../logging/logger.js';
import os from 'os';

const router = express.Router();
console.log('✅ debugRoutes loaded with RBAC protection');

/**
 * ✅ Debug Routes with RBAC protection
 * Admin-only debugging and system monitoring tools
 * RBAC-protected using config key: debugRoutes
 */
wrapAutoRBAC(
  router,
  'debugRoutes',
  {
    get: [
      // 🏓 Basic Ping Test
      [
        '/ping',
        (req, res) => {
          success(res, { 
            message: 'Debug route is operational',
            timestamp: new Date().toISOString(),
            requestId: req.headers['x-request-id'] || 'unknown',
            user: req.user?.name || 'Unknown',
            userRole: req.user?.role || 'Unknown'
          }, 'Ping successful');
        }
      ],
      
      // 🔍 Legacy debug info (from deprecated)
      ['/debug', debugController.getDebugInfo],
      
      // 📊 Enhanced debug info (from new version)
      ['/info', debugController.getDebugInfo],
      
      // 💻 System Information
      [
        '/system',
        (req, res) => {
          try {
            const systemInfo = {
              platform: os.platform(),
              architecture: os.arch(),
              nodeVersion: process.version,
              uptime: process.uptime(),
              systemUptime: os.uptime(),
              totalMemory: os.totalmem(),
              freeMemory: os.freemem(),
              memoryUsage: process.memoryUsage(),
              cpuCount: os.cpus().length,
              loadAverage: os.loadavg(),
              networkInterfaces: Object.keys(os.networkInterfaces()),
              environment: process.env.NODE_ENV || 'development',
              hostname: os.hostname(),
              homeDirectory: os.homedir(),
              tempDirectory: os.tmpdir(),
              requestedBy: req.user?.name
            };

            success(res, systemInfo, 'System information retrieved');
          } catch (err) {
            logger.error('System info error:', err);
            error(res, 'Failed to retrieve system information', 500);
          }
        }
      ],

      // 🔍 Database Connection Test
      [
        '/db-test',
        async (req, res) => {
          try {
            const start = Date.now();
            const result = await db.query('SELECT NOW() as server_time, version() as postgres_version');
            const responseTime = Date.now() - start;

            // Test additional database operations
            const tableCheck = await db.query(`
              SELECT table_name, table_type 
              FROM information_schema.tables 
              WHERE table_schema = 'public' 
              ORDER BY table_name
              LIMIT 10
            `);

            success(res, {
              connected: true,
              responseTimeMs: responseTime,
              serverTime: result.rows[0].server_time,
              postgresVersion: result.rows[0].postgres_version.split(' ')[0],
              sampleTables: tableCheck.rows,
              tableCount: tableCheck.rows.length,
              testedBy: req.user?.name
            }, 'Database connection test successful');

          } catch (err) {
            logger.error('Database test error:', err);
            error(res, {
              connected: false,
              error: err.message,
              code: err.code,
              testedBy: req.user?.name
            }, 'Database connection failed');
          }
        }
      ],

      // 🔥 Trigger Sentry Error (Testing) - Enhanced
      [
        '/debug-sentry',
        (req, res, next) => {
          try {
            logger.warn(`🔥 Sentry debug error triggered by ${req.user?.name || 'Unknown'}`);
            throw new Error(`Sentry debug trigger: Test error for monitoring! Triggered by ${req.user?.name || 'Unknown'}`);
          } catch (err) {
            next(err); // Will be caught by centralized error handler
          }
        }
      ],

      // 📊 Application Health Check
      [
        '/health',
        async (req, res) => {
          try {
            const healthData = {
              status: 'healthy',
              timestamp: new Date().toISOString(),
              uptime: process.uptime(),
              environment: process.env.NODE_ENV || 'development',
              nodeVersion: process.version,
              memoryUsage: process.memoryUsage(),
              checks: {}
            };

            // Database health check
            try {
              const dbStart = Date.now();
              await db.query('SELECT 1');
              healthData.checks.database = {
                status: 'healthy',
                responseTimeMs: Date.now() - dbStart
              };
            } catch (dbErr) {
              healthData.checks.database = {
                status: 'unhealthy',
                error: dbErr.message
              };
              healthData.status = 'degraded';
            }

            // Memory health check
            const memUsage = process.memoryUsage();
            const memoryHealthy = memUsage.heapUsed < (memUsage.heapTotal * 0.9);
            healthData.checks.memory = {
              status: memoryHealthy ? 'healthy' : 'warning',
              heapUsed: memUsage.heapUsed,
              heapTotal: memUsage.heapTotal,
              usage: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
            };

            if (!memoryHealthy && healthData.status === 'healthy') {
              healthData.status = 'warning';
            }

            healthData.checkedBy = req.user?.name;

            success(res, healthData, `Application health: ${healthData.status}`);
          } catch (err) {
            logger.error('Health check error:', err);
            error(res, {
              status: 'unhealthy',
              error: err.message,
              checkedBy: req.user?.name
            }, 'Health check failed');
          }
        }
      ],

      // 🔧 Environment Variables (Sanitized)
      [
        '/env',
        (req, res) => {
          try {
            // Only show safe environment variables
            const safeEnvVars = {
              NODE_ENV: process.env.NODE_ENV,
              PORT: process.env.PORT,
              API_VERSION: process.env.API_VERSION,
              CORS_ORIGIN: process.env.CORS_ORIGIN,
              LOG_LEVEL: process.env.LOG_LEVEL
            };

            // Add sanitized versions of sensitive vars
            const sensitiveVars = ['DATABASE_URL', 'JWT_SECRET', 'API_KEY'];
            sensitiveVars.forEach(varName => {
              if (process.env[varName]) {
                safeEnvVars[varName] = process.env[varName].substring(0, 10) + '...[REDACTED]';
              }
            });

            success(res, {
              environment: safeEnvVars,
              totalEnvVars: Object.keys(process.env).length,
              shownVars: Object.keys(safeEnvVars).length,
              requestedBy: req.user?.name,
              warning: 'Sensitive environment variables are redacted for security'
            }, 'Environment variables retrieved (sanitized)');
          } catch (err) {
            logger.error('Environment check error:', err);
            error(res, 'Failed to retrieve environment variables', 500);
          }
        }
      ],

      // 📝 Application Logs (Recent)
      [
        '/logs',
        async (req, res) => {
          try {
            const { level = 'all', limit = 50 } = req.query;
            
            // This would integrate with your logging system
            // For now, we'll provide a mock structure
            const mockLogs = [
              {
                timestamp: new Date().toISOString(),
                level: 'info',
                message: 'Application started successfully',
                module: 'app'
              },
              {
                timestamp: new Date(Date.now() - 300000).toISOString(),
                level: 'warn',
                message: 'High memory usage detected',
                module: 'monitor'
              },
              {
                timestamp: new Date(Date.now() - 600000).toISOString(),
                level: 'error',
                message: 'Database connection timeout',
                module: 'database'
              }
            ];

            const filteredLogs = level === 'all' 
              ? mockLogs 
              : mockLogs.filter(log => log.level === level);

            success(res, {
              logs: filteredLogs.slice(0, parseInt(limit)),
              totalLogs: filteredLogs.length,
              filter: { level, limit: parseInt(limit) },
              note: 'This is mock data - integrate with actual logging system',
              requestedBy: req.user?.name
            }, 'Recent logs retrieved');
          } catch (err) {
            logger.error('Logs retrieval error:', err);
            error(res, 'Failed to retrieve logs', 500);
          }
        }
      ],

      // 🔍 Request Headers Debug
      [
        '/headers',
        (req, res) => {
          try {
            const debugHeaders = {
              allHeaders: req.headers,
              userAgent: req.get('User-Agent'),
              authorization: req.get('Authorization') ? 'Bearer [REDACTED]' : 'None',
              contentType: req.get('Content-Type'),
              acceptLanguage: req.get('Accept-Language'),
              xForwardedFor: req.get('X-Forwarded-For'),
              xRealIp: req.get('X-Real-IP'),
              host: req.get('Host'),
              origin: req.get('Origin'),
              referer: req.get('Referer'),
              userInfo: {
                uid: req.user?.uid,
                role: req.user?.role,
                name: req.user?.name
              },
              requestInfo: {
                method: req.method,
                url: req.url,
                protocol: req.protocol,
                secure: req.secure,
                ip: req.ip,
                ips: req.ips
              }
            };

            success(res, debugHeaders, 'Request headers and user info retrieved');
          } catch (err) {
            logger.error('Headers debug error:', err);
            error(res, 'Failed to retrieve header information', 500);
          }
        }
      ],

      // ⚡ Performance Metrics
      [
        '/performance',
        async (req, res) => {
          try {
            const metrics = {
              timestamp: new Date().toISOString(),
              uptime: process.uptime(),
              memoryUsage: process.memoryUsage(),
              cpuUsage: process.cpuUsage(),
              resourceUsage: process.resourceUsage ? process.resourceUsage() : 'Not available',
              systemLoad: os.loadavg(),
              systemMemory: {
                total: os.totalmem(),
                free: os.freemem(),
                used: os.totalmem() - os.freemem(),
                usagePercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100)
              }
            };

            // Database performance test
            try {
              const dbStart = process.hrtime.bigint();
              await db.query('SELECT COUNT(*) FROM information_schema.tables');
              const dbEnd = process.hrtime.bigint();
              metrics.database = {
                queryTimeNs: Number(dbEnd - dbStart),
                queryTimeMs: Number(dbEnd - dbStart) / 1000000
              };
            } catch (dbErr) {
              metrics.database = {
                error: dbErr.message
              };
            }

            metrics.requestedBy = req.user?.name;

            success(res, metrics, 'Performance metrics retrieved');
          } catch (err) {
            logger.error('Performance metrics error:', err);
            error(res, 'Failed to retrieve performance metrics', 500);
          }
        }
      ]
    ],

    post: [
      // 🔧 Trigger Garbage Collection (if available)
      [
        '/gc',
        (req, res) => {
          try {
            if (global.gc) {
              const before = process.memoryUsage();
              global.gc();
              const after = process.memoryUsage();
              
              success(res, {
                triggered: true,
                memoryBefore: before,
                memoryAfter: after,
                freedBytes: before.heapUsed - after.heapUsed,
                triggeredBy: req.user?.name,
                timestamp: new Date().toISOString()
              }, 'Garbage collection triggered');
            } else {
              success(res, {
                triggered: false,
                reason: 'Garbage collection not available (start with --expose-gc flag)',
                triggeredBy: req.user?.name
              }, 'Garbage collection not available');
            }
          } catch (err) {
            logger.error('GC trigger error:', err);
            error(res, 'Failed to trigger garbage collection', 500);
          }
        }
      ],

      // 🔄 Simulate Load Test
      [
        '/load-test',
        async (req, res) => {
          try {
            const { iterations = 1000, delay = 1 } = req.body;
            
            logger.info(`🔄 Load test started by ${req.user?.name}: ${iterations} iterations`);
            
            const start = process.hrtime.bigint();
            
            // Simulate some work
            for (let i = 0; i < iterations; i++) {
              await new Promise(resolve => setTimeout(resolve, delay));
              if (i % 100 === 0) {
                // Yield control occasionally
                setImmediate(() => {});
              }
            }
            
            const end = process.hrtime.bigint();
            const durationMs = Number(end - start) / 1000000;
            
            success(res, {
              completed: true,
              iterations,
              delayMs: delay,
              totalDurationMs: durationMs,
              avgIterationMs: durationMs / iterations,
              triggeredBy: req.user?.name,
              timestamp: new Date().toISOString()
            }, 'Load test completed');
          } catch (err) {
            logger.error('Load test error:', err);
            error(res, 'Load test failed', 500);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,        // Require admin authentication
    requirePhone: false,     // Phone not required for debug operations
    auditLog: true,         // Enable audit logging for debug actions
    rateLimiting: true,     // Enable rate limiting
    roles: ['ADMIN']        // Admin only access
  }
);

export default router;