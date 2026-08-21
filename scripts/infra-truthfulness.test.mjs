import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { validateBootstrap } from './validate-sealed-secrets-bootstrap.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = relative => readFileSync(path.join(repoRoot, relative), 'utf8');
const bashPath = value => {
  const normalized = value.replaceAll('\\', '/');
  if (process.platform !== 'win32') return normalized;
  const match = normalized.match(/^([A-Za-z]):(\/.*)$/);
  return match ? `/mnt/${match[1].toLowerCase()}${match[2]}` : normalized;
};
const spawnBash = (args, options) => process.platform === 'win32'
  ? spawnSync('wsl.exe', ['-e', 'bash', ...args], options)
  : spawnSync('bash', args, options);
const commandWorks = (command, args) => spawnSync(command, args, {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: 'pipe',
}).status === 0;
const findKustomize = () => {
  const candidates = [
    process.env.KUSTOMIZE_BIN,
    process.platform === 'win32' ? 'D:\\Dev\\Tools\\kubetools\\kustomize.exe' : null,
    'kustomize',
  ].filter(Boolean);
  return candidates.find(candidate => commandWorks(candidate, ['version']));
};
const renderBootstrap = () => {
  const kustomize = findKustomize();
  assert.ok(kustomize, 'kustomize is required for the Sealed Secrets bootstrap contract');
  const result = spawnSync(kustomize, [
    'build',
    path.join(repoRoot, 'infra', 'kubernetes', 'base', 'sealed-secrets'),
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
const mutateResource = (rendered, kind, mutate) => {
  let matches = 0;
  const mutated = rendered
    .split(/^---\s*$/m)
    .map(document => {
      if (!new RegExp(`^kind:\\s*${kind}\\s*$`, 'm').test(document)) return document;
      matches += 1;
      return mutate(document);
    })
    .join('\n---\n');
  assert.equal(matches, 1, `expected exactly one ${kind} fixture document`);
  return mutated;
};

test('inactive Admin metrics and duplicate Argo source are absent', () => {
  const adminKustomization = readRepo('infra/kubernetes/apps/admin/kustomization.yaml');
  assert.doesNotMatch(adminKustomization, /service-monitor\.yaml/);

  const monitoring = readRepo('infra/kubernetes/base/argocd/applications/monitoring.yaml');
  const documents = monitoring.split(/^---\s*$/m).filter(document => /kind:\s*Application/.test(document));
  for (const document of documents) {
    assert.doesNotMatch(document, /^\s{2}source:\s*$/m);
    assert.match(document, /^\s{2}sources:\s*$/m);
  }
});

test('Sealed Secrets bootstrap render is self-contained and rejects identity drift', () => {
  const sealedKustomization = readRepo('infra/kubernetes/base/sealed-secrets/kustomization.yaml');
  const monitoringKustomization = readRepo('infra/kubernetes/base/monitoring/kustomization.yaml');
  const commonNamespaces = readRepo('infra/kubernetes/base/_common/namespaces.yaml');
  const controller = readRepo('infra/kubernetes/base/sealed-secrets/sealed-secrets.yaml');

  assert.match(sealedKustomization, /^\s*- namespace\.yaml\s*$/m);
  assert.match(sealedKustomization, /^\s*- crd\.yaml\s*$/m);
  assert.match(sealedKustomization, /^\s*- sealed-secrets\.yaml\s*$/m);
  assert.doesNotMatch(sealedKustomization, /service-monitor/i);
  assert.match(monitoringKustomization, /^\s*- sealed-secrets-service-monitor\.yaml\s*$/m);
  assert.doesNotMatch(commonNamespaces, /^\s{2}name:\s*vhhealth-security\s*$/m);
  assert.doesNotMatch(controller, /^kind:\s*ServiceMonitor\s*$/m);

  const rendered = renderBootstrap();
  assert.doesNotThrow(() => validateBootstrap(rendered));

  const cases = [
    {
      label: 'controller name',
      rendered: mutateResource(rendered, 'Deployment', document =>
        document.replace(/^  name:\s*sealed-secrets\s*$/m, '  name: wrong-controller')),
      pattern: /expected exactly one Deployment\/vhhealth-security\/sealed-secrets/,
    },
    {
      label: 'controller namespace',
      rendered: mutateResource(rendered, 'Deployment', document =>
        document.replace(/^  namespace:\s*vhhealth-security\s*$/m, '  namespace: wrong-namespace')),
      pattern: /expected exactly one Deployment\/vhhealth-security\/sealed-secrets/,
    },
    {
      label: 'deployment service account',
      rendered: mutateResource(rendered, 'Deployment', document =>
        document.replace(/serviceAccountName:\s*sealed-secrets/, 'serviceAccountName: wrong-account')),
      pattern: /Deployment must use ServiceAccount sealed-secrets/,
    },
    {
      label: 'unsupported controller flag',
      rendered: mutateResource(rendered, 'Deployment', document =>
        document.replace('--listen-addr=:8080', '--listen-address=:8080')),
      pattern: /controller args must include --listen-addr=:8080/,
    },
    {
      label: 'binding subject',
      rendered: mutateResource(rendered, 'ClusterRoleBinding', document =>
        document.replace(/namespace:\s*vhhealth-security/, 'namespace: wrong-namespace')),
      pattern: /must bind only vhhealth-security\/sealed-secrets/,
    },
    {
      label: 'monitoring CR',
      rendered: `${rendered}\n---\napiVersion: monitoring.coreos.com/v1\nkind: ServiceMonitor\nmetadata:\n  name: sealed-secrets\n  namespace: vhhealth-security\n`,
      pattern: /monitoring CRs must be installed by the monitoring Kustomization/,
    },
  ];

  for (const candidate of cases) {
    assert.throws(
      () => validateBootstrap(candidate.rendered),
      candidate.pattern,
      `${candidate.label} drift must fail closed`,
    );
  }
});

test('Sealed Secrets bootstrap helper validates the exact bytes before kubectl', t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'vhhealth-sealed-bootstrap-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const calls = path.join(temp, 'calls.log');
  const fixture = path.join(temp, 'bootstrap.yaml');
  const fakeKustomize = path.join(temp, 'kustomize');
  const fakeKubectl = path.join(temp, 'kubectl');
  const executable = { mode: 0o755 };

  writeFileSync(fixture, renderBootstrap());
  writeFileSync(
    fakeKustomize,
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "kustomize:$*" >> "${bashPath(calls)}"\ncat "${bashPath(fixture)}"\n`,
    executable,
  );
  writeFileSync(
    fakeKubectl,
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "kubectl:$*" >> "${bashPath(calls)}"\n`,
    executable,
  );
  chmodSync(fakeKustomize, 0o755);
  chmodSync(fakeKubectl, 0o755);

  const helper = path.join(repoRoot, 'scripts/bootstrap-sealed-secrets.sh');
  const invoke = mode => spawnBash([
    '-c',
    'KUSTOMIZE_BIN="$1" KUBECTL_BIN="$2" "$3" "$4"',
    'vhhealth-sealed-bootstrap-test',
    bashPath(fakeKustomize),
    bashPath(fakeKubectl),
    bashPath(helper),
    mode,
  ], { encoding: 'utf8', env: process.env });

  const checked = invoke('--check');
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const applied = invoke('--apply');
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);

  const commandLog = readFileSync(calls, 'utf8');
  assert.match(commandLog, /kustomize:build .*infra\/kubernetes\/base\/sealed-secrets/);
  assert.match(commandLog, /kubectl:apply --dry-run=client -f /);
  assert.match(commandLog, /kubectl:apply -f /);
  assert.match(commandLog, /kubectl:-n vhhealth-security rollout status deployment\/sealed-secrets --timeout=180s/);

  const kubectlCallsBeforeDrift = (commandLog.match(/^kubectl:/gm) ?? []).length;
  writeFileSync(
    fixture,
    mutateResource(renderBootstrap(), 'Deployment', document =>
      document.replace(/serviceAccountName:\s*sealed-secrets/, 'serviceAccountName: wrong-account')),
  );
  const rejected = invoke('--check');
  assert.notEqual(rejected.status, 0, rejected.stderr || rejected.stdout);
  assert.match(rejected.stderr, /Deployment must use ServiceAccount sealed-secrets/);
  const afterDrift = readFileSync(calls, 'utf8');
  assert.equal(
    (afterDrift.match(/^kubectl:/gm) ?? []).length,
    kubectlCallsBeforeDrift,
    'kubectl must not run after validator rejection',
  );
});

test('Sealed Secrets documentation matches the committed controller', () => {
  const sealedReadme = readRepo('infra/kubernetes/base/sealed-secrets/README.md');
  const deploymentGuide = readRepo('docs/DEPLOYMENT_GUIDE.md');
  const argoReadme = readRepo('infra/kubernetes/base/argocd/README.md');

  for (const document of [sealedReadme, deploymentGuide]) {
    assert.match(document, /--controller-namespace vhhealth-security/);
    assert.match(document, /--controller-name sealed-secrets/);
    assert.doesNotMatch(document, /--controller-namespace sealed-secrets(?:\s|\\)/);
    assert.doesNotMatch(document, /--controller-name sealed-secrets-controller/);
  }
  assert.match(deploymentGuide, /^\| `vhhealth-security`\s*\|/m);
  assert.match(deploymentGuide, /^\| `vhhealth-monitoring`\s*\|/m);
  assert.doesNotMatch(deploymentGuide, /^\| `sealed-secrets`\s*\|/m);
  assert.doesNotMatch(deploymentGuide, /^\| `monitoring`\s*\|/m);
  assert.doesNotMatch(deploymentGuide, /monitoring\/grafana/);
  assert.match(deploymentGuide, /16 vCPU \/ 64 GB ECC \/ 2× 2 TB NVMe RAID1/);
  assert.doesNotMatch(argoReadme, /kubectl apply -f infra\/kubernetes\/base\/sealed-secrets\//);
  assert.match(argoReadme, /bootstrap-sealed-secrets\.sh --apply/);
});

test('fresh-cluster proof is required in GitHub CI and static proof remains canonical', () => {
  const smoke = readRepo('scripts/sealed-secrets-bootstrap-smoke.mjs');
  const infraStage = readRepo('scripts/ci/infra.mjs');
  const workflow = readRepo('.github/workflows/_reusable-kubernetes-manifests.yml');

  assert.ok(
    smoke.indexOf('validateBootstrap(rendered)') < smoke.indexOf('const kind = firstAvailable'),
    'mandatory static validation must run before runtime availability is considered',
  );
  assert.match(infraStage, /sealed-secrets-bootstrap-smoke\.mjs', '--auto/);
  assert.match(workflow, /kind-linux-amd64/);
  assert.match(workflow, /sealed-secrets-bootstrap-smoke\.mjs --require-cluster/);
});

test('held device-gateway tree is wired to the real backend Service and validated by CI', () => {
  const backendService = readRepo('infra/kubernetes/apps/backend/service.yaml');
  const backendPolicy = readRepo('infra/kubernetes/apps/backend/network-policy.yaml');
  const gatewayDeployment = readRepo('infra/kubernetes/base/device-gateway/deployment.yaml');
  const gatewayPolicy = readRepo('infra/kubernetes/base/device-gateway/networkpolicy.yaml');
  const validator = readRepo('scripts/validate-kubernetes-manifests.mjs');

  // The Service the gateway must call: vhhealth-backend, port 80 → pod port
  // http (5000). If the Service ever changes, these anchors fail with it.
  assert.match(backendService, /^  name:\s*vhhealth-backend\s*$/m);
  assert.match(backendService, /port:\s*80\s*\n\s+targetPort:\s*http/);

  // (a) BACKEND_BASE_URL names that Service (not the pre-monorepo
  // backend:3000 that never existed in this cluster).
  assert.match(
    gatewayDeployment,
    /name:\s*BACKEND_BASE_URL\s*\n(?:\s*#.*\n)*\s+value:\s*http:\/\/vhhealth-backend\.vhhealth\.svc\.cluster\.local\s*$/m,
  );
  assert.doesNotMatch(gatewayDeployment, /backend\.vhhealth\.svc\.cluster\.local:3000/);

  // (b) Egress selects the real backend pod label on the pod port (policies
  // are evaluated after Service DNAT), and the metrics ingress uses the
  // immutable namespace label like every sibling policy.
  assert.match(gatewayPolicy, /app\.kubernetes\.io\/name:\s*vhhealth-backend/);
  assert.match(gatewayPolicy, /port:\s*5000/);
  assert.doesNotMatch(gatewayPolicy, /app\.kubernetes\.io\/name:\s*backend\s*$/m);
  assert.doesNotMatch(gatewayPolicy, /port:\s*3000/);
  assert.match(gatewayPolicy, /kubernetes\.io\/metadata\.name:\s*vhhealth-monitoring/);
  assert.doesNotMatch(gatewayPolicy, /^\s+name:\s*vhhealth-monitoring\s*$/m);

  // (c) The backend's default-deny ingress admits device-gateway pods on 5000.
  const deviceGatewayRule = backendPolicy.match(
    /app\.kubernetes\.io\/name:\s*device-gateway[\s\S]*?port:\s*(\d+)/,
  );
  assert.ok(deviceGatewayRule, 'backend NetworkPolicy must admit device-gateway ingress');
  assert.equal(deviceGatewayRule[1], '5000');
  assert.ok(
    backendPolicy.indexOf('app.kubernetes.io/name: device-gateway') <
      backendPolicy.indexOf('egress:'),
    'device-gateway must be admitted in the ingress section',
  );

  // The held tree is a validated kustomize root, closing the rot vector.
  assert.match(validator, /^\s*'infra\/kubernetes\/base\/device-gateway',\s*$/m);
});

test('Dalek deploy workflow is strict and verifies the deployed commit', () => {
  const workflow = readRepo('.forgejo/release-authority-templates/release-authority-dalekdefender.yml');
  const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));

  assert.doesNotMatch(deployJob, /--allow-skip/);
  assert.doesNotMatch(deployJob, /Skipping deploy/);
  assert.match(deployJob, /Pin deployments to verified digests/);

  const helper = readRepo('infra/kubernetes/overlays/dalekdefender/vhhealth-gha-deploy.sh');
  assert.match(helper, /verify_backend_version/);
  assert.match(helper, /\/health\/version/);
  assert.match(helper, /deployed commit .* does not match requested commit/);
});

test('MinIO capacity and failure claims match the rendered single-pool topology', () => {
  const tenant = readRepo('infra/kubernetes/base/minio/tenant.yaml');
  const hardware = readRepo('docs/HARDWARE_REQUIREMENTS.md');

  assert.match(tenant, /1 pool \* 4 servers \* 4 volumes \* 100Gi = 1600 GiB = 1\.5625 TiB raw/);
  assert.match(tenant, /1200 GiB = 1\.171875 TiB/);
  assert.match(tenant, /name:\s+pool-0[\s\S]*servers:\s+4[\s\S]*volumesPerServer:\s+4/);
  assert.match(tenant, /name:\s+MINIO_STORAGE_CLASS_STANDARD\s+value:\s+"EC:4"/);
  assert.doesNotMatch(tenant, /4 pools|16 pods|loss of 4 drives \(one pool\)|50 percent usable/);
  assert.match(hardware, /one 4-server pool × 4 PVCs\/server × 100 GiB with EC:4/);
  assert.match(hardware, /1600 GiB \(1\.5625 TiB\) raw cluster baseline/);
  assert.match(hardware, /1200 GiB \(1\.171875 TiB\)/);
  assert.match(hardware, /does not guarantee whole-node tolerance/);
  assert.match(hardware, /2× 2 TB NVMe in RAID1/);
  assert.match(hardware, /A 1 TB RAID1 data volume cannot satisfy/);
});
