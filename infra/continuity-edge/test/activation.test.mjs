import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { activateFromSource } from '../lib/activation.mjs';
import {
  FACILITY_ID,
  TENANT_ID,
  TRUSTED_NOW,
  buildMirror,
  createTestRuntime,
  facilityDirectory,
  localSource,
  newSigningKeys,
} from './helpers/fixture.mjs';

let runtime;
const roots = [];

before(async () => {
  runtime = await createTestRuntime();
});

after(async () => {
  await Promise.all([
    ...roots.map((root) => rm(root, { recursive: true, force: true })),
    runtime ? rm(runtime.root, { recursive: true, force: true }) : Promise.resolve(),
  ]);
});

async function tempRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function currentVersion(root) {
  try {
    const pointer = JSON.parse(
      await readFile(path.join(facilityDirectory(root), 'current.json'), 'utf8'),
    );
    return pointer.manifest_version;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function preparedPair() {
  const signingKeys = newSigningKeys();
  const oldSourceRoot = await tempRoot('vh-edge-old-source-');
  const newSourceRoot = await tempRoot('vh-edge-new-source-');
  const dataRoot = await tempRoot('vh-edge-data-');
  const oldFixture = await buildMirror({
    runtime,
    root: oldSourceRoot,
    signingKeys,
    manifestVersion: '8',
    issuedAt: '2026-07-29T23:00:00.000Z',
    expiresAt: '2026-07-30T03:00:00.000Z',
  });
  const newFixture = await buildMirror({
    runtime,
    root: newSourceRoot,
    signingKeys,
    manifestVersion: '9',
  });
  const newPointer = JSON.parse(
    await readFile(newFixture.receipt.paths.currentPath, 'utf8'),
  );
  const scope = { tenantId: TENANT_ID, facilityId: FACILITY_ID };
  const floorsPath = path.join(dataRoot, 'state', 'floors.json');
  const metricPath = path.join(dataRoot, 'metrics', 'continuity.prom');
  const initial = await activateFromSource({
    source: localSource(oldSourceRoot),
    dataRoot,
    scope,
    trustedKeys: oldFixture.trustedKeys,
    policyReceipt: oldFixture.policyReceipt,
    floors: oldFixture.floors,
    floorsPath,
    trustedNow: TRUSTED_NOW,
    runtime,
    prometheusPath: metricPath,
  });
  return {
    dataRoot,
    oldSourceRoot,
    oldFixture,
    newSourceRoot,
    newFixture,
    newPointer,
    scope,
    floorsPath,
    metricPath,
    floors: initial.floors,
  };
}

test('crash-lagged floors advance before a later pull can roll back the pointer', async () => {
  const pair = await preparedPair();
  await assert.rejects(
    activateFromSource({
      source: localSource(pair.newSourceRoot),
      dataRoot: pair.dataRoot,
      scope: pair.scope,
      trustedKeys: pair.newFixture.trustedKeys,
      policyReceipt: pair.newFixture.policyReceipt,
      floors: pair.floors,
      floorsPath: pair.floorsPath,
      trustedNow: TRUSTED_NOW,
      runtime,
      prometheusPath: pair.metricPath,
      faultInjector: async (point) => {
        if (point === 'afterPointerRename') {
          throw new Error('INJECTED_AFTER_POINTER_RENAME');
        }
      },
    }),
    /INJECTED_AFTER_POINTER_RENAME/,
  );
  assert.equal(await currentVersion(pair.dataRoot), '9');

  await assert.rejects(
    activateFromSource({
      source: localSource(pair.oldSourceRoot),
      dataRoot: pair.dataRoot,
      scope: pair.scope,
      trustedKeys: pair.oldFixture.trustedKeys,
      policyReceipt: pair.oldFixture.policyReceipt,
      floors: pair.floors,
      floorsPath: pair.floorsPath,
      trustedNow: TRUSTED_NOW,
      runtime,
      prometheusPath: pair.metricPath,
    }),
    /MANIFEST_ROLLBACK/,
  );
  assert.equal(await currentVersion(pair.dataRoot), '9');
  const recoveredFloors = JSON.parse(
    await readFile(pair.floorsPath, 'utf8'),
  );
  assert.equal(recoveredFloors.manifestVersion, '9');
  assert.equal(
    recoveredFloors.currentManifestSha256,
    pair.newPointer.manifest_sha256,
  );
});

test('a broken selected set is never treated as an uninitialized edge', async () => {
  const pair = await preparedPair();
  const current = JSON.parse(
    await readFile(
      path.join(facilityDirectory(pair.dataRoot), 'current.json'),
      'utf8',
    ),
  );
  await rm(
    path.join(
      facilityDirectory(pair.dataRoot),
      ...current.manifest.split('/'),
    ),
  );
  await assert.rejects(
    activateFromSource({
      source: localSource(pair.newSourceRoot),
      dataRoot: pair.dataRoot,
      scope: pair.scope,
      trustedKeys: pair.newFixture.trustedKeys,
      policyReceipt: pair.newFixture.policyReceipt,
      floors: pair.floors,
      floorsPath: pair.floorsPath,
      trustedNow: TRUSTED_NOW,
      runtime,
      prometheusPath: pair.metricPath,
    }),
    { code: 'ENOENT' },
  );
  assert.equal(await currentVersion(pair.dataRoot), '8');
});

test('activates only after a complete verify and advances an atomic pointer', async () => {
  const pair = await preparedPair();
  const result = await activateFromSource({
    source: localSource(pair.newSourceRoot),
    dataRoot: pair.dataRoot,
    scope: pair.scope,
    trustedKeys: pair.newFixture.trustedKeys,
    policyReceipt: pair.newFixture.policyReceipt,
    floors: pair.floors,
    floorsPath: pair.floorsPath,
    trustedNow: TRUSTED_NOW,
    runtime,
    prometheusPath: pair.metricPath,
  });
  assert.equal(result.ok, true);
  assert.equal(await currentVersion(pair.dataRoot), '9');
  assert.equal(
    (
      await runtime.verifyContinuityEdgeMirror({
        root: pair.dataRoot,
        tenantId: TENANT_ID,
        facilityId: FACILITY_ID,
        trustedKeys: pair.newFixture.trustedKeys.packKeys,
        persistedFloors: result.floors,
        trustedNow: TRUSTED_NOW,
        clockTrusted: true,
      })
    ).ok,
    true,
  );
});

for (const stage of [
  'beforeSetRename',
  'afterSetRename',
  'beforePointerRename',
  'afterPointerRename',
]) {
  test(`fault at ${stage} never leaves current.json missing or partial`, async () => {
    const pair = await preparedPair();
    await assert.rejects(
      activateFromSource({
        source: localSource(pair.newSourceRoot),
        dataRoot: pair.dataRoot,
        scope: pair.scope,
        trustedKeys: pair.newFixture.trustedKeys,
        policyReceipt: pair.newFixture.policyReceipt,
        floors: pair.floors,
        floorsPath: pair.floorsPath,
        trustedNow: TRUSTED_NOW,
        runtime,
        prometheusPath: pair.metricPath,
        faultInjector: async (point) => {
          if (point === stage) throw new Error(`INJECTED_${stage}`);
        },
      }),
      new RegExp(`INJECTED_${stage}`),
    );
    assert.equal(
      await currentVersion(pair.dataRoot),
      stage === 'afterPointerRename' ? '9' : '8',
    );
    const pointerBytes = await readFile(
      path.join(facilityDirectory(pair.dataRoot), 'current.json'),
    );
    assert.doesNotThrow(() => JSON.parse(pointerBytes.toString('utf8')));
  });
}
