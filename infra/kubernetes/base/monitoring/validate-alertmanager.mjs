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

const here = dirname(fileURLToPath(import.meta.url));
const amtool = process.env.AMTOOL_BIN || 'amtool';
const secretFixtureDir = resolve(here, 'proof', 'secrets').replaceAll('\\', '/');
const source = readFileSync(join(here, 'alertmanager.yaml.example'), 'utf8');
const rendered = source.replaceAll(
  '/etc/alertmanager/secrets/alertmanager-secrets',
  secretFixtureDir,
);
const values = readFileSync(
  join(here, 'kube-prometheus-values.yaml'),
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

try {
  requireSnippets(values, 'kube-prometheus-values.yaml', [
    'Chart: prometheus-community/kube-prometheus-stack v65.2.0',
    'useExistingSecret: true',
    'configSecret: alertmanager-secrets',
    'secrets:\n      - alertmanager-secrets',
    'serviceDiscoveryRole: EndpointSlice',
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

function run(args) {
  try {
    return execFileSync(amtool, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    process.stdout.write(error.stdout || '');
    process.stderr.write(error.stderr || error.message);
    process.exit(1);
  }
}

function requireSnippets(content, file, snippets) {
  for (const snippet of snippets) {
    if (!content.includes(snippet)) {
      throw new Error(`${file} is missing required contract: ${snippet}`);
    }
  }
  console.log(`✓ ${file}: C1.3 wiring contract`);
}
