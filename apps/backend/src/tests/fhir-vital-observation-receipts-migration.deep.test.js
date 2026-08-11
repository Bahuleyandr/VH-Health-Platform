import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jest } from '@jest/globals';
import pg from 'pg';

import { splitStatements } from '../utils/migrations/splitStatements.js';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(__dirname, '..', 'migrations', '656_fhir_vital_observation_receipts.sql');
const migrationSql = readFileSync(migrationPath, 'utf8');
const statements = splitStatements(migrationSql);
const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;

jest.setTimeout(90_000);

describe('migration 656 static deploy-safety contract', () => {
  test('is non-transactional, unbounded, and replay-safe by construction', () => {
    expect(migrationSql).toMatch(/^-- Migration 656:[\s\S]*^-- @no-transaction$/m);
    expect(migrationSql).toMatch(/^-- @statement_timeout: 0$/m);
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT);\s*$/m);
    expect(migrationSql).toMatch(/CREATE TABLE IF NOT EXISTS public\.fhir_vital_observation_receipts/);
    expect(migrationSql).toMatch(/CREATE TABLE IF NOT EXISTS public\.fhir_vital_observation_sets/);
    expect(migrationSql).toMatch(/CREATE TABLE IF NOT EXISTS public\.fhir_vital_observation_set_resources/);
    expect(migrationSql).toMatch(/ALTER COLUMN supplemental_o2 DROP NOT NULL/);
    expect(migrationSql).toMatch(/UNIQUE \(tenant_id, resource_fingerprint\)/);
    expect(migrationSql).toMatch(/news2_effects_completed_at TIMESTAMPTZ\(6\)/);
    expect(migrationSql).toMatch(/anomaly_effects_completed_at TIMESTAMPTZ\(6\)/);
    expect(migrationSql).toMatch(/news2_effects_claim_token UUID/);
    expect(migrationSql).toMatch(/anomaly_effects_claim_token UUID/);
    expect(migrationSql).toMatch(/news2_effects_next_retry_at TIMESTAMPTZ\(6\)/);
    expect(migrationSql).toMatch(/anomaly_effects_next_retry_at TIMESTAMPTZ\(6\)/);
    expect(migrationSql).toMatch(/chk_fhir_vital_observation_set_effects_immutable/);
    expect(migrationSql).toMatch(/chk_fhir_vital_observation_set_news2_claim/);
    expect(migrationSql).toMatch(/chk_fhir_vital_observation_set_anomaly_claim/);
    expect(migrationSql.match(/DEFERRABLE INITIALLY IMMEDIATE/g)).toHaveLength(4);
    expect(migrationSql).toMatch(/fhir_vital_observation_set_scope_deferred/);
    expect(migrationSql).toMatch(/app\.patient_merge_execution/);
    expect(migrationSql).toMatch(/fhir_vital_observation_receipt_update_guard/);
    expect(migrationSql).toMatch(/chk_fhir_vital_observation_receipt_immutable/);
    expect(migrationSql).toMatch(/chk_fhir_vital_observation_receipt_scope_deferred/);

    expect(migrationSql).not.toMatch(/DROP INDEX public\./i);
    expect(migrationSql.match(/NOT indisvalid/g)).toHaveLength(4);
    expect(migrationSql.match(/ALTER INDEX public\.(?:idx|ux)_fhir_vital_observation_/g)).toHaveLength(4);
    expect(migrationSql.match(/DROP INDEX CONCURRENTLY IF EXISTS public\.(?:idx|ux)_fhir_vital_\w+_invalid_rebuild/g)).toHaveLength(8);
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_fhir_vital_observation_receipt_logical_resource/,
    );
    expect(migrationSql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fhir_vital_observation_receipts_patient/,
    );
    expect(migrationSql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fhir_vital_observation_sets_patient/,
    );
    expect(migrationSql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fhir_vital_observation_sets_pending_effects/,
    );
  });
});

d('migration 656 interrupted replay (isolated scratch database)', () => {
  const sourceUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const scratchName = `vh_p2_m656_${process.pid}_${Date.now().toString(36)}`;
  let admin;
  let scratch;
  let scratchUrl;
  const runtimeRole = `vh_p2_runtime_${process.pid}_${Date.now().toString(36)}`;
  const migrationRuntimeRole = 'vhhealth_runtime';
  let createdMigrationRuntimeRole = false;

  beforeAll(async () => {
    if (!/^[a-z0-9_]+$/.test(scratchName)) throw new Error('Unsafe scratch database name');
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = '/postgres';
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const existingMigrationRuntimeRole = await admin.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      [migrationRuntimeRole],
    );
    if (existingMigrationRuntimeRole.rowCount === 0) {
      await admin.query(`CREATE ROLE ${migrationRuntimeRole} NOLOGIN`);
      createdMigrationRuntimeRole = true;
    }
    await admin.query(`CREATE DATABASE ${scratchName}`);

    scratchUrl = new URL(sourceUrl);
    scratchUrl.pathname = `/${scratchName}`;
    scratch = new Client({ connectionString: scratchUrl.toString() });
    await scratch.connect();
    await scratch.query(`
      CREATE TABLE public.tenants (id UUID PRIMARY KEY);
      CREATE TABLE public.users (
        uid UUID PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        UNIQUE (tenant_id, uid)
      );
      CREATE TABLE public.vitals_chart (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        patient_uid UUID NOT NULL,
        source VARCHAR(30) NOT NULL,
        source_device VARCHAR(120),
        recorded_at TIMESTAMPTZ(6) NOT NULL
      );
      CREATE TABLE public.news2_scores (
        id SERIAL PRIMARY KEY,
        supplemental_o2 BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE public.patient_merge_requests (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        primary_uid UUID NOT NULL,
        secondary_uid UUID,
        status VARCHAR(20) NOT NULL,
        continuity_disposition VARCHAR(32)
      );
      CREATE FUNCTION public.app_current_tenant_id_uuid()
      RETURNS UUID LANGUAGE sql STABLE AS $$
        SELECT NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
      $$;
    `);
  });

  afterAll(async () => {
    await scratch?.end().catch(() => {});
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`).catch(() => {});
      if (createdMigrationRuntimeRole) {
        await admin.query(`DROP ROLE IF EXISTS ${migrationRuntimeRole}`).catch(() => {});
      }
      await admin.end().catch(() => {});
    }
  });

  test('recovers after the durable-owner cut point and remains safe on a second full replay', async () => {
    const receiptTable = statements.findIndex((statement) => (
      statement.includes('CREATE TABLE IF NOT EXISTS public.fhir_vital_observation_receipts')
    ));
    const setTable = statements.findIndex((statement) => (
      statement.includes('CREATE TABLE IF NOT EXISTS public.fhir_vital_observation_sets')
    ));
    const logicalIndexRename = statements.findIndex((statement) => (
      statement.includes('RENAME TO ux_fhir_vital_logical_invalid_rebuild')
    ));
    const cutPoint = statements.findIndex((statement) => (
      statement.includes('CREATE TABLE IF NOT EXISTS public.fhir_vital_observation_set_resources')
    ));
    expect(receiptTable).toBeGreaterThan(0);
    expect(logicalIndexRename).toBeGreaterThan(receiptTable);
    expect(setTable).toBeGreaterThan(receiptTable);
    expect(cutPoint).toBeGreaterThan(setTable);

    for (const statement of statements.slice(0, receiptTable + 1)) await scratch.query(statement);
    await scratch.query(
      `CREATE UNIQUE INDEX ux_fhir_vital_observation_receipt_logical_resource
         ON fhir_vital_observation_receipts (tenant_id, patient_uid, resource_id)`,
    );
    await scratch.query(
      `CREATE INDEX idx_fhir_vital_observation_receipts_patient
         ON fhir_vital_observation_receipts (tenant_id, patient_uid, observed_at DESC)`,
    );
    await scratch.query(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid IN (
          'ux_fhir_vital_observation_receipt_logical_resource'::regclass,
          'idx_fhir_vital_observation_receipts_patient'::regclass
        )`,
    );

    for (const statement of statements.slice(receiptTable + 1, logicalIndexRename + 1)) {
      await scratch.query(statement);
    }
    const interruptedRename = await scratch.query(
      `SELECT to_regclass('public.ux_fhir_vital_observation_receipt_logical_resource')::text AS canonical,
              to_regclass('public.ux_fhir_vital_logical_invalid_rebuild')::text AS recovery`,
    );
    expect(interruptedRename.rows[0]).toEqual({
      canonical: null,
      recovery: 'ux_fhir_vital_logical_invalid_rebuild',
    });

    for (const statement of statements.slice(receiptTable + 1, setTable + 1)) {
      await scratch.query(statement);
    }
    await scratch.query(
      `GRANT UPDATE ON public.fhir_vital_observation_sets TO ${migrationRuntimeRole}`,
    );
    await scratch.query(
      `CREATE INDEX idx_fhir_vital_observation_sets_patient
         ON fhir_vital_observation_sets (tenant_id, patient_uid, observed_at DESC)`,
    );
    await scratch.query(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = 'idx_fhir_vital_observation_sets_patient'::regclass`,
    );

    for (const statement of statements.slice(setTable + 1, cutPoint + 1)) {
      await scratch.query(statement);
    }
    const repairedIndexes = await scratch.query(
      `SELECT index_class.relname, index_state.indisvalid
         FROM pg_index index_state
         JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
        WHERE index_class.relname = ANY($1::text[])
        ORDER BY index_class.relname`,
      [[
        'idx_fhir_vital_observation_receipts_patient',
        'idx_fhir_vital_observation_sets_patient',
        'ux_fhir_vital_observation_receipt_logical_resource',
      ]],
    );
    expect(repairedIndexes.rows).toEqual([
      { relname: 'idx_fhir_vital_observation_receipts_patient', indisvalid: true },
      { relname: 'idx_fhir_vital_observation_sets_patient', indisvalid: true },
      { relname: 'ux_fhir_vital_observation_receipt_logical_resource', indisvalid: true },
    ]);
    const invalidRebuildIndexes = await scratch.query(
      `SELECT relname FROM pg_class
        WHERE relname = ANY($1::text[])`,
      [[
        'idx_fhir_vital_receipts_invalid_rebuild',
        'idx_fhir_vital_sets_invalid_rebuild',
        'ux_fhir_vital_logical_invalid_rebuild',
      ]],
    );
    expect(invalidRebuildIndexes.rows).toEqual([]);
    const atCutPoint = await scratch.query(
      `SELECT COUNT(*)::integer AS count
         FROM pg_constraint
        WHERE conname = 'ux_fhir_vital_observation_resource_owner'`,
    );
    expect(atCutPoint.rows[0].count).toBe(1);

    for (const statement of statements.slice(cutPoint + 1)) await scratch.query(statement);
    const migrationOnlyPrivileges = await scratch.query(
      `SELECT
         has_table_privilege($1, 'public.fhir_vital_observation_sets', 'UPDATE') AS table_update,
         has_column_privilege($1, 'public.fhir_vital_observation_sets', 'patient_uid', 'UPDATE') AS patient_update,
         has_column_privilege($1, 'public.fhir_vital_observation_sets', 'vitals_chart_id', 'UPDATE') AS link_update,
         has_column_privilege($1, 'public.fhir_vital_observation_sets', 'anomaly_effects_completed_at', 'UPDATE') AS effect_update`,
      [migrationRuntimeRole],
    );
    expect(migrationOnlyPrivileges.rows[0]).toEqual({
      table_update: false,
      patient_update: true,
      link_update: true,
      effect_update: true,
    });

    const tenantA = '00000000-0000-4000-8000-000000000101';
    const tenantB = '00000000-0000-4000-8000-000000000102';
    const patientA = '00000000-0000-4000-8000-000000000201';
    const patientB = '00000000-0000-4000-8000-000000000202';
    const patientOther = '00000000-0000-4000-8000-000000000203';
    const importerA = '00000000-0000-4000-8000-000000000301';
    const importerB = '00000000-0000-4000-8000-000000000302';
    const resourceFingerprint = `fhir:${'a'.repeat(64)}`;
    const otherPatientFingerprint = `fhir:${'f'.repeat(64)}`;
    const otherTimeFingerprint = `fhir:${'0'.repeat(64)}`;
    const logicalResourceFingerprint = `fhir:${'1'.repeat(64)}`;
    const changedLogicalResourceFingerprint = `fhir:${'2'.repeat(64)}`;
    const setA = `fhir-set:${'b'.repeat(64)}`;
    const setB = `fhir-set:${'c'.repeat(64)}`;
    const setWrongTime = `fhir-set:${'d'.repeat(64)}`;
    const setWrongIdentity = `fhir-set:${'e'.repeat(64)}`;
    const observedAt = new Date('2026-08-10T08:30:00.123Z');

    await scratch.query(`INSERT INTO tenants (id) VALUES ($1), ($2)`, [tenantA, tenantB]);
    await scratch.query(
      `INSERT INTO users (tenant_id, uid)
       VALUES ($1, $3), ($1, $5), ($1, $7), ($2, $4), ($2, $6)`,
      [tenantA, tenantB, patientA, patientB, importerA, importerB, patientOther],
    );
    await scratch.query(
      `INSERT INTO fhir_vital_observation_receipts
         (tenant_id, resource_fingerprint, patient_uid, observed_at, loinc_codes)
       VALUES ($1, $2, $3, $4, ARRAY['8867-4']),
              ($1, $5, $6, $4, ARRAY['8867-4']),
              ($1, $7, $3, $4::timestamptz + INTERVAL '1 second', ARRAY['8867-4'])`,
      [
        tenantA,
        resourceFingerprint,
        patientA,
        observedAt,
        otherPatientFingerprint,
        patientOther,
        otherTimeFingerprint,
      ],
    );
    await scratch.query(
      `INSERT INTO fhir_vital_observation_receipts
         (tenant_id, resource_fingerprint, patient_uid, resource_id, observed_at, loinc_codes)
       VALUES ($1, $2, $3, 'shared-logical-id', $4, ARRAY['8867-4'])`,
      [tenantA, logicalResourceFingerprint, patientA, observedAt],
    );
    await expect(scratch.query(
      `INSERT INTO fhir_vital_observation_receipts
         (tenant_id, resource_fingerprint, patient_uid, resource_id, observed_at, loinc_codes)
       VALUES ($1, $2, $3, 'shared-logical-id', $4, ARRAY['8867-4'])`,
      [tenantA, changedLogicalResourceFingerprint, patientA, observedAt],
    )).rejects.toMatchObject({
      code: '23505',
      constraint: 'ux_fhir_vital_observation_receipt_logical_resource',
    });
    await expect(scratch.query(
      `INSERT INTO fhir_vital_observation_receipts
         (tenant_id, resource_fingerprint, patient_uid, resource_id, observed_at, loinc_codes)
       VALUES ($1, $2, $3, 'shared-logical-id', $4, ARRAY['8867-4'])`,
      [tenantA, changedLogicalResourceFingerprint, patientOther, observedAt],
    )).resolves.toMatchObject({ rowCount: 1 });
    await scratch.query(
      `INSERT INTO fhir_vital_observation_sets
         (tenant_id, set_fingerprint, patient_uid, observed_at, imported_by)
       VALUES ($1, $2, $3, $7, $4),
              ($1, $5, $3, $7, $4),
              ($1, $6, $3, $7, $4),
              ($1, $8, $3, $7, $4)`,
      [tenantA, setA, patientA, importerA, setB, setWrongTime, observedAt, setWrongIdentity],
    );
    await scratch.query(
      `INSERT INTO fhir_vital_observation_set_resources
         (tenant_id, set_fingerprint, resource_fingerprint)
       VALUES ($1, $2, $3)`,
      [tenantA, setA, resourceFingerprint],
    );
    await expect(scratch.query(
      `INSERT INTO fhir_vital_observation_set_resources
         (tenant_id, set_fingerprint, resource_fingerprint)
       VALUES ($1, $2, $3)`,
      [tenantA, setB, resourceFingerprint],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(scratch.query(
      `INSERT INTO fhir_vital_observation_set_resources
         (tenant_id, set_fingerprint, resource_fingerprint)
       VALUES ($1, $2, $3)`,
      [tenantA, setB, otherPatientFingerprint],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'chk_fhir_vital_observation_resource_owner_scope',
    });
    await expect(scratch.query(
      `INSERT INTO fhir_vital_observation_set_resources
         (tenant_id, set_fingerprint, resource_fingerprint)
       VALUES ($1, $2, $3)`,
      [tenantA, setB, otherTimeFingerprint],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'chk_fhir_vital_observation_resource_owner_scope',
    });

    const exactVitals = await scratch.query(
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, source, source_device, recorded_at)
       VALUES ($1, $2, 'fhir', $3, $4) RETURNING id`,
      [tenantA, patientA, setA, observedAt],
    );
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET news2_effects_completed_at = clock_timestamp()
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'chk_fhir_vital_observation_set_effects_linked',
    });
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET news2_effects_claimed_at = clock_timestamp(),
              news2_effects_claim_token = '00000000-0000-4000-8000-000000000101'::uuid
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'chk_fhir_vital_observation_set_effects_linked',
    });
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET vitals_chart_id = $3
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA, exactVitals.rows[0].id],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET news2_effects_claimed_at = clock_timestamp()
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'chk_fhir_vital_observation_set_news2_claim',
    });
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET news2_effects_claimed_at = clock_timestamp(),
              news2_effects_claim_token = '00000000-0000-4000-8000-000000000102'::uuid,
              news2_effects_attempts = news2_effects_attempts + 1,
              anomaly_effects_claimed_at = clock_timestamp(),
              anomaly_effects_claim_token = '00000000-0000-4000-8000-000000000103'::uuid,
              anomaly_effects_attempts = anomaly_effects_attempts + 1
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET news2_effects_completed_at = clock_timestamp(),
              news2_effects_claimed_at = NULL,
              news2_effects_claim_token = NULL,
              anomaly_effects_completed_at = clock_timestamp(),
              anomaly_effects_claimed_at = NULL,
              anomaly_effects_claim_token = NULL
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET anomaly_effects_completed_at = NULL
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'chk_fhir_vital_observation_set_effects_immutable',
    });
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET news2_effects_attempts = news2_effects_attempts + 1
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'chk_fhir_vital_observation_set_effects_immutable',
    });

    const replacementVitals = await scratch.query(
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, source, source_device, recorded_at)
       VALUES ($1, $2, 'fhir', $3, $4) RETURNING id`,
      [tenantA, patientA, setA, observedAt],
    );
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET vitals_chart_id = $3
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA, replacementVitals.rows[0].id],
    )).rejects.toMatchObject({ code: '23514', constraint: 'chk_fhir_vital_observation_set_link_immutable' });
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET vitals_chart_id = NULL
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setA],
    )).rejects.toMatchObject({ code: '23514', constraint: 'chk_fhir_vital_observation_set_link_immutable' });

    const wrongTimeVitals = await scratch.query(
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, source, source_device, recorded_at)
       VALUES ($1, $2, 'fhir', $3, $4::timestamptz + INTERVAL '1 second') RETURNING id`,
      [tenantA, patientA, setWrongTime, observedAt],
    );
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET vitals_chart_id = $3
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setWrongTime, wrongTimeVitals.rows[0].id],
    )).rejects.toMatchObject({ code: '23514', constraint: 'chk_fhir_vital_observation_set_vitals_scope' });

    const wrongIdentityVitals = await scratch.query(
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, source, source_device, recorded_at)
       VALUES ($1, $2, 'fhir', $3, $4) RETURNING id`,
      [tenantA, patientA, setA, observedAt],
    );
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET vitals_chart_id = $3
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setWrongIdentity, wrongIdentityVitals.rows[0].id],
    )).rejects.toMatchObject({ code: '23514', constraint: 'chk_fhir_vital_observation_set_vitals_scope' });

    const foreignVitals = await scratch.query(
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, source, source_device, recorded_at)
       VALUES ($1, $2, 'fhir', $3, $4) RETURNING id`,
      [tenantB, patientB, setB, observedAt],
    );
    await expect(scratch.query(
      `UPDATE fhir_vital_observation_sets
          SET vitals_chart_id = $3
        WHERE tenant_id = $1 AND set_fingerprint = $2`,
      [tenantA, setB, foreignVitals.rows[0].id],
    )).rejects.toMatchObject({ code: '23514', constraint: 'chk_fhir_vital_observation_set_vitals_scope' });

    const validIndexOids = await scratch.query(
      `SELECT index_class.relname, index_class.oid::text AS oid
         FROM pg_index index_state
         JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
        WHERE index_class.relname = ANY($1::text[])
        ORDER BY index_class.relname`,
      [[
        'idx_fhir_vital_observation_receipts_patient',
        'idx_fhir_vital_observation_sets_pending_effects',
        'idx_fhir_vital_observation_sets_patient',
        'ux_fhir_vital_observation_receipt_logical_resource',
      ]],
    );

    for (const statement of statements) await scratch.query(statement);
    const oxygenEvidenceColumn = await scratch.query(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'news2_scores'
          AND column_name = 'supplemental_o2'`,
    );
    expect(oxygenEvidenceColumn.rows).toEqual([{
      is_nullable: 'YES',
      column_default: 'false',
    }]);
    const replayedIndexOids = await scratch.query(
      `SELECT index_class.relname, index_class.oid::text AS oid
         FROM pg_index index_state
         JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
        WHERE index_class.relname = ANY($1::text[])
        ORDER BY index_class.relname`,
      [[
        'idx_fhir_vital_observation_receipts_patient',
        'idx_fhir_vital_observation_sets_pending_effects',
        'idx_fhir_vital_observation_sets_patient',
        'ux_fhir_vital_observation_receipt_logical_resource',
      ]],
    );
    expect(replayedIndexOids.rows).toEqual(validIndexOids.rows);
    const patientForeignKeys = await scratch.query(
      `SELECT conname, condeferrable, condeferred
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [[
        'fk_fhir_vital_observation_receipt_patient',
        'fk_fhir_vital_observation_set_patient',
      ]],
    );
    expect(patientForeignKeys.rows).toEqual([
      {
        conname: 'fk_fhir_vital_observation_receipt_patient',
        condeferrable: true,
        condeferred: false,
      },
      {
        conname: 'fk_fhir_vital_observation_set_patient',
        condeferrable: true,
        condeferred: false,
      },
    ]);
    const policies = await scratch.query(
      `SELECT COUNT(*)::integer AS count
         FROM pg_policy
        WHERE polrelid = ANY($1::regclass[])`,
      [[
        'fhir_vital_observation_receipts',
        'fhir_vital_observation_sets',
        'fhir_vital_observation_set_resources',
      ]],
    );
    expect(policies.rows[0].count).toBe(6);

    const priorEnvironment = {
      databaseUrl: process.env.DATABASE_URL,
      databaseReadUrl: process.env.DATABASE_READ_URL,
      runtimeRole: process.env.AUTH_TENANT_RLS_RUNTIME_ROLE,
    };
    let runtimePrisma;
    try {
      process.env.DATABASE_URL = scratchUrl.toString();
      delete process.env.DATABASE_READ_URL;
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = runtimeRole;
      const runtimeModule = await import(`../lib/prisma.js?fhir-runtime-fence=${Date.now()}`);
      runtimePrisma = runtimeModule.default;
      await expect(runtimeModule.ensureTenantRlsRuntimeRoleGrants()).resolves.toEqual({
        skipped: false,
        role: runtimeRole,
      });
    } finally {
      await runtimePrisma?.$disconnect().catch(() => {});
      if (priorEnvironment.databaseUrl == null) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorEnvironment.databaseUrl;
      if (priorEnvironment.databaseReadUrl == null) delete process.env.DATABASE_READ_URL;
      else process.env.DATABASE_READ_URL = priorEnvironment.databaseReadUrl;
      if (priorEnvironment.runtimeRole == null) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = priorEnvironment.runtimeRole;
    }

    const runtimePrivileges = await scratch.query(
      `SELECT
         has_table_privilege($1, 'public.fhir_vital_observation_receipts', 'SELECT') AS receipt_select,
         has_table_privilege($1, 'public.fhir_vital_observation_receipts', 'INSERT') AS receipt_insert,
         has_table_privilege($1, 'public.fhir_vital_observation_receipts', 'UPDATE') AS receipt_update,
         has_column_privilege($1, 'public.fhir_vital_observation_receipts', 'patient_uid', 'UPDATE') AS receipt_patient_update,
         has_table_privilege($1, 'public.fhir_vital_observation_receipts', 'DELETE') AS receipt_delete,
         has_table_privilege($1, 'public.fhir_vital_observation_sets', 'SELECT') AS set_select,
         has_table_privilege($1, 'public.fhir_vital_observation_sets', 'INSERT') AS set_insert,
         has_table_privilege($1, 'public.fhir_vital_observation_sets', 'UPDATE') AS set_table_update,
         has_column_privilege($1, 'public.fhir_vital_observation_sets', 'vitals_chart_id', 'UPDATE') AS set_link_update,
         has_column_privilege($1, 'public.fhir_vital_observation_sets', 'patient_uid', 'UPDATE') AS set_patient_update,
         has_table_privilege($1, 'public.fhir_vital_observation_sets', 'DELETE') AS set_delete,
         has_table_privilege($1, 'public.fhir_vital_observation_set_resources', 'SELECT') AS link_select,
         has_table_privilege($1, 'public.fhir_vital_observation_set_resources', 'INSERT') AS link_insert,
         has_table_privilege($1, 'public.fhir_vital_observation_set_resources', 'UPDATE') AS link_update,
         has_table_privilege($1, 'public.fhir_vital_observation_set_resources', 'DELETE') AS link_delete,
         has_function_privilege($1, 'public.validate_fhir_vital_observation_set_link()', 'EXECUTE') AS set_guard_execute,
         has_function_privilege($1, 'public.validate_fhir_vital_observation_receipt_update()', 'EXECUTE') AS receipt_guard_execute,
         has_function_privilege($1, 'public.validate_fhir_vital_observation_receipt_scope_deferred()', 'EXECUTE') AS receipt_deferred_guard_execute,
         has_function_privilege($1, 'public.validate_fhir_vital_observation_set_scope_deferred()', 'EXECUTE') AS deferred_guard_execute,
         has_function_privilege($1, 'public.validate_fhir_vital_observation_resource_owner()', 'EXECUTE') AS link_guard_execute`,
      [runtimeRole],
    );
    expect(runtimePrivileges.rows[0]).toEqual({
      receipt_select: true,
      receipt_insert: true,
      receipt_update: false,
      receipt_patient_update: true,
      receipt_delete: false,
      set_select: true,
      set_insert: true,
      set_table_update: false,
      set_link_update: true,
      set_patient_update: true,
      set_delete: false,
      link_select: true,
      link_insert: true,
      link_update: false,
      link_delete: false,
      set_guard_execute: false,
      receipt_guard_execute: false,
      receipt_deferred_guard_execute: false,
      deferred_guard_execute: false,
      link_guard_execute: false,
    });

    await scratch.query('BEGIN');
    try {
      await scratch.query(`SET LOCAL ROLE ${runtimeRole}`);
      await scratch.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await scratch.query(`SELECT set_config('app.patient_merge_execution', 'on', true)`);
      await scratch.query(`SELECT set_config('app.patient_merge_request_id', '999999999', true)`);
      await scratch.query(`SELECT set_config('app.patient_merge_tenant_id', $1, true)`, [tenantA]);
      await scratch.query(`SELECT set_config('app.patient_merge_from_uid', $1, true)`, [patientA]);
      await scratch.query(`SELECT set_config('app.patient_merge_to_uid', $1, true)`, [patientOther]);
      await expect(scratch.query(
        `UPDATE public.fhir_vital_observation_receipts
            SET patient_uid = $3
          WHERE tenant_id = $1 AND resource_fingerprint = $2`,
        [tenantA, resourceFingerprint, patientOther],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'chk_fhir_vital_observation_receipt_immutable',
      });
    } finally {
      await scratch.query('ROLLBACK').catch(() => {});
    }

    await scratch.query('BEGIN');
    try {
      await scratch.query(`SET LOCAL ROLE ${runtimeRole}`);
      await scratch.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await expect(scratch.query(
        `UPDATE public.fhir_vital_observation_receipts
            SET patient_uid = $3
          WHERE tenant_id = $1 AND resource_fingerprint = $2`,
        [tenantA, resourceFingerprint, patientOther],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'chk_fhir_vital_observation_receipt_immutable',
      });
    } finally {
      await scratch.query('ROLLBACK');
    }

    await scratch.query('BEGIN');
    try {
      await scratch.query(`SET LOCAL ROLE ${runtimeRole}`);
      await scratch.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await expect(scratch.query(
        `DELETE FROM public.fhir_vital_observation_receipts
          WHERE tenant_id = $1 AND resource_fingerprint = $2`,
        [tenantA, resourceFingerprint],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await scratch.query('ROLLBACK');
    }
  });
});
