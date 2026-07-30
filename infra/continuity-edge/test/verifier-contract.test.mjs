import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  buildMirror,
  createTestRuntime,
  facilityDirectory,
  verifyOptions,
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

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vh-edge-contract-'));
  roots.push(root);
  return buildMirror({ runtime, root, ...options });
}

test('runtime receipt pins the exact C3.2a source bytes', async () => {
  const receipt = JSON.parse(
    await readFile(path.join(runtime.root, 'source-receipt.json'), 'utf8'),
  );
  const sourceRoot = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'apps',
    'backend',
    'src',
    'services',
    'downtime',
  );
  for (const [name, expected] of Object.entries(receipt.sources)) {
    const actual = createHash('sha256')
      .update(await readFile(path.join(sourceRoot, name)))
      .digest('hex');
    assert.equal(actual, expected, `${name} drifted after the runtime build`);
  }
});

test('accepts a complete signed mirror and preserves the reason vocabulary', async () => {
  const built = await fixture();
  const result = await runtime.verifyContinuityEdgeMirror(verifyOptions(built));
  assert.deepEqual(
    {
      ok: result.ok,
      manifestVersion: result.manifestVersion,
      policyVersion: result.policyVersion,
      revocationEpoch: result.revocationEpoch,
      accessRevision: result.accessRevision,
      coverage: result.coverage,
    },
    {
      ok: true,
      manifestVersion: '9',
      policyVersion: '7',
      revocationEpoch: '3',
      accessRevision: '11',
      coverage: ['ward/ward-10'],
    },
  );
  for (const required of [
    'ASSET_HASH_MISMATCH',
    'ASSET_MISSING',
    'SIGNATURE_INVALID',
    'MANIFEST_ROLLBACK',
    'KEY_REVOKED',
    'AUDIENCE_MISMATCH',
    'SYMLINK_ESCAPE',
  ]) {
    assert.ok(
      Object.values(runtime.verifier.EDGE_MIRROR_VERIFICATION_REASONS).includes(
        required,
      ),
      `${required} must remain classifiable`,
    );
  }
});

test('classifies tampering, partial copies, rollbacks, revoked keys, and audiences', async () => {
  const tampered = await fixture();
  await writeFile(
    path.join(
      tampered.receipt.paths.setDir,
      'locations',
      'ward',
      'ward-10',
      'pack.html',
    ),
    'tampered',
  );
  assert.equal(
    (await runtime.verifyContinuityEdgeMirror(verifyOptions(tampered))).reason,
    'ASSET_HASH_MISMATCH',
  );

  const partial = await fixture();
  await unlink(
    path.join(
      partial.receipt.paths.setDir,
      'locations',
      'ward',
      'ward-10',
      'pack.json',
    ),
  );
  assert.equal(
    (await runtime.verifyContinuityEdgeMirror(verifyOptions(partial))).reason,
    'ASSET_MISSING',
  );

  const rollback = await fixture();
  assert.equal(
    (
      await runtime.verifyContinuityEdgeMirror(
        verifyOptions(rollback, {
          persistedFloors: {
            ...rollback.floors,
            manifestVersion: '10',
          },
        }),
      )
    ).reason,
    'MANIFEST_ROLLBACK',
  );

  const revoked = await fixture();
  revoked.trustedKeys.packKeys[
    revoked.manifestEnvelope.keyId
  ].state = 'revoked';
  assert.equal(
    (await runtime.verifyContinuityEdgeMirror(verifyOptions(revoked))).reason,
    'KEY_REVOKED',
  );

  const expired = await fixture({
    expiresAt: '2026-07-30T00:00:30.000Z',
  });
  assert.equal(
    (await runtime.verifyContinuityEdgeMirror(verifyOptions(expired))).reason,
    'PACK_EXPIRED',
  );

  const unsigned = await fixture();
  const unsignedManifest = JSON.parse(
    await readFile(unsigned.receipt.paths.manifestPath, 'utf8'),
  );
  unsignedManifest.signature =
    `${unsignedManifest.signature[0] === 'A' ? 'B' : 'A'}` +
    unsignedManifest.signature.slice(1);
  const unsignedBytes = Buffer.from(
    `${runtime.canonical.canonicalizeJson(unsignedManifest)}\n`,
  );
  await writeFile(unsigned.receipt.paths.manifestPath, unsignedBytes);
  const unsignedPointer = JSON.parse(
    await readFile(unsigned.receipt.paths.currentPath, 'utf8'),
  );
  unsignedPointer.manifest_sha256 =
    runtime.canonical.sha256Hex(unsignedBytes);
  await writeFile(
    unsigned.receipt.paths.currentPath,
    `${JSON.stringify(unsignedPointer)}\n`,
  );
  assert.equal(
    (
      await runtime.verifyContinuityEdgeMirror(
        verifyOptions(unsigned),
      )
    ).reason,
    'SIGNATURE_INVALID',
  );

  const wrongAudience = await fixture();
  const copiedFacility = path.join(
    path.dirname(facilityDirectory(wrongAudience.root)),
    '42',
  );
  await cp(facilityDirectory(wrongAudience.root), copiedFacility, {
    recursive: true,
  });
  const copiedPointerPath = path.join(copiedFacility, 'current.json');
  const copiedPointer = JSON.parse(
    await readFile(copiedPointerPath, 'utf8'),
  );
  copiedPointer.facility_id = 42;
  await writeFile(copiedPointerPath, `${JSON.stringify(copiedPointer)}\n`);
  assert.equal(
    (
      await runtime.verifyContinuityEdgeMirror(
        verifyOptions(wrongAudience, { facilityId: 42 }),
      )
    ).reason,
    'AUDIENCE_MISMATCH',
  );
  const envelope = JSON.parse(
    await readFile(
      path.join(
        wrongAudience.receipt.paths.setDir,
        'locations',
        'ward',
        'ward-10',
        'pack.json',
      ),
      'utf8',
    ),
  );
  envelope.signature = `${envelope.signature.slice(0, -2)}AA`;
  assert.equal(
    runtime.canonical.verifySignedPackEnvelope(envelope, {
      rendered: '<!doctype html><title>Verified ward pack</title>',
      trustedKeys: wrongAudience.trustedKeys.packKeys,
      expectedAudience: {
        tenantId: '52e31913-c846-4458-a21b-31cd2f457e9b',
        facilityId: '41',
      },
      minimumManifestVersion: '9',
      minimumPolicyVersion: '7',
      minimumRevocationEpoch: '3',
      minimumTrustedNow: wrongAudience.floors.trustedNow,
      trustedNow: wrongAudience.trustedNow,
      clockTrusted: true,
    }).reason,
    'SIGNATURE_INVALID',
  );
});

test('rejects symbolic links as escapes before reading their target', async (t) => {
  const built = await fixture();
  const htmlPath = path.join(
    built.receipt.paths.setDir,
    'locations',
    'ward',
    'ward-10',
    'pack.html',
  );
  await unlink(htmlPath);
  try {
    await symlink(
      path.join(built.receipt.paths.setDir, 'manifest.json'),
      htmlPath,
      'file',
    );
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('Windows symlink creation is unavailable');
      return;
    }
    throw error;
  }
  assert.equal(
    (await runtime.verifyContinuityEdgeMirror(verifyOptions(built))).reason,
    'SYMLINK_ESCAPE',
  );
});
