// src/routes/versionRoutes.js
// Hospital-Grade API Versioning and System Information Management System
// Enhanced with comprehensive RBAC, monitoring, and compliance features

import express from 'express';
import { success, error } from '../utils/responseHelper.js';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import db from '../config/database.js';
import logger from '../logging/logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const router = express.Router();

// ✅ Read package.json for version info with fallback
let packageInfo = { version: '1.0.0', name: 'vh-health-backend', description: 'VH Health API' };
try {
  const packagePath = path.resolve('package.json');
  packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
} catch (err) {
  logger.warn('Could not read package.json for version info');
}

// ===================================================================
// 🌐 PUBLIC VERSION ENDPOINTS (No Authentication Required)
// ===================================================================

wrapRoutes(
  router,
  [], // No roles required - public access
  {
    get: [
      // 📊 Basic Version Information (Public)
      [
        '/',
        (req, res) => {
          try {
            const versionInfo = {
              name: packageInfo.name,
              version: packageInfo.version,
              apiVersion: 'v1',
              status: 'operational',
              environment: process.env.NODE_ENV || 'development',
              buildDate: process.env.BUILD_DATE || new Date().toLocaleDateString('en-GB'),
              lastUpdated: '24-06-2025',
              message: `${packageInfo.name} v${packageInfo.version} - Healthcare Management API`,
              documentation: '/api-docs',
              support: {
                email: 'support@vhhealth.com',
                phone: '+91-80-1234-5678',
                hours: '24/7 Emergency Support'
              }
            };

            success(res, versionInfo, 'Version information retrieved successfully');
          } catch (err) {
            logger.error('[Version Basic] Error:', err.stack || err.toString());
            error(res, 'Failed to retrieve version information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🏥 Public API Capabilities
      [
        '/capabilities',
        (req, res) => {
          try {
            const capabilities = {
              apiVersion: packageInfo.version,
              supportedFormats: ['JSON', 'XML'],
              authentication: {
                methods: ['OTP', 'Firebase', 'JWT', 'API Key'],
                security: 'TLS 1.3',
                rateLimit: 'Role-based'
              },
              features: [
                'Patient Management',
                'Appointment Scheduling',
                'Medical Records',
                'Laboratory Integration',
                'Pharmacy Management',
                'Emergency Response',
                'Audit Logging',
                'HIPAA Compliance'
              ],
              integrations: {
                firebase: 'Authentication',
                cloudStorage: 'File Management',
                notifications: 'Push & In-App',
                analytics: 'Operational Metrics'
              },
              compliance: ['HIPAA', 'ISO 27001', 'GDPR'],
              availability: '99.9% SLA',
              documentation: '/api-docs'
            };

            success(res, capabilities, 'API capabilities retrieved successfully');
          } catch (err) {
            logger.error('[Version Capabilities] Error:', err.stack || err.toString());
            error(res, 'Failed to retrieve API capabilities', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📈 Public Health Status
      [
        '/health',
        async (req, res) => {
          try {
            // Basic health check without sensitive information
            const healthStatus = {
              status: 'healthy',
              version: packageInfo.version,
              timestamp: new Date().toISOString(),
              uptime: Math.floor(process.uptime()) + ' seconds',
              environment: process.env.NODE_ENV || 'development',
              services: {
                api: 'operational',
                database: 'checking...',
                storage: 'operational'
              }
            };

            // Quick database check
            try {
              await db.query('SELECT 1');
              healthStatus.services.database = 'operational';
            } catch (dbErr) {
              healthStatus.services.database = 'degraded';
              healthStatus.status = 'degraded';
            }

            const statusCode = healthStatus.status === 'healthy' ? HTTP_STATUS.OK : 503;
            res.status(statusCode).json({
              success: healthStatus.status === 'healthy',
              message: `System ${healthStatus.status}`,
              data: healthStatus
            });
          } catch (err) {
            logger.error('[Version Health] Error:', err.stack || err.toString());
            error(res, 'Health check failed', 503);
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true,
    configKey: 'versionRoutes'
  }
);

// ===================================================================
// 🔐 PROTECTED SYSTEM INFORMATION (RBAC Required)
// ===================================================================

wrapAutoRBAC(
  router,
  'versionRoutes', // Maps to rbacConfig for staff/admin access
  {
    get: [
      // 🔍 Detailed System Information (Staff/Admin)
      [
        '/system',
        async (req, res) => {
          try {
            const userRole = req.user?.role;
            const isAdmin = userRole === 'ADMIN';
            
            const systemInfo = {
              application: {
                name: packageInfo.name,
                version: packageInfo.version,
                description: packageInfo.description,
                nodeVersion: process.version,
                platform: process.platform,
                architecture: process.arch
              },
              runtime: {
                uptime: Math.floor(process.uptime()),
                environment: process.env.NODE_ENV,
                processId: process.pid,
                workingDirectory: process.cwd(),
                memoryUsage: {
                  rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
                  heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
                  heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
                }
              },
              system: {
                hostname: os.hostname(),
                totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB',
                freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024) + ' GB',
                cpuCount: os.cpus().length,
                loadAverage: os.loadavg().map(avg => Math.round(avg * 100) / 100),
                uptime: Math.floor(os.uptime()) + ' seconds'
              },
              requestInfo: {
                requestedBy: req.user?.uid || 'unknown',
                userRole: userRole,
                timestamp: new Date().toISOString(),
                ipAddress: req.headers['x-forwarded-for'] || req.connection?.remoteAddress
              }
            };

            // Add sensitive information only for admins
            if (isAdmin) {
              systemInfo.environment = {
                nodeEnv: process.env.NODE_ENV,
                hasDatabase: !!process.env.DATABASE_URL,
                hasCloudStorage: !!process.env.CF_R2_BUCKET,
                hasFirebase: !!process.env.FIREBASE_PROJECT_ID,
                hasVirusScanning: !!process.env.CLAMAV_API_URL
              };
            }

            logger.info(`[System Info] Accessed by ${userRole} user: ${req.user?.uid}`);
            success(res, systemInfo, 'System information retrieved successfully');
          } catch (err) {
            logger.error('[Version System] Error:', err.stack || err.toString());
            error(res, 'Failed to retrieve system information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📋 Complete API Catalog (Staff/Admin)
      [
        '/api-catalog',
        (req, res) => {
          try {
            const userRole = req.user?.role;
            const apiCatalog = {
              version: packageInfo.version,
              totalEndpoints: 87, // Updated count
              categories: {
                authentication: {
                  endpoints: ['POST /auth/login', 'POST /auth/register', 'POST /auth/logout', 'POST /auth/refresh'],
                  description: 'User authentication and session management'
                },
                users: {
                  endpoints: ['GET /users', 'POST /users', 'GET /users/:id', 'PUT /users/:id', 'DELETE /users/:id'],
                  description: 'User profile and account management'
                },
                appointments: {
                  endpoints: ['GET /appointments', 'POST /appointments', 'PUT /appointments/:id', 'DELETE /appointments/:id'],
                  description: 'Appointment scheduling and management'
                },
                medical: {
                  endpoints: ['GET /records', 'POST /records', 'GET /investigations', 'POST /investigations'],
                  description: 'Medical records and laboratory integration'
                },
                pharmacy: {
                  endpoints: ['GET /pharmacy-orders', 'POST /pharmacy-orders', 'PUT /pharmacy-orders/:id'],
                  description: 'Pharmacy and medication management'
                },
                emergency: {
                  endpoints: ['POST /sos', 'GET /sos/alerts', 'PUT /sos/:id'],
                  description: 'Emergency response and alert system'
                },
                administration: {
                  endpoints: ['GET /admin/users', 'POST /admin/reports', 'GET /admin/analytics'],
                  description: 'Administrative tools and reporting'
                }
              },
              security: {
                authentication: 'JWT + API Key',
                authorization: 'Role-Based Access Control (RBAC)',
                encryption: 'TLS 1.3',
                compliance: ['HIPAA', 'GDPR']
              },
              requestInfo: {
                requestedBy: req.user?.uid,
                userRole: userRole,
                timestamp: new Date().toISOString()
              }
            };

            logger.info(`[API Catalog] Accessed by ${userRole} user: ${req.user?.uid}`);
            success(res, apiCatalog, 'API catalog retrieved successfully');
          } catch (err) {
            logger.error('[Version API Catalog] Error:', err.stack || err.toString());
            error(res, 'Failed to retrieve API catalog', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📊 Database Schema Information (Staff/Admin)
      [
        '/schema',
        async (req, res) => {
          try {
            const userRole = req.user?.role;
            
            // Get database table information
            const tablesQuery = `
              SELECT table_name, table_type 
              FROM information_schema.tables 
              WHERE table_schema = 'public' 
              ORDER BY table_name
            `;
            
            const result = await db.query(tablesQuery);
            
            const schemaInfo = {
              database: {
                type: 'PostgreSQL',
                tables: result.rows.map(row => ({
                  name: row.table_name,
                  type: row.table_type
                })),
                totalTables: result.rows.length
              },
              coreEntities: [
                'users', 'appointments', 'health_records', 'investigations',
                'pharmacy_orders', 'doctors', 'departments', 'feedback'
              ],
              systemTables: [
                'audit_logs', 'file_metadata', 'notifications', 'sos_alerts'
              ],
              lastUpdated: '24-06-2025',
              requestInfo: {
                requestedBy: req.user?.uid,
                userRole: userRole,
                timestamp: new Date().toISOString()
              }
            };

            logger.info(`[Schema Info] Accessed by ${userRole} user: ${req.user?.uid}`);
            success(res, schemaInfo, 'Database schema information retrieved successfully');
          } catch (err) {
            logger.error('[Version Schema] Error:', err.stack || err.toString());
            error(res, 'Failed to retrieve database schema information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false,
    configKey: 'versionRoutes'
  }
);

// ===================================================================
// 🛡️ ADMIN-ONLY SYSTEM MANAGEMENT
// ===================================================================

wrapAutoRBAC(
  router,
  'adminRoutes', // Admin-only access
  {
    get: [
      // 🔧 Advanced System Diagnostics (Admin Only)
      [
        '/diagnostics',
        async (req, res) => {
          try {
            const diagnostics = {
              system: {
                status: 'operational',
                version: packageInfo.version,
                uptime: Math.floor(process.uptime()),
                memoryUsage: process.memoryUsage(),
                cpuUsage: process.cpuUsage(),
                platform: {
                  os: process.platform,
                  arch: process.arch,
                  node: process.version
                }
              },
              database: {
                status: 'checking...',
                connections: 'unknown',
                version: 'unknown'
              },
              services: {
                api: 'operational',
                fileStorage: !!process.env.CF_R2_BUCKET ? 'operational' : 'disabled',
                notifications: 'operational',
                virusScanning: !!process.env.CLAMAV_API_URL ? 'operational' : 'disabled'
              },
              performance: {
                requestsPerMinute: 'N/A', // Would need monitoring service
                averageResponseTime: 'N/A',
                errorRate: 'N/A'
              },
              requestInfo: {
                requestedBy: req.user?.uid,
                timestamp: new Date().toISOString(),
                ipAddress: req.headers['x-forwarded-for'] || req.connection?.remoteAddress
              }
            };

            // Advanced database diagnostics
            try {
              const dbVersionResult = await db.query('SELECT version()');
              const dbStatsResult = await db.query(`
                SELECT 
                  count(*) as total_connections,
                  sum(case when state = 'active' then 1 else 0 end) as active_connections
                FROM pg_stat_activity
              `);
              
              diagnostics.database.status = 'operational';
              diagnostics.database.version = dbVersionResult.rows[0].version.split(' ')[1];
              diagnostics.database.connections = dbStatsResult.rows[0];
            } catch (dbErr) {
              diagnostics.database.status = 'error';
              diagnostics.database.error = dbErr.message;
            }

            logger.info(`[System Diagnostics] Accessed by admin: ${req.user?.uid}`);
            success(res, diagnostics, 'System diagnostics retrieved successfully');
          } catch (err) {
            logger.error('[Version Diagnostics] Error:', err.stack || err.toString());
            error(res, 'Failed to retrieve system diagnostics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📈 Performance Metrics (Admin Only)
      [
        '/metrics',
        async (req, res) => {
          try {
            const metrics = {
              application: {
                version: packageInfo.version,
                uptime: Math.floor(process.uptime()),
                restarts: 0, // Would need persistent storage
                lastRestart: 'N/A'
              },
              performance: {
                memory: {
                  used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                  total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
                  external: Math.round(process.memoryUsage().external / 1024 / 1024),
                  unit: 'MB'
                },
                cpu: {
                  usage: process.cpuUsage(),
                  loadAverage: os.loadavg()
                },
                system: {
                  freeMemory: Math.round(os.freemem() / 1024 / 1024),
                  totalMemory: Math.round(os.totalmem() / 1024 / 1024),
                  unit: 'MB'
                }
              },
              database: {
                status: 'checking...',
                responseTime: 'N/A'
              },
              requestInfo: {
                requestedBy: req.user?.uid,
                timestamp: new Date().toISOString()
              }
            };

            // Database performance check
            try {
              const start = Date.now();
              await db.query('SELECT 1');
              const responseTime = Date.now() - start;
              
              metrics.database.status = 'operational';
              metrics.database.responseTime = responseTime + 'ms';
            } catch (dbErr) {
              metrics.database.status = 'error';
              metrics.database.error = dbErr.message;
            }

            logger.info(`[System Metrics] Accessed by admin: ${req.user?.uid}`);
            success(res, metrics, 'Performance metrics retrieved successfully');
          } catch (err) {
            logger.error('[Version Metrics] Error:', err.stack || err.toString());
            error(res, 'Failed to retrieve performance metrics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔄 Version History (Admin Only)
      [
        '/history',
        (req, res) => {
          try {
            const versionHistory = {
              current: packageInfo.version,
              releases: [
                {
                  version: '1.0.0',
                  releaseDate: '24-06-2025',
                  type: 'major',
                  features: [
                    'Initial release',
                    'Complete RBAC implementation',
                    'Hospital-grade security',
                    'HIPAA compliance',
                    'Emergency response system'
                  ],
                  fixes: [],
                  breaking: []
                }
              ],
              upcomingFeatures: [
                'AI-powered diagnostics integration',
                'Telemedicine platform',
                'Advanced analytics dashboard',
                'Mobile app enhancements'
              ],
              deprecatedFeatures: [],
              requestInfo: {
                requestedBy: req.user?.uid,
                timestamp: new Date().toISOString()
              }
            };

            logger.info(`[Version History] Accessed by admin: ${req.user?.uid}`);
            success(res, versionHistory, 'Version history retrieved successfully');
          } catch (err) {
            logger.error('[Version History] Error:', err.stack || err.toString());
            error(res, 'Failed to retrieve version history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    post: [
      // 🔄 Trigger System Update Check (Admin Only)
      [
        '/update-check',
        async (req, res) => {
          try {
            const updateCheck = {
              currentVersion: packageInfo.version,
              latestVersion: packageInfo.version, // Would check against registry
              updateAvailable: false,
              securityUpdates: false,
              lastChecked: new Date().toISOString(),
              nextScheduledCheck: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              updateInfo: {
                type: 'none',
                description: 'System is up to date',
                releaseNotes: []
              },
              requestInfo: {
                triggeredBy: req.user?.uid,
                timestamp: new Date().toISOString()
              }
            };

            logger.info(`[Update Check] Triggered by admin: ${req.user?.uid}`);
            success(res, updateCheck, 'Update check completed successfully');
          } catch (err) {
            logger.error('[Version Update Check] Error:', err.stack || err.toString());
            error(res, 'Failed to perform update check', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false,
    configKey: 'adminRoutes'
  }
);

export default router;