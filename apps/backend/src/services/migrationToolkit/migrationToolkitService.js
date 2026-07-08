import crypto from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { parseHL7 } from '../hl7/hl7Parser.js';
import { postLedgerEntry } from '../billing/ledger/ledgerService.js';
import { AppError } from '../../utils/AppError.js';
import { toPaise } from '../../utils/money.js';
import { requireTenantId } from '../tenant/tenantService.js';

const IMPORT_KINDS = ['patient', 'encounter', 'opening_ar', 'mixed', 'hl7_adt'];
const FILE_KINDS = ['patient', 'encounter', 'opening_ar'];
const HL7_ADT_MESSAGE_TYPES = ['ADT^A01', 'ADT^A02', 'ADT^A03'];
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

function moneyNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value?.toNumber === 'function') return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUniqueViolation(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return String(code) === '23505' || /duplicate key value/i.test(String(err?.message || ''));
}

function hl7Component(value, index = 0) {
  return text(String(value || '').split('^')[index], 240);
}

function normalizeHl7Date(value) {
  const clean = text(value, 40);
  if (!clean) return null;
  const match = clean.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/);
  if (!match) return normalizeDate(clean);
  const [, year, month, day, hour, minute, second] = match;
  if (!hour) return `${year}-${month}-${day}`;
  return `${year}-${month}-${day}T${hour}:${minute || '00'}:${second || '00'}Z`;
}

function normalizeHl7Gender(value) {
  const clean = text(value, 20)?.toUpperCase();
  if (clean === 'M') return 'male';
  if (clean === 'F') return 'female';
  if (clean === 'O') return 'other';
  return clean ? clean.toLowerCase() : null;
}

function normalizeEncounterType(value) {
  const clean = text(value, 40)?.toLowerCase();
  if (!clean) return 'op';
  if (['i', 'ip', 'inpatient', 'admission', 'adt'].includes(clean)) return 'ip';
  if (['e', 'er', 'ed', 'emergency'].includes(clean)) return 'er';
  if (['o', 'op', 'outpatient', 'ambulatory'].includes(clean)) return 'op';
  return clean.slice(0, 40);
}

function isAdmissionEncounter(canonical) {
  return ['ip', 'inpatient', 'admission'].includes(normalizeEncounterType(canonical?.encounter_type));
}

function commitSourceKey(kind, canonical, fallback) {
  return sourceKeyFor(kind, canonical) || fallback;
}

function rowCommitKey({ jobId, targetKind, sourceKey, rowNumber }) {
  const raw = `${jobId}:${targetKind}:${sourceKey || rowNumber || 'row'}`;
  return sha256(raw).slice(0, 32);
}

function summarizeCommitRecords(records) {
  const summary = {
    total: records.length,
    by_target_kind: {},
    by_status: {},
    by_action: {},
  };
  records.forEach((record) => {
    summary.by_target_kind[record.target_kind] = (summary.by_target_kind[record.target_kind] || 0) + 1;
    summary.by_status[record.status] = (summary.by_status[record.status] || 0) + 1;
    summary.by_action[record.action] = (summary.by_action[record.action] || 0) + 1;
  });
  return summary;
}

function redactCanonicalForCommit(kind, canonical) {
  if (kind === 'patient') {
    return {
      external_patient_id: redactValue('external_patient_id', canonical.external_patient_id),
      mrn: redactValue('mrn', canonical.mrn),
      phone: redactValue('phone', canonical.phone),
      dob: redactValue('dob', canonical.dob),
      has_name: !!canonical.full_name,
    };
  }
  if (kind === 'opening_ar') {
    return {
      external_invoice_id: canonical.external_invoice_id,
      invoice_number: canonical.invoice_number,
      amount_due_number: canonical.amount_due_number,
      currency: canonical.currency,
      patient_reference: redactValue('external_patient_id', canonical.external_patient_id || canonical.mrn),
    };
  }
  return {
    external_encounter_id: canonical.external_encounter_id,
    encounter_type: canonical.encounter_type,
    encounter_date: canonical.encounter_date,
    patient_reference: redactValue('external_patient_id', canonical.external_patient_id || canonical.mrn),
  };
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
  const committableRecords = [];
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

    committableRecords.push({
      import_record: row,
      source_file: sourceFile,
      row_number: record.rowNumber,
      target_kind: fileInput.fileKind,
      source_key: sourceKeyFor(fileInput.fileKind, record.canonical),
      row_hash: sha256(JSON.stringify(record.row)),
      canonical: record.canonical,
      validation_state: validationState,
      findings: rowFindings,
    });
  }

  return {
    source_file: sourceFile,
    row_count: records.length,
    valid_rows: validRows,
    warning_rows: warningRows,
    error_rows: errorRows,
    duplicate_summary: { ...duplicateSummary, ...existingSummary },
    findings: insertedFindings,
    records: committableRecords,
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

async function lookupPatientByIdentifierTx(tx, { tenantId, identifierType, identifierValue }) {
  const type = text(identifierType, 40);
  const value = text(identifierValue, 255);
  if (!type || !value) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT patient_uid, identifier_type, identifier_value
       FROM patient_identifiers
      WHERE tenant_id = $1::uuid
        AND identifier_type = $2
        AND identifier_value = $3
        AND status = 'active'
      LIMIT 1`,
    tenantId,
    type,
    value,
  );
  return rows[0] || null;
}

async function lookupPatientByPhoneTx(tx, { tenantId, phone }) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, id
       FROM users
      WHERE tenant_id = $1::uuid
        AND role = 'PATIENT'
        AND is_active = true
        AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2
      LIMIT 1`,
    tenantId,
    normalized,
  );
  return rows[0] || null;
}

async function insertCommitRecordTx(tx, {
  tenantId,
  batchId,
  jobId,
  importRecordId = null,
  targetKind,
  sourceKey = null,
  rowHash = null,
  status,
  action,
  targetTable = null,
  targetId = null,
  targetUid = null,
  idempotencyKey,
  rollbackPayload = {},
  replayProof = {},
  errorRedacted = null,
  metadata = {},
}) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO migration_commit_records
       (tenant_id, commit_batch_id, job_id, import_record_id, target_kind,
        source_key, row_hash, status, action, target_table, target_id, target_uid,
        idempotency_key, rollback_payload, replay_proof, error_redacted, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid,
             $13, $14::jsonb, $15::jsonb, $16, $17::jsonb)
     ON CONFLICT (tenant_id, commit_batch_id, idempotency_key)
     DO UPDATE SET
       status = EXCLUDED.status,
       action = EXCLUDED.action,
       target_table = EXCLUDED.target_table,
       target_id = EXCLUDED.target_id,
       target_uid = EXCLUDED.target_uid,
       rollback_payload = EXCLUDED.rollback_payload,
       replay_proof = EXCLUDED.replay_proof,
       error_redacted = EXCLUDED.error_redacted,
       metadata = EXCLUDED.metadata
     RETURNING id, uid, tenant_id, commit_batch_id, job_id, import_record_id,
               target_kind, source_key, row_hash, status, action, target_table,
               target_id, target_uid, idempotency_key, rollback_payload,
               replay_proof, error_redacted, metadata, created_at`,
    tenantId,
    normalizeId(batchId, 'commit batch id'),
    normalizeId(jobId, 'job id'),
    importRecordId ? normalizeId(importRecordId, 'import record id') : null,
    targetKind,
    text(sourceKey, 180),
    rowHash,
    status,
    action,
    targetTable,
    targetId === null || targetId === undefined ? null : String(targetId),
    maybeUuid(targetUid, 'target_uid'),
    idempotencyKey,
    JSON.stringify(rollbackPayload || {}),
    JSON.stringify(replayProof || {}),
    text(errorRedacted, 800),
    JSON.stringify(metadata || {}),
  );
  return rows[0];
}

async function insertMergeQueueItemTx(tx, {
  tenantId,
  jobId,
  batchId,
  importRecordId = null,
  conflictKind,
  sourcePatientKey = null,
  candidatePatientUid = null,
  importedPatientUid = null,
  reviewPayloadRedacted = {},
  createdBy = null,
}) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO migration_merge_queue_items
       (tenant_id, job_id, commit_batch_id, import_record_id, conflict_kind,
        source_patient_key, candidate_patient_uid, imported_patient_uid,
        status, review_payload_redacted, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::uuid,
             'review_required', $9::jsonb, $10::uuid)
     ON CONFLICT (tenant_id, commit_batch_id, import_record_id, conflict_kind)
     DO UPDATE SET
       candidate_patient_uid = EXCLUDED.candidate_patient_uid,
       imported_patient_uid = EXCLUDED.imported_patient_uid,
       review_payload_redacted = EXCLUDED.review_payload_redacted
     RETURNING id, uid, tenant_id, job_id, commit_batch_id, import_record_id,
               conflict_kind, source_patient_key, candidate_patient_uid,
               imported_patient_uid, status, review_payload_redacted, created_at`,
    tenantId,
    normalizeId(jobId, 'job id'),
    normalizeId(batchId, 'commit batch id'),
    importRecordId ? normalizeId(importRecordId, 'import record id') : null,
    conflictKind,
    text(sourcePatientKey, 180),
    maybeUuid(candidatePatientUid, 'candidate_patient_uid'),
    maybeUuid(importedPatientUid, 'imported_patient_uid'),
    JSON.stringify(reviewPayloadRedacted || {}),
    maybeUuid(createdBy, 'created_by'),
  );
  return rows[0];
}

async function ensureIdentifierTx(tx, {
  tenantId,
  patientUid,
  identifierType,
  identifierValue,
  issuer = 'legacy_his',
  createdBy = null,
  metadata = {},
}) {
  const type = text(identifierType, 40);
  const value = text(identifierValue, 255);
  if (!type || !value || !patientUid) return { action: 'skipped' };

  const existing = await lookupPatientByIdentifierTx(tx, {
    tenantId,
    identifierType: type,
    identifierValue: value,
  });
  if (existing?.patient_uid) {
    if (String(existing.patient_uid) !== String(patientUid)) {
      return { action: 'conflict', patient_uid: existing.patient_uid };
    }
    return { action: 'reused', patient_uid: patientUid };
  }

  try {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO patient_identifiers
         (tenant_id, patient_uid, identifier_type, identifier_value,
          issuer, assigned_at, is_primary, status, metadata, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, NOW(), $6, 'active', $7::jsonb, $8::uuid)
       RETURNING id, patient_uid`,
      tenantId,
      patientUid,
      type,
      value,
      issuer,
      type === 'mrn' || type === 'uhid',
      JSON.stringify(metadata || {}),
      maybeUuid(createdBy, 'created_by'),
    );
    return { action: 'created', id: rows[0]?.id, patient_uid: patientUid };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const conflict = await lookupPatientByIdentifierTx(tx, {
      tenantId,
      identifierType: type,
      identifierValue: value,
    });
    return { action: 'conflict', patient_uid: conflict?.patient_uid || null };
  }
}

async function findPatientByCanonicalTx(tx, { tenantId, canonical }) {
  const external = await lookupPatientByIdentifierTx(tx, {
    tenantId,
    identifierType: 'external_emr',
    identifierValue: canonical.external_patient_id,
  });
  if (external) return { patient_uid: external.patient_uid, match: 'external_emr' };

  const mrn = await lookupPatientByIdentifierTx(tx, {
    tenantId,
    identifierType: 'mrn',
    identifierValue: canonical.mrn,
  });
  if (mrn) return { patient_uid: mrn.patient_uid, match: 'mrn' };

  const phone = await lookupPatientByPhoneTx(tx, { tenantId, phone: canonical.phone });
  if (phone?.uid) return { patient_uid: phone.uid, match: 'phone' };
  return null;
}

async function commitPatientRecordTx(tx, {
  tenantId,
  job,
  batchId,
  record,
  createdBy,
  patientUidBySource,
}) {
  const canonical = record.canonical;
  const sourceKey = commitSourceKey('patient', canonical, `row-${record.row_number}`);
  const match = await findPatientByCanonicalTx(tx, { tenantId, canonical });

  if (match?.match === 'phone' && (canonical.external_patient_id || canonical.mrn)) {
    await insertMergeQueueItemTx(tx, {
      tenantId,
      jobId: job.id,
      batchId,
      importRecordId: record.import_record?.id || null,
      conflictKind: 'phone_existing_patient',
      sourcePatientKey: sourceKey,
      candidatePatientUid: match.patient_uid,
      reviewPayloadRedacted: redactCanonicalForCommit('patient', canonical),
      createdBy,
    });
    patientUidBySource.set(sourceKey, match.patient_uid);
    return {
      status: 'conflict',
      action: 'queued_conflict',
      target_table: 'migration_merge_queue_items',
      target_uid: null,
      target_id: null,
      replay_proof: { source_key: sourceKey, candidate_patient_uid: match.patient_uid },
      error_redacted: 'Possible existing patient matched by phone; queued for merge review.',
    };
  }

  let patientUid = match?.patient_uid || null;
  const action = match ? 'reused' : 'created';
  if (!patientUid) {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO users
         (tenant_id, phone, name, email, birthday, gender, role, status,
          is_active, registered_at, updated_at, identity_source)
       VALUES ($1::uuid, $2, $3, $4, $5::date, $6, 'PATIENT', 'active',
               true, NOW(), NOW(), 'migration')
       RETURNING uid, id`,
      tenantId,
      text(canonical.phone, 15),
      text(canonical.full_name, 255),
      text(canonical.email, 255),
      normalizeDate(canonical.dob),
      text(canonical.gender, 20),
    );
    patientUid = rows[0]?.uid;
  }

  const identifierResults = [];
  identifierResults.push(await ensureIdentifierTx(tx, {
    tenantId,
    patientUid,
    identifierType: 'external_emr',
    identifierValue: canonical.external_patient_id,
    createdBy,
    metadata: { source: 'migration_toolkit', job_id: Number(job.id), source_key: sourceKey },
  }));
  identifierResults.push(await ensureIdentifierTx(tx, {
    tenantId,
    patientUid,
    identifierType: 'mrn',
    identifierValue: canonical.mrn,
    issuer: 'legacy_his',
    createdBy,
    metadata: { source: 'migration_toolkit', job_id: Number(job.id), source_key: sourceKey },
  }));
  identifierResults.push(await ensureIdentifierTx(tx, {
    tenantId,
    patientUid,
    identifierType: 'mobile',
    identifierValue: canonical.phone_normalized,
    issuer: 'legacy_his',
    createdBy,
    metadata: { source: 'migration_toolkit', job_id: Number(job.id), source_key: sourceKey },
  }));

  const conflict = identifierResults.find((result) => result.action === 'conflict');
  if (conflict) {
    await insertMergeQueueItemTx(tx, {
      tenantId,
      jobId: job.id,
      batchId,
      importRecordId: record.import_record?.id || null,
      conflictKind: 'identifier_existing_patient',
      sourcePatientKey: sourceKey,
      candidatePatientUid: conflict.patient_uid,
      importedPatientUid: patientUid,
      reviewPayloadRedacted: redactCanonicalForCommit('patient', canonical),
      createdBy,
    });
  }

  [sourceKey, canonical.external_patient_id, canonical.mrn, canonical.phone_normalized]
    .filter(Boolean)
    .forEach((key) => patientUidBySource.set(String(key), patientUid));

  return {
    status: conflict ? 'conflict' : 'committed',
    action: conflict ? 'queued_conflict' : action,
    target_table: 'users',
    target_uid: patientUid,
    target_id: null,
    rollback_payload: {
      users: action === 'created' ? [{ uid: patientUid }] : [],
      patient_identifiers: identifierResults
        .filter((result) => result.action === 'created')
        .map((result) => ({ id: Number(result.id) })),
    },
    replay_proof: {
      source_key: sourceKey,
      matched_by: match?.match || null,
      identifier_actions: identifierResults.map((result) => result.action),
    },
  };
}

async function resolvePatientUidForCommitTx(tx, { tenantId, canonical, patientUidBySource }) {
  const keys = [
    canonical.external_patient_id,
    canonical.mrn,
    canonical.phone_normalized,
    sourceKeyFor('patient', canonical),
  ].filter(Boolean);
  for (const key of keys) {
    if (patientUidBySource.has(String(key))) return patientUidBySource.get(String(key));
  }
  const match = await findPatientByCanonicalTx(tx, { tenantId, canonical });
  return match?.patient_uid || null;
}

async function upsertAdmissionTx(tx, {
  tenantId,
  patientUid,
  canonical,
  migrationSourceKey,
  createdBy,
}) {
  const existing = await tx.$queryRawUnsafe(
    `SELECT id, encounter_id
       FROM admissions
      WHERE tenant_id = $1::uuid
        AND migration_source_key = $2
      LIMIT 1`,
    tenantId,
    migrationSourceKey,
  );
  if (existing[0]) return { ...existing[0], action: 'reused' };

  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO admissions
       (tenant_id, patient_uid, status, department, admission_type, admitted_at,
        reason, created_by, migration_source_key, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', $3, $4, COALESCE($5::timestamptz, NOW()),
             'Imported from legacy migration toolkit', $6::uuid, $7, NOW(), NOW())
     RETURNING id, encounter_id`,
    tenantId,
    patientUid,
    text(canonical.department, 255),
    text(canonical.encounter_type, 50) || 'ip',
    canonical.encounter_date,
    maybeUuid(createdBy, 'created_by'),
    migrationSourceKey,
  );
  return { ...rows[0], action: 'created' };
}

async function upsertEncounterTx(tx, {
  tenantId,
  patientUid,
  canonical,
  migrationSourceKey,
  admissionId = null,
  createdBy,
}) {
  const existing = await tx.$queryRawUnsafe(
    `SELECT id
       FROM patient_encounters
      WHERE tenant_id = $1::uuid
        AND metadata->>'migration_source_key' = $2
      LIMIT 1`,
    tenantId,
    migrationSourceKey,
  );
  if (existing[0]) return { id: existing[0].id, action: 'reused' };

  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO patient_encounters
       (tenant_id, patient_uid, encounter_type, status, admission_id,
        opened_at, created_by, updated_by, metadata)
     VALUES ($1::uuid, $2::uuid, $3, 'open', $4,
             COALESCE($5::timestamptz, NOW()), $6::uuid, $6::uuid, $7::jsonb)
     RETURNING id`,
    tenantId,
    patientUid,
    normalizeEncounterType(canonical.encounter_type),
    admissionId ? normalizeId(admissionId, 'admission id') : null,
    canonical.encounter_date,
    maybeUuid(createdBy, 'created_by'),
    JSON.stringify({
      source: 'migration_toolkit',
      migration_source_key: migrationSourceKey,
      external_encounter_id: canonical.external_encounter_id || null,
      department: canonical.department || null,
      doctor: canonical.doctor || null,
    }),
  );
  return { id: rows[0]?.id, action: 'created' };
}

async function commitEncounterRecordTx(tx, {
  tenantId,
  job,
  batchId,
  record,
  createdBy,
  patientUidBySource,
}) {
  const canonical = record.canonical;
  const patientCanonical = {
    external_patient_id: canonical.external_patient_id,
    mrn: canonical.mrn,
    phone_normalized: normalizePhone(canonical.phone),
  };
  const patientUid = await resolvePatientUidForCommitTx(tx, {
    tenantId,
    canonical: patientCanonical,
    patientUidBySource,
  });
  const sourceKey = commitSourceKey('encounter', canonical, `row-${record.row_number}`);
  if (!patientUid) {
    await insertMergeQueueItemTx(tx, {
      tenantId,
      jobId: job.id,
      batchId,
      importRecordId: record.import_record?.id || null,
      conflictKind: 'encounter_patient_unresolved',
      sourcePatientKey: canonical.external_patient_id || canonical.mrn || null,
      reviewPayloadRedacted: redactCanonicalForCommit('encounter', canonical),
      createdBy,
    });
    return {
      status: 'conflict',
      action: 'queued_conflict',
      target_table: 'migration_merge_queue_items',
      error_redacted: 'Encounter patient reference could not be resolved.',
      replay_proof: { source_key: sourceKey },
    };
  }

  const migrationSourceKey = `${job.id}:${sourceKey}`;
  let admission = null;
  if (isAdmissionEncounter(canonical)) {
    admission = await upsertAdmissionTx(tx, {
      tenantId,
      patientUid,
      canonical,
      migrationSourceKey,
      createdBy,
    });
  }
  const encounter = await upsertEncounterTx(tx, {
    tenantId,
    patientUid,
    canonical,
    migrationSourceKey,
    admissionId: admission?.id || null,
    createdBy,
  });

  return {
    status: 'committed',
    action: admission?.action === 'created' || encounter.action === 'created' ? 'created' : 'reused',
    target_table: admission ? 'admissions' : 'patient_encounters',
    target_id: admission?.id || encounter.id,
    target_uid: admission ? encounter.id : null,
    rollback_payload: {
      admissions: admission?.action === 'created' ? [{ id: Number(admission.id) }] : [],
      patient_encounters: encounter.action === 'created' ? [{ id: encounter.id }] : [],
    },
    replay_proof: {
      source_key: sourceKey,
      migration_source_key: migrationSourceKey,
      patient_uid: patientUid,
      admission_action: admission?.action || null,
      encounter_action: encounter.action,
    },
  };
}

async function upsertOpeningInvoiceTx(tx, {
  tenantId,
  patientUid,
  canonical,
  migrationSourceKey,
  createdBy,
}) {
  const invoiceNumber = text(canonical.invoice_number || canonical.external_invoice_id, 50)
    || `MIG-${migrationSourceKey.slice(0, 42)}`;
  const existing = await tx.$queryRawUnsafe(
    `SELECT id, amount_due, total_amount
       FROM billing_invoices
      WHERE tenant_id = $1::uuid
        AND invoice_number = $2
      LIMIT 1`,
    tenantId,
    invoiceNumber,
  );
  if (existing[0]) return { ...existing[0], invoice_number: invoiceNumber, action: 'reused' };

  const amount = canonical.amount_due_number;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (tenant_id, invoice_number, patient_uid, invoice_type, subtotal,
        total_amount, amount_due, amount_paid, status, issued_at, created_by,
        notes, migration_source_key)
     VALUES ($1::uuid, $2, $3::uuid, 'OPENING_AR', $4::numeric, $4::numeric,
             $4::numeric, 0, 'ISSUED', COALESCE($5::timestamptz, NOW()),
             $6::uuid, 'Imported opening AR balance', $7)
     RETURNING id, amount_due, total_amount`,
    tenantId,
    invoiceNumber,
    patientUid,
    amount,
    canonical.invoice_date,
    maybeUuid(createdBy, 'created_by'),
    migrationSourceKey,
  );
  return { ...rows[0], invoice_number: invoiceNumber, action: 'created' };
}

async function commitOpeningArRecordTx(tx, {
  tenantId,
  job,
  batchId,
  record,
  createdBy,
  patientUidBySource,
}) {
  const canonical = record.canonical;
  const patientCanonical = {
    external_patient_id: canonical.external_patient_id,
    mrn: canonical.mrn,
    phone_normalized: normalizePhone(canonical.phone),
  };
  const patientUid = await resolvePatientUidForCommitTx(tx, {
    tenantId,
    canonical: patientCanonical,
    patientUidBySource,
  });
  const sourceKey = commitSourceKey('opening_ar', canonical, `row-${record.row_number}`);
  if (!patientUid) {
    await insertMergeQueueItemTx(tx, {
      tenantId,
      jobId: job.id,
      batchId,
      importRecordId: record.import_record?.id || null,
      conflictKind: 'opening_ar_patient_unresolved',
      sourcePatientKey: canonical.external_patient_id || canonical.mrn || null,
      reviewPayloadRedacted: redactCanonicalForCommit('opening_ar', canonical),
      createdBy,
    });
    return {
      status: 'conflict',
      action: 'queued_conflict',
      target_table: 'migration_merge_queue_items',
      opening_balance_paise: 0,
      error_redacted: 'Opening AR patient reference could not be resolved.',
      replay_proof: { source_key: sourceKey },
    };
  }

  const migrationSourceKey = `${job.id}:${sourceKey}`;
  const invoice = await upsertOpeningInvoiceTx(tx, {
    tenantId,
    patientUid,
    canonical,
    migrationSourceKey,
    createdBy,
  });
  const amount = moneyNumber(invoice.amount_due) ?? canonical.amount_due_number;
  const paise = toPaise(String(amount));
  const ledgerKey = `migration-opening-ar-${job.id}-${sourceKey}`;
  const existingLedger = await tx.$queryRawUnsafe(
    `SELECT id FROM ledger_entries WHERE tenant_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
    tenantId,
    ledgerKey,
  );
  if (!existingLedger[0] && paise > 0) {
    try {
      await postLedgerEntry(tx, {
        entryType: 'OPENING_BALANCE',
        idempotencyKey: ledgerKey,
        createdBy: maybeUuid(createdBy, 'created_by'),
        metadata: {
          source: 'migration_toolkit',
          job_id: Number(job.id),
          commit_batch_id: Number(batchId),
          source_key: sourceKey,
          invoice_id: Number(invoice.id),
        },
        lines: [
          {
            accountCode: 'PATIENT_AR',
            amountPaise: paise,
            patient_uid: patientUid,
            invoice_id: Number(invoice.id),
          },
          { accountCode: 'OPENING_EQUITY', amountPaise: -paise },
        ],
      });
    } catch (err) {
      if (err?.code !== 'LEDGER_DUPLICATE') throw err;
    }
  }

  return {
    status: 'committed',
    action: invoice.action,
    target_table: 'billing_invoices',
    target_id: invoice.id,
    opening_balance_paise: paise,
    rollback_payload: {
      billing_invoices: invoice.action === 'created' ? [{ id: Number(invoice.id) }] : [],
      ledger_entries: [{ idempotency_key: ledgerKey }],
    },
    replay_proof: {
      source_key: sourceKey,
      migration_source_key: migrationSourceKey,
      patient_uid: patientUid,
      invoice_id: Number(invoice.id),
      ledger_idempotency_key: ledgerKey,
      ledger_existing: !!existingLedger[0],
    },
  };
}

async function getOrCreateCommitBatchTx(tx, {
  tenantId,
  job,
  idempotencyKey,
  committedBy,
  source = 'csv',
  metadata = {},
}) {
  const cleanKey = text(idempotencyKey, 160) || `job-${job.id}-${source}`;
  const existing = await tx.$queryRawUnsafe(
    `SELECT id, uid, tenant_id, job_id, status, idempotency_key, acceptance_summary,
            opening_balance_totals, rollback_plan, replay_proof, committed_at
       FROM migration_commit_batches
      WHERE tenant_id = $1::uuid AND idempotency_key = $2
      LIMIT 1`,
    tenantId,
    cleanKey,
  );
  if (existing[0]) return { batch: existing[0], replay: true };

  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO migration_commit_batches
       (tenant_id, job_id, status, idempotency_key, requested_by, committed_by,
        committed_at, metadata)
     VALUES ($1::uuid, $2, 'committing', $3, $4::uuid, $4::uuid, NOW(), $5::jsonb)
     RETURNING id, uid, tenant_id, job_id, status, idempotency_key, acceptance_summary,
               opening_balance_totals, rollback_plan, replay_proof, committed_at`,
    tenantId,
    normalizeId(job.id, 'job id'),
    cleanKey,
    maybeUuid(committedBy, 'committed_by'),
    JSON.stringify({ source, ...metadata }),
  );
  return { batch: rows[0], replay: false };
}

async function writeAcceptanceReportTx(tx, {
  tenantId,
  job,
  batch,
  commitRecords,
  openingBalanceTotals,
  generatedBy,
  source = 'csv',
}) {
  const acceptanceSummary = summarizeCommitRecords(commitRecords);
  const rollbackPlan = {
    reversible: true,
    mode: 'operator_review_required',
    records: commitRecords.map((record) => ({
      commit_record_id: Number(record.id),
      target_kind: record.target_kind,
      target_table: record.target_table,
      target_id: record.target_id,
      target_uid: record.target_uid,
      rollback_payload: record.rollback_payload,
    })),
  };
  const replayProof = {
    idempotency_key: batch.idempotency_key,
    source,
    commit_record_keys: commitRecords.map((record) => record.idempotency_key),
    committed_records: commitRecords.filter((record) => record.status === 'committed').length,
    conflict_records: commitRecords.filter((record) => record.status === 'conflict').length,
  };
  const reportJson = {
    scope: 'NL11-S9 migration toolkit P2',
    job_id: Number(job.id),
    commit_batch_id: Number(batch.id),
    source,
    acceptance_summary: acceptanceSummary,
    opening_balance_totals: openingBalanceTotals,
    rollback_plan: rollbackPlan,
    replay_proof: replayProof,
    phi_redacted: true,
  };

  await tx.$queryRawUnsafe(
    `UPDATE migration_commit_batches
        SET status = 'committed',
            acceptance_summary = $1::jsonb,
            opening_balance_totals = $2::jsonb,
            rollback_plan = $3::jsonb,
            replay_proof = $4::jsonb,
            committed_at = COALESCE(committed_at, NOW())
      WHERE id = $5 AND tenant_id = $6::uuid`,
    JSON.stringify(acceptanceSummary),
    JSON.stringify(openingBalanceTotals),
    JSON.stringify(rollbackPlan),
    JSON.stringify(replayProof),
    normalizeId(batch.id, 'commit batch id'),
    tenantId,
  );

  await tx.$queryRawUnsafe(
    `UPDATE migration_import_jobs
        SET status = 'committed',
            dry_run_only = false,
            authoritative_write_enabled = true,
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2::uuid`,
    normalizeId(job.id, 'job id'),
    tenantId,
  );

  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO migration_acceptance_reports
       (tenant_id, job_id, commit_batch_id, status, phi_redacted, report_json,
        acceptance_summary, opening_balance_totals, rollback_proof, replay_proof,
        generated_by)
     VALUES ($1::uuid, $2, $3, 'accepted', true, $4::jsonb,
             $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::uuid)
     ON CONFLICT (commit_batch_id)
     DO UPDATE SET
       report_json = EXCLUDED.report_json,
       acceptance_summary = EXCLUDED.acceptance_summary,
       opening_balance_totals = EXCLUDED.opening_balance_totals,
       rollback_proof = EXCLUDED.rollback_proof,
       replay_proof = EXCLUDED.replay_proof
     RETURNING id, uid, tenant_id, job_id, commit_batch_id, status, phi_redacted,
               report_json, acceptance_summary, opening_balance_totals,
               rollback_proof, replay_proof, generated_by, created_at`,
    tenantId,
    normalizeId(job.id, 'job id'),
    normalizeId(batch.id, 'commit batch id'),
    JSON.stringify(reportJson),
    JSON.stringify(acceptanceSummary),
    JSON.stringify(openingBalanceTotals),
    JSON.stringify(rollbackPlan),
    JSON.stringify(replayProof),
    maybeUuid(generatedBy, 'generated_by'),
  );
  return rows[0];
}

async function getAcceptanceReportByBatchTx(tx, { tenantId, batchId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, uid, tenant_id, job_id, commit_batch_id, status, phi_redacted,
            report_json, acceptance_summary, opening_balance_totals,
            rollback_proof, replay_proof, generated_by, created_at, metadata
       FROM migration_acceptance_reports
      WHERE tenant_id = $1::uuid
        AND commit_batch_id = $2
      LIMIT 1`,
    tenantId,
    normalizeId(batchId, 'commit batch id'),
  );
  return rows[0] || null;
}

async function commitPreparedRecordsTx(tx, {
  tenantId,
  job,
  records,
  idempotencyKey,
  committedBy,
  source = 'csv',
  metadata = {},
}) {
  const { batch, replay } = await getOrCreateCommitBatchTx(tx, {
    tenantId,
    job,
    idempotencyKey,
    committedBy,
    source,
    metadata,
  });
  if (replay && batch.status === 'committed') {
    const report = await getAcceptanceReportByBatchTx(tx, { tenantId, batchId: batch.id });
    return { batch, report, replayed: true, records: [] };
  }

  const patientUidBySource = new Map();
  const commitRecords = [];
  const ordered = [...records].sort((a, b) => {
    const rank = { patient: 0, encounter: 1, opening_ar: 2 };
    return (rank[a.target_kind] ?? 9) - (rank[b.target_kind] ?? 9);
  });
  let openingBalancePaise = 0;

  for (const record of ordered) {
    const sourceKey = commitSourceKey(record.target_kind, record.canonical, `row-${record.row_number}`);
    const idempotencyKeyForRow = `${batch.idempotency_key}:${record.target_kind}:${rowCommitKey({
      jobId: job.id,
      targetKind: record.target_kind,
      sourceKey,
      rowNumber: record.row_number,
    })}`;
    let result;
    if (record.validation_state === 'error') {
      result = {
        status: 'failed',
        action: 'blocked',
        target_table: null,
        error_redacted: 'Validation errors block commit for this source row.',
        replay_proof: { source_key: sourceKey, validation_state: record.validation_state },
      };
    } else if (record.target_kind === 'patient') {
      result = await commitPatientRecordTx(tx, {
        tenantId,
        job,
        batchId: batch.id,
        record,
        createdBy: committedBy,
        patientUidBySource,
      });
    } else if (record.target_kind === 'encounter') {
      result = await commitEncounterRecordTx(tx, {
        tenantId,
        job,
        batchId: batch.id,
        record,
        createdBy: committedBy,
        patientUidBySource,
      });
    } else if (record.target_kind === 'opening_ar') {
      result = await commitOpeningArRecordTx(tx, {
        tenantId,
        job,
        batchId: batch.id,
        record,
        createdBy: committedBy,
        patientUidBySource,
      });
      openingBalancePaise += result.opening_balance_paise || 0;
    } else {
      result = {
        status: 'failed',
        action: 'unsupported',
        error_redacted: `Unsupported target kind: ${record.target_kind}`,
      };
    }

    const commitRecord = await insertCommitRecordTx(tx, {
      tenantId,
      batchId: batch.id,
      jobId: job.id,
      importRecordId: record.import_record?.id || null,
      targetKind: record.target_kind,
      sourceKey,
      rowHash: record.row_hash,
      status: result.status,
      action: result.action,
      targetTable: result.target_table,
      targetId: result.target_id,
      targetUid: result.target_uid,
      idempotencyKey: idempotencyKeyForRow,
      rollbackPayload: result.rollback_payload || {},
      replayProof: result.replay_proof || {},
      errorRedacted: result.error_redacted || null,
      metadata: {
        source,
        preview_redacted: redactCanonicalForCommit(record.target_kind, record.canonical),
      },
    });
    commitRecords.push(commitRecord);
  }

  const openingBalanceTotals = {
    amount_paise: openingBalancePaise,
    amount: (openingBalancePaise / 100).toFixed(2),
    committed_rows: commitRecords.filter((record) => record.target_kind === 'opening_ar' && record.status === 'committed').length,
  };
  const report = await writeAcceptanceReportTx(tx, {
    tenantId,
    job,
    batch,
    commitRecords,
    openingBalanceTotals,
    generatedBy: committedBy,
    source,
  });
  return { batch: { ...batch, status: 'committed' }, report, replayed: false, records: commitRecords };
}

export async function commitImportJob({
  tenantId = null,
  jobId,
  files,
  idempotencyKey = null,
  committedBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const job = await getJobOrThrow(tid, jobId);
  const normalizedFiles = normalizeFiles(files);
  const fileResults = [];
  for (const fileInput of normalizedFiles) {
    fileResults.push(await processFileForRehearsal({
      tenantId: tid,
      jobId: job.id,
      fileInput,
      generatedBy: committedBy,
    }));
  }
  const records = fileResults.flatMap((result) => result.records);
  const errorCount = records.filter((record) => record.validation_state === 'error').length;
  if (errorCount > 0) {
    throw AppError.badRequest(
      'Migration commit blocked by validation errors',
      'MIGRATION_COMMIT_VALIDATION_FAILED',
      { error_rows: errorCount },
    );
  }

  return setTenantTx(tid, (tx) => commitPreparedRecordsTx(tx, {
    tenantId: tid,
    job,
    records,
    idempotencyKey,
    committedBy,
    source: 'csv',
  }));
}

function hl7AdtToRecords({ message, rowNumber }) {
  const parsed = parseHL7(message);
  if (!parsed.msh) throw AppError.badRequest('HL7 ADT message is missing MSH');
  if (!parsed.pid) throw AppError.badRequest('HL7 ADT message is missing PID');
  const messageType = parsed.msh.messageType || '';
  if (!HL7_ADT_MESSAGE_TYPES.includes(messageType)) {
    throw AppError.badRequest(`Unsupported HL7 ADT message type: ${messageType}`);
  }

  const pv1Segment = parsed.segments.find((segment) => segment.type === 'PV1');
  const pv1Fields = pv1Segment?.fields || [];
  const location = String(parsed.pv1?.assignedLocation || '').split('^');
  const patientId = hl7Component(parsed.pid.patientId);
  const patientName = String(parsed.pid.name || '').split('^').filter(Boolean).join(' ');
  const encounterId = hl7Component(pv1Fields[19]) || parsed.msh.messageControlId || `hl7-row-${rowNumber}`;
  const encounterType = normalizeEncounterType(parsed.pv1?.patientClass || 'I');
  const encounterDate = normalizeHl7Date(parsed.pv1?.admitDate || parsed.msh.dateTime);

  const patientCanonical = {
    external_patient_id: patientId,
    mrn: patientId,
    full_name: text(patientName, 240),
    first_name: null,
    last_name: null,
    phone: text(parsed.pid.phone, 80),
    phone_normalized: normalizePhone(parsed.pid.phone),
    email: null,
    dob: normalizeHl7Date(parsed.pid.birthDate),
    gender: normalizeHl7Gender(parsed.pid.gender),
  };
  const encounterCanonical = {
    external_encounter_id: encounterId,
    external_patient_id: patientId,
    mrn: patientId,
    encounter_date: encounterDate,
    encounter_type: encounterType,
    department: text(location[0], 100),
    doctor: text(parsed.pv1?.attendingDoctor, 160),
    hl7_message_type: messageType,
  };
  return {
    message_control_id: parsed.msh.messageControlId || null,
    message_type: messageType,
    parsed_summary_redacted: {
      message_type: messageType,
      message_control_id: parsed.msh.messageControlId || null,
      sending_facility: parsed.msh.sendingFacility || null,
      patient: redactCanonicalForCommit('patient', patientCanonical),
      encounter: redactCanonicalForCommit('encounter', encounterCanonical),
    },
    records: [
      {
        import_record: null,
        source_file: null,
        row_number: rowNumber,
        target_kind: 'patient',
        source_key: patientId,
        row_hash: sha256(message),
        canonical: patientCanonical,
        validation_state: validationStateFor(validateCanonicalRow('patient', patientCanonical, rowNumber)),
        findings: validateCanonicalRow('patient', patientCanonical, rowNumber),
      },
      {
        import_record: null,
        source_file: null,
        row_number: rowNumber,
        target_kind: 'encounter',
        source_key: encounterId,
        row_hash: sha256(`${message}:encounter`),
        canonical: encounterCanonical,
        validation_state: validationStateFor(validateCanonicalRow('encounter', encounterCanonical, rowNumber)),
        findings: validateCanonicalRow('encounter', encounterCanonical, rowNumber),
      },
    ],
  };
}

export async function importHl7AdtBatch({
  tenantId = null,
  jobId,
  messages,
  sourceFilename = 'adt.hl7',
  idempotencyKey = null,
  committedBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  if (!Array.isArray(messages) || messages.length === 0) {
    throw AppError.badRequest('messages must include at least one HL7 ADT payload');
  }
  const job = await getJobOrThrow(tid, jobId);
  const parsedMessages = messages.map((message, index) => hl7AdtToRecords({
    message: String(message || ''),
    rowNumber: index + 1,
  }));
  const records = parsedMessages.flatMap((parsed) => parsed.records);
  const errorCount = records.filter((record) => record.validation_state === 'error').length;
  if (errorCount > 0) {
    throw AppError.badRequest(
      'HL7 ADT import blocked by validation errors',
      'MIGRATION_HL7_ADT_VALIDATION_FAILED',
      { error_rows: errorCount },
    );
  }
  const batchKey = text(idempotencyKey, 160) || `hl7-adt-${job.id}-${sha256(messages.join('\n')).slice(0, 20)}`;

  return setTenantTx(tid, async (tx) => {
    const existing = await tx.$queryRawUnsafe(
      `SELECT id, uid, tenant_id, job_id, status, idempotency_key, summary, accepted_count, rejected_count
         FROM migration_hl7_adt_batches
        WHERE tenant_id = $1::uuid AND idempotency_key = $2
        LIMIT 1`,
      tid,
      batchKey,
    );
    let hl7Batch = existing[0] || null;
    if (!hl7Batch) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO migration_hl7_adt_batches
           (tenant_id, job_id, status, source_filename, content_sha256,
            message_count, idempotency_key, received_by, summary)
         VALUES ($1::uuid, $2, 'processing', $3, $4, $5, $6, $7::uuid, $8::jsonb)
         RETURNING id, uid, tenant_id, job_id, status, idempotency_key, summary,
                   accepted_count, rejected_count`,
        tid,
        normalizeId(job.id, 'job id'),
        text(sourceFilename, 260) || 'adt.hl7',
        sha256(messages.join('\n')),
        parsedMessages.length,
        batchKey,
        maybeUuid(committedBy, 'received_by'),
        JSON.stringify({ source_filename: text(sourceFilename, 260), message_count: parsedMessages.length }),
      );
      hl7Batch = rows[0];
      for (const parsed of parsedMessages) {
        await tx.$queryRawUnsafe(
          `INSERT INTO migration_hl7_adt_messages
             (tenant_id, hl7_batch_id, message_control_id, message_type,
              source_patient_key, raw_message_hash, parsed_summary_redacted,
              validation_findings, status)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'parsed')
           ON CONFLICT (tenant_id, hl7_batch_id, message_control_id)
           DO UPDATE SET parsed_summary_redacted = EXCLUDED.parsed_summary_redacted,
                         validation_findings = EXCLUDED.validation_findings,
                         status = 'parsed'`,
          tid,
          normalizeId(hl7Batch.id, 'HL7 batch id'),
          text(parsed.message_control_id, 120) || `row-${parsedMessages.indexOf(parsed) + 1}`,
          parsed.message_type,
          parsed.records[0]?.source_key || null,
          sha256(messages[parsedMessages.indexOf(parsed)]),
          JSON.stringify(parsed.parsed_summary_redacted),
          JSON.stringify(parsed.records.flatMap((record) => record.findings)),
        );
      }
    }

    const committed = await commitPreparedRecordsTx(tx, {
      tenantId: tid,
      job,
      records,
      idempotencyKey: `commit-${batchKey}`,
      committedBy,
      source: 'hl7_adt',
      metadata: { hl7_batch_id: Number(hl7Batch.id) },
    });
    await tx.$queryRawUnsafe(
      `UPDATE migration_hl7_adt_batches
          SET status = 'committed',
              accepted_count = $1,
              rejected_count = 0,
              summary = jsonb_set(COALESCE(summary, '{}'::jsonb), '{commit_batch_id}', to_jsonb($2::bigint), true),
              completed_at = NOW()
        WHERE id = $3 AND tenant_id = $4::uuid`,
      parsedMessages.length,
      normalizeId(committed.batch.id, 'commit batch id'),
      normalizeId(hl7Batch.id, 'HL7 batch id'),
      tid,
    );
    await tx.$queryRawUnsafe(
      `UPDATE migration_hl7_adt_messages
          SET status = 'committed',
              commit_batch_id = $1
        WHERE tenant_id = $2::uuid
          AND hl7_batch_id = $3`,
      normalizeId(committed.batch.id, 'commit batch id'),
      tid,
      normalizeId(hl7Batch.id, 'HL7 batch id'),
    );
    return { hl7_batch: { ...hl7Batch, status: 'committed' }, ...committed };
  });
}

export async function getAcceptanceReport({ tenantId = null, batchId } = {}) {
  const tid = requireTenantId(tenantId);
  const report = await setTenantTx(tid, (tx) => getAcceptanceReportByBatchTx(tx, { tenantId: tid, batchId }));
  if (!report) throw AppError.notFound('Migration acceptance report not found');
  return report;
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
  hl7AdtToRecords,
  parseCsvText,
  redactRow,
  validateCanonicalRow,
};
