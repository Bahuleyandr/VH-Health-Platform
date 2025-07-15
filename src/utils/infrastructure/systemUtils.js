// utils/infrastructure/systemUtils.js
import os from 'os';
import { formatDateDDMMYYYY } from '../dateUtils.js';

// Get system metrics
export const getSystemMetrics = () => {
  const cpus = os.cpus();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  
  return {
    cpu: {
      count: cpus.length,
      model: cpus[0]?.model || 'Unknown',
      speed: cpus[0]?.speed || 0,
      usage: process.cpuUsage(),
      loadAverage: os.loadavg().map(avg => Math.round(avg * 100) / 100)
    },
    memory: {
      total: {
        bytes: totalMemory,
        mb: Math.round(totalMemory / 1024 / 1024),
        gb: Math.round(totalMemory / 1024 / 1024 / 1024 * 100) / 100
      },
      free: {
        bytes: freeMemory,
        mb: Math.round(freeMemory / 1024 / 1024),
        gb: Math.round(freeMemory / 1024 / 1024 / 1024 * 100) / 100
      },
      used: {
        bytes: usedMemory,
        mb: Math.round(usedMemory / 1024 / 1024),
        gb: Math.round(usedMemory / 1024 / 1024 / 1024 * 100) / 100,
        percentage: Math.round((usedMemory / totalMemory) * 100)
      }
    },
    process: {
      pid: process.pid,
      version: process.version,
      uptime: Math.floor(process.uptime()),
      memoryUsage: process.memoryUsage()
    },
    system: {
      platform: os.platform(),
      architecture: os.arch(),
      hostname: os.hostname(),
      uptime: Math.floor(os.uptime()),
      type: os.type(),
      release: os.release()
    }
  };
};

// Get process memory usage
export const getProcessMemory = () => {
  const usage = process.memoryUsage();
  return {
    rss: {
      bytes: usage.rss,
      mb: Math.round(usage.rss / 1024 / 1024),
      description: 'Resident Set Size - total memory allocated'
    },
    heapTotal: {
      bytes: usage.heapTotal,
      mb: Math.round(usage.heapTotal / 1024 / 1024),
      description: 'Total heap allocated'
    },
    heapUsed: {
      bytes: usage.heapUsed,
      mb: Math.round(usage.heapUsed / 1024 / 1024),
      description: 'Heap actually used'
    },
    external: {
      bytes: usage.external,
      mb: Math.round(usage.external / 1024 / 1024),
      description: 'External C++ objects memory'
    },
    arrayBuffers: {
      bytes: usage.arrayBuffers || 0,
      mb: Math.round((usage.arrayBuffers || 0) / 1024 / 1024),
      description: 'ArrayBuffers and SharedArrayBuffers memory'
    }
  };
};

// Format uptime to human readable
export const formatUptime = (seconds) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  
  return parts.join(' ');
};

// Get safe environment variables
export const getSafeEnvironmentVars = () => {
  const safeVars = {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    API_VERSION: process.env.API_VERSION,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'Not configured',
    PATIENT_APP_ORIGINS: process.env.PATIENT_APP_ORIGINS || 'Not configured',
    ADMIN_APP_ORIGINS: process.env.ADMIN_APP_ORIGINS || 'Not configured',
    DEBUG_CORS: process.env.DEBUG_CORS || 'false',
    LOG_LEVEL: process.env.LOG_LEVEL,
    BUILD_DATE: process.env.BUILD_DATE || formatDateDDMMYYYY(new Date())
  };
  
  // Add sanitized versions of sensitive vars
  const sensitiveVars = [
    'DATABASE_URL', 'JWT_SECRET', 'API_KEY', 
    'FIREBASE_PROJECT_ID', 'CF_R2_BUCKET'
  ];
  
  sensitiveVars.forEach(varName => {
    if (process.env[varName]) {
      safeVars[varName] = process.env[varName].substring(0, 10) + '...[REDACTED]';
    }
  });
  
  return safeVars;
};

// Get network interfaces info
export const getNetworkInfo = () => {
  const interfaces = os.networkInterfaces();
  const result = {};
  
  Object.keys(interfaces).forEach(name => {
    result[name] = interfaces[name]
      .filter(iface => !iface.internal)
      .map(iface => ({
        family: iface.family,
        address: iface.family === 'IPv6' ? '[REDACTED]' : iface.address,
        mac: '[REDACTED]'
      }));
  });
  
  return result;
};

// Check system health
export const checkSystemHealth = () => {
  const metrics = getSystemMetrics();
  const issues = [];
  let status = 'healthy';
  
// Check CORS configuration
if (!process.env.ALLOWED_ORIGINS && !process.env.PATIENT_APP_ORIGINS && !process.env.ADMIN_APP_ORIGINS) {
  issues.push('No CORS origins configured');
  status = status === 'healthy' ? 'warning' : status;
}

  // Check memory usage
  if (metrics.memory.used.percentage > 90) {
    issues.push('Critical memory usage (>90%)');
    status = 'critical';
  } else if (metrics.memory.used.percentage > 80) {
    issues.push('High memory usage (>80%)');
    status = status === 'healthy' ? 'warning' : status;
  }
  
  // Check load average (1 minute)
  const loadPerCPU = metrics.cpu.loadAverage[0] / metrics.cpu.count;
  if (loadPerCPU > 2) {
    issues.push('High CPU load');
    status = status === 'healthy' ? 'warning' : status;
  }
  
  // Check process memory
  const processMemory = getProcessMemory();
  if (processMemory.heapUsed.mb > 1024) {
    issues.push('High heap memory usage (>1GB)');
    status = status === 'healthy' ? 'warning' : status;
  }
  
  return {
    status,
    issues,
    timestamp: formatDateDDMMYYYY(new Date()),
    metrics: {
      memoryUsage: `${metrics.memory.used.percentage}%`,
      cpuLoad: metrics.cpu.loadAverage[0],
      processHeap: `${processMemory.heapUsed.mb}MB`
    }
  };
};