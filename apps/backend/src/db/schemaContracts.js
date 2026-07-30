import { partitionSeedCoverageEmptyTables } from './seedCoveragePolicy.js';

export const SCHEMA_CONTRACTS = [
  {
    id: 'health.ready',
    label: 'Health readiness sentinel',
    tables: [
      {
        name: 'appointment_status_history',
        columns: ['id', 'appointment_id', 'from_status', 'to_status', 'created_at'],
      },
    ],
    probe: {
      sql: `SELECT id, appointment_id, from_status, to_status, created_at
              FROM appointment_status_history
             LIMIT 1`,
    },
  },
  {
    id: 'auth.admin',
    label: 'Admin authentication',
    tables: [
      {
        name: 'admins',
        columns: ['uid', 'username', 'password_hash', 'role', 'is_active', 'totp_enabled'],
      },
    ],
    probe: {
      sql: `SELECT uid, username, role, is_active, totp_enabled
              FROM admins
             LIMIT 1`,
    },
  },
  {
    id: 'auth.staff',
    label: 'Staff authentication and profile',
    tables: [
      {
        name: 'users',
        columns: ['id', 'uid', 'phone', 'name', 'role', 'encrypted_password', 'is_active'],
      },
      {
        name: 'staff',
        columns: ['id', 'user_id', 'employee_id', 'name', 'department', 'is_active'],
      },
    ],
    probe: {
      sql: `SELECT s.id, s.employee_id, s.name, s.user_id
              FROM staff s
             LIMIT 1`,
    },
  },
  {
    id: 'staff.attendance.calendar',
    label: 'Staff attendance calendar',
    tables: [
      {
        name: 'staff_attendance',
        columns: ['id', 'staff_id', 'check_in_time', 'check_out_time', 'attendance_status'],
      },
      {
        name: 'leave_applications',
        columns: ['id', 'staff_id', 'leave_type', 'start_date', 'end_date', 'status'],
      },
    ],
    probe: {
      sql: `SELECT id, staff_id, check_in_time, check_out_time, attendance_status
              FROM staff_attendance
             LIMIT 1`,
    },
  },
  {
    id: 'staff.shift',
    label: 'Staff shift assignment',
    tables: [
      {
        name: 'staff_shifts',
        columns: ['id', 'name', 'start_time', 'end_time', 'grace_minutes', 'grace_period_minutes'],
      },
      {
        name: 'staff_shift_assignments',
        columns: ['id', 'staff_id', 'shift_id', 'effective_from', 'effective_to'],
      },
    ],
    probe: {
      sql: `SELECT ss.id, ss.name, ssa.staff_id
              FROM staff_shifts ss
              LEFT JOIN staff_shift_assignments ssa ON ssa.shift_id = ss.id
             LIMIT 1`,
    },
  },
  {
    id: 'staff.replacement',
    label: 'Staff replacement requests',
    tables: [
      {
        name: 'replacement_requests',
        columns: [
          'id',
          'leave_request_id',
          'requester_id',
          'replacement_staff_id',
          'status',
          'requested_at',
        ],
      },
    ],
    probe: {
      sql: `SELECT id, requester_id, replacement_staff_id, status, requested_at
              FROM replacement_requests
             LIMIT 1`,
    },
  },
  {
    id: 'appointments.list',
    label: 'Appointment list and queue',
    tables: [
      {
        name: 'appointments',
        columns: [
          'id',
          'uid',
          'patient_id',
          'doctor_id',
          'appointment_date',
          'appointment_time',
          'status',
        ],
      },
      {
        name: 'doctors',
        columns: ['id', 'user_id', 'name', 'department_id', 'department', 'is_available'],
      },
      {
        name: 'departments',
        columns: ['id', 'name', 'is_active'],
      },
    ],
    probe: {
      sql: `SELECT a.id, a.patient_id, a.doctor_id, a.appointment_date, a.status
              FROM appointments a
             LIMIT 1`,
    },
  },
  {
    id: 'beds.board',
    label: 'Ward and bed board',
    tables: [
      {
        name: 'wards',
        columns: ['id', 'name', 'floor', 'department_id', 'total_beds'],
      },
      {
        name: 'beds',
        columns: ['id', 'ward_id', 'bed_number', 'status', 'patient_id', 'patient_name'],
      },
      {
        name: 'admissions',
        columns: ['id', 'patient_uid', 'status', 'bed_id', 'admitted_at', 'updated_at'],
      },
    ],
    probe: {
      sql: `SELECT b.id, b.ward_id, b.bed_number, b.status, w.name AS ward_name
              FROM beds b
              LEFT JOIN wards w ON w.id = b.ward_id
             LIMIT 1`,
    },
  },
  {
    id: 'notifications.my',
    label: 'Staff and patient notifications',
    tables: [
      {
        name: 'notifications',
        columns: ['id', 'uid', 'phone', 'title', 'body', 'type', 'is_read', 'created_at'],
      },
    ],
    probe: {
      sql: `SELECT id, phone, title, type, is_read, created_at
              FROM notifications
             LIMIT 1`,
    },
  },
  {
    id: 'investigations.booking',
    label: 'Investigation catalog and bookings',
    tables: [
      {
        name: 'investigations',
        columns: ['id', 'patient_id', 'test_name', 'test_type', 'status', 'created_at'],
      },
      {
        name: 'investigation_bookings',
        columns: ['id', 'booking_number', 'patient_id', 'test_name', 'status', 'created_at'],
      },
    ],
    probe: {
      sql: `SELECT ib.id, ib.booking_number, ib.patient_id, ib.test_name, ib.status
              FROM investigation_bookings ib
             LIMIT 1`,
    },
  },
  {
    id: 'pharmacy.catalog',
    label: 'Pharmacy catalog route',
    tables: [
      {
        name: 'pharmacy_catalog',
        columns: [
          'id',
          'name',
          'category',
          'price',
          'stock',
          'is_active',
          'is_available',
          'description',
          'created_at',
        ],
      },
    ],
    probe: {
      sql: `SELECT id, name, category, price, stock, is_available, description, created_at
              FROM pharmacy_catalog
             WHERE is_active = TRUE
             ORDER BY category, name
             LIMIT 1`,
    },
  },
  {
    id: 'pharmacy.orders',
    label: 'Pharmacy order workflow',
    tables: [
      {
        name: 'pharmacy_orders',
        columns: [
          'id',
          'uid',
          'patient_id',
          'patient_name',
          'status',
          'order_number',
          'created_at',
        ],
      },
    ],
    probe: {
      sql: `SELECT id, uid, patient_id, patient_name, status, order_number, created_at
              FROM pharmacy_orders
             LIMIT 1`,
    },
  },
  {
    id: 'records.core',
    label: 'Medical and patient records',
    tables: [
      {
        name: 'medical_records',
        columns: ['id', 'patient_id', 'doctor_id', 'record_type', 'title', 'created_at'],
      },
      {
        name: 'patient_records',
        columns: ['id', 'patient_id', 'document_type', 'title', 'file_key', 'created_at'],
      },
    ],
    probe: {
      sql: `SELECT id, patient_id, record_type, title, created_at
              FROM medical_records
             LIMIT 1`,
    },
  },
];

export function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

async function runQuery(client, sql, params = []) {
  if (typeof client.query === 'function') {
    return client.query(sql, params);
  }
  if (typeof client.$queryRawUnsafe === 'function') {
    const rows = await client.$queryRawUnsafe(sql, ...params);
    return { rows };
  }
  throw new Error('Unsupported database client');
}

async function getPublicTableColumns(client) {
  const result = await runQuery(client, `
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position
  `);

  const columnsByTable = new Map();
  for (const row of result.rows) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name).add(row.column_name);
  }
  return columnsByTable;
}

async function getPublicAppTables(client) {
  const result = await runQuery(client, `
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname NOT LIKE '\\_%' ESCAPE '\\'
     ORDER BY c.relname
  `);
  return result.rows.map((row) => row.table_name);
}

async function tableHasRows(client, tableName) {
  const result = await runQuery(
    client,
    `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(tableName)} LIMIT 1) AS has_rows`
  );
  return Boolean(result.rows[0]?.has_rows);
}

export async function runSchemaContractCheck(client, options = {}) {
  const columnsByTable = await getPublicTableColumns(client);
  const contractResults = [];
  const failures = [];

  for (const contract of SCHEMA_CONTRACTS) {
    const checks = [];
    for (const table of contract.tables) {
      const columns = columnsByTable.get(table.name);
      if (!columns) {
        const message = `Missing table: ${table.name}`;
        checks.push({ type: 'table', table: table.name, ok: false, message });
        failures.push({ contract: contract.id, message });
        continue;
      }

      checks.push({ type: 'table', table: table.name, ok: true });
      const missingColumns = table.columns.filter((column) => !columns.has(column));
      if (missingColumns.length > 0) {
        const message = `Missing columns on ${table.name}: ${missingColumns.join(', ')}`;
        checks.push({ type: 'columns', table: table.name, ok: false, missing: missingColumns, message });
        failures.push({ contract: contract.id, message });
      } else {
        checks.push({ type: 'columns', table: table.name, ok: true });
      }
    }

    if (contract.probe && checks.every((check) => check.ok)) {
      try {
        await runQuery(client, contract.probe.sql, contract.probe.params || []);
        checks.push({ type: 'probe', ok: true });
      } catch (err) {
        const message = `Probe failed: ${err.message}`;
        checks.push({ type: 'probe', ok: false, message });
        failures.push({ contract: contract.id, message });
      }
    }

    contractResults.push({
      id: contract.id,
      label: contract.label,
      ok: checks.every((check) => check.ok),
      checks,
    });
  }

  let seeded = null;
  if (options.requireSeeded) {
    const tables = await getPublicAppTables(client);
    const emptyTables = [];
    for (const table of tables) {
      if (!(await tableHasRows(client, table))) emptyTables.push(table);
    }
    const {
      intentionallyEmptyAppTables,
      unexpectedEmptyAppTables,
    } = partitionSeedCoverageEmptyTables(emptyTables);
    seeded = {
      totalAppTables: tables.length,
      nonEmptyAppTables: tables.length - emptyTables.length,
      emptyTables,
      intentionallyEmptyAppTables,
      unexpectedEmptyAppTables,
      ok: unexpectedEmptyAppTables.length === 0,
    };
    for (const table of unexpectedEmptyAppTables) {
      failures.push({ contract: 'seeded.table.coverage', message: `Empty table after seed: ${table}` });
    }
  }

  return {
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    totals: {
      contracts: contractResults.length,
      passing: contractResults.filter((contract) => contract.ok).length,
      failing: contractResults.filter((contract) => !contract.ok).length,
      failures: failures.length,
    },
    contracts: contractResults,
    seeded,
    failures,
  };
}
