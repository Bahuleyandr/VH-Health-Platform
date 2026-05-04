import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

/**
 * Detect schema drift between expected tables and actual database.
 * Run at startup to catch mismatches early.
 */
export async function detectSchemaDrift() {
  // Tables whose absence would break a real route or service. Runtime-
  // bookkeeping tables (e.g. `_migrations`, created lazily by
  // `src/utils/migrations/runMigrations.js` at server startup) are excluded —
  // they're not a schema invariant the drift detector should gate on, and
  // CI's `scripts/ci-setup-db.mjs` bypasses the runtime migration runner by
  // design, so `_migrations` never exists in the test DB.
  const expectedTables = [
    'users', 'appointments', 'doctors', 'departments',
    'health_records', 'patient_records', 'patient_allergies',
    'investigations', 'investigation_bookings', 'investigation_test_catalog',
    'pharmacy_orders', 'pharmacy_catalog', 'e_prescriptions', 'medications',
    'notifications', 'notification_outbox', 'scheduled_notifications',
    'feedback', 'sos_alerts',
    'staff_devices', 'staff_auth_sessions',
    'audit_logs', 'hipaa_access_log',
    'appointment_documents', 'appointment_status_history',
    'wards', 'beds',
  ];

  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const actualTables = new Set(result.map(r => r.table_name));

    const missing = expectedTables.filter(t => !actualTables.has(t));
    const unexpected = [...actualTables].filter(t => !expectedTables.includes(t) && !t.startsWith('_'));

    if (missing.length > 0) {
      logger.warn(`Schema drift: ${missing.length} expected tables MISSING from database:`, missing);
    }
    if (unexpected.length > 0) {
      logger.info(`Schema drift: ${unexpected.length} unexpected tables found (may be new):`, unexpected);
    }
    if (missing.length === 0 && unexpected.length === 0) {
      logger.info('Schema check: All expected tables present, no drift detected');
    }

    return { missing, unexpected, total: actualTables.size };
  } catch (err) {
    logger.error('Schema drift detection failed:', err.message);
    return { missing: [], unexpected: [], error: err.message };
  }
}

export default { detectSchemaDrift };
