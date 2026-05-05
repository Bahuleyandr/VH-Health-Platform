import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { SCHEMA_CONTRACTS } from '../db/schemaContracts.js';

const RUNTIME_EXPECTED_TABLES = [
  'users',
  'appointments',
  'doctors',
  'departments',
  'health_records',
  'patient_records',
  'patient_allergies',
  'investigations',
  'investigation_bookings',
  'investigation_test_catalog',
  'pharmacy_orders',
  'pharmacy_catalog',
  'e_prescriptions',
  'medications',
  'notifications',
  'notification_outbox',
  'scheduled_notifications',
  'feedback',
  'sos_alerts',
  'staff_devices',
  'staff_auth_sessions',
  'audit_logs',
  'hipaa_access_log',
  'appointment_documents',
  'appointment_status_history',
  'wards',
  'beds',
];

function getExpectedTables() {
  const contractTables = SCHEMA_CONTRACTS.flatMap((contract) =>
    contract.tables.map((table) => table.name)
  );
  return [...new Set([...RUNTIME_EXPECTED_TABLES, ...contractTables])].sort();
}

/**
 * Detect schema drift between expected tables and actual database.
 * Run at startup to catch mismatches early.
 */
export async function detectSchemaDrift() {
  const expectedTables = getExpectedTables();

  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const actualTables = new Set(result.map(r => r.table_name));

    const missing = expectedTables.filter(t => !actualTables.has(t));
    const additional = [...actualTables]
      .filter(t => !expectedTables.includes(t) && !t.startsWith('_'))
      .sort();

    if (missing.length > 0) {
      logger.warn(`Schema drift: ${missing.length} expected tables MISSING from database:`, missing);
    }
    if (additional.length > 0) {
      logger.info(
        `Schema drift: ${additional.length} additional managed tables present beyond route-critical checks.`,
      );
    }
    if (missing.length === 0) {
      logger.info('Schema check: all route-critical tables present');
    }

    return {
      missing,
      additional,
      unexpected: additional,
      total: actualTables.size,
      expected: expectedTables.length,
    };
  } catch (err) {
    logger.error('Schema drift detection failed:', err.message);
    return { missing: [], additional: [], unexpected: [], expected: expectedTables.length, error: err.message };
  }
}

export default { detectSchemaDrift };
