#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ACKNOWLEDGEMENT_FLAG = '--ack-all-tenant-read-only';
export const TARGET_MIGRATION = '800_restore_maternity_pregnancy_checks.sql';
export const LIMITS = Object.freeze({ connectionMs: 5000, lockMs: 5000, statementMs: 30000 });
export const DOMAINS = Object.freeze([
  { column: 'edd_method', nullable: true, values: ['lmp', 'usg', 'mixed'] },
  { column: 'booking_status', nullable: false, values: ['booked', 'unbooked', 'transferred_in', 'transferred_out'] },
  { column: 'status', nullable: false, values: ['ongoing', 'delivered', 'aborted', 'still_birth', 'transferred'] },
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) fail('INVALID_SCHEMA');
  return `"${value}"`;
}

function predicate(domain) {
  const membership = `${domain.column} IN (${domain.values.map(value => `'${value}'`).join(', ')})`;
  return domain.nullable ? `${domain.column} IS NULL OR ${membership}` : membership;
}

// Compare only the narrow PostgreSQL IN/ANY deparse forms of these fixed domains.
// Unknown expression shapes require review rather than semantic guesswork.
function expressionTokens(expression) {
  const tokens = String(expression).match(/'(?:''|[^'])*'|"[a-z_][a-z0-9_]*"|::|[a-z_][a-z0-9_]*|[()[\],=]|\s+|./gi) || [];
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^\s+$/.test(token)) continue;
    result.push(token.startsWith("'") ? token : token.startsWith('"') ? token.slice(1, -1) : token.toLowerCase());
  }
  const normalized = [];
  for (let index = 0; index < result.length; index += 1) {
    const token = result[index];
    if (token === '(' || token === ')') continue;
    if (token === '::') {
      let end = index;
      if (result[index + 1] === 'text') end = index + 1;
      else if (result[index + 1] === 'character' && result[index + 2] === 'varying') end = index + 2;
      if (end !== index) {
        if (result[end + 1] === '[' && result[end + 2] === ']') end += 2;
        index = end;
        continue;
      }
    }
    normalized.push(token);
  }
  return JSON.stringify(normalized);
}

export function matchesDomainExpression(expression, domain) {
  const expected = predicate(domain);
  const membership = `${domain.column} = ANY (ARRAY[${domain.values.map(value => `'${value}'`).join(', ')}])`;
  const arrayForm = domain.nullable ? `${domain.column} IS NULL OR (${membership})` : membership;
  const actual = expressionTokens(expression);
  return [expected, arrayForm].some(value => expressionTokens(value) === actual);
}

export function parseArgs(argv) {
  const options = { acknowledged: false, exportPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === ACKNOWLEDGEMENT_FLAG) options.acknowledged = true;
    else if (argv[index] === '--export' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      if (options.exportPath) fail('DUPLICATE_EXPORT');
      options.exportPath = argv[++index];
    } else fail('INVALID_ARGUMENT');
  }
  return options;
}

export function assertOperationalSafety({ acknowledged, databaseUrl }) {
  if (!acknowledged) fail('ALL_TENANT_INSPECTION_NOT_ACKNOWLEDGED');
  if (!databaseUrl) fail('MIGRATION_800_PREFLIGHT_DATABASE_URL_REQUIRED');
  let url;
  try { url = new URL(databaseUrl); } catch { fail('INVALID_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail('INVALID_DATABASE_URL');
  if ([...url.searchParams.keys()].some(key => !['sslmode', 'sslrootcert', 'sslcert', 'sslkey'].includes(key))) {
    fail('DATABASE_URL_OPTIONS_NOT_ALLOWED');
  }
}

function oneRow(result, code) {
  if (result.rows?.length !== 1) fail(code);
  return result.rows[0];
}

function count(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) fail('INCOMPLETE_POPULATION');
  return String(value);
}

export async function collectPregnancy800Report(client, { schemaName = 'public' } = {}) {
  const schema = identifier(schemaName);
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(`SET LOCAL lock_timeout = '${LIMITS.lockMs}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${LIMITS.statementMs}ms'`);
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    await client.query('SET LOCAL row_security = off');
    await client.query('SET LOCAL search_path = pg_catalog');
    await client.query(`LOCK TABLE ${schema}.maternity_pregnancies, ${schema}._migrations IN ACCESS SHARE MODE`);

    const session = oneRow(await client.query(`
      SELECT current_setting('transaction_read_only') AS read_only,
             current_setting('transaction_isolation') AS isolation,
             current_setting('row_security') AS row_security,
             current_setting('lock_timeout') AS lock_timeout,
             current_setting('statement_timeout') AS statement_timeout,
             current_setting('server_version_num') AS server_version_num,
             pg_is_in_recovery() AS replica,
             statement_timestamp()::text AS observed_at,
             rol.rolsuper OR rol.rolbypassrls AS complete_visibility
        FROM pg_catalog.pg_roles rol WHERE rol.rolname = current_user
    `), 'SESSION_VISIBILITY_UNPROVEN');
    if (session.read_only !== 'on' || session.isolation !== 'repeatable read'
      || session.row_security !== 'off' || session.complete_visibility !== true
      || session.lock_timeout !== '5s' || session.statement_timeout !== '30s') {
      fail('SESSION_VISIBILITY_UNPROVEN');
    }
    if (session.replica !== false) fail('PRIMARY_SNAPSHOT_REQUIRED');
    if (!/^17\d{4}$/.test(session.server_version_num)) fail('POSTGRES_17_REQUIRED');

    const relations = (await client.query(`
      SELECT c.oid::text AS oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
             has_table_privilege(c.oid, 'SELECT') AS can_select,
             EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
                      WHERE i.inhrelid = c.oid OR i.inhparent = c.oid) AS inherited,
             EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid = pg_backend_pid()
                      AND l.relation = c.oid AND l.mode = 'AccessShareLock' AND l.granted) AS locked
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY c.relname
    `, [schemaName, ['maternity_pregnancies', '_migrations']])).rows;
    if (relations.length !== 2 || new Set(relations.map(row => row.relname)).size !== 2
      || relations.some(row => row.relkind !== 'r' || row.inherited !== false
        || row.can_select !== true || row.locked !== true)) fail('RELATION_SCOPE_UNPROVEN');
    const pregnancy = relations.find(row => row.relname === 'maternity_pregnancies');
    const tracker = relations.find(row => row.relname === '_migrations');
    if (!pregnancy || !tracker) fail('RELATION_SCOPE_UNPROVEN');

    const columns = (await client.query(`
      SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS not_null
        FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname = ANY($2::text[]) ORDER BY a.attname
    `, [pregnancy.oid, ['id', 'tenant_id', ...DOMAINS.map(domain => domain.column)]])).rows;
    const expectedColumns = [
      { name: 'id', type: 'integer', not_null: true },
      { name: 'tenant_id', type: 'uuid', not_null: true },
      ...DOMAINS.map(domain => ({ name: domain.column, type: 'character varying(20)', not_null: !domain.nullable })),
    ].sort((a, b) => a.name.localeCompare(b.name));
    if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) fail('COLUMN_LINEAGE_MISMATCH');

    const constraints = (await client.query(`
      SELECT c.conname AS name, c.contype AS type, c.convalidated AS validated,
             pg_catalog.pg_get_expr(c.conbin, c.conrelid, true) AS expression,
             pg_catalog.pg_get_constraintdef(c.oid, true) AS definition
        FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = $1::oid AND (c.contype = 'c' OR c.conname = ANY($2::text[]))
       ORDER BY c.conname
    `, [pregnancy.oid, DOMAINS.map(domain => `maternity_pregnancies_${domain.column}_check`)])).rows;
    const domains = DOMAINS.map(domain => {
      const name = `maternity_pregnancies_${domain.column}_check`;
      const named = constraints.filter(row => row.name === name);
      if (named.length > 1 || named.some(row => row.type !== 'c'
        || typeof row.validated !== 'boolean' || !row.definition?.startsWith('CHECK ')
        || !matchesDomainExpression(row.expression, domain))) {
        fail('CONSTRAINT_LINEAGE_MISMATCH');
      }
      const aliases = constraints.filter(row => row.name !== name && row.type === 'c'
        && matchesDomainExpression(row.expression, domain));
      return {
        column: domain.column, intended_predicate: predicate(domain),
        name, present: named.length === 1,
        validated: named[0]?.validated ?? null, definition: named[0]?.definition ?? null,
        equivalent_other_names: aliases.map(row => row.name),
        equivalent_other_constraints: aliases.map(row => ({ name: row.name,
          validated: row.validated, definition: row.definition })),
      };
    });

    const trackerRows = (await client.query(
      `SELECT name, checksum FROM ${schema}._migrations WHERE name = $1 ORDER BY name`,
      [TARGET_MIGRATION],
    )).rows;
    if (trackerRows.length > 1 || trackerRows.some(row => row.name !== TARGET_MIGRATION
      || !/^[0-9a-f]{64}$/.test(row.checksum || ''))) fail('TRACKER_CHECKSUM_UNPROVEN');
    if (trackerRows.length === 1 && domains.some(domain => !domain.present)) fail('APPLIED_CATALOG_MISMATCH');

    const population = oneRow(await client.query(`
      SELECT count(*)::text AS total_rows,
             ${DOMAINS.map(domain => `count(*) FILTER (WHERE (${predicate(domain)}) IS FALSE)::text AS invalid_${domain.column}`).join(',\n             ')}
        FROM ${schema}.maternity_pregnancies
    `), 'INCOMPLETE_POPULATION');
    const total = count(population.total_rows);
    for (const domain of domains) {
      domain.violating_rows = count(population[`invalid_${domain.column}`]);
      if (BigInt(domain.violating_rows) > BigInt(total)) fail('INCOMPLETE_POPULATION');
      if (domain.validated && domain.violating_rows !== '0') fail('VALIDATED_POPULATION_MISMATCH');
    }
    await client.query('COMMIT');
    const report = {
      schema_version: 1, status: 'report_only', authorizes_rollout: false,
      scope: `${schemaName}.maternity_pregnancies`, all_tenants: true,
      observed_at: session.observed_at, server_version_num: session.server_version_num,
      source_migration: '155_maternity_workflow.sql', target_migration: TARGET_MIGRATION,
      visibility: 'existing_superuser_or_bypassrls_read_only_primary_snapshot',
      limits: LIMITS, relations, columns, total_rows: total, domains,
      tracker: { applied: trackerRows.length === 1, recorded_checksum: trackerRows[0]?.checksum ?? null,
        candidate_checksum_verified: false },
      stop_reasons: [
        'OPERATOR_ROLLOUT_ACCEPTANCE_REQUIRED', 'CANDIDATE_CHECKSUM_COMPARISON_REQUIRED',
        ...(domains.some(domain => domain.violating_rows !== '0') ? ['CLINICAL_RECORDS_REVIEW_REQUIRED'] : []),
        ...(domains.some(domain => domain.equivalent_other_names.length) ? ['EQUIVALENT_CONSTRAINT_LINEAGE_REVIEW_REQUIRED'] : []),
        ...(total === '0' ? ['EMPTY_POPULATION_NOT_CLINICAL_VALIDATION'] : []),
      ],
    };
    return { ...report, report_sha256: createHash('sha256').update(JSON.stringify(report)).digest('hex') };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function runPregnancy800Preflight({
  acknowledged = false, exportPath = null,
  databaseUrl = process.env.MIGRATION_800_PREFLIGHT_DATABASE_URL,
  clientFactory = null,
} = {}) {
  assertOperationalSafety({ acknowledged, databaseUrl });
  const createClient = clientFactory || (options => import('pg').then(({ Client }) => new Client(options)));
  const client = await createClient({
    connectionString: databaseUrl, application_name: 'vhhealth-maternity-800-preflight',
    connectionTimeoutMillis: LIMITS.connectionMs, query_timeout: LIMITS.statementMs + 5000,
    statement_timeout: LIMITS.statementMs, lock_timeout: LIMITS.lockMs,
    options: '-c default_transaction_read_only=on',
  });
  try {
    await client.connect();
    const report = await collectPregnancy800Report(client);
    if (exportPath) {
      await writeFile(exportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    return report;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => runPregnancy800Preflight(parseArgs(process.argv.slice(2))))
    .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(error => {
      const code = /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'PREFLIGHT_FAILED';
      process.stderr.write(`[maternity-pregnancy-800-preflight] ${code}; no rollout authorization issued.\n`);
      process.exitCode = 1;
    });
}
