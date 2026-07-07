#!/usr/bin/env node
// drug-kb-edition-diff.mjs — reviewer-facing structural diff for KB editions.
//
// Compares two persisted drug_kb_sources editions by dataset keys and selected
// structural columns. It reports changes only; it does not judge clinical merit.

import process from 'node:process';
import pg from 'pg';

const DATASETS = {
  monographs: {
    table: 'drug_kb_monographs',
    columns: ['drug_key', 'display_name', 'atc_code', 'drug_class', 'aliases', 'license_status', 'review_status'],
    key: (row) => row.drug_key,
  },
  interactions: {
    table: 'drug_kb_interactions',
    columns: ['drug_a_key', 'drug_b_key', 'severity', 'mechanism', 'effect', 'management', 'evidence', 'license_status', 'review_status'],
    key: (row) => `${row.drug_a_key}|${row.drug_b_key}`,
  },
  'allergy-groups': {
    table: 'drug_kb_allergy_groups',
    columns: ['group_key', 'member_key', 'license_status', 'review_status'],
    key: (row) => `${row.group_key}|${row.member_key}`,
  },
  'cross-reactivity': {
    table: 'drug_kb_allergy_cross_reactivity',
    columns: ['group_key', 'reacts_with_group_key', 'risk', 'note', 'license_status', 'review_status'],
    key: (row) => `${row.group_key}|${row.reacts_with_group_key}`,
  },
  'condition-cautions': {
    table: 'drug_kb_condition_cautions',
    columns: ['drug_key', 'icd10_prefix', 'condition_label', 'risk', 'note', 'license_status', 'review_status'],
    key: (row) => `${row.drug_key}|${row.icd10_prefix}`,
  },
  'dose-ranges': {
    table: 'drug_kb_dose_ranges',
    columns: [
      'drug_key',
      'route',
      'population',
      'max_single_dose_mg',
      'max_daily_dose_mg',
      'max_daily_mg_per_kg',
      'min_egfr',
      'egfr_max_daily_mg',
      'note',
      'license_status',
      'review_status',
    ],
    key: (row) => `${row.drug_key}|${row.route || 'any'}|${row.population}`,
  },
  'iv-compatibility': {
    table: 'drug_kb_iv_compatibility',
    columns: ['drug_a_key', 'drug_b_key', 'compatibility', 'diluent', 'note', 'license_status', 'review_status'],
    key: (row) => `${row.drug_a_key}|${row.drug_b_key}|${row.diluent || 'any'}`,
  },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') args.from = argv[++i];
    else if (arg === '--to') args.to = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function stableValue(value) {
  if (value && typeof value === 'object' && typeof value.toString === 'function' && value.constructor?.name === 'Decimal') {
    return value.toString();
  }
  if (Array.isArray(value)) return [...value].sort();
  return value ?? null;
}

function stableShape(row, columns) {
  return Object.fromEntries(columns.map((column) => [column, stableValue(row[column])]));
}

function changedFields(before, after, columns) {
  const changed = [];
  for (const column of columns) {
    if (JSON.stringify(stableValue(before[column])) !== JSON.stringify(stableValue(after[column]))) {
      changed.push(column);
    }
  }
  return changed;
}

async function rowsFor(client, dataset, sourceKey) {
  const sql = `SELECT ${dataset.columns.join(', ')}
                 FROM ${dataset.table}
                WHERE source_key = $1
                ORDER BY ${dataset.columns[0]}`;
  const { rows } = await client.query(sql, [sourceKey]);
  return new Map(rows.map((row) => [dataset.key(row), row]));
}

async function compareDataset(client, name, dataset, fromSource, toSource) {
  const before = await rowsFor(client, dataset, fromSource);
  const after = await rowsFor(client, dataset, toSource);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of [...keys].sort()) {
    const oldRow = before.get(key);
    const newRow = after.get(key);
    if (!oldRow && newRow) {
      added.push({ key, row: stableShape(newRow, dataset.columns) });
    } else if (oldRow && !newRow) {
      removed.push({ key, row: stableShape(oldRow, dataset.columns) });
    } else {
      const fields = changedFields(oldRow, newRow, dataset.columns);
      if (fields.length) {
        changed.push({
          key,
          changed_fields: fields,
          before: stableShape(oldRow, dataset.columns),
          after: stableShape(newRow, dataset.columns),
        });
      }
    }
  }
  return {
    dataset: name,
    counts: {
      before: before.size,
      after: after.size,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
    },
    added,
    removed,
    changed,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.from || !args.to) {
    console.error('--from and --to source keys are required');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const datasets = [];
    for (const [name, dataset] of Object.entries(DATASETS)) {
      datasets.push(await compareDataset(client, name, dataset, args.from, args.to));
    }
    const report = {
      report: 'drug-kb-edition-diff-v1',
      generated_at: new Date().toISOString(),
      from_source_key: args.from,
      to_source_key: args.to,
      status: 'completed',
      totals: datasets.reduce((acc, dataset) => {
        acc.added += dataset.counts.added;
        acc.removed += dataset.counts.removed;
        acc.changed += dataset.counts.changed;
        return acc;
      }, { added: 0, removed: 0, changed: 0 }),
      datasets,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
