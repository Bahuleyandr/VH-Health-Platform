#!/usr/bin/env node

// C0.1 REPORT EMITTER — NO LIVE COMMAND EXECUTION.
//
// ABSOLUTE SAFETY RULES:
// 1. READ-ONLY: this emitter only reads an operator evidence directory and
//    repository target files, then writes local reports.
// 2. NEVER PRINT SECRET VALUES: sensitive named values, bearer credentials,
//    and long encoded values are removed from both reports; the redacted
//    report additionally pseudonymizes host addresses.
// 3. NEVER TOUCH PHI: the emitter has no database or network capability and
//    reports only the fixed infrastructure captures selected by the collector.
// 4. DEGRADE, DON'T CRASH: unavailable live captures become one of the explicit
//    four-state rows rather than being inferred.
// 5. RECORD EVERY COMMAND: the complete capture index is rendered as the
//    command ledger in both reports.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const STATES = Object.freeze([
  'repository target',
  'live verified',
  'absent',
  'unknown',
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, '..', '..', '..');

function usage() {
  process.stdout.write(`Usage:
  node c0-1-live-state-report.mjs \\
    --input EVIDENCE_DIRECTORY \\
    --full FULL_REPORT.md \\
    --redacted REDACTED_SUMMARY.md \\
    [--repo-root REPOSITORY_ROOT]

The input directory must contain index.tsv plus the command capture files
created by c0-1-live-state-evidence.sh. Both reports are generated
automatically; redaction never depends on an operator editing the full report.
`);
}

export function parseArgs(argv) {
  const parsed = {
    input: null,
    full: null,
    redacted: null,
    repoRoot: defaultRepoRoot,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    const match = arg.match(/^--(input|full|redacted|repo-root)=(.+)$/);
    if (match) {
      const key = match[1] === 'repo-root' ? 'repoRoot' : match[1];
      parsed[key] = match[2];
      continue;
    }
    if (['--input', '--full', '--redacted', '--repo-root'].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      const key = arg === '--repo-root' ? 'repoRoot' : arg.slice(2);
      parsed[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.help) {
    for (const key of ['input', 'full', 'redacted']) {
      if (!parsed[key]) throw new Error(`--${key} is required`);
    }
  }
  return parsed;
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function readRepoFile(repoRoot, relativePath) {
  return readIfPresent(path.join(repoRoot, ...relativePath.split('/')));
}

export function parseCapture(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const firstMarker = normalized.indexOf('\n---\n');
  const lastMarker = normalized.lastIndexOf('\n---\n');
  const statusMatch = normalized.match(/\nexit_status=(\d+)\s*$/);
  if (firstMarker === -1 || lastMarker === firstMarker || !statusMatch) {
    return { output: normalized.trim(), status: null };
  }
  return {
    output: normalized.slice(firstMarker + 5, lastMarker).trim(),
    status: Number(statusMatch[1]),
  };
}

export function readCaptureIndex(inputDir) {
  const indexFile = path.join(inputDir, 'index.tsv');
  const source = readIfPresent(indexFile);
  const captures = new Map();
  if (!source) return captures;

  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    if (!line || lineIndex === 0) continue;
    const fields = line.split('\t');
    if (fields.length !== 6) {
      throw new Error(`Malformed index.tsv row ${lineIndex + 1}`);
    }
    const [id, section, label, relativeFile, indexedStatus, command] = fields;
    const captureFile = path.resolve(inputDir, relativeFile);
    if (!captureFile.startsWith(`${path.resolve(inputDir)}${path.sep}`)) {
      throw new Error(`Capture path escapes evidence directory: ${relativeFile}`);
    }
    const parsed = parseCapture(readIfPresent(captureFile));
    captures.set(id, {
      id,
      section,
      label,
      relativeFile,
      command,
      status: parsed.status ?? Number(indexedStatus),
      output: parsed.output,
    });
  }
  return captures;
}

function captureList(captures, ...idsOrPrefixes) {
  const results = [];
  for (const [id, capture] of captures) {
    if (
      idsOrPrefixes.some(
        (candidate) => id === candidate || id.startsWith(`${candidate}_`),
      )
    ) {
      results.push(capture);
    }
  }
  return results.sort((left, right) => left.id.localeCompare(right.id));
}

function successful(capture) {
  return capture?.status === 0;
}

function headerOnlyTable(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return false;

  const columns = lines[0].split(/\s{2,}|\t+/).filter(Boolean);
  const identityHeaders = new Set(['KIND', 'NAME', 'NAMESPACE', 'NODE', 'POD']);
  return (
    columns.length > 0 &&
    columns.every((column) => /^[A-Z][A-Z0-9_-]*$/.test(column)) &&
    columns.some((column) => identityHeaders.has(column))
  );
}

function explicitlyEmpty(output) {
  return (
    !output.trim() ||
    /No resources found|longhorn_installed=false|items:\s*\[\s*\]/i.test(output) ||
    headerOnlyTable(output)
  );
}

function deriveState(target, relevantCaptures) {
  if (relevantCaptures.length > 0) {
    if (relevantCaptures.some((capture) => !successful(capture))) return 'unknown';
    if (relevantCaptures.every(({ output }) => explicitlyEmpty(output))) return 'absent';
    return 'live verified';
  }
  if (target && target !== 'none') return 'repository target';
  return 'unknown';
}

function normalizeSpace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function bounded(value, limit = 420) {
  const normalized = normalizeSpace(value);
  if (!normalized) return 'no rows returned';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function summarizeCaptures(relevantCaptures, options = {}) {
  if (relevantCaptures.length === 0) return 'not collected';
  if (
    relevantCaptures.every(successful) &&
    relevantCaptures.every(({ output }) => explicitlyEmpty(output))
  ) {
    return options.absent || 'no live object was returned';
  }
  return bounded(
    relevantCaptures
      .map(({ id, output, status }) => {
        if (status !== 0) return `${id}: unavailable (exit ${status})`;
        if (explicitlyEmpty(output)) return `${id}: no rows returned`;
        return `${id}: ${output}`;
      })
      .join(' | '),
    options.limit,
  );
}

function extractQuotedValue(source, key) {
  const match = source.match(
    new RegExp(`^\\s*${key}:\\s*["']?([^"'\\s#]+)["']?`, 'm'),
  );
  return match?.[1] || 'not declared';
}

function extractTarget(repoRoot) {
  const appKustomization = readRepoFile(
    repoRoot,
    'infra/kubernetes/apps/kustomization.yaml',
  );
  const cnpgOperator = readRepoFile(
    repoRoot,
    'infra/kubernetes/base/cnpg/operator.yaml',
  );
  const cnpgCluster = readRepoFile(
    repoRoot,
    'infra/kubernetes/base/cnpg/cluster.yaml',
  );
  const monitoringTracker = readRepoFile(
    repoRoot,
    'infra/kubernetes/base/monitoring/chart-tracker.yaml',
  );
  const longhorn = readRepoFile(
    repoRoot,
    'infra/kubernetes/base/longhorn/longhorn-app.yaml',
  );
  const rke2Defaults = readRepoFile(
    repoRoot,
    'infra/ansible/roles/rke2_server/defaults/main.yml',
  );
  const upgradeRunbook = readRepoFile(
    repoRoot,
    'infra/ansible/playbooks/upgrade-k8s.yml',
  );
  const chrony = readRepoFile(
    repoRoot,
    'infra/ansible/roles/common/templates/chrony.conf.j2',
  );
  const backup = readRepoFile(
    repoRoot,
    'infra/kubernetes/base/cnpg/scheduled-backup.yaml',
  );
  const cloudflared = readRepoFile(
    repoRoot,
    'infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml',
  );

  const digestMatches = [
    ...appKustomization.matchAll(
      /-\s+name:\s+([^\s]+)[\s\S]*?\n\s+digest:\s+(sha256:[0-9a-f]{64})/g,
    ),
  ];
  const zeroDigests = digestMatches.filter(([, , digest]) =>
    /^sha256:0{64}$/.test(digest),
  );
  const imagePins = digestMatches.map(
    ([, image, digest]) => `${image}@${digest}`,
  );
  const rke2Objective =
    upgradeRunbook.match(/v1\.34\.\d+\+rke2r\d+/)?.[0] || '>=1.34';

  return {
    imagePins,
    imagePinStatus:
      zeroDigests.length === 0
        ? `real digests written: yes (${imagePins.length} pins)`
        : `real digests written: no (${zeroDigests.length} all-zero fail-closed placeholders)`,
    cnpgOperator: extractQuotedValue(cnpgOperator, 'operatorVersion'),
    postgresImage:
      cnpgCluster.match(/^\s*imageName:\s*(\S+)/m)?.[1] || 'not declared',
    longhorn: longhorn.match(/targetRevision:\s*["']?([^"'\s]+)/)?.[1] || 'not declared',
    prometheus: extractQuotedValue(monitoringTracker, 'prometheusVersion'),
    alertmanager: extractQuotedValue(monitoringTracker, 'alertmanagerVersion'),
    monitoringStack: extractQuotedValue(
      monitoringTracker,
      'kubePrometheusStackVersion',
    ),
    rke2StartingPin: extractQuotedValue(rke2Defaults, 'rke2_version'),
    rke2Objective,
    ntpPool:
      chrony.match(/^\s*pool\s+\{\{\s*common_ntp_pool\s*\}\}/m)
        ? 'Ansible common_ntp_pool (default 2.in.pool.ntp.org); hospital NTP is still commented'
        : 'not declared',
    backupSchedule:
      backup.match(/^\s*schedule:\s*["']([^"']+)["']/m)?.[1] || 'not declared',
    cloudflareTunnel:
      cloudflared.match(/^\s*tunnel:\s*(\S+)/m)?.[1] || 'not declared',
  };
}

function findC12Directory(inputDir) {
  const root = path.join(inputDir, 'raw', 'c1-2');
  if (!fs.existsSync(root)) return null;
  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('c1-2-ha-evidence-'))
    .map((entry) => path.join(root, entry.name))
    .sort();
  return candidates.at(-1) || null;
}

function c12Capture(inputDir, file) {
  const directory = findC12Directory(inputDir);
  if (!directory) return null;
  const content = readIfPresent(path.join(directory, file));
  if (!content) return null;
  const parsed = parseCapture(content);
  return {
    id: `c1_2/${file}`,
    status: parsed.status,
    output: parsed.output,
  };
}

function tableColumnValues(output, columnName) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  if (lines.length < 2) return [];

  // kubectl pads every column to a fixed width, so columns must be read by
  // character offset. Splitting a row on whitespace and indexing by token
  // shifts every later column whenever a cell contains a space -- RESTARTS
  // renders as "35 (21d ago)" and NOMINATED NODE is itself two words -- which
  // silently harvests the AGE value as if it were a node name.
  const columns = [...lines[0].matchAll(/\S(?:\S|\s(?!\s))*/g)].map(
    (match) => ({ name: match[0], start: match.index }),
  );
  const columnIndex = columns.findIndex(({ name }) => name === columnName);
  if (columnIndex === -1) return [];

  const start = columns[columnIndex].start;
  const end = columns[columnIndex + 1]?.start ?? Infinity;

  return lines
    .slice(1)
    .map((line) => line.slice(start, end).trim())
    .filter(
      (value) =>
        value &&
        value !== '<none>' &&
        /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value),
    );
}

function discoverNodeNames(captures, inputDir) {
  const nodeNames = new Set();
  const addColumn = (capture, columnName) => {
    if (!capture || !successful(capture)) return;
    for (const value of tableColumnValues(capture.output, columnName)) {
      nodeNames.add(value);
    }
  };

  for (const capture of captureList(captures, 'rke2_nodes')) {
    addColumn(capture, 'NODE');
  }
  for (const capture of captureList(captures, 'cloudflared')) {
    addColumn(capture, 'NODE');
  }
  addColumn(c12Capture(inputDir, '03-nodes-placement.txt'), 'NAME');
  addColumn(c12Capture(inputDir, '10-pod-placement.txt'), 'NODE');
  return [...nodeNames].sort((left, right) => right.length - left.length);
}

function row(section, fact, target, captures, liveOverride, stateOverride) {
  const state = stateOverride || deriveState(target, captures);
  if (!STATES.includes(state)) throw new Error(`Invalid evidence state: ${state}`);
  return {
    section,
    fact,
    state,
    target: target || 'none',
    live: liveOverride || summarizeCaptures(captures),
    evidence:
      captures.length === 0
        ? 'none'
        : captures.map(({ id }) => id).join(', '),
  };
}

export function buildEvidenceRows({ captures, inputDir, repoRoot }) {
  const target = extractTarget(repoRoot);
  const c12Fallback = captureList(captures, 'c1_2');
  const c12Version = c12Capture(inputDir, '01-kubernetes-release.txt');
  const c12Nodes = c12Capture(inputDir, '03-nodes-placement.txt');
  const c12Api = c12Capture(inputDir, '04-api-endpoint.txt');
  const c12Vip = c12Capture(inputDir, '07-vip-owner.txt');
  const c12Etcd = c12Capture(inputDir, '09-etcd-members-leader.txt');
  const c12Placement = [
    c12Capture(inputDir, '10-pod-placement.txt'),
    c12Capture(inputDir, '13-storageclasses.yaml'),
    c12Capture(inputDir, '14-persistent-volumes.txt'),
    c12Capture(inputDir, '15-persistent-volume-claims.txt'),
  ].filter(Boolean);
  const c12Replication = c12Capture(inputDir, '12-cnpg-replication.txt');
  const c12Helm = c12Capture(inputDir, '17-helm-releases.txt');
  const c12Longhorn = c12Capture(inputDir, '18-longhorn-state.txt');
  const longhornEvidence = c12Longhorn
    ? [c12Longhorn]
    : c12Helm
      ? [c12Helm]
      : c12Fallback;
  const c12Evidence = (capture) => (capture ? [capture] : c12Fallback);
  const rows = [];

  rows.push(
    row(
      'Release and images',
      'Repository application digest pins',
      target.imagePinStatus,
      [],
      'live comparison is in the next two rows',
      'repository target',
    ),
    row(
      'Release and images',
      'Running workload image references and image IDs',
      target.imagePins.join('; ') || 'three immutable application digests',
      captureList(captures, 'release_images'),
    ),
    row(
      'Release and images',
      'Argo CD target and deployed revisions',
      'manual-sync Applications track reviewed repository revisions',
      captureList(captures, 'argocd_apps'),
    ),
  );

  rows.push(
    row(
      'Kubernetes, database, and storage',
      'Kubernetes server/client release',
      `C1.2 objective ${target.rke2Objective}`,
      c12Evidence(c12Version),
    ),
    row(
      'Kubernetes, database, and storage',
      'RKE2 node versions',
      `starting pin ${target.rke2StartingPin}; objective ${target.rke2Objective}`,
      captureList(captures, 'rke2_nodes'),
    ),
    row(
      'Kubernetes, database, and storage',
      'CloudNativePG operator version and image',
      `CNPG ${target.cnpgOperator}`,
      captureList(captures, 'cnpg_operator'),
    ),
    row(
      'Kubernetes, database, and storage',
      'PostgreSQL image and cluster posture',
      target.postgresImage,
      captureList(captures, 'cnpg_clusters'),
    ),
    row(
      'Kubernetes, database, and storage',
      'Database-safe catalog facts: version, extensions, pgvector, migration high-water mark, and RLS posture',
      'PostgreSQL 18.4 target; vector must be available; no clinical rows may be read',
      captureList(captures, 'database_catalog'),
    ),
    row(
      'Kubernetes, database, and storage',
      'CNPG replication state',
      'three instances with one synchronous standby',
      c12Evidence(c12Replication),
    ),
    row(
      'Kubernetes, database, and storage',
      'StorageClasses, PVs, PVCs, and actual pod/PVC placement',
      'CNPG data/WAL remain local-path until C1.2 storage placement is qualified',
      c12Placement.length > 0 ? c12Placement : c12Fallback,
    ),
    row(
      'Kubernetes, database, and storage',
      'Longhorn presence, target version, and health',
      `Longhorn ${target.longhorn} is an unqualified, manual-sync repository target`,
      longhornEvidence,
    ),
  );

  rows.push(
    row(
      'Ingress, edge, DNS, and certificates',
      'IngressClasses and claimed controllers',
      'nginx public, nginx-internal active, nginx-internal-held intentionally unimplemented',
      captureList(captures, 'ingress_classes'),
    ),
    row(
      'Ingress, edge, DNS, and certificates',
      'Ingress controller workloads actually running',
      'separate public and internal ingress-nginx controllers',
      captureList(captures, 'ingress_controllers'),
    ),
    row(
      'Ingress, edge, DNS, and certificates',
      'Ingress routes and nginx-internal-held darkness',
      'held routes remain dark until their explicit activation gates close',
      captureList(captures, 'ingress_routes'),
    ),
    row(
      'Ingress, edge, DNS, and certificates',
      'Services and Service types',
      'repository Kubernetes Services',
      captureList(captures, 'services'),
    ),
    row(
      'Ingress, edge, DNS, and certificates',
      'Cloudflare tunnel workload state',
      `tunnel ${target.cloudflareTunnel}; three cloudflared replicas`,
      captureList(captures, 'cloudflared'),
    ),
    row(
      'Ingress, edge, DNS, and certificates',
      'Cloudflare control-plane tunnel status',
      'named production tunnel is healthy in the Cloudflare control plane',
      captureList(captures, 'cloudflare_api'),
    ),
    row(
      'Ingress, edge, DNS, and certificates',
      'DNS from an outside/public resolver',
      'public hostnames resolve through the intended edge',
      captureList(captures, 'dns_outside'),
    ),
    row(
      'Ingress, edge, DNS, and certificates',
      'DNS from the clinical VLAN resolver',
      'public and internal hostnames resolve as intended from the clinical VLAN',
      captureList(captures, 'dns_inside'),
    ),
    row(
      'Ingress, edge, DNS, and certificates',
      'Certificate resources, issuer, and expiry posture',
      'cert-manager Certificates match the intended public/internal issuers',
      captureList(captures, 'certificates'),
    ),
    row(
      'Ingress, edge, DNS, and certificates',
      'Certificates in use and SPKI SHA-256',
      'endpoint certificates are unexpired and SPKI is retained for C-D13 rotation',
      captureList(captures, 'tls_endpoints'),
    ),
  );

  rows.push(
    row(
      'Control plane and etcd',
      'Kubernetes API endpoint',
      'control-plane VIP rather than a node address',
      c12Evidence(c12Api),
    ),
    row(
      'Control plane and etcd',
      'VIP ownership',
      'exactly one control-plane VIP holder',
      c12Evidence(c12Vip),
    ),
    row(
      'Control plane and etcd',
      'etcd member list and leader',
      'three-member etcd topology with a single observable leader',
      c12Evidence(c12Etcd),
    ),
  );

  rows.push(
    row(
      'Monitoring and alerting',
      'Prometheus and discovery resources',
      `kube-prometheus-stack ${target.monitoringStack}; Prometheus ${target.prometheus}`,
      captureList(captures, 'prometheus_resources'),
    ),
    row(
      'Monitoring and alerting',
      'Prometheus active scrape targets',
      'Prometheus API reports active targets and scrape health',
      captureList(captures, 'prometheus_targets'),
    ),
    row(
      'Monitoring and alerting',
      'Prometheus loaded rules',
      'committed PrometheusRules are loaded by the live Prometheus',
      captureList(captures, 'prometheus_rules'),
    ),
    row(
      'Monitoring and alerting',
      'Prometheus Watchdog state',
      'Watchdog is continuously firing',
      captureList(captures, 'prometheus_watchdog'),
    ),
    row(
      'Monitoring and alerting',
      'Alertmanager resource and replica posture',
      `Alertmanager ${target.alertmanager}; receiver secret values remain unread`,
      captureList(captures, 'alertmanager_resources'),
    ),
    row(
      'Monitoring and alerting',
      'Watchdog visible to Alertmanager',
      'Alertmanager has a current Watchdog alert without exposing receiver configuration',
      captureList(captures, 'alertmanager_watchdog'),
    ),
  );

  rows.push(
    row(
      'Backups and restore',
      'CNPG ScheduledBackup state',
      `one vhhealth-pg-daily schedule at ${target.backupSchedule} (CNPG cron format)`,
      captureList(captures, 'scheduled_backups'),
    ),
    row(
      'Backups and restore',
      'Latest successful CNPG backup and timestamp',
      'latest Backup CR reports completed and is within the accepted RPO',
      captureList(captures, 'cnpg_backups'),
    ),
    row(
      'Backups and restore',
      'Application archive/verification CronJobs and latest Jobs',
      'producer and verifier schedules are healthy',
      captureList(captures, 'backup_jobs'),
    ),
    row(
      'Backups and restore',
      'Live R2 target metadata',
      'live non-secret endpoint/bucket configuration matches the repository target',
      captureList(captures, 'r2_target'),
    ),
    row(
      'Backups and restore',
      'R2 object lock and versioning posture',
      'operator-approved retention/bucket-lock posture',
      captureList(captures, 'r2_retention'),
    ),
    row(
      'Backups and restore',
      'Latest successful restore evidence',
      'most recent governed restore proof is completed and timestamped',
      captureList(captures, 'restore_evidence_jobs'),
    ),
    row(
      'Backups and restore',
      'Restore-proof schedule and recovery-cluster posture',
      'restore proof remains operator-gated and any disposable recovery cluster is observable',
      captureList(
        captures,
        'restore_evidence_schedule',
        'restore_evidence_clusters',
      ),
    ),
  );

  rows.push(
    row(
      'Time and clock trust',
      'Repository time-source target',
      target.ntpPool,
      [],
      'live node probes are separate',
      'repository target',
    ),
    row(
      'Time and clock trust',
      'Node chrony synchronization and source',
      'every node synchronized with sub-second drift to an approved source',
      captureList(captures, 'time_nodes'),
    ),
    row(
      'Time and clock trust',
      'Clinical device clock-trust posture',
      'device fleets have an owner-attested clock policy and drift response',
      [],
      'manual owner evidence required',
      'unknown',
    ),
  );

  const manualFacts = [
    'UPS and generator presence plus latest test date',
    'Switch redundancy and shared-failure mapping',
    'ISP arrangement and most recent failover result',
    'Per-node rack, power, cooling, switch, and physical zone mapping',
    'Cloudflare WAF, bot-management, and rate-limit configuration',
  ];
  for (const fact of manualFacts) {
    rows.push(
      row(
        'Manual operator attestations',
        fact,
        'named owner supplies a dated evidence reference without credentials or PHI',
        [],
        'operator must complete manual-checklist.md; this collector does not automate the check',
        'unknown',
      ),
    );
  }
  return rows;
}

function stableAlias(kind, value) {
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${kind}-${digest}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactText(value, nodeNames = []) {
  let redacted = sanitizeSecretValues(value);

  redacted = redacted.replace(
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    (address) => stableAlias('ipv4', address),
  );
  const ipv6Pattern =
    /(?<![0-9a-f:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?:(?::[0-9a-f]{1,4}){1,6})|:(?:(?::[0-9a-f]{1,4}){1,7}|:))(?![0-9a-f:])/gi;
  redacted = redacted.replace(ipv6Pattern, (address) =>
    stableAlias('ipv6', address.toLowerCase()),
  );
  redacted = redacted.replace(
    /\b(cp|node|worker|server)-[A-Za-z0-9_.-]+\b/gi,
    (hostname) => stableAlias('node', hostname.toLowerCase()),
  );
  for (const nodeName of [...new Set(nodeNames)].sort(
    (left, right) => right.length - left.length,
  )) {
    const nodePattern = new RegExp(
      `(?<![A-Za-z0-9_-])${escapeRegExp(nodeName)}(?![A-Za-z0-9_-])`,
      'gi',
    );
    redacted = redacted.replace(nodePattern, (hostname) =>
      stableAlias('node', hostname.toLowerCase()),
    );
  }
  return redacted;
}

export function sanitizeSecretValues(value) {
  return String(value)
    .replace(
      /(authorization\s*:\s*bearer\s+)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(password|passwd|token|secret_value|client_secret|access_key|api_key|credential|aws_secret_access_key|private_key)\s*[=:]\s*([^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /\b[A-Za-z0-9+/]{80,}={0,2}\b/g,
      '[REDACTED-LONG-ENCODED-VALUE]',
    );
}

function markdownCell(value) {
  return String(value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim();
}

function stateCounts(rows) {
  return Object.fromEntries(
    STATES.map((state) => [
      state,
      rows.filter((rowItem) => rowItem.state === state).length,
    ]),
  );
}

function manualChecklist() {
  return `# C0.1 Manual Operator Checklist

This checklist is deliberately not automated. Complete it by hand, attach only
credential-free and PHI-free references, and have the named infrastructure or
network owner sign it. Do not paste dashboard exports that contain tokens,
cookies, client addresses, patient identifiers, or request payloads.

| Check | Operator observation | Evidence reference | Observed/tested at (UTC) | Owner and signature |
|---|---|---|---|---|
| UPS presence, protected load, runtime, battery health, and latest transfer test |  |  |  |  |
| Generator presence, fuel/run-time assumption, automatic transfer behavior, and latest loaded test |  |  |  |  |
| Switch redundancy, uplinks, spanning/failover design, and shared failure points |  |  |  |  |
| ISP circuits, physical/provider diversity, failover mechanism, and latest failover test |  |  |  |  |
| Node-by-node rack, room, power feed, UPS, PDU, switch, cooling, and physical-zone mapping |  |  |  |  |
| Cloudflare WAF rulesets, bot controls, rate limits, exceptions, and last reviewed change |  |  |  |  |
| Clinical device fleet clock source, enforcement, drift tolerance, and incident response |  |  |  |  |

An empty row remains **unknown**. A repository diagram or intended design is
not a live verification. If the check would require a state change, stop and
schedule it as a separately approved drill.
`;
}

export function renderReport({
  rows,
  captures,
  repositorySha,
  generatedAt,
  redacted,
  nodeNames = [],
}) {
  const transform = redacted
    ? (value) => redactText(value, nodeNames)
    : sanitizeSecretValues;
  const counts = stateCounts(rows);
  const title = redacted
    ? 'C0.1 Live-State Evidence Summary (Redacted)'
    : 'C0.1 Live-State Evidence Report (Full Local Copy)';
  const sections = [...new Set(rows.map(({ section }) => section))];
  const lines = [
    `# ${title}`,
    '',
    `- Generated at: \`${generatedAt}\``,
    `- Repository baseline: \`${repositorySha || 'unknown'}\``,
    '- Safety boundary: read-only collection; no production state change; no secret values; no PHI.',
    `- State totals: ${STATES.map((state) => `${state}=${counts[state]}`).join(', ')}.`,
    redacted
      ? '- Redaction: raw IP addresses, discovered Kubernetes node names, and conventional node-role hostnames are replaced with deterministic SHA-256-derived aliases; configured service DNS names and workload metadata remain visible.'
      : '- Handling: keep this full copy in the operator artifact directory; it may contain node addresses and topology.',
    '',
    'The state describes the evidence available for that fact. `repository target`',
    'means the intended state exists in source but was not established live;',
    '`live verified` means the read-only command returned an observable live fact;',
    '`absent` means a successful query explicitly returned no object; and `unknown`',
    'means the probe was unavailable, unauthorized, unreachable, or manual.',
    '',
  ];

  for (const section of sections) {
    lines.push(`## ${section}`, '');
    lines.push('| Fact | State | Repository target | Live observation | Evidence |');
    lines.push('|---|---|---|---|---|');
    for (const item of rows.filter((candidate) => candidate.section === section)) {
      lines.push(
        `| ${markdownCell(transform(item.fact))} | **${item.state}** | ${markdownCell(
          transform(item.target),
        )} | ${markdownCell(transform(item.live))} | ${markdownCell(item.evidence)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Command ledger', '');
  lines.push(
    redacted
      ? 'The redacted ledger preserves commands and exit status but pseudonymizes host addresses.'
      : 'Every live interrogation command is recorded below and in the raw capture index.',
    '',
    '| ID | Section | Exit | Command | Artifact |',
    '|---|---|---:|---|---|',
  );
  for (const capture of [...captures.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    lines.push(
      `| ${markdownCell(capture.id)} | ${markdownCell(capture.section)} | ${
        capture.status
      } | \`${markdownCell(transform(capture.command))}\` | \`${markdownCell(
        capture.relativeFile,
      )}\` |`,
    );
  }

  lines.push(
    '',
    '## Interpretation boundary',
    '',
    'This inventory is evidence, not activation authority. Unknown and repository-only',
    'rows remain open. The pack does not authorize a manifest sync, migration, failover,',
    'fault injection, restore, production change, or clinical continuity activation.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function gitSha(repoRoot) {
  const gitHead = readIfPresent(path.join(repoRoot, '.git'));
  if (!gitHead && !fs.existsSync(path.join(repoRoot, '.git'))) return '';
  const capture = process.env.C0_1_REPOSITORY_SHA;
  return capture || '';
}

export function generateReports({
  input,
  full,
  redacted,
  repoRoot = defaultRepoRoot,
  generatedAt = new Date().toISOString(),
  repositorySha = gitSha(repoRoot),
}) {
  const resolvedInput = path.resolve(input);
  const resolvedRepo = path.resolve(repoRoot);
  const captures = readCaptureIndex(resolvedInput);
  const rows = buildEvidenceRows({
    captures,
    inputDir: resolvedInput,
    repoRoot: resolvedRepo,
  });
  const nodeNames = discoverNodeNames(captures, resolvedInput);
  fs.writeFileSync(
    full,
    renderReport({
      rows,
      captures,
      repositorySha,
      generatedAt,
      redacted: false,
      nodeNames,
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    redacted,
    renderReport({
      rows,
      captures,
      repositorySha,
      generatedAt,
      redacted: true,
      nodeNames,
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(path.dirname(full), 'manual-checklist.md'),
    manualChecklist(),
    { mode: 0o600 },
  );
  return { rows, captures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      usage();
      process.exit(0);
    }
    const result = generateReports(args);
    process.stdout.write(
      `Generated ${result.rows.length} evidence rows in full and redacted reports.\n`,
    );
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    usage();
    process.exit(2);
  }
}
