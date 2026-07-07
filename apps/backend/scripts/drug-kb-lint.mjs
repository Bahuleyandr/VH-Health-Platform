#!/usr/bin/env node
// drug-kb-lint.mjs — structural lint for drug-KB edition packages.
//
// This script validates file shape, provenance, license status, and internal
// references only. It does not judge clinical correctness.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseCsvLine } from './terminology-import.mjs';

const LICENSE_STATUSES = new Set([
  'hospital_owned',
  'government_open_data_attribution',
  'permission_recorded',
  'operator_supplied_terms',
]);
const BLOCKED_LICENSE_STATUSES = new Set(['permission_required', 'prohibited']);

const DATASETS = {
  monographs: {
    required: ['drug_key', 'display_name'],
    key: (row) => lower(row.drug_key),
    refs: () => [],
  },
  interactions: {
    required: ['drug_a_key', 'drug_b_key', 'severity'],
    key: (row) => canonicalPair(row.drug_a_key, row.drug_b_key).join('|'),
    refs: (row) => canonicalPair(row.drug_a_key, row.drug_b_key).map((drugKey) => ({ dataset: 'monographs', key: drugKey })),
  },
  'allergy-groups': {
    required: ['group_key', 'member_key'],
    key: (row) => `${lower(row.group_key)}|${lower(row.member_key)}`,
    refs: (row) => [{ dataset: 'monographs', key: lower(row.member_key), optional: true }],
  },
  'cross-reactivity': {
    required: ['group_key', 'reacts_with_group_key', 'risk'],
    key: (row) => `${lower(row.group_key)}|${lower(row.reacts_with_group_key)}`,
    refs: (row) => [
      { dataset: 'allergy-group-keys', key: lower(row.group_key) },
      { dataset: 'allergy-group-keys', key: lower(row.reacts_with_group_key) },
    ],
  },
  'condition-cautions': {
    required: ['drug_key', 'icd10_prefix', 'condition_label', 'risk'],
    key: (row) => `${lower(row.drug_key)}|${upper(row.icd10_prefix)}`,
    refs: (row) => [{ dataset: 'monographs', key: lower(row.drug_key) }],
  },
  'dose-ranges': {
    required: ['drug_key', 'population'],
    key: (row) => `${lower(row.drug_key)}|${lower(row.route || 'any')}|${lower(row.population)}`,
    refs: (row) => [{ dataset: 'monographs', key: lower(row.drug_key) }],
  },
  'iv-compatibility': {
    required: ['drug_a_key', 'drug_b_key', 'compatibility'],
    key: (row) => canonicalPair(row.drug_a_key, row.drug_b_key).join('|'),
    refs: (row) => canonicalPair(row.drug_a_key, row.drug_b_key).map((drugKey) => ({ dataset: 'monographs', key: drugKey })),
  },
};

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function canonicalPair(a, b) {
  const x = lower(a);
  const y = lower(b);
  return x < y ? [x, y] : [y, x];
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') args.manifest = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function readJson(raw, context, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${context} must be valid JSON: ${err.message}`);
  }
}

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (lines.length === 0) return { header: [], rows: [] };
  const header = parseCsvLine(lines[0]).map((col) => lower(col));
  const rows = lines.slice(1).map((line, index) => {
    const cols = parseCsvLine(line);
    return {
      __line: index + 2,
      ...Object.fromEntries(header.map((h, i) => [h, (cols[i] ?? '').trim()])),
    };
  });
  return { header, rows };
}

function sourceRefsFor(row, provenance) {
  if (row.source_refs) return readJson(row.source_refs, `line ${row.__line} source_refs`, []);
  return Array.isArray(provenance.source_refs) ? provenance.source_refs : [];
}

function provenanceValue(row, provenance, column, key = column) {
  return row[column] || provenance[key] || null;
}

function lintRowGovernance({ row, provenance, sourceRefs, manifest, datasetName, errors }) {
  const licenseStatus = row.license_status || manifest.row_license_status || manifest.license_status;
  if (BLOCKED_LICENSE_STATUSES.has(licenseStatus)) {
    errors.push(`${datasetName}:${row.__line} license_status '${licenseStatus}' is not releasable`);
  } else if (licenseStatus && !LICENSE_STATUSES.has(licenseStatus)) {
    errors.push(`${datasetName}:${row.__line} unknown license_status '${licenseStatus}'`);
  }

  if (manifest.source_family === 'vh_indigenous') {
    const reviewStatus = row.review_status || manifest.row_review_status;
    if (reviewStatus !== 'approved') {
      errors.push(`${datasetName}:${row.__line} indigenous rows must have review_status=approved`);
    }
    if (sourceRefs.length === 0) {
      errors.push(`${datasetName}:${row.__line} indigenous rows require at least one source reference`);
    }
    for (const field of [
      ['author_user_id', 'author_user_id'],
      ['clinical_reviewer_user_id', 'clinical_reviewer_user_id'],
      ['pharmacy_reviewer_user_id', 'pharmacy_reviewer_user_id'],
      ['approved_by', 'approved_by'],
      ['content_basis', 'content_basis'],
      ['license_decision_id', 'license_decision_id'],
    ]) {
      if (!provenanceValue(row, provenance, field[0], field[1])) {
        errors.push(`${datasetName}:${row.__line} missing provenance field ${field[0]}`);
      }
    }
  }
}

function lintManifest(manifest, manifestPath) {
  const root = path.dirname(manifestPath);
  const errors = [];
  const warnings = [];
  const loaded = {};
  const keys = {
    monographs: new Set(),
    'allergy-group-keys': new Set(),
  };

  if (!manifest.source_key || !/^[a-z0-9_]+$/.test(manifest.source_key)) {
    errors.push('manifest source_key must be lowercase snake_case');
  }
  if (manifest.source_family === 'vh_indigenous' && !String(manifest.source_key || '').startsWith('vh_indigenous_')) {
    errors.push('vh_indigenous source_key must be an immutable edition key such as vh_indigenous_2026q3');
  }
  if (!manifest.version) errors.push('manifest version is required');
  if (BLOCKED_LICENSE_STATUSES.has(manifest.license_status)) {
    errors.push(`manifest license_status '${manifest.license_status}' is not releasable`);
  }

  for (const [datasetName, relativeFile] of Object.entries(manifest.datasets || {})) {
    const dataset = DATASETS[datasetName];
    if (!dataset) {
      errors.push(`unknown dataset '${datasetName}'`);
      continue;
    }
    const file = path.resolve(root, relativeFile);
    if (!fs.existsSync(file)) {
      errors.push(`${datasetName} file not found: ${relativeFile}`);
      continue;
    }
    const parsed = readCsv(file);
    const missing = dataset.required.filter((column) => !parsed.header.includes(column));
    if (missing.length) {
      errors.push(`${datasetName} missing required columns: ${missing.join(', ')}`);
    }
    loaded[datasetName] = parsed.rows;
    for (const row of parsed.rows) {
      const key = dataset.key(row);
      if (!key) errors.push(`${datasetName}:${row.__line} has an empty structural key`);
      if (keys[datasetName]?.has(key)) errors.push(`${datasetName}:${row.__line} duplicate key ${key}`);
      if (!keys[datasetName]) keys[datasetName] = new Set();
      keys[datasetName].add(key);
      if (datasetName === 'allergy-groups') keys['allergy-group-keys'].add(lower(row.group_key));

      const provenance = readJson(row.provenance, `${datasetName}:${row.__line} provenance`, {});
      const sourceRefs = sourceRefsFor(row, provenance);
      lintRowGovernance({ row, provenance, sourceRefs, manifest, datasetName, errors });
    }
  }

  for (const [datasetName, rows] of Object.entries(loaded)) {
    const dataset = DATASETS[datasetName];
    for (const row of rows) {
      for (const ref of dataset.refs(row)) {
        if (ref.optional && !keys[ref.dataset]?.has(ref.key)) {
          warnings.push(`${datasetName}:${row.__line} optional reference ${ref.dataset}:${ref.key} not present in package`);
          continue;
        }
        if (!ref.optional && !keys[ref.dataset]?.has(ref.key)) {
          errors.push(`${datasetName}:${row.__line} missing reference ${ref.dataset}:${ref.key}`);
        }
      }
    }
  }

  return {
    report: 'drug-kb-lint-v1',
    source_key: manifest.source_key || null,
    source_family: manifest.source_family || null,
    status: errors.length ? 'failed' : 'passed',
    datasets: Object.fromEntries(Object.entries(loaded).map(([name, rows]) => [name, rows.length])),
    errors,
    warnings,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.manifest) {
    console.error('--manifest is required');
    process.exit(2);
  }
  const manifestPath = path.resolve(args.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const report = lintManifest(manifest, manifestPath);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) process.exit(1);
}

main();
