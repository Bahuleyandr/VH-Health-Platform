import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitStatements } from '../../utils/migrations/splitStatements.js';

const migrationsDir = new URL('../../migrations/', import.meta.url);

function migration(name) {
  return readFileSync(new URL(name, migrationsDir), 'utf8');
}

function productionJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'tests') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionJavaScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

// Index builds on a table the same migration creates are uncontended — the
// table is empty and no other session can even see it — so only builds against
// PRE-EXISTING tables need CONCURRENTLY. This asserts that for the named
// already-live tables, which is the H-1 property.
function expectNoBlockingIndexBuildOn(sql, preExistingTables) {
  for (const table of preExistingTables) {
    const onTable = new RegExp(`\\bON\\s+(?:public\\.)?${table}\\b`, 'i');
    const offenders = splitStatements(sql)
      .map((statement) => statement.replace(/^\s*--[^\n]*$/gm, ''))
      .filter((statement) => /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement)
        && onTable.test(statement)
        && !/\bCONCURRENTLY\b/i.test(statement));
    expect(offenders).toEqual([]);
  }
}

function expectInvalidConcurrentIndexRecovery(sql, indexName, temporaryName) {
  const statements = splitStatements(sql);
  const temporaryDrops = statements
    .map((statement, index) => ({ statement, index }))
    .filter(({ statement }) => statement.includes(
      `DROP INDEX CONCURRENTLY IF EXISTS public.${temporaryName}`,
    ));
  const rename = statements.findIndex(
    (statement) => statement.includes('to_regclass')
      && statement.includes(indexName)
      && statement.includes('NOT indisvalid')
      && statement.includes(`RENAME TO ${temporaryName}`),
  );
  const create = statements.findIndex(
    (statement) => statement.includes('CREATE')
      && statement.includes('INDEX CONCURRENTLY IF NOT EXISTS')
      && statement.includes(indexName),
  );

  expect(temporaryDrops).toHaveLength(2);
  expect(rename).toBeGreaterThan(temporaryDrops[0].index);
  expect(temporaryDrops[1].index).toBeGreaterThan(rename);
  expect(create).toBeGreaterThan(temporaryDrops[1].index);
}

describe('Audit 3 migration deploy-safety contracts', () => {
  test('647 warns on duplicate ABHA data and builds its index outside a transaction', () => {
    const sql = migration('647_users_abha_number_tenant_unique.sql');

    expect(sql).toContain('-- @no-transaction');
    expect(sql).toContain('-- @statement_timeout: 0');
    expect(sql).toMatch(/RAISE\s+WARNING/i);
    expect(sql).not.toMatch(/RAISE\s+EXCEPTION/i);
    expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+uniq_users_tenant_abha_number_canonical/i);
  });

  test('650 validates token-epoch checks after adding them NOT VALID', () => {
    const sql = migration('650_token_epoch_issuance_gate.sql');

    expect(sql).toContain('-- @no-transaction');
    expect(sql).toContain('-- @statement_timeout: 0');
    for (const constraint of [
      'chk_users_token_epoch_nonnegative',
      'chk_admins_token_epoch_nonnegative',
    ]) {
      expect(sql).toMatch(new RegExp(`ADD CONSTRAINT ${constraint}[\\s\\S]*?NOT VALID`, 'i'));
      expect(sql).toMatch(new RegExp(`VALIDATE CONSTRAINT ${constraint}`, 'i'));
      expect(sql).not.toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint}`, 'i'));
    }
  });

  test('652 bounds both historical partial-score updates and avoids blocking index creation', () => {
    const sql = migration('652_news2_rescore_supersede_partial.sql');

    expect(sql).toContain('-- @no-transaction');
    expect(sql).toContain('-- @statement_timeout: 0');
    expect(sql).toMatch(/WHERE\s+n\.id\s*=\s*d\.id\s+AND\s+d\.present_count\s+BETWEEN\s+1\s+AND\s+5/i);
    expect(sql).toMatch(/WHERE\s+n\.id\s*=\s*c\.id\s+AND\s+c\.present_count\s+BETWEEN\s+1\s+AND\s+5/i);
    expect(sql).toMatch(/CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+idx_news2_scores_vitals_chart/i);
    expect(sql).not.toMatch(/DROP\s+INDEX(?!\s+CONCURRENTLY)/i);
    for (const constraint of [
      'fk_news2_scores_vitals_chart',
      'fk_news2_scores_superseded_by',
    ]) {
      expect(sql).toMatch(new RegExp(`ADD CONSTRAINT ${constraint}[\\s\\S]*?NOT VALID`, 'i'));
      expect(sql).toMatch(new RegExp(`VALIDATE CONSTRAINT ${constraint}`, 'i'));
    }
  });

  test('653 validates its check and keeps ABHA uniqueness continuously enforced during the concurrent swap', () => {
    const sql = migration('653_users_abha_verification_gate.sql');

    expect(sql).toContain('-- @no-transaction');
    expect(sql).toContain('-- @statement_timeout: 0');
    expect(sql).toMatch(/ADD CONSTRAINT chk_users_abha_verification_status[\s\S]*?NOT VALID/i);
    expect(sql).toMatch(/VALIDATE CONSTRAINT chk_users_abha_verification_status/i);
    expect(sql).not.toMatch(/DROP CONSTRAINT IF EXISTS chk_users_abha_verification_status/i);
    const build = sql.indexOf('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_users_tenant_abha_number_canonical_verified_build');
    const drop = sql.indexOf('DROP INDEX CONCURRENTLY IF EXISTS uniq_users_tenant_abha_number_canonical');
    const rename = sql.indexOf('RENAME TO uniq_users_tenant_abha_number_canonical');
    expect(build).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(build);
    expect(rename).toBeGreaterThan(drop);
  });

  test('648 and additive 655 keep ICU code-status history tenant-bound and fail-closed', () => {
    const historical = migration('648_icu_flowsheet_bounds_code_status_history.sql');
    const additive = migration('655_audit3_migration_deploy_safety.sql');

    for (const sql of [historical, additive]) {
      expect(sql).toContain('-- @no-transaction');
      expect(sql).toContain('-- @statement_timeout: 0');
      expect(sql).toMatch(/icu_code_status_history_explicit_context[\s\S]*?AS RESTRICTIVE/i);
      expect(sql).toMatch(/FOREIGN KEY \(tenant_id, icu_admission_id\)[\s\S]*?REFERENCES public\.icu_admissions \(tenant_id, id\)[\s\S]*?ON DELETE RESTRICT/i);
      expect(sql).toMatch(/FOREIGN KEY \(tenant_id\)[\s\S]*?REFERENCES public\.tenants \(id\)[\s\S]*?ON DELETE RESTRICT/i);
      expect(sql).toMatch(/ALTER COLUMN tenant_id SET DEFAULT|tenant_id\s+UUID\s+NOT NULL\s+DEFAULT/i);

      const statements = splitStatements(sql);
      for (const policyName of [
        'tenant_isolation',
        'icu_code_status_history_explicit_context',
      ]) {
        const swaps = statements.filter(
          (statement) => statement.includes(`DROP POLICY IF EXISTS ${policyName}`)
            && statement.includes(`CREATE POLICY ${policyName}`),
        );
        expect(swaps).toHaveLength(1);
      }
      const atomicPolicyRepair = statements.filter(
        (statement) => statement.includes('DROP POLICY IF EXISTS tenant_isolation')
          && statement.includes('CREATE POLICY tenant_isolation')
          && statement.includes(
            'DROP POLICY IF EXISTS icu_code_status_history_explicit_context',
          )
          && statement.includes('CREATE POLICY icu_code_status_history_explicit_context'),
      );
      expect(atomicPolicyRepair).toHaveLength(1);
      if (sql === additive) {
        expect(statements.indexOf(atomicPolicyRepair[0])).toBeLessThanOrEqual(2);
      }
    }

    for (const sql of [historical, additive]) {
      expect(sql).not.toMatch(/DROP TRIGGER IF EXISTS trg_icu_code_status_history_append_only/i);
      expect(sql).toMatch(/IF NOT EXISTS[\s\S]*?trg_icu_code_status_history_append_only/i);
    }

    expect(additive).toMatch(/VALIDATE CONSTRAINT fk_icu_code_status_history_tenant/i);
    expect(additive).toMatch(/VALIDATE CONSTRAINT fk_icu_code_status_history_admission_tenant/i);

    const addReplacement = additive.indexOf(
      'ADD CONSTRAINT fk_icu_code_status_history_admission_tenant',
    );
    const validateReplacement = additive.indexOf(
      'VALIDATE CONSTRAINT fk_icu_code_status_history_admission_tenant',
    );
    const dropLegacy = additive.indexOf(
      'DROP CONSTRAINT IF EXISTS icu_code_status_history_icu_admission_id_fkey',
    );
    expect(addReplacement).toBeGreaterThan(-1);
    expect(validateReplacement).toBeGreaterThan(addReplacement);
    expect(dropLegacy).toBeGreaterThan(validateReplacement);
  });

  // H-1 (audit 2026-08-13). 668 originally anchored its composite tenant/user
  // FK with a table-level UNIQUE constraint on `users`, which builds a full
  // btree while holding ACCESS EXCLUSIVE on the hottest table in the system for
  // the whole build — measured at 4.3s and fully blocking on a 3M-row stand-in,
  // against ~0 blocking for the concurrent form. Inside the PreSync
  // transaction that either blows the statement timeout (failing the Job, so
  // the ArgoCD sync aborts) or stalls every query touching `users`. 666 carried
  // the same shape on `patient_allergies`, which sits on the
  // prescription-safety read path. These two tests pin the fix so neither can
  // regress to the blocking form.
  test('668 anchors the composite tenant/user FK without ever locking users', () => {
    const sql = migration('668_scheduler_truth_and_notification_tenant_integrity.sql');

    expect(sql).toContain('-- @no-transaction');
    expect(sql).toContain('-- @statement_timeout: 0');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_users_tenant_id_id\s+ON public\.users \(tenant_id, id\)/i,
    );
    // The blocking forms must never come back: no table-level UNIQUE
    // constraint on users, and no non-concurrent index build anywhere.
    expect(sql).not.toMatch(/ADD CONSTRAINT ux_users_tenant_id_id\s+UNIQUE/i);
    expect(sql).not.toMatch(/ALTER TABLE public\.users\s+ADD CONSTRAINT/i);
    expect(sql).not.toMatch(/DROP INDEX (?!CONCURRENTLY)/i);
    expectNoBlockingIndexBuildOn(sql, ['users', 'scheduled_notifications']);
    // NOT VALID + a separate VALIDATE only buys anything outside a transaction.
    expect(sql).toMatch(/ADD CONSTRAINT scheduled_notifications_tenant_user_fk[\s\S]*?NOT VALID/i);
    expect(sql).toMatch(/VALIDATE CONSTRAINT scheduled_notifications_tenant_user_fk/i);
  });

  test('666 anchors the FHIR allergy receipt FK without locking patient_allergies', () => {
    const sql = migration('666_canonical_interop_live_receipts.sql');

    expect(sql).toContain('-- @no-transaction');
    expect(sql).toContain('-- @statement_timeout: 0');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_patient_allergies_tenant_id_for_fhir_receipt/i,
    );
    expect(sql).not.toMatch(/DROP INDEX (?!CONCURRENTLY)/i);
    expectNoBlockingIndexBuildOn(sql, ['patient_allergies']);
    // SET LOCAL is a no-op WARNING outside a transaction block — the runner
    // sets the session values from the directives instead.
    expect(sql).not.toMatch(/SET LOCAL/i);
  });

  test('every concurrent index path repairs an interrupted invalid build', () => {
    const historical647 = migration('647_users_abha_number_tenant_unique.sql');
    const historical648 = migration('648_icu_flowsheet_bounds_code_status_history.sql');
    const historical652 = migration('652_news2_rescore_supersede_partial.sql');
    const historical653 = migration('653_users_abha_verification_gate.sql');
    const additive = migration('655_audit3_migration_deploy_safety.sql');
    const h1_666 = migration('666_canonical_interop_live_receipts.sql');
    const h1_668 = migration('668_scheduler_truth_and_notification_tenant_integrity.sql');

    expectInvalidConcurrentIndexRecovery(
      historical647,
      'uniq_users_tenant_abha_number_canonical',
      'uniq_users_abha_canonical_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      historical648,
      'ux_icu_admissions_tenant_id',
      'ux_icu_admissions_tenant_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      historical648,
      'idx_icu_code_status_history_admission',
      'idx_icu_code_status_history_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      historical652,
      'idx_news2_scores_vitals_chart',
      'idx_news2_vitals_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      historical653,
      'uniq_users_tenant_abha_number_canonical_verified_build',
      'uniq_users_abha_verified_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      additive,
      'ux_icu_admissions_tenant_id',
      'ux_icu_admissions_tenant_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      additive,
      'uniq_users_tenant_abha_number_canonical',
      'uniq_users_abha_canonical_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      additive,
      'uniq_users_tenant_abha_number_canonical_verified_build',
      'uniq_users_abha_verified_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      additive,
      'idx_news2_scores_vitals_chart',
      'idx_news2_vitals_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      h1_666,
      'ux_patient_allergies_tenant_id_for_fhir_receipt',
      'ux_patient_allergies_tenant_id_for_fhir_receipt_invalid_rebuild',
    );
    expectInvalidConcurrentIndexRecovery(
      h1_668,
      'ux_users_tenant_id_id',
      'ux_users_tenant_id_id_invalid_rebuild',
    );
  });

  test('ICU history keeps deprecated write provenance without production patient-uid reads', () => {
    const historical = migration('648_icu_flowsheet_bounds_code_status_history.sql');
    const additive = migration('655_audit3_migration_deploy_safety.sql');
    const productionSources = productionJavaScriptFiles(
      fileURLToPath(new URL('../../', import.meta.url)),
    ).map((path) => ({ path, source: readFileSync(path, 'utf8') }));
    const productionSql = productionSources.flatMap(({ path, source }) => {
      return [...source.matchAll(/`(?:\\.|[^`])*`/gs)]
        .map((match) => ({ path, sql: match[0] }))
        .filter(({ sql }) => /\bicu_code_status_history\b/i.test(sql));
    });

    expect(historical).toMatch(/patient_uid\s+UUID/i);
    expect(additive).toMatch(/ADD COLUMN IF NOT EXISTS patient_uid UUID/i);
    expect(additive).not.toMatch(/DROP COLUMN IF EXISTS patient_uid/i);
    expect(historical).toMatch(/DEPRECATED immutable provenance/i);
    expect(additive).toMatch(/DEPRECATED immutable provenance/i);

    expect(productionSql).toHaveLength(2);
    for (const { sql } of productionSql) {
      expect(sql).toMatch(/^`\s*INSERT INTO icu_code_status_history/i);
      expect(sql).toMatch(/\bpatient_uid\b/i);
      expect(sql).not.toMatch(/\b(?:SELECT|FROM|JOIN|UPDATE|DELETE)\b/i);
    }
    for (const { source } of productionSources) {
      expect(source).not.toMatch(
        /\b(?:FROM|JOIN|UPDATE|DELETE\s+FROM)\s+(?:public\.)?icu_code_status_history\b/i,
      );
    }
  });
});
