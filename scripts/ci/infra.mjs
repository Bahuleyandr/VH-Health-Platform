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

export function runInfraStage({
  install,
  platform = process.platform,
  commandAvailable = checkCommand,
  installValidators = installLinuxManifestValidators,
  runCommand = run,
} = {}) {
  let installedTools;
  try {
    if (
      install &&
      platform === 'linux' &&
      (!commandAvailable('kustomize', ['version']) || !commandAvailable('kubeconform', ['-v']))
    ) {
      installedTools = installValidators();
    }

    runCommand(process.execPath, [
      '--test',
      'scripts/update-prod-digests.test.mjs',
      'scripts/check-prod-digests-pinned.test.mjs',
      'scripts/check-prod-helm-image-inventory.test.mjs',
      'scripts/operator-lifecycle-preflight.test.mjs',
      'scripts/infra-truthfulness.test.mjs',
      // Runtime image ↔ manifest command contract: every command the backend
      // workloads invoke must exist in the image the Dockerfile actually
      // builds (the PreSync migration Job called a stripped `npm` for months).
      'scripts/backend-image-command-contract.test.mjs',
      'scripts/ci/forgejo-deploy-preflight.test.mjs',
      'scripts/check-redis-ha-contract.test.mjs',
      'scripts/ci/infra.test.mjs',
    ], { env: installedTools?.env });
    runCommand(
      process.execPath,
      [
        '--test',
        'scripts/check-c1-1-manifest-contract.test.mjs',
        'scripts/c1-1-backup-scripts.test.mjs',
      ],
      { env: installedTools?.env },
    );
    runCommand(
      process.execPath,
      ['scripts/sealed-secrets-bootstrap-smoke.mjs', '--auto'],
      { env: installedTools?.env },
    );
    runCommand(process.execPath, ['scripts/check-zero-trust-network-pack.mjs']);
    runCommand(process.execPath, ['scripts/check-c1-1-manifest-contract.mjs'], {
      env: installedTools?.env,
    });

    runCommand(process.execPath, ['scripts/validate-kubernetes-manifests.mjs'], {
      env: installedTools?.env,
    });

    runCommand(process.execPath, ['scripts/check-kyverno-enforce-readiness.mjs']);

    // Operator Applications stay held outside active composition. This gate
    // pins their chart archives and images without contacting a cluster.
    runCommand(process.execPath, ['scripts/operator-lifecycle-preflight.mjs', '--contract-only'], {
      env: installedTools?.env,
    });

    // Bound the exact chart Applications outside the Kustomize image render.
    // A chart/version/values-source change fails until it is reviewed, while
    // activation still requires a separately rendered Helm image inventory.
    runCommand(process.execPath, ['scripts/check-prod-helm-image-inventory.mjs'], {
      env: installedTools?.env,
    });

    // Render the Kustomize-controlled roots, include the scheduled restore
    // proof's synthesized runtime manifests, and live-verify each active pin.
    runCommand(process.execPath, ['scripts/check-prod-digests-pinned.mjs'], {
      env: installedTools?.env,
    });
  } finally {
    if (installedTools?.temporary && installedTools?.dir) {
      rmSync(installedTools.dir, { recursive: true, force: true });
    }
  }
}
