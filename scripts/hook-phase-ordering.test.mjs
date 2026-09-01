// Tests for the ArgoCD hook phase-ordering guard and the migration/runtime
// role-parity guard in scripts/validate-kubernetes-manifests.mjs.
//
// Every assertion here is paired: the guard must PASS on the real rendered tree
// AND FAIL on a mutation of it. A guard verified only against the tree it was
// written for is indistinguishable from one that inspects nothing — which is
// exactly how the migration-Job guard in PR #955 first reported green.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  requireHookPhaseOrdering,
  requireMigrationRuntimeRoleParity,
} from './validate-kubernetes-manifests.mjs';
import {
  BLOCK_SCALAR,
  objectReferencesOf,
  parseRenderedManifests,
  syncPhasesOf,
} from './lib/rendered-manifest-refs.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPS_TARGET = 'infra/kubernetes/apps';
const MIGRATION_JOB = 'vhhealth-backend-migrate';
const MIGRATION_CONFIG = 'vhhealth-backend-migration-config';
const RUNTIME_CONFIG = 'vhhealth-backend-config';

function findKustomize() {
  const explicit = process.env.KUSTOMIZE_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const dirs = String(process.env.PATH || '').split(delimiter);
  if (process.platform === 'win32') dirs.push('D:\\Dev\\Tools\\kubetools');
  const names = process.platform === 'win32' ? ['kustomize.exe', 'kustomize'] : ['kustomize'];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  throw new Error('kustomize was not found; set KUSTOMIZE_BIN.');
}

function renderApps() {
  const result = spawnSync(findKustomize(), ['build', APPS_TARGET], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `kustomize build ${APPS_TARGET} failed: ${result.stderr}`);
  return parseRenderedManifests(result.stdout);
}

const resources = renderApps();
const clone = () => JSON.parse(JSON.stringify(resources));
const find = (list, kind, name) =>
  list.find((resource) => resource?.kind === kind && resource?.metadata?.name === name);

// ── The parser actually sees the tree ────────────────────────────────────────
// Without these, every guard below could be passing on an empty parse.

test('the render parses into the resources the guards need to inspect', () => {
  assert.ok(resources.length > 20, `expected a full app render, parsed ${resources.length} docs`);
  const job = find(resources, 'Job', MIGRATION_JOB);
  assert.ok(job, `${MIGRATION_JOB} not found in the parsed render`);
  assert.deepEqual(syncPhasesOf(job), ['PreSync']);
  assert.ok(
    find(resources, 'ConfigMap', MIGRATION_CONFIG),
    `${MIGRATION_CONFIG} not found in the parsed render`,
  );
  assert.ok(find(resources, 'ConfigMap', RUNTIME_CONFIG));
  assert.ok(find(resources, 'Deployment', 'vhhealth-backend'));
});

test('object references are extracted from the migration Job, block scalars and all', () => {
  const job = find(resources, 'Job', MIGRATION_JOB);
  const references = objectReferencesOf(job);
  const names = references.map((reference) => `${reference.kind}/${reference.name}`);

  // envFrom on the migrate container — the reference this whole change is about.
  assert.ok(names.includes(`ConfigMap/${MIGRATION_CONFIG}`), names.join(', '));
  // ...and it must NOT reach for the Sync-phase runtime ConfigMap any more.
  assert.ok(!names.includes(`ConfigMap/${RUNTIME_CONFIG}`), names.join(', '));
  // env[].valueFrom.configMapKeyRef on the same container.
  assert.ok(names.includes('ConfigMap/vhhealth-payroll-revision-754-acceptance'));
  // secretKeyRef from BOTH the initContainer and the migrate container.
  assert.ok(names.includes('Secret/vhhealth-backend-env'));
  // The initContainer embeds a node program in a block scalar containing
  // `name:`-looking text; nothing from it may leak in as a reference.
  assert.ok(
    references.every((reference) => /^[a-z0-9.-]+$/.test(reference.name)),
    `implausible reference name parsed out of a block scalar: ${names.join(', ')}`,
  );
});

// ── Phase-ordering guard ─────────────────────────────────────────────────────

test('passes on the real rendered app tree', () => {
  requireHookPhaseOrdering(APPS_TARGET, resources);
});

test('FAILS when the PreSync Job envFrom points back at the Sync-phase ConfigMap', () => {
  // This is main as it stood before this change.
  const mutated = clone();
  const job = find(mutated, 'Job', MIGRATION_JOB);
  const migrate = job.spec.template.spec.containers.find((c) => c.name === 'migrate');
  const source = migrate.envFrom.find((entry) => entry.configMapRef);
  source.configMapRef.name = RUNTIME_CONFIG;
  assert.throws(
    () => requireHookPhaseOrdering(APPS_TARGET, mutated),
    /PreSync hooks that consume Sync-phase resources[\s\S]*vhhealth-backend-config/,
  );
});

test('FAILS when the migration ConfigMap stops being a PreSync hook', () => {
  const mutated = clone();
  const config = find(mutated, 'ConfigMap', MIGRATION_CONFIG);
  delete config.metadata.annotations['argocd.argoproj.io/hook'];
  assert.throws(
    () => requireHookPhaseOrdering(APPS_TARGET, mutated),
    new RegExp(`PreSync hooks that consume Sync-phase resources[\\s\\S]*${MIGRATION_CONFIG}`),
  );
});

test('FAILS when the payroll acceptance ConfigMap stops being a PreSync hook', () => {
  // The other PreSync-phase dependency of the same Job, reached through
  // env[].valueFrom rather than envFrom.
  const mutated = clone();
  const config = find(mutated, 'ConfigMap', 'vhhealth-payroll-revision-754-acceptance');
  config.metadata.annotations['argocd.argoproj.io/hook'] = 'PostSync';
  assert.throws(
    () => requireHookPhaseOrdering(APPS_TARGET, mutated),
    /PreSync hooks that consume Sync-phase resources/,
  );
});

test('a volume mount of a Sync-phase ConfigMap from a PreSync hook is caught too', () => {
  const mutated = clone();
  const job = find(mutated, 'Job', MIGRATION_JOB);
  job.spec.template.spec.volumes.push({ name: 'extra', configMap: { name: RUNTIME_CONFIG } });
  assert.throws(
    () => requireHookPhaseOrdering(APPS_TARGET, mutated),
    /volumes\[extra\]/,
  );
});

test('optional: true is accepted — the hook has declared it tolerates absence', () => {
  const mutated = clone();
  const job = find(mutated, 'Job', MIGRATION_JOB);
  const migrate = job.spec.template.spec.containers.find((c) => c.name === 'migrate');
  migrate.envFrom.find((entry) => entry.configMapRef).configMapRef = {
    name: RUNTIME_CONFIG,
    optional: true,
  };
  requireHookPhaseOrdering(APPS_TARGET, mutated);
});

test('references to objects this render does not produce are not flagged', () => {
  // vhhealth-backend-env is sealed and applied out of band before the first
  // sync; flagging it would push people to mark a DATABASE_URL secret optional.
  const secretReferences = objectReferencesOf(find(resources, 'Job', MIGRATION_JOB)).filter(
    (reference) => reference.name === 'vhhealth-backend-env',
  );
  assert.ok(secretReferences.length > 0);
  assert.ok(secretReferences.every((reference) => !reference.optional));
  requireHookPhaseOrdering(APPS_TARGET, resources); // still passes
});

test('FAILS closed when the migration Job stops being a PreSync hook at all', () => {
  // Otherwise the guard would have nothing to inspect and report green.
  const mutated = clone();
  delete find(mutated, 'Job', MIGRATION_JOB).metadata.annotations['argocd.argoproj.io/hook'];
  assert.throws(
    () => requireHookPhaseOrdering(APPS_TARGET, mutated),
    /no longer an argocd\.argoproj\.io\/hook: PreSync resource/,
  );
});

test('FAILS closed when the migration Job disappears from a target that must render it', () => {
  const mutated = clone().filter(
    (resource) => !(resource?.kind === 'Job' && resource?.metadata?.name === MIGRATION_JOB),
  );
  assert.throws(
    () => requireHookPhaseOrdering(APPS_TARGET, mutated),
    /no longer renders a Job named vhhealth-backend-migrate/,
  );
});

// ── Runtime-role parity guard ────────────────────────────────────────────────

test('role parity passes on the real rendered app tree', () => {
  requireMigrationRuntimeRoleParity(APPS_TARGET, resources);
});

test('FAILS when the two runtime-role values diverge', () => {
  const mutated = clone();
  find(mutated, 'ConfigMap', MIGRATION_CONFIG).data.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_other';
  assert.throws(
    () => requireMigrationRuntimeRoleParity(APPS_TARGET, mutated),
    /grant privileges to one role while the API connects as another/,
  );
});

test('FAILS when the migration ConfigMap loses the key entirely', () => {
  const mutated = clone();
  delete find(mutated, 'ConfigMap', MIGRATION_CONFIG).data.AUTH_TENANT_RLS_RUNTIME_ROLE;
  assert.throws(
    () => requireMigrationRuntimeRoleParity(APPS_TARGET, mutated),
    /would fail closed in ensure-runtime-role-grants\.mjs/,
  );
});

test('FAILS when the runtime ConfigMap loses the key entirely', () => {
  const mutated = clone();
  delete find(mutated, 'ConfigMap', RUNTIME_CONFIG).data.AUTH_TENANT_RLS_RUNTIME_ROLE;
  assert.throws(
    () => requireMigrationRuntimeRoleParity(APPS_TARGET, mutated),
    /would lose tenant RLS runtime-role enforcement/,
  );
});

test('FAILS rather than comparing two block-scalar placeholders as equal', () => {
  // The parser skips block scalar bodies. If it substituted a plain string,
  // two block-scalar role values would compare EQUAL and this guard would
  // report green on a value it never actually read.
  const mutated = clone();
  find(mutated, 'ConfigMap', MIGRATION_CONFIG).data.AUTH_TENANT_RLS_RUNTIME_ROLE = BLOCK_SCALAR;
  find(mutated, 'ConfigMap', RUNTIME_CONFIG).data.AUTH_TENANT_RLS_RUNTIME_ROLE = BLOCK_SCALAR;
  assert.throws(
    () => requireMigrationRuntimeRoleParity(APPS_TARGET, mutated),
    /has no plain-scalar AUTH_TENANT_RLS_RUNTIME_ROLE/,
  );
});

test('FAILS when a target renders one ConfigMap but not the other', () => {
  const mutated = clone().filter(
    (resource) => !(resource?.kind === 'ConfigMap' && resource?.metadata?.name === MIGRATION_CONFIG),
  );
  assert.throws(
    () => requireMigrationRuntimeRoleParity(APPS_TARGET, mutated),
    /Both are required/,
  );
});
