#!/usr/bin/env node

import pg from 'pg';
import { pathToFileURL } from 'node:url';

const DEFAULT_TABLE = 'clinical_ai_modules';
const PRIMARY_KEY_NAME = 'clinical_ai_modules_pkey';

export function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    json: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function groupByModule(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.module_key) || {
      module_key: row.module_key,
      duplicate_count: Number(row.duplicate_count),
      keep: null,
      delete: [],
    };

    const normalized = {
      row_locator: row.row_locator,
      module_key: row.module_key,
      display_name: row.display_name,
      enabled: row.enabled,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    if (Number(row.keep_rank) === 1) {
      group.keep = normalized;
    } else {
      group.delete.push(normalized);
    }

    groups.set(row.module_key, group);
  }
  return [...groups.values()].sort((a, b) => String(a.module_key).localeCompare(String(b.module_key)));
}

async function primaryKeyPresent(client, tableName) {
  if (tableName !== DEFAULT_TABLE) return null;
  const { rows } = await client.query(
    `SELECT 1
       FROM pg_constraint
      WHERE conrelid = $1::regclass
        AND conname = $2
      LIMIT 1`,
    [tableName, PRIMARY_KEY_NAME],
  );
  return rows.length > 0;
}

async function ensurePrimaryKey(client, tableName) {
  if (tableName !== DEFAULT_TABLE) return { skipped: true };
  const present = await primaryKeyPresent(client, tableName);
  if (present) return { skipped: false, created: false };

  await client.query(
    `ALTER TABLE ${quoteIdentifier(tableName)}
       ADD CONSTRAINT ${quoteIdentifier(PRIMARY_KEY_NAME)} PRIMARY KEY (module_key)`,
  );
  return { skipped: false, created: true };
}

async function fetchDuplicateRows(client, tableName) {
  const table = quoteIdentifier(tableName);
  const { rows } = await client.query(
    `WITH ranked AS (
       SELECT
         ctid::text AS row_locator,
         module_key,
         display_name,
         enabled,
         created_at,
         updated_at,
         ROW_NUMBER() OVER (
           PARTITION BY module_key
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, ctid DESC
         ) AS keep_rank,
         COUNT(*) OVER (PARTITION BY module_key) AS duplicate_count
       FROM ${table}
       WHERE module_key IN (
         SELECT module_key
         FROM ${table}
         GROUP BY module_key
         HAVING COUNT(*) > 1
       )
     )
     SELECT *
     FROM ranked
     ORDER BY module_key, keep_rank`,
  );
  return rows;
}

async function deleteRowsByLocator(client, tableName, locators) {
  if (locators.length === 0) return [];
  const table = quoteIdentifier(tableName);
  const { rows } = await client.query(
    `DELETE FROM ${table}
      WHERE ctid::text = ANY($1::text[])
      RETURNING ctid::text AS row_locator, module_key, display_name, enabled, created_at, updated_at`,
    [locators],
  );
  return rows;
}

export async function reconcileClinicalAiCatalog(client, {
  apply = false,
  tableName = DEFAULT_TABLE,
  ensureConstraint = true,
} = {}) {
  const startedAt = new Date().toISOString();
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    table: tableName,
    started_at: startedAt,
    duplicate_module_keys: 0,
    rows_to_delete: 0,
    duplicate_groups: [],
    deleted_rows: [],
    primary_key_present_before: await primaryKeyPresent(client, tableName),
    primary_key_created: false,
  };

  if (apply) await client.query('BEGIN');

  try {
    if (apply) {
      await client.query(`LOCK TABLE ${quoteIdentifier(tableName)} IN SHARE ROW EXCLUSIVE MODE`);
    }

    const duplicateRows = await fetchDuplicateRows(client, tableName);
    const groups = groupByModule(duplicateRows);
    const locators = groups.flatMap((group) => group.delete.map((row) => row.row_locator));

    report.duplicate_groups = groups;
    report.duplicate_module_keys = groups.length;
    report.rows_to_delete = locators.length;

    if (apply) {
      report.deleted_rows = await deleteRowsByLocator(client, tableName, locators);
      if (ensureConstraint) {
        const constraint = await ensurePrimaryKey(client, tableName);
        report.primary_key_created = Boolean(constraint.created);
      }
      await client.query('COMMIT');
    }
  } catch (error) {
    if (apply) await client.query('ROLLBACK').catch(() => {});
    throw error;
  }

  report.primary_key_present_after = await primaryKeyPresent(client, tableName);
  report.completed_at = new Date().toISOString();
  return report;
}

export function formatReport(report) {
  const lines = [
    `Clinical AI catalog reconcile (${report.mode})`,
    `Table: ${report.table}`,
    `Primary key before: ${report.primary_key_present_before === null ? 'not checked' : report.primary_key_present_before ? 'present' : 'missing'}`,
    `Duplicate module keys: ${report.duplicate_module_keys}`,
    `Rows ${report.mode === 'apply' ? 'deleted' : 'planned for delete'}: ${report.mode === 'apply' ? report.deleted_rows.length : report.rows_to_delete}`,
  ];

  if (report.primary_key_created) {
    lines.push(`Primary key restored: ${PRIMARY_KEY_NAME}`);
  } else if (report.primary_key_present_after === false) {
    lines.push(`Primary key after: missing`);
  }

  for (const group of report.duplicate_groups) {
    lines.push(`- ${group.module_key}: keep ${group.keep?.row_locator || 'unknown'} updated_at=${group.keep?.updated_at || 'null'} display_name="${group.keep?.display_name || ''}"`);
    for (const row of group.delete) {
      lines.push(`  delete ${row.row_locator} updated_at=${row.updated_at || 'null'} display_name="${row.display_name || ''}" enabled=${row.enabled}`);
    }
  }

  if (report.mode === 'dry-run' && report.rows_to_delete > 0) {
    lines.push('Dry run only. Re-run with --apply to delete stale duplicates.');
  }

  if (report.mode === 'dry-run' && report.rows_to_delete === 0) {
    lines.push('No duplicate catalog rows found. No changes needed.');
  }

  return `${lines.join('\n')}\n`;
}

function usage() {
  return `Usage: node apps/backend/scripts/reconcile-clinical-ai-catalog.mjs [--dry-run] [--apply] [--json]

Dry-run is the default. --apply deletes stale duplicate clinical_ai_modules rows
after keeping the newest-updated row for each module_key and restores the
clinical_ai_modules_pkey constraint when missing.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL or TEST_DATABASE_URL is required');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const report = await reconcileClinicalAiCatalog(client, { apply: options.apply });
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[reconcile-clinical-ai-catalog] ${error.message}`);
    process.exit(1);
  });
}
