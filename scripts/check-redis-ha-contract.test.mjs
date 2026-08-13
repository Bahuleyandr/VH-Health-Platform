import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function read(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

test('Redis source contract keeps quorum discovery and activation fail closed', () => {
  const manifest = read('infra/kubernetes/base/redis/redis-sentinel.yaml');
  const kustomization = read('infra/kubernetes/base/redis/kustomization.yaml');
  const redisConfig = read('infra/kubernetes/base/redis/config/redis-base.conf');
  const redisStart = read('infra/kubernetes/base/redis/config/start-redis.sh');
  const sentinelStart = read('infra/kubernetes/base/redis/config/start-sentinel.sh');
  const credentialSchema = read('infra/kubernetes/base/redis/redis-credentials.sealed-secret.yaml.example');
  const backendConfig = read('infra/kubernetes/apps/backend/configmap.yaml');

  assert.match(manifest, /podManagementPolicy: Parallel/);
  assert.doesNotMatch(manifest, /checksum\/config|will-be-filled-by-kustomize/);
  assert.equal((manifest.match(/- name: REDIS_ALLOW_FIRST_CLUSTER_BOOTSTRAP/g) || []).length, 2);
  assert.equal((manifest.match(/value: "false"/g) || []).length >= 2, true);
  assert.match(kustomization, /configMapGenerator:[\s\S]*start-redis\.sh=config\/start-redis\.sh/);
  assert.match(redisConfig, /^min-replicas-to-write 1$/m);
  assert.match(redisConfig, /^replica-read-only yes$/m);
  assert.match(redisStart, /wait_for_sentinel_consensus/);
  assert.match(redisStart, /pod_index" = "0".*first_cluster_bootstrap_allowed/);
  assert.match(sentinelStart, /wait_for_sentinel_consensus/);
  assert.match(sentinelStart, /sentinel sentinel-pass/);
  assert.match(credentialSchema, /redis-password: PLACEHOLDER/);
  assert.match(credentialSchema, /sentinel-password: PLACEHOLDER/);
  assert.doesNotMatch(manifest, /key: password$/m);
  assert.match(backendConfig, /REDIS_REQUIRE_SENTINEL: "true"/);
  assert.equal((backendConfig.match(/redis-[012]\.redis-headless/g) || []).length, 3);
});

test('Redis HA shell harness proves bootstrap, quorum-follow, and stale-primary rejection', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync('sh', ['infra/kubernetes/base/redis/test/redis-ha-harness.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /passed \(10 scenarios\)/);
});

test('rendered Redis ConfigMap is content hashed and referenced by the StatefulSet', (t) => {
  const explicit = process.env.KUSTOMIZE_BIN;
  if (explicit && !existsSync(explicit)) {
    t.skip(`KUSTOMIZE_BIN does not exist: ${explicit}`);
    return;
  }
  const result = spawnSync(explicit || 'kustomize', ['build', 'infra/kubernetes/base/redis'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.error?.code === 'ENOENT') {
    t.skip('kustomize is not installed');
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  const names = [...result.stdout.matchAll(/name: (redis-sentinel-config-[a-z0-9]+)$/gm)]
    .map((match) => match[1]);
  assert.equal(names.length, 2, 'generated ConfigMap and volume reference must both be hashed');
  assert.equal(names[0], names[1]);
});
