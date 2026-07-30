import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

import {
  DEFAULT_TENANT_ID,
  assertExactCoverage,
  buildContinuityAssetRelativePath,
  buildContinuityPackPaths,
  publishContinuityPackSet,
} from '../../services/downtime/continuityPackPublicationService.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const FACILITY_ID = 7;
const REQUIRED_COVERAGE = [
  { locationType: 'ward', locationId: 'north-1' },
  { locationType: 'ed', locationId: 'main' },
];

function publication({
  root,
  tenantId = TENANT_A,
  facilityId = FACILITY_ID,
  manifestVersion = 1,
  requiredCoverage = REQUIRED_COVERAGE,
  assets,
  rootAssets,
  manifestContent,
  fsOps,
  commitEvidence,
} = {}) {
  return {
    root,
    tenantId,
    facilityId,
    manifestVersion,
    requiredCoverage,
    assets: assets ?? [
      {
        locationType: 'ward',
        locationId: 'north-1',
        fileName: 'pack.json',
        content: '{"ward":"north-1"}',
      },
      {
        locationType: 'ward',
        locationId: 'north-1',
        fileName: 'pack.html',
        content: '<html>North 1</html>',
      },
      {
        locationType: 'ed',
        locationId: 'main',
        fileName: 'pack.json',
        content: '',
      },
    ],
    manifestContent: manifestContent ?? '{"signature":"already-signed"}',
    ...(rootAssets ? { rootAssets } : {}),
    ...(fsOps ? { fsOps } : {}),
    ...(commitEvidence ? { commitEvidence } : {}),
  };
}

function injectedError(message) {
  const error = new Error(message);
  error.code = 'EIO';
  return error;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('continuityPackPublicationService', () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vh-continuity-publication-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('publishes a complete immutable set and atomically points the facility at it', async () => {
    const result = await publishContinuityPackSet(publication({ root }));
    const pointer = JSON.parse(await fs.readFile(result.paths.currentPath, 'utf8'));

    expect(pointer).toMatchObject({
      schema: 'continuity-current-v1',
      tenant_id: TENANT_A,
      facility_id: FACILITY_ID,
      manifest_version: '1',
      set: 'sets/v1',
      manifest: 'sets/v1/manifest.json',
      manifest_sha256: result.manifestSha256,
    });
    expect(await fs.readFile(result.paths.manifestPath, 'utf8'))
      .toBe('{"signature":"already-signed"}');
    expect(await fs.readFile(
      path.join(result.paths.setDir, 'locations', 'ward', 'north-1', 'pack.json'),
      'utf8',
    )).toBe('{"ward":"north-1"}');
    expect(await fs.readFile(
      path.join(result.paths.setDir, 'locations', 'ward', 'north-1', 'pack.html'),
      'utf8',
    )).toBe('<html>North 1</html>');
    expect(await fs.readFile(
      path.join(result.paths.setDir, 'locations', 'ed', 'main', 'pack.json'),
      'utf8',
    )).toBe('');
    expect(result.coverage).toEqual([
      { locationType: 'ed', locationId: 'main' },
      { locationType: 'ward', locationId: 'north-1' },
    ]);

    expect(await fs.readdir(result.paths.continuityRoot)).toEqual(['tenants']);
    expect((await fs.readdir(result.paths.setsDir)).filter((name) => name.includes('staging')))
      .toEqual([]);

    await expect(publishContinuityPackSet(publication({ root })))
      .rejects.toMatchObject({ code: 'CONTINUITY_PACK_SET_EXISTS' });
    expect(JSON.parse(await fs.readFile(result.paths.currentPath, 'utf8')))
      .toEqual(pointer);
  });

  it('stages, verifies, and receipts root assets before exposing the new pointer', async () => {
    let observed;
    const content = '{"schema":"vhhealth_continuity_edge_access/v1"}\n';
    const result = await publishContinuityPackSet(publication({
      root,
      rootAssets: [{ relativePath: 'edge-access.json', content }],
      commitEvidence: (receipt) => {
        observed = receipt;
      },
    }));

    expect(await fs.readFile(path.join(result.paths.setDir, 'edge-access.json'), 'utf8'))
      .toBe(content);
    expect(observed.rootAssets).toEqual([{
      relativePath: 'edge-access.json',
      sha256: createHash('sha256').update(content).digest('hex'),
    }]);
    expect(Object.isFrozen(observed.rootAssets)).toBe(true);
  });

  it('keeps identical facility/location labels isolated between tenants', async () => {
    const first = await publishContinuityPackSet(publication({
      root,
      tenantId: TENANT_A,
      manifestContent: '{"tenant":"a"}',
    }));
    const second = await publishContinuityPackSet(publication({
      root,
      tenantId: TENANT_B,
      manifestContent: '{"tenant":"b"}',
      assets: [
        {
          locationType: 'ward',
          locationId: 'north-1',
          fileName: 'pack.json',
          content: '{"tenant":"b","ward":"north-1"}',
        },
        {
          locationType: 'ward',
          locationId: 'north-1',
          fileName: 'pack.html',
          content: '<html>Tenant B</html>',
        },
        {
          locationType: 'ed',
          locationId: 'main',
          fileName: 'pack.json',
          content: '',
        },
      ],
    }));

    expect(first.paths.setDir).not.toBe(second.paths.setDir);
    expect(await fs.readFile(first.paths.manifestPath, 'utf8')).toBe('{"tenant":"a"}');
    expect(await fs.readFile(second.paths.manifestPath, 'utf8')).toBe('{"tenant":"b"}');
    expect(await fs.readFile(
      path.join(first.paths.setDir, 'locations', 'ward', 'north-1', 'pack.json'),
      'utf8',
    )).toBe('{"ward":"north-1"}');
    expect(await fs.readFile(
      path.join(second.paths.setDir, 'locations', 'ward', 'north-1', 'pack.json'),
      'utf8',
    )).toBe('{"tenant":"b","ward":"north-1"}');
  });

  it('replaces current.json on Windows while retaining both immutable complete sets', async () => {
    const first = await publishContinuityPackSet(publication({ root }));
    const second = await publishContinuityPackSet(publication({
      root,
      manifestVersion: 2,
      manifestContent: '{"signature":"version-2"}',
    }));
    const pointer = JSON.parse(await fs.readFile(second.paths.currentPath, 'utf8'));

    expect(pointer.manifest_version).toBe('2');
    expect(pointer.set).toBe('sets/v2');
    expect(await fs.readFile(first.paths.manifestPath, 'utf8'))
      .toBe('{"signature":"already-signed"}');
    expect(await fs.readFile(second.paths.manifestPath, 'utf8'))
      .toBe('{"signature":"version-2"}');
  });

  it('rejects a lower manifest version after a higher version becomes current', async () => {
    const higher = await publishContinuityPackSet(publication({
      root,
      manifestVersion: 2,
      manifestContent: '{"signature":"version-2"}',
    }));
    const lowerEvidence = jest.fn();

    await expect(publishContinuityPackSet({
      ...publication({
        root,
        manifestVersion: 1,
        manifestContent: '{"signature":"late-version-1"}',
      }),
      commitEvidence: lowerEvidence,
    })).rejects.toMatchObject({ code: 'CONTINUITY_PACK_MANIFEST_ROLLBACK' });

    expect(lowerEvidence).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(higher.paths.currentPath, 'utf8')))
      .toMatchObject({ manifest_version: '2', set: 'sets/v2' });
    await expect(fs.lstat(buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 1,
    }).setDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes out-of-order writers and rejects the lower version without evidence', async () => {
    const firstEnteredEvidence = deferred();
    const releaseFirst = deferred();
    const firstEvidence = jest.fn(async () => {
      firstEnteredEvidence.resolve();
      await releaseFirst.promise;
    });
    const secondEvidence = jest.fn();
    const firstPublication = publishContinuityPackSet({
      ...publication({ root, manifestVersion: 2 }),
      commitEvidence: firstEvidence,
    });
    await firstEnteredEvidence.promise;

    await expect(publishContinuityPackSet({
      ...publication({ root, manifestVersion: 1 }),
      commitEvidence: secondEvidence,
    })).rejects.toMatchObject({ code: 'CONTINUITY_PACK_PUBLICATION_LOCKED' });

    expect(secondEvidence).not.toHaveBeenCalled();
    const secondPaths = buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 1,
    });
    await expect(fs.lstat(secondPaths.setDir)).rejects.toMatchObject({ code: 'ENOENT' });
    releaseFirst.resolve();
    const first = await firstPublication;
    expect(firstEvidence).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(first.paths.currentPath, 'utf8')))
      .toMatchObject({ manifest_version: '2' });
    await expect(publishContinuityPackSet({
      ...publication({ root, manifestVersion: 1 }),
      commitEvidence: secondEvidence,
    })).rejects.toMatchObject({ code: 'CONTINUITY_PACK_MANIFEST_ROLLBACK' });
    expect(secondEvidence).not.toHaveBeenCalled();
    await expect(fs.lstat(first.paths.publicationLockPath))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holds the lock through pointer restoration so rollback cannot clobber another writer', async () => {
    const previous = await publishContinuityPackSet(publication({ root }));
    const oldPointer = await fs.readFile(previous.paths.currentPath);
    const pointerMutated = deferred();
    const releaseFailingWriter = deferred();
    let injected = false;
    const rename = async (source, destination) => {
      await fs.rename(source, destination);
      if (!injected && destination === previous.paths.currentPath) {
        injected = true;
        pointerMutated.resolve();
        await releaseFailingWriter.promise;
        throw injectedError('injected delayed pointer rename failure');
      }
    };
    const failingPublication = publishContinuityPackSet(publication({
      root,
      manifestVersion: 2,
      fsOps: { rename },
    }));
    await pointerMutated.promise;
    const competingEvidence = jest.fn();

    await expect(publishContinuityPackSet({
      ...publication({ root, manifestVersion: 3 }),
      commitEvidence: competingEvidence,
    })).rejects.toMatchObject({ code: 'CONTINUITY_PACK_PUBLICATION_LOCKED' });

    expect(competingEvidence).not.toHaveBeenCalled();
    releaseFailingWriter.resolve();
    await expect(failingPublication).rejects.toThrow('injected delayed pointer rename failure');
    expect((await fs.readFile(previous.paths.currentPath)).equals(oldPointer)).toBe(true);
    await expect(fs.lstat(previous.paths.publicationLockPath))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('scopes publication locks independently by tenant and facility', async () => {
    const firstEnteredEvidence = deferred();
    const releaseFirst = deferred();
    const firstPublication = publishContinuityPackSet({
      ...publication({ root }),
      commitEvidence: async () => {
        firstEnteredEvidence.resolve();
        await releaseFirst.promise;
      },
    });
    await firstEnteredEvidence.promise;

    const otherTenant = await publishContinuityPackSet(publication({
      root,
      tenantId: TENANT_B,
      manifestContent: '{"tenant":"b"}',
    }));
    const otherFacility = await publishContinuityPackSet(publication({
      root,
      facilityId: FACILITY_ID + 1,
      manifestContent: '{"facility":8}',
    }));

    expect(JSON.parse(await fs.readFile(otherTenant.paths.currentPath, 'utf8')))
      .toMatchObject({ tenant_id: TENANT_B, facility_id: FACILITY_ID });
    expect(JSON.parse(await fs.readFile(otherFacility.paths.currentPath, 'utf8')))
      .toMatchObject({ tenant_id: TENANT_A, facility_id: FACILITY_ID + 1 });
    releaseFirst.resolve();
    await firstPublication;
  });

  it('commits evidence against the durable set before swapping current.json', async () => {
    const previous = await publishContinuityPackSet(publication({ root }));
    const oldPointer = await fs.readFile(previous.paths.currentPath);
    let observed;
    const commitEvidence = async (receipt) => {
      observed = {
        receipt,
        manifest: await fs.readFile(receipt.manifestPath, 'utf8'),
        pointer: await fs.readFile(receipt.currentPath),
        asset: await fs.readFile(path.join(
          receipt.setPath,
          'locations',
          'ward',
          'north-1',
          'pack.json',
        ), 'utf8'),
      };
    };

    const result = await publishContinuityPackSet({
      ...publication({ root, manifestVersion: 2 }),
      commitEvidence,
    });
    const current = JSON.parse(await fs.readFile(result.paths.currentPath, 'utf8'));

    expect(observed.manifest).toBe('{"signature":"already-signed"}');
    expect(observed.asset).toBe('{"ward":"north-1"}');
    expect(observed.pointer.equals(oldPointer)).toBe(true);
    expect(observed.receipt).toBe(result.evidenceReceipt);
    expect(Object.isFrozen(observed.receipt)).toBe(true);
    expect(Object.isFrozen(observed.receipt.assets)).toBe(true);
    expect(current.manifest_version).toBe('2');
  });

  it('keeps the old pointer and a complete orphan set when evidence commit throws', async () => {
    const previous = await publishContinuityPackSet(publication({ root }));
    const oldPointer = await fs.readFile(previous.paths.currentPath);
    let observedPointer;
    let observedManifest;
    const commitEvidence = async (receipt) => {
      observedPointer = await fs.readFile(receipt.currentPath);
      observedManifest = await fs.readFile(receipt.manifestPath, 'utf8');
      throw injectedError('injected evidence commit failure');
    };

    await expect(publishContinuityPackSet({
      ...publication({ root, manifestVersion: 2 }),
      commitEvidence,
    })).rejects.toThrow('injected evidence commit failure');

    const orphanPaths = buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 2,
    });
    expect(observedPointer.equals(oldPointer)).toBe(true);
    expect(observedManifest).toBe('{"signature":"already-signed"}');
    expect((await fs.readFile(previous.paths.currentPath)).equals(oldPointer)).toBe(true);
    expect(await fs.readFile(orphanPaths.manifestPath, 'utf8'))
      .toBe('{"signature":"already-signed"}');
    expect(await fs.readFile(
      path.join(orphanPaths.setDir, 'locations', 'ward', 'north-1', 'pack.html'),
      'utf8',
    )).toBe('<html>North 1</html>');
    expect((await fs.readdir(orphanPaths.setsDir)).filter((name) => name.includes('staging')))
      .toEqual([]);
    expect((await fs.readdir(orphanPaths.facilityDir)).filter((name) => name.startsWith('.current')))
      .toEqual([]);
  });

  it('does not create current.json when first-publication evidence commit fails', async () => {
    const paths = buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 1,
    });
    const commitEvidence = async () => {
      throw injectedError('injected first evidence commit failure');
    };

    await expect(publishContinuityPackSet({
      ...publication({ root }),
      commitEvidence,
    })).rejects.toThrow('injected first evidence commit failure');

    await expect(fs.lstat(paths.currentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(paths.manifestPath, 'utf8'))
      .toBe('{"signature":"already-signed"}');
    expect((await fs.readdir(paths.setsDir)).filter((name) => name.includes('staging')))
      .toEqual([]);
  });

  it('rejects missing, unexpected, and duplicate coverage before touching the root', async () => {
    const validationRoot = path.join(root, 'coverage-validation');
    const wardOnly = [{
      locationType: 'ward',
      locationId: 'north-1',
      fileName: 'pack.json',
      content: '',
    }];
    await expect(publishContinuityPackSet(publication({
      root: validationRoot,
      assets: wardOnly,
    }))).rejects.toThrow(/missing: ed\/main/);

    await expect(publishContinuityPackSet(publication({
      root: validationRoot,
      requiredCoverage: [{ locationType: 'ward', locationId: 'north-1' }],
    }))).rejects.toThrow(/unexpected: ed\/main/);

    await expect(publishContinuityPackSet(publication({
      root: validationRoot,
      requiredCoverage: [
        { locationType: 'ward', locationId: 'north-1' },
        { locationType: 'WARD', locationId: 'NORTH-1' },
      ],
      assets: wardOnly,
    }))).rejects.toThrow(/duplicate coverage/);

    await expect(publishContinuityPackSet(publication({
      root: validationRoot,
      requiredCoverage: [{ locationType: 'ward', locationId: 'north-1' }],
      assets: [
        ...wardOnly,
        {
          locationType: 'WARD',
          locationId: 'NORTH-1',
          fileName: 'PACK.JSON',
          content: 'duplicate path',
        },
      ],
    }))).rejects.toThrow(/duplicate relative path/);

    await expect(fs.lstat(path.join(validationRoot, 'continuity-v1')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows multiple assets for one produced location while counting coverage once', () => {
    expect(assertExactCoverage(
      [{ locationType: 'ward', locationId: '1' }],
      [
        { locationType: 'ward', locationId: '1', fileName: 'pack.json' },
        { locationType: 'ward', locationId: '1', fileName: 'pack.html' },
      ],
    )).toEqual({
      required: [{ locationType: 'ward', locationId: '1' }],
      produced: [{ locationType: 'ward', locationId: '1' }],
    });
  });

  it('publishes an explicitly empty coverage set as a complete manifest-only set', async () => {
    const result = await publishContinuityPackSet(publication({
      root,
      requiredCoverage: [],
      assets: [],
    }));
    const pointer = JSON.parse(await fs.readFile(result.paths.currentPath, 'utf8'));

    expect(result.coverage).toEqual([]);
    expect(result.assets).toEqual([]);
    expect(pointer.set).toBe('sets/v1');
    expect(await fs.readFile(result.paths.manifestPath, 'utf8'))
      .toBe('{"signature":"already-signed"}');
    await expect(fs.lstat(result.paths.locationsDir))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['location type', { locationType: '../ward', locationId: '1' }, 'pack.json'],
    ['location identifier', { locationType: 'ward', locationId: '..' }, 'pack.json'],
    ['asset filename', { locationType: 'ward', locationId: '1' }, '../pack.json'],
    ['absolute asset filename', { locationType: 'ward', locationId: '1' }, 'C:\\escape.json'],
  ])('rejects traversal through %s', async (_label, location, fileName) => {
    const traversalRoot = path.join(root, 'traversal');
    await expect(publishContinuityPackSet(publication({
      root: traversalRoot,
      requiredCoverage: [location],
      assets: [{ ...location, fileName, content: '' }],
    }))).rejects.toThrow(/unsafe|traversal|stay within/);
    await expect(fs.lstat(path.join(traversalRoot, 'continuity-v1')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid tenant/facility/version identities and never falls back to temp storage', async () => {
    expect(() => buildContinuityPackPaths({
      root: '',
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 1,
    })).toThrow(/explicit/);
    expect(() => buildContinuityPackPaths({
      root,
      tenantId: DEFAULT_TENANT_ID,
      facilityId: FACILITY_ID,
      manifestVersion: 1,
    })).toThrow(/default tenant/);
    expect(() => buildContinuityPackPaths({
      root,
      tenantId: 'not-a-uuid',
      facilityId: FACILITY_ID,
      manifestVersion: 1,
    })).toThrow(/UUID/);
    expect(() => buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: 0,
      manifestVersion: 1,
    })).toThrow(/facilityId/);
    expect(() => buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: -1,
    })).toThrow(/manifestVersion/);
    expect(buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: '9007199254740993',
    })).toMatchObject({
      manifestVersion: '9007199254740993',
      setName: 'v9007199254740993',
    });
  });

  it('leaves the previous pointer unchanged after an injected asset write failure', async () => {
    const previous = await publishContinuityPackSet(publication({ root }));
    const oldPointer = await fs.readFile(previous.paths.currentPath);
    const writeFile = async (target, ...args) => {
      if (String(target).endsWith(`${path.sep}pack.html`)) {
        throw injectedError('injected asset write failure');
      }
      return fs.writeFile(target, ...args);
    };

    await expect(publishContinuityPackSet(publication({
      root,
      manifestVersion: 2,
      fsOps: { writeFile },
    }))).rejects.toThrow('injected asset write failure');

    expect((await fs.readFile(previous.paths.currentPath)).equals(oldPointer)).toBe(true);
    const nextPaths = buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 2,
    });
    await expect(fs.lstat(nextPaths.setDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(nextPaths.setsDir)).filter((name) => name.includes('staging')))
      .toEqual([]);
  });

  it('restores the previous pointer when pointer rename mutates then reports failure', async () => {
    const previous = await publishContinuityPackSet(publication({ root }));
    const oldPointer = await fs.readFile(previous.paths.currentPath);
    let injected = false;
    const rename = async (source, destination) => {
      await fs.rename(source, destination);
      if (!injected && destination === previous.paths.currentPath) {
        injected = true;
        throw injectedError('injected pointer rename failure');
      }
    };

    await expect(publishContinuityPackSet(publication({
      root,
      manifestVersion: 2,
      fsOps: { rename },
    }))).rejects.toThrow('injected pointer rename failure');

    expect(injected).toBe(true);
    expect((await fs.readFile(previous.paths.currentPath)).equals(oldPointer)).toBe(true);
    const nextPaths = buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 2,
    });
    await expect(fs.lstat(nextPaths.setDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a first-publication pointer when rename mutates then reports failure', async () => {
    const paths = buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 1,
    });
    const commitEvidence = jest.fn().mockResolvedValue(undefined);
    let injected = false;
    const rename = async (source, destination) => {
      await fs.rename(source, destination);
      if (!injected && destination === paths.currentPath) {
        injected = true;
        throw injectedError('injected first pointer rename failure');
      }
    };

    await expect(publishContinuityPackSet(publication({
      root,
      commitEvidence,
      fsOps: { rename },
    }))).rejects.toThrow('injected first pointer rename failure');

    expect(injected).toBe(true);
    expect(commitEvidence).toHaveBeenCalledTimes(1);
    await expect(fs.lstat(paths.currentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(paths.setDir)).resolves.toBeDefined();
  });

  it('leaves the previous pointer unchanged after an injected readback failure', async () => {
    const previous = await publishContinuityPackSet(publication({ root }));
    const oldPointer = await fs.readFile(previous.paths.currentPath);
    const readFile = async (target, ...args) => {
      if (
        String(target).includes('.v2.staging-')
        && String(target).endsWith(`${path.sep}pack.json`)
      ) {
        throw injectedError('injected asset readback failure');
      }
      return fs.readFile(target, ...args);
    };

    await expect(publishContinuityPackSet(publication({
      root,
      manifestVersion: 2,
      fsOps: { readFile },
    }))).rejects.toThrow('injected asset readback failure');

    expect((await fs.readFile(previous.paths.currentPath)).equals(oldPointer)).toBe(true);
    const nextPaths = buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 2,
    });
    await expect(fs.lstat(nextPaths.setDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves the previous pointer unchanged after an edge-access readback failure', async () => {
    const previous = await publishContinuityPackSet(publication({ root }));
    const oldPointer = await fs.readFile(previous.paths.currentPath);
    const readFile = async (target, ...args) => {
      if (
        String(target).includes('.v2.staging-')
        && String(target).endsWith(`${path.sep}edge-access.json`)
      ) {
        throw injectedError('injected edge-access readback failure');
      }
      return fs.readFile(target, ...args);
    };

    await expect(publishContinuityPackSet(publication({
      root,
      manifestVersion: 2,
      rootAssets: [{
        relativePath: 'edge-access.json',
        content: '{"schema":"vhhealth_continuity_edge_access/v1"}\n',
      }],
      fsOps: { readFile },
    }))).rejects.toThrow('injected edge-access readback failure');

    expect((await fs.readFile(previous.paths.currentPath)).equals(oldPointer)).toBe(true);
    const nextPaths = buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 2,
    });
    await expect(fs.lstat(nextPaths.setDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never exposes a current pointer to a half-written first set', async () => {
    const paths = buildContinuityPackPaths({
      root,
      tenantId: TENANT_A,
      facilityId: FACILITY_ID,
      manifestVersion: 1,
    });
    let writes = 0;
    const writeFile = async (target, ...args) => {
      writes += 1;
      if (writes === 2) throw injectedError('injected mid-set failure');
      return fs.writeFile(target, ...args);
    };

    await expect(publishContinuityPackSet(publication({
      root,
      fsOps: { writeFile },
    }))).rejects.toThrow('injected mid-set failure');

    await expect(fs.lstat(paths.currentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(paths.setDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(paths.setsDir)).filter((name) => name.includes('staging')))
      .toEqual([]);
  });

  it('builds only location-contained asset paths', () => {
    expect(buildContinuityAssetRelativePath(
      { locationType: 'WARD', locationId: 'North-1' },
      'print/Pack.HTML',
    )).toBe('locations/ward/north-1/print/pack.html');
  });
});
