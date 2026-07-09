#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(backendRoot, '../..');

const REQUIRED_DOCS = [
  {
    id: 'cross-site-plan',
    file: 'docs/CROSS_SITE_DR_FAILOVER_PLAN.md',
    contains: [
      'Cross-Site DR Replica And Failover Plan',
      'Clinical Invariant Checklist',
      'Promotion Runbook Deltas',
      'Readiness Preflight',
    ],
  },
  {
    id: 'promotion-evidence-template',
    file: 'docs/qa-findings/cross-site-dr-promotion-template.md',
    contains: ['Clinical Invariants', 'Traffic Cutover', 'Downtime Reconciliation'],
  },
  {
    id: 'restore-drill-runbook',
    file: 'docs/DR_RESTORE_DRILL.md',
    contains: ['RPO', 'RTO', 'clinical invariant'],
  },
  {
    id: 'cnpg-dr-template',
    file: 'infra/kubernetes/base/cnpg/dr-restore-drill.yaml',
    contains: ['vhhealth-pg-drill', 'RECOVERY_TARGET_TIME'],
  },
  {
    id: 'r2-hardening-manifest',
    file: 'infra/kubernetes/base/cnpg/r2-backup-hardening.yaml',
    contains: ['versioning', 'DR reader'],
  },
];

const OPERATOR_FIELDS = [
  ['DR_SITE_NAME', 'Approved DR site or cluster name'],
  ['DR_NETWORK_PATH', 'Approved network path or egress pattern'],
  ['DR_STORAGE_JURISDICTION', 'Approved backup/restore storage jurisdiction'],
  ['DR_RPO_RTO_APPROVER', 'Named RPO/RTO approver or ticket'],
  ['DR_DNS_FAILOVER_OWNER', 'DNS, Cloudflare, or tunnel cutover owner'],
  ['DR_REPLICA_MODE', 'Replica mode'],
  ['DR_DRILL_WINDOW', 'Approved drill or promotion window'],
  ['DR_BACKUP_READER_SECRET_REF', 'Reference to the read-only DR backup credential, not the secret value'],
];

const REPLICA_MODES = new Set([
  'backup-fed-warm-standby',
  'async-physical-replica',
  'cnpg-external-cluster',
]);

const args = parseArgs(process.argv.slice(2));
const report = {
  generated_at: new Date().toISOString(),
  operator_ready: args.operatorReady,
  checks: [],
  summary: {
    passed: 0,
    warnings: 0,
    blockers: 0,
  },
};

for (const doc of REQUIRED_DOCS) {
  checkDoc(doc);
}

checkPackageScript();
checkOperatorInputs(args.operatorReady);

if (args.output) {
  const outputPath = resolveRepoPath(args.output);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printSummary(args.output);
}

if (report.summary.blockers > 0) {
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {
    json: false,
    operatorReady: false,
    output: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') parsed.json = true;
    else if (arg === '--operator-ready') parsed.operatorReady = true;
    else if (arg === '--output') parsed.output = argv[++i] || null;
    else if (arg.startsWith('--output=')) parsed.output = arg.slice('--output='.length);
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node apps/backend/scripts/dr-cross-site-preflight.mjs [options]

Options:
  --operator-ready   Require operator-owned DR site, network, storage, DNS, and drill fields.
  --output <path>    Write the JSON report.
  --json             Print the full JSON report.
`);
}

function addCheck(level, id, summary, details = {}) {
  report.checks.push({ level, id, summary, details });
  if (level === 'pass') report.summary.passed += 1;
  if (level === 'warning') report.summary.warnings += 1;
  if (level === 'blocker') report.summary.blockers += 1;
}

function checkDoc(doc) {
  const absolute = resolveRepoPath(doc.file);
  if (!existsSync(absolute)) {
    addCheck('blocker', `${doc.id}-missing`, `${doc.file} is missing.`);
    return;
  }

  const body = readFileSync(absolute, 'utf8');
  const missing = doc.contains.filter((needle) => !body.includes(needle));
  if (missing.length > 0) {
    addCheck('blocker', `${doc.id}-incomplete`, `${doc.file} is missing required DR package markers.`, {
      missing,
    });
    return;
  }

  addCheck('pass', `${doc.id}-present`, `${doc.file} is present and contains required markers.`);
}

function checkPackageScript() {
  const packagePath = resolveRepoPath('apps/backend/package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const actual = pkg.scripts?.['dr:cross-site:preflight'];
  if (actual !== 'node scripts/dr-cross-site-preflight.mjs') {
    addCheck('blocker', 'package-script-missing', 'apps/backend/package.json must expose dr:cross-site:preflight.');
    return;
  }

  addCheck('pass', 'package-script-present', 'Backend package exposes dr:cross-site:preflight.');
}

function checkOperatorInputs(operatorReady) {
  if (!operatorReady) {
    addCheck(
      'warning',
      'operator-inputs-not-required',
      'Operator-owned site/network/storage/DNS fields were not required because --operator-ready was not supplied.',
    );
    return;
  }

  for (const [name, label] of OPERATOR_FIELDS) {
    if (!process.env[name]) {
      addCheck('blocker', `${name.toLowerCase()}-missing`, `${label} is required for operator-ready cross-site DR.`);
    } else {
      addCheck('pass', `${name.toLowerCase()}-present`, `${label} is present.`, {
        present: true,
      });
    }
  }

  const mode = process.env.DR_REPLICA_MODE || '';
  if (mode && !REPLICA_MODES.has(mode)) {
    addCheck('blocker', 'dr-replica-mode-invalid', `DR_REPLICA_MODE must be one of: ${[...REPLICA_MODES].join(', ')}.`);
  }

  checkNumericTarget('DR_RPO_MINUTES', 5);
  checkNumericTarget('DR_RTO_MINUTES', 60);
}

function checkNumericTarget(name, ceiling) {
  const raw = process.env[name];
  if (!raw) {
    addCheck('warning', `${name.toLowerCase()}-not-set`, `${name} not set; using the current runbook target ceiling of ${ceiling} minutes.`);
    return;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    addCheck('blocker', `${name.toLowerCase()}-invalid`, `${name} must be a positive number of minutes.`);
    return;
  }

  if (value > ceiling) {
    addCheck('blocker', `${name.toLowerCase()}-too-high`, `${name}=${value} exceeds the current runbook ceiling of ${ceiling} minutes.`);
    return;
  }

  addCheck('pass', `${name.toLowerCase()}-within-target`, `${name}=${value} is within the current runbook ceiling of ${ceiling} minutes.`);
}

function printSummary(outputPath) {
  console.log(
    `DR cross-site preflight: ${report.summary.passed} passed, ` +
      `${report.summary.warnings} warnings, ${report.summary.blockers} blockers.`,
  );

  for (const check of report.checks) {
    const prefix = check.level.toUpperCase().padEnd(7, ' ');
    console.log(`${prefix} ${check.id}: ${check.summary}`);
  }

  if (outputPath) {
    console.log(`Report written to ${resolveRepoPath(outputPath)}`);
  }
}

function resolveRepoPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
}
