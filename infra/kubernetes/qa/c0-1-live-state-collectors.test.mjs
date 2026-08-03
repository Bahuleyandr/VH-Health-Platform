import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  STATES,
  generateReports,
  parseCapture,
  redactText,
  sanitizeSecretValues,
} from './c0-1-live-state-report.mjs';
import { stagesForChangedFiles } from '../../../scripts/ci/stage-selection.mjs';

const qaDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(qaDir, '..', '..', '..');
const collector = path.join(qaDir, 'c0-1-live-state-evidence.sh');
const reporter = path.join(qaDir, 'c0-1-live-state-report.mjs');
const c12Collector = path.join(qaDir, 'c1-2-ha-evidence.sh');
const fixture = path.join(qaDir, 'fixtures', 'c0-1-live-state');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function bashPath(file) {
  return file.replaceAll('\\', '/');
}

function captureText(command, output, status) {
  return [
    'captured_at=2026-07-31T00:00:00Z',
    `command=${command}`,
    '---',
    output,
    '---',
    `exit_status=${status}`,
    '',
  ].join('\n');
}

function writeSyntheticEvidence(input, entries) {
  const capturesDirectory = path.join(input, 'captures');
  fs.mkdirSync(capturesDirectory, { recursive: true });
  const indexRows = [
    'id\tsection\tlabel\tfile\texit_status\tcommand',
  ];
  for (const entry of entries) {
    const relativeFile = `captures/${entry.id}.txt`;
    fs.writeFileSync(
      path.join(input, ...relativeFile.split('/')),
      captureText(entry.command, entry.output, entry.status),
    );
    indexRows.push(
      [
        entry.id,
        entry.section,
        entry.label,
        relativeFile,
        entry.status,
        entry.command,
      ].join('\t'),
    );
  }
  fs.writeFileSync(path.join(input, 'index.tsv'), `${indexRows.join('\n')}\n`);
}

function verifySha256ManifestRow(line, outputDirectory) {
  const match = line.match(/^([0-9a-f]{64}) [ *]\.\/(.+)$/);
  assert.ok(match, `malformed SHA256SUMS row: ${line}`);
  const actual = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(outputDirectory, match[2])))
    .digest('hex');
  assert.equal(actual, match[1], `${match[2]} changed after checksumming`);
  return match;
}

test('capture parser preserves output and exit status', () => {
  const lf = [
    'captured_at=2026-07-30T00:00:00Z',
    'command= example',
    '---',
    'first',
    'second',
    '---',
    'exit_status=78',
    '',
  ].join('\n');

  for (const content of [lf, lf.replace(/\n/g, '\r\n')]) {
    assert.deepEqual(
      parseCapture(content),
      { output: 'first\nsecond', status: 78 },
    );
  }
});

test('redactor uses stable aliases and never preserves sensitive named values', () => {
  const source =
    'node=cp-hospital-01 primary=10.10.0.11 peer=10.10.0.11 token=do-not-keep Authorization: Bearer do-not-keep';
  const redacted = redactText(source);
  assert.doesNotMatch(redacted, /10\.10\.0\.11|cp-hospital-01|do-not-keep/);
  const aliases = redacted.match(/ipv4-[0-9a-f]{10}/g);
  assert.equal(aliases.length, 2);
  assert.equal(aliases[0], aliases[1]);
  assert.match(redacted, /node-[0-9a-f]{10}/);
  assert.match(redacted, /token=\[REDACTED\]/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.equal(redactText('observed=2026-07-30T00:10:00.000Z'), 'observed=2026-07-30T00:10:00.000Z');
  assert.match(redactText('host=2001:db8:0:1:2:3:4:5'), /ipv6-[0-9a-f]{10}/);
  assert.match(redactText('host=2001:db8::5'), /ipv6-[0-9a-f]{10}/);

  assert.equal(
    sanitizeSecretValues('client_secret=abc123'),
    'client_secret=[REDACTED]',
  );
});

test('rehearsal regressions preserve absence, partial failure, and arbitrary node redaction', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-c0-1-rehearsal-'));
  const input = path.join(temp, 'input');
  const full = path.join(temp, 'full.md');
  const redacted = path.join(temp, 'redacted.md');
  fs.mkdirSync(input, { recursive: true });
  writeSyntheticEvidence(input, [
    {
      id: 'rke2_nodes',
      section: 'Kubernetes, database, and storage',
      label: 'Node versions',
      command: 'kubectl get nodes -o custom-columns=...',
      output:
        'NODE             KUBELET\norchard-ubuntu   v1.34.6+k3s1',
      status: 0,
    },
    {
      id: 'ingress_controllers',
      section: 'Ingress, edge, DNS, and certificates',
      label: 'Ingress controllers',
      command: 'kubectl get deployments -o custom-columns=...',
      output: 'KIND   NAME   IMAGE   DESIRED   READY   AVAILABLE',
      status: 0,
    },
    {
      id: 'cloudflared',
      section: 'Ingress, edge, DNS, and certificates',
      label: 'cloudflared',
      command: 'kubectl get pods -o custom-columns=...',
      output: 'POD   NODE   IMAGE   READY   RESTARTS   PHASE',
      status: 0,
    },
    {
      id: 'backup_jobs_schedules',
      section: 'Backups and restore',
      label: 'Backup schedules',
      command: 'kubectl get cronjobs -o custom-columns=...',
      output: 'Error from server (NotFound): cronjobs.batch not found',
      status: 1,
    },
    {
      id: 'backup_jobs_producer',
      section: 'Backups and restore',
      label: 'Producer Jobs',
      command: 'kubectl get jobs -o custom-columns=...',
      output: 'NAME   START   COMPLETION   SUCCEEDED   FAILED',
      status: 0,
    },
    {
      id: 'backup_jobs_verifier',
      section: 'Backups and restore',
      label: 'Verifier Jobs',
      command: 'kubectl get jobs -o custom-columns=...',
      output: 'NAME   START   COMPLETION   SUCCEEDED   FAILED',
      status: 0,
    },
  ]);

  const c12Directory = path.join(
    input,
    'raw',
    'c1-2',
    'c1-2-ha-evidence-fixture',
  );
  fs.mkdirSync(c12Directory, { recursive: true });
  fs.writeFileSync(
    path.join(c12Directory, '10-pod-placement.txt'),
    captureText(
      'kubectl get pods -A -o wide',
      // Real kubectl padding, a RESTARTS cell with an embedded space, and the
      // two-word NOMINATED NODE / READINESS GATES headers: the shapes that make
      // token-indexed column parsing read AGE as if it were the node name.
      [
        'NAMESPACE   NAME        READY   STATUS    RESTARTS       AGE    IP          NODE             NOMINATED NODE   READINESS GATES',
        'vhhealth    backend-1   1/1     Running   35 (21d ago)   100d   192.0.2.1   orchard-ubuntu   <none>           <none>',
      ].join('\n'),
      0,
    ),
  );
  fs.writeFileSync(
    path.join(c12Directory, '17-helm-releases.txt'),
    captureText(
      'helm list -A',
      'NAME   NAMESPACE   STATUS\ningress-nginx   ingress-nginx   deployed',
      0,
    ),
  );
  fs.writeFileSync(
    path.join(c12Directory, '18-longhorn-state.txt'),
    captureText('kubectl get namespace longhorn-system', 'longhorn_installed=false', 0),
  );

  const result = generateReports({
    input,
    full,
    redacted,
    repoRoot,
    generatedAt: '2026-07-31T00:10:00.000Z',
    repositorySha: '48509b1a8e5ff011905c01ef7370a85bf2fa7a0d',
  });
  const stateFor = (fact) =>
    result.rows.find((candidate) => candidate.fact === fact)?.state;

  assert.equal(
    stateFor('Ingress controller workloads actually running'),
    'absent',
  );
  assert.equal(stateFor('Cloudflare tunnel workload state'), 'absent');
  assert.equal(
    stateFor('Application archive/verification CronJobs and latest Jobs'),
    'unknown',
  );
  assert.equal(
    stateFor('Longhorn presence, target version, and health'),
    'absent',
  );

  const backupRow = result.rows.find(
    ({ fact }) =>
      fact === 'Application archive/verification CronJobs and latest Jobs',
  );
  assert.match(backupRow.live, /backup_jobs_schedules: unavailable \(exit 1\)/);
  assert.match(backupRow.live, /backup_jobs_producer: no rows returned/);

  const fullText = read(full);
  const redactedText = read(redacted);
  const expectedNodeAlias = `node-${crypto
    .createHash('sha256')
    .update('orchard-ubuntu')
    .digest('hex')
    .slice(0, 10)}`;
  assert.match(fullText, /orchard-ubuntu/);
  assert.doesNotMatch(redactedText, /orchard-ubuntu/);
  assert.match(redactedText, new RegExp(expectedNodeAlias));

  // One node in, one alias out. Aliasing a non-hostname cell would invent
  // extra nodes in the pod-placement evidence and destroy the pod ages that
  // the C1.2 placement claim is read against.
  assert.deepEqual(
    [...new Set(redactedText.match(/node-[0-9a-f]{10}/g) ?? [])],
    [expectedNodeAlias],
  );
  assert.match(redactedText, /35 \(21d ago\)\s+100d/);
});

test('fixture emission produces both reports and all four evidence states', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-c0-1-report-'));
  const full = path.join(temp, 'full.md');
  const redacted = path.join(temp, 'redacted.md');
  const result = generateReports({
    input: fixture,
    full,
    redacted,
    repoRoot,
    generatedAt: '2026-07-30T00:10:00.000Z',
    repositorySha: 'dfac4c7202f49037f3407a705064be3c1945b3f0',
  });

  assert.deepEqual(
    new Set(result.rows.map(({ state }) => state)),
    new Set(STATES),
  );
  assert.equal(
    result.rows.find(
      ({ fact }) => fact === 'Cloudflare control-plane tunnel status',
    ).state,
    'unknown',
  );
  assert.equal(
    result.rows.find(
      ({ fact }) =>
        fact === 'Application archive/verification CronJobs and latest Jobs',
    ).state,
    'absent',
  );
  assert.equal(
    result.rows.find(
      ({ fact }) => fact === 'Repository application digest pins',
    ).state,
    'repository target',
  );
  assert.equal(
    result.rows.find(
      ({ fact }) =>
        fact === 'Running workload image references and image IDs',
    ).state,
    'live verified',
  );
  assert.ok(result.rows.length >= 40);
  assert.ok(fs.existsSync(path.join(temp, 'manual-checklist.md')));

  const fullText = read(full);
  const redactedText = read(redacted);
  for (const section of [
    'Release and images',
    'Kubernetes, database, and storage',
    'Ingress, edge, DNS, and certificates',
    'Control plane and etcd',
    'Monitoring and alerting',
    'Backups and restore',
    'Time and clock trust',
    'Manual operator attestations',
  ]) {
    assert.match(fullText, new RegExp(`## ${section}`));
  }
  for (const state of STATES) {
    assert.match(fullText, new RegExp(`\\*\\*${state}\\*\\*`));
  }
  assert.match(fullText, /203\.0\.113\.41/);
  assert.doesNotMatch(redactedText, /203\.0\.113\.41|10\.10\.0\.31/);
  assert.match(redactedText, /ipv4-[0-9a-f]{10}/);
  assert.match(redactedText, /## Command ledger/);
});

test('fixture mode runs without kubectl and writes separate full/redacted packs', () => {
  const temp = fs.mkdtempSync(
    path.join(path.dirname(repoRoot), 'vh-c0-1-collector-'),
  );
  const result = spawnSync(
    'bash',
    [
      bashPath(path.relative(repoRoot, collector)),
      bashPath(path.relative(repoRoot, temp)),
      '--fixture',
      bashPath(path.relative(repoRoot, fixture)),
    ],
    {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: process.env.PATH,
    },
    },
  );
  assert.equal(
    result.status,
    0,
    `fixture collector failed:\n${result.stdout}\n${result.stderr}`,
  );

  const outputDirectory = fs
    .readdirSync(temp, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(temp, entry.name))
    .at(0);
  assert.ok(outputDirectory);
  for (const name of [
    'full-report.md',
    'redacted-summary.md',
    'manual-checklist.md',
    'index.tsv',
    'commands.log',
    'SHA256SUMS',
  ]) {
    assert.ok(fs.existsSync(path.join(outputDirectory, name)), `${name} missing`);
  }
  const manifestRows = read(path.join(outputDirectory, 'SHA256SUMS'))
    .trim()
    .split(/\r?\n/);
  for (const line of manifestRows) {
    assert.match(
      line,
      /^[0-9a-f]{64}  \.\//,
      `generated SHA256SUMS row is not text mode: ${line}`,
    );
    verifySha256ManifestRow(line, outputDirectory);
  }

  const [, firstHash, firstPath] = verifySha256ManifestRow(
    manifestRows[0],
    outputDirectory,
  );
  for (const separator of [' ', '*']) {
    verifySha256ManifestRow(
      `${firstHash} ${separator}./${firstPath}`,
      outputDirectory,
    );
  }
  assert.doesNotMatch(
    read(path.join(outputDirectory, 'redacted-summary.md')),
    /203\.0\.113\.41/,
  );
  assert.match(read(path.join(outputDirectory, 'commands.log')), /live_commands=0/);
});

test('collectors are syntactically valid and C0.1 calls the C1.2 prior art', () => {
  for (const script of [collector, c12Collector]) {
    const result = spawnSync(
      'bash',
      ['-n', bashPath(path.relative(repoRoot, script))],
      {
      cwd: repoRoot,
      encoding: 'utf8',
      },
    );
    assert.equal(
      result.status,
      0,
      `${path.basename(script)} failed bash -n:\n${result.stderr}`,
    );
  }

  const source = read(collector);
  assert.match(source, /c1-2-ha-evidence\.sh/);
  assert.match(source, /sha256sum --text -- "\$\{evidence_file\}"/);
  assert.match(source, /ABSOLUTE SAFETY RULES/);
  assert.match(source, /assert_safe_command/);
  assert.match(source, /cloudflare_tunnel_api_probe/);
  assert.doesNotMatch(source, /set -x/);
  assert.match(read(reporter), /NO LIVE COMMAND EXECUTION/);
});

test('read-only guard allows the argocd namespace but rejects the argocd control tool', () => {
  const source = read(collector);
  const safetyFunctions = source.slice(
    source.indexOf('shell_quote_command() {'),
    source.indexOf('\ncapture() {'),
  );
  const temp = fs.mkdtempSync(
    path.join(path.dirname(repoRoot), 'vh-c0-1-safety-'),
  );
  const harness = path.join(temp, 'guard-harness.sh');
  fs.writeFileSync(
    harness,
    `${safetyFunctions}\nassert_safe_command "$@"\n`,
  );
  const allowed = spawnSync(
    'bash',
    [
      bashPath(path.relative(repoRoot, harness)),
      'kubectl',
      '-n',
      'argocd',
      'get',
      'applications.argoproj.io',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(
    allowed.status,
    0,
    `argocd namespace was rejected:\n${allowed.stdout}\n${allowed.stderr}`,
  );

  const rejected = spawnSync(
    'bash',
    [
      bashPath(path.relative(repoRoot, harness)),
      'argocd',
      'app',
      'get',
      'vhhealth',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(rejected.status, 97);
  assert.match(rejected.stderr, /SAFETY REFUSAL/);
});

test('grep-style safety check forbids secret-value reads in every evidence collector', () => {
  const collectors = fs
    .readdirSync(qaDir)
    .filter((name) => /evidence\.sh$/.test(name))
    .map((name) => ({ name, source: read(path.join(qaDir, name)) }));

  for (const { name, source } of collectors) {
    const executableLines = source
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    assert.doesNotMatch(
      executableLines,
      /kubectl[^\n]*\bget\s+secrets?\b[^\n]*(?:-o|--output)(?:=|\s+)(?:yaml|json|jsonpath|go-template|template|custom-columns)/i,
      `${name} may read Secret values`,
    );
    assert.doesNotMatch(
      executableLines,
      /kubectl[^\n]*\bget\s+secrets?\b[^\n]*\.(?:data|stringData)\b/i,
      `${name} may select Secret data`,
    );
  }
});

test('database probe is fixed to PHI-free metadata sources', () => {
  const source = read(collector);
  const sql = source.slice(
    source.indexOf("cat <<'SQL'"),
    source.indexOf('\nSQL\n', source.indexOf("cat <<'SQL'")),
  );
  assert.match(sql, /SELECT version\(\)/);
  assert.match(sql, /pg_extension/);
  assert.match(sql, /pg_available_extensions/);
  assert.match(sql, /pg_stat_replication/);
  assert.match(sql, /_prisma_migrations/);
  assert.match(sql, /pg_class/);
  assert.doesNotMatch(
    sql,
    /\b(?:patients|appointments|encounters|admissions|clinical_timeline_events|prescriptions|patient_vitals)\b/i,
  );
});

test('collector and runbook paths stay within the existing security+infra CI scope', () => {
  const stageOrder = ['security', 'backend', 'fhir', 'admin', 'flutter', 'infra'];
  assert.deepEqual(
    stagesForChangedFiles(
      [
        'infra/kubernetes/qa/c0-1-live-state-evidence.sh',
        'infra/kubernetes/qa/c0-1-live-state-report.mjs',
        'infra/kubernetes/qa/c0-1-live-state-collectors.test.mjs',
        'docs/continuity/c0-1-live-state-runbook.md',
      ],
      stageOrder,
    ),
    ['security', 'infra'],
  );
});
