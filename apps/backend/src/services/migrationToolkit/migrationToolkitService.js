import crypto from 'node:crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const IMPORT_KINDS = ['patient', 'encounter', 'opening_ar', 'mixed'];
const FILE_KINDS = ['patient', 'encounter', 'opening_ar'];
const PROFILE_STATUSES = ['draft', 'active', 'archived'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CSV_ROWS = 5000;
const REDACTED = '[redacted]';

const AUTHORITATIVE_TABLES_BLOCKED = [
  'users',
  'patient_identifiers',
  'appointments',
  'patient_encounters',
  'admissions',
  'invoices',
  'ledger_entries',
  'ledger_postings',
  'payment_transactions',
];

const FIELD_ALIASES = {
  patient: {
    external_patient_id: ['external_patient_id', 'patient_id', 'legacy_patient_id', 'legacy_id'],
    mrn: ['mrn', 'medical_record_number', 'uhid', 'hospital_number'],
    full_name: ['full_name', 'name', 'patient_name'],
    first_name: ['first_name', 'given_name'],
    last_name: ['last_name', 'family_name', 'surname'],
    phone: ['phone', 'mobile', 'mobile_number', 'contact_number'],
    email: ['email', 'email_address'],
    dob: ['dob', 'date_of_birth', 'birth_date'],
    gender: ['gender', 'sex'],
  },
  encounter: {
    external_encounter_id: ['external_encounter_id', 'encounter_id', 'visit_id', 'legacy_visit_id'],
    external_patient_id: ['external_patient_id', 'patient_id', 'legacy_patient_id', 'legacy_id'],
    mrn: ['mrn', 'medical_record_number', 'uhid', 'hospital_number'],
    encounter_date: ['encounter_date', 'visit_date', 'admission_date', 'date'],
    encounter_type: ['encounter_type', 'visit_type', 'type'],
    department: ['department', 'department_name', 'specialty'],
    doctor: ['doctor', 'doctor_name', 'clinician'],
  },
  opening_ar: {
    external_invoice_id: ['external_invoice_id', 'invoice_id', 'legacy_invoice_id'],
    external_patient_id: ['external_patient_id', 'patient_id', 'legacy_patient_id', 'legacy_id'],
    mrn: ['mrn', 'medical_record_number', 'uhid', 'hospital_number'],
    invoice_number: ['invoice_number', 'bill_number', 'bill_no'],
    amount_due: ['amount_due', 'outstanding_amount', 'balance_due', 'open_amount'],
    currency: ['currency', 'currency_code'],
    invoice_date: ['invoice_date', 'bill_date', 'date'],
  },
};

function text(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const clean = String(value).trim();
  if (!clean) return null;
  return max ? clean.slice(0, max) : clean;
}

function normalizeHeader(value, fallback = null) {
  const clean = text(value, 120);
  if (!clean) return fallback;
  const normalized = clean
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function normalizeEnum(value, allowed, label, fallback = null) {
  const clean = text(value, 80) || fallback;
  if (!clean || !allowed.includes(clean)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return clean;
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  const clean = text(value, 80);
  if (!clean) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return clean;
}

function jsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function isMissingSchemaError(err) {
  return /relation .* does not exist|does not exist/i.test(String(err?.message || ''));
}

function isPhiField(key) {
  return /(^|_)(name|phone|mobile|email|address|dob|birth|mrn|uhid|abha|aadhaar|patient|guardian|identifier|id_number)($|_)/i
    .test(String(key || ''));
}

function redactValue(key, value) {
  if (value === null || value === undefined || value === '') return value ?? null;
  if (!isPhiField(key)) return value;
  return REDACTED;
}

function redactRow(row = {}) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, redactValue(key, value)]),
  );
}

function normalizePhone(value) {
  const clean = text(value, 80);
  if (!clean) return null;
  const digits = clean.replace(/\D/g, '');
  if (digits.length < 7) return clean.toLowerCase();
  return digits.slice(-10);
}

function normalizeDate(value) {
  const clean = text(value, 40);
  if (!clean) return null;
  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    return `${dmy[3]}-${month}-${day}`;
  }
  return clean;
}

function parseAmount(value) {
  const clean = text(value, 60);
  if (!clean) return null;
  const normalized = clean.replace(/[, ]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseCsvText(csvText) {
  const source = typeof csvText === 'string' ? csvText : '';
  if (!source.trim()) throw AppError.badRequest('csv_text is required');

  const parsedRows = [];
  let currentRow = [];
  let currentValue = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        currentValue += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentValue += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      currentRow.push(currentValue);
      currentValue = '';
    } else if (char === '\n') {
      currentRow.push(currentValue);
      parsedRows.push(currentRow);
      currentRow = [];
      currentValue = '';
    } else if (char !== '\r') {
      currentValue += char;
    }
  }

  if (inQuotes) throw AppError.badRequest('CSV has an unterminated quoted field');
  currentRow.push(currentValue);
  parsedRows.push(currentRow);

  const nonEmptyRows = parsedRows.filter((row) => row.some((cell) => text(cell) !== null));
  if (nonEmptyRows.length < 2) throw AppError.badRequest('CSV must include a header row and at least one data row');

  const headers = nonEmptyRows[0].map((header, index) => normalizeHeader(header, `column_${index + 1}`));
  const seenHeaders = new Set();
  const uniqueHeaders = headers.map((header, index) => {
    if (!seenHeaders.has(header)) {
      seenHeaders.add(header);
      return header;
    }
    const deduped = `${header}_${index + 1}`;
    seenHeaders.add(deduped);
    return deduped;
  });

  const rows = nonEmptyRows.slice(1).map((cells, index) => {
    const row = {};
    uniqueHeaders.forEach((header, headerIndex) => {
      row[header] = text(cells[headerIndex], 4000);
    });
    return {
      rowNumber: index + 2,
      row,
    };
  });

  if (rows.length > MAX_CSV_ROWS) {
    throw AppError.badRequest(`CSV rehearsal is limited to ${MAX_CSV_ROWS} rows per file`);
  }

  return { headers: uniqueHeaders, rows };
}

function inferType(value) {
  const clean = text(value, 120);
  if (!clean) return 'empty';
  if (parseAmount(clean) !== null) return 'number';
  if (/^\d{4}-\d{2}-\d{2}/.test(clean) || /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(clean)) return 'date';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return 'email';
  if (clean.replace(/\D/g, '').length >= 7) return 'phone_like';
  return 'text';
}

function buildColumnProfile(headers, parsedRows) {
  const profile = {};
  headers.forEach((header) => {
    const uniqueValues = new Set();
    const typeCounts = {};
    let nonEmpty = 0;
    let maxLength = 0;

    parsedRows.forEach(({ row }) => {
      const value = row[header];
      const clean = text(value, 4000);
      const type = inferType(clean);
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      if (clean) {
        nonEmpty += 1;
        maxLength = Math.max(maxLength, clean.length);
        if (uniqueValues.size < 100) uniqueValues.add(clean.toLowerCase());
      }
    });

    profile[header] = {
      non_empty_count: nonEmpty,
      empty_count: parsedRows.length - nonEmpty,
      unique_count_capped: uniqueValues.size,
      max_length: maxLength,
      inferred_types: typeCounts,
      phi_redacted: isPhiField(header),
    };
  });
  return profile;
}

function buildCsvProfile({ csvText, sourceFilename, fileKind, mimeType = 'text/csv' }) {
  const parsed = parseCsvText(csvText);
  const cleanFilename = text(sourceFilename, 260) || `${fileKind}.csv`;
  return {
    parsed,
    sourceFilename: cleanFilename,
    contentSha256: sha256(csvText),
    byteSize: Buffer.byteLength(csvText, 'utf8'),
    mimeType: text(mimeType, 120) || 'text/csv',
    rowCount: parsed.rows.length,
    headerRow: parsed.headers,
    columnProfile: buildColumnProfile(parsed.headers, parsed.rows),
    sampleRowsRedacted: parsed.rows.slice(0, 5).map(({ rowNumber, row }) => ({
      row_number: rowNumber,
      values: redactRow(row),
    })),
    storageContract: {
      raw_content_stored: false,
      accepted_format: 'text/csv',
      content_sha256_required: true,
      persisted_payloads: ['column_profile', 'sample_rows_redacted', 'validation_findings', 'rehearsal_report'],
      report_redaction: 'phi_redacted',
    },
  };
}

function getField(row, fieldMap, targetField, aliases) {
  const mapped = text(fieldMap?.[targetField], 120);
  if (mapped) {
    const mappedKey = normalizeHeader(mapped);
    if (Object.prototype.hasOwnProperty.call(row, mappedKey)) return row[mappedKey];
  }

  for (const alias of aliases) {
    const aliasKey = normalizeHeader(alias);
    if (Object.prototype.hasOwnProperty.call(row, aliasKey)) return row[aliasKey];
  }
  return null;
}

function canonicalizeRow(kind, row, fieldMap = {}) {
  const aliases = FIELD_ALIASES[kind];
  const values = {};
  Object.keys(aliases).forEach((field) => {
    values[field] = text(getField(row, fieldMap, field, aliases[field]), 2000);
  });

  if (kind === 'patient') {
    const fullName = values.full_name || [values.first_name, values.last_name].filter(Boolean).join(' ');
    return {
      ...values,
      full_name: text(fullName, 240),
      phone_normalized: normalizePhone(values.phone),
      dob: normalizeDate(values.dob),
    };
  }

  if (kind === 'encounter') {
    return {
      ...values,
      encounter_date: normalizeDate(values.encounter_date),
    };
  }

  return {
    ...values,
    invoice_date: normalizeDate(values.invoice_date),
    amount_due_number: parseAmount(values.amount_due),
    currency: (values.currency || 'INR').toUpperCase(),
  };
}

function makeFinding({
  code,
  severity,
  targetKind,
  fieldName = null,
  rowNumber = null,
  message,
  remediationHint = null,
  metadata = {},
}) {
  return {
    finding_code: code,
    severity,
    target_kind: targetKind,
    field_name: fieldName,
    source_row_number: rowNumber,
    message_redacted: message,
    remediation_hint: remediationHint,
    metadata,
  };
}

function validateCanonicalRow(kind, canonical, rowNumber) {
  const findings = [];

  if (kind === 'patient') {
    if (!canonical.full_name) {
      findings.push(makeFinding({
        code: 'PATIENT_NAME_REQUIRED',
        severity: 'error',
        targetKind: kind,
        fieldName: 'full_name',
        rowNumber,
        message: `Row ${rowNumber} is missing a patient name.`,
        remediationHint: 'Map a full_name column or both first_name and last_name.',
      }));
    }
    if (!canonical.phone_normalized && !canonical.external_patient_id && !canonical.mrn) {
      findings.push(makeFinding({
        code: 'PATIENT_IDENTITY_REQUIRED',
        severity: 'error',
        targetKind: kind,
        fieldName: 'phone',
        rowNumber,
        message: `Row ${rowNumber} has no patient identifier for matching.`,
        remediationHint: 'Provide phone, MRN, or legacy patient id before commit rehearsal.',
      }));
    }
    if (!canonical.dob) {
      findings.push(makeFinding({
        code: 'PATIENT_DOB_RECOMMENDED',
        severity: 'warning',
        targetKind: kind,
        fieldName: 'dob',
        rowNumber,
        message: `Row ${rowNumber} has no date of birth for duplicate confidence.`,
        remediationHint: 'Add DOB where available; it improves duplicate matching.',
      }));
    }
  }

  if (kind === 'encounter') {
    if (!canonical.external_patient_id && !canonical.mrn) {
      findings.push(makeFinding({
        code: 'ENCOUNTER_PATIENT_REFERENCE_REQUIRED',
        severity: 'error',
        targetKind: kind,
        fieldName: 'external_patient_id',
        rowNumber,
        message: `Row ${rowNumber} has no patient reference for encounter matching.`,
        remediationHint: 'Map external_patient_id or MRN from the source file.',
      }));
    }
    if (!canonical.encounter_date) {
      findings.push(makeFinding({
        code: 'ENCOUNTER_DATE_REQUIRED',
        severity: 'error',
        targetKind: kind,
        fieldName: 'encounter_date',
        rowNumber,
        message: `Row ${rowNumber} has no encounter date.`,
        remediationHint: 'Map a YYYY-MM-DD encounter, visit, or admission date.',
      }));
    }
    if (!canonical.encounter_type) {
      findings.push(makeFinding({
        code: 'ENCOUNTER_TYPE_RECOMMENDED',
        severity: 'warning',
        targetKind: kind,
        fieldName: 'encounter_type',
        rowNumber,
        message: `Row ${rowNumber} has no encounter type.`,
        remediationHint: 'Map OP/IP/ER or a legacy visit type for acceptance reporting.',
      }));
    }
  }

  if (kind === 'opening_ar') {
    if (!canonical.external_patient_id && !canonical.mrn) {
      findings.push(makeFinding({
        code: 'OPENING_AR_PATIENT_REFERENCE_REQUIRED',
        severity: 'error',
        targetKind: kind,
        fieldName: 'external_patient_id',
        rowNumber,
        message: `Row ${rowNumber} has no patient reference for opening AR.`,
        remediationHint: 'Map external_patient_id or MRN from the billing export.',
      }));
    }
    if (!canonical.invoice_number && !canonical.external_invoice_id) {
      findings.push(makeFinding({
        code: 'OPENING_AR_INVOICE_REQUIRED',
        severity: 'error',
        targetKind: kind,
        fieldName: 'invoice_number',
        rowNumber,
        message: `Row ${rowNumber} has no invoice or bill number.`,
        remediationHint: 'Map a stable source invoice id before a commit-path slice.',
      }));
    }
    if (canonical.amount_due_number === null || canonical.amount_due_number < 0) {
      findings.push(makeFinding({
        code: 'OPENING_AR_AMOUNT_INVALID',
        severity: 'error',
        targetKind: kind,
        fieldName: 'amount_due',
        rowNumber,
        message: `Row ${rowNumber} has an invalid opening AR amount.`,
        remediationHint: 'Provide a non-negative numeric outstanding amount.',
      }));
    }
  }

  return findings;
}

function addDuplicateGroupFindings({ records, keyName, code, message, targetKind, findingsByRow }) {
  const groups = new Map();
  records.forEach((record) => {
    const value = text(record.duplicateKeys[keyName], 200);
    if (!value) return;
    const key = value.toLowerCase();
    const existing = groups.get(key) || [];
    existing.push(record.rowNumber);
    groups.set(key, existing);
  });

  let groupCount = 0;
  let rowCount = 0;
  groups.forEach((rows) => {
    if (rows.length < 2) return;
    groupCount += 1;
    rowCount += rows.length;
    rows.forEach((rowNumber) => {
      const rowFindings = findingsByRow.get(rowNumber) || [];
      rowFindings.push(makeFinding({
        code,
        severity: 'warning',
        targetKind,
        fieldName: keyName,
        rowNumber,
        message: `Row ${rowNumber} has a possible duplicate in this source file.`,
        remediationHint: message,
        metadata: { duplicate_key_type: keyName, duplicate_rows: rows },
      }));
      findingsByRow.set(rowNumber, rowFindings);
    });
  });

  return { groupCount, rowCount };
}

function detectInFileDuplicates(kind, records, findingsByRow) {
  const summary = { duplicate_groups: 0, duplicate_rows: 0, by_key_type: {} };
  const keysByKind = {
    patient: [
      ['phone_normalized', 'PATIENT_DUPLICATE_IN_FILE', 'Review patient identity before any commit run.'],
      ['external_patient_id', 'PATIENT_DUPLICATE_IN_FILE', 'Resolve repeated legacy patient ids before commit.'],
      ['mrn', 'PATIENT_DUPLICATE_IN_FILE', 'Resolve repeated MRNs before commit.'],
      ['name_dob', 'PATIENT_DUPLICATE_IN_FILE', 'Review same-name and same-DOB records.'],
    ],
    encounter: [
      ['external_encounter_id', 'ENCOUNTER_DUPLICATE_IN_FILE', 'Resolve repeated encounter ids before commit.'],
    ],
    opening_ar: [
      ['invoice_number', 'OPENING_AR_DUPLICATE_IN_FILE', 'Resolve repeated bill numbers before commit.'],
      ['external_invoice_id', 'OPENING_AR_DUPLICATE_IN_FILE', 'Resolve repeated invoice ids before commit.'],
    ],
  };

  (keysByKind[kind] || []).forEach(([keyName, code, hint]) => {
    const result = addDuplicateGroupFindings({
      records,
      keyName,
      code,
      message: hint,
      targetKind: kind,
      findingsByRow,
    });
    if (result.groupCount > 0) {
      summary.duplicate_groups += result.groupCount;
      summary.duplicate_rows += result.rowCount;
      summary.by_key_type[keyName] = result;
    }
  });

  return summary;
}

function duplicateKeysFor(kind, canonical) {
  if (kind === 'patient') {
    return {
      phone_normalized: canonical.phone_normalized,
      external_patient_id: canonical.external_patient_id,
      mrn: canonical.mrn,
      name_dob: canonical.full_name && canonical.dob
        ? `${canonical.full_name.toLowerCase()}|${canonical.dob}`
        : null,
    };
  }
  if (kind === 'encounter') {
    return { external_encounter_id: canonical.external_encounter_id };
  }
  return {
    invoice_number: canonical.invoice_number,
    external_invoice_id: canonical.external_invoice_id,
  };
}

async function addExistingPatientFindings({ tenantId, records, findingsByRow }) {
  const phones = [...new Set(records.map((record) => record.canonical.phone_normalized).filter(Boolean))];
  if (phones.length === 0) return { existing_patient_candidates: 0 };

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT phone
       FROM users
       WHERE tenant_id = $1::uuid
         AND role = 'PATIENT'
         AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ANY($2::text[])`,
      tenantId,
      phones,
    );
    const existingPhones = new Set(rows.map((row) => normalizePhone(row.phone)).filter(Boolean));
    let candidates = 0;
    records.forEach((record) => {
      if (!record.canonical.phone_normalized || !existingPhones.has(record.canonical.phone_normalized)) return;
      candidates += 1;
      const rowFindings = findingsByRow.get(record.rowNumber) || [];
      rowFindings.push(makeFinding({
        code: 'PATIENT_POSSIBLE_EXISTING_MATCH',
        severity: 'warning',
        targetKind: 'patient',
        fieldName: 'phone',
        rowNumber: record.rowNumber,
        message: `Row ${record.rowNumber} may match an existing tenant patient.`,
        remediationHint: 'Review the duplicate queue before a future commit-path run.',
        metadata: { duplicate_key_type: 'phone', source: 'users' },
      }));
      findingsByRow.set(record.rowNumber, rowFindings);
    });
    return { existing_patient_candidates: candidates };
  } catch (err) {
    if (isMissingSchemaError(err)) return { existing_patient_candidates: 0, skipped: 'users_schema_missing' };
    throw err;
  }
}

function summarizeFindings(findings) {
  const summary = {
    total: findings.length,
    by_severity: { info: 0, warning: 0, error: 0 },
    by_code: {},
  };
  findings.forEach((finding) => {
    summary.by_severity[finding.severity] = (summary.by_severity[finding.severity] || 0) + 1;
    summary.by_code[finding.finding_code] = (summary.by_code[finding.finding_code] || 0) + 1;
  });
  return summary;
}

function validationStateFor(findings) {
  if (findings.some((finding) => finding.severity === 'error')) return 'error';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  return 'valid';
}

function sourceKeyFor(kind, canonical) {
  if (kind === 'patient') {
    return canonical.external_patient_id || canonical.mrn || canonical.phone_normalized || null;
  }
  if (kind === 'encounter') {
    return canonical.external_encounter_id || canonical.external_patient_id || canonical.mrn || null;
  }
  return canonical.external_invoice_id || canonical.invoice_number || null;
}

function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw AppError.badRequest('files must include at least one CSV source file');
  }
  return files.map((file, index) => ({
    fileKind: normalizeEnum(file?.file_kind || file?.fileKind, FILE_KINDS, `files[${index}].file_kind`),
    sourceFilename: text(file?.source_filename || file?.sourceFilename, 260) || `source-${index + 1}.csv`,
    csvText: typeof file?.csv_text === 'string' ? file.csv_text : file?.csvText,
    mimeType: text(file?.mime_type || file?.mimeType, 120) || 'text/csv',
    mappingProfileId: file?.mapping_profile_id || file?.mappingProfileId || null,
    fieldMap: jsonObject(file?.field_map || file?.fieldMap || {}, `files[${index}].field_map`),
  }));
}

async function getJobOrThrow(tenantId, jobId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id, job_name, source_system, import_kind, status,
            dry_run_only, authoritative_write_enabled, redaction_mode, row_counts,
            created_by, created_at, updated_at, completed_at, metadata
     FROM migration_import_jobs
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    normalizeId(jobId, 'job id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Migration import job not found');
  return rows[0];
}

async function resolveMappingProfile(tenantId, mappingProfileId) {
  if (!mappingProfileId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, field_map
     FROM migration_mapping_profiles
     WHERE id = $1 AND tenant_id = $2::uuid AND status <> 'archived'
     LIMIT 1`,
    normalizeId(mappingProfileId, 'mapping profile id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Migration mapping profile not found');
  return rows[0];
}

async function insertSourceFile({ tenantId, jobId, fileKind, sourceFilename, profile, createdBy }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO migration_source_files
       (tenant_id, job_id, file_kind, source_filename, content_sha256, mime_type,
        byte_size, row_count, header_row, column_profile, sample_rows_redacted,
        storage_contract, uploaded_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
             $11::jsonb, $12::jsonb, $13::uuid)
     RETURNING id, uid, tenant_id, job_id, file_kind, source_filename,
               content_sha256, mime_type, byte_size, row_count, header_row,
               column_profile, sample_rows_redacted, storage_contract, created_at`,
    tenantId,
    normalizeId(jobId, 'job id'),
    fileKind,
    sourceFilename,
    profile.contentSha256,
    profile.mimeType,
    profile.byteSize,
    profile.rowCount,
    JSON.stringify(profile.headerRow),
    JSON.stringify(profile.columnProfile),
    JSON.stringify(profile.sampleRowsRedacted),
    JSON.stringify(profile.storageContract),
    maybeUuid(createdBy, 'uploaded_by'),
  );
  return rows[0];
}

async function insertImportRecord({
  tenantId,
  jobId,
  sourceFileId,
  mappingProfileId,
  targetKind,
  sourceRowNumber,
  sourceKey,
  rowHash,
  previewRedacted,
  validationState,
  duplicateCandidate,
  duplicateSummary,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO migration_import_records
       (tenant_id, job_id, source_file_id, mapping_profile_id, target_kind,
        source_row_number, source_key, row_hash, normalized_preview_redacted,
        validation_state, duplicate_candidate, duplicate_summary)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb)
     RETURNING id, uid, validation_state, duplicate_candidate`,
    tenantId,
    normalizeId(jobId, 'job id'),
    normalizeId(sourceFileId, 'source file id'),
    mappingProfileId ? normalizeId(mappingProfileId, 'mapping profile id') : null,
    targetKind,
    sourceRowNumber,
    text(sourceKey, 180),
    rowHash,
    JSON.stringify(previewRedacted),
    validationState,
    duplicateCandidate,
    JSON.stringify(duplicateSummary),
  );
  return rows[0];
}

async function insertFinding({ tenantId, jobId, sourceFileId, importRecordId, finding }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO migration_validation_findings
       (tenant_id, job_id, source_file_id, import_record_id, finding_code,
        severity, target_kind, field_name, source_row_number, message_redacted,
        remediation_hint, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     RETURNING id, uid, finding_code, severity, target_kind, field_name,
               source_row_number, message_redacted, remediation_hint, metadata`,
    tenantId,
    normalizeId(jobId, 'job id'),
    normalizeId(sourceFileId, 'source file id'),
    importRecordId ? normalizeId(importRecordId, 'import record id') : null,
    finding.finding_code,
    finding.severity,
    finding.target_kind,
    finding.field_name,
    finding.source_row_number,
    finding.message_redacted,
    finding.remediation_hint,
    JSON.stringify(finding.metadata || {}),
  );
  return rows[0];
}

export async function createImportJob({
  tenantId = null,
  jobName,
  sourceSystem = null,
  importKind = 'mixed',
  createdBy = null,
  metadata = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const cleanName = text(jobName, 180);
  if (!cleanName) throw AppError.badRequest('job_name is required');
  const kind = normalizeEnum(importKind, IMPORT_KINDS, 'import_kind', 'mixed');

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO migration_import_jobs
       (tenant_id, job_name, source_system, import_kind, created_by, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6::jsonb)
     RETURNING id, uid, tenant_id, job_name, source_system, import_kind, status,
               dry_run_only, authoritative_write_enabled, redaction_mode, row_counts,
               created_by, created_at, updated_at, completed_at, metadata`,
    tid,
    cleanName,
    text(sourceSystem, 120),
    kind,
    maybeUuid(createdBy, 'created_by'),
    JSON.stringify(jsonObject(metadata, 'metadata')),
  );
  return rows[0];
}

export async function listImportJobs({
  tenantId = null,
  status = null,
  importKind = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const params = [tid];
  const filters = ['tenant_id = $1::uuid'];
  if (status) {
    params.push(text(status, 40));
    filters.push(`status = $${params.length}`);
  }
  if (importKind) {
    params.push(normalizeEnum(importKind, IMPORT_KINDS, 'import_kind'));
    filters.push(`import_kind = $${params.length}`);
  }
  params.push(normalizeLimit(limit));

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id, job_name, source_system, import_kind, status,
            dry_run_only, authoritative_write_enabled, redaction_mode, row_counts,
            created_by, created_at, updated_at, completed_at, metadata
     FROM migration_import_jobs
     WHERE ${filters.join(' AND ')}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${params.length}`,
    ...params,
  );
  return { jobs: rows, count: rows.length };
}

export async function upsertMappingProfile({
  tenantId = null,
  profileName,
  sourceSystem = null,
  targetKind,
  version = 1,
  status = 'draft',
  fieldMap = {},
  transformNotes = null,
  createdBy = null,
  metadata = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const cleanName = text(profileName, 180);
  if (!cleanName) throw AppError.badRequest('profile_name is required');
  const kind = normalizeEnum(targetKind, FILE_KINDS, 'target_kind');
  const cleanStatus = normalizeEnum(status, PROFILE_STATUSES, 'status', 'draft');
  const cleanVersion = normalizeId(version, 'version');

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO migration_mapping_profiles
       (tenant_id, profile_name, source_system, target_kind, version, status,
        field_map, transform_notes, created_by, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::uuid, $10::jsonb)
     ON CONFLICT (tenant_id, target_kind, profile_name, version)
     DO UPDATE SET
       source_system = EXCLUDED.source_system,
       status = EXCLUDED.status,
       field_map = EXCLUDED.field_map,
       transform_notes = EXCLUDED.transform_notes,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, uid, tenant_id, profile_name, source_system, target_kind,
               version, status, field_map, transform_notes, created_by,
               created_at, updated_at, metadata`,
    tid,
    cleanName,
    text(sourceSystem, 120),
    kind,
    cleanVersion,
    cleanStatus,
    JSON.stringify(jsonObject(fieldMap, 'field_map')),
    text(transformNotes),
    maybeUuid(createdBy, 'created_by'),
    JSON.stringify(jsonObject(metadata, 'metadata')),
  );
  return rows[0];
}

export async function listMappingProfiles({
  tenantId = null,
  targetKind = null,
  status = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const params = [tid];
  const filters = ['tenant_id = $1::uuid'];
  if (targetKind) {
    params.push(normalizeEnum(targetKind, FILE_KINDS, 'target_kind'));
    filters.push(`target_kind = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, PROFILE_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  params.push(normalizeLimit(limit));

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id, profile_name, source_system, target_kind,
            version, status, field_map, transform_notes, created_by,
            created_at, updated_at, metadata
     FROM migration_mapping_profiles
     WHERE ${filters.join(' AND ')}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${params.length}`,
    ...params,
  );
  return { profiles: rows, count: rows.length };
}

export async function profileSourceFile({
  tenantId = null,
  jobId,
  fileKind,
  sourceFilename,
  csvText,
  mimeType = 'text/csv',
  uploadedBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  await getJobOrThrow(tid, jobId);
  const kind = normalizeEnum(fileKind, FILE_KINDS, 'file_kind');
  const profile = buildCsvProfile({ csvText, sourceFilename, fileKind: kind, mimeType });
  const row = await insertSourceFile({
    tenantId: tid,
    jobId,
    fileKind: kind,
    sourceFilename: profile.sourceFilename,
    profile,
    createdBy: uploadedBy,
  });

  await prisma.$queryRawUnsafe(
    `UPDATE migration_import_jobs
     SET status = 'profiled',
         row_counts = jsonb_set(
           COALESCE(row_counts, '{}'::jsonb),
           ARRAY[$1],
           to_jsonb($2::int),
           true
         ),
         updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4::uuid`,
    kind,
    profile.rowCount,
    normalizeId(jobId, 'job id'),
    tid,
  );

  return row;
}

async function clearPriorRehearsalRows({ tenantId, jobId }) {
  await prisma.$queryRawUnsafe(
    `DELETE FROM migration_rehearsal_reports
     WHERE job_id = $1 AND tenant_id = $2::uuid`,
    normalizeId(jobId, 'job id'),
    tenantId,
  );
  await prisma.$queryRawUnsafe(
    `DELETE FROM migration_validation_findings
     WHERE job_id = $1 AND tenant_id = $2::uuid`,
    normalizeId(jobId, 'job id'),
    tenantId,
  );
  await prisma.$queryRawUnsafe(
    `DELETE FROM migration_import_records
     WHERE job_id = $1 AND tenant_id = $2::uuid`,
    normalizeId(jobId, 'job id'),
    tenantId,
  );
  await prisma.$queryRawUnsafe(
    `DELETE FROM migration_source_files
     WHERE job_id = $1 AND tenant_id = $2::uuid`,
    normalizeId(jobId, 'job id'),
    tenantId,
  );
}

async function processFileForRehearsal({ tenantId, jobId, fileInput, generatedBy }) {
  const profile = buildCsvProfile({
    csvText: fileInput.csvText,
    sourceFilename: fileInput.sourceFilename,
    fileKind: fileInput.fileKind,
    mimeType: fileInput.mimeType,
  });
  const mappingProfile = await resolveMappingProfile(tenantId, fileInput.mappingProfileId);
  const fieldMap = mappingProfile?.field_map || fileInput.fieldMap || {};
  const sourceFile = await insertSourceFile({
    tenantId,
    jobId,
    fileKind: fileInput.fileKind,
    sourceFilename: profile.sourceFilename,
    profile,
    createdBy: generatedBy,
  });

  const records = profile.parsed.rows.map(({ rowNumber, row }) => {
    const canonical = canonicalizeRow(fileInput.fileKind, row, fieldMap);
    return {
      rowNumber,
      row,
      canonical,
      duplicateKeys: duplicateKeysFor(fileInput.fileKind, canonical),
    };
  });

  const findingsByRow = new Map();
  records.forEach((record) => {
    findingsByRow.set(
      record.rowNumber,
      validateCanonicalRow(fileInput.fileKind, record.canonical, record.rowNumber),
    );
  });

  const duplicateSummary = detectInFileDuplicates(fileInput.fileKind, records, findingsByRow);
  const existingSummary = fileInput.fileKind === 'patient'
    ? await addExistingPatientFindings({ tenantId, records, findingsByRow })
    : {};

  const insertedFindings = [];
  let validRows = 0;
  let warningRows = 0;
  let errorRows = 0;

  for (const record of records) {
    const rowFindings = findingsByRow.get(record.rowNumber) || [];
    const validationState = validationStateFor(rowFindings);
    if (validationState === 'valid') validRows += 1;
    if (validationState === 'warning') warningRows += 1;
    if (validationState === 'error') errorRows += 1;

    const row = await insertImportRecord({
      tenantId,
      jobId,
      sourceFileId: sourceFile.id,
      mappingProfileId: mappingProfile?.id || null,
      targetKind: fileInput.fileKind,
      sourceRowNumber: record.rowNumber,
      sourceKey: sourceKeyFor(fileInput.fileKind, record.canonical),
      rowHash: sha256(JSON.stringify(record.row)),
      previewRedacted: redactRow(record.canonical),
      validationState,
      duplicateCandidate: rowFindings.some((finding) => /DUPLICATE|EXISTING_MATCH/.test(finding.finding_code)),
      duplicateSummary: {
        finding_codes: rowFindings
          .filter((finding) => /DUPLICATE|EXISTING_MATCH/.test(finding.finding_code))
          .map((finding) => finding.finding_code),
      },
    });

    for (const finding of rowFindings) {
      insertedFindings.push(await insertFinding({
        tenantId,
        jobId,
        sourceFileId: sourceFile.id,
        importRecordId: row.id,
        finding,
      }));
    }
  }

  return {
    source_file: sourceFile,
    row_count: records.length,
    valid_rows: validRows,
    warning_rows: warningRows,
    error_rows: errorRows,
    duplicate_summary: { ...duplicateSummary, ...existingSummary },
    findings: insertedFindings,
  };
}

export async function rehearseImportJob({
  tenantId = null,
  jobId,
  files,
  generatedBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const job = await getJobOrThrow(tid, jobId);
  const normalizedFiles = normalizeFiles(files);

  await clearPriorRehearsalRows({ tenantId: tid, jobId: job.id });

  const fileResults = [];
  for (const fileInput of normalizedFiles) {
    fileResults.push(await processFileForRehearsal({
      tenantId: tid,
      jobId: job.id,
      fileInput,
      generatedBy,
    }));
  }

  const allFindings = fileResults.flatMap((result) => result.findings);
  const validationSummary = summarizeFindings(allFindings);
  const rowCounts = fileResults.reduce((acc, result) => {
    acc[result.source_file.file_kind] = (acc[result.source_file.file_kind] || 0) + result.row_count;
    acc.total = (acc.total || 0) + result.row_count;
    acc.valid = (acc.valid || 0) + result.valid_rows;
    acc.warning = (acc.warning || 0) + result.warning_rows;
    acc.error = (acc.error || 0) + result.error_rows;
    return acc;
  }, {});
  const duplicateSummary = fileResults.reduce((acc, result) => {
    acc.duplicate_groups += result.duplicate_summary.duplicate_groups || 0;
    acc.duplicate_rows += result.duplicate_summary.duplicate_rows || 0;
    acc.existing_patient_candidates += result.duplicate_summary.existing_patient_candidates || 0;
    return acc;
  }, { duplicate_groups: 0, duplicate_rows: 0, existing_patient_candidates: 0 });

  const reportStatus = validationSummary.by_severity.error > 0 ? 'blocked' : 'report_ready';
  const noWriteProof = {
    dry_run_only: true,
    authoritative_write_enabled: false,
    authoritative_tables_blocked: AUTHORITATIVE_TABLES_BLOCKED,
    source_raw_content_persisted: false,
    toolkit_tables_written: [
      'migration_source_files',
      'migration_import_records',
      'migration_validation_findings',
      'migration_rehearsal_reports',
    ],
  };
  const summary = {
    job_id: job.id,
    import_kind: job.import_kind,
    source_files: fileResults.map((result) => ({
      id: result.source_file.id,
      file_kind: result.source_file.file_kind,
      source_filename: result.source_file.source_filename,
      content_sha256: result.source_file.content_sha256,
      row_count: result.row_count,
    })),
    row_counts: rowCounts,
  };

  const reportRows = await prisma.$queryRawUnsafe(
    `INSERT INTO migration_rehearsal_reports
       (tenant_id, job_id, status, summary, validation_summary, duplicate_summary,
        no_write_proof, generated_by)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::uuid)
     RETURNING id, uid, tenant_id, job_id, status, phi_redacted, summary,
               validation_summary, duplicate_summary, no_write_proof,
               generated_by, created_at, metadata`,
    tid,
    job.id,
    reportStatus,
    JSON.stringify(summary),
    JSON.stringify(validationSummary),
    JSON.stringify(duplicateSummary),
    JSON.stringify(noWriteProof),
    maybeUuid(generatedBy, 'generated_by'),
  );

  await prisma.$queryRawUnsafe(
    `UPDATE migration_import_jobs
     SET status = 'report_ready',
         row_counts = $1::jsonb,
         updated_at = NOW(),
         completed_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid`,
    JSON.stringify(rowCounts),
    job.id,
    tid,
  );

  return {
    report: reportRows[0],
    files: fileResults.map((result) => result.source_file),
    findings: allFindings,
  };
}

export async function getRehearsalReport({ tenantId = null, jobId } = {}) {
  const tid = requireTenantId(tenantId);
  await getJobOrThrow(tid, jobId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id, job_id, status, phi_redacted, summary,
            validation_summary, duplicate_summary, no_write_proof,
            generated_by, created_at, metadata
     FROM migration_rehearsal_reports
     WHERE job_id = $1 AND tenant_id = $2::uuid
     ORDER BY created_at DESC
     LIMIT 1`,
    normalizeId(jobId, 'job id'),
    tid,
  );
  if (!rows[0]) throw AppError.notFound('Migration rehearsal report not found');
  return rows[0];
}

export const __testing__ = {
  AUTHORITATIVE_TABLES_BLOCKED,
  buildCsvProfile,
  canonicalizeRow,
  detectInFileDuplicates,
  parseCsvText,
  redactRow,
  validateCanonicalRow,
};
