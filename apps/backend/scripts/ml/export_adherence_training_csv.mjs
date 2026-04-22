#!/usr/bin/env node

/**
 * Export labelled rows for scripts/ml/train_adherence_model.py.
 *
 * The snapshot date should normally be at least 30 days in the past so the
 * label column can look forward 30 days. The feature windows mirror the
 * runtime scorer:
 *   missed_30, overrides_30, late_refills_90, days_silent
 *
 * Example:
 *   node scripts/ml/export_adherence_training_csv.mjs --out data/labelled_adherence.csv
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import prisma from '../../src/lib/prisma.js';
import {
  adherenceTrainingRowsToCsv,
  defaultAdherenceSnapshotDate,
} from '../../src/services/gamification/adherenceTrainingDatasetService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(__dirname, '../../data/labelled_adherence.csv');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    asOf: defaultAdherenceSnapshotDate(),
    defaultThreshold: 2,
    limit: 50000,
    out: DEFAULT_OUT,
    tenantId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--out') {
      args.out = path.resolve(process.cwd(), next);
      i += 1;
    } else if (flag === '--as-of') {
      args.asOf = next;
      i += 1;
    } else if (flag === '--tenant-id') {
      args.tenantId = next;
      i += 1;
    } else if (flag === '--limit') {
      args.limit = Math.max(Number.parseInt(next, 10) || args.limit, 1);
      i += 1;
    } else if (flag === '--default-threshold') {
      args.defaultThreshold = Math.max(Number.parseInt(next, 10) || args.defaultThreshold, 1);
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Export medication-adherence training CSV.

Usage:
  node scripts/ml/export_adherence_training_csv.mjs --out data/labelled_adherence.csv

Options:
  --out PATH                 Output CSV path
  --as-of YYYY-MM-DD         Snapshot date; defaults to today minus 30 days
  --tenant-id UUID           Optional tenant filter when users.tenant_id exists
  --limit N                  Max patient rows, default 50000
  --default-threshold N      Future missed-dose count needed for label=1, default 2
`);
}

async function tableHasColumn(tableName, columnName) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    tableName,
    columnName
  );
  return rows.length > 0;
}

async function exportRows({ asOf, tenantId, limit, defaultThreshold }) {
  const hasUsersTenant = await tableHasColumn('users', 'tenant_id').catch(() => false);
  const tenantClause = tenantId && hasUsersTenant ? 'AND p.tenant_id = $5::uuid' : '';
  const params = tenantId && hasUsersTenant
    ? [asOf, defaultThreshold, limit, 'PATIENT', tenantId]
    : [asOf, defaultThreshold, limit, 'PATIENT'];

  return prisma.$queryRawUnsafe(
    `WITH candidate_patients AS (
       SELECT p.id, p.uid
         FROM users p
        WHERE COALESCE(p.role, 'PATIENT') = $4
          AND p.uid IS NOT NULL
          ${tenantClause}
        ORDER BY p.id
        LIMIT $3
     ),
     feature_rows AS (
       SELECT
         p.id AS patient_id,
         COUNT(ma.*) FILTER (
           WHERE ma.status = 'missed'
             AND COALESCE(ma.administered_at, ma.scheduled_time) > ($1::date - INTERVAL '30 days')
             AND COALESCE(ma.administered_at, ma.scheduled_time) <= $1::date
         )::int AS missed_30,
         COUNT(ma.*) FILTER (
           WHERE ma.override_reason IS NOT NULL
             AND COALESCE(ma.administered_at, ma.scheduled_time) > ($1::date - INTERVAL '30 days')
             AND COALESCE(ma.administered_at, ma.scheduled_time) <= $1::date
         )::int AS overrides_30,
         COUNT(ep.*) FILTER (
           WHERE ep.created_at > ($1::date - INTERVAL '90 days')
             AND ep.created_at <= $1::date
             AND COALESCE(ep.status, '') = 'ACTIVE'
         )::int AS late_refills_90,
         LEAST(
           COALESCE(FLOOR(EXTRACT(EPOCH FROM ($1::timestamp - MAX(pv.recorded_at))) / 86400), 60),
           60
         )::int AS days_silent,
         COUNT(future_ma.*) FILTER (
           WHERE future_ma.status = 'missed'
             AND COALESCE(future_ma.administered_at, future_ma.scheduled_time) > $1::date
             AND COALESCE(future_ma.administered_at, future_ma.scheduled_time) <= ($1::date + INTERVAL '30 days')
         )::int AS future_missed_30
       FROM candidate_patients p
       LEFT JOIN medication_administrations ma ON ma.patient_uid = p.uid
       LEFT JOIN e_prescriptions ep ON ep.patient_id = p.id
       LEFT JOIN patient_vitals pv ON pv.patient_uid = p.uid AND pv.recorded_at <= $1::date
       LEFT JOIN medication_administrations future_ma ON future_ma.patient_uid = p.uid
       GROUP BY p.id
     )
     SELECT
       missed_30,
       overrides_30,
       late_refills_90,
       days_silent,
       CASE WHEN future_missed_30 >= $2 THEN 1 ELSE 0 END AS defaulted_within_30
     FROM feature_rows
     ORDER BY patient_id`,
    ...params
  );
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return 0;
  }

  try {
    const rows = await exportRows({
      asOf: args.asOf,
      tenantId: args.tenantId,
      limit: args.limit,
      defaultThreshold: args.defaultThreshold,
    });
    const csv = adherenceTrainingRowsToCsv(rows);
    await fs.mkdir(path.dirname(args.out), { recursive: true });
    await fs.writeFile(args.out, csv, 'utf8');
    console.log(`Wrote ${rows.length} adherence training row(s) to ${args.out}`);
    console.log(`Snapshot date: ${args.asOf}; label window: next 30 days`);
    return 0;
  } catch (err) {
    console.error(`Failed to export adherence training CSV: ${err.message}`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
