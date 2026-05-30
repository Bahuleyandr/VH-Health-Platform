import process from 'node:process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand, run } from './lib.mjs';

const kustomizeVersion = process.env.KUSTOMIZE_VERSION || '5.8.1';
const kubeconformVersion = process.env.KUBECONFORM_VERSION || '0.7.0';

function installLinuxManifestValidators() {
  const installDir = mkdtempSync(join(tmpdir(), 'vhhealth-k8s-tools-'));
  const kustomizeArchive = join(installDir, `kustomize_v${kustomizeVersion}_linux_amd64.tar.gz`);
  const kubeconformArchive = join(installDir, 'kubeconform-linux-amd64.tar.gz');
  const kustomizeBin = join(installDir, 'kustomize');
  const kubeconformBin = join(installDir, 'kubeconform');

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

  run(kustomizeBin, ['version']);
  run(kubeconformBin, ['-v']);

  return {
    dir: installDir,
    env: {
      KUSTOMIZE_BIN: kustomizeBin,
      KUBECONFORM_BIN: kubeconformBin,
    },
  };
}

export function runInfraStage({ install } = {}) {
  let installedTools;
  try {
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
  } finally {
    if (installedTools?.dir) {
      rmSync(installedTools.dir, { recursive: true, force: true });
    }
  }
}
