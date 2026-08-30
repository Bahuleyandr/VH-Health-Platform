import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

import { executeCiMigrationFile } from '../../../scripts/lib/ciMigrationExecutor.mjs';
import {
  buildPayrollRevision754Receipt,
  collectPayrollRevision754Manifest,
  lockAndAssertPayrollRevision754Acceptance,
  lockPayrollRevision754Tables,
} from '../../../scripts/payroll-revision-754-preflight.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/754_salary_revision_tenant_reconciliation.sql', import.meta.url),
  'utf8',
);

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

async function expectPgFailure(operation, code, constraint) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  expect(failure).toMatchObject({ code, constraint });
}

describe('migration 754 salary-revision tenant reconciliation contract', () => {
  test('uses identity authority, dependent-row coherence, dual-layer FKs, and restrictive RLS', () => {
    expect(migrationSql).toContain('ALTER COLUMN tenant_id DROP DEFAULT');
    expect(migrationSql).toContain("set_config('app.current_tenant_id', 'bypass', true)");
    expect(migrationSql).not.toContain('00000000-0000-4000-8000-000000000001');
    expect(migrationSql).toContain('arrears.tenant_id AS observed_tenant_id');
    expect(migrationSql).toContain('reminder.tenant_id AS observed_tenant_id');
    expect(migrationSql).toContain("THEN 'auto_repaired'");
    expect(migrationSql).not.toMatch(/DROP CONSTRAINT IF EXISTS salary_revisions_staff_uid_fkey/i);
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, staff_uid) REFERENCES users (tenant_id, uid)');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, proposed_by) REFERENCES users (tenant_id, uid)');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, hr_signed_by) REFERENCES users (tenant_id, uid)');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, admin_signed_by) REFERENCES users (tenant_id, uid)');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, rejected_by) REFERENCES users (tenant_id, uid)');
    expect(migrationSql).toContain('AS RESTRICTIVE');
    expect(migrationSql).toContain('tenant_reconciliation_required = FALSE');
  });
});

describeIfDb('migration 754 salary-revision tenant reconciliation behavior', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const schemaName = `salary_revision_754_${suffix}`;
  const readerRole = `salary_revision_754_reader_${suffix}`;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const staffA = randomUUID();
  const proposerA = randomUUID();
  const staffB = randomUUID();
  const proposerB = randomUUID();
  let firstPassSnapshot;
  let firstPassArrearsSnapshot;
  let firstPassReminderSnapshot;

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await client.query(`CREATE ROLE ${readerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`
      CREATE FUNCTION app_current_tenant_id_uuid() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$
        SELECT NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
      $$;

      CREATE TABLE users (
        uid uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        UNIQUE (tenant_id, uid)
      );

      CREATE TABLE salary_revisions (
        id serial PRIMARY KEY,
        revision_number varchar(30) NOT NULL,
        tenant_id uuid NOT NULL DEFAULT '${tenantA}'::uuid,
        staff_uid uuid,
        proposed_by uuid,
        hr_signed_by uuid,
        admin_signed_by uuid,
        rejected_by uuid,
        revision_type varchar(30) NOT NULL DEFAULT 'increment',
        current_basic numeric(12, 2) DEFAULT 40000,
        proposed_basic numeric(12, 2) DEFAULT 41000,
        current_gross numeric(12, 2) DEFAULT 60000,
        proposed_gross numeric(12, 2) DEFAULT 61500,
        increment_amount numeric(12, 2) DEFAULT 1000,
        increment_pct numeric(5, 2) DEFAULT 2.5,
        bonus_amount numeric(12, 2),
        bonus_reason text,
        other_changes jsonb,
        effective_from date NOT NULL DEFAULT '2099-01-01',
        reason text NOT NULL DEFAULT 'legacy migration fixture',
        proposed_at timestamptz DEFAULT now(),
        hr_signed_at timestamptz,
        hr_comment text,
        admin_signed_at timestamptz,
        admin_comment text,
        status varchar(30) NOT NULL DEFAULT 'pending_hr',
        rejected_at timestamptz,
        rejection_reason text,
        applied_at timestamptz,
        signature_hash varchar(64),
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT salary_revisions_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES users(uid),
        CONSTRAINT salary_revisions_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES users(uid),
        CONSTRAINT salary_revisions_hr_signed_by_fkey FOREIGN KEY (hr_signed_by) REFERENCES users(uid),
        CONSTRAINT salary_revisions_admin_signed_by_fkey FOREIGN KEY (admin_signed_by) REFERENCES users(uid),
        CONSTRAINT salary_revisions_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES users(uid)
      );
      CREATE UNIQUE INDEX uniq_salary_revisions_tenant_revision_number
        ON salary_revisions (tenant_id, revision_number);

      CREATE TABLE salary_arrears (
        id serial PRIMARY KEY,
        tenant_id uuid NOT NULL,
        staff_uid uuid,
        revision_id integer,
        from_month integer NOT NULL DEFAULT 1,
        from_year integer NOT NULL DEFAULT 2025,
        to_month integer NOT NULL DEFAULT 1,
        to_year integer NOT NULL DEFAULT 2025,
        arrears_amount numeric(12, 2) NOT NULL DEFAULT 100,
        paid_in_month integer,
        paid_in_year integer,
        payslip_id integer,
        status varchar(20) DEFAULT 'pending',
        calculated_at timestamptz DEFAULT now(),
        CONSTRAINT salary_arrears_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES users(uid),
        CONSTRAINT salary_arrears_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES salary_revisions(id)
      );
      CREATE TABLE annual_review_reminders (
        id serial PRIMARY KEY,
        tenant_id uuid NOT NULL,
        staff_uid uuid,
        revision_id integer,
        review_year integer NOT NULL DEFAULT 2025,
        reminder_sent_at timestamptz,
        status varchar(20) DEFAULT 'pending',
        created_at timestamptz DEFAULT now(),
        CONSTRAINT annual_review_reminders_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES users(uid),
        CONSTRAINT annual_review_reminders_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES salary_revisions(id)
      );

      CREATE TABLE payslips (
        id serial PRIMARY KEY,
        tenant_id uuid NOT NULL,
        staff_uid uuid,
        payroll_run_id integer,
        generation_attempt_token uuid,
        UNIQUE (tenant_id, id)
      );

      CREATE TABLE payroll_runs (
        id serial PRIMARY KEY,
        tenant_id uuid NOT NULL,
        UNIQUE (tenant_id, id)
      );
      CREATE UNIQUE INDEX ux_payslips_attempt_staff_binding
        ON payslips (tenant_id, id, payroll_run_id, generation_attempt_token, staff_uid);

      CREATE TABLE bulk_revision_jobs (
        id serial PRIMARY KEY,
        description text NOT NULL,
        revision_type varchar(20) NOT NULL,
        target_type varchar(20) NOT NULL,
        target_value varchar(100),
        increment_type varchar(10),
        increment_value numeric(10, 2),
        bonus_amount numeric(10, 2),
        effective_from date NOT NULL,
        staff_count integer DEFAULT 0,
        processed_count integer DEFAULT 0,
        status varchar(20) DEFAULT 'draft',
        approved_by uuid,
        approved_at timestamptz,
        completed_at timestamptz,
        error_log text,
        created_by uuid,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        tenant_id uuid NOT NULL
      );

      CREATE POLICY tenant_isolation ON salary_revisions
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        );
      CREATE POLICY tenant_isolation ON salary_arrears
        USING (tenant_id = app_current_tenant_id_uuid())
        WITH CHECK (tenant_id = app_current_tenant_id_uuid());
      CREATE POLICY tenant_isolation ON annual_review_reminders
        USING (tenant_id = app_current_tenant_id_uuid())
        WITH CHECK (tenant_id = app_current_tenant_id_uuid());
    `);
    await client.query(
      `INSERT INTO users (uid, tenant_id) VALUES
         ($1::uuid, $2::uuid), ($3::uuid, $2::uuid),
         ($4::uuid, $5::uuid), ($6::uuid, $5::uuid)`,
      [staffA, tenantA, proposerA, staffB, tenantB, proposerB],
    );

    const seeded = await client.query(
      `INSERT INTO salary_revisions
         (revision_number, tenant_id, staff_uid, proposed_by)
       VALUES
         ('REPAIR-B', $1::uuid, $2::uuid, $3::uuid),
         ('OWNED-A', $1::uuid, $4::uuid, $5::uuid),
         ('CONFLICT', $1::uuid, $4::uuid, $3::uuid),
         ('UNOWNED', $1::uuid, NULL, NULL),
         ('COLLISION', $1::uuid, $4::uuid, NULL),
         ('COLLISION', $6::uuid, NULL, $5::uuid),
         ('DEPENDENT-OWNER', $1::uuid, $4::uuid, NULL),
         ('DEPENDENT-ROW', $1::uuid, $4::uuid, NULL),
         ('LEGACY-BONUS', $1::uuid, $4::uuid, $5::uuid)
       RETURNING id, revision_number`,
      [tenantA, staffB, proposerB, staffA, proposerA, tenantB],
    );
    const idFor = (number, occurrence = 0) => seeded.rows
      .filter((row) => row.revision_number === number)[occurrence].id;
    await client.query(
      `INSERT INTO annual_review_reminders (tenant_id, staff_uid, revision_id)
       VALUES ($1::uuid, $2::uuid, $3::int)`,
      [tenantA, staffB, idFor('DEPENDENT-OWNER')],
    );
    await client.query(
      `INSERT INTO salary_arrears (tenant_id, staff_uid, revision_id)
       VALUES ($1::uuid, $2::uuid, $3::int)`,
      [tenantB, staffA, idFor('DEPENDENT-ROW')],
    );
    await client.query(
      `INSERT INTO salary_arrears (tenant_id, staff_uid, revision_id)
       VALUES ($1::uuid, $2::uuid, $3::int)`,
      [tenantA, staffA, idFor('OWNED-A')],
    );
    await client.query(
      `UPDATE salary_revisions
          SET revision_type = 'bonus', bonus_amount = 2500,
              status = 'applied', applied_at = now()
        WHERE id = $1::int`,
      [idFor('LEGACY-BONUS')],
    );
    await client.query(
      `INSERT INTO salary_arrears (tenant_id, staff_uid, revision_id)
       VALUES ($1::uuid, $2::uuid, NULL)`,
      [tenantA, staffA],
    );
    await client.query(
      `INSERT INTO annual_review_reminders (tenant_id, staff_uid, revision_id)
       VALUES ($1::uuid, $2::uuid, $3::int)`,
      [tenantA, staffA, idFor('OWNED-A')],
    );
    await client.query(
      `INSERT INTO annual_review_reminders (tenant_id, staff_uid, revision_id)
       VALUES ($1::uuid, $2::uuid, NULL)`,
      [tenantB, staffA],
    );

    await client.query(migrationSql);
    await client.query("SELECT set_config('app.current_tenant_id', 'bypass', false)");
    firstPassSnapshot = (await client.query(
      `SELECT id, revision_number, tenant_id, tenant_reconciliation_required,
              tenant_reconciliation_reason, tenant_reconciliation_evidence,
              tenant_reconciled_at
         FROM salary_revisions
        ORDER BY id`,
    )).rows;
    firstPassArrearsSnapshot = (await client.query(
      `SELECT id, tenant_id, staff_uid, revision_id, status,
              tenant_reconciliation_required, tenant_reconciliation_reason,
              tenant_reconciliation_evidence, tenant_reconciled_at
         FROM salary_arrears
        ORDER BY id`,
    )).rows;
    firstPassReminderSnapshot = (await client.query(
      `SELECT id, tenant_id, staff_uid, revision_id, status,
              tenant_reconciliation_required, tenant_reconciliation_reason,
              tenant_reconciliation_evidence, tenant_reconciled_at
         FROM annual_review_reminders
        ORDER BY id`,
    )).rows;
    await client.query(migrationSql);
    await client.query("SELECT set_config('app.current_tenant_id', 'bypass', false)");
  }, 30000);

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
    await client.query(`DROP ROLE IF EXISTS ${readerRole}`).catch(() => {});
    await client.end().catch(() => {});
  }, 30000);

  test('repairs only unanimous ownership and quarantines every uncertain assignment idempotently', async () => {
    const secondPass = (await client.query(
      `SELECT id, revision_number, tenant_id, tenant_reconciliation_required,
              tenant_reconciliation_reason, tenant_reconciliation_evidence,
              tenant_reconciled_at
         FROM salary_revisions
        ORDER BY id`,
    )).rows;
    expect(secondPass).toEqual(firstPassSnapshot);

    const byNumber = (number) => secondPass.filter((row) => row.revision_number === number);
    expect(byNumber('REPAIR-B')[0]).toMatchObject({
      tenant_id: null,
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'revision_financial_shape_invalid',
    });
    expect(byNumber('OWNED-A')[0]).toMatchObject({
      tenant_id: null,
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'revision_financial_shape_invalid',
    });
    expect(byNumber('CONFLICT')[0]).toMatchObject({
      tenant_id: null,
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'revision_financial_shape_invalid',
    });
    expect(byNumber('UNOWNED')[0]).toMatchObject({
      tenant_id: null,
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'identity_unowned',
    });
    expect(byNumber('COLLISION')).toHaveLength(2);
    expect(byNumber('COLLISION').map((row) => row.tenant_reconciliation_reason).sort()).toEqual([
      'proposer_identity_missing',
      'subject_identity_missing',
    ]);
    expect(byNumber('DEPENDENT-OWNER')[0].tenant_reconciliation_reason)
      .toBe('proposer_identity_missing');
    expect(byNumber('DEPENDENT-ROW')[0].tenant_reconciliation_reason)
      .toBe('proposer_identity_missing');
    expect(byNumber('LEGACY-BONUS')[0]).toMatchObject({
      tenant_id: null,
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'revision_lifecycle_evidence_missing',
    });

    const arrears = (await client.query(
      `SELECT id, tenant_id, staff_uid, revision_id, status,
              tenant_reconciliation_required, tenant_reconciliation_reason,
              tenant_reconciliation_evidence, tenant_reconciled_at
         FROM salary_arrears
        ORDER BY id`,
    )).rows;
    const reminders = (await client.query(
      `SELECT id, tenant_id, staff_uid, revision_id, status,
              tenant_reconciliation_required, tenant_reconciliation_reason,
              tenant_reconciliation_evidence, tenant_reconciled_at
         FROM annual_review_reminders
        ORDER BY id`,
    )).rows;
    expect(arrears).toEqual(firstPassArrearsSnapshot);
    expect(reminders).toEqual(firstPassReminderSnapshot);
    expect(arrears[0]).toMatchObject({
      tenant_id: null,
      staff_uid: staffA,
      revision_id: null,
      status: 'reconciliation_required',
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'parent_revision_quarantined',
    });
    expect(arrears[1]).toMatchObject({
      tenant_id: null,
      staff_uid: staffA,
      revision_id: null,
      status: 'reconciliation_required',
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'parent_revision_quarantined',
    });
    expect(arrears[2]).toMatchObject({
      tenant_id: null,
      staff_uid: staffA,
      revision_id: null,
      status: 'reconciliation_required',
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'revision_identity_missing',
    });
    expect(reminders[0]).toMatchObject({
      tenant_id: null,
      revision_id: null,
      status: 'reconciliation_required',
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'parent_revision_quarantined',
    });
    expect(reminders[1]).toMatchObject({
      tenant_id: null,
      staff_uid: staffA,
      revision_id: null,
      status: 'reconciliation_required',
      tenant_reconciliation_required: true,
      tenant_reconciliation_reason: 'parent_revision_quarantined',
    });
    expect(reminders[2]).toMatchObject({
      tenant_id: tenantA,
      staff_uid: staffA,
      revision_id: null,
      status: 'pending',
      tenant_reconciliation_required: false,
      tenant_reconciliation_reason: null,
    });
    expect(reminders[2].tenant_reconciliation_evidence).toMatchObject({
      action: 'auto_repaired',
      observed_tenant_id: tenantB,
      resolved_tenant_id: tenantA,
    });

    const legacyPayables = (await client.query(
      `SELECT id FROM salary_revision_payables
        WHERE revision_id = (
          SELECT id FROM salary_revisions WHERE revision_number = 'LEGACY-BONUS'
        )`,
    )).rows;
    expect(legacyPayables).toEqual([]);
  });

  test('drops inferred tenant defaults and enforces identity and tenant coherence structurally', async () => {
    const column = await client.query(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'salary_revisions' AND column_name = 'tenant_id'`,
      [schemaName],
    );
    expect(column.rows[0].column_default).toBeNull();

    await expectPgFailure(
      () => client.query(
        `INSERT INTO salary_revisions (
           revision_number, staff_uid, proposed_by, revision_type,
           current_basic, proposed_basic, current_gross, proposed_gross,
           increment_amount, increment_pct, effective_from, reason, salary_baseline,
           tenant_reconciliation_required, tenant_reconciliation_evidence
         ) VALUES (
           'NO-TENANT', $1::uuid, $2::uuid, 'increment',
           40000, 41000, 60000, 61500, 1000, 2.5, '2099-01-01',
           'post-migration missing-tenant fixture',
           '{"basic_salary":40000,"hra_pct":40,"da_pct":10,"special_allowance":0,
             "transport_allowance":0,"medical_allowance":0,"tds_monthly":0,
             "pf_employee_pct":12,"esi_applicable":true}'::jsonb,
           false, '{}'::jsonb
         )`,
        [staffA, proposerA],
      ),
      '23514',
      'chk_salary_revisions_tenant_reconciliation',
    );
    const validRevision = (await client.query(
      `INSERT INTO salary_revisions (
         revision_number, tenant_id, staff_uid, proposed_by, revision_type,
         current_basic, proposed_basic, current_gross, proposed_gross,
         increment_amount, increment_pct, effective_from, reason, salary_baseline,
         tenant_reconciliation_required, tenant_reconciliation_evidence
       ) VALUES (
         'VALID-POST-754', $1::uuid, $2::uuid, $3::uuid, 'increment',
         40000, 41000, 60000, 61500, 1000, 2.5, '2099-01-01',
         'post-migration structural fixture',
         '{"basic_salary":40000,"hra_pct":40,"da_pct":10,"special_allowance":0,
           "transport_allowance":0,"medical_allowance":0,"tds_monthly":0,
           "pf_employee_pct":12,"esi_applicable":true}'::jsonb,
         false, '{}'::jsonb
       ) RETURNING id`,
      [tenantA, staffA, proposerA],
    )).rows[0];
    await expectPgFailure(
      () => client.query(
        `UPDATE salary_revisions SET staff_uid = $1::uuid WHERE id = $2::int`,
        [staffB, validRevision.id],
      ),
      '23503',
      'fk_salary_revisions_staff_tenant',
    );
    await expectPgFailure(
      () => client.query(
        `UPDATE salary_revisions
            SET staff_uid = $1::uuid
          WHERE revision_number = 'CONFLICT'`,
        [randomUUID()],
      ),
      '23503',
      'salary_revisions_staff_uid_fkey',
    );
  });

  test('never converts unprovable legacy bonus history into a payable', async () => {
    const rows = (await client.query(
      `SELECT revision.tenant_reconciliation_reason, payable.id AS payable_id
         FROM salary_revisions revision
         LEFT JOIN salary_revision_payables payable ON payable.revision_id = revision.id
        WHERE revision.revision_number = 'LEGACY-BONUS'`,
    )).rows;
    expect(rows).toEqual([{
      tenant_reconciliation_reason: 'revision_lifecycle_evidence_missing',
      payable_id: null,
    }]);
  });

  test('ordinary tenant RLS hides quarantine while bypass retains reconciliation evidence', async () => {
    await client.query(`GRANT USAGE ON SCHEMA ${schemaName} TO ${readerRole}`);
    await client.query(`GRANT SELECT ON ${schemaName}.salary_revisions TO ${readerRole}`);
    await client.query(`GRANT SELECT ON ${schemaName}.salary_arrears TO ${readerRole}`);
    await client.query(`GRANT SELECT ON ${schemaName}.annual_review_reminders TO ${readerRole}`);
    await client.query(`SET ROLE ${readerRole}`);
    await client.query(`SELECT set_config('app.current_tenant_id', $1::text, false)`, [tenantA]);
    const tenantRows = await client.query(
      `SELECT revision_number FROM ${schemaName}.salary_revisions ORDER BY revision_number`,
    );
    expect(tenantRows.rows.map((row) => row.revision_number)).toEqual(['VALID-POST-754']);
    const tenantArrears = await client.query(
      `SELECT tenant_reconciliation_required FROM ${schemaName}.salary_arrears`,
    );
    const tenantReminders = await client.query(
      `SELECT tenant_reconciliation_required FROM ${schemaName}.annual_review_reminders`,
    );
    expect(tenantArrears.rows).toEqual([]);
    expect(tenantReminders.rows).toEqual([{ tenant_reconciliation_required: false }]);

    await client.query("SELECT set_config('app.current_tenant_id', 'bypass', false)");
    const bypassRows = await client.query(
      `SELECT tenant_reconciliation_required FROM ${schemaName}.salary_revisions`,
    );
    expect(bypassRows.rows).toHaveLength(10);
    expect(bypassRows.rows.filter((row) => row.tenant_reconciliation_required)).toHaveLength(9);
    const bypassArrears = await client.query(
      `SELECT tenant_reconciliation_required FROM ${schemaName}.salary_arrears ORDER BY id`,
    );
    const bypassReminders = await client.query(
      `SELECT tenant_reconciliation_required
         FROM ${schemaName}.annual_review_reminders
        ORDER BY id`,
    );
    expect(bypassArrears.rows).toHaveLength(3);
    expect(bypassArrears.rows.filter((row) => row.tenant_reconciliation_required)).toHaveLength(3);
    expect(bypassReminders.rows).toHaveLength(3);
    expect(bypassReminders.rows[0].tenant_reconciliation_required).toBe(true);
    await client.query('RESET ROLE');
  });
});

describeIfDb('migration 754 accepted-manifest transaction fence', () => {
  test('blocks a late writer through apply and aborts a changed accepted manifest', async () => {
    const gateClient = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    const concurrentRunnerClient = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    const writerClient = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    const raceSchema = `salary_revision_754_gate_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const raceTenant = randomUUID();
    const raceUser = randomUUID();
    await gateClient.connect();
    await concurrentRunnerClient.connect();
    await writerClient.connect();
    try {
      await gateClient.query(`CREATE SCHEMA ${raceSchema}`);
      await gateClient.query(`SET search_path TO ${raceSchema}, public`);
      await concurrentRunnerClient.query(`SET search_path TO ${raceSchema}, public`);
      await writerClient.query(`SET search_path TO ${raceSchema}, public`);
      await gateClient.query(`
        CREATE TABLE _migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL
        );
        CREATE TABLE users (
          uid uuid PRIMARY KEY,
          tenant_id uuid NOT NULL
        );
        CREATE TABLE payslips (
          id serial PRIMARY KEY,
          tenant_id uuid NOT NULL,
          staff_uid uuid NOT NULL
        );
        CREATE TABLE salary_revisions (
          id serial PRIMARY KEY,
          revision_number text NOT NULL,
          tenant_id uuid,
          staff_uid uuid,
          proposed_by uuid,
          hr_signed_by uuid,
          admin_signed_by uuid,
          rejected_by uuid,
          revision_type text NOT NULL DEFAULT 'increment',
          status text NOT NULL DEFAULT 'pending_hr',
          effective_from date NOT NULL DEFAULT '2099-01-01',
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        CREATE TABLE salary_arrears (
          id serial PRIMARY KEY,
          tenant_id uuid,
          staff_uid uuid,
          revision_id integer,
          payslip_id integer,
          status text,
          from_year integer,
          from_month integer,
          to_year integer,
          to_month integer
        );
        CREATE TABLE annual_review_reminders (
          id serial PRIMARY KEY,
          tenant_id uuid,
          staff_uid uuid,
          revision_id integer,
          status text,
          review_year integer
        );
        CREATE TABLE bulk_revision_jobs (
          id serial PRIMARY KEY,
          tenant_id uuid,
          created_by uuid,
          approved_by uuid,
          revision_type text,
          target_type text,
          status text,
          effective_from date,
          staff_count integer,
          processed_count integer,
          completed_at timestamptz
        );
      `);
      await gateClient.query(
        `INSERT INTO ${raceSchema}.users (uid, tenant_id) VALUES ($1::uuid, $2::uuid)`,
        [raceUser, raceTenant],
      );
      await gateClient.query(
        `INSERT INTO ${raceSchema}.salary_revisions (
           revision_number, tenant_id, staff_uid
         ) VALUES ('GATE-BASELINE', $2::uuid, $1::uuid)`,
        [raceUser, raceTenant],
      );
      const accepted = buildPayrollRevision754Receipt(
        await collectPayrollRevision754Manifest(gateClient, { schemaName: raceSchema }),
      );
      let releaseGate;
      let lockAcquired;
      const gateReleased = new Promise(resolve => { releaseGate = resolve; });
      const locked = new Promise(resolve => { lockAcquired = resolve; });
      const applyPromise = executeCiMigrationFile({
        client: gateClient,
        file: '754-lock-fence-test.sql',
        sql: `BEGIN;
              ALTER TABLE ${raceSchema}.salary_revisions
                ADD COLUMN locked_migration_applied boolean NOT NULL DEFAULT true;
              COMMIT;`,
        selfManaged: true,
        forceTransactional: true,
        beforeTransaction: async (transactionClient) => {
          await lockAndAssertPayrollRevision754Acceptance(transactionClient, {
            schemaName: raceSchema,
            acceptedManifestSha256: accepted.manifest_sha256,
            acceptedBy: 'Payroll Data Owner',
          });
          lockAcquired();
          await gateReleased;
        },
      });
      await locked;
      let concurrentRunnerSettled = false;
      const concurrentPromise = executeCiMigrationFile({
        client: concurrentRunnerClient,
        file: '754-lock-fence-test.sql',
        sql: `BEGIN;
              ALTER TABLE ${raceSchema}.salary_revisions
                ADD COLUMN concurrent_reapply_should_not_run boolean;
              COMMIT;`,
        selfManaged: true,
        forceTransactional: true,
        beforeTransaction: async (transactionClient) => {
          await lockPayrollRevision754Tables(transactionClient, {
            schemaName: raceSchema,
          });
          const tracked = await transactionClient.query(
            `SELECT 1 FROM ${raceSchema}._migrations WHERE name = $1 LIMIT 1`,
            ['754-lock-fence-test.sql'],
          );
          return tracked.rowCount === 1 ? { skipMigration: true } : null;
        },
      }).finally(() => { concurrentRunnerSettled = true; });
      let writerSettled = false;
      const writerPromise = writerClient.query(
        `INSERT INTO ${raceSchema}.salary_revisions (revision_number)
         VALUES ('GATE-LATE')
         RETURNING locked_migration_applied`,
      ).finally(() => { writerSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 75));
      expect(concurrentRunnerSettled).toBe(false);
      expect(writerSettled).toBe(false);
      releaseGate();
      await applyPromise;
      const concurrentResult = await concurrentPromise;
      expect((await writerPromise).rows[0].locked_migration_applied).toBe(true);
      expect(concurrentResult.mode).toBe('concurrent-already-applied');
      expect((await gateClient.query(
        `SELECT COUNT(*)::int AS count
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'salary_revisions'
            AND column_name = 'concurrent_reapply_should_not_run'`,
        [raceSchema],
      )).rows[0].count).toBe(0);

      const authorityAccepted = buildPayrollRevision754Receipt(
        await collectPayrollRevision754Manifest(gateClient, { schemaName: raceSchema }),
      );
      let releaseAuthorityGate;
      let authorityLockAcquired;
      const authorityGateReleased = new Promise(resolve => { releaseAuthorityGate = resolve; });
      const authorityLocked = new Promise(resolve => { authorityLockAcquired = resolve; });
      const authorityApplyPromise = executeCiMigrationFile({
        client: gateClient,
        file: '754-authority-lock-test.sql',
        sql: `BEGIN;
              ALTER TABLE ${raceSchema}.salary_revisions
                ADD COLUMN authority_lock_applied boolean NOT NULL DEFAULT true;
              COMMIT;`,
        selfManaged: true,
        forceTransactional: true,
        beforeTransaction: async (transactionClient) => {
          await lockAndAssertPayrollRevision754Acceptance(transactionClient, {
            schemaName: raceSchema,
            acceptedManifestSha256: authorityAccepted.manifest_sha256,
            acceptedBy: 'Payroll Data Owner',
          });
          authorityLockAcquired();
          await authorityGateReleased;
        },
      });
      await authorityLocked;
      let authorityWriterSettled = false;
      const authorityWriterPromise = writerClient.query(
        `UPDATE ${raceSchema}.users
            SET tenant_id = $2::uuid
          WHERE uid = $1::uuid
        RETURNING tenant_id`,
        [raceUser, randomUUID()],
      ).finally(() => { authorityWriterSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 75));
      expect(authorityWriterSettled).toBe(false);
      releaseAuthorityGate();
      await authorityApplyPromise;
      await authorityWriterPromise;

      const acceptedBeforeMismatch = buildPayrollRevision754Receipt(
        await collectPayrollRevision754Manifest(gateClient, { schemaName: raceSchema }),
      );
      await writerClient.query(
        `INSERT INTO ${raceSchema}.salary_revisions (revision_number)
         VALUES ('GATE-HASH-MISMATCH')`,
      );
      await expect(executeCiMigrationFile({
        client: gateClient,
        file: '754-hash-fence-test.sql',
        sql: `BEGIN;
              ALTER TABLE ${raceSchema}.salary_revisions
                ADD COLUMN hash_mismatch_should_rollback boolean;
              COMMIT;`,
        selfManaged: true,
        forceTransactional: true,
        beforeTransaction: transactionClient => lockAndAssertPayrollRevision754Acceptance(
          transactionClient,
          {
            schemaName: raceSchema,
            acceptedManifestSha256: acceptedBeforeMismatch.manifest_sha256,
            acceptedBy: 'Payroll Data Owner',
          },
        ),
      })).rejects.toMatchObject({ code: 'PAYROLL_754_MANIFEST_NOT_ACCEPTED' });
      const rolledBack = await gateClient.query(
        `SELECT COUNT(*)::int AS count
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'salary_revisions'
            AND column_name = 'hash_mismatch_should_rollback'`,
        [raceSchema],
      );
      expect(rolledBack.rows[0].count).toBe(0);
      expect((await gateClient.query(
        `SELECT name FROM ${raceSchema}._migrations WHERE name = '754-hash-fence-test.sql'`,
      )).rows).toEqual([]);
    } finally {
      await writerClient.end().catch(() => {});
      await concurrentRunnerClient.end().catch(() => {});
      await gateClient.query(`DROP SCHEMA IF EXISTS ${raceSchema} CASCADE`).catch(() => {});
      await gateClient.end().catch(() => {});
    }
  }, 30000);
});
