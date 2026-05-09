import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

/**
 * Verify Postgres is using UTF-8 for both server and client encoding.
 *
 * Background: a swarm tenant DB created with non-UTF8 encoding (e.g.,
 * SQL_ASCII or LATIN1) silently corrupts multi-byte chars typed by
 * doctors — `°C` → `�C`, `μg` → `?g` — and the corruption only shows
 * up later when a clinical PDF is generated or a downstream service
 * reads the value. There is no app-level code that strips non-ASCII
 * (verified across utils/sanitize.js, sanitizeMiddleware.js, the
 * vitalsChartService stripNul helper, and the request body chain),
 * so a UTF-8 mismatch at the DB layer is the only realistic root
 * cause for the U+FFFD corruption.
 *
 * This check fails loud at startup so a misconfigured deployment
 * never silently destroys clinical text.
 *
 * Finding: 2026-05-08-walk-in-opd-doctor-notes-non-ascii-corrupted.
 */
async function checkDbEncoding() {
  try {
    const rows = await prisma.$queryRawUnsafe(
      "SHOW server_encoding"
    );
    const clientRows = await prisma.$queryRawUnsafe(
      "SHOW client_encoding"
    );
    const serverEncoding = rows?.[0]?.server_encoding ?? 'unknown';
    const clientEncoding = clientRows?.[0]?.client_encoding ?? 'unknown';
    const serverOk = String(serverEncoding).toUpperCase() === 'UTF8';
    const clientOk = String(clientEncoding).toUpperCase() === 'UTF8';
    const ok = serverOk && clientOk;

    if (ok) {
      logger.info(
        `✅ DB encoding check passed — server=${serverEncoding}, client=${clientEncoding}`
      );
    } else {
      logger.error(
        `❌ DB encoding check FAILED — server=${serverEncoding}, client=${clientEncoding}. ` +
        `Non-UTF-8 storage will silently corrupt clinical text (e.g. "°C" → "�C"). ` +
        `Recreate the database with ENCODING 'UTF8' or set client_encoding TO 'UTF8' on the connection.`
      );
    }
    return { ok, serverEncoding, clientEncoding };
  } catch (err) {
    logger.error(`DB encoding check error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

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

    // Encoding check — non-blocking but loud so misconfigured
    // deployments are caught before clinical text is corrupted.
    const encoding = await checkDbEncoding();
    if (!encoding.ok) {
      healthy = false;
    }

    if (healthy) {
      logger.info('✅ Schema health check passed — all critical tables accessible');
    } else {
      logger.error('❌ Schema health check FAILED — some tables inaccessible or DB encoding wrong:', results);
    }

    return { healthy, tables: results, encoding, checkedAt: new Date().toISOString() };
  } catch (error) {
    logger.error('Schema health check error:', error.message);
    return { healthy: false, error: error.message, checkedAt: new Date().toISOString() };
  }
}
