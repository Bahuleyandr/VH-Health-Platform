import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(backendRoot, '.env.local'), quiet: true });
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

if (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) {
  console.log('Test DB bootstrap skipped: DATABASE_URL or TEST_DATABASE_URL is already set.');
  process.exit(0);
}

const port = process.env.VHHEALTH_TEST_DB_PORT || '55432';
const database = process.env.VHHEALTH_TEST_DB_NAME || 'vhhealth_test';
const user = process.env.VHHEALTH_TEST_DB_USER || 'postgres';
const databaseUrl = `postgresql://${user}@127.0.0.1:${port}/${database}`;
const defaultDataDir = path.join('D:', 'Dev', 'Tools', 'vhhealth-test-postgres-data');
const dataDir = process.env.VHHEALTH_TEST_PGDATA || (
  process.platform === 'win32'
    ? defaultDataDir
    : path.join(os.homedir(), '.vhhealth-test-postgres-data')
);
const logFile = path.join(dataDir, 'postgres.log');

const pgBin = findPgBin();
const bin = (name) => path.join(pgBin, process.platform === 'win32' ? `${name}.exe` : name);
const prismaSchemaPath = path.join(backendRoot, 'prisma', 'schema.prisma');

function findPgBin() {
  const candidates = [
    process.env.PG_BIN,
    process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\17\\bin' : null,
    process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\16\\bin' : null,
    process.platform !== 'win32' ? '/usr/local/bin' : null,
    process.platform !== 'win32' ? '/usr/bin' : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'))) {
      return candidate;
    }
  }

  throw new Error(
    'PostgreSQL binaries not found. Set PG_BIN to the folder containing pg_ctl/psql, or set TEST_DATABASE_URL.'
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || backendRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (result.status !== 0) {
    const cause = result.error ? `\n${result.error.message}` : '';
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed${cause}\n${output}`);
  }

  return result.stdout || '';
}

function pgIsReady() {
  const result = spawnSync(bin('pg_isready'), ['-h', '127.0.0.1', '-p', port], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return result.status === 0;
}

function psql(db, sql, capture = false) {
  return run(bin('psql'), [
    '-h', '127.0.0.1',
    '-p', port,
    '-U', user,
    '-d', db,
    '-v', 'ON_ERROR_STOP=1',
    '-c', sql,
  ], { capture });
}

function ensureCluster() {
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.log(`Initializing local test Postgres at ${dataDir}`);
    run(bin('initdb'), ['-D', dataDir, '-A', 'trust', '-U', user, '--encoding=UTF8']);
  }

  if (!pgIsReady()) {
    console.log(`Starting local test Postgres on 127.0.0.1:${port}`);
    run(bin('pg_ctl'), [
      '-D', dataDir,
      '-l', logFile,
      '-o', `-p ${port} -h 127.0.0.1`,
      '-w',
      '-t', '60',
      'start',
    ]);
  }
}

function ensureDatabase() {
  const exists = psql('postgres', `SELECT 1 FROM pg_database WHERE datname='${database}'`, true)
    .split(/\r?\n/)
    .some((line) => line.trim() === '1');

  if (!exists) {
    console.log(`Creating test database ${database}`);
    run(bin('createdb'), ['-h', '127.0.0.1', '-p', port, '-U', user, database]);
  }

  psql(database, 'CREATE EXTENSION IF NOT EXISTS pgcrypto');
}

function schemaRequiresPgvector() {
  return fs.existsSync(prismaSchemaPath) &&
    fs.readFileSync(prismaSchemaPath, 'utf8').includes('Unsupported("vector")');
}

function isPgvectorAvailable() {
  return psql(
    database,
    "SELECT 1 FROM pg_available_extensions WHERE name = 'vector' LIMIT 1",
    true
  )
    .split(/\r?\n/)
    .some((line) => line.trim() === '1');
}

function assertPgvectorAvailable() {
  if (!schemaRequiresPgvector()) return;
  if (isPgvectorAvailable()) return;

  throw new Error(
    'Local test DB setup requires pgvector because prisma/schema.prisma contains Unsupported("vector"). ' +
    'Install the vector extension for local Postgres, or run the Docker-backed guardrail: ' +
    'npm run ci:db-guardrails:docker'
  );
}

function ensurePgvectorExtension() {
  if (schemaRequiresPgvector()) {
    psql(database, 'CREATE EXTENSION IF NOT EXISTS vector');
  }
}

function ensureCompatibilityTables() {
  console.log('Ensuring legacy clinical test tables');
  psql(database, `
    CREATE TABLE IF NOT EXISTS e_prescriptions (
      id SERIAL PRIMARY KEY,
      appointment_id INTEGER,
      patient_id INTEGER,
      doctor_id INTEGER,
      patient_uid UUID,
      doctor_uid UUID,
      medication_name VARCHAR(255),
      diagnosis TEXT,
      clinical_notes TEXT,
      medications JSONB,
      notes TEXT,
      status VARCHAR(50) DEFAULT 'active',
      prescription_number VARCHAR(80) DEFAULT ('RX-' || replace(gen_random_uuid()::text, '-', '')),
      follow_up_date DATE,
      follow_up_notes TEXT,
      vitals JSONB,
      handwritten_photo_key TEXT,
      pdf_key TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS patient_vitals (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      blood_pressure JSONB,
      heart_rate INTEGER,
      temperature NUMERIC(5,2),
      blood_sugar INTEGER,
      weight NUMERIC(6,2),
      spo2 INTEGER,
      mood VARCHAR(50),
      recorded_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS medication_administrations (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      prescription_id INTEGER,
      medication_name VARCHAR(255) NOT NULL,
      dose VARCHAR(100),
      dosage VARCHAR(100),
      route VARCHAR(50),
      scheduled_time TIMESTAMPTZ,
      administered_at TIMESTAMPTZ,
      administered_by UUID,
      status VARCHAR(50) DEFAULT 'scheduled',
      notes TEXT,
      witness_uid UUID,
      hold_reason TEXT,
      refusal_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS patient_allergies (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER,
      patient_uid UUID,
      allergy_name VARCHAR(255) NOT NULL,
      severity VARCHAR(50),
      reaction TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS allergies (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      allergen VARCHAR(255),
      name VARCHAR(255),
      severity VARCHAR(50),
      reaction TEXT,
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admissions (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      status VARCHAR(50) DEFAULT 'admitted',
      allergies TEXT[],
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      medication_name VARCHAR(255) NOT NULL,
      dosage VARCHAR(100),
      frequency VARCHAR(100),
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE prescriptions
      ADD COLUMN IF NOT EXISTS dosage VARCHAR(100),
      ADD COLUMN IF NOT EXISTS frequency VARCHAR(100);

    CREATE TABLE IF NOT EXISTS drug_interactions (
      id SERIAL PRIMARY KEY,
      drug_a VARCHAR(255) NOT NULL,
      drug_b VARCHAR(255) NOT NULL,
      severity VARCHAR(50) NOT NULL,
      description TEXT,
      clinical_effect TEXT,
      management TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cds_alerts (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      encounter_id INTEGER,
      alert_type VARCHAR(100) NOT NULL,
      severity VARCHAR(50) NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      source_data JSONB,
      acknowledged BOOLEAN DEFAULT false,
      ack_by UUID,
      ack_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE pharmacy_orders
      ADD COLUMN IF NOT EXISTS order_number VARCHAR(80) DEFAULT ('PO-' || replace(gen_random_uuid()::text, '-', '')),
      ADD COLUMN IF NOT EXISTS prescription_photo_key TEXT,
      ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(50) DEFAULT 'delivery',
      ADD COLUMN IF NOT EXISTS delivery_address TEXT,
      ADD COLUMN IF NOT EXISTS delivery_landmark TEXT,
      ADD COLUMN IF NOT EXISTS delivery_lat NUMERIC(10,6),
      ADD COLUMN IF NOT EXISTS delivery_lng NUMERIC(10,6),
      ADD COLUMN IF NOT EXISTS delivery_phone VARCHAR(20),
      ADD COLUMN IF NOT EXISTS confirmed_by INTEGER,
      ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS confirmation_notes TEXT,
      ADD COLUMN IF NOT EXISTS items_list JSONB,
      ADD COLUMN IF NOT EXISTS sla_confirm_target TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS sla_dispatch_target TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS preparing_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS dispatched_by INTEGER,
      ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS delivery_person VARCHAR(255),
      ADD COLUMN IF NOT EXISTS delivery_person_phone VARCHAR(20),
      ADD COLUMN IF NOT EXISTS estimated_delivery_mins INTEGER,
      ADD COLUMN IF NOT EXISTS delivery_distance_km NUMERIC(8,2),
      ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS delivery_tracking_active BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS sla_delivery_target TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
      ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS pharmacy_order_history (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES pharmacy_orders(id) ON DELETE CASCADE,
      from_status VARCHAR(50),
      to_status VARCHAR(50) NOT NULL,
      changed_by INTEGER,
      changed_by_role VARCHAR(50),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vitals_chart (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      encounter_id INTEGER,
      heart_rate NUMERIC(6,2),
      systolic_bp NUMERIC(6,2),
      diastolic_bp NUMERIC(6,2),
      temperature NUMERIC(5,2),
      spo2 NUMERIC(5,2),
      respiratory_rate NUMERIC(5,2),
      blood_glucose NUMERIC(8,2),
      pain_score NUMERIC(4,1),
      weight_kg NUMERIC(6,2),
      height_cm NUMERIC(6,2),
      gcs_score INTEGER,
      supplemental_o2 BOOLEAN DEFAULT false,
      o2_flow_rate NUMERIC(6,2),
      consciousness VARCHAR(5),
      notes TEXT,
      recorded_by UUID,
      recorded_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS intake_output (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      encounter_id INTEGER,
      io_type VARCHAR(20) NOT NULL,
      category VARCHAR(50) NOT NULL,
      amount_ml NUMERIC(10,2) NOT NULL,
      description TEXT,
      recorded_by UUID NOT NULL,
      recorded_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clinical_alerts (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER,
      alert_type VARCHAR(100),
      vital_name VARCHAR(100),
      vital_value NUMERIC(10,2),
      severity VARCHAR(50),
      message TEXT,
      acknowledged BOOLEAN DEFAULT false,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wards (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      floor INTEGER DEFAULT 1,
      department_id INTEGER REFERENCES departments(id),
      total_beds INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS beds (
      id SERIAL PRIMARY KEY,
      ward_id INTEGER REFERENCES wards(id) ON DELETE CASCADE,
      bed_number VARCHAR(20) NOT NULL,
      status VARCHAR(20) DEFAULT 'available',
      patient_id INTEGER REFERENCES users(id),
      patient_name VARCHAR(100),
      admitted_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    DO $$
    BEGIN
      ALTER TABLE beds DROP CONSTRAINT IF EXISTS beds_status_check;
      ALTER TABLE beds ADD CONSTRAINT beds_status_check
        CHECK (status IN ('available', 'occupied', 'reserved', 'maintenance', 'cleaning'));
    END $$;

    ALTER TABLE beds
      ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS patient_uid UUID,
      ADD COLUMN IF NOT EXISTS expected_discharge TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS ward_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS floor INTEGER,
      ADD COLUMN IF NOT EXISTS bed_type VARCHAR(50) DEFAULT 'general';

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      uid UUID,
      role VARCHAR(50),
      ip VARCHAR(50),
      ip_address VARCHAR(50),
      action VARCHAR(255) NOT NULL,
      platform VARCHAR(50),
      phone VARCHAR(20),
      resource VARCHAR(100),
      resource_id VARCHAR(100),
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      uid UUID,
      action VARCHAR(255),
      resource VARCHAR(100),
      resource_id VARCHAR(100),
      metadata JSONB,
      ip_address VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS patient_consents (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      consent_type VARCHAR(100) NOT NULL,
      granted BOOLEAN DEFAULT false,
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE admissions
      ADD COLUMN IF NOT EXISTS encounter_id UUID DEFAULT gen_random_uuid(),
      ADD COLUMN IF NOT EXISTS admitting_doctor UUID,
      ADD COLUMN IF NOT EXISTS attending_doctor UUID,
      ADD COLUMN IF NOT EXISTS department VARCHAR(255),
      ADD COLUMN IF NOT EXISTS ward VARCHAR(255),
      ADD COLUMN IF NOT EXISTS bed_id INTEGER,
      ADD COLUMN IF NOT EXISTS bed_number VARCHAR(50),
      ADD COLUMN IF NOT EXISTS chief_complaint TEXT,
      ADD COLUMN IF NOT EXISTS admitting_diagnosis TEXT,
      ADD COLUMN IF NOT EXISTS admission_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS priority VARCHAR(50),
      ADD COLUMN IF NOT EXISTS insurance_info JSONB,
      ADD COLUMN IF NOT EXISTS emergency_contact JSONB,
      ADD COLUMN IF NOT EXISTS code_status VARCHAR(50) DEFAULT 'full_code',
      ADD COLUMN IF NOT EXISTS expected_los_days INTEGER,
      ADD COLUMN IF NOT EXISTS created_by UUID,
      ADD COLUMN IF NOT EXISTS admitted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS discharged_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS discharge_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS discharge_summary JSONB,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS bed_transfers (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      admission_id INTEGER,
      from_bed_id INTEGER,
      to_bed_id INTEGER,
      reason TEXT,
      transferred_by UUID,
      transferred_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS icd10_codes (
      id SERIAL PRIMARY KEY,
      code VARCHAR(20) UNIQUE NOT NULL,
      description TEXT NOT NULL,
      category VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS diagnoses (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      encounter_id UUID,
      icd10_code VARCHAR(20),
      icd10_description TEXT,
      description TEXT NOT NULL,
      diagnosis_type VARCHAR(50) DEFAULT 'secondary',
      status VARCHAR(50) DEFAULT 'active',
      onset_date DATE,
      resolved_date DATE,
      severity VARCHAR(50),
      diagnosed_by UUID,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ot_schedules (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      encounter_id INTEGER,
      surgeon UUID NOT NULL,
      anesthetist UUID,
      procedure_name TEXT NOT NULL,
      procedure_code VARCHAR(50),
      ot_room VARCHAR(100),
      scheduled_date DATE NOT NULL,
      scheduled_time TIME,
      estimated_duration INTEGER,
      actual_duration INTEGER,
      status VARCHAR(50) DEFAULT 'scheduled',
      pre_op_checklist JSONB,
      equipment_needed TEXT[],
      blood_arranged BOOLEAN DEFAULT false,
      consent_obtained BOOLEAN DEFAULT false,
      post_op_notes TEXT,
      complications TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS blood_requests (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      encounter_id INTEGER,
      blood_group VARCHAR(5) NOT NULL,
      component VARCHAR(50) NOT NULL,
      units INTEGER NOT NULL,
      urgency VARCHAR(50) DEFAULT 'routine',
      clinical_indication TEXT NOT NULL,
      cross_match_status VARCHAR(50) DEFAULT 'pending',
      cross_matched_by UUID,
      cross_matched_at TIMESTAMPTZ,
      issued_by UUID,
      issued_at TIMESTAMPTZ,
      transfused_at TIMESTAMPTZ,
      status VARCHAR(50) DEFAULT 'requested',
      ordered_by UUID,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS radiology_orders (
      id SERIAL PRIMARY KEY,
      patient_uid UUID NOT NULL,
      encounter_id INTEGER,
      modality VARCHAR(50) NOT NULL,
      body_part VARCHAR(100) NOT NULL,
      clinical_indication TEXT NOT NULL,
      priority VARCHAR(50) DEFAULT 'routine',
      status VARCHAR(50) DEFAULT 'ordered',
      ordered_by UUID NOT NULL,
      radiologist UUID,
      report TEXT,
      report_completed_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function syncSchema() {
  console.log('Resetting local test database schema');
  psql(database, `
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SEQUENCE IF NOT EXISTS _migrations_id_seq;
  `);
  ensurePgvectorExtension();

  // Drop RLS policies first — `prisma db push --accept-data-loss` wants to drop
  // tenant_id columns (not in schema.prisma) and fails when policies depend on
  // them. Migration 075 re-applies policies after all migrations run.
  psql(database, `
    DO $$
    DECLARE t text;
    BEGIN
      FOR t IN SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation'
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
      END LOOP;
    END
    $$;
  `);

  console.log('Syncing Prisma schema into local test database');
  run(
    process.execPath,
    [
      path.join(backendRoot, 'node_modules', 'prisma', 'build', 'index.js'),
      'db',
      'push',
      '--skip-generate',
      '--accept-data-loss',
    ],
    { env: { DATABASE_URL: databaseUrl } }
  );

  ensureCompatibilityTables();

  console.log('Applying hybrid SQL migrations and local seeds');
  run(process.execPath, [path.join(backendRoot, 'scripts', 'ci-setup-db.mjs')], {
    env: { DATABASE_URL: databaseUrl },
  });
}

try {
  ensureCluster();
  ensureDatabase();
  assertPgvectorAvailable();
  syncSchema();
  console.log(`Local backend test DB ready: ${databaseUrl}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
