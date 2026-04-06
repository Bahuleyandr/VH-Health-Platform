// src/services/health/systemHealthService.js
import { REQUIRED_ENV_VARS, SYSTEM_INFO } from '../../config/healthConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';


export async function checkDatabaseHealth() {
  let retries = 3;
  let lastError = null;
  
  while (retries > 0) {
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return { status: 'connected', error: null };
    } catch (err) {
      lastError = err;
      retries -= 1;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  logger.error('Database health check failed after retries:', lastError.message);
  return { status: 'disconnected', error: lastError.message };
}

export function checkEnvironmentVariables() {
  const missingEnv = REQUIRED_ENV_VARS.filter(key => !process.env[key]);
  
  return {
    status: missingEnv.length === 0 ? 'all variables present' : `missing: ${missingEnv.join(', ')}`,
    missing: missingEnv
  };
}

export function getSystemStatus() {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  
  return {
    status: 'healthy',
    uptime_seconds: Math.floor(uptime),
    uptime_formatted: formatUptime(uptime),
    memory: {
      used_mb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      total_mb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      external_mb: Math.round(memoryUsage.external / 1024 / 1024),
      usage_percent: Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100)
    },
    timestamp: new Date().toISOString(),
    node_version: process.version,
    environment: process.env.NODE_ENV || 'development'
  };
}

export function getAppVersion() {
  return {
    version: SYSTEM_INFO.VERSION,
    updated_at: SYSTEM_INFO.UPDATED_AT,
    message: `VH Health API Version ${SYSTEM_INFO.VERSION} - Enhanced Release with RBAC`,
    features: SYSTEM_INFO.FEATURES
  };
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours}h ${minutes}m ${secs}s`;
}