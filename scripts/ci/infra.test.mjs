import assert from 'node:assert/strict';
import test from 'node:test';

import { runInfraStage } from './infra.mjs';

test('clean Linux --install runner propagates installed manifest tools to every render check', () => {
  const installedEnv = {
    KUSTOMIZE_BIN: '/clean-runner/tools/kustomize',
    KUBECONFORM_BIN: '/clean-runner/tools/kubeconform',
  };
  const calls = [];
  let installs = 0;
  runInfraStage({
    install: true,
    platform: 'linux',
    commandAvailable: () => false,
    installValidators: () => {
      installs += 1;
      return { dir: '', env: installedEnv, temporary: false };
    },
    runCommand: (command, args, options = {}) => calls.push({ command, args, options }),
  });

  assert.equal(installs, 1);
  for (const script of [
    'scripts/check-prod-digests-pinned.test.mjs',
    'scripts/check-prod-helm-image-inventory.test.mjs',
    'scripts/check-redis-ha-contract.test.mjs',
    'scripts/operator-lifecycle-preflight.test.mjs',
    'scripts/check-c1-1-manifest-contract.test.mjs',
    'scripts/check-c1-1-manifest-contract.mjs',
    'scripts/sealed-secrets-bootstrap-smoke.mjs',
    'scripts/validate-kubernetes-manifests.mjs',
    'scripts/operator-lifecycle-preflight.mjs',
    'scripts/check-prod-helm-image-inventory.mjs',
    'scripts/check-prod-digests-pinned.mjs',
  ]) {
    const invocation = calls.find(({ args }) => args.includes(script));
    assert.ok(invocation, `${script} was not invoked`);
    assert.deepEqual(invocation.options.env, installedEnv, `${script} did not receive installed tools`);
  }

  const bootstrapSmoke = calls.find(({ args }) =>
    args.includes('scripts/sealed-secrets-bootstrap-smoke.mjs'));
  assert.deepEqual(
    bootstrapSmoke.args,
    ['scripts/sealed-secrets-bootstrap-smoke.mjs', '--auto'],
  );
});
