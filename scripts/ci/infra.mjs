import process from 'node:process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheDir, checkCommand, run } from './lib.mjs';

const kustomizeVersion = process.env.KUSTOMIZE_VERSION || '5.8.1';
const kubeconformVersion = process.env.KUBECONFORM_VERSION || '0.7.0';

function installLinuxManifestValidators() {
  const cachedRoot =
    process.env.VH_K8S_TOOLS_CACHE_DIR ||
    cacheDir('k8s-tools');
  const installDir = cachedRoot
    ? join(cachedRoot, `kustomize-${kustomizeVersion}_kubeconform-${kubeconformVersion}`)
    : mkdtempSync(join(tmpdir(), 'vhhealth-k8s-tools-'));
  const kustomizeArchive = join(installDir, `kustomize_v${kustomizeVersion}_linux_amd64.tar.gz`);
  const kubeconformArchive = join(installDir, 'kubeconform-linux-amd64.tar.gz');
  const kustomizeBin = join(installDir, 'kustomize');
  const kubeconformBin = join(installDir, 'kubeconform');

  if (cachedRoot) {
    mkdirSync(installDir, { recursive: true });
  }

  if (!checkCommand(kustomizeBin, ['version'])) {
    run('curl', [
      '--fail',
      '--location',
      '--retry',
      '5',
      '--retry-all-errors',
      '--connect-timeout',
      '30',
      '--output',
      kustomizeArchive,
      `https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${kustomizeVersion}/kustomize_v${kustomizeVersion}_linux_amd64.tar.gz`,
    ]);
    run('tar', ['-xzf', kustomizeArchive, '-C', installDir, 'kustomize']);
    chmodSync(kustomizeBin, 0o755);
  }

  if (!checkCommand(kubeconformBin, ['-v'])) {
    run('curl', [
      '--fail',
      '--location',
      '--retry',
      '5',
      '--retry-all-errors',
      '--connect-timeout',
      '30',
      '--output',
      kubeconformArchive,
      `https://github.com/yannh/kubeconform/releases/download/v${kubeconformVersion}/kubeconform-linux-amd64.tar.gz`,
    ]);
    run('tar', ['-xzf', kubeconformArchive, '-C', installDir, 'kubeconform']);
    chmodSync(kubeconformBin, 0o755);
  }

  run(kustomizeBin, ['version']);
  run(kubeconformBin, ['-v']);

  return {
    dir: installDir,
    env: {
      KUSTOMIZE_BIN: kustomizeBin,
      KUBECONFORM_BIN: kubeconformBin,
    },
    temporary: !cachedRoot,
  };
}

export function runInfraStage({ install } = {}) {
  let installedTools;
  try {
    run(process.execPath, ['--test', 'scripts/update-prod-digests.test.mjs']);
    run(process.execPath, ['scripts/check-zero-trust-network-pack.mjs']);

    if (
      install &&
      process.platform === 'linux' &&
      (!checkCommand('kustomize', ['version']) || !checkCommand('kubeconform', ['-v']))
    ) {
      installedTools = installLinuxManifestValidators();
    }

    run(process.execPath, ['scripts/validate-kubernetes-manifests.mjs'], {
      env: installedTools?.env,
    });

    run(process.execPath, ['scripts/check-kyverno-enforce-readiness.mjs']);

    // B0.6 / H11: fail the build if any prod image digest is still the
    // all-zeros fail-closed placeholder when running on `main` (the script
    // auto-detects main via GITHUB_REF/GITHUB_EVENT_NAME and is a no-op
    // off-main, where placeholders are expected until the release pipeline
    // writes real digests).
    run(process.execPath, ['scripts/check-prod-digests-pinned.mjs']);
  } finally {
    if (installedTools?.temporary && installedTools?.dir) {
      rmSync(installedTools.dir, { recursive: true, force: true });
    }
  }
}
