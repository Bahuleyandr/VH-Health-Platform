#!/usr/bin/env node
// Read-only audit for legacy plaintext rows in secret-bearing columns.
//
// New writes now use field/TOTP encryption wrappers, but existing database rows
// still need operator-driven backfill or credential rotation. This script finds
// rows that do not match the expected encrypted envelope and exits non-zero.

import process from 'process';

import dotenv from 'dotenv';
import pg from 'pg';

const { Client } = pg;

dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ path: '.env', quiet: true });

const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const help = args.has('--help') || args.has('-h');

const FIELD_ENCRYPTED_SQL = "LIKE 'enc:v1:%'";
const TOTP_ENCRYPTED_SQL = "~ '^[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$'";

const SECRET_COLUMNS = [
  {
    secretClass: 'integration_webhook_signing_secret',
    table: 'integration_credentials',
    column: 'ciphertext',
    encryptedSql: FIELD_ENCRYPTED_SQL,
    detailColumns: ['integration_id', 'credential_key'],
  },
  {
    secretClass: 'smart_fhir_client_secret',
    table: 'smart_apps',
    column: 'client_secret_ciphertext',
    encryptedSql: FIELD_ENCRYPTED_SQL,
    detailColumns: ['client_id', 'app_kind', 'environment'],
  },
  {
    secretClass: 'hl7_outbound_authorization_header',
    table: 'hl7_feed_subscriptions',
    column: 'auth_header',
    encryptedSql: FIELD_ENCRYPTED_SQL,
    detailColumns: ['name', 'endpoint_url'],
  },
  {
    secretClass: 'telemedicine_api_key',
    table: 'teleconsult_provider_configs',
    column: 'api_key_ciphertext',
    encryptedSql: FIELD_ENCRYPTED_SQL,
    detailColumns: ['provider'],
  },
  {
    secretClass: 'telemedicine_api_secret',
    table: 'teleconsult_provider_configs',
    column: 'api_secret_ciphertext',
    encryptedSql: FIELD_ENCRYPTED_SQL,
    detailColumns: ['provider'],
  },
  {
    secretClass: 'telemedicine_webhook_secret',
    table: 'teleconsult_provider_configs',
    column: 'webhook_secret_ciphertext',
    encryptedSql: FIELD_ENCRYPTED_SQL,
    detailColumns: ['provider'],
  },
  {
    secretClass: 'mfa_totp_shared_secret',
    table: 'mfa_devices',
    column: 'secret_ciphertext',
    encryptedSql: TOTP_ENCRYPTED_SQL,
    detailColumns: ['user_uid', 'device_kind', 'status'],
  },
];

function usage() {
  return `Usage: node src/scripts/security/audit-secret-encryption.js [--json]

Checks DATABASE_URL for plaintext legacy rows in secret-bearing columns:
${SECRET_COLUMNS.map((s) => `  - ${s.table}.${s.column} (${s.secretClass})`).join('\n')}

Exit codes:
  0  all checked rows are encrypted or empty
  1  script/configuration/database error
  2  one or more plaintext legacy rows were found
`;
}

function quoteIdent(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function tableExists(client, table) {
  const result = await client.query(
    `SELECT to_regclass($1) AS regclass`,
    [`public.${table}`],
  );
  return Boolean(result.rows[0]?.regclass);
}

function buildAuditQuery(spec) {
  const table = quoteIdent(spec.table);
  const column = quoteIdent(spec.column);
  const detail = spec.detailColumns.map((name) =>
    `'${name}', ${quoteIdent(name)}::text`
  ).join(', ');
  const detailsSql = detail ? `jsonb_build_object(${detail})` : `'{}'::jsonb`;

  return `
    SELECT
      $1::text AS secret_class,
      $2::text AS table_name,
      $3::text AS column_name,
      id::text AS row_id,
      tenant_id::text AS tenant_id,
      ${detailsSql} AS details,
      length(${column}) AS value_length,
      left(${column}, 12) AS value_prefix
    FROM ${table}
    WHERE ${column} IS NOT NULL
      AND btrim(${column}) <> ''
      AND NOT (${column} ${spec.encryptedSql})
    ORDER BY id
    LIMIT 100
  `;
}

async function audit(client) {
  const findings = [];
  const skipped = [];

  for (const spec of SECRET_COLUMNS) {
    if (!(await tableExists(client, spec.table))) {
      skipped.push({ table: spec.table, reason: 'table_missing' });
      continue;
    }
    const result = await client.query(
      buildAuditQuery(spec),
      [spec.secretClass, spec.table, spec.column],
    );
    findings.push(...result.rows);
  }

  return { findings, skipped };
}

if (help) {
  process.stdout.write(usage());
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is required for secret encryption audit.\n');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const result = await audit(client);

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.findings.length === 0) {
    process.stdout.write('Secret encryption audit passed: no plaintext legacy rows found.\n');
    if (result.skipped.length > 0) {
      process.stdout.write(`Skipped missing tables: ${result.skipped.map((s) => s.table).join(', ')}\n`);
    }
  } else {
    process.stdout.write(`Secret encryption audit found ${result.findings.length} plaintext legacy row(s):\n`);
    for (const finding of result.findings) {
      process.stdout.write(
        `- ${finding.secret_class}: ${finding.table_name}.${finding.column_name} id=${finding.row_id} tenant=${finding.tenant_id} prefix=${finding.value_prefix}\n`,
      );
    }
  }

  process.exit(result.findings.length > 0 ? 2 : 0);
} catch (err) {
  process.stderr.write(`Secret encryption audit failed: ${err?.message || err}\n`);
  process.exit(1);
} finally {
  try {
    await client.end();
  } catch {
    // Ignore close errors after a failed connect/query.
  }
}
