import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const here = dirname(modulePath);
const amtool = process.env.AMTOOL_BIN || 'amtool';
const secretFixtureDir = resolve(here, 'proof', 'secrets').replaceAll('\\', '/');

const routeCases = [
  {
    labels: ['alertname=Watchdog', 'severity=none', 'team=platform'],
    receivers: ['deadman-external'],
  },
  {
    labels: [
      'alertname=NodeDown',
      'severity=critical',
      'team=platform',
      'namespace=vhhealth-monitoring',
    ],
    receivers: ['ops-webhook', 'critical-pagerduty', 'team-platform'],
  },
  {
    labels: ['alertname=PostgresReplicationLagHigh', 'severity=warning', 'team=database'],
    receivers: ['ops-webhook', 'team-database'],
  },
  {
    labels: ['alertname=CnpgBackupVerifyStale', 'severity=critical', 'team=backup'],
    receivers: ['ops-webhook', 'critical-pagerduty', 'team-backup'],
  },
  {
    labels: ['alertname=BackendDown', 'severity=critical', 'team=backend'],
    receivers: ['ops-webhook', 'critical-pagerduty', 'team-backend'],
  },
  {
    labels: [
      'alertname=BackendMigrationJobFailed',
      'severity=critical',
      'team=backend',
      'namespace=vhhealth',
    ],
    receivers: ['ops-webhook', 'critical-pagerduty', 'team-backend'],
  },
  {
    labels: ['alertname=ContinuityPackExpired', 'severity=critical', 'team=continuity'],
    receivers: ['ops-webhook', 'critical-pagerduty', 'team-continuity'],
  },
  {
    labels: ['alertname=DeviceGatewaySpoolDepthHigh', 'severity=warning', 'team=device'],
    receivers: ['ops-webhook', 'team-device'],
  },
  {
    labels: ['alertname=UnclassifiedInfo', 'severity=info'],
    receivers: ['unmatched-alerts'],
  },
];

export function assertRouteCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('Alertmanager route validation requires at least one case');
  }

  for (const [index, routeCase] of cases.entries()) {
    if (!Array.isArray(routeCase.labels) || routeCase.labels.length === 0) {
      throw new Error(`Alertmanager route case ${index + 1} has an empty label match`);
    }
    if (!Array.isArray(routeCase.receivers) || routeCase.receivers.length === 0) {
      throw new Error(`Alertmanager route case ${index + 1} has no expected receivers`);
    }
  }

  const migrationCase = cases.find((routeCase) =>
    routeCase.labels.includes('alertname=BackendMigrationJobFailed'),
  );
  if (!migrationCase) {
    throw new Error('BackendMigrationJobFailed route case is required');
  }

  for (const label of ['severity=critical', 'team=backend']) {
    if (!migrationCase.labels.includes(label)) {
      throw new Error(`BackendMigrationJobFailed route case is missing ${label}`);
    }
  }

  const expectedReceivers = ['ops-webhook', 'critical-pagerduty', 'team-backend'];
  if (
    migrationCase.receivers.length !== expectedReceivers.length ||
    expectedReceivers.some((receiver) => !migrationCase.receivers.includes(receiver))
  ) {
    throw new Error(
      `BackendMigrationJobFailed must route to ${expectedReceivers.join(', ')}`,
    );
  }
}

export function validateAlertmanager() {
  const source = readFileSync(
    process.env.ALERTMANAGER_CONFIG_SOURCE || join(here, 'alertmanager.yaml.example'),
    'utf8',
  );
  const rendered = source.replaceAll(
    '/etc/alertmanager/secrets/alertmanager-secrets',
    secretFixtureDir,
  );
  const values = readFileSync(
    join(here, 'kube-prometheus-values.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const chartTracker = readFileSync(
    join(here, 'chart-tracker.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const sealedSecretExample = readFileSync(
    join(here, 'alertmanager-secrets.sealed-secret.yaml.example'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const kustomization = readFileSync(
    join(here, 'kustomization.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const edgeServiceMonitor = readFileSync(
    join(here, 'continuity-edge-service-monitor.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const tempDir = mkdtempSync(join(tmpdir(), 'vhhealth-alertmanager-'));
  const configPath = join(tempDir, 'alertmanager.yaml');

  assertRouteCases(routeCases);

  try {
    requireSnippets(values, 'kube-prometheus-values.yaml', [
      'Chart: prometheus-community/kube-prometheus-stack v65.2.0',
      'useExistingSecret: true',
      'configSecret: alertmanager-secrets',
      'secrets:\n      - alertmanager-secrets',
      'serviceDiscoveryRole: EndpointSlice',
    ]);
    requireSnippets(chartTracker, 'chart-tracker.yaml', [
      'prometheusVersion: "v2.55.0"',
      'alertmanagerVersion: "v0.27.0"',
    ]);
    requireSnippets(
      sealedSecretExample,
      'alertmanager-secrets.sealed-secret.yaml.example',
      [
        'alertmanager.yaml: PLACEHOLDER_REPLACE_WITH_KUBESEAL_CIPHERTEXT',
        'discord-watchdog-url: PLACEHOLDER_REPLACE_WITH_KUBESEAL_CIPHERTEXT',
      ],
    );
    requireSnippets(kustomization, 'kustomization.yaml', [
      '  - continuity-edge-alerts.yaml\n  - continuity-edge-service-monitor.yaml',
    ]);
    requireSnippets(
      edgeServiceMonitor,
      'continuity-edge-service-monitor.yaml',
      [
        'namespace: vhhealth-monitoring',
        'app.kubernetes.io/name: vhhealth-continuity-edge',
      ],
    );

    writeFileSync(configPath, rendered, 'utf8');
    run(['check-config', configPath]);
    console.log('✓ amtool check-config: alertmanager.yaml.example');

    for (const routeCase of routeCases) {
      run([
        'config',
        'routes',
        'test',
        `--config.file=${configPath}`,
        `--verify.receivers=${routeCase.receivers.join(',')}`,
        ...routeCase.labels,
      ]);
      console.log(
        `✓ ${routeCase.labels.join(' ')} -> ${routeCase.receivers.join(', ')}`,
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function run(args) {
  return execFileSync(amtool, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function requireSnippets(content, file, snippets) {
  for (const snippet of snippets) {
    if (!content.includes(snippet)) {
      throw new Error(`${file} is missing required contract: ${snippet}`);
    }
  }
  console.log(`✓ ${file}: C1.3 wiring contract`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  try {
    validateAlertmanager();
  } catch (error) {
    process.stdout.write(error.stdout || '');
    process.stderr.write(error.stderr || error.message);
    process.exitCode = 1;
  }
}
