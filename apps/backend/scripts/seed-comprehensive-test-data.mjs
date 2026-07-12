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
  // satisfy (ordered time windows, slot holds, XOR dosing, FDI tooth
  // codes, plan-anchored cycles). Seeded by seedPillarDWorkflowTables below.
  'provider_availability_templates',
  'appointment_slot_holds',
  'resource_bookings',
  // NL13-P1f: the link row must reference the REAL seeded booking/room/case —
  // resource_bookings itself is manually seeded AFTER the generic walk, so the
  // generic pass would have no parent to point at. Seeded alongside it in
  // seedPillarDWorkflowTables below.
  'cath_case_schedule_links',
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
  // N6-2 donor intake: volume_ml BETWEEN 100 AND 650 and sha256_hash
  // ~ '^[0-9a-f]{64}$' CHECKs reject the generic seeder's values.
  'donation_events',
  'donor_consents',
  // NL-7 P3 biomedical CMMS rows need a valid device -> schedule -> work-order
  // chain plus timestamp/check-constrained certificate data.
  'clinical_ai_biomed_devices',
  'biomed_maintenance_schedules',
  'biomed_work_orders',
  'biomed_work_order_updates',
  'biomed_work_order_recipients',
  'biomed_calibration_certificates',
  // NL-7 P2 cold-chain units need a fridge-sensor device and an ordered
  // min/max temperature range before child readings/excursions can seed.
  'cold_chain_units',
  // N6-12 mortuary slots enforce occupancy consistency: an available
  // slot cannot carry a current body reference.
  'mortuary_slots',
  // N6-10 infusion chair coverage needs an active chair plus an ordered,
  // cycle-date-aligned booking window.
  'infusion_chairs',
  'chair_bookings',
  // NL11-S1 migration toolkit: source_row_number is a plain INTEGER the
  // generic seeder fills with semantic strings, and content_sha256/row_hash
  // carry 64-lowercase-hex CHECKs. NL11-S9 adds HL7 ADT hash + enum checks
  // that also need constraint-aware values.
  'migration_source_files',
  'migration_import_records',
  'migration_hl7_adt_batches',
  'migration_hl7_adt_messages',
  // NL12-S2 SIEM: transport/severity/source enums + CHAR(64) hex hashes +
  // a redaction CHECK that forbids raw_payload_exported=true.
  'siem_export_targets',
  'siem_export_events',
  'siem_export_delivery_attempts',
  // NL-14 ICU chart depth rows have clinical review/provenance gates and
  // exact-one-source links that the generic foreign-key seeder cannot infer.
  'icu_device_observation_links',
  'icu_scoring_outputs',
  'icu_weaning_trials',
  // NL-13 P5 perfusion sign-offs require reviewer/timestamp pairs; a minimal
  // draft row must be linked to the generated perfusion record explicitly.
  'perfusion_signoffs',
  // NL-13 P6 transplant suite: organ enums, non-empty organ arrays, and
  // clinical chain FKs need a coherent program -> candidate -> review seed.
  'transplant_program_settings',
  'transplant_programs',
  'transplant_candidates',
  'transplant_waitlist_status_history',
  'transplant_donor_referrals',
  'transplant_match_reviews',
  'transplant_committee_reviews',
  'transplant_immunosuppression_plans',
  'transplant_notto_exports',
  // NL-14 ED evidence requires exactly one source pointer; seed below.
  'ed_encounter_evidence',
  // NL-14 P2 resuscitation rows carry status/finalize/content CHECK gates,
  // an append-only trigger, and MAR/device link invariants the generic
  // seeder cannot satisfy.
  'resuscitation_settings',
  'resuscitation_events',
  'resuscitation_event_timeline',
  'resuscitation_team_roles',
  'resuscitation_medication_links',
  'resuscitation_device_links',
  'resuscitation_qa_reviews',
  // NL-14 P3 NICU/PICU rows carry per-kind payload CHECKs (typed feed/
  // fluid/jaundice events) and an owner-approval reference gate on score
  // outputs that the generic seeder cannot satisfy.
  'nicu_feed_fluid_entries',
  'nicu_jaundice_phototherapy_events',
  'nicu_picu_scoring_outputs',
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

async function tableExists(table) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
      LIMIT 1`,
    [table]
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
  const textTypes = new Set(['bpchar', 'char', 'name', 'text', 'varchar']);
  if (!textTypes.has(column.udt_name)) return null;

  const definitions = checksByTable.get(table) || [];
  const lowerColumn = column.column_name.toLowerCase();
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

  if (table === 'ophthalmic_biometry' && name === 'axial_length_mm') return 23.5;

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
  if (name.includes('number') && ['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money'].includes(column.udt_name)) return 1;
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
  if (/(^|_)(lat|latitude)($|_)/.test(name)) return 13.02936;
  if (/(^|_)(lng|lon|longitude)($|_)/.test(name)) return 80.24409;
  if (name === 'volume_ml') return 450;
  if (name.includes('amount') || name.includes('cost') || name.includes('rate') || name.includes('score')) return 1;
  if (name.includes('count') || name.includes('total') || name.includes('units') || name.includes('minutes')) return 1;

  return undefined;
}

// Constraint-aware per-table overrides for columns the generic heuristics
// cannot satisfy: conditional CHECKs that tie one column's validity to
// another column's value. rowForTable also consults this map so a NULLABLE
// override column is still filled (the generic walk skips nullable non-FK
// columns). Keep entries minimal and tied to the migration that needs them.
const TABLE_COLUMN_SEED_OVERRIDES = {
  // mig 562: started_at/due_at became nullable, but NULL is legal only for
  // stemi-sourced rows carrying explicit *_pending metadata — the generic
  // row must supply both clocks or every SLA-linked dependent cascades.
  workflow_sla_instances: {
    started_at: () => new Date('2026-05-04T09:00:00.000Z'),
    due_at: () => new Date('2026-05-04T10:00:00.000Z'),
  },
  // mig 558: stemi_activations_door_clock requires door_time_at unless the
  // activation is a prehospital handover; pick the source whose branch the
  // generic row satisfies without coordinating three clock columns.
  stemi_activations: {
    activation_source: 'prehospital_handover',
  },
  // migs 563-565: keep the generic cath usage row on the non-batch,
  // non-implant branch while satisfying its tenant-composite references.
  cath_consumable_catalog: {
    tenant_id: (ctx) => ctx.tenantId,
    inventory_item_id: async () => firstValue('pharmacy_inventory_items', 'id'),
  },
  cath_case_consumable_usage: {
    tenant_id: (ctx) => ctx.tenantId,
    case_id: async () => firstValue('cath_lab_cases', 'id'),
    procedure_log_id: null,
    catalog_item_id: async () => firstValue('cath_consumable_catalog', 'id'),
    patient_uid: async () => firstValue('cath_lab_cases', 'patient_uid'),
    inventory_batch_id: null,
    batch_tracked: false,
    is_implant: false,
    inventory_movement_id: null,
    timeline_event_id: null,
    audit_event_id: null,
  },
  surgical_implants: {
    tenant_id: (ctx) => ctx.tenantId,
    cath_case_id: null,
    cath_usage_id: null,
  },
};

function seedOverrideFor(table, columnName) {
  return TABLE_COLUMN_SEED_OVERRIDES[table]?.[columnName];
}

function primitiveValue(column, table, index, ctx, checksByTable) {
  const override = seedOverrideFor(table, column.column_name);
  if (override !== undefined) {
    const value = typeof override === 'function' ? override() : override;
    return typeof value === 'string' ? clip(value, column.character_maximum_length) : value;
  }

  const checked = checkedValue(checksByTable, table, column);
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

    const tableOverrides = TABLE_COLUMN_SEED_OVERRIDES[table];
    if (tableOverrides && Object.hasOwn(tableOverrides, column.column_name)) {
      const override = tableOverrides[column.column_name];
      row[column.column_name] = typeof override === 'function'
        ? await override(ctx)
        : override;
      continue;
    }

    const required = column.is_nullable === 'NO' && !hasDefault;
    const fk = metadata.fkByTableColumn.get(`${table}.${column.column_name}`);
    const hasOverride = seedOverrideFor(table, column.column_name) !== undefined;
    if (!required && !fk && !hasOverride) continue;

    if (fk) {
      row[column.column_name] = await fkValue(fk, ctx);
      continue;
    }

    if (required || relaxed || hasOverride) {
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

  const refs = await getCoreRefs();
  if (doctor && refs.patient?.uid) {
    await insertIfEmpty('appointment_slot_holds', [{
      tenant_id: DEFAULT_TENANT_ID,
      doctor_id: doctor.id,
      appointment_date: new Date().toISOString().slice(0, 10),
      slot_start: '09:00:00',
      slot_end: '09:15:00',
      source_channel: 'staff',
      idempotency_key: 'seed-slot-hold-0001',
      held_by_uid: refs.staff?.uid,
      held_by_role: 'RECEPTIONIST',
      patient_uid: refs.patient.uid,
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
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

  // NL13-P1f: cath case ↔ booking link needs the real seeded parents (the
  // partial unique indexes allow exactly one active link per case/booking).
  const cathCase = await first('cath_lab_cases', 'id');
  const booking = await first('resource_bookings', 'id, resource_id');
  if (cathCase && booking?.resource_id) {
    await insertIfEmpty('cath_case_schedule_links', [{
      tenant_id: DEFAULT_TENANT_ID,
      case_id: cathCase.id,
      resource_booking_id: booking.id,
      resource_id: booking.resource_id,
      status: 'active',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
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

async function seedDonorIntakeTables() {
  // N6-2: constraint-aware seeds — the generic seeder cannot satisfy
  // chk_donation_events_volume (100..650) or chk_donor_consents_hash
  // (64 lowercase hex). Mirrors the radiology_peer_reviews precedent.
  const donor = await first('donors', 'id, tenant_id', 'TRUE', []);
  if (!donor) return;

  if (!(await tableCount('donation_events'))) {
    await insertIfEmpty('donation_events', [{
      tenant_id: donor.tenant_id || DEFAULT_TENANT_ID,
      donor_id: donor.id,
      donation_code: 'DON-SEED-0001',
      donation_barcode: 'DONBAR-SEED-0001',
      collection_kind: 'in_house',
      volume_ml: 450,
      status: 'collected',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (!(await tableCount('donor_consents'))) {
    await insertIfEmpty('donor_consents', [{
      tenant_id: donor.tenant_id || DEFAULT_TENANT_ID,
      donor_id: donor.id,
      consent_type: 'blood_donation',
      consent_version: 1,
      consent_statement: 'Seed donor consent for QA coverage.',
      consent_payload: JSON.stringify({ seed: true }),
      sha256_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }
}

async function seedBiomedCmmsTables() {
  let device = await first('clinical_ai_biomed_devices', 'id, tenant_id', 'TRUE', []);
  if (!device) {
    const created = await client.query(
      `INSERT INTO clinical_ai_biomed_devices (
         tenant_id, device_code, device_type, manufacturer, model, serial_number,
         location, installed_at, usage_hours, fault_events_last_90d, status, metadata
       )
       VALUES (
         $1::uuid, 'BIO-SEED-0001', 'ventilator', 'Seed Biomedical', 'Ventilator QA',
         'BIO-SEED-SN-0001', 'ICU seed bay', CURRENT_DATE - INTERVAL '180 days',
         1200, 0, 'in_service', '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, tenant_id`,
      [DEFAULT_TENANT_ID],
    );
    device = created.rows[0];
  }

  const staffUser = await first('users', 'id, uid', 'role <> $1', ['PATIENT']);
  if (!staffUser) return;

  let schedule = await first('biomed_maintenance_schedules', 'id, tenant_id', 'TRUE', []);
  if (!schedule) {
    const created = await client.query(
      `INSERT INTO biomed_maintenance_schedules (
         tenant_id, biomed_device_id, kind, interval_days, next_due_at,
         assigned_role, assigned_to_id, assigned_to_uid, created_by, metadata
       )
       VALUES (
         $1::uuid, $2, 'preventive', 90, NOW() + INTERVAL '30 days',
         'BIOMEDICAL_STAFF', $3, $4::uuid, $4::uuid,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, tenant_id`,
      [device.tenant_id || DEFAULT_TENANT_ID, device.id, staffUser.id, staffUser.uid],
    );
    schedule = created.rows[0];
  }

  let workOrder = await first('biomed_work_orders', 'id, tenant_id', 'TRUE', []);
  if (!workOrder) {
    const created = await client.query(
      `INSERT INTO biomed_work_orders (
         tenant_id, biomed_device_id, schedule_id, kind, priority, status,
         description, assigned_to_id, assigned_to_uid, assigned_to_role,
         assigned_by, assigned_at, sla_due_at, source, due_window_start,
         due_window_end, created_by, metadata
       )
       VALUES (
         $1::uuid, $2, $3, 'preventive', 'normal', 'assigned',
         'Seed preventive maintenance work order for QA coverage.',
         $4, $5::uuid, 'BIOMEDICAL_STAFF', $5::uuid, NOW(),
         NOW() + INTERVAL '72 hours', 'schedule', NOW() + INTERVAL '30 days',
         NOW() + INTERVAL '31 days', $5::uuid,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, tenant_id`,
      [schedule.tenant_id || device.tenant_id || DEFAULT_TENANT_ID, device.id, schedule.id, staffUser.id, staffUser.uid],
    );
    workOrder = created.rows[0];
  }

  await client.query(
    `UPDATE biomed_maintenance_schedules
        SET last_work_order_id = $1,
            updated_at = NOW()
      WHERE id = $2
        AND last_work_order_id IS NULL`,
    [workOrder.id, schedule.id],
  );

  await insertIfEmpty('biomed_work_order_recipients', [{
    tenant_id: workOrder.tenant_id || DEFAULT_TENANT_ID,
    work_order_id: workOrder.id,
    staff_id: staffUser.id,
    staff_uid: staffUser.uid,
    recipient_kind: 'assignee',
    source: 'seed',
  }]);

  await insertIfEmpty('biomed_work_order_updates', [{
    tenant_id: workOrder.tenant_id || DEFAULT_TENANT_ID,
    work_order_id: workOrder.id,
    previous_status: 'open',
    status: 'assigned',
    message: 'Seed work-order update for QA coverage.',
    author_id: staffUser.id,
    author_uid: staffUser.uid,
    author_role: 'BIOMEDICAL_STAFF',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);

  await insertIfEmpty('biomed_calibration_certificates', [{
    tenant_id: workOrder.tenant_id || DEFAULT_TENANT_ID,
    biomed_device_id: device.id,
    work_order_id: workOrder.id,
    certificate_number: 'BIO-CERT-SEED-0001',
    calibrated_at: new Date('2026-05-04T09:00:00.000Z'),
    due_at: new Date('2027-05-04T09:00:00.000Z'),
    performed_by: 'Seed Biomedical Engineer',
    performed_by_uid: staffUser.uid,
    document_id: 'seed-biomed-calibration-document',
    document_storage_key: 'seed/biomed/calibration/BIO-CERT-SEED-0001.pdf',
    document_mime_type: 'application/pdf',
    result: 'pass',
    notes: 'Seed calibration certificate for QA coverage.',
    created_by: staffUser.uid,
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedColdChainTables() {
  let device = await first(
    'device_registry',
    'id',
    'tenant_id = $1 AND kind = $2',
    [DEFAULT_TENANT_ID, 'fridge_sensor']
  );

  if (!device) {
    await insert('device_registry', {
      tenant_id: DEFAULT_TENANT_ID,
      device_code: 'SEED-COLD-FRIDGE-01',
      display_name: 'Seed cold-chain fridge sensor',
      kind: 'fridge_sensor',
      protocol: 'http-json',
      vendor: 'Seed',
      model: 'ColdChain',
      serial_number: 'SEED-COLD-FRIDGE-01',
      status: 'active',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    });
    device = await first(
      'device_registry',
      'id',
      'tenant_id = $1 AND kind = $2',
      [DEFAULT_TENANT_ID, 'fridge_sensor']
    );
  }

  if (!device) return;

  await insertIfEmpty('cold_chain_units', [{
    tenant_id: DEFAULT_TENANT_ID,
    unit_code: 'SEED-COLD-FRIDGE-01',
    display_name: 'Seed cold-chain refrigerator',
    kind: 'fridge',
    department: 'pharmacy',
    device_registry_id: device.id,
    min_temp_c: 2,
    max_temp_c: 8,
    excursion_grace_minutes: 15,
    status: 'active',
    retention_days: 730,
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedMortuarySlots() {
  await insertIfEmpty('mortuary_slots', [{
    tenant_id: DEFAULT_TENANT_ID,
    slot_code: 'MORT-SEED-0001',
    display_name: 'Seed mortuary slot',
    status: 'available',
    notes: 'Seed slot for QA coverage',
  }]);
}

async function seedInfusionChairTables() {
  let chair = await first(
    'infusion_chairs',
    'id, tenant_id',
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );

  if (!chair) {
    const created = await client.query(
      `INSERT INTO infusion_chairs (
         tenant_id, unit_name, chair_code, display_name, status, location_note
       )
       VALUES (
         $1::uuid, 'Day Care', 'SEED-CHAIR-1', 'Seed Chair 1',
         'active', 'Seed chair for QA coverage'
       )
       ON CONFLICT (tenant_id, unit_name, chair_code)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         status = 'active',
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, tenant_id`,
      [DEFAULT_TENANT_ID],
    );
    chair = created.rows[0];
  }

  if (await tableCount('chair_bookings')) return;

  const cycleResult = await client.query(
    `SELECT c.id, c.tenant_id, c.scheduled_date, p.patient_uid
       FROM chemo_cycles c
       JOIN chemo_treatment_plans p ON p.id = c.plan_id
      ORDER BY c.id
      LIMIT 1`,
  );
  const cycle = cycleResult.rows[0];
  if (!chair || !cycle?.patient_uid) return;

  const scheduledDate =
    cycle.scheduled_date instanceof Date
      ? cycle.scheduled_date.toISOString().slice(0, 10)
      : String(cycle.scheduled_date).slice(0, 10);

  await insertIfEmpty('chair_bookings', [{
    tenant_id: cycle.tenant_id || chair.tenant_id || DEFAULT_TENANT_ID,
    chair_id: chair.id,
    cycle_id: cycle.id,
    patient_uid: cycle.patient_uid,
    start_at: `${scheduledDate}T09:00:00.000Z`,
    end_at: `${scheduledDate}T10:00:00.000Z`,
    status: 'booked',
    warning_codes: [],
    notes: 'Seed booking for QA coverage',
  }]);
}

async function seedMergedMainCoverageTables() {
  const hasBiomedCalibration = await tableExists('biomed_calibration_certificates');
  const hasBiomedMaintenance = await tableExists('biomed_maintenance_schedules');

  if ((hasBiomedCalibration || hasBiomedMaintenance) && await tableExists('clinical_ai_biomed_devices')) {
    const biomedDevice = await first(
      'clinical_ai_biomed_devices',
      'id, tenant_id',
      'tenant_id = $1::uuid',
      [DEFAULT_TENANT_ID],
    );

    if (biomedDevice && hasBiomedCalibration) {
      await insertIfEmpty('biomed_calibration_certificates', [{
        tenant_id: biomedDevice.tenant_id || DEFAULT_TENANT_ID,
        biomed_device_id: biomedDevice.id,
        certificate_number: 'CAL-SEED-0001',
        calibrated_at: new Date('2026-05-04T09:00:00.000Z'),
        due_at: new Date('2027-05-04T09:00:00.000Z'),
        performed_by: 'Seed biomedical engineer',
        document_id: 'DOC-SEED-CAL-0001',
        document_storage_key: 'seed/biomed/calibration/DOC-SEED-CAL-0001.pdf',
        document_mime_type: 'application/pdf',
        result: 'pass',
        notes: 'Seed calibration certificate for QA coverage',
        metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      }]);
    }

    if (biomedDevice && hasBiomedMaintenance) {
      await insertIfEmpty('biomed_maintenance_schedules', [{
        tenant_id: biomedDevice.tenant_id || DEFAULT_TENANT_ID,
        biomed_device_id: biomedDevice.id,
        kind: 'preventive',
        interval_days: 90,
        next_due_at: new Date('2026-08-04T09:00:00.000Z'),
        assigned_role: 'BIOMEDICAL_STAFF',
        active: true,
        metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      }]);
    }
  }

  if (await tableExists('cold_chain_units') && await tableExists('device_registry')) {
    const registeredDevice = await first(
      'device_registry',
      'id, tenant_id',
      'tenant_id = $1::uuid',
      [DEFAULT_TENANT_ID],
    );

    if (registeredDevice) {
      await insertIfEmpty('cold_chain_units', [{
        tenant_id: registeredDevice.tenant_id || DEFAULT_TENANT_ID,
        unit_code: 'CC-SEED-0001',
        display_name: 'Seed vaccine fridge',
        kind: 'fridge',
        department: 'pharmacy',
        device_registry_id: registeredDevice.id,
        min_temp_c: 2,
        max_temp_c: 8,
        excursion_grace_minutes: 15,
        alert_roles: ['PHARMACY_INCHARGE'],
        status: 'active',
        retention_days: 730,
        metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      }]);
    }
  }

  const hasMigrationSourceFiles = await tableExists('migration_source_files');
  const hasMigrationImportRecords = await tableExists('migration_import_records');

  if (!hasMigrationSourceFiles || !(await tableExists('migration_import_jobs'))) return;

  const importJob = await first(
    'migration_import_jobs',
    'id, tenant_id',
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );

  if (!importJob) return;

  if (hasMigrationSourceFiles) {
    await insertIfEmpty('migration_source_files', [{
      tenant_id: importJob.tenant_id || DEFAULT_TENANT_ID,
      job_id: importJob.id,
      file_kind: 'patient',
      source_filename: 'seed-patients.csv',
      content_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mime_type: 'text/csv',
      byte_size: 128,
      row_count: 1,
      header_row: JSON.stringify(['external_id', 'full_name']),
      column_profile: JSON.stringify({ external_id: 'text', full_name: 'text' }),
      sample_rows_redacted: JSON.stringify([{ external_id: 'SEED-1', full_name: 'Seed Patient' }]),
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (!hasMigrationImportRecords || !hasMigrationSourceFiles) return;

  const sourceFile = await first(
    'migration_source_files',
    'id, tenant_id, job_id',
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );

  if (!sourceFile) return;

  await insertIfEmpty('migration_import_records', [{
    tenant_id: sourceFile.tenant_id || DEFAULT_TENANT_ID,
    job_id: sourceFile.job_id || importJob.id,
    source_file_id: sourceFile.id,
    target_kind: 'patient',
    source_row_number: 1,
    source_key: 'SEED-1',
    row_hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    normalized_preview_redacted: JSON.stringify({ external_id: 'SEED-1' }),
    validation_state: 'valid',
    duplicate_candidate: false,
    duplicate_summary: JSON.stringify({}),
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedMigrationToolkitTables() {
  // NL11-S1/S9: constraint-aware seeds — generic values violate the 64-hex
  // sha256 CHECKs, ADT enum checks, and the INTEGER source_row_number column.
  const job = await first('migration_import_jobs', 'id, tenant_id', 'TRUE', []);
  if (!job) return;
  const hex64 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  const altHex64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  if (!(await tableCount('migration_source_files'))) {
    await insertIfEmpty('migration_source_files', [{
      tenant_id: job.tenant_id || DEFAULT_TENANT_ID,
      job_id: job.id,
      file_kind: 'patient',
      source_filename: 'seed-patients.csv',
      content_sha256: hex64,
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (!(await tableCount('migration_import_records'))) {
    const file = await first('migration_source_files', 'id, tenant_id, job_id', 'TRUE', []);
    if (!file) return;
    await insertIfEmpty('migration_import_records', [{
      tenant_id: file.tenant_id || DEFAULT_TENANT_ID,
      job_id: file.job_id,
      source_file_id: file.id,
      target_kind: 'patient',
      source_row_number: 1,
      row_hash: hex64,
    }]);
  }

  if ((await tableExists('migration_hl7_adt_batches')) && !(await tableCount('migration_hl7_adt_batches'))) {
    await insertIfEmpty('migration_hl7_adt_batches', [{
      tenant_id: job.tenant_id || DEFAULT_TENANT_ID,
      job_id: job.id,
      status: 'committed',
      source_filename: 'seed-adt-a01.hl7',
      content_sha256: altHex64,
      message_count: 1,
      accepted_count: 1,
      rejected_count: 0,
      idempotency_key: 'seed-hl7-adt-batch-1',
      summary: JSON.stringify({ seed: true, accepted: 1 }),
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if ((await tableExists('migration_hl7_adt_messages')) && !(await tableCount('migration_hl7_adt_messages'))) {
    const batch = await first('migration_hl7_adt_batches', 'id, tenant_id', 'TRUE', []);
    if (!batch) return;
    const commitBatch = await first('migration_commit_batches', 'id', 'TRUE', []);
    await insertIfEmpty('migration_hl7_adt_messages', [{
      tenant_id: batch.tenant_id || DEFAULT_TENANT_ID,
      hl7_batch_id: batch.id,
      commit_batch_id: commitBatch?.id,
      message_control_id: 'SEED-ADT-A01-1',
      message_type: 'ADT^A01',
      source_patient_key: 'SEED-1',
      raw_message_hash: hex64,
      parsed_summary_redacted: JSON.stringify({ messageType: 'ADT^A01', patientKey: 'SEED-1' }),
      validation_findings: JSON.stringify([]),
      status: 'committed',
    }]);
  }
}

async function seedSiemExportTables() {
  // NL12-S2: constraint-aware seeds (transport/severity/source enums,
  // CHAR(64) hex hashes, minimized_payload redaction invariant).
  const hex64 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  if (!(await tableCount('siem_export_targets'))) {
    await insertIfEmpty('siem_export_targets', [{
      tenant_id: DEFAULT_TENANT_ID,
      target_key: 'seed-siem-webhook',
      display_name: 'Seed SIEM webhook target',
      transport: 'webhook',
      status: 'draft',
      min_severity: 'high',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }
  const target = await first('siem_export_targets', 'id, tenant_id', 'TRUE', []);
  if (!target) return;
  if (!(await tableCount('siem_export_events'))) {
    await insertIfEmpty('siem_export_events', [{
      tenant_id: target.tenant_id || DEFAULT_TENANT_ID,
      source_name: 'synthetic',
      source_id: 'seed-event-1',
      event_type: 'seed.security.event',
      severity: 'high',
      payload_sha256: hex64,
      minimized_payload: JSON.stringify({ redaction: { raw_payload_exported: false }, seed: true }),
      synthetic: true,
    }]);
  }
  const event = await first('siem_export_events', 'id, tenant_id', 'TRUE', []);
  if (!event) return;
  if (!(await tableCount('siem_export_delivery_attempts'))) {
    await insertIfEmpty('siem_export_delivery_attempts', [{
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      event_id: event.id,
      target_id: target.id,
      transport: 'webhook',
      status: 'pending',
      payload_sha256: hex64,
      metadata: JSON.stringify({ seed: true }),
    }]);
  }
}

async function seedNicuPicuChartTables() {
  const hasFeedFluid = await tableExists('nicu_feed_fluid_entries');
  const hasJaundice = await tableExists('nicu_jaundice_phototherapy_events');
  const hasScoring = await tableExists('nicu_picu_scoring_outputs');
  if (!hasFeedFluid && !hasJaundice && !hasScoring) return;

  const refs = await getCoreRefs();
  const icuAdmission = await first(
    'icu_admissions',
    'id, tenant_id, admission_id, patient_uid',
    'TRUE',
    [],
  );
  const reviewerUid = refs.staff?.uid || refs.doctor?.uid;
  if (!icuAdmission?.id || !icuAdmission.patient_uid || !reviewerUid) return;
  const tenantId = icuAdmission.tenant_id || DEFAULT_TENANT_ID;
  const seedMeta = JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' });

  if (hasFeedFluid) {
    await insertIfEmpty('nicu_feed_fluid_entries', [
      {
        tenant_id: tenantId,
        icu_admission_id: icuAdmission.id,
        admission_id: icuAdmission.admission_id,
        patient_uid: icuAdmission.patient_uid,
        entry_kind: 'weight',
        recorded_at: new Date('2026-05-04T06:00:00.000Z'),
        weight_grams: 1500,
        recorded_by: reviewerUid,
        notes: 'Seed NICU weight-of-day anchor for QA coverage.',
        metadata: seedMeta,
      },
      {
        tenant_id: tenantId,
        icu_admission_id: icuAdmission.id,
        admission_id: icuAdmission.admission_id,
        patient_uid: icuAdmission.patient_uid,
        entry_kind: 'feed',
        recorded_at: new Date('2026-05-04T08:00:00.000Z'),
        feed_type: 'expressed_breast_milk',
        feed_route: 'og_tube',
        volume_ml: 30,
        duration_minutes: 20,
        recorded_by: reviewerUid,
        metadata: seedMeta,
      },
      {
        tenant_id: tenantId,
        icu_admission_id: icuAdmission.id,
        admission_id: icuAdmission.admission_id,
        patient_uid: icuAdmission.patient_uid,
        entry_kind: 'fluid_output',
        recorded_at: new Date('2026-05-04T09:00:00.000Z'),
        output_kind: 'urine',
        output_volume_ml: 12,
        diaper_weight_based: true,
        recorded_by: reviewerUid,
        metadata: seedMeta,
      },
    ]);
  }

  if (hasJaundice) {
    await insertIfEmpty('nicu_jaundice_phototherapy_events', [{
      tenant_id: tenantId,
      icu_admission_id: icuAdmission.id,
      patient_uid: icuAdmission.patient_uid,
      event_kind: 'bilirubin_measurement',
      occurred_at: new Date('2026-05-04T10:00:00.000Z'),
      bilirubin_total_mgdl: 11.4,
      bilirubin_direct_mgdl: 0.6,
      measurement_method: 'serum',
      threshold_reference_source: 'nl5_content_studio',
      threshold_reference_version: 'seed-tsb-v1',
      recorded_by: reviewerUid,
      notes: 'Seed bilirubin measurement for QA coverage.',
      metadata: seedMeta,
    }]);
  }

  if (!hasScoring) return;

  // Score outputs fail closed without an owner-approved definition row, so
  // the seed provides its own reference-complete (inactive) definition and
  // stamps the output from it — mirroring the service's provenance rule.
  let definition = await first(
    'nicu_picu_score_definitions',
    'id, reference_source, reference_version',
    'reference_source IS NOT NULL AND reference_version IS NOT NULL',
    [],
  );
  if (!definition && await tableExists('nicu_picu_score_definitions')) {
    const created = await client.query(
      `INSERT INTO nicu_picu_score_definitions (
         tenant_id, score_kind, display_name, description, age_scope, source,
         reference_source, reference_version, approved_by, approved_at,
         active, metadata
       )
       VALUES (
         $1::uuid, 'crib_ii', 'CRIB-II (seed)',
         'Seed owner-approval evidence row for QA coverage.', 'neonatal',
         'operator_supplied', 'Seed owner-approved CRIB-II reference',
         'seed-crib2-v1', $2::uuid, NOW(), FALSE,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, reference_source, reference_version`,
      [tenantId, reviewerUid],
    );
    definition = created.rows[0];
  }
  if (!definition?.id) return;

  await insertIfEmpty('nicu_picu_scoring_outputs', [{
    tenant_id: tenantId,
    icu_admission_id: icuAdmission.id,
    patient_uid: icuAdmission.patient_uid,
    score_definition_id: definition.id,
    score_kind: 'crib_ii',
    recorded_at: new Date('2026-05-04T11:00:00.000Z'),
    input_facts: JSON.stringify({ gestational_age_weeks: 31.5, birth_weight_g: 1500 }),
    score_value: 7,
    score_label: 'CRIB-II 7',
    output_payload: JSON.stringify({ score: 7, scale: 'CRIB-II' }),
    reference_source: definition.reference_source,
    reference_version: definition.reference_version,
    reviewer_uid: reviewerUid,
    reviewer_role: 'NURSING_STAFF',
    reviewed_at: new Date('2026-05-04T11:05:00.000Z'),
    review_status: 'reviewed',
    score_available: true,
    order_mutation_performed: false,
    recorded_by: reviewerUid,
    metadata: seedMeta,
  }]);
}

async function seedResuscitationTables() {
  if (!(await tableExists('resuscitation_events'))) return;

  const refs = await getCoreRefs();
  const patientUid = refs.patient?.uid;
  const leaderUid = refs.staff?.uid || refs.doctor?.uid;
  const recorderUid = refs.secondStaff?.uid || leaderUid;
  if (!patientUid || !leaderUid) return;

  await insertIfEmpty('resuscitation_settings', [{
    tenant_id: DEFAULT_TENANT_ID,
    enabled: true,
    charting_policy: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    trigger_policy: JSON.stringify({ seed: true }),
    policy_source: 'operator_supplied',
    enabled_at: new Date('2026-05-04T08:00:00.000Z'),
    enabled_by: leaderUid,
    acceptance_snapshot: JSON.stringify({ seed: true, accepted_by: 'seed-comprehensive-test-data' }),
  }]);

  let event = await first('resuscitation_events', 'id, tenant_id, patient_uid', 'TRUE', []);
  if (!event) {
    const created = await client.query(
      `INSERT INTO resuscitation_events (
         tenant_id, patient_uid, event_kind, trigger_source, triggered_by,
         ward_snapshot, bed_snapshot, reason, started_at, ended_at, outcome,
         status, team_leader_uid, team_leader_name, recorder_uid, recorder_name,
         post_event_note_status, created_by, metadata
       )
       VALUES (
         $1::uuid, $2::uuid, 'code_blue', 'explicit_staff', $3::uuid,
         'ICU-A', 'B1', 'Seed code blue for QA coverage.',
         '2026-05-04T11:00:00.000Z'::timestamptz,
         '2026-05-04T11:25:00.000Z'::timestamptz, 'rosc',
         'ended', $3::uuid, 'Seed team leader', $4::uuid, 'Seed recorder',
         'draft', $3::uuid,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, tenant_id, patient_uid`,
      [DEFAULT_TENANT_ID, patientUid, leaderUid, recorderUid],
    );
    event = created.rows[0];
  }

  await insertIfEmpty('resuscitation_event_timeline', [
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      seq: 1,
      entry_type: 'compressions_started',
      occurred_at: new Date('2026-05-04T11:00:30.000Z'),
      details: JSON.stringify({ seed: true }),
      recorded_by: recorderUid,
    },
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      seq: 2,
      entry_type: 'shock',
      occurred_at: new Date('2026-05-04T11:02:00.000Z'),
      rhythm: 'vf',
      energy_joules: 200,
      details: JSON.stringify({ seed: true, waveform: 'biphasic' }),
      recorded_by: recorderUid,
    },
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      seq: 3,
      entry_type: 'medication',
      occurred_at: new Date('2026-05-04T11:03:00.000Z'),
      medication_name: 'Adrenaline (epinephrine)',
      dose: '1 mg',
      route: 'IV',
      details: JSON.stringify({ seed: true }),
      recorded_by: recorderUid,
    },
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      seq: 4,
      entry_type: 'rosc',
      occurred_at: new Date('2026-05-04T11:24:00.000Z'),
      details: JSON.stringify({ seed: true }),
      recorded_by: recorderUid,
    },
  ]);

  const medEntry = await first(
    'resuscitation_event_timeline',
    'id',
    "resuscitation_event_id = $1 AND entry_type = 'medication'",
    [event.id],
  );
  await insertIfEmpty('resuscitation_medication_links', [{
    tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
    resuscitation_event_id: event.id,
    timeline_entry_id: medEntry?.id,
    patient_uid: event.patient_uid,
    link_kind: 'unlinked_emergency',
    medication_kind: 'medication',
    medication_name: 'Adrenaline (epinephrine)',
    dose: '1 mg',
    route: 'IV',
    reconciliation_status: 'pending_mar_reconciliation',
    recorded_by: recorderUid,
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);

  await insertIfEmpty('resuscitation_team_roles', [
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      staff_uid: leaderUid,
      staff_name: 'Seed team leader',
      role: 'team_leader',
      joined_at: new Date('2026-05-04T11:00:00.000Z'),
      signed_at: new Date('2026-05-04T11:30:00.000Z'),
      signature_method: 'app_confirmation',
      signature_evidence: JSON.stringify({ seed: true }),
      assigned_by: leaderUid,
      metadata: JSON.stringify({ seed: true }),
    },
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      staff_uid: recorderUid,
      staff_name: 'Seed recorder',
      role: 'recorder',
      joined_at: new Date('2026-05-04T11:00:00.000Z'),
      signed_at: new Date('2026-05-04T11:30:00.000Z'),
      signature_method: 'app_confirmation',
      signature_evidence: JSON.stringify({ seed: true }),
      assigned_by: leaderUid,
      metadata: JSON.stringify({ seed: true }),
    },
  ]);

  const alertRow = await first('clinical_alerts', 'id', 'TRUE', []);
  await insertIfEmpty('resuscitation_device_links', [{
    tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
    resuscitation_event_id: event.id,
    patient_uid: event.patient_uid,
    link_kind: alertRow ? 'clinical_alert' : 'defibrillator',
    clinical_alert_id: alertRow?.id,
    evidence: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    linked_by: recorderUid,
    linked_at: new Date('2026-05-04T11:02:30.000Z'),
  }]);

  await insertIfEmpty('resuscitation_qa_reviews', [{
    tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
    resuscitation_event_id: event.id,
    patient_uid: event.patient_uid,
    review_status: 'draft',
    template_source: 'operator_supplied',
    template_version: 'seed-qa-v1',
    template_snapshot: JSON.stringify({ seed: true, questions: ['timeliness', 'documentation'] }),
    evidence_owner_uid: leaderUid,
    responses: JSON.stringify({ timeliness: 'seed answer' }),
    findings: 'Seed QA review for coverage.',
    action_items: JSON.stringify([]),
    debrief_held_at: new Date('2026-05-04T12:00:00.000Z'),
    debrief_lead_uid: leaderUid,
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedEdEncounterEvidence() {
  if (!(await tableExists('ed_encounter_evidence')) || await tableCount('ed_encounter_evidence')) return;

  const visit = await first('emergency_visits', 'id, tenant_id, patient_uid', 'TRUE', []);
  const vital = await first(
    'vitals_chart',
    'id, tenant_id, patient_uid, recorded_at, device_verified, recorded_by',
    'TRUE',
    [],
  );
  if (!visit || !vital) return;

  await insertIfEmpty('ed_encounter_evidence', [{
    tenant_id: visit.tenant_id || vital.tenant_id || DEFAULT_TENANT_ID,
    emergency_visit_id: visit.id,
    patient_uid: visit.patient_uid || vital.patient_uid,
    evidence_kind: 'vital_snapshot',
    vitals_chart_id: vital.id,
    observed_at: vital.recorded_at || new Date(),
    verified: vital.device_verified ?? false,
    linked_by_uid: vital.recorded_by,
    notes: 'Seed ED vital snapshot evidence for QA coverage',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedTransplantProgramTables() {
  if (!(await tableExists('transplant_programs'))) return;

  const refs = await getCoreRefs();
  if (!refs.patient || !refs.staff) return;
  const ownerUid = refs.doctor?.uid || refs.staff.uid;

  if (await tableExists('transplant_program_settings')) {
    await insertIfEmpty('transplant_program_settings', [{
      tenant_id: DEFAULT_TENANT_ID,
      enabled: false,
      acceptance_snapshot: JSON.stringify({ seed: true, suite: 'nl13-p6-transplant' }),
      owner_evidence_reference: 'seed-transplant-owner-evidence',
    }]);
  }

  let program = await first(
    'transplant_programs',
    'id, tenant_id',
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );
  if (!program) {
    const created = await client.query(
      `INSERT INTO transplant_programs (
         tenant_id, organ, service_line, site, program_owner_uid, program_owner_role,
         status, notto_evidence_owner_uid, notto_evidence_owner_role,
         notto_evidence_reference, metadata, created_by
       )
       VALUES (
         $1::uuid, 'kidney'::transplant_organ_type, 'Seed transplant service',
         'Seed transplant site', $2::uuid, 'DOCTOR', 'active', $3::uuid,
         'TRANSPLANT_COORDINATOR', 'seed-transplant-owner-evidence',
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb, $3::uuid
       )
       RETURNING id, tenant_id`,
      [DEFAULT_TENANT_ID, ownerUid, refs.staff.uid],
    );
    program = created.rows[0];
  }

  let candidate = await first(
    'transplant_candidates',
    'id, tenant_id, patient_uid',
    'tenant_id = $1::uuid',
    [program.tenant_id || DEFAULT_TENANT_ID],
  );
  if (!candidate && await tableExists('transplant_candidates')) {
    const created = await client.query(
      `INSERT INTO transplant_candidates (
         tenant_id, program_id, patient_uid, diagnosis, required_organs,
         listing_evaluation_status, committee_status, contraindications_summary,
         metadata, created_by
       )
       VALUES (
         $1::uuid, $2, $3::uuid, 'Seed transplant candidate evaluation',
         ARRAY['kidney']::transplant_organ_type[], 'committee_review', 'approved',
         'No seed contraindications recorded',
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb, $4::uuid
       )
       RETURNING id, tenant_id, patient_uid`,
      [program.tenant_id || DEFAULT_TENANT_ID, program.id, refs.patient.uid, refs.staff.uid],
    );
    candidate = created.rows[0];
  }

  if (!candidate) return;

  if (await tableExists('transplant_committee_reviews')) {
    await insertIfEmpty('transplant_committee_reviews', [{
      tenant_id: candidate.tenant_id || DEFAULT_TENANT_ID,
      program_id: program.id,
      candidate_id: candidate.id,
      attendees: JSON.stringify([{ staff_uid: refs.staff.uid, role: 'TRANSPLANT_COORDINATOR' }]),
      quorum_policy_reference: 'seed-transplant-quorum-policy',
      decision: 'approved',
      recommendations: 'Seed committee approval for QA coverage.',
      affects_candidate: true,
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
    }]);
  }

  if (await tableExists('transplant_waitlist_status_history')) {
    await insertIfEmpty('transplant_waitlist_status_history', [{
      tenant_id: candidate.tenant_id || DEFAULT_TENANT_ID,
      candidate_id: candidate.id,
      status: 'listed',
      reason: 'Seed waitlist status for QA coverage.',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
    }]);
  }

  let donorReferral = await first(
    'transplant_donor_referrals',
    'id, tenant_id',
    'tenant_id = $1::uuid',
    [program.tenant_id || DEFAULT_TENANT_ID],
  );
  if (!donorReferral && await tableExists('transplant_donor_referrals')) {
    const created = await client.query(
      `INSERT INTO transplant_donor_referrals (
         tenant_id, program_id, donor_type, source, relation_category,
         screening_summary, documents, status, audit_register, created_by
       )
       VALUES (
         $1::uuid, $2, 'living', 'Seed donor referral', 'related',
         'Seed transplant donor referral for QA coverage.',
         '[]'::jsonb, 'screening',
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb, $3::uuid
       )
       RETURNING id, tenant_id`,
      [program.tenant_id || DEFAULT_TENANT_ID, program.id, refs.staff.uid],
    );
    donorReferral = created.rows[0];
  }

  if (donorReferral && await tableExists('transplant_match_reviews')) {
    await insertIfEmpty('transplant_match_reviews', [{
      tenant_id: candidate.tenant_id || DEFAULT_TENANT_ID,
      candidate_id: candidate.id,
      donor_referral_id: donorReferral.id,
      compatibility_summary: 'Seed compatibility review for QA coverage.',
      crossmatch_documents: JSON.stringify([]),
      chain_of_custody: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      risk_flags: [],
      decision: 'pending',
      created_by: refs.staff.uid,
    }]);
  }

  if (await tableExists('transplant_immunosuppression_plans')) {
    await insertIfEmpty('transplant_immunosuppression_plans', [{
      tenant_id: candidate.tenant_id || DEFAULT_TENANT_ID,
      candidate_id: candidate.id,
      patient_uid: candidate.patient_uid || refs.patient.uid,
      regimen_summary: 'Seed immunosuppression regimen for QA coverage.',
      monitoring_plan: 'Seed monitoring plan for QA coverage.',
      prescribing_owner_uid: ownerUid,
      downstream_medication_links: JSON.stringify([]),
      status: 'draft',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
    }]);
  }

  if (await tableExists('transplant_notto_exports')) {
    await insertIfEmpty('transplant_notto_exports', [{
      tenant_id: program.tenant_id || DEFAULT_TENANT_ID,
      program_id: program.id,
      candidate_id: candidate.id,
      package_metadata: JSON.stringify({ seed: true, export_kind: 'candidate_snapshot' }),
      owner_reviewed_status: 'pending_owner_review',
      audit_evidence: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
    }]);
  }
}

async function seedPerfusionSignoffs() {
  if (!(await tableExists('perfusion_signoffs')) || await tableCount('perfusion_signoffs')) return;
  const record = await first('perfusion_records', 'id, tenant_id, ot_schedule_id, patient_uid', 'TRUE', []);
  if (!record) return;

  await insertIfEmpty('perfusion_signoffs', [{
    tenant_id: record.tenant_id || DEFAULT_TENANT_ID,
    perfusion_record_id: record.id,
    ot_schedule_id: record.ot_schedule_id,
    patient_uid: record.patient_uid,
    status: 'draft',
    signoff_policy_source_label: 'owner-pending-perfusion-signoff-policy',
    signoff_policy_source_version: 'pending',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedIcuChartDepthTables() {
  const hasWeaning = await tableExists('icu_weaning_trials');
  const hasScoring = await tableExists('icu_scoring_outputs');
  const hasDeviceLinks = await tableExists('icu_device_observation_links');
  if (!hasWeaning && !hasScoring && !hasDeviceLinks) return;

  const refs = await getCoreRefs();
  const icuAdmission = await first(
    'icu_admissions',
    'id, tenant_id, admission_id, patient_uid',
    'TRUE',
    [],
  );
  const reviewerUid = refs.staff?.uid || refs.doctor?.uid;
  if (!icuAdmission?.id || !icuAdmission.patient_uid || !reviewerUid) return;

  let ventilationEpisode = await first(
    'icu_ventilation_episodes',
    'id',
    'icu_admission_id = $1',
    [icuAdmission.id],
  );
  if (hasWeaning && !ventilationEpisode && await tableExists('icu_ventilation_episodes')) {
    const created = await client.query(
      `INSERT INTO icu_ventilation_episodes (
         tenant_id, icu_admission_id, admission_id, patient_uid, mode, oxygen_device,
         airway_type, started_at, settings, responsible_clinician_uid,
         responsible_clinician_name, started_by, metadata
       )
       VALUES (
         $1::uuid, $2, $3, $4::uuid, 'pressure_support', 'ventilator',
         'ett', '2026-05-04T08:00:00.000Z'::timestamptz,
         '{"fio2":0.35,"peepCmH2o":5}'::jsonb, $5::uuid,
         'Seed ICU clinician', $5::uuid,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id`,
      [
        icuAdmission.tenant_id || DEFAULT_TENANT_ID,
        icuAdmission.id,
        icuAdmission.admission_id,
        icuAdmission.patient_uid,
        reviewerUid,
      ],
    );
    ventilationEpisode = created.rows[0];
  }

  if (hasWeaning) {
    await insertIfEmpty('icu_weaning_trials', [{
      tenant_id: icuAdmission.tenant_id || DEFAULT_TENANT_ID,
      icu_admission_id: icuAdmission.id,
      ventilation_episode_id: ventilationEpisode?.id,
      patient_uid: icuAdmission.patient_uid,
      trial_kind: 'sbt',
      readiness_status: 'ready',
      started_at: new Date('2026-05-04T09:00:00.000Z'),
      ended_at: new Date('2026-05-04T09:30:00.000Z'),
      outcome: 'passed',
      reason: 'Seed spontaneous breathing trial for QA coverage.',
      criteria_snapshot: JSON.stringify({ fio2: 0.35, peepCmH2o: 5, hemodynamics: 'stable' }),
      protocol_reference: JSON.stringify({ source: 'nl5_content_studio', version: 'seed-sbt-v1' }),
      reviewer_uid: reviewerUid,
      reviewed_at: new Date('2026-05-04T09:35:00.000Z'),
      recorded_by: reviewerUid,
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (hasScoring) {
    await insertIfEmpty('icu_scoring_outputs', [{
      tenant_id: icuAdmission.tenant_id || DEFAULT_TENANT_ID,
      icu_admission_id: icuAdmission.id,
      patient_uid: icuAdmission.patient_uid,
      scoring_kind: 'rass',
      recorded_at: new Date('2026-05-04T10:00:00.000Z'),
      input_facts: JSON.stringify({ agitation: 'calm', arousal: 'alert' }),
      score_value: 0,
      score_label: 'Alert and calm',
      output_payload: JSON.stringify({ score: 0, scale: 'RASS' }),
      reference_source: 'nl5_content_studio',
      reference_version: 'seed-rass-v1',
      reviewer_uid: reviewerUid,
      reviewer_role: 'NURSING_STAFF',
      reviewed_at: new Date('2026-05-04T10:05:00.000Z'),
      review_status: 'reviewed',
      protocol_available: true,
      order_mutation_performed: false,
      recorded_by: reviewerUid,
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (!hasDeviceLinks) return;

  let vitalsRow = await first(
    'vitals_chart',
    'id, tenant_id, patient_uid',
    'patient_uid = $1::uuid',
    [icuAdmission.patient_uid],
  );
  if (!vitalsRow) {
    const created = await client.query(
      `INSERT INTO vitals_chart (
         tenant_id, patient_uid, heart_rate, systolic_bp, diastolic_bp,
         spo2, respiratory_rate, source, device_verified, verified_by,
         verified_at, recorded_by, recorded_at, notes
       )
       VALUES (
         $1::uuid, $2::uuid, 82, 118, 72, 98, 16, 'device',
         TRUE, $3::uuid, '2026-05-04T10:10:00.000Z'::timestamptz,
         $3::uuid, '2026-05-04T10:10:00.000Z'::timestamptz,
         'Seed ICU device vital for QA coverage.'
       )
       RETURNING id, tenant_id, patient_uid`,
      [icuAdmission.tenant_id || DEFAULT_TENANT_ID, icuAdmission.patient_uid, reviewerUid],
    );
    vitalsRow = created.rows[0];
  }

  await insertIfEmpty('icu_device_observation_links', [{
    tenant_id: icuAdmission.tenant_id || vitalsRow.tenant_id || DEFAULT_TENANT_ID,
    icu_admission_id: icuAdmission.id,
    patient_uid: icuAdmission.patient_uid,
    link_kind: 'vitals_chart',
    vitals_chart_id: vitalsRow.id,
    linked_at: new Date('2026-05-04T10:15:00.000Z'),
    linked_by: reviewerUid,
    context: 'seed_coverage',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

try {
  await client.query('BEGIN');
  await seedCoreData();
  await seedIdentityProviderTables();
  await seedColdChainTables();
  const { seeded, failed } = await seedRemainingTables();
  await seedInsuranceClaimCaps();
  await seedLedgerEntries();
  await seedPillarDWorkflowTables();
  await seedRadiologyPeerReviews();
  await seedDonorIntakeTables();
  await seedBiomedCmmsTables();
  await seedMortuarySlots();
  await seedInfusionChairTables();
  await seedMigrationToolkitTables();
  await seedSiemExportTables();
  await seedIcuChartDepthTables();
  await seedPerfusionSignoffs();
  await seedTransplantProgramTables();
  await seedEdEncounterEvidence();
  await seedResuscitationTables();
  await seedNicuPicuChartTables();
  await seedMergedMainCoverageTables();
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
