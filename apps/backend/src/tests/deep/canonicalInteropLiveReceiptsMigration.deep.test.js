import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jest } from '@jest/globals';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(__dirname, '..', '..', 'migrations', '666_canonical_interop_live_receipts.sql');
const migrationSql = readFileSync(migrationPath, 'utf8');
const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;

jest.setTimeout(90_000);

describe('migration 666 static canonical-interoperability contract', () => {
  test('is runner-atomic and declares the durable outcome and semantic receipts', () => {
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT);\s*$/m);
    expect(migrationSql).toMatch(/CREATE TABLE public\.hl7_inbound_clinical_receipts/);
    expect(migrationSql).toMatch(/UNIQUE \(tenant_id, sender_identity, message_control_id\)/);
    expect(migrationSql).toMatch(/CHECK \(acknowledgement_code = 'AA'\)/);
    expect(migrationSql).toMatch(/CREATE TABLE public\.fhir_allergy_intolerance_receipts/);
    expect(migrationSql).toMatch(/PRIMARY KEY \(tenant_id, resource_fingerprint\)/);
    expect(migrationSql).toMatch(/FOREIGN KEY \(tenant_id, patient_uid\) REFERENCES public\.users\(tenant_id, uid\)/);
    expect(migrationSql.match(/FOREIGN KEY \(tenant_id, patient_uid\)/g)).toHaveLength(2);
    expect(migrationSql.match(/audit_append_only_guard\(\)/g)).toHaveLength(2);
    expect(migrationSql.match(/ALTER TABLE public\.%I FORCE ROW LEVEL SECURITY/g)).toHaveLength(1);
    expect(migrationSql).toMatch(/AS RESTRICTIVE/);
    expect(migrationSql).toMatch(/current_setting\('app\.current_tenant_id', true\) <> 'bypass'/);
  });
});

d('migration 666 constraints and tenant posture (isolated scratch database)', () => {
  const sourceUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const scratchName = `vh_a4_m666_${process.pid}_${Date.now().toString(36)}`;
  let admin;
  let scratch;
  let runtime;
  let runtimeUrl;
  const runtimeRole = `vh_a4_m666_runtime_${process.pid}_${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!/^[a-z0-9_]+$/.test(scratchName)) throw new Error('Unsafe scratch database name');
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = '/postgres';
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN`);
    await admin.query(`CREATE DATABASE ${scratchName}`);

    const scratchUrl = new URL(sourceUrl);
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
      CREATE TABLE public.patient_allergies (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        patient_uid UUID,
        allergy_name VARCHAR(255) NOT NULL,
        UNIQUE (tenant_id, id)
      );
      CREATE TABLE public.clinical_timeline_events (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        UNIQUE (tenant_id, id)
      );
      CREATE TABLE public.clinical_audit_events (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        UNIQUE (tenant_id, id)
      );
      CREATE FUNCTION public.app_current_tenant_id_uuid()
      RETURNS UUID LANGUAGE sql STABLE AS $$
        SELECT NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
      $$;
      CREATE FUNCTION public.audit_append_only_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'append-only';
      END
      $$;
    `);
    await scratch.query(migrationSql);
    await scratch.query(`GRANT CONNECT ON DATABASE ${scratchName} TO ${runtimeRole}`);
    await scratch.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await scratch.query(`GRANT SELECT ON public.fhir_allergy_intolerance_receipts TO ${runtimeRole}`);

    runtimeUrl = new URL(scratchUrl.toString());
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = '';
    runtime = new Client({ connectionString: runtimeUrl.toString() });
    await runtime.connect();
  });

  afterAll(async () => {
    await runtime?.end().catch(() => {});
    await scratch?.end().catch(() => {});
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

  test('enforces tenant-scoped patient and canonical evidence ownership', async () => {
    const tenantA = '00000000-0000-4000-8000-000000000101';
    const tenantB = '00000000-0000-4000-8000-000000000102';
    const patientA = '00000000-0000-4000-8000-000000000201';
    const timelineA = '00000000-0000-4000-8000-000000000301';
    const auditA = '00000000-0000-4000-8000-000000000401';
    await scratch.query('INSERT INTO tenants (id) VALUES ($1), ($2)', [tenantA, tenantB]);
    await scratch.query(
      'INSERT INTO users (tenant_id, uid) VALUES ($1, $2)',
      [tenantA, patientA],
    );
    await scratch.query(
      'INSERT INTO clinical_timeline_events (tenant_id, id) VALUES ($1, $2)',
      [tenantA, timelineA],
    );
    await scratch.query(
      'INSERT INTO clinical_audit_events (tenant_id, id) VALUES ($1, $2)',
      [tenantA, auditA],
    );
    const allergy = await scratch.query(
      `INSERT INTO patient_allergies (tenant_id, patient_uid, allergy_name)
       VALUES ($1, $2, 'Penicillin') RETURNING id`,
      [tenantA, patientA],
    );

    await scratch.query('BEGIN');
    await scratch.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
    await expect(scratch.query(
      `INSERT INTO fhir_allergy_intolerance_receipts
         (tenant_id, resource_fingerprint, payload_sha256, patient_uid,
          allergy_id, timeline_event_id, audit_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantA, 'a'.repeat(64), 'b'.repeat(64), patientA, allergy.rows[0].id, timelineA, auditA],
    )).resolves.toMatchObject({ rowCount: 1 });
    await scratch.query('COMMIT');

    await scratch.query('BEGIN');
    await scratch.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantB]);
    await expect(scratch.query(
      `INSERT INTO hl7_inbound_clinical_receipts
         (tenant_id, sender_identity, message_control_id, message_type,
          payload_sha256, patient_uid, detail_table, detail_id,
          timeline_event_id, audit_event_id)
       VALUES ($1, 'SENDER|SITE', 'CTRL-1', 'ADT^A01', $2, $3,
               'admissions', 1, $4, $5)`,
      [tenantB, 'c'.repeat(64), patientA, timelineA, auditA],
    )).rejects.toMatchObject({ code: '23503' });
    await scratch.query('ROLLBACK');
  });

  test('requires an explicit tenant context and keeps receipts append-only', async () => {
    const tenantA = '00000000-0000-4000-8000-000000000101';
    const patientA = '00000000-0000-4000-8000-000000000201';

    const withoutContext = await runtime.query(
      `SELECT COUNT(*)::int AS count
         FROM fhir_allergy_intolerance_receipts`,
    );
    expect(withoutContext.rows).toEqual([{ count: 0 }]);

    await runtime.query('BEGIN');
    await runtime.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
    const visible = await runtime.query(
      `SELECT COUNT(*)::int AS count
         FROM fhir_allergy_intolerance_receipts
        WHERE patient_uid = $1`,
      [patientA],
    );
    expect(visible.rows).toEqual([{ count: 1 }]);
    await runtime.query('ROLLBACK');

    await scratch.query('BEGIN');
    await scratch.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
    await expect(scratch.query(
      `DELETE FROM fhir_allergy_intolerance_receipts
        WHERE patient_uid = $1`,
      [patientA],
    )).rejects.toMatchObject({ code: '55000' });
    await scratch.query('ROLLBACK');
  });
});
