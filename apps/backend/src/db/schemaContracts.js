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
  {
    id: 'scheduler.tenant.truth',
    label: 'Tenant scheduler outcome receipts',
    tables: [
      {
        name: 'scheduled_job_runs',
        columns: [
          'id', 'job_label', 'lock_key', 'discovery_status', 'aggregate_status',
          'tenants_discovered', 'tenants_succeeded', 'tenants_failed',
          'tenants_unresolved', 'failure_code', 'started_at', 'finished_at',
        ],
      },
      {
        name: 'scheduled_job_tenant_runs',
        columns: ['run_id', 'tenant_id', 'status', 'failure_code', 'started_at', 'finished_at'],
      },
    ],
    probe: {
      sql: `SELECT r.id, r.job_label, r.lock_key, r.aggregate_status, r.tenants_unresolved
              FROM scheduled_job_runs r
              LEFT JOIN scheduled_job_tenant_runs t ON t.run_id = r.id
             LIMIT 1`,
    },
  },
  {
    id: 'notifications.scheduled.tenant-owner',
    label: 'Scheduled notification tenant ownership',
    tables: [
      {
        name: 'scheduled_notifications',
        columns: ['id', 'tenant_id', 'user_id', 'type', 'send_at', 'status'],
      },
      {
        name: 'users',
        columns: ['id', 'tenant_id'],
      },
    ],
    probe: {
      sql: `SELECT sn.id, sn.tenant_id, sn.user_id
              FROM scheduled_notifications sn
              JOIN users u
                ON u.tenant_id = sn.tenant_id
               AND u.id = sn.user_id
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

function uniqueProbeToken() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function expectStatementRejected(
  client,
  { contract, label, sql, params = [], expectedCode, expectedConstraint },
  failures,
) {
  const savepoint = `schema_contract_${uniqueProbeToken()}`.replace(/[^a-z0-9_]/gi, '_');
  await runQuery(client, `SAVEPOINT ${quoteIdentifier(savepoint)}`);
  try {
    await runQuery(client, sql, params);
    failures.push({ contract, message: `Invalid fixture unexpectedly accepted: ${label}` });
  } catch (err) {
    if (expectedCode && err?.code !== expectedCode) {
      failures.push({
        contract,
        message: `${label} rejected with SQLSTATE ${err?.code || 'unknown'}, expected ${expectedCode}`,
      });
    }
    if (expectedConstraint && err?.constraint !== expectedConstraint) {
      failures.push({
        contract,
        message: `${label} rejected by ${err?.constraint || 'an unknown constraint'}, expected ${expectedConstraint}`,
      });
    }
  } finally {
    await runQuery(client, `ROLLBACK TO SAVEPOINT ${quoteIdentifier(savepoint)}`);
    await runQuery(client, `RELEASE SAVEPOINT ${quoteIdentifier(savepoint)}`);
  }
}

async function runIntegrityRejectionProbes(client, failures) {
  await runQuery(client, 'BEGIN');
  try {
    const posture = await runQuery(client, `
      SELECT current_setting('session_replication_role') = 'origin' AS triggers_enabled
    `);
    if (!posture.rows[0]?.triggers_enabled) {
      failures.push({
        contract: 'integrity.trigger-posture',
        message: 'Constraint rejection probes require session_replication_role=origin',
      });
      return;
    }

    const fixtures = await runQuery(client, `
      SELECT u.id AS user_id,
             u.tenant_id AS owner_tenant_id,
             other.id AS other_tenant_id
        FROM users u
        JOIN LATERAL (
          SELECT t.id
            FROM tenants t
           WHERE t.id <> u.tenant_id
           ORDER BY t.id
           LIMIT 1
        ) other ON TRUE
       ORDER BY u.id
       LIMIT 1
    `);
    if (!fixtures.rows[0]) {
      failures.push({
        contract: 'integrity.fixture',
        message: 'Constraint rejection probes require a user plus a second tenant',
      });
      return;
    }
    const fixture = fixtures.rows[0];

    await expectStatementRejected(client, {
      contract: 'notifications.scheduled.tenant-owner',
      label: 'scheduled notification owned by a user in another tenant',
      sql: `INSERT INTO scheduled_notifications
              (tenant_id, user_id, type, data, send_at, status)
            VALUES ($1::uuid, $2::integer, 'feedback_request', '{}'::jsonb, NOW(), 'pending')`,
      params: [fixture.other_tenant_id, fixture.user_id],
      expectedCode: '23503',
      expectedConstraint: 'scheduled_notifications_tenant_user_fk',
    }, failures);

    await runQuery(
      client,
      `SELECT set_config('app.current_tenant_id', $1::text, true)`,
      [fixture.owner_tenant_id],
    );

    await expectStatementRejected(client, {
      contract: 'scheduler.tenant.truth',
      label: 'tenant scheduler outcome without a parent run',
      sql: `INSERT INTO scheduled_job_tenant_runs
              (run_id, tenant_id, status, failure_code, finished_at)
            VALUES (-1, $1::uuid, 'failed', 'TEST_ORPHAN', NOW())`,
      params: [fixture.owner_tenant_id],
      expectedCode: '23514',
      expectedConstraint: 'scheduled_job_tenant_run_parent_running',
    }, failures);
  } finally {
    await runQuery(client, 'ROLLBACK');
  }
}

async function runSeedInvariantProbes(client, failures) {
  const probes = [
    {
      contract: 'seed.identity.graph',
      label: 'seeded patient, staff, appointment, and admission relationships are coherent',
      sql: `SELECT
        EXISTS (
          SELECT 1
            FROM users u
           WHERE u.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
             AND u.role = 'PATIENT'
        )
        AND EXISTS (
          SELECT 1
            FROM staff s
            JOIN users u ON u.uid = s.user_id
           WHERE s.tenant_id = u.tenant_id
        )
        AND EXISTS (
          SELECT 1
            FROM appointments a
            JOIN users u
              ON u.tenant_id = a.tenant_id
             AND u.id = a.patient_id
        )
        AND EXISTS (
          SELECT 1
            FROM admissions a
            JOIN users u
              ON u.tenant_id = a.tenant_id
             AND u.uid = a.patient_uid
        ) AS ok`,
    },
    {
      contract: 'seed.notification.graph',
      label: 'seeded scheduled notification has an exact tenant-owned recipient',
      sql: `SELECT
        EXISTS (
          SELECT 1
            FROM scheduled_notifications sn
            JOIN users u
              ON u.tenant_id = sn.tenant_id
             AND u.id = sn.user_id
           WHERE sn.data->>'appointment_id' = 'seed'
             AND sn.data->>'survey' = 'nps'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM scheduled_notifications sn
            LEFT JOIN users u
              ON u.tenant_id = sn.tenant_id
             AND u.id = sn.user_id
           WHERE u.id IS NULL
        ) AS ok`,
    },
  ];

  const results = [];
  for (const probe of probes) {
    const result = await runQuery(client, probe.sql);
    const ok = result.rows[0]?.ok === true;
    results.push({ id: probe.contract, label: probe.label, ok });
    if (!ok) failures.push({ contract: probe.contract, message: probe.label });
  }
  return results;
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
      coverageOnly: true,
      invariants: [],
    };
    seeded.invariants = await runSeedInvariantProbes(client, failures);
    await runIntegrityRejectionProbes(client, failures);
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
