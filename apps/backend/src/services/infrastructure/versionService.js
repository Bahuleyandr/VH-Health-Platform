// services/infrastructure/versionService.js
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describeFileScanPolicy, resolveFileScanPolicy } from '../../config/fileScanPolicy.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { 
  getSystemMetrics, 
  getProcessMemory, 
  formatUptime 
} from '../../utils/infrastructure/systemUtils.js';

export class VersionService {
  static packageInfo = null;
  
  // Load package info
  static getPackageInfo() {
    if (!this.packageInfo) {
      try {
        const packagePath = path.resolve('package.json');
        this.packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      } catch (_err) {
        logger.warn('Could not read package.json for version info');
        this.packageInfo = { 
          version: '1.0.0', 
          name: 'vh-health-backend', 
          description: 'VH Health API' 
        };
      }
    }
    return this.packageInfo;
  }
  
  // Get basic version information
  static getVersionInfo() {
    const packageInfo = this.getPackageInfo();
    
    return {
      name: packageInfo.name,
      version: packageInfo.version,
      apiVersion: 'v1',
      status: 'operational',
      environment: process.env.NODE_ENV || 'development',
      buildDate: process.env.BUILD_DATE || formatDateDDMMYYYY(new Date()),
      lastUpdated: formatDateDDMMYYYY(new Date()),
      message: `${packageInfo.name} v${packageInfo.version} - Healthcare Management API`,
      documentation: '/api-docs',
      support: {
        email: 'support@vhhealth.com',
        phone: '+91-80-1234-5678',
        hours: '24/7 Emergency Support'
      }
    };
  }
  
  // Get API capabilities
  static getCapabilities() {
    const packageInfo = this.getPackageInfo();
    
    return {
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
  }
  
  // Get health status
  static async getHealthStatus() {
    try {
      const healthStatus = {
        status: 'healthy',
        version: this.getPackageInfo().version,
        timestamp: new Date().toISOString(),
        uptime: formatUptime(process.uptime()),
        uptimeSeconds: Math.floor(process.uptime()),
        environment: process.env.NODE_ENV || 'development',
        services: {
          api: 'operational',
          database: 'checking...',
          storage: 'operational'
        }
      };
      
      // Quick database check
      try {
        await prisma.$queryRawUnsafe('SELECT 1');
        healthStatus.services.database = 'operational';
      } catch (_dbErr) {
        healthStatus.services.database = 'degraded';
        healthStatus.status = 'degraded';
      }
      
      return healthStatus;
    } catch (error) {
      logger.error('Health check error:', error);
      throw error;
    }
  }
  
  // Get detailed system information
  static async getSystemInfo(userInfo) {
    try {
      const packageInfo = this.getPackageInfo();
      const isAdmin = userInfo.role === 'ADMIN';
      const systemMetrics = getSystemMetrics();
      
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
          uptimeFormatted: formatUptime(process.uptime()),
          environment: process.env.NODE_ENV,
          processId: process.pid,
          workingDirectory: process.cwd(),
          memoryUsage: getProcessMemory()
        },
        system: {
          hostname: os.hostname(),
          totalMemory: systemMetrics.memory.total.gb + ' GB',
          freeMemory: systemMetrics.memory.free.gb + ' GB',
          cpuCount: systemMetrics.cpu.count,
          cpuModel: systemMetrics.cpu.model,
          loadAverage: systemMetrics.cpu.loadAverage,
          platform: systemMetrics.system.platform,
          release: systemMetrics.system.release,
          uptime: formatUptime(systemMetrics.system.uptime)
        },
        requestInfo: {
          requestedBy: userInfo.uid || 'unknown',
          userRole: userInfo.role,
          timestamp: formatDateDDMMYYYY(new Date()),
          ipAddress: userInfo.ipAddress
        }
      };
      
      // Add sensitive information only for admins
      if (isAdmin) {
        systemInfo.environment = {
          nodeEnv: process.env.NODE_ENV,
          hasDatabase: !!process.env.DATABASE_URL,
          hasCloudStorage: !!process.env.CF_R2_BUCKET,
          hasFirebase: !!process.env.FIREBASE_PROJECT_ID,
          // Whether this deployment scans uploads is a DECLARED policy
          // (FILE_SCAN_POLICY, see config/fileScanPolicy.js), not something
          // inferred from a probe. Reporting the declaration is what lets an
          // admin answer "are our uploads being scanned?" without a shell.
          virusScanning: describeFileScanPolicy()
        };
      }
      
      return systemInfo;
    } catch (error) {
      logger.error('System info error:', error);
      throw error;
    }
  }
  
  // Get API catalog
  static getAPICatalog(userInfo) {
    const packageInfo = this.getPackageInfo();
    
    return {
      version: packageInfo.version,
      totalEndpoints: 87,
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
        requestedBy: userInfo.uid,
        userRole: userInfo.role,
        timestamp: formatDateDDMMYYYY(new Date())
      }
    };
  }
  
  // Get database schema information
  static async getSchemaInfo(userInfo) {
    try {
      // Get database table information
      const tablesQuery = `
        SELECT table_name, table_type 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `;
      
      const result = await prisma.$queryRawUnsafe(tablesQuery);
      
      return {
        database: {
          type: 'PostgreSQL',
          tables: result.map(row => ({
            name: row.table_name,
            type: row.table_type
          })),
          totalTables: result.length
        },
        coreEntities: [
          'users', 'appointments', 'health_records', 'investigations',
          'pharmacy_orders', 'doctors', 'departments', 'feedback'
        ],
        systemTables: [
          'audit_logs', 'file_metadata', 'notifications', 'sos_alerts'
        ],
        lastUpdated: formatDateDDMMYYYY(new Date()),
        requestInfo: {
          requestedBy: userInfo.uid,
          userRole: userInfo.role,
          timestamp: formatDateDDMMYYYY(new Date())
        }
      };
    } catch (error) {
      logger.error('Schema info error:', error);
      throw error;
    }
  }
  
  // Get advanced diagnostics (Admin only)
  static async getDiagnostics(userInfo) {
    try {
      const systemMetrics = getSystemMetrics();
      const diagnostics = {
        system: {
          status: 'operational',
          version: this.getPackageInfo().version,
          uptime: Math.floor(process.uptime()),
          uptimeFormatted: formatUptime(process.uptime()),
          memoryUsage: systemMetrics.process.memoryUsage,
          cpuUsage: systemMetrics.process.cpuUsage,
          platform: systemMetrics.system
        },
        database: {
          status: 'checking...',
          connections: 'unknown',
          version: 'unknown'
        },
        services: {
          api: 'operational',
          fileStorage: process.env.CF_R2_BUCKET ? 'operational' : 'disabled',
          notifications: 'operational',
          // Declared posture (FILE_SCAN_POLICY), not a probe result — see
          // config/fileScanPolicy.js.
          virusScanning: resolveFileScanPolicy()
        },
        performance: {
          requestsPerMinute: 'N/A',
          averageResponseTime: 'N/A',
          errorRate: 'N/A'
        },
        requestInfo: {
          requestedBy: userInfo.uid,
          timestamp: formatDateDDMMYYYY(new Date()),
          ipAddress: userInfo.ipAddress
        }
      };
      
      // Advanced database diagnostics
      try {
        const dbVersionResult = await prisma.$queryRawUnsafe('SELECT version()');
        const dbStatsResult = await prisma.$queryRawUnsafe(`
          SELECT 
            count(*) as total_connections,
            sum(case when state = 'active' then 1 else 0 end) as active_connections
          FROM pg_stat_activity
        `);
        
        diagnostics.database.status = 'operational';
        diagnostics.database.version = dbVersionResult[0].version.split(' ')[1];
        diagnostics.database.connections = dbStatsResult[0];
      } catch (dbErr) {
        diagnostics.database.status = 'error';
        diagnostics.database.error = dbErr.message;
      }
      
      return diagnostics;
    } catch (error) {
      logger.error('Diagnostics error:', error);
      throw error;
    }
  }
  
  // Get performance metrics (Admin only)
  static async getPerformanceMetrics(userInfo) {
    try {
      const systemMetrics = getSystemMetrics();
      const metrics = {
        application: {
          version: this.getPackageInfo().version,
          uptime: Math.floor(process.uptime()),
          restarts: 0, // Would need persistent storage
          lastRestart: 'N/A'
        },
        performance: {
          memory: systemMetrics.memory,
          cpu: systemMetrics.cpu,
          process: systemMetrics.process
        },
        database: {
          status: 'checking...',
          responseTime: 'N/A'
        },
        requestInfo: {
          requestedBy: userInfo.uid,
          timestamp: formatDateDDMMYYYY(new Date())
        }
      };
      
      // Database performance check
      try {
        const start = Date.now();
        await prisma.$queryRawUnsafe('SELECT 1');
        const responseTime = Date.now() - start;
        
        metrics.database.status = 'operational';
        metrics.database.responseTime = responseTime + 'ms';
      } catch (dbErr) {
        metrics.database.status = 'error';
        metrics.database.error = dbErr.message;
      }
      
      return metrics;
    } catch (error) {
      logger.error('Performance metrics error:', error);
      throw error;
    }
  }
  
  // Get version history (Admin only)
  static getVersionHistory(userInfo) {
    const packageInfo = this.getPackageInfo();
    
    return {
      current: packageInfo.version,
      releases: [
        {
          version: '1.0.0',
          releaseDate: formatDateDDMMYYYY(new Date('2025-06-24')),
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
        requestedBy: userInfo.uid,
        timestamp: formatDateDDMMYYYY(new Date())
      }
    };
  }
  
  // Check for updates (Admin only)
  static async checkForUpdates(userInfo) {
    const packageInfo = this.getPackageInfo();
    
    return {
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
        triggeredBy: userInfo.uid,
        timestamp: formatDateDDMMYYYY(new Date())
      }
    };
  }
}