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

test('Sealed Secrets bootstrap helper binds the rendered controller identity', t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'vhhealth-sealed-bootstrap-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const calls = path.join(temp, 'calls.log');
  const fakeKustomize = path.join(temp, 'kustomize');
  const fakeKubectl = path.join(temp, 'kubectl');
  const fakePython = path.join(temp, 'python3');
  const executable = { mode: 0o755 };

  writeFileSync(fakeKustomize, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"kustomize:$*\" >> \"${bashPath(calls)}\"\ncat <<'YAML'\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: sealed-secrets\n  namespace: vhhealth-security\nYAML\n`, executable);
  writeFileSync(fakeKubectl, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"kubectl:$*\" >> \"${bashPath(calls)}\"\n`, executable);
  writeFileSync(fakePython, '#!/usr/bin/env bash\nexit 0\n', executable);
  chmodSync(fakeKustomize, 0o755);
  chmodSync(fakeKubectl, 0o755);
  chmodSync(fakePython, 0o755);

  const helper = path.join(repoRoot, 'scripts/bootstrap-sealed-secrets.sh');
  const invoke = mode => spawnBash([
    '-c',
    'KUSTOMIZE_BIN="$1" KUBECTL_BIN="$2" PYTHON_BIN="$3" "$4" "$5"',
    'vhhealth-sealed-bootstrap-test',
    bashPath(fakeKustomize),
    bashPath(fakeKubectl),
    bashPath(fakePython),
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
  assert.match(commandLog, /kubectl:apply -k .*infra\/kubernetes\/base\/sealed-secrets/);
  assert.match(commandLog, /kubectl:-n vhhealth-security rollout status deployment\/sealed-secrets --timeout=180s/);
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
  assert.doesNotMatch(argoReadme, /kubectl apply -f infra\/kubernetes\/base\/sealed-secrets\//);
  assert.match(argoReadme, /bootstrap-sealed-secrets\.sh --apply/);
});

test('Dalek deploy workflow is strict and verifies the deployed commit', () => {
  const workflow = readRepo('.forgejo/workflows/deploy-dalekdefender.yml');
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

  assert.match(tenant, /1 pool \* 4 servers \* 4 volumes \* 100Gi = 1\.6 TiB raw/);
  assert.match(tenant, /name:\s+pool-0[\s\S]*servers:\s+4[\s\S]*volumesPerServer:\s+4/);
  assert.match(tenant, /name:\s+MINIO_STORAGE_CLASS_STANDARD\s+value:\s+"EC:4"/);
  assert.doesNotMatch(tenant, /4 pools|16 pods|loss of 4 drives \(one pool\)|50 percent usable/);
  assert.match(hardware, /one 4-server pool × 4 PVCs\/server × 100 GiB with EC:4/);
  assert.match(hardware, /does not guarantee whole-node tolerance/);
  assert.match(hardware, /2× 2 TB NVMe in RAID1/);
  assert.match(hardware, /A 1 TB RAID1 data volume cannot satisfy/);
});
