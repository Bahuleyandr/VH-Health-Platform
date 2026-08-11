import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

import { splitStatements } from '../../utils/migrations/splitStatements.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const RLS_TEST_ROLE = 'rls_test_app';
const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : null;
const databaseName = parsedDatabaseUrl
  ? decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//, ''))
  : '';
const localHostedCiDatabase = process.env.CI === 'true'
  && process.env.GITHUB_ACTIONS === 'true'
  && ['127.0.0.1', 'localhost'].includes(parsedDatabaseUrl?.hostname)
  && /^vhhealth(?:_test)?$/.test(databaseName);
const testIfDisposable = /^vh_a3p6_(?:fresh|recorded)_/.test(databaseName)
  || localHostedCiDatabase
  ? test
  : test.skip;

function migrationSql(name) {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

const migration647 = migrationSql('647_users_abha_number_tenant_unique.sql');
const migration648 = migrationSql('648_icu_flowsheet_bounds_code_status_history.sql');
const migration650 = migrationSql('650_token_epoch_issuance_gate.sql');
const migration652 = migrationSql('652_news2_rescore_supersede_partial.sql');
const migration653 = migrationSql('653_users_abha_verification_gate.sql');
const migration655 = migrationSql('655_audit3_migration_deploy_safety.sql');

describeIfDb('Audit 3 migration deploy-safety posture', () => {
  let client;
  const tenantIds = [randomUUID(), randomUUID()];
  const patientUids = [randomUUID(), randomUUID()];
  const admissionIds = [];
  const historyIds = [];

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();

    for (let index = 0; index < tenantIds.length; index += 1) {
      await client.query(
        `INSERT INTO tenants (id, slug, name)
         VALUES ($1::uuid, $2::text, $3::text)`,
        [
          tenantIds[index],
          `audit3-p6-${tenantIds[index]}`.slice(0, 60),
          `Audit 3 P6 tenant ${index + 1}`,
        ],
      );
      await client.query(
        `INSERT INTO users (tenant_id, uid, name, role, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::text, 'PATIENT', NOW())`,
        [tenantIds[index], patientUids[index], `Audit 3 P6 patient ${index + 1}`],
      );
      const admission = await client.query(
        `INSERT INTO icu_admissions (tenant_id, patient_uid, unit_code)
         VALUES ($1::uuid, $2::uuid, 'MICU')
         RETURNING id`,
        [tenantIds[index], patientUids[index]],
      );
      admissionIds.push(Number(admission.rows[0].id));

      await client.query('BEGIN');
      try {
        await client.query(
          "SELECT set_config('app.current_tenant_id', $1::text, true)",
          [tenantIds[index]],
        );
        const history = await client.query(
          `INSERT INTO icu_code_status_history
             (icu_admission_id, patient_uid, previous_code_status, new_code_status)
           VALUES ($1::integer, $2::uuid, 'full_code', 'dnr')
           RETURNING id, tenant_id::text AS tenant_id`,
          [admissionIds[index], patientUids[index]],
        );
        expect(history.rows[0].tenant_id).toBe(tenantIds[index]);
        historyIds.push(String(history.rows[0].id));
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.audit_bypass', 'on', true)");
      if (historyIds.length) {
        await client.query(
          'DELETE FROM icu_code_status_history WHERE id = ANY($1::bigint[])',
          [historyIds],
        );
      }
      if (admissionIds.length) {
        await client.query(
          'DELETE FROM icu_admissions WHERE id = ANY($1::integer[])',
          [admissionIds],
        );
      }
      await client.query('DELETE FROM users WHERE uid = ANY($1::uuid[])', [patientUids]);
      await client.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }, 30_000);

  test('schema converges on validated tenant-bound restrictive history', async () => {
    const constraints = await client.query(
      `SELECT conname, convalidated, confdeltype,
              pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'public.icu_code_status_history'::regclass
          AND conname IN (
            'fk_icu_code_status_history_tenant',
            'fk_icu_code_status_history_admission_tenant'
          )
        ORDER BY conname`,
    );
    expect(constraints.rows).toEqual([
      expect.objectContaining({
        conname: 'fk_icu_code_status_history_admission_tenant',
        convalidated: true,
        confdeltype: 'r',
        definition: expect.stringContaining('FOREIGN KEY (tenant_id, icu_admission_id)'),
      }),
      expect.objectContaining({
        conname: 'fk_icu_code_status_history_tenant',
        convalidated: true,
        confdeltype: 'r',
        definition: expect.stringContaining('FOREIGN KEY (tenant_id)'),
      }),
    ]);

    const policy = await client.query(
      `SELECT permissive, cmd
         FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'icu_code_status_history'
          AND policyname = 'icu_code_status_history_explicit_context'`,
    );
    expect(policy.rows).toEqual([{ permissive: 'RESTRICTIVE', cmd: 'ALL' }]);

    const posture = await client.query(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE oid = 'public.icu_code_status_history'::regclass`,
    );
    expect(posture.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const provenanceColumn = await client.query(
      `SELECT col_description(
                'public.icu_code_status_history'::regclass,
                attnum
              ) AS comment
         FROM pg_attribute
        WHERE attrelid = 'public.icu_code_status_history'::regclass
          AND attname = 'patient_uid'
          AND NOT attisdropped`,
    );
    expect(provenanceColumn.rows).toHaveLength(1);
    expect(provenanceColumn.rows[0].comment).toMatch(/deprecated immutable provenance/i);
  });

  testIfDisposable('interrupted replay keeps the legacy FK until its replacement is validated', async () => {
    const statements = splitStatements(migration655);
    const dropLegacyIndex = statements.findIndex((statement) => statement.includes(
      'DROP CONSTRAINT IF EXISTS icu_code_status_history_icu_admission_id_fkey',
    ));
    expect(dropLegacyIndex).toBeGreaterThan(0);

    try {
      await client.query(
        `ALTER TABLE public.icu_code_status_history
         DROP CONSTRAINT IF EXISTS icu_code_status_history_icu_admission_id_fkey`,
      );
      await client.query(
        `ALTER TABLE public.icu_code_status_history
         ADD CONSTRAINT icu_code_status_history_icu_admission_id_fkey
         FOREIGN KEY (icu_admission_id)
         REFERENCES public.icu_admissions (id)
         ON DELETE CASCADE
         NOT VALID`,
      );
      await client.query(
        `ALTER TABLE public.icu_code_status_history
         VALIDATE CONSTRAINT icu_code_status_history_icu_admission_id_fkey`,
      );

      for (const statement of statements.slice(0, dropLegacyIndex)) {
        await client.query(statement);
      }
      let constraints = await client.query(
        `SELECT conname, convalidated
           FROM pg_constraint
          WHERE conrelid = 'public.icu_code_status_history'::regclass
            AND conname IN (
              'icu_code_status_history_icu_admission_id_fkey',
              'fk_icu_code_status_history_admission_tenant'
            )
          ORDER BY conname`,
      );
      expect(constraints.rows).toEqual([
        {
          conname: 'fk_icu_code_status_history_admission_tenant',
          convalidated: true,
        },
        {
          conname: 'icu_code_status_history_icu_admission_id_fkey',
          convalidated: true,
        },
      ]);

      for (const statement of statements.slice(dropLegacyIndex)) {
        await client.query(statement);
      }
      for (const statement of statements) await client.query(statement);

      constraints = await client.query(
        `SELECT conname, convalidated
           FROM pg_constraint
          WHERE conrelid = 'public.icu_code_status_history'::regclass
            AND conname IN (
              'icu_code_status_history_icu_admission_id_fkey',
              'fk_icu_code_status_history_admission_tenant'
            )
          ORDER BY conname`,
      );
      expect(constraints.rows).toEqual([
        {
          conname: 'fk_icu_code_status_history_admission_tenant',
          convalidated: true,
        },
      ]);
    } finally {
      await client.query(
        `ALTER TABLE public.icu_code_status_history
           DROP CONSTRAINT IF EXISTS icu_code_status_history_icu_admission_id_fkey`,
      );
    }
  }, 120_000);

  testIfDisposable('additive migration converges the already-recorded fail-open posture', async () => {
    const statements = splitStatements(migration655);
    const policyRepairIndex = statements.findIndex(
      (statement) => statement.includes('DROP POLICY IF EXISTS tenant_isolation')
        && statement.includes('CREATE POLICY tenant_isolation')
        && statement.includes('DROP POLICY IF EXISTS icu_code_status_history_explicit_context')
        && statement.includes('CREATE POLICY icu_code_status_history_explicit_context'),
    );
    expect(policyRepairIndex).toBeGreaterThan(0);

    try {
      await client.query(
        `ALTER TABLE public.icu_code_status_history
         DROP CONSTRAINT IF EXISTS fk_icu_code_status_history_admission_tenant`,
      );
      await client.query(
        `ALTER TABLE public.icu_code_status_history
         DROP CONSTRAINT IF EXISTS fk_icu_code_status_history_tenant`,
      );
      await client.query(
        `ALTER TABLE public.icu_code_status_history
         DROP CONSTRAINT IF EXISTS icu_code_status_history_icu_admission_id_fkey`,
      );
      await client.query(
        'DROP INDEX CONCURRENTLY IF EXISTS public.ux_icu_admissions_tenant_id',
      );
      await client.query(
        `ALTER TABLE public.icu_code_status_history
         ADD CONSTRAINT icu_code_status_history_icu_admission_id_fkey
         FOREIGN KEY (icu_admission_id)
         REFERENCES public.icu_admissions (id)
         ON DELETE CASCADE
         NOT VALID`,
      );
      await client.query(
        `ALTER TABLE public.icu_code_status_history
         VALIDATE CONSTRAINT icu_code_status_history_icu_admission_id_fkey`,
      );
      await client.query(
        'ALTER TABLE public.icu_code_status_history ALTER COLUMN tenant_id DROP DEFAULT',
      );
      await client.query(
        'DROP TRIGGER IF EXISTS trg_icu_code_status_history_append_only ON public.icu_code_status_history',
      );
      await client.query(
        'DROP POLICY IF EXISTS icu_code_status_history_explicit_context ON public.icu_code_status_history',
      );
      await client.query(
        'ALTER TABLE public.users DROP CONSTRAINT IF EXISTS chk_users_token_epoch_nonnegative',
      );
      await client.query(
        'ALTER TABLE public.admins DROP CONSTRAINT IF EXISTS chk_admins_token_epoch_nonnegative',
      );
      await client.query(
        'ALTER TABLE public.users DROP CONSTRAINT IF EXISTS chk_users_abha_verification_status',
      );

      for (const statement of statements.slice(0, policyRepairIndex)) {
        await client.query(statement);
      }
      let restrictivePolicy = await client.query(
        `SELECT count(*)::integer AS count
           FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'icu_code_status_history'
            AND policyname = 'icu_code_status_history_explicit_context'
            AND permissive = 'RESTRICTIVE'`,
      );
      expect(restrictivePolicy.rows[0].count).toBe(0);

      await client.query(statements[policyRepairIndex]);
      restrictivePolicy = await client.query(
        `SELECT count(*)::integer AS count
           FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'icu_code_status_history'
            AND policyname = 'icu_code_status_history_explicit_context'
            AND permissive = 'RESTRICTIVE'`,
      );
      expect(restrictivePolicy.rows[0].count).toBe(1);

      for (const statement of statements.slice(policyRepairIndex + 1)) {
        await client.query(statement);
        restrictivePolicy = await client.query(
          `SELECT count(*)::integer AS count
             FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'icu_code_status_history'
              AND policyname = 'icu_code_status_history_explicit_context'
              AND permissive = 'RESTRICTIVE'`,
        );
        expect(restrictivePolicy.rows[0].count).toBe(1);
      }

      const posture = await client.query(
        `SELECT
           (SELECT count(*)::integer
              FROM pg_constraint
             WHERE conrelid = 'public.icu_code_status_history'::regclass
               AND conname IN (
                 'fk_icu_code_status_history_tenant',
                 'fk_icu_code_status_history_admission_tenant'
               )
               AND convalidated
               AND confdeltype = 'r') AS validated_history_fks,
           (SELECT count(*)::integer
              FROM pg_constraint
             WHERE conrelid = 'public.icu_code_status_history'::regclass
               AND conname = 'icu_code_status_history_icu_admission_id_fkey') AS legacy_fk,
           (SELECT count(*)::integer
              FROM pg_constraint
             WHERE conname IN (
               'chk_users_token_epoch_nonnegative',
               'chk_admins_token_epoch_nonnegative',
               'chk_users_abha_verification_status'
             ) AND convalidated) AS validated_checks,
           (SELECT count(*)::integer
              FROM pg_trigger
             WHERE tgrelid = 'public.icu_code_status_history'::regclass
               AND tgname = 'trg_icu_code_status_history_append_only'
               AND NOT tgisinternal) AS append_only_trigger,
           (SELECT indisvalid
              FROM pg_index
             WHERE indexrelid = 'public.ux_icu_admissions_tenant_id'::regclass) AS tenant_index_valid,
           (SELECT pg_get_expr(adbin, adrelid)
              FROM pg_attrdef
             WHERE adrelid = 'public.icu_code_status_history'::regclass
               AND adnum = (
                 SELECT attnum FROM pg_attribute
                  WHERE attrelid = 'public.icu_code_status_history'::regclass
                    AND attname = 'tenant_id'
               )) AS tenant_default`,
      );
      expect(posture.rows[0]).toEqual({
        validated_history_fks: 2,
        legacy_fk: 0,
        validated_checks: 3,
        append_only_trigger: 1,
        tenant_index_valid: true,
        tenant_default: expect.stringContaining('app.current_tenant_id'),
      });

      for (const statement of statements) await client.query(statement);
    } finally {
      for (const statement of statements) await client.query(statement);
    }
  }, 120_000);

  testIfDisposable('replay replaces invalid remnants from every concurrent index path', async () => {
    const invalidated = [
      'uniq_users_tenant_abha_number_canonical',
      'ux_icu_admissions_tenant_id',
      'idx_icu_code_status_history_admission',
      'idx_news2_scores_vitals_chart',
    ];

    try {
      await client.query(
        `ALTER TABLE public.icu_code_status_history
           DROP CONSTRAINT IF EXISTS fk_icu_code_status_history_admission_tenant`,
      );
      for (const indexName of invalidated) {
        await client.query(
          `UPDATE pg_index
              SET indisvalid = FALSE
            WHERE indexrelid = to_regclass($1)`,
          [`public.${indexName}`],
        );
      }

      let indexes = await client.query(
        `SELECT c.relname, i.indisvalid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = ANY($1::text[])
          ORDER BY c.relname`,
        [invalidated],
      );
      expect(indexes.rows).toHaveLength(invalidated.length);
      expect(indexes.rows.every(({ indisvalid }) => indisvalid === false)).toBe(true);

      for (const sql of [migration647, migration648, migration652]) {
        for (const statement of splitStatements(sql)) await client.query(statement);
      }

      await client.query(
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
           uniq_users_tenant_abha_number_canonical_verified_build
         ON public.users (tenant_id, (regexp_replace(abha_number, '-', '', 'g')))
         WHERE abha_number IS NOT NULL
           AND btrim(abha_number) <> ''
           AND abha_verification_status = 'verified'`,
      );
      await client.query(
        `UPDATE pg_index
            SET indisvalid = FALSE
          WHERE indexrelid =
            'public.uniq_users_tenant_abha_number_canonical_verified_build'::regclass`,
      );
      for (const statement of splitStatements(migration653)) await client.query(statement);

      indexes = await client.query(
        `SELECT c.relname, i.indisvalid, pg_get_expr(i.indpred, i.indrelid) AS predicate
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = ANY($1::text[])
          ORDER BY c.relname`,
        [[
          'uniq_users_tenant_abha_number_canonical',
          'ux_icu_admissions_tenant_id',
          'idx_icu_code_status_history_admission',
          'idx_news2_scores_vitals_chart',
        ]],
      );
      expect(indexes.rows).toHaveLength(4);
      expect(indexes.rows.every(({ indisvalid }) => indisvalid === true)).toBe(true);
      expect(indexes.rows.find(
        ({ relname }) => relname === 'uniq_users_tenant_abha_number_canonical',
      ).predicate).toMatch(/abha_verification_status.*verified/i);

      const leftovers = await client.query(
        `SELECT count(*)::integer AS count
           FROM pg_class
          WHERE relname = ANY($1::text[])`,
        [[
          'uniq_users_abha_canonical_invalid_rebuild',
          'uniq_users_abha_verified_invalid_rebuild',
          'ux_icu_admissions_tenant_invalid_rebuild',
          'idx_icu_code_status_history_invalid_rebuild',
          'idx_news2_vitals_invalid_rebuild',
          'uniq_users_tenant_abha_number_canonical_verified_build',
        ]],
      );
      expect(leftovers.rows[0].count).toBe(0);
    } finally {
      for (const statement of splitStatements(migration655)) await client.query(statement);
    }
  }, 120_000);

  test('historical protection swaps survive every no-transaction replay boundary', async () => {
    for (const statement of splitStatements(migration648)) {
      await client.query(statement);
      const protection = await client.query(
        `SELECT
           (SELECT count(*)::integer
              FROM pg_trigger
             WHERE tgrelid = 'public.icu_code_status_history'::regclass
               AND tgname = 'trg_icu_code_status_history_append_only'
               AND NOT tgisinternal) AS trigger_count,
           (SELECT count(*)::integer
              FROM pg_policies
             WHERE schemaname = 'public'
               AND tablename = 'icu_code_status_history'
               AND policyname = 'icu_code_status_history_explicit_context'
               AND permissive = 'RESTRICTIVE') AS restrictive_policy_count`,
      );
      expect(protection.rows[0]).toEqual({
        trigger_count: 1,
        restrictive_policy_count: 1,
      });
    }

    for (const statement of splitStatements(migration650)) {
      await client.query(statement);
      const checks = await client.query(
        `SELECT count(*)::integer AS count
           FROM pg_constraint
          WHERE conname IN (
            'chk_users_token_epoch_nonnegative',
            'chk_admins_token_epoch_nonnegative'
          )
            AND convalidated`,
      );
      expect(checks.rows[0].count).toBe(2);
    }

    for (const statement of splitStatements(migration653)) {
      await client.query(statement);
      const protection = await client.query(
        `SELECT
           (SELECT count(*)::integer
              FROM pg_constraint
             WHERE conrelid = 'public.users'::regclass
               AND conname = 'chk_users_abha_verification_status'
               AND convalidated) AS check_count,
           (SELECT count(*)::integer
              FROM pg_indexes
             WHERE schemaname = 'public'
               AND indexname IN (
                 'uniq_users_tenant_abha_number_canonical',
                 'uniq_users_tenant_abha_number_canonical_verified_build'
               )) AS enforcing_index_count`,
      );
      expect(protection.rows[0].check_count).toBe(1);
      expect(protection.rows[0].enforcing_index_count).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  test('additive replay preserves every existing protection at every statement boundary', async () => {
    for (const statement of splitStatements(migration655)) {
      await client.query(statement);
      const protection = await client.query(
        `SELECT
           (SELECT count(*)::integer
              FROM pg_trigger
             WHERE tgrelid = 'public.icu_code_status_history'::regclass
               AND tgname = 'trg_icu_code_status_history_append_only'
               AND NOT tgisinternal) AS trigger_count,
           (SELECT count(*)::integer
              FROM pg_policies
             WHERE schemaname = 'public'
               AND tablename = 'icu_code_status_history'
               AND policyname = 'icu_code_status_history_explicit_context'
               AND permissive = 'RESTRICTIVE') AS restrictive_policy_count,
           (SELECT count(*)::integer
              FROM pg_constraint
             WHERE conname IN (
               'chk_users_token_epoch_nonnegative',
               'chk_admins_token_epoch_nonnegative',
               'chk_users_abha_verification_status'
             )
               AND convalidated) AS validated_check_count,
           (SELECT count(*)::integer
              FROM pg_indexes
             WHERE schemaname = 'public'
               AND indexname IN (
                 'uniq_users_tenant_abha_number_canonical',
                 'uniq_users_tenant_abha_number_canonical_verified_build'
               )) AS enforcing_index_count`,
      );
      expect(protection.rows[0]).toEqual({
        trigger_count: 1,
        restrictive_policy_count: 1,
        validated_check_count: 3,
        enforcing_index_count: expect.any(Number),
      });
      expect(protection.rows[0].enforcing_index_count).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  test('actual 655 backfills only genuine partial NEWS2 rows', async () => {
    const news2 = await client.query(
      `INSERT INTO news2_scores
         (tenant_id, patient_uid, respiration_rate, spo2, temperature,
          systolic_bp, heart_rate, consciousness)
       VALUES
         ($1::uuid, $2::uuid, 20, 98, 37, 120, 80, 'alert'),
         ($1::uuid, $2::uuid, 20, NULL, NULL, NULL, NULL, NULL),
         ($1::uuid, $2::uuid, NULL, NULL, NULL, NULL, NULL, NULL)
       RETURNING id`,
      [tenantIds[0], patientUids[0]],
    );
    const assessments = await client.query(
      `INSERT INTO nursing_assessments
         (tenant_id, patient_uid, assessment_kind, inputs)
       VALUES
         ($1::uuid, $2::uuid, 'news2', $3::jsonb),
         ($1::uuid, $2::uuid, 'news2', $4::jsonb),
         ($1::uuid, $2::uuid, 'news2', $5::jsonb)
       RETURNING id`,
      [
        tenantIds[0],
        patientUids[0],
        JSON.stringify({
          rr: '20', spo2: '98', temp_c: '37', sbp: '120', hr: '80', consciousness: 'alert',
        }),
        JSON.stringify({ rr: '20' }),
        JSON.stringify({}),
      ],
    );
    const news2Ids = news2.rows.map(({ id }) => Number(id));
    const assessmentIds = assessments.rows.map(({ id }) => Number(id));

    try {
      await client.query(
        `UPDATE news2_scores
            SET partial_score = TRUE,
                missing_params = ARRAY[
                  'respiration_rate', 'spo2', 'temperature',
                  'systolic_bp', 'heart_rate', 'consciousness'
                ]::text[]
          WHERE id = $1::integer`,
        [news2Ids[2]],
      );
      await client.query(
        `UPDATE nursing_assessments
            SET partial_score = TRUE,
                missing_params = ARRAY[
                  'respiration_rate', 'spo2', 'temperature',
                  'systolic_bp', 'heart_rate', 'consciousness'
                ]::text[]
          WHERE id = $1::integer`,
        [assessmentIds[2]],
      );

      const backfills = splitStatements(migration655).filter(
        (statement) => statement.includes('UPDATE public.news2_scores AS score')
          || statement.includes('UPDATE public.nursing_assessments AS assessment'),
      );
      expect(backfills).toHaveLength(2);
      for (const statement of backfills) await client.query(statement);

      const scores = await client.query(
        `SELECT partial_score, cardinality(missing_params) AS missing_count
           FROM news2_scores
          WHERE id = ANY($1::integer[])
          ORDER BY id`,
        [news2Ids],
      );
      const nursing = await client.query(
        `SELECT partial_score, cardinality(missing_params) AS missing_count
           FROM nursing_assessments
          WHERE id = ANY($1::integer[])
          ORDER BY id`,
        [assessmentIds],
      );
      for (const rows of [scores.rows, nursing.rows]) {
        expect(rows).toEqual([
          { partial_score: false, missing_count: null },
          { partial_score: true, missing_count: 5 },
          { partial_score: false, missing_count: null },
        ]);
      }
    } finally {
      await client.query('DELETE FROM news2_scores WHERE id = ANY($1::integer[])', [news2Ids]);
      await client.query(
        'DELETE FROM nursing_assessments WHERE id = ANY($1::integer[])',
        [assessmentIds],
      );
    }
  });

  test('non-owner reads require an explicit matching tenant context', async () => {
    const role = await client.query('SELECT to_regrole($1)::text AS role', [RLS_TEST_ROLE]);
    expect(role.rows[0].role).toBe(RLS_TEST_ROLE);

    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE ${RLS_TEST_ROLE}`);
      await client.query("SELECT set_config('app.current_tenant_id', '', true)");
      let visible = await client.query(
        'SELECT tenant_id::text FROM icu_code_status_history WHERE id = ANY($1::bigint[])',
        [historyIds],
      );
      expect(visible.rows).toEqual([]);

      await client.query(
        "SELECT set_config('app.current_tenant_id', $1::text, true)",
        [tenantIds[0]],
      );
      visible = await client.query(
        'SELECT tenant_id::text FROM icu_code_status_history WHERE id = ANY($1::bigint[])',
        [historyIds],
      );
      expect(visible.rows).toEqual([{ tenant_id: tenantIds[0] }]);

      await client.query("SELECT set_config('app.current_tenant_id', 'bypass', true)");
      visible = await client.query(
        'SELECT tenant_id::text FROM icu_code_status_history WHERE id = ANY($1::bigint[])',
        [historyIds],
      );
      expect(visible.rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('append-only history makes admission deletion an explicit FK rejection', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SAVEPOINT expected_restrict');
      let failure;
      try {
        await client.query('DELETE FROM icu_admissions WHERE id = $1::integer', [admissionIds[0]]);
      } catch (error) {
        failure = error;
      }
      await client.query('ROLLBACK TO SAVEPOINT expected_restrict');
      expect(['23001', '23503']).toContain(failure?.code);
      expect(failure.constraint).toBe('fk_icu_code_status_history_admission_tenant');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
