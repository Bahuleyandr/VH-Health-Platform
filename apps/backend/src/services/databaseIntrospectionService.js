import prisma from '../lib/prisma.js';
import { quoteIdentifier, runSchemaContractCheck } from '../db/schemaContracts.js';
import { buildPagination, parseListQuery } from '../utils/listQuery.js';

const MAX_ROW_LIMIT = 100;
const DEFAULT_ROW_LIMIT = 50;
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_COLUMN_RE =
  /(password|secret|token|api[_-]?key|private[_-]?key|hash|encrypted|backup_codes|totp)/i;

function asNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '') return Number(value);
  return 0;
}

function normalizeJsonValue(value) {
  if (typeof value === 'bigint') {
    const asNumeric = Number(value);
    return Number.isSafeInteger(asNumeric) ? asNumeric : value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalizeJsonValue(nested)])
    );
  }
  return value;
}

function assertSafeTableName(tableName) {
  if (!TABLE_NAME_RE.test(String(tableName || ''))) {
    const err = new Error('Invalid table name');
    err.statusCode = 400;
    throw err;
  }
}

async function assertPublicTable(tableName) {
  assertSafeTableName(tableName);
  const result = await prisma.$queryRawUnsafe(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name = $1`,
    tableName
  );
  if (result.length === 0) {
    const err = new Error('Table not found');
    err.statusCode = 404;
    throw err;
  }
}

function redactRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      SENSITIVE_COLUMN_RE.test(key) && value != null ? '[redacted]' : normalizeJsonValue(value),
    ])
  );
}

async function getPrimaryKeyColumns(tableName) {
  const result = await prisma.$queryRawUnsafe(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    tableName
  );
  return result.map((row) => row.column_name);
}

export async function getDatabaseOverview() {
  const [tables, contractReport] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT c.relname AS table_name,
             COALESCE(s.n_live_tup, 0)::bigint AS row_estimate,
             pg_total_relation_size(c.oid)::bigint AS total_bytes,
             pg_relation_size(c.oid)::bigint AS table_bytes,
             COUNT(a.attname)::int AS column_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        LEFT JOIN pg_attribute a
               ON a.attrelid = c.oid
              AND a.attnum > 0
              AND NOT a.attisdropped
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relname NOT LIKE '\\_%' ESCAPE '\\'
       GROUP BY c.oid, c.relname, s.n_live_tup
       ORDER BY c.relname
    `),
    runSchemaContractCheck(prisma),
  ]);

  const normalizedTables = tables.map((table) => ({
    name: table.table_name,
    rowEstimate: asNumber(table.row_estimate),
    totalBytes: asNumber(table.total_bytes),
    tableBytes: asNumber(table.table_bytes),
    columnCount: asNumber(table.column_count),
  }));

  return {
    summary: {
      tableCount: normalizedTables.length,
      rowEstimate: normalizedTables.reduce((sum, table) => sum + table.rowEstimate, 0),
      totalBytes: normalizedTables.reduce((sum, table) => sum + table.totalBytes, 0),
      contractStatus: contractReport.ok ? 'passing' : 'failing',
      failingContracts: contractReport.totals.failing,
    },
    tables: normalizedTables,
    contracts: {
      ok: contractReport.ok,
      checkedAt: contractReport.checkedAt,
      totals: contractReport.totals,
      failures: contractReport.failures,
      items: contractReport.contracts.map((contract) => ({
        id: contract.id,
        label: contract.label,
        ok: contract.ok,
      })),
    },
  };
}

export async function getTableDetail(tableName) {
  await assertPublicTable(tableName);

  const [columns, indexes, constraints, primaryKeyColumns, rowCountResult] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default, ordinal_position
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position`,
      tableName
    ),
    prisma.$queryRawUnsafe(
      `SELECT indexname AS name, indexdef AS definition
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = $1
        ORDER BY indexname`,
      tableName
    ),
    prisma.$queryRawUnsafe(
      `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conrelid = $1::regclass
        ORDER BY conname`,
      tableName
    ),
    getPrimaryKeyColumns(tableName),
    prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(tableName)}`),
  ]);

  return {
    name: tableName,
    rowCount: asNumber(rowCountResult[0]?.count),
    primaryKeyColumns,
    columns: columns.map((column) => ({
      name: column.column_name,
      dataType: column.data_type,
      dbType: column.udt_name,
      nullable: column.is_nullable === 'YES',
      defaultValue: column.column_default,
      ordinalPosition: asNumber(column.ordinal_position),
      redactedInPreview: SENSITIVE_COLUMN_RE.test(column.column_name),
    })),
    indexes,
    constraints,
  };
}

export async function getTableRows(tableName, options = {}) {
  await assertPublicTable(tableName);

  const listQuery = parseListQuery(options, {
    defaultLimit: DEFAULT_ROW_LIMIT,
    maxLimit: MAX_ROW_LIMIT,
    defaultSortBy: 'primary_key',
    allowOffset: true,
  });
  const primaryKeyColumns = await getPrimaryKeyColumns(tableName);
  const orderBy = primaryKeyColumns.length
    ? ` ORDER BY ${primaryKeyColumns.map(quoteIdentifier).join(', ')}`
    : '';

  const [detail, rows] = await Promise.all([
    getTableDetail(tableName),
    prisma.$queryRawUnsafe(
      `SELECT *
         FROM ${quoteIdentifier(tableName)}
        ${orderBy}
        LIMIT $1 OFFSET $2`,
      listQuery.limit,
      listQuery.offset
    ),
  ]);
  const pageFromOffset = Math.floor(listQuery.offset / listQuery.limit) + 1;

  return {
    table: detail,
    pagination: {
      ...buildPagination(detail.rowCount, pageFromOffset, listQuery.limit),
      offset: listQuery.offset,
      returned: rows.length,
    },
    rows: rows.map(redactRow),
  };
}
