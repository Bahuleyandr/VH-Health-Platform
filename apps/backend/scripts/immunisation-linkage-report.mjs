#!/usr/bin/env node
// apps/backend/scripts/immunisation-linkage-report.mjs
//
// O1 — read-only, tenant-scoped, deterministic reconciliation report for
// newborn <-> patient immunisation duplicate / linkage risk. It NEVER writes.
//
//   DATABASE_URL=... node apps/backend/scripts/immunisation-linkage-report.mjs \
//     --tenant <uuid> [--json] [--limit N]
//
// For one tenant it enumerates two risk families:
//   * patient_immunisations rows that share an EXACT identity + vaccine with a
//     newborn dose — classified already_linked / linkable / multiple_newborns /
//     multiple_doses; and
//   * newborn_immunisations rows whose newborn has no newborn_patient_uid and
//     therefore can never be exactly linked — missing_newborn_patient_uid.
//
// Identity is matched ONLY on exact uuid (maternity_newborns.newborn_patient_uid
// = patient_immunisations.patient_uid) and exact vaccine_catalogue_id — never on
// vaccine name/code equivalence. Every query is scoped by tenant_id so the
// report can never leak another tenant's rows. Pure reads: idempotent and
// deterministic (stable ordering), safe to run as often as needed.

import { pathToFileURL } from 'node:url';
import prisma from '../src/lib/prisma.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 5000;

export function parseArgs(argv) {
  const opts = { tenantId: null, json: false, limit: DEFAULT_LIMIT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant' || arg === '--tenant-id') {
      opts.tenantId = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--tenant=')) {
      opts.tenantId = arg.slice('--tenant='.length);
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--limit') {
      opts.limit = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      opts.limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

// Classification mirrors the seed's exact-link rule precisely: a link is only
// safe when identity is unambiguous (exactly one newborn for the uid) and that
// newborn has exactly one matching dose.
export function classifyLinkage({ currentLink, newbornCount, doseCount }) {
  if (currentLink != null) return 'already_linked';
  if (newbornCount > 1) return 'multiple_newborns';
  if (doseCount > 1) return 'multiple_doses';
  return 'linkable';
}

function isoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Build the linkage-risk report for a single tenant. Pure reads.
 *
 * @param {{ tenantId: string, limit?: number }} params
 * @returns {Promise<{ tenant_id: string, limit: number, truncated: boolean,
 *   summary: Record<string, number>, records: Array<object> }>}
 */
export async function buildLinkageReport({ tenantId, limit = DEFAULT_LIMIT } = {}) {
  if (!tenantId || !UUID_RE.test(String(tenantId))) {
    throw new Error('buildLinkageReport requires a valid tenant uuid');
  }
  const tid = String(tenantId);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  // How many newborns carry each uid in this tenant — the identity-ambiguity
  // signal, independent of whether a given newborn has a matching dose.
  const newbornCounts = await prisma.$queryRawUnsafe(
    `SELECT newborn_patient_uid AS uid, COUNT(*)::int AS total
       FROM maternity_newborns
      WHERE tenant_id = $1::uuid
        AND newborn_patient_uid IS NOT NULL
      GROUP BY newborn_patient_uid`,
    tid,
  );
  const nbTotalByUid = new Map();
  for (const row of newbornCounts) nbTotalByUid.set(String(row.uid), Number(row.total));

  // One row per (patient dose x candidate newborn dose) — same exact identity
  // and same exact vaccine_catalogue_id.
  const paired = await prisma.$queryRawUnsafe(
    `SELECT
        pi.id                       AS patient_immunisation_id,
        pi.patient_uid              AS patient_uid,
        pi.vaccine_catalogue_id     AS vaccine_catalogue_id,
        pi.due_date::text           AS patient_due_date,
        pi.status                   AS patient_status,
        pi.given_at                 AS patient_given_at,
        pi.newborn_immunisation_id  AS current_link,
        vc.code                     AS code,
        vc.dose_number              AS dose_number,
        vc.display_name             AS display_name,
        vc.schedule_source          AS schedule_source,
        vc.source_version           AS source_version,
        n.id                        AS newborn_id,
        ni.id                       AS newborn_immunisation_id,
        ni.due_date::text           AS newborn_due_date,
        ni.status                   AS newborn_status,
        ni.given_at                 AS newborn_given_at
       FROM patient_immunisations pi
       JOIN vaccine_catalogue vc
         ON vc.id = pi.vaccine_catalogue_id
        AND vc.tenant_id = pi.tenant_id
       JOIN maternity_newborns n
         ON n.tenant_id = pi.tenant_id
        AND n.newborn_patient_uid = pi.patient_uid
       JOIN newborn_immunisations ni
         ON ni.tenant_id = n.tenant_id
        AND ni.newborn_id = n.id
        AND ni.vaccine_catalogue_id = pi.vaccine_catalogue_id
      WHERE pi.tenant_id = $1::uuid
      ORDER BY pi.patient_uid, vc.code, COALESCE(vc.dose_number, -1),
               pi.id, n.id, ni.id`,
    tid,
  );

  const byPatientDose = new Map();
  for (const row of paired) {
    const key = Number(row.patient_immunisation_id);
    let group = byPatientDose.get(key);
    if (!group) {
      group = { head: row, candidates: [] };
      byPatientDose.set(key, group);
    }
    group.candidates.push(row);
  }

  const patientRecords = [];
  for (const { head, candidates } of byPatientDose.values()) {
    const currentLink = head.current_link == null ? null : Number(head.current_link);
    const newbornCount = nbTotalByUid.get(String(head.patient_uid)) || 0;
    const reason = classifyLinkage({
      currentLink,
      newbornCount,
      doseCount: candidates.length,
    });
    // The singular authoritative newborn dose (already_linked -> the linked
    // one; linkable -> the only candidate). Null when the case is ambiguous.
    let authoritative = null;
    if (reason === 'already_linked') {
      authoritative = candidates.find(
        (candidate) => Number(candidate.newborn_immunisation_id) === currentLink,
      ) || null;
    } else if (reason === 'linkable') {
      [authoritative] = candidates;
    }
    patientRecords.push({
      kind: 'patient_dose',
      reason,
      patient_uid: head.patient_uid,
      patient_immunisation_id: Number(head.patient_immunisation_id),
      vaccine_catalogue_id: Number(head.vaccine_catalogue_id),
      code: head.code,
      dose_number: head.dose_number == null ? null : Number(head.dose_number),
      display_name: head.display_name,
      schedule_source: head.schedule_source,
      source_version: head.source_version,
      patient_due_date: head.patient_due_date,
      patient_status: head.patient_status,
      patient_given_at: isoOrNull(head.patient_given_at),
      current_link: currentLink,
      newborn_count: newbornCount,
      newborn_dose_count: candidates.length,
      newborn_id: authoritative ? Number(authoritative.newborn_id) : null,
      newborn_patient_uid: head.patient_uid,
      newborn_immunisation_id: authoritative ? Number(authoritative.newborn_immunisation_id) : null,
      newborn_due_date: authoritative ? authoritative.newborn_due_date : null,
      newborn_status: authoritative ? authoritative.newborn_status : null,
      newborn_given_at: authoritative ? isoOrNull(authoritative.newborn_given_at) : null,
      candidate_newborn_immunisation_ids: candidates
        .map((candidate) => Number(candidate.newborn_immunisation_id))
        .sort((a, b) => a - b),
    });
  }
  patientRecords.sort((a, b) => (
    String(a.patient_uid).localeCompare(String(b.patient_uid))
    || String(a.code).localeCompare(String(b.code))
    || (a.dose_number ?? -1) - (b.dose_number ?? -1)
    || a.patient_immunisation_id - b.patient_immunisation_id
  ));

  // Newborn doses that can never be uid-linked because the newborn carries no
  // newborn_patient_uid. Reported at dose granularity, capped + flagged.
  const orphanRows = await prisma.$queryRawUnsafe(
    `SELECT
        n.id                     AS newborn_id,
        ni.id                    AS newborn_immunisation_id,
        ni.vaccine_catalogue_id  AS vaccine_catalogue_id,
        ni.due_date::text        AS newborn_due_date,
        ni.status                AS newborn_status,
        ni.given_at              AS newborn_given_at,
        vc.code                  AS code,
        vc.dose_number           AS dose_number,
        vc.display_name          AS display_name,
        vc.schedule_source       AS schedule_source,
        vc.source_version        AS source_version
       FROM newborn_immunisations ni
       JOIN maternity_newborns n
         ON n.id = ni.newborn_id
        AND n.tenant_id = ni.tenant_id
       JOIN vaccine_catalogue vc
         ON vc.id = ni.vaccine_catalogue_id
        AND vc.tenant_id = ni.tenant_id
      WHERE ni.tenant_id = $1::uuid
        AND n.newborn_patient_uid IS NULL
      ORDER BY n.id, vc.code, COALESCE(vc.dose_number, -1), ni.id
      LIMIT $2::int`,
    tid, cap + 1,
  );
  const truncated = orphanRows.length > cap;
  const orphanRecords = orphanRows.slice(0, cap).map((row) => ({
    kind: 'newborn_dose',
    reason: 'missing_newborn_patient_uid',
    patient_uid: null,
    patient_immunisation_id: null,
    vaccine_catalogue_id: Number(row.vaccine_catalogue_id),
    code: row.code,
    dose_number: row.dose_number == null ? null : Number(row.dose_number),
    display_name: row.display_name,
    schedule_source: row.schedule_source,
    source_version: row.source_version,
    patient_due_date: null,
    patient_status: null,
    patient_given_at: null,
    current_link: null,
    newborn_count: 1,
    newborn_dose_count: 1,
    newborn_id: Number(row.newborn_id),
    newborn_patient_uid: null,
    newborn_immunisation_id: Number(row.newborn_immunisation_id),
    newborn_due_date: row.newborn_due_date,
    newborn_status: row.newborn_status,
    newborn_given_at: isoOrNull(row.newborn_given_at),
    candidate_newborn_immunisation_ids: [Number(row.newborn_immunisation_id)],
  }));

  const records = [...patientRecords, ...orphanRecords];
  const summary = records.reduce((acc, record) => {
    acc[record.reason] = (acc[record.reason] || 0) + 1;
    return acc;
  }, {});
  summary.total = records.length;

  return {
    tenant_id: tid,
    limit: cap,
    truncated,
    summary,
    records,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      'Usage: DATABASE_URL=... node scripts/immunisation-linkage-report.mjs '
      + '--tenant <uuid> [--json] [--limit N]\n',
    );
    return;
  }
  if (!opts.tenantId || !UUID_RE.test(String(opts.tenantId))) {
    throw new Error('A valid --tenant <uuid> is required (tenant-scoped; refuses a tenant-wide scan).');
  }
  const report = await buildLinkageReport({ tenantId: opts.tenantId, limit: opts.limit });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`\n[immunisation-linkage] tenant ${report.tenant_id}\n`);
  process.stdout.write(`  records : ${report.summary.total}\n`);
  for (const reason of [
    'already_linked', 'linkable', 'multiple_newborns',
    'multiple_doses', 'missing_newborn_patient_uid',
  ]) {
    if (report.summary[reason]) {
      process.stdout.write(`  ${reason.padEnd(28)}: ${report.summary[reason]}\n`);
    }
  }
  if (report.truncated) {
    process.stdout.write(
      `  NOTE: missing-uid newborn doses truncated at --limit ${report.limit}; re-run with a higher --limit.\n`,
    );
  }
  process.stdout.write('  (read-only; no rows were modified)\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then(async () => {
      await prisma.$disconnect().catch(() => {});
    })
    .catch(async (err) => {
      process.stderr.write(`[immunisation-linkage] fatal: ${err.message}\n`);
      await prisma.$disconnect().catch(() => {});
      process.exitCode = 1;
    });
}
