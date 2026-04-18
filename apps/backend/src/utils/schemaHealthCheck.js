import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

export async function checkSchemaHealth() {
  try {
    // Verify critical tables exist and are queryable
    const checks = await Promise.allSettled([
      prisma.users.count(),
      prisma.admins.count(),
      prisma.otp_sessions.count(),
      prisma.staff.count(),
      prisma.appointments.count(),
    ]);

    const tables = ['users', 'admins', 'otp_sessions', 'staff', 'appointments'];
    const results = {};
    let healthy = true;

    checks.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        results[tables[i]] = { status: 'ok', count: result.value };
      } else {
        results[tables[i]] = { status: 'error', error: result.reason.message };
        healthy = false;
      }
    });

    if (healthy) {
      logger.info('✅ Schema health check passed — all critical tables accessible');
    } else {
      logger.error('❌ Schema health check FAILED — some tables inaccessible:', results);
    }

    return { healthy, tables: results, checkedAt: new Date().toISOString() };
  } catch (error) {
    logger.error('Schema health check error:', error.message);
    return { healthy: false, error: error.message, checkedAt: new Date().toISOString() };
  }
}
