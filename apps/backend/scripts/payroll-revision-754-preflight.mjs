#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

const { Client } = pg;
const TARGET_MIGRATION = '754_salary_revision_tenant_reconciliation.sql';
const ACCEPTED_HASH_ENV = 'PAYROLL_754_ACCEPTED_MANIFEST_SHA256';
const ACCEPTED_BY_ENV = 'PAYROLL_754_ACCEPTED_BY';
const PAYROLL_TABLES = [
  'salary_revisions',
  'salary_arrears',
  'annual_review_reminders',
  'bulk_revision_jobs',
];
const PAYROLL_AUTHORITY_TABLES = ['users', 'payslips'];

function parseArgs(argv) {
  const options = { reportOnly: false, exportPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--report-only') {
      options.reportOnly = true;
    } else if (argument === '--export') {
      options.exportPath = argv[index + 1] || null;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (argv.includes('--export') && !options.exportPath) {
    throw new Error('--export requires a file path');
  }
  return options;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function qualifiedName(schemaName, tableName) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schemaName)) throw new Error('Invalid schema name');
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) throw new Error('Invalid table name');
  return `"${schemaName}"."${tableName}"`;
}

async function tableExists(client, tableName, schemaName = 'public') {
  const result = await client.query(
    `SELECT to_regclass($1)::text AS relation`,
    [`${schemaName}.${tableName}`],
  );
  return result.rows[0]?.relation != null;
}

async function migrationApplied(client, schemaName = 'public') {
  if (!(await tableExists(client, '_migrations', schemaName))) return false;
  const result = await client.query(
    `SELECT 1 FROM ${qualifiedName(schemaName, '_migrations')} WHERE name = $1 LIMIT 1`,
    [TARGET_MIGRATION],
  );
  return result.rowCount === 1;
}

async function queryIfPresent(client, tableName, schemaName, selectSql) {
  if (!(await tableExists(client, tableName, schemaName))) return [];
  return (await client.query(
    `${selectSql} FROM ${qualifiedName(schemaName, tableName)} AS source_row ORDER BY id`,
  )).rows;
}

function fingerprintSourceRows(rows) {
  return rows.map(({ source_json: sourceJson, ...fields }) => ({
    ...Object.fromEntries(
      Object.entries(fields).filter(([field]) => !field.startsWith('_')),
    ),
    source_json: sourceJson,
    source_sha256: sha256(sourceJson),
  }));
}

function groupedCounts(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.observed_tenant_id || 'unowned'}\u0000${row.observed_status || 'unknown'}`;
    const current = groups.get(key) || {
      observed_tenant_id: row.observed_tenant_id || null,
      observed_status: row.observed_status || null,
      count: 0,
    };
    current.count += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => (
    String(left.observed_tenant_id).localeCompare(String(right.observed_tenant_id))
    || String(left.observed_status).localeCompare(String(right.observed_status))
  ));
}

export async function collectPayrollRevision754Manifest(client, { schemaName = 'public' } = {}) {
  const salaryRevisionSources = await queryIfPresent(client, 'salary_revisions', schemaName, `
    SELECT id::text,
           revision_number,
           tenant_id::text AS observed_tenant_id,
           status AS observed_status,
           to_jsonb(source_row)->>'staff_uid' AS _staff_uid,
           to_jsonb(source_row)->>'proposed_by' AS _proposed_by,
           to_jsonb(source_row)->>'hr_signed_by' AS _hr_signed_by,
           to_jsonb(source_row)->>'admin_signed_by' AS _admin_signed_by,
           to_jsonb(source_row)->>'rejected_by' AS _rejected_by,
           to_jsonb(source_row)::text AS source_json
  `);
  const salaryArrearsSources = await queryIfPresent(client, 'salary_arrears', schemaName, `
    SELECT id::text,
           tenant_id::text AS observed_tenant_id,
           status AS observed_status,
           to_jsonb(source_row)->>'staff_uid' AS _staff_uid,
           to_jsonb(source_row)->>'payslip_id' AS _payslip_id,
           to_jsonb(source_row)::text AS source_json
  `);
  const annualReviewReminderSources = await queryIfPresent(
    client,
    'annual_review_reminders',
    schemaName,
    `
    SELECT id::text,
           tenant_id::text AS observed_tenant_id,
           status AS observed_status,
           to_jsonb(source_row)->>'staff_uid' AS _staff_uid,
           to_jsonb(source_row)::text AS source_json
  `,
  );
  const bulkRevisionJobSources = await queryIfPresent(
    client,
    'bulk_revision_jobs',
    schemaName,
    `
    SELECT id::text,
           tenant_id::text AS observed_tenant_id,
           status AS observed_status,
           to_jsonb(source_row)->>'created_by' AS _created_by,
           to_jsonb(source_row)->>'hr_signed_by' AS _hr_signed_by,
           to_jsonb(source_row)->>'approved_by' AS _approved_by,
           to_jsonb(source_row)::text AS source_json
  `,
  );
  const relevantUserUids = [...new Set([
    ...salaryRevisionSources.flatMap(row => [
      row._staff_uid,
      row._proposed_by,
      row._hr_signed_by,
      row._admin_signed_by,
      row._rejected_by,
    ]),
    ...salaryArrearsSources.map(row => row._staff_uid),
    ...annualReviewReminderSources.map(row => row._staff_uid),
    ...bulkRevisionJobSources.flatMap(row => [
      row._created_by,
      row._hr_signed_by,
      row._approved_by,
    ]),
  ].filter(Boolean))].sort();
  const relevantPayslipIds = [...new Set(
    salaryArrearsSources.map(row => row._payslip_id).filter(Boolean),
  )].sort((left, right) => {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return 0;
  });
  const users = relevantUserUids.length > 0 && await tableExists(client, 'users', schemaName)
    ? (await client.query(
      `SELECT uid::text, tenant_id::text
         FROM ${qualifiedName(schemaName, 'users')}
        WHERE uid = ANY($1::uuid[])
        ORDER BY uid`,
      [relevantUserUids],
    )).rows
    : [];
  const payslips = relevantPayslipIds.length > 0
      && await tableExists(client, 'payslips', schemaName)
    ? (await client.query(
      `SELECT id::text, tenant_id::text, staff_uid::text
         FROM ${qualifiedName(schemaName, 'payslips')}
        WHERE id = ANY($1::bigint[])
        ORDER BY id`,
      [relevantPayslipIds],
    )).rows
    : [];
  const salaryRevisions = fingerprintSourceRows(salaryRevisionSources);
  const salaryArrears = fingerprintSourceRows(salaryArrearsSources);
  const annualReviewReminders = fingerprintSourceRows(annualReviewReminderSources);
  const bulkRevisionJobs = fingerprintSourceRows(bulkRevisionJobSources);
  return {
    schema_version: 2,
    target_migration: TARGET_MIGRATION,
    affected_rows: {
      salary_revisions: salaryRevisions,
      salary_arrears: salaryArrears,
      annual_review_reminders: annualReviewReminders,
      bulk_revision_jobs: bulkRevisionJobs,
    },
    authority_evidence: {
      users,
      payslips,
    },
  };
}

export function buildPayrollRevision754Receipt(manifest) {
  const sections = manifest.affected_rows;
  const cardinality = Object.fromEntries(
    Object.entries(sections).map(([name, rows]) => [name, rows.length]),
  );
  const total = Object.values(cardinality).reduce((sum, count) => sum + count, 0);
  const byTenantAndStatus = Object.fromEntries(
    Object.entries(sections).map(([name, rows]) => [name, groupedCounts(rows)]),
  );
  return {
    target_migration: TARGET_MIGRATION,
    manifest_sha256: sha256(canonicalJson(manifest)),
    cardinality: { ...cardinality, total },
    authority_cardinality: Object.fromEntries(
      Object.entries(manifest.authority_evidence || {})
        .map(([name, rows]) => [name, rows.length]),
    ),
    by_tenant_and_status: byTenantAndStatus,
  };
}

export function assertPayrollRevision754Acceptance(receipt, {
  acceptedManifestSha256 = process.env[ACCEPTED_HASH_ENV],
  acceptedBy = process.env[ACCEPTED_BY_ENV],
} = {}) {
  if (receipt.cardinality.total === 0) {
    return { status: 'empty', ...receipt };
  }
  const acceptedHash = String(acceptedManifestSha256 || '').trim().toLowerCase();
  const owner = String(acceptedBy || '').trim();
  if (!/^[0-9a-f]{64}$/.test(acceptedHash) || acceptedHash !== receipt.manifest_sha256) {
    const error = new Error(
      `${TARGET_MIGRATION} would reconcile ${receipt.cardinality.total} legacy payroll row(s). `
      + 'Run node scripts/payroll-revision-754-preflight.mjs --report-only '
      + '--export /tmp/payroll-754-manifest.json from the backend working directory, '
      + 'retrieve the mode-0600 export before the container exits, have the named '
      + `payroll data owner accept manifest ${receipt.manifest_sha256}, then set ${ACCEPTED_HASH_ENV}.`,
    );
    error.code = 'PAYROLL_754_MANIFEST_NOT_ACCEPTED';
    error.receipt = receipt;
    throw error;
  }
  if (owner.length < 3 || owner.length > 200) {
    const error = new Error(
      `${ACCEPTED_BY_ENV} must name the payroll data owner who accepted manifest `
      + receipt.manifest_sha256,
    );
    error.code = 'PAYROLL_754_OWNER_NOT_NAMED';
    error.receipt = receipt;
    throw error;
  }
  return {
    status: 'accepted',
    accepted_by: owner,
    accepted_manifest_sha256: acceptedHash,
    ...receipt,
  };
}

export async function lockPayrollRevision754Tables(client, {
  schemaName = 'public',
} = {}) {
  await client.query(
    `LOCK TABLE ${PAYROLL_TABLES.map(table => qualifiedName(schemaName, table)).join(', ')} `
    + 'IN ACCESS EXCLUSIVE MODE',
  );
  await client.query(
    `LOCK TABLE ${PAYROLL_AUTHORITY_TABLES
      .map(table => qualifiedName(schemaName, table)).join(', ')} IN SHARE MODE`,
  );
  return {
    lockedTables: [...PAYROLL_AUTHORITY_TABLES, ...PAYROLL_TABLES],
  };
}

export async function lockAndAssertPayrollRevision754Acceptance(client, {
  schemaName = 'public',
  acceptedManifestSha256 = process.env[ACCEPTED_HASH_ENV],
  acceptedBy = process.env[ACCEPTED_BY_ENV],
} = {}) {
  await lockPayrollRevision754Tables(client, { schemaName });
  const manifest = await collectPayrollRevision754Manifest(client, { schemaName });
  const receipt = buildPayrollRevision754Receipt(manifest);
  return assertPayrollRevision754Acceptance(receipt, {
    acceptedManifestSha256,
    acceptedBy,
  });
}

export async function runPayrollRevision754Preflight({
  databaseUrl = process.env.DATABASE_URL,
  acceptedManifestSha256 = process.env[ACCEPTED_HASH_ENV],
  acceptedBy = process.env[ACCEPTED_BY_ENV],
  reportOnly = false,
  exportPath = null,
} = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'vhhealth-payroll-revision-754-preflight',
  });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (await migrationApplied(client)) {
      await client.query('COMMIT');
      return {
        status: 'already_applied',
        target_migration: TARGET_MIGRATION,
      };
    }
    const manifest = await collectPayrollRevision754Manifest(client);
    const receipt = buildPayrollRevision754Receipt(manifest);
    await client.query('COMMIT');

    if (exportPath) {
      await writeFile(
        exportPath,
        `${JSON.stringify({ ...receipt, manifest }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
    }
    if (receipt.cardinality.total === 0 || reportOnly) {
      return {
        status: receipt.cardinality.total === 0 ? 'empty' : 'report_only',
        ...receipt,
      };
    }

    return assertPayrollRevision754Acceptance(receipt, {
      acceptedManifestSha256,
      acceptedBy,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await runPayrollRevision754Preflight(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error.receipt) process.stderr.write(`${JSON.stringify(error.receipt, null, 2)}\n`);
    process.stderr.write(`[payroll-revision-754-preflight] ${error.code || 'FATAL'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
