import bcrypt from 'bcrypt';
import pg from 'pg';
import { seedCurrentBedStructure } from './seed-current-bed-structure.mjs';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const STAFF_PASSWORD = process.env.VH_TEST_STAFF_PASSWORD || ['test', '1234'].join('');
const ADMIN_PASSWORD = process.env.VH_TEST_ADMIN_PASSWORD || STAFF_PASSWORD;
const SEED_TAG = 'vh_seed';
const MANUAL_SEED_TABLES = new Set([
  'insurance_claim_caps',
  // Pillar-D workflow tables — domain CHECKs the auto-seeder can't
  // satisfy (ordered time windows, XOR dosing, FDI tooth codes, plan-
  // anchored cycles). Seeded by seedPillarDWorkflowTables below.
  'provider_availability_templates',
  'resource_bookings',
  'chemo_protocol_drugs',
  'chemo_cycles',
  'dental_tooth_findings',
  // Double-entry ledger transactional tables — migration 344 added a
  // constraint trigger (ledger_assert_entry_balanced, DEFERRABLE INITIALLY
  // DEFERRED) requiring each entry's postings to sum to 0 at COMMIT. The
  // naive auto-seeder inserts a single unbalanced posting, which aborts the
  // whole seed transaction. They still need a row for the seeded-coverage
  // contract, so seedLedgerEntries below inserts one balanced journal entry
  // (two postings netting to zero) instead.
  'ledger_entries',
  'ledger_postings',
  // NL-1 identity SSO tables have realm/protocol/role CHECK constraints
  // that the generic relaxed seeder cannot infer safely.
  'tenant_identity_providers',
  'tenant_idp_role_mappings',
  // N6-1 radiology peer review rows must carry distinct reviewer/author
  // humans. The generic auto-seeder assigns one semantic UUID to both.
  'radiology_peer_reviews',
]);

const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL or TEST_DATABASE_URL is required.');
}

function isLocalTestDatabase(urlText) {
  try {
    const url = new URL(urlText);
    const host = url.hostname.toLowerCase();
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    return ['127.0.0.1', 'localhost', '::1'].includes(host) && database === 'vhhealth_test';
  } catch {
    return false;
  }
}

if (!isLocalTestDatabase(connectionString) && process.env.VH_ALLOW_NON_TEST_DATA_SEED !== 'true') {
  throw new Error(
    'Refusing to seed a non-local test database. Use a local vhhealth_test database, ' +
    'or set VH_ALLOW_NON_TEST_DATA_SEED=true for an intentional disposable CI database.'
  );
}

const client = new pg.Client({ connectionString });
await client.connect();

const quote = (ident) => `"${String(ident).replaceAll('"', '""')}"`;
const clip = (value, max) => {
  const text = String(value);
  return max && text.length > max ? text.slice(0, max) : text;
};

async function tableCount(table) {
  const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${quote(table)}`);
  return result.rows[0].count;
}

async function columnExists(table, column) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return result.rowCount > 0;
}

async function insert(table, row) {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    await client.query(`INSERT INTO ${quote(table)} DEFAULT VALUES`);
    return;
  }

  const columns = entries.map(([key]) => quote(key)).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
  const values = entries.map(([, value]) => value);
  await client.query(`INSERT INTO ${quote(table)} (${columns}) VALUES (${placeholders})`, values);
}

async function insertIfEmpty(table, rows) {
  if (await tableCount(table)) return 0;
  let inserted = 0;
  for (const row of rows) {
    await insert(table, row);
    inserted += 1;
  }
  return inserted;
}

async function first(table, select = '*', where = 'TRUE', params = []) {
  const result = await client.query(
    `SELECT ${select} FROM ${quote(table)} WHERE ${where} LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

async function firstValue(table, column) {
  const row = await first(table, quote(column));
  return row?.[column] ?? null;
}

async function getMetadata() {
  const columns = await client.query(`
    SELECT c.table_name,
           c.column_name,
           c.udt_name,
           c.data_type,
           c.is_nullable,
           c.column_default,
           c.is_identity,
           c.is_generated,
           c.character_maximum_length,
           c.ordinal_position
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position
  `);

  const fks = await client.query(`
    SELECT tc.table_name,
           kcu.column_name,
           ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'
  `);

  const checks = await client.query(`
    SELECT conrelid::regclass::text AS table_name,
           pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE contype = 'c'
       AND connamespace = 'public'::regnamespace
  `);

  const columnsByTable = new Map();
  for (const row of columns.rows) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, []);
    columnsByTable.get(row.table_name).push(row);
  }

  const fkByTableColumn = new Map();
  for (const row of fks.rows) {
    fkByTableColumn.set(`${row.table_name}.${row.column_name}`, row);
  }

  const checksByTable = new Map();
  const xorPairsByTable = new Map();
  for (const row of checks.rows) {
    if (!checksByTable.has(row.table_name)) checksByTable.set(row.table_name, []);
    checksByTable.get(row.table_name).push(row.definition);
    const xor = detectXorPair(row.definition);
    if (xor && !xorPairsByTable.has(row.table_name)) {
      xorPairsByTable.set(row.table_name, xor);
    }
  }

  return { columnsByTable, fkByTableColumn, checksByTable, xorPairsByTable };
}

function detectXorPair(definition) {
  // Mutually-exclusive pair: exactly one of (A, B) must be NOT NULL.
  // Matches `(A IS NOT NULL AND B IS NULL) OR (A IS NULL AND B IS NOT NULL)`
  // regardless of how many parens pg_get_constraintdef wraps each clause in.
  const stripped = definition.replace(/[()]/g, ' ').replace(/\s+/g, ' ');
  const re = /([a-z_][a-z0-9_]*)\s+IS\s+NOT\s+NULL\s+AND\s+([a-z_][a-z0-9_]*)\s+IS\s+NULL\s+OR\s+\1\s+IS\s+NULL\s+AND\s+\2\s+IS\s+NOT\s+NULL/i;
  const match = stripped.match(re);
  return match ? [match[1], match[2]] : null;
}

function checkedValue(checksByTable, table, column) {
  const definitions = checksByTable.get(table) || [];
  const lowerColumn = column.toLowerCase();
  for (const definition of definitions) {
    if (!definition.toLowerCase().includes(lowerColumn)) continue;
    const values = [...definition.matchAll(/'([^']+)'(?:::|,|\)|\])/g)].map((match) => match[1]);
    const cleaned = values.filter((value) => (
      !value.includes('::')
      && value.length <= 80
      && !/[\\^$[\]{}+*?]/.test(value)
    ));
    if (cleaned.length) return cleaned[0];
  }
  return null;
}

function semanticValue(column, table, index, ctx, maxLength) {
  const name = column.column_name.toLowerCase();
  const tablePrefix = table.replace(/[^a-z0-9]+/gi, '_').slice(0, 28);
  const text = (value) => clip(value, maxLength);

  if (name === 'tenant_id') return ctx.tenantId;
  if (name === 'patient_uid') return ctx.patient.uid;
  if (name === 'doctor_uid' || name === 'surgeon' || name === 'anesthetist') return ctx.doctor.uid;
  if (name.includes('staff_uid') || name === 'sender_uid' || name === 'recipient_uid') return ctx.staff.uid;
  if (name.endsWith('_uid') || name === 'uid') return ctx.generatedUuid;

  if (name === 'patient_id') return column.udt_name === 'uuid' ? ctx.patient.uid : ctx.patient.id;
  if (name === 'doctor_id') return column.udt_name === 'uuid' ? ctx.doctor.uid : ctx.doctor.id;
  if (name === 'staff_id') return column.udt_name === 'uuid' ? ctx.staff.uid : ctx.staff.userId;
  if (name === 'user_id') return column.udt_name === 'uuid' ? ctx.staff.uid : ctx.staff.userId;
  if (name === 'created_by' || name === 'updated_by' || name === 'changed_by') {
    return column.udt_name === 'uuid' ? ctx.staff.uid : ctx.staff.userId;
  }
  if (name.includes('appointment_id')) return ctx.appointmentId;
  if (name.includes('admission_id')) return ctx.admissionId;
  if (name.includes('department_id')) return ctx.departmentId;
  if (name.includes('ward_id')) return ctx.wardId;
  if (name.includes('bed_id')) return ctx.bedId;
  if (name.includes('pharmacy_order_id')) return ctx.pharmacyOrderId;
  if (name.includes('investigation_id')) return ctx.investigationId;
  if (name.includes('claim_id')) return ctx.invoiceId;
  if (name.includes('ot_schedule_id')) return ctx.otScheduleId;
  if (name.includes('care_plan_id')) return ctx.carePlanId;
  if (name.includes('chat_session_id')) return ctx.chatSessionId;
  if (name.includes('task_id')) return ctx.taskId;
  if (name.includes('api_client_id')) return ctx.apiClientId;
  if (name.includes('from_node_id') || name.includes('to_node_id')) return ctx.kgNodeId;

  if (name.includes('phone')) return text(`+919777${String(index).padStart(5, '0')}`);
  if (name.includes('email')) return text(`${tablePrefix}.${name}@example.test`);
  if (name === 'blood_group') return text('O+');
  if (name === 'component') return text('PRBC');
  if (name === 'gender') return text('Female');
  if (name.includes('priority')) return text('routine');
  if (name.includes('severity')) return text('low');
  if (name.includes('status')) return text('active');
  if (name.includes('role')) return text('staff');
  if (name.includes('type') || name.includes('kind') || name.includes('category')) return text('general');
  if (name.includes('code')) return text(`CODE-${index}`);
  if (name.includes('number')) return text(`VH-${String(index).padStart(5, '0')}`);
  if (name.includes('key')) return text(`${SEED_TAG}_${tablePrefix}_${index}`);
  if (name === 'sha256_hash' || name.endsWith('_sha256_hash')) return text('0'.repeat(64));
  if (name.includes('hash')) return text(`hash_${tablePrefix}_${index}`);
  if (name.includes('url')) return text(`https://example.test/${tablePrefix}/${index}`);
  if (name.includes('name') || name.includes('title') || name.includes('label')) return text(`Seed ${tablePrefix}`);
  if (name.includes('description') || name.includes('reason') || name.includes('notes') || name.includes('body')) {
    return text(`Synthetic local test data for ${table}.${column.column_name}`);
  }
  if (name.includes('date')) {
    if (column.udt_name === 'date' || column.udt_name === 'timestamp' || column.udt_name === 'timestamptz') {
      return new Date('2026-05-04T00:00:00.000Z');
    }
  }
  if (name.includes('time')) {
    if (column.udt_name === 'time' || column.udt_name === 'timetz') return '09:00:00';
    if (column.udt_name === 'timestamp' || column.udt_name === 'timestamptz') {
      return new Date('2026-05-04T09:00:00.000Z');
    }
  }
  if (name.includes('lat')) return 13.02936;
  if (name.includes('lng') || name.includes('lon')) return 80.24409;
  if (name === 'volume_ml') return 450;
  if (name.includes('amount') || name.includes('cost') || name.includes('rate') || name.includes('score')) return 1;
  if (name.includes('count') || name.includes('total') || name.includes('units') || name.includes('minutes')) return 1;

  return undefined;
}

function primitiveValue(column, table, index, ctx, checksByTable) {
  const checked = checkedValue(checksByTable, table, column.column_name);
  if (checked) return clip(checked, column.character_maximum_length);

  const semantic = semanticValue(column, table, index, ctx, column.character_maximum_length);
  if (semantic !== undefined) return semantic;

  const type = column.udt_name;
  if (type === 'uuid') return ctx.generatedUuid;
  if (['int2', 'int4', 'int8'].includes(type)) return 1;
  if (['float4', 'float8', 'numeric', 'money'].includes(type)) return 1;
  if (type === 'bool') return true;
  if (type === 'date') return new Date('2026-05-04T00:00:00.000Z');
  if (type === 'time') return '09:00:00';
  if (['timestamp', 'timestamptz'].includes(type)) return new Date('2026-05-04T09:00:00.000Z');
  if (type === 'json' || type === 'jsonb') return JSON.stringify({ seed: true });
  if (type.startsWith('_')) return [];
  if (type === 'bytea') return Buffer.from('seed');
  if (column.data_type === 'ARRAY') return [];
  return clip(`${SEED_TAG}_${table}_${column.column_name}_${index}`, column.character_maximum_length);
}

async function fkValue(fk, ctx) {
  const preferred = await firstValue(fk.foreign_table_name, fk.foreign_column_name);
  if (preferred !== null && preferred !== undefined) return preferred;

  if (fk.foreign_column_name === 'uid' || fk.foreign_column_name.endsWith('_uid')) return ctx.patient.uid;
  if (fk.foreign_column_name === 'id') return 1;
  return ctx.generatedUuid;
}

async function rowForTable(table, columns, metadata, ctx, index, relaxed = false) {
  const row = {};
  // For XOR check constraints (e.g. billing_refunds.chk_refund_target requires
  // exactly one of invoice_id/advance_id to be NOT NULL), drop the second
  // column so the kept column carries the value.
  const xorSkip = metadata.xorPairsByTable?.get(table)?.[1] ?? null;
  for (const column of columns) {
    if (column.column_name === xorSkip) continue;
    const hasDefault = column.column_default !== null;
    const isGenerated = column.is_identity === 'YES' || column.is_generated !== 'NEVER';
    if (isGenerated) continue;

    const required = column.is_nullable === 'NO' && !hasDefault;
    const fk = metadata.fkByTableColumn.get(`${table}.${column.column_name}`);
    if (!required && !fk) continue;

    if (fk) {
      row[column.column_name] = await fkValue(fk, ctx);
      continue;
    }

    if (required || relaxed) {
      row[column.column_name] = primitiveValue(column, table, index, ctx, metadata.checksByTable);
    }
  }
  return row;
}

async function tryInsertSeedRow(table, row, savepointSuffix) {
  const savepoint = `seed_${String(savepointSuffix).replace(/[^a-z0-9_]/gi, '_')}`;
  await client.query(`SAVEPOINT ${quote(savepoint)}`);
  try {
    await insert(table, row);
    await client.query(`RELEASE SAVEPOINT ${quote(savepoint)}`);
    return null;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${quote(savepoint)}`);
    await client.query(`RELEASE SAVEPOINT ${quote(savepoint)}`);
    return error;
  }
}

async function seedCoreData() {
  const staffHash = await bcrypt.hash(STAFF_PASSWORD, 10);
  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  await insertIfEmpty('admins', [{
    username: 'admin',
    password_hash: adminHash,
    email: 'admin@example.test',
    name: 'Seed Admin',
    role: 'SUPER_ADMIN',
    status: 'active',
    permissions: ['*'],
    updated_at: new Date(),
  }]);

  const staffAccounts = [
    ['EMP-1001', 'e2e_test Nurse Arya', 'NURSING_STAFF', '+919999990001', 'General Medicine', 'Staff Nurse'],
    ['EMP-1002', 'e2e_test Pharmacist Bala', 'PHARMACY_STAFF', '+919999990002', 'Pharmacy', 'Pharmacist'],
    ['EMP-1003', 'e2e_test LabTech Chitra', 'LAB_STAFF', '+919999990003', 'Laboratory', 'Lab Technician'],
    ['EMP-1004', 'Test Doctor', 'DOCTOR', '+919999990004', 'General Medicine', 'Consultant'],
    ['EMP-1005', 'Test HR', 'HR_STAFF', '+919999990005', 'HR', 'HR Officer'],
    ['EMP-1006', 'Test Admin', 'ADMIN', '+919999990006', 'Administration', 'Administrator'],
    ['EMP-1007', 'Test Super Admin', 'SUPER_ADMIN', '+919999990007', 'Administration', 'Super Admin'],
    ['EMP-1008', 'Test General Staff', 'GENERAL_STAFF', '+919999990008', 'Operations', 'Staff'],
  ];

  for (const [employeeId, name, role, phone, department, position] of staffAccounts) {
    const user = await client.query(
      `INSERT INTO users (phone, name, role, encrypted_password, is_active, status, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, 'active', NOW())
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET name = EXCLUDED.name,
             role = EXCLUDED.role,
             encrypted_password = EXCLUDED.encrypted_password,
             is_active = TRUE,
             status = 'active',
             updated_at = NOW()
       RETURNING id, uid`,
      [phone, name, role, staffHash]
    );

    const existingStaff = await client.query(
      `SELECT id FROM staff WHERE employee_id = $1 OR user_id = $2::uuid LIMIT 1`,
      [employeeId, user.rows[0].uid]
    );
    if (existingStaff.rowCount) {
      await client.query(
        `UPDATE staff
            SET user_id = $1::uuid,
                employee_id = $2,
                name = $3,
                designation = $4,
                position = $4,
                department = $5,
                shift = 'DAY',
                salary = 75000,
                is_active = TRUE,
                updated_at = NOW()
          WHERE id = $6`,
        [user.rows[0].uid, employeeId, name, position, department, existingStaff.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO staff
           (user_id, employee_id, name, designation, position, department, shift, salary, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $4, $5, 'DAY', 75000, TRUE, NOW())`,
        [user.rows[0].uid, employeeId, name, position, department]
      );
    }
  }

  const patients = [
    ['+918888880001', 'Seed Patient Asha Rao', 'Female', 'O+'],
    ['+918888880002', 'Seed Patient Bala Menon', 'Male', 'A+'],
    ['+918888880003', 'Seed Patient Chitra Devi', 'Female', 'B+'],
    ['+918888880004', 'Seed Patient Dev Kumar', 'Male', 'AB+'],
    ['+918888880005', 'Seed Patient Esha Nair', 'Female', 'O-'],
  ];

  for (const [phone, name, gender, bloodGroup] of patients) {
    await client.query(
      `INSERT INTO users
         (phone, name, gender, email, role, is_active, status, blood_group, allergies, medical_history,
          profile_completed_at, updated_at)
       VALUES ($1, $2, $3, $4, 'PATIENT', TRUE, 'active', $5, 'Penicillin', 'Hypertension',
               NOW(), NOW())
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET name = EXCLUDED.name,
             role = 'PATIENT',
             is_active = TRUE,
             status = 'active',
             blood_group = EXCLUDED.blood_group,
             profile_completed_at = NOW(),
             updated_at = NOW()`,
      [phone, name, gender, `${phone.slice(-4)}@patient.example.test`, bloodGroup]
    );
  }

  const refs = await getCoreRefs();

  await seedCurrentBedStructure(client);

  const firstWard = await first('wards', 'id, name, floor', 'LOWER(name) = LOWER($1)', ['A Block - Floor III']);
  const firstBed = await first('beds', 'id', 'LOWER(bed_number) = LOWER($1)', ['A-303']);
  if (firstWard && firstBed) {
    await client.query(
      `UPDATE beds
          SET status = 'occupied',
              patient_id = $1,
              patient_uid = $2::uuid,
              patient_name = $3,
              admitted_at = COALESCE(admitted_at, NOW()),
              assigned_at = COALESCE(assigned_at, NOW()),
              ward_id = $4,
              ward_name = $5,
              floor = $6,
              notes = COALESCE(notes, 'Seed occupied bed'),
              updated_at = NOW()
        WHERE id = $7
          AND (patient_uid IS NULL OR patient_uid = $2::uuid)`,
      [refs.patient.id, refs.patient.uid, refs.patient.name, firstWard.id, firstWard.name, firstWard.floor, firstBed.id]
    );
  }

  const refreshed = await getCoreRefs();
  await insertIfEmpty('appointments', [
    {
      phone: refreshed.patient.phone,
      patient_id: refreshed.patient.id,
      doctor_id: refreshed.doctor.id,
      doctor_name: refreshed.doctor.name,
      patient_name: refreshed.patient.name,
      appointment_date: new Date(),
      appointment_time: '10:00',
      status: 'SCHEDULED',
      reason: 'Seed general medicine review',
      token_number: 'A001',
      department: 'General Medicine',
      updated_at: new Date(),
    },
    {
      phone: '+918888880002',
      patient_id: refreshed.secondPatient.id,
      doctor_id: refreshed.doctor.id,
      doctor_name: refreshed.doctor.name,
      patient_name: refreshed.secondPatient.name,
      appointment_date: new Date(),
      appointment_time: '10:30',
      status: 'CONFIRMED',
      reason: 'Seed follow-up',
      token_number: 'A002',
      department: 'Cardiology',
      updated_at: new Date(),
    },
  ]);

  const afterAppointment = await getCoreRefs();
  await insertIfEmpty('appointment_status_history', [{
    appointment_id: afterAppointment.appointmentId,
    from_status: 'REQUESTED',
    to_status: 'SCHEDULED',
    changed_by: afterAppointment.staff.userId,
    changed_by_role: 'SUPER_ADMIN',
    reason: 'Seed status transition',
  }]);

  await insertIfEmpty('medications', [
    {
      name: 'Paracetamol',
      generic_name: 'Paracetamol',
      brand: 'SeedMed',
      category: 'Analgesic',
      dosage: '500mg',
      form: 'tablet',
      price: 12,
      stock_quantity: 500,
      expiry_date: new Date('2027-05-04T00:00:00.000Z'),
      manufacturer: 'Seed Pharma',
      prescription_required: false,
      description: 'Seed medication',
      updated_at: new Date(),
    },
  ]);

  await insertIfEmpty('pharmacy_orders', [{
    phone: afterAppointment.patient.phone,
    patient_id: afterAppointment.patient.id,
    patient_name: afterAppointment.patient.name,
    patient_phone: afterAppointment.patient.phone,
    order_note: 'Seed medication order',
    medication: 'Paracetamol 500mg',
    status: 'PENDING',
    priority: 'NORMAL',
    total_amount: 120,
    items_list: JSON.stringify([{ name: 'Paracetamol', quantity: 10 }]),
    updated_at: new Date(),
  }]);

  await insertIfEmpty('investigations', [{
    phone: afterAppointment.patient.phone,
    patient_id: afterAppointment.patient.id,
    patient_uid: afterAppointment.patient.uid,
    test_name: 'Complete Blood Count',
    test_type: 'Pathology',
    investigation_type: 'LAB',
    status: 'REQUESTED',
    priority: 'NORMAL',
    requested_by: afterAppointment.doctor.uid,
    doctor_id: afterAppointment.doctor.id,
    test_code: 'CBC',
    type: 'LAB',
    normal_range: 'Standard',
    unit: 'cells/uL',
    cost: 450,
    updated_at: new Date(),
  }]);

  const afterInvestigation = await getCoreRefs();
  await insertIfEmpty('investigation_bookings', [{
    patient_id: afterInvestigation.patient.id,
    patient_name: afterInvestigation.patient.name,
    patient_phone: afterInvestigation.patient.phone,
    investigation_id: afterInvestigation.investigationId,
    test_name: 'Complete Blood Count',
    preferred_date: new Date(),
    preferred_time_slot: '09:00-10:00',
    estimated_cost: 450,
    final_cost: 450,
    status: 'BOOKED',
    updated_at: new Date(),
  }]);

  await insertIfEmpty('medical_records', [{
    patient_id: afterInvestigation.patient.uid,
    doctor_id: afterInvestigation.doctor.id,
    record_type: 'consultation',
    title: 'Seed consultation note',
    description: 'Stable vitals. Continue current medication.',
    diagnosis: 'Hypertension',
    treatment: 'Lifestyle advice and medication review',
    medications: JSON.stringify([{ name: 'Amlodipine', dose: '5mg' }]),
    lab_results: JSON.stringify([{ test: 'CBC', status: 'pending' }]),
    updated_at: new Date(),
  }]);

  await insertIfEmpty('patient_records', [{
    patient_id: afterInvestigation.patient.id,
    document_type: 'lab_report',
    title: 'Seed CBC report',
    file_key: 'seed/patient-records/cbc.pdf',
    file_name: 'cbc.pdf',
    file_size: 1024,
    file_mime: 'application/pdf',
    source_hospital: 'Venkataeswara Hospitals',
    record_date: new Date(),
    notes: 'Seed patient record',
  }]);

  await insertIfEmpty('health_records', [{
    phone: afterInvestigation.patient.phone,
    record_type: 'GENERAL',
    file_name: 'seed-health-record.pdf',
    file_type: 'application/pdf',
    file_key: 'seed/health-records/general.pdf',
    file_size: 1024,
    privacy_level: 'RESTRICTED',
    created_by: afterInvestigation.patient.uid,
    updated_at: new Date(),
  }]);

  await insertIfEmpty('admissions', [{
    patient_uid: afterInvestigation.patient.uid,
    status: 'admitted',
    allergies: ['Penicillin'],
    admitting_doctor: afterInvestigation.doctor.uid,
    attending_doctor: afterInvestigation.doctor.uid,
    department: 'General Medicine',
    ward: 'General Ward',
    bed_id: afterInvestigation.bedId,
    bed_number: 'GW-201',
    chief_complaint: 'Seed admission',
    admitting_diagnosis: 'Observation',
    admission_type: 'planned',
    priority: 'routine',
    admitted_at: new Date(),
    updated_at: new Date(),
  }]);

  const afterAdmission = await getCoreRefs();
  await insertIfEmpty('prescriptions', [{
    patient_uid: afterAdmission.patient.uid,
    medication_name: 'Paracetamol',
    dosage: '500mg',
    frequency: 'BD',
    status: 'active',
    duration_days: 3,
  }]);

  await insertIfEmpty('e_prescriptions', [{
    appointment_id: afterAdmission.appointmentId,
    patient_id: afterAdmission.patient.id,
    doctor_id: afterAdmission.doctor.id,
    patient_uid: afterAdmission.patient.uid,
    doctor_uid: afterAdmission.doctor.uid,
    medication_name: 'Paracetamol',
    diagnosis: 'Fever',
    clinical_notes: 'Seed e-prescription',
    medications: JSON.stringify([{ route: 'oral', dose: '500mg', frequency: 'BD' }]),
    created_by: afterAdmission.doctor.userId,
    updated_at: new Date(),
  }]);

  await insertIfEmpty('staff_attendance', [{
    staff_id: afterAdmission.staff.userId,
    staff_uid: afterAdmission.staff.uid,
    type: 'check_in',
    attendance_type: 'regular',
    attendance_status: 'present',
    check_in_time: new Date(),
    location: 'Main Campus',
    updated_at: new Date(),
  }]);

  await insertIfEmpty('leave_applications', [{
    staff_id: afterAdmission.staff.userId,
    leave_type: 'sick',
    start_date: new Date('2026-05-10T00:00:00.000Z'),
    end_date: new Date('2026-05-11T00:00:00.000Z'),
    days_taken: 2,
    reason: 'Seed leave request',
    status: 'pending',
    applied_by: afterAdmission.staff.uid,
  }]);

  await insertIfEmpty('replacement_requests', [{
    leave_request_id: await firstValue('leave_applications', 'id'),
    requester_id: afterAdmission.staff.userId,
    replacement_staff_id: afterAdmission.secondStaff.userId,
    dates: JSON.stringify(['2026-05-10', '2026-05-11']),
    status: 'pending',
    requester_message: 'Seed replacement request',
  }]);

  await insertIfEmpty('staff_messages', [{
    sender_uid: afterAdmission.staff.uid,
    recipient_uid: afterAdmission.secondStaff.uid,
    patient_uid: afterAdmission.patient.uid,
    subject: 'Seed handover',
    body: 'Seed staff message for desktop smoke testing.',
    priority: 'normal',
  }]);

  await seedCareTeam(afterAdmission);

  await insertIfEmpty('notifications', [{
    uid: afterAdmission.patient.uid,
    phone: afterAdmission.patient.phone,
    title: 'Seed notification',
    body: 'Your appointment is scheduled.',
    type: 'APPOINTMENT',
    priority: 'NORMAL',
    user_id: afterAdmission.patient.id,
    updated_at: new Date(),
  }]);
}

async function seedCareTeam(refs) {
  if (!refs.patient || !refs.staff) return;

  if ((await tableCount('care_teams')) === 0) {
    await insert('care_teams', {
      tenant_id: refs.tenantId,
      patient_uid: refs.patient.uid,
      admission_id: refs.admissionId,
      team_kind: 'ip',
      display_name: 'Seed IP care team',
      primary_department: 'General Medicine',
      status: 'active',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
      updated_by: refs.staff.uid,
      updated_at: new Date(),
    });
  }

  if ((await tableCount('care_team_members')) > 0) return;

  const team = await first('care_teams', 'id, patient_uid', 'TRUE', []);
  if (!team) return;

  await insert('care_team_members', {
    tenant_id: refs.tenantId,
    care_team_id: team.id,
    patient_uid: team.patient_uid,
    staff_uid: refs.staff.uid,
    staff_id: refs.staff.staffId,
    staff_role: 'NURSING_STAFF',
    member_name: refs.staff.employeeId || 'Seed staff',
    relationship_kind: 'nurse',
    access_scope: JSON.stringify({ ip: true, vitals: true, notes: true }),
    break_glass_allowed: false,
    status: 'active',
    notes: 'Seed care-team member for patient-access coverage',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    created_by: refs.staff.uid,
    updated_by: refs.staff.uid,
    updated_at: new Date(),
  });
}

async function getCoreRefs() {
  const patient = await first('users', 'id, uid, phone, name', "role = 'PATIENT'", []);
  const secondPatient = await first('users', 'id, uid, phone, name', "role = 'PATIENT' AND phone <> $1", [patient?.phone || '']);
  const doctor = await client.query(`
    SELECT d.id, d.user_id, d.name, u.uid
      FROM doctors d
      JOIN users u ON u.id = d.user_id
     ORDER BY d.id
     LIMIT 1
  `);
  const staff = await client.query(`
    SELECT s.id AS staff_id, u.id AS user_id, u.uid, s.employee_id
      FROM staff s
      JOIN users u ON u.uid = s.user_id
     ORDER BY s.id
     LIMIT 1
  `);
  const secondStaff = await client.query(`
    SELECT s.id AS staff_id, u.id AS user_id, u.uid, s.employee_id
      FROM staff s
      JOIN users u ON u.uid = s.user_id
     ORDER BY s.id
     OFFSET 1
     LIMIT 1
  `);
  const doctorRow = doctor.rows[0];
  const staffRow = staff.rows[0];
  const secondStaffRow = secondStaff.rows[0] || staffRow;

  return {
    tenantId: DEFAULT_TENANT_ID,
    generatedUuid: '11111111-1111-4111-8111-111111111111',
    patient,
    secondPatient: secondPatient || patient,
    doctor: doctorRow ? {
      id: doctorRow.id,
      userId: doctorRow.user_id,
      uid: doctorRow.uid,
      name: doctorRow.name,
    } : null,
    staff: staffRow ? {
      staffId: staffRow.staff_id,
      userId: staffRow.user_id,
      uid: staffRow.uid,
      employeeId: staffRow.employee_id,
    } : null,
    secondStaff: secondStaffRow ? {
      staffId: secondStaffRow.staff_id,
      userId: secondStaffRow.user_id,
      uid: secondStaffRow.uid,
      employeeId: secondStaffRow.employee_id,
    } : null,
    departmentId: await firstValue('departments', 'id'),
    wardId: await firstValue('wards', 'id'),
    bedId: await firstValue('beds', 'id'),
    appointmentId: await firstValue('appointments', 'id'),
    admissionId: await firstValue('admissions', 'id'),
    pharmacyOrderId: await firstValue('pharmacy_orders', 'id'),
    investigationId: await firstValue('investigations', 'id'),
    invoiceId: await firstValue('invoices', 'id'),
    otScheduleId: await firstValue('ot_schedules', 'id'),
    carePlanId: await firstValue('care_plans', 'id'),
    chatSessionId: await firstValue('chat_sessions', 'id'),
    taskId: await firstValue('tasks', 'id'),
    apiClientId: await firstValue('api_clients', 'id'),
    kgNodeId: await firstValue('clinical_ai_kg_nodes', 'id'),
  };
}

async function seedRemainingTables() {
  const metadata = await getMetadata();
  const tables = [...metadata.columnsByTable.keys()]
    .filter((table) => !table.startsWith('_') && !MANUAL_SEED_TABLES.has(table))
    .sort();
  const seeded = [];
  const failed = new Map();

  for (let pass = 0; pass < 6; pass += 1) {
    let progress = 0;
    const ctx = await getCoreRefs();
    for (const table of tables) {
      if (await tableCount(table)) continue;
      try {
        const row = await rowForTable(table, metadata.columnsByTable.get(table), metadata, ctx, seeded.length + 1);
        const error = await tryInsertSeedRow(table, row, `${pass}_${table}`);
        if (error) throw error;
        seeded.push(table);
        failed.delete(table);
        progress += 1;
      } catch (error) {
        failed.set(table, error.message);
      }
    }
    if (progress === 0) break;
  }

  const stillEmpty = [];
  for (const table of tables) {
    if ((await tableCount(table)) === 0) stillEmpty.push(table);
  }

  if (stillEmpty.length) {
    await client.query('SET session_replication_role = replica');
    const ctx = await getCoreRefs();
    try {
      for (const table of stillEmpty) {
        try {
          const row = await rowForTable(
            table,
            metadata.columnsByTable.get(table),
            metadata,
            ctx,
            seeded.length + 1,
            true
          );
          const error = await tryInsertSeedRow(table, row, `relaxed_${table}`);
          if (error) throw error;
          seeded.push(table);
          failed.delete(table);
        } catch (error) {
          failed.set(table, error.message);
        }
      }
    } finally {
      await client.query('SET session_replication_role = DEFAULT');
    }
  }

  return { seeded, failed };
}

async function summarize(failed) {
  const counts = await client.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `);

  let nonEmpty = 0;
  const empty = [];
  for (const { table_name: table } of counts.rows) {
    if (table.startsWith('_')) continue;
    if (await tableCount(table)) nonEmpty += 1;
    else empty.push(table);
  }

  const domainCounts = {};
  for (const table of [
    'users',
    'staff',
    'admins',
    'appointments',
    'admissions',
    'beds',
    'investigations',
    'investigation_bookings',
    'pharmacy_orders',
    'medical_records',
    'patient_records',
    'notifications',
  ]) {
    if (await columnExists(table, 'id')) domainCounts[table] = await tableCount(table);
  }

  return {
    totalAppTables: counts.rows.filter((row) => !row.table_name.startsWith('_')).length,
    nonEmptyAppTables: nonEmpty,
    emptyAppTables: empty,
    failed: [...failed.entries()].map(([table, error]) => ({ table, error })),
    domainCounts,
    credentials: {
      staff: 'EMP-1001..EMP-1008 / test1234',
      admin: `admin / ${ADMIN_PASSWORD === STAFF_PASSWORD ? 'test1234' : '<VH_TEST_ADMIN_PASSWORD>'}`,
    },
  };
}

// Explicit seed for insurance_claim_caps. The auto-seeder in
// seedRemainingTables can't navigate the CHECK constraint added by
// migration 197 — the constraint requires exactly one of claim_id /
// tpa_claim_id to be set, but rowForTable either sets both (violating
// the XOR check) or neither (violating the "at least one" half). Pick
// any existing insurance_claims.id from the auto-seeded rows and bind
// a single cap row to it so the seeded.table.coverage contract passes.
async function seedInsuranceClaimCaps() {
  if (await tableCount('insurance_claim_caps')) return;

  // Prefer linking to a legacy insurance_claims row; fall back to
  // tpa_claims if the legacy side is somehow empty. Both should be
  // auto-seeded by this point.
  const legacyClaim = await first('insurance_claims', 'id', 'TRUE', []);
  const tpaClaim = legacyClaim ? null : await first('tpa_claims', 'id', 'TRUE', []);
  if (!legacyClaim && !tpaClaim) return; // can't seed without a parent

  const staffUid = await firstValue('users', 'uid') || DEFAULT_TENANT_ID;
  // insurance_claim_caps has no tenant_id column — its tenant scope is
  // inherited through the parent claim row (insurance_claims has no
  // tenant_id either, tpa_claims has tenant_id). Columns: claim_id /
  // tpa_claim_id (XOR), category, max_amount, currency, source, notes,
  // created_by (uuid required), created_at, updated_at.
  const baseRow = {
    category: 'room_rent',
    max_amount: 3500,
    currency: 'INR',
    source: 'tpa_preauth',
    notes: 'Seed cap for QA coverage',
    created_by: staffUid,
  };

  await insertIfEmpty('insurance_claim_caps', [
    legacyClaim
      ? { ...baseRow, claim_id: legacyClaim.id }
      : { ...baseRow, tpa_claim_id: tpaClaim.id },
  ]);
}

// Explicit seed for the double-entry ledger (migrations 343/344). The
// auto-seeder is excluded from ledger_entries/ledger_postings (see
// MANUAL_SEED_TABLES) because it would insert a single unbalanced posting,
// and ledger_postings_balanced (DEFERRABLE INITIALLY DEFERRED) rejects any
// entry whose postings don't sum to 0 at COMMIT. Insert one balanced journal
// entry — two equal-and-opposite postings — so the seeded.table.coverage
// contract sees a row in both tables. tenant_id defaults to the literal
// default tenant on every ledger row (GUC unset during seeding).
async function seedLedgerEntries() {
  if (await tableCount('ledger_entries')) return;

  // Any ledger account works — the balance invariant is about the entry's
  // posting sum, not which accounts are touched. Reuse an auto-seeded
  // ledger_accounts row, or create a minimal one if none exists yet.
  let account = await first('ledger_accounts', 'id');
  if (!account) {
    const created = await client.query(
      `INSERT INTO ledger_accounts (code, type, description)
       VALUES ('SEED-COVERAGE', 'ASSET', 'Seed account for QA coverage')
       RETURNING id`,
    );
    account = created.rows[0];
  }

  const entry = await client.query(
    `INSERT INTO ledger_entries (entry_type, idempotency_key, metadata)
     VALUES ('SEED_COVERAGE', 'seed-coverage-balanced-1', '{}'::jsonb)
     RETURNING id`,
  );
  const entryId = entry.rows[0].id;

  // Two postings netting to zero — satisfies ledger_assert_entry_balanced
  // at COMMIT. Inserted in one statement; the deferred trigger checks the
  // entry total once the transaction commits.
  await client.query(
    `INSERT INTO ledger_postings (entry_id, account_id, amount_paise)
     VALUES ($1, $2, $3), ($1, $2, $4)`,
    [entryId, account.id, 100000, -100000],
  );
}

async function seedIdentityProviderTables() {
  let provider = await first(
    'tenant_identity_providers',
    'id',
    "tenant_id = $1::uuid AND realm = 'admin' AND protocol = 'oidc'",
    [DEFAULT_TENANT_ID],
  );

  if (!provider) {
    const created = await client.query(
      `INSERT INTO tenant_identity_providers (
         tenant_id, realm, protocol, provider_key, display_name, status
       )
       VALUES ($1::uuid, 'admin', 'oidc', 'seed-oidc', 'Seed admin OIDC', 'draft')
       RETURNING id`,
      [DEFAULT_TENANT_ID],
    );
    provider = created.rows[0];
  }

  await insertIfEmpty('tenant_idp_role_mappings', [{
    tenant_id: DEFAULT_TENANT_ID,
    provider_id: provider.id,
    realm: 'admin',
    idp_group: 'seed-admins',
    vh_role: 'ADMIN',
    status: 'active',
    priority: 100,
  }]);
}

// Explicit seeds for the Pillar-D workflow tables (migrations 285/290/292).
// The auto-seeder can't navigate their domain CHECK constraints — provider
// availability and resource bookings require ordered time windows
// (end > start), chemo_protocol_drugs requires the mg/m²-XOR-fixed dosing
// shape, chemo_cycles hangs off a treatment plan with real weight/BSA
// numbers, and dental findings must carry a valid FDI tooth code. These
// CHECKs failing the generic engine is the constraints working as designed;
// constraint-aware rows here keep the seeded.table.coverage contract
// meaningful instead of weakening it. (This was the Forgejo `backend` stage
// failure from the pillar-C/D merges onward — the guardrail flow is the
// only place the comprehensive seeder runs.)
async function seedPillarDWorkflowTables() {
  const doctor = await first('doctors', 'id');
  if (doctor) {
    await insertIfEmpty('provider_availability_templates', [{
      doctor_id: doctor.id,
      weekday: 1,
      start_time: '09:00:00',
      end_time: '13:00:00',
      slot_minutes: 15,
      location: 'OPD-1 (seed)',
    }]);
  }

  const resource = await first('bookable_resources', 'id');
  if (resource) {
    await insertIfEmpty('resource_bookings', [{
      resource_id: resource.id,
      starts_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ends_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      booked_for_type: 'other',
      status: 'booked',
      notes: 'Seed booking for QA coverage',
    }]);
  }

  const protocol = await first('chemo_protocols', 'id');
  if (protocol) {
    await insertIfEmpty('chemo_protocol_drugs', [{
      protocol_id: protocol.id,
      drug_name: 'Doxorubicin (seed)',
      dose_per_m2: 60, // XOR dosing: fixed_dose deliberately NULL
      dose_unit: 'mg',
      route: 'IV',
      infusion_duration_min: 30,
      is_vesicant: true,
      max_lifetime_dose_per_m2: 450,
      sequence: 1,
      notes: 'Seed protocol drug for QA coverage',
    }]);
  }

  const plan = await first('chemo_treatment_plans', 'id');
  if (plan) {
    await insertIfEmpty('chemo_cycles', [{
      plan_id: plan.id,
      cycle_number: 1,
      scheduled_date: new Date().toISOString().slice(0, 10),
      status: 'scheduled',
      weight_kg: 70.0,
      bsa_m2: 1.84,
      notes: 'Seed cycle for QA coverage',
    }]);
  }

  const patientUid = await firstValue('users', 'uid');
  if (patientUid) {
    await insertIfEmpty('dental_tooth_findings', [{
      patient_uid: patientUid,
      tooth_fdi: '16',
      surface: 'occlusal',
      finding: 'caries',
      status: 'active',
      notes: 'Seed finding for QA coverage',
    }]);
  }
}

async function seedRadiologyPeerReviews() {
  if (await tableCount('radiology_peer_reviews')) return;

  const refs = await getCoreRefs();
  const fallbackAuthorUid = refs.doctor?.uid || refs.staff?.uid;
  if (!refs.patient?.uid || !fallbackAuthorUid) return;

  let order = await first(
    'radiology_orders',
    'id, tenant_id, ordered_by, radiologist, report_signed_off_by',
    'TRUE',
    [],
  );

  if (!order) {
    const created = await client.query(
      `INSERT INTO radiology_orders (
         tenant_id, patient_uid, modality, body_part, clinical_indication,
         priority, status, ordered_by, radiologist, report, report_completed_at,
         report_signed_off_at, report_signed_off_by, structured_report
       )
       VALUES (
         $1::uuid, $2::uuid, 'xray', 'chest', 'Seed chest radiograph review',
         'routine', 'signed_off', $3::uuid, $4::uuid,
         'Findings: No acute cardiopulmonary abnormality.\n\nImpression: No acute abnormality.',
         NOW() - INTERVAL '20 minutes', NOW(), $4::uuid,
         '{"sections":{"findings":"No acute cardiopulmonary abnormality.","impression":"No acute abnormality."}}'::jsonb
       )
       RETURNING id, tenant_id, ordered_by, radiologist, report_signed_off_by`,
      [DEFAULT_TENANT_ID, refs.patient.uid, refs.staff?.uid || fallbackAuthorUid, fallbackAuthorUid],
    );
    order = created.rows[0];
  }

  const reportAuthorUid = order.report_signed_off_by || order.radiologist || fallbackAuthorUid;
  const reviewerUid = [
    refs.secondStaff?.uid,
    refs.staff?.uid,
    refs.doctor?.uid,
    refs.generatedUuid,
  ].find((uid) => uid && uid !== reportAuthorUid);

  if (!reviewerUid) return;

  await insertIfEmpty('radiology_peer_reviews', [{
    tenant_id: order.tenant_id || DEFAULT_TENANT_ID,
    radiology_order_id: order.id,
    reviewer_uid: reviewerUid,
    report_author_uid: reportAuthorUid,
    discrepancy_score: 1,
    outcome: 'no_change',
    comments: 'Seed peer review for QA coverage',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

try {
  await client.query('BEGIN');
  await seedCoreData();
  await seedIdentityProviderTables();
  const { seeded, failed } = await seedRemainingTables();
  await seedInsuranceClaimCaps();
  await seedLedgerEntries();
  await seedPillarDWorkflowTables();
  await seedRadiologyPeerReviews();
  await client.query('COMMIT');
  const summary = await summarize(failed);
  console.log(JSON.stringify({ ...summary, newlySeededTables: seeded.length }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
