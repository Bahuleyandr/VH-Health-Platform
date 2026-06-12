#!/usr/bin/env node
// India deployability preflight.
//
// This is a production gate for India hospital launches. Use --advisory while
// collecting owner-side evidence; omit it for a hard deployability decision.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const REQUIRED_TABLES = [
  'patient_consents',
  'patient_data_rights_requests',
  'data_processing_activities',
  'data_retention_policies',
  'abdm_webhook_events',
  'nabh_indicator_snapshots',
  'india_compliance_evidence',
  'billing_invoices',
  'billing_payments',
  'pharmacy_orders',
  'pharmacy_inventory_batches',
  'pharmacy_suppliers',
];

const RETENTION_TABLES = [
  'users',
  'patient_consents',
  'patient_data_rights_requests',
  'abdm_consent_artifacts',
  'abdm_data_requests',
  'abdm_data_transfers',
  'abdm_webhook_events',
  'audit_logs',
  'clinical_audit_events',
  'nabh_indicator_snapshots',
  'billing_invoices',
  'billing_payments',
  'pharmacy_orders',
  'pharmacy_inventory_batches',
  'pharmacy_suppliers',
];

const REQUIRED_EVIDENCE_CONTROLS = [
  'DPDP_NOTICE_PURPOSE_MAP',
  'DPDP_DSR_DRY_RUN',
  'DPDP_RETENTION_SCHEDULE',
  'ABDM_CALLBACK_AUTHENTICITY',
  'ABDM_M2_ENCRYPTED_PUSH',
  'NABH_AUDIT_EXPORT',
  'INDIA_LOG_RETENTION_180D',
  'DR_RESTORE_DRILL',
  'VAPT_OR_SIGNED_EXCEPTION',
  'SIEM_ALERTS_ONCALL',
  'LOCAL_REGION_BACKUP_JURISDICTION',
  'IMAGE_SIGNATURE_ADMISSION',
  'BILLING_GST_TPA_RECON',
  'PHARMACY_LICENSE_PRESCRIPTION_CONTROL',
];

const ACCEPTED_EVIDENCE_STATUSES = new Set([
  'verified',
  'accepted_exception',
  'not_applicable',
]);

const ABDM_REQUIRED_ENV = [
  'ABDM_CLIENT_ID',
  'ABDM_CLIENT_SECRET',
  'ABDM_HIP_ID',
  'ABDM_CALLBACK_URL',
  'ABDM_CALLBACK_SECRET',
];

function parseArgs(argv) {
  const args = {
    advisory: false,
    noDb: false,
    output: null,
    tenantId: DEFAULT_TENANT_ID,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--advisory') args.advisory = true;
    else if (arg === '--no-db') args.noDb = true;
    else if (arg === '--output') args.output = argv[++i] || null;
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
    else if (arg === '--tenant-id') args.tenantId = argv[++i] || args.tenantId;
    else if (arg.startsWith('--tenant-id=')) args.tenantId = arg.slice('--tenant-id='.length);
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.tenantId)) {
    throw new Error(`Invalid --tenant-id UUID: ${args.tenantId}`);
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node -r dotenv/config apps/backend/scripts/india-deployability-preflight.mjs [options]

Options:
  --advisory              Report blockers but exit 0.
  --no-db                 Skip database checks; only verify environment posture.
  --output <path>         Write the JSON report.
  --tenant-id <uuid>      Tenant to check. Defaults to the platform default tenant.
`);
}

function makeReport(args) {
  return {
    generated_at: new Date().toISOString(),
    tenant_id: args.tenantId,
    advisory: args.advisory,
    no_db: args.noDb,
    checks: [],
    summary: {
      passed: 0,
      warnings: 0,
      blockers: 0,
    },
  };
}

function addCheck(report, level, id, summary, details = {}) {
  report.checks.push({ level, id, summary, details });
  if (level === 'pass') report.summary.passed += 1;
  if (level === 'warning') report.summary.warnings += 1;
  if (level === 'blocker') report.summary.blockers += 1;
}

async function withDb(args, report, fn) {
  if (args.noDb) {
    addCheck(report, 'warning', 'db-skipped', 'Database checks skipped because --no-db was supplied.');
    if (!args.advisory) {
      addCheck(report, 'blocker', 'db-required-for-hard-gate', '--no-db is only valid with --advisory; production deployability requires database checks.');
    }
    return null;
  }

  if (!process.env.DATABASE_URL) {
    addCheck(report, 'blocker', 'database-url-missing', 'DATABASE_URL is required for deployability checks.');
    return null;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (err) {
    addCheck(report, 'blocker', 'database-connect-failed', 'Could not connect to DATABASE_URL for deployability checks.', {
      error: err.code || err.message,
    });
    return null;
  }

  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function getExistingTables(client, tableNames) {
  const { rows } = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [tableNames],
  );
  return new Set(rows.map((row) => row.table_name));
}

async function checkRequiredTables(client, report) {
  const existing = await getExistingTables(client, REQUIRED_TABLES);
  const missing = REQUIRED_TABLES.filter((table) => !existing.has(table));

  if (missing.length > 0) {
    addCheck(report, 'blocker', 'required-schema-missing', 'Required India deployability tables are missing.', { missing });
    return existing;
  }

  addCheck(report, 'pass', 'required-schema-present', `${REQUIRED_TABLES.length} required India deployability tables are present.`);
  return existing;
}

async function checkRetentionPolicies(client, report, tenantId, existingTables) {
  if (!existingTables.has('data_retention_policies')) {
    addCheck(report, 'blocker', 'retention-table-missing', 'data_retention_policies is missing.');
    return;
  }

  const { rows } = await client.query(
    `SELECT applies_to_table, retention_days, status
       FROM data_retention_policies
      WHERE tenant_id = $1::uuid
        AND applies_to_table = ANY($2::text[])
        AND status = 'active'`,
    [tenantId, RETENTION_TABLES],
  );

  const byTable = new Map(rows.map((row) => [row.applies_to_table, row]));
  const missing = RETENTION_TABLES.filter((table) => !byTable.has(table));

  if (missing.length > 0) {
    addCheck(report, 'blocker', 'retention-policy-missing', 'India baseline retention policies are missing or inactive.', { missing });
  } else {
    addCheck(report, 'pass', 'retention-policies-present', `${RETENTION_TABLES.length} critical retention policies are active.`);
  }

  const auditPolicy = byTable.get('audit_logs');
  if (!auditPolicy || Number(auditPolicy.retention_days) < 180) {
    addCheck(report, 'blocker', 'cert-in-log-retention-short', 'audit_logs retention is below the 180-day CERT-In readiness threshold.', {
      retention_days: auditPolicy?.retention_days ?? null,
    });
  } else {
    addCheck(report, 'pass', 'cert-in-log-retention', `audit_logs retention is ${auditPolicy.retention_days} days.`);
  }
}

async function checkDataRightsSla(client, report, tenantId, existingTables) {
  if (!existingTables.has('patient_data_rights_requests')) {
    addCheck(report, 'blocker', 'data-rights-table-missing', 'patient_data_rights_requests is missing.');
    return;
  }

  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS overdue
       FROM patient_data_rights_requests
      WHERE tenant_id = $1::uuid
        AND status IN ('submitted', 'in_review')
        AND due_at IS NOT NULL
        AND due_at < NOW()`,
    [tenantId],
  );

  const overdue = rows[0]?.overdue ?? 0;
  if (overdue > 0) {
    addCheck(report, 'blocker', 'data-rights-overdue', 'Open data-principal rights requests are past due.', { overdue });
  } else {
    addCheck(report, 'pass', 'data-rights-sla-clear', 'No submitted/in_review data-principal rights requests are overdue.');
  }
}

async function checkEvidenceLedger(client, report, tenantId, existingTables) {
  if (!existingTables.has('india_compliance_evidence')) {
    addCheck(report, 'blocker', 'india-evidence-table-missing', 'india_compliance_evidence is missing; run migration 300 first.');
    return;
  }

  const { rows } = await client.query(
    `SELECT control_code, control_area, status, evidence_uri, verified_at
       FROM india_compliance_evidence
      WHERE tenant_id = $1::uuid
        AND control_code = ANY($2::text[])
      ORDER BY control_area, control_code`,
    [tenantId, REQUIRED_EVIDENCE_CONTROLS],
  );

  const byCode = new Map(rows.map((row) => [row.control_code, row]));
  const missing = REQUIRED_EVIDENCE_CONTROLS.filter((code) => !byCode.has(code));
  const unaccepted = REQUIRED_EVIDENCE_CONTROLS
    .map((code) => byCode.get(code))
    .filter((row) => row && !ACCEPTED_EVIDENCE_STATUSES.has(row.status))
    .map((row) => ({
      control_code: row.control_code,
      control_area: row.control_area,
      status: row.status,
      has_evidence_uri: Boolean(row.evidence_uri),
      verified_at: row.verified_at,
    }));

  if (missing.length > 0) {
    addCheck(report, 'blocker', 'india-evidence-missing', 'Required India evidence controls have not been seeded.', { missing });
  }

  if (unaccepted.length > 0) {
    addCheck(report, 'blocker', 'india-evidence-not-accepted', 'India launch evidence rows are not verified, accepted as exceptions, or marked not applicable.', {
      unaccepted,
      accepted_statuses: [...ACCEPTED_EVIDENCE_STATUSES],
    });
  }

  if (missing.length === 0 && unaccepted.length === 0) {
    addCheck(report, 'pass', 'india-evidence-accepted', `${REQUIRED_EVIDENCE_CONTROLS.length} India evidence controls are accepted.`);
  }
}

async function checkAbdm(client, report, existingTables) {
  const abdmEnabled = /^(1|true|yes)$/i.test((process.env.ABDM_ENABLED || '').trim());
  if (!abdmEnabled) {
    addCheck(report, 'warning', 'abdm-disabled', 'ABDM_ENABLED is not true; ABDM production launch remains blocked until owner-side onboarding is complete.');
    return;
  }

  const missing = ABDM_REQUIRED_ENV.filter((key) => !(process.env[key] || '').trim());
  if (missing.length > 0) {
    addCheck(report, 'blocker', 'abdm-env-missing', 'ABDM is enabled but required sealed env values are missing.', { missing });
  } else {
    addCheck(report, 'pass', 'abdm-env-present', `${ABDM_REQUIRED_ENV.length} required ABDM env values are present.`);
  }

  if (!existingTables.has('abdm_webhook_events')) {
    addCheck(report, 'blocker', 'abdm-webhook-events-missing', 'abdm_webhook_events table is missing.');
    return;
  }

  const { rows } = await client.query(
    `SELECT
        COUNT(*)::int AS total_recent,
        COUNT(*) FILTER (WHERE signature_verified = false)::int AS unsigned_recent
       FROM abdm_webhook_events
      WHERE received_at >= NOW() - INTERVAL '30 days'`,
  );

  const totalRecent = rows[0]?.total_recent ?? 0;
  const unsignedRecent = rows[0]?.unsigned_recent ?? 0;
  if (unsignedRecent > 0) {
    addCheck(report, 'blocker', 'abdm-unsigned-callbacks-recent', 'Recent ABDM webhook events include callbacks without verified signatures.', {
      total_recent: totalRecent,
      unsigned_recent: unsignedRecent,
    });
  } else {
    addCheck(report, 'pass', 'abdm-callback-signatures-clear', `No unsigned ABDM callback events in the last 30 days (${totalRecent} recent event(s)).`);
  }
}

async function checkNabh(client, report, tenantId, existingTables) {
  if (!existingTables.has('nabh_indicator_snapshots')) {
    addCheck(report, 'blocker', 'nabh-snapshot-table-missing', 'nabh_indicator_snapshots is missing.');
    return;
  }

  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS snapshot_count
       FROM nabh_indicator_snapshots
      WHERE tenant_id = $1::uuid`,
    [tenantId],
  );

  const snapshotCount = rows[0]?.snapshot_count ?? 0;
  if (snapshotCount === 0) {
    addCheck(report, 'warning', 'nabh-snapshots-empty', 'No NABH indicator snapshots exist for this tenant; attach assessor-pack evidence before go-live.');
  } else {
    addCheck(report, 'pass', 'nabh-snapshots-present', `${snapshotCount} NABH indicator snapshot(s) exist for this tenant.`);
  }
}

function checkEnvPosture(report) {
  const requiredProductionGuards = [
    'NODE_ENV',
    'JWT_SECRET',
    'DATABASE_URL',
  ];

  const missing = requiredProductionGuards.filter((key) => !(process.env[key] || '').trim());
  if (missing.length > 0) {
    addCheck(report, 'warning', 'baseline-env-missing', 'Some baseline runtime env values are not set in this shell.', { missing });
  } else {
    addCheck(report, 'pass', 'baseline-env-present', 'Baseline runtime env values are present in this shell.');
  }
}

async function writeReport(outputPath, report) {
  if (!outputPath) return;
  const absolutePath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function printReport(report) {
  console.log('=== VH Health India deployability preflight ===');
  console.log(`Generated: ${report.generated_at}`);
  console.log(`Tenant: ${report.tenant_id}`);
  console.log(`Mode: ${report.advisory ? 'advisory' : 'hard gate'}${report.no_db ? ' / no-db' : ''}`);
  console.log('');

  for (const check of report.checks) {
    const prefix = check.level === 'pass' ? 'PASS' : check.level === 'warning' ? 'WARN' : 'BLOCK';
    console.log(`[${prefix}] ${check.id}: ${check.summary}`);
  }

  console.log('');
  console.log(`Summary: ${report.summary.passed} passed, ${report.summary.warnings} warning(s), ${report.summary.blockers} blocker(s).`);
  if (report.no_db) {
    console.log(`Verdict: database checks skipped; not a production deployability pass${report.advisory ? ' (advisory exit)' : ''}.`);
    return;
  }
  console.log(report.summary.blockers === 0
    ? 'Verdict: deployability gate passed.'
    : `Verdict: deployability gate blocked${report.advisory ? ' (advisory exit)' : ''}.`);
}

const args = parseArgs(process.argv.slice(2));
const report = makeReport(args);

checkEnvPosture(report);

await withDb(args, report, async (client) => {
  const existingTables = await checkRequiredTables(client, report);
  await checkRetentionPolicies(client, report, args.tenantId, existingTables);
  await checkDataRightsSla(client, report, args.tenantId, existingTables);
  await checkEvidenceLedger(client, report, args.tenantId, existingTables);
  await checkAbdm(client, report, existingTables);
  await checkNabh(client, report, args.tenantId, existingTables);
});

await writeReport(args.output, report);
printReport(report);

process.exit(report.summary.blockers === 0 || args.advisory ? 0 : 1);
