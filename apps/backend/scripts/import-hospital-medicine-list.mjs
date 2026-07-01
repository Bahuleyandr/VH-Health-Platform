import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { backfillCompositions } from './backfill-drug-compositions.mjs';

const SOURCE_MARKER = 'vh_hospital_medicine_list';
const DEFAULT_SHEET_NAME = 'Sheet1';
const LOCAL_DB_NAMES = new Set(['vhhealth_test', 'vh_health_test']);

function parseArgs(argv) {
  const args = {
    apply: false,
    file: null,
    sheet: DEFAULT_SHEET_NAME,
    limit: null,
    allowNonTest: process.env.VH_ALLOW_FORMULARY_IMPORT === 'true',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--allow-non-test') {
      args.allowNonTest = true;
    } else if (arg === '--file') {
      args.file = argv[i + 1];
      i += 1;
    } else if (arg === '--sheet') {
      args.sheet = argv[i + 1] || DEFAULT_SHEET_NAME;
      i += 1;
    } else if (arg === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (!args.file && !arg.startsWith('--')) {
      args.file = arg;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node scripts/import-hospital-medicine-list.mjs --file "C:\\path\\MEDCINE LIST.xlsx"
  node scripts/import-hospital-medicine-list.mjs --file "C:\\path\\MEDCINE LIST.xlsx" --apply --allow-non-test

Options:
  --file <path>        Hospital medicine Excel workbook.
  --sheet <name>       Sheet name. Defaults to ${DEFAULT_SHEET_NAME}.
  --limit <n>          Parse/import only first n normalized rows.
  --apply              Write to pharmacy_catalog. Without this, parse-only dry run.
  --allow-non-test     Allow writes to a non-local/non-test DATABASE_URL.

Safety:
  Non-test database writes require --allow-non-test or VH_ALLOW_FORMULARY_IMPORT=true.
`);
}

function cleanText(value, max = null) {
  if (value === undefined || value === null) return '';
  const text = String(value)
    .replace(/<br\s*\/?>/gi, '; ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = text === '-' || /^none$/i.test(text) ? '' : text;
  return max && normalized.length > max ? normalized.slice(0, max) : normalized;
}

function normalizeGeneric(value) {
  const seen = new Set();
  const parts = cleanText(value)
    .split(/\s*;\s*/)
    .map((part) => cleanText(part, 255))
    .filter(Boolean)
    .filter((part) => !/^none$/i.test(part));
  const out = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join('; ');
}

function normalizeCategory(drugType) {
  const text = cleanText(drugType, 100).toLowerCase();
  if (!text) return 'other';
  const normalized = text
    .replace(/[./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized === 'tablets' || normalized === 'tablet c') return 'tablet';
  if (normalized === 'capsules') return 'capsule';
  if (normalized === 'oral drops') return 'drops';
  if (normalized === 'nasalspray') return 'nasal spray';
  if (normalized === 'ivf') return 'iv fluid';
  return normalized.slice(0, 100);
}

function inferPackSize(particulars, drugType) {
  const text = cleanText(particulars);
  const type = normalizeCategory(drugType);
  const trailing = text.match(/-\s*([0-9]+(?:\.\d+)?\s*(?:s|tabs?|tablets?|caps?|capsules?|vials?|amp(?:oules?)?|ml|l|strips?|patch(?:es)?|sachet(?:s)?|unit(?:s)?))\s*$/i);
  if (trailing) return cleanText(trailing[1], 100);
  if (type && type !== 'other') return cleanText(type, 100);
  return '';
}

function requiresPrescriptionFor(category) {
  const nonRx = new Set([
    'surgical',
    'surgicals',
    'strips',
    'mask',
    'pack',
    'lotion',
    'shampoo',
    'solution',
    'paint',
  ]);
  return !nonRx.has(String(category).toLowerCase());
}

function sourceKeyFor(row) {
  const payload = [
    row.name,
    row.generic_name,
    row.category,
    row.manufacturer,
    row.pack_size,
  ].map((value) => String(value || '').toLowerCase()).join('|');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function normalizeRecord(row, rowNumber) {
  const manufacturer = cleanText(row.MFR, 255);
  const name = cleanText(row.PARTICULARS, 255);
  const rawDrugType = cleanText(row['DRUG TYPE'], 100);
  const category = normalizeCategory(rawDrugType);
  const genericName = normalizeGeneric(row['GENERIC NAME']);
  if (!name) return null;
  const packSize = inferPackSize(name, rawDrugType);
  const normalized = {
    row_number: rowNumber,
    name,
    generic_name: genericName || null,
    category,
    manufacturer: manufacturer || null,
    unit_price: null,
    price: 0,
    pack_size: packSize || null,
    requires_prescription: requiresPrescriptionFor(category),
    in_stock: true,
    is_available: true,
    stock_quantity: 0,
    stock: 0,
    reorder_level: 10,
    description: '',
  };
  const sourceKey = sourceKeyFor(normalized);
  normalized.source_key = sourceKey;
  normalized.description = [
    `source=${SOURCE_MARKER}`,
    `source_key=${sourceKey}`,
    `workbook_row=${rowNumber}`,
    rawDrugType ? `drug_type=${rawDrugType}` : null,
  ].filter(Boolean).join('; ');
  return normalized;
}

function findHeaderRow(worksheet) {
  for (let rowNumber = 1; rowNumber <= Math.min(20, worksheet.rowCount); rowNumber += 1) {
    const values = worksheet.getRow(rowNumber).values.map((value) => cleanText(value).toUpperCase());
    if (
      values.includes('MFR') &&
      values.includes('PARTICULARS') &&
      values.includes('DRUG TYPE') &&
      values.includes('GENERIC NAME')
    ) {
      return rowNumber;
    }
  }
  return null;
}

async function readWorkbook(filePath, sheetName, limit = null) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.getWorksheet(sheetName) || workbook.worksheets[0];
  if (!worksheet) throw new Error('Workbook has no worksheets');
  const headerRowNumber = findHeaderRow(worksheet);
  if (!headerRowNumber) throw new Error('Could not find MFR/PARTICULARS/DRUG TYPE/GENERIC NAME header row');

  const headerRow = worksheet.getRow(headerRowNumber);
  const columnForHeader = new Map();
  headerRow.eachCell((cell, colNumber) => {
    const key = cleanText(cell.value).toUpperCase();
    if (key) columnForHeader.set(key, colNumber);
  });

  const required = ['MFR', 'PARTICULARS', 'DRUG TYPE', 'GENERIC NAME'];
  for (const key of required) {
    if (!columnForHeader.has(key)) throw new Error(`Missing required column: ${key}`);
  }

  const records = [];
  const seen = new Set();
  const skipped = { blank: 0, duplicate: 0 };
  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const excelRow = worksheet.getRow(rowNumber);
    const row = {};
    for (const key of required) {
      row[key] = excelRow.getCell(columnForHeader.get(key)).value;
    }
    const normalized = normalizeRecord(row, rowNumber);
    if (!normalized) {
      skipped.blank += 1;
      continue;
    }
    if (seen.has(normalized.source_key)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(normalized.source_key);
    records.push(normalized);
    if (limit && records.length >= limit) break;
  }
  return { worksheetName: worksheet.name, headerRowNumber, records, skipped };
}

function isSafeLocalTestDatabase(connectionString) {
  try {
    const url = new URL(connectionString);
    const host = url.hostname.toLowerCase();
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    return ['127.0.0.1', 'localhost', '::1'].includes(host) && LOCAL_DB_NAMES.has(database);
  } catch {
    return false;
  }
}

function requireSafeApply(connectionString, allowNonTest) {
  if (isSafeLocalTestDatabase(connectionString)) return;
  if (allowNonTest) return;
  throw new Error(
    'Refusing to import into a non-local/non-test database. Re-run with --allow-non-test ' +
    'or VH_ALLOW_FORMULARY_IMPORT=true when this is intentional.',
  );
}

async function findExisting(client, record) {
  const bySource = await client.query(
    `SELECT id
       FROM pharmacy_catalog
      WHERE description LIKE $1
      LIMIT 1`,
    [`%source_key=${record.source_key}%`],
  );
  if (bySource.rows[0]) return bySource.rows[0].id;

  const byNaturalKey = await client.query(
    `SELECT id
       FROM pharmacy_catalog
      WHERE LOWER(name) = LOWER($1)
        AND COALESCE(LOWER(generic_name), '') = COALESCE(LOWER($2), '')
        AND COALESCE(LOWER(category), '') = COALESCE(LOWER($3), '')
        AND COALESCE(LOWER(manufacturer), '') = COALESCE(LOWER($4), '')
        AND COALESCE(LOWER(pack_size), '') = COALESCE(LOWER($5), '')
      LIMIT 1`,
    [record.name, record.generic_name, record.category, record.manufacturer, record.pack_size],
  );
  return byNaturalKey.rows[0]?.id ?? null;
}

async function importRecords(records, connectionString, allowNonTest) {
  requireSafeApply(connectionString, allowNonTest);
  const client = new pg.Client({ connectionString });
  await client.connect();
  const stats = { inserted: 0, updated: 0, unchanged: 0 };
  try {
    await client.query('BEGIN');
    for (const record of records) {
      const existingId = await findExisting(client, record);
      if (existingId) {
        const result = await client.query(
          `UPDATE pharmacy_catalog
              SET name = $1,
                  generic_name = $2,
                  category = $3,
                  manufacturer = $4,
                  unit_price = $5,
                  price = $6,
                  pack_size = $7,
                  requires_prescription = $8,
                  in_stock = $9,
                  is_available = $10,
                  is_active = TRUE,
                  stock_quantity = COALESCE(stock_quantity, $11),
                  stock = COALESCE(stock, $12),
                  reorder_level = COALESCE(reorder_level, $13),
                  description = $14,
                  updated_at = NOW()
            WHERE id = $15
          RETURNING (xmax = 0) AS inserted`,
          [
            record.name,
            record.generic_name,
            record.category,
            record.manufacturer,
            record.unit_price,
            record.price,
            record.pack_size,
            record.requires_prescription,
            record.in_stock,
            record.is_available,
            record.stock_quantity,
            record.stock,
            record.reorder_level,
            record.description,
            existingId,
          ],
        );
        stats.updated += result.rowCount;
      } else {
        await client.query(
          `INSERT INTO pharmacy_catalog
             (name, generic_name, category, manufacturer, unit_price, price,
              pack_size, requires_prescription, in_stock, is_active, is_available,
              stock_quantity, stock, reorder_level, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12, $13, $14)`,
          [
            record.name,
            record.generic_name,
            record.category,
            record.manufacturer,
            record.unit_price,
            record.price,
            record.pack_size,
            record.requires_prescription,
            record.in_stock,
            record.is_available,
            record.stock_quantity,
            record.stock,
            record.reorder_level,
            record.description,
          ],
        );
        stats.inserted += 1;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
  return stats;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

if (!args.file) {
  usage();
  throw new Error('Excel workbook path is required');
}

const filePath = path.resolve(args.file);
if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

const { worksheetName, headerRowNumber, records, skipped } = await readWorkbook(
  filePath,
  args.sheet,
  Number.isFinite(args.limit) && args.limit > 0 ? args.limit : null,
);

console.log(`Workbook: ${filePath}`);
console.log(`Sheet: ${worksheetName} (header row ${headerRowNumber})`);
console.log(`Normalized rows: ${records.length}`);
console.log(`Skipped blank: ${skipped.blank}; duplicate rows: ${skipped.duplicate}`);
console.log('Sample:', records.slice(0, 5).map((row) => ({
  name: row.name,
  generic_name: row.generic_name,
  category: row.category,
  manufacturer: row.manufacturer,
  pack_size: row.pack_size,
})));

if (!args.apply) {
  console.log('Dry run only. Re-run with --apply to write pharmacy_catalog.');
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required when using --apply');

const stats = await importRecords(records, connectionString, args.allowNonTest);
console.table(stats);

// Phase 1 composition layer: enrich every catalog row with structured
// composition/strength/form identity (idempotent; curated rows are skipped).
const compositionStats = await backfillCompositions({ connectionString });
console.log(
  `composition backfill: ${compositionStats.total} rows, ${compositionStats.resolved} high-confidence, ${compositionStats.queued} queued for curation`,
);
