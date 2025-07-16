// services/infrastructure/debugService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { 
  getSystemMetrics, 
  getProcessMemory, 
  formatUptime, 
  getSafeEnvironmentVars,
  checkSystemHealth 
} from '../../utils/infrastructure/systemUtils.js';

export class DebugService {
  // Get debug information
  static async getDebugInfo(userInfo) {
    try {
      const [dbInfo, systemMetrics, processInfo] = await Promise.all([
        this.getDatabaseInfo(),
        getSystemMetrics(),
        this.getProcessInfo()
      ]);
      
      return {
        environment: process.env.NODE_ENV || 'development',
        apiVersion: process.env.API_VERSION || '1.0.0',
        timestamp: formatDateDDMMYYYY(new Date()),
        database: dbInfo,
        system: systemMetrics,
        process: processInfo,
        requestedBy: userInfo?.name || 'Unknown',
        requestedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Debug info error:', error);
      throw error;
    }
  }
  
  // Get database information
  static async getDatabaseInfo() {
    try {
      const versionResult = await db.query('SELECT version()');
      const connectionResult = await db.query(`
        SELECT count(*) as total_connections,
               sum(case when state = 'active' then 1 else 0 end) as active_connections
        FROM pg_stat_activity
      `);
      
      return {
        connected: true,
        version: versionResult.rows[0].version.split(' ')[1],
        connections: connectionResult.rows[0],
        host: process.env.DATABASE_URL ? '[REDACTED]' : 'unknown'
      };
    } catch (error) {
      return {
        connected: false,
        error: error.message
      };
    }
  }
  
  // Get process information
  static getProcessInfo() {
    return {
      pid: process.pid,
      ppid: process.ppid,
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: formatUptime(process.uptime()),
      uptimeSeconds: Math.floor(process.uptime()),
      memory: getProcessMemory(),
      cpuUsage: process.cpuUsage()
    };
  }
  
  // Test database connection
  static async testDatabaseConnection() {
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
      
      return {
        connected: true,
        responseTimeMs: responseTime,
        serverTime: result.rows[0].server_time,
        postgresVersion: result.rows[0].postgres_version.split(' ')[0],
        sampleTables: tableCheck.rows,
        tableCount: tableCheck.rows.length
      };
    } catch (error) {
      logger.error('Database test error:', error);
      throw error;
    }
  }
  
  // Get application health
  static async getApplicationHealth() {
    try {
      const healthData = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
        memoryUsage: process.memoryUsage(),
        systemHealth: checkSystemHealth(),
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
      
      return healthData;
    } catch (error) {
      logger.error('Health check error:', error);
      throw error;
    }
  }
  
  // Get environment variables (sanitized)
  static getEnvironmentVariables() {
    return {
      environment: getSafeEnvironmentVars(),
      totalEnvVars: Object.keys(process.env).length,
      warning: 'Sensitive environment variables are redacted for security'
    };
  }
  
  // Get recent logs (mock implementation)
  static async getRecentLogs(level = 'all', limit = 50) {
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
      
    return {
      logs: filteredLogs.slice(0, parseInt(limit)),
      totalLogs: filteredLogs.length,
      filter: { level, limit: parseInt(limit) },
      note: 'This is mock data - integrate with actual logging system'
    };
  }
  
  // Get performance metrics
  static async getPerformanceMetrics() {
    try {
      const metrics = {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        resourceUsage: process.resourceUsage ? process.resourceUsage() : 'Not available',
        systemMetrics: getSystemMetrics()
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
      
      return metrics;
    } catch (error) {
      logger.error('Performance metrics error:', error);
      throw error;
    }
  }
  
  // Trigger garbage collection
  static triggerGarbageCollection() {
    if (global.gc) {
      const before = process.memoryUsage();
      global.gc();
      const after = process.memoryUsage();
      
      return {
        triggered: true,
        memoryBefore: before,
        memoryAfter: after,
        freedBytes: before.heapUsed - after.heapUsed,
        timestamp: new Date().toISOString()
      };
    }
    
    return {
      triggered: false,
      reason: 'Garbage collection not available (start with --expose-gc flag)'
    };
  }
  
  // Simulate load test
  static async simulateLoadTest(iterations = 1000, delay = 1) {
    logger.info(`🔄 Load test started: ${iterations} iterations`);
    
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
    
    return {
      completed: true,
      iterations,
      delayMs: delay,
      totalDurationMs: durationMs,
      avgIterationMs: durationMs / iterations,
      timestamp: new Date().toISOString()
    };
  }
}