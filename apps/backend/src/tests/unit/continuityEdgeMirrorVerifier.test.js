import { generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EDGE_MIRROR_VERIFICATION_REASONS,
  __testing__,
  verifyContinuityEdgeMirror
} from '../../services/downtime/continuityEdgeMirrorVerifier.js';
import {
  KEY_STATES,
  SIGNATURE_ALGORITHM,
  VERIFICATION_REASONS,
  canonicalizeJson,
  createSignedPackEnvelope,
  sha256Hex
} from '../../services/downtime/continuityPackCanonical.js';
import { publishContinuityPackSet } from '../../services/downtime/continuityPackPublicationService.js';
import {
  CLINICAL_CONTINUITY_MANIFEST_FORMAT
} from '../../services/downtime/clinicalContinuityPackOrchestrationService.js';
import {
  CONTINUITY_EDGE_ACCESS_FORMAT
} from '../../services/downtime/continuityEdgeAccessService.js';

const TENANT = '52e31913-c846-4458-a21b-31cd2f457e9b';
const FACILITY = 41;
const POLICY_ID = '55555555-5555-4555-8555-555555555555';
const ISSUED_AT = '2026-07-30T00:00:00.000Z';
const TRUSTED_NOW = '2026-07-30T00:01:00.000Z';
const EXPIRES_AT = '2026-07-30T04:00:00.000Z';
const KEY_ID = 'continuity-pack-current-k1';

let roots = [];

afterEach(async () => {
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
  roots = [];
});

function signedEnvelope(content, rendered, privateKey) {
  return createSignedPackEnvelope({
    audience: { tenantId: TENANT, facilityId: String(FACILITY) },
    content,
    rendered,
    keyId: KEY_ID,
    manifestVersion: '9',
    policyVersion: '7',
    revocationEpoch: '3',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    privateKey
  });
}

async function buildMirror({
  edgeGrants = [],
  edgePolicyVersion = '7',
  manifestPolicyVersion = '7'
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-edge-verifier-'));
  roots.push(root);
  const keys = generateKeyPairSync('ed25519');
  const pack = { kind: 'ward-pack', tenantId: TENANT, facilityId: String(FACILITY) };
  const html = '<!doctype html><title>Verified ward pack</title>';
  const packEnvelope = signedEnvelope(pack, html, keys.privateKey);
  const packJson = `${canonicalizeJson(packEnvelope)}\n`;
  const edgeAccess = {
    accessRevision: '11',
    audience: { tenantId: TENANT, facilityId: String(FACILITY) },
    edgeAccess: {
      authenticationMode: 'mtls_client_certificate',
      credentialLifetimeMinutes: 480,
      emergencyReadPosture: 'read_only',
      maximumOfflineAuthorizationMinutes: 60
    },
    format: CONTINUITY_EDGE_ACCESS_FORMAT,
    generatedAt: ISSUED_AT,
    grants: edgeGrants,
    policy: { id: POLICY_ID, version: edgePolicyVersion, revocationEpoch: '3' },
    revocations: []
  };
  const edgeRendered = canonicalizeJson(edgeAccess);
  const edgeEnvelope = signedEnvelope(edgeAccess, edgeRendered, keys.privateKey);
  const edgeJson = `${canonicalizeJson(edgeEnvelope)}\n`;
  const location = {
    contentHash: packEnvelope.contentHash,
    expiresAt: EXPIRES_AT,
    generatedAt: ISSUED_AT,
    keyId: KEY_ID,
    locationId: 'ward-10',
    locationType: 'ward',
    packHtmlSha256: sha256Hex(html),
    packJsonSha256: sha256Hex(packJson),
    renderHash: packEnvelope.renderHash
  };
  const manifest = {
    edgeAccess: {
      accessRevision: '11',
      path: 'edge-access.json',
      sha256: sha256Hex(edgeJson)
    },
    facility: {
      id: String(FACILITY),
      name: 'VH Central',
      timezone: 'Asia/Kolkata'
    },
    format: CLINICAL_CONTINUITY_MANIFEST_FORMAT,
    generatedAt: ISSUED_AT,
    locations: [location],
    manifestVersion: '9',
    publicationSetId: randomUUID(),
    policy: {
      checksum: 'a'.repeat(64),
      id: POLICY_ID,
      revocationEpoch: '3',
      version: manifestPolicyVersion
    },
    sourceWatermark: { generatedAt: ISSUED_AT },
    tenantId: TENANT
  };
  const manifestRendered = canonicalizeJson(manifest);
  const manifestEnvelope = signedEnvelope(
    manifest,
    manifestRendered,
    keys.privateKey
  );
  const receipt = await publishContinuityPackSet({
    root,
    tenantId: TENANT,
    facilityId: FACILITY,
    manifestVersion: '9',
    requiredCoverage: [{ locationType: 'ward', locationId: 'ward-10' }],
    assets: [
      {
        locationType: 'ward',
        locationId: 'ward-10',
        relativePath: 'pack.json',
        content: packJson
      },
      {
        locationType: 'ward',
        locationId: 'ward-10',
        relativePath: 'pack.html',
        content: html
      }
    ],
    rootAssets: [{ relativePath: 'edge-access.json', content: edgeJson }],
    manifestContent: `${canonicalizeJson(manifestEnvelope)}\n`
  });
  return {
    root,
    receipt,
    trustedKeys: {
      [KEY_ID]: {
        algorithm: SIGNATURE_ALGORITHM,
        publicKey: keys.publicKey,
        state: KEY_STATES.CURRENT
      }
    }
  };
}

function verifyOptions(fixture, overrides = {}) {
  return {
    root: fixture.root,
    tenantId: TENANT,
    facilityId: FACILITY,
    trustedKeys: fixture.trustedKeys,
    trustedNow: TRUSTED_NOW,
    clockTrusted: true,
    persistedFloors: {
      manifestVersion: '9',
      policyVersion: '7',
      revocationEpoch: '3',
      accessRevision: '11',
      trustedNow: ISSUED_AT
    },
    ...overrides
  };
}

describe('continuity edge mirror verifier', () => {
  test('verifies pointer, signed manifest, every asset, coverage, and access floor', async () => {
    const fixture = await buildMirror();
    const result = await verifyContinuityEdgeMirror(verifyOptions(fixture));

    expect(result).toMatchObject({
      ok: true,
      reason: null,
      tenantId: TENANT,
      facilityId: FACILITY,
      manifestVersion: '9',
      policyVersion: '7',
      revocationEpoch: '3',
      accessRevision: '11',
      coverage: ['ward/ward-10']
    });
  });

  test('rejects a per-asset hash mismatch and an undeclared file', async () => {
    const fixture = await buildMirror();
    await fs.writeFile(
      path.join(fixture.receipt.paths.setDir, 'locations', 'ward', 'ward-10', 'pack.html'),
      'tampered',
      'utf8'
    );
    await expect(verifyContinuityEdgeMirror(verifyOptions(fixture))).resolves.toMatchObject({
      ok: false,
      reason: EDGE_MIRROR_VERIFICATION_REASONS.ASSET_HASH_MISMATCH
    });

    const second = await buildMirror();
    await fs.writeFile(path.join(second.receipt.paths.setDir, 'extra.json'), '{}', 'utf8');
    await expect(verifyContinuityEdgeMirror(verifyOptions(second))).resolves.toMatchObject({
      ok: false,
      reason: EDGE_MIRROR_VERIFICATION_REASONS.ASSET_EXTRA
    });
  });

  test('rejects an access-revision rollback independently of C3.1 floors', async () => {
    const fixture = await buildMirror();
    const options = verifyOptions(fixture);
    options.persistedFloors.accessRevision = '12';

    await expect(verifyContinuityEdgeMirror(options)).resolves.toMatchObject({
      ok: false,
      reason: EDGE_MIRROR_VERIFICATION_REASONS.ACCESS_REVISION_ROLLBACK
    });
  });

  test('preserves KEY_INVALID for unusable trusted key material', async () => {
    const fixture = await buildMirror();
    fixture.trustedKeys[KEY_ID].publicKey = 'not-an-ed25519-public-key';

    await expect(verifyContinuityEdgeMirror(verifyOptions(fixture))).resolves.toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.KEY_INVALID
    });
  });

  test('preserves CANONICALIZATION_FAILED for hostile signed content', async () => {
    const fixture = await buildMirror();
    const manifestEnvelope = JSON.parse(
      await fs.readFile(fixture.receipt.paths.manifestPath, 'utf8')
    );
    manifestEnvelope.content = { hostile: '\ud800' };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifestEnvelope)}\n`, 'utf8');
    await fs.writeFile(fixture.receipt.paths.manifestPath, manifestBytes);

    const pointer = JSON.parse(
      await fs.readFile(fixture.receipt.paths.currentPath, 'utf8')
    );
    pointer.manifest_sha256 = sha256Hex(manifestBytes);
    await fs.writeFile(fixture.receipt.paths.currentPath, JSON.stringify(pointer), 'utf8');

    await expect(verifyContinuityEdgeMirror(verifyOptions(fixture))).resolves.toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.CANONICALIZATION_FAILED
    });
  });

  test('rejects signed inner policy metadata that disagrees with its envelope', async () => {
    const fixture = await buildMirror({
      edgePolicyVersion: '6',
      manifestPolicyVersion: '6'
    });

    await expect(verifyContinuityEdgeMirror(verifyOptions(fixture))).resolves.toMatchObject({
      ok: false,
      reason: EDGE_MIRROR_VERIFICATION_REASONS.MANIFEST_INVALID
    });
  });

  test('rejects an overlong grant even when its signed envelope is valid', async () => {
    const fixture = await buildMirror({
      edgeGrants: [{
        accessRevision: '11',
        clientCertificateSha256: 'a'.repeat(64),
        deviceId: 'edge-1',
        grantId: '11111111-1111-4111-8111-111111111111',
        locationIdentifier: 'ward-10',
        locationType: 'ward',
        staffUid: '22222222-2222-4222-8222-222222222222',
        validFrom: ISSUED_AT,
        validUntil: '2026-07-31T00:00:00.000Z'
      }]
    });

    await expect(verifyContinuityEdgeMirror(verifyOptions(fixture))).resolves.toMatchObject({
      ok: false,
      reason: EDGE_MIRROR_VERIFICATION_REASONS.EDGE_ACCESS_MISMATCH
    });
  });

  test('rejects a grant outside the signed manifest coverage', async () => {
    const fixture = await buildMirror({
      edgeGrants: [{
        accessRevision: '11',
        clientCertificateSha256: 'a'.repeat(64),
        deviceId: 'edge-1',
        grantId: '11111111-1111-4111-8111-111111111111',
        locationIdentifier: 'ward-99',
        locationType: 'ward',
        staffUid: '22222222-2222-4222-8222-222222222222',
        validFrom: ISSUED_AT,
        validUntil: EXPIRES_AT
      }]
    });

    await expect(verifyContinuityEdgeMirror(verifyOptions(fixture))).resolves.toMatchObject({
      ok: false,
      reason: EDGE_MIRROR_VERIFICATION_REASONS.EDGE_ACCESS_MISMATCH
    });
  });

  test('rejects malformed pointers before resolving an unsafe path', async () => {
    const fixture = await buildMirror();
    const pointer = JSON.parse(
      await fs.readFile(fixture.receipt.paths.currentPath, 'utf8')
    );
    pointer.set = '../sets/v9';
    await fs.writeFile(fixture.receipt.paths.currentPath, JSON.stringify(pointer), 'utf8');

    await expect(verifyContinuityEdgeMirror(verifyOptions(fixture))).resolves.toMatchObject({
      ok: false,
      reason: EDGE_MIRROR_VERIFICATION_REASONS.POINTER_INVALID
    });
  });

  test('classifies a symbolic-link entry as an escape', async () => {
    const result = await __testing__.walkRegularFiles(
      {
        readdir: async () => [{
          name: 'escape',
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false
        }]
      },
      'C:\\mirror'
    );
    expect(result).toMatchObject({
      ok: false,
      reason: EDGE_MIRROR_VERIFICATION_REASONS.SYMLINK_ESCAPE
    });
  });

  test('rejects a symbolic link in the tenant/facility directory chain', async () => {
    const mirrorRoot = path.resolve('mirror');
    const tenantDirectory = path.join(
      mirrorRoot,
      'continuity-v1',
      'tenants',
      'tenant-a'
    );
    const tenantsSuffix = `${path.sep}tenants`;
    const result = await __testing__.safeDirectoryChain(
      {
        lstat: async candidate => ({
          isDirectory: () => !String(candidate).endsWith(tenantsSuffix),
          isSymbolicLink: () => String(candidate).endsWith(tenantsSuffix)
        }),
        realpath: async candidate => candidate
      },
      mirrorRoot,
      tenantDirectory
    );
    expect(result).toMatchObject({
      ok: false,
      reason: EDGE_MIRROR_VERIFICATION_REASONS.SYMLINK_ESCAPE
    });
  });

  test('rejects malformed signed edge grant-set content before activation', () => {
    expect(__testing__.edgeAccessContentRevision({
      accessRevision: '11',
      audience: { tenantId: TENANT, facilityId: String(FACILITY) },
      edgeAccess: {
        authenticationMode: 'mtls_client_certificate',
        credentialLifetimeMinutes: 480,
        emergencyReadPosture: 'read_only',
        maximumOfflineAuthorizationMinutes: 60
      },
      format: CONTINUITY_EDGE_ACCESS_FORMAT,
      generatedAt: ISSUED_AT,
      grants: [{
        accessRevision: '11',
        clientCertificateSha256: 'a'.repeat(64),
        deviceId: 'edge-1',
        grantId: 'not-a-uuid',
        locationIdentifier: 'ward-10',
        locationType: 'ward',
        staffUid: '22222222-2222-4222-8222-222222222222',
        validFrom: ISSUED_AT,
        validUntil: EXPIRES_AT
      }],
      policy: {
        id: POLICY_ID,
        revocationEpoch: '3',
        version: '7'
      },
      revocations: []
    }, TENANT, FACILITY)).toBeNull();
  });

  test('preserves every C3.1 canonical verification reason', () => {
    expect(Object.values(EDGE_MIRROR_VERIFICATION_REASONS)).toEqual(
      expect.arrayContaining(Object.values(VERIFICATION_REASONS))
    );
  });
});
