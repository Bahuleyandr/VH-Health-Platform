import {
  createHash,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRuntimeVerifier } from '../../tools/build-runtime-verifier.mjs';

export const TENANT_ID = '52e31913-c846-4458-a21b-31cd2f457e9b';
export const FACILITY_ID = 41;
export const POLICY_ID = '55555555-5555-4555-8555-555555555555';
export const PACK_KEY_ID = 'continuity-pack-current-k1';
export const POLICY_KEY_ID = 'continuity-policy-current-k1';
export const TRUSTED_NOW = '2026-07-30T00:01:00.000Z';

function pemSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function createTestRuntime() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vh-edge-runtime-'));
  await buildRuntimeVerifier({ out: root });
  const nonce = `?test=${randomUUID()}`;
  const [canonical, publication, verifier] = await Promise.all([
    import(`${pathToFileURL(path.join(root, 'continuityPackCanonical.js')).href}${nonce}`),
    import(`${pathToFileURL(path.join(root, 'continuityPackPublicationService.js')).href}${nonce}`),
    import(`${pathToFileURL(path.join(root, 'continuityEdgeMirrorVerifier.js')).href}${nonce}`),
  ]);
  return {
    root,
    canonical,
    publication,
    verifier,
    verifyContinuityEdgeMirror: verifier.verifyContinuityEdgeMirror,
  };
}

export function newSigningKeys() {
  return {
    pack: generateKeyPairSync('ed25519'),
    policy: generateKeyPairSync('ed25519'),
  };
}

export async function buildMirror({
  runtime,
  root,
  signingKeys = newSigningKeys(),
  manifestVersion = '9',
  policyVersion = '7',
  revocationEpoch = '3',
  accessRevision = '11',
  issuedAt = '2026-07-30T00:00:00.000Z',
  expiresAt = '2026-07-30T04:00:00.000Z',
  edgeGrants = [],
  edgeRevocations = [],
  retention = {
    sourcePackRetentionHours: 24,
    edgePackRetentionHours: 12,
    accessLogRetentionHours: 168,
  },
} = {}) {
  if (!runtime) throw new TypeError('runtime is required');
  const mirrorRoot =
    root || (await mkdtemp(path.join(os.tmpdir(), 'vh-edge-mirror-')));
  const { canonical, publication } = runtime;
  const packPublicKey = signingKeys.pack.publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  const policyPublicKey = signingKeys.policy.publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  const audience = {
    tenantId: TENANT_ID,
    facilityId: String(FACILITY_ID),
  };
  const edgeAccessDecisions = {
    authenticationMode: 'mtls_client_certificate',
    credentialLifetimeMinutes: 480,
    emergencyReadPosture: 'read_only',
    maximumOfflineAuthorizationMinutes: 60,
  };
  const policyDocument = {
    audience,
    edgeAccess: edgeAccessDecisions,
    fieldPolicy: {},
    generation: {},
    includedAreas: ['patient_identity', 'medications', 'recent_results'],
    medicationsDueWindow: {},
    packSchemaVersion: 1,
    policySchemaVersion: 2,
    policyType: 'clinical_continuity_pack',
    recentReleasedResults: {},
    requiredCoverage: [{ locationType: 'ward', locationId: 'ward-10' }],
    retention,
  };
  const policyChecksum = canonical.hashCanonicalValue(policyDocument);
  const policyPayload = {
    algorithm: 'Ed25519',
    audience,
    canonicalization: 'rfc8785-jcs',
    currentPackSigningKeyId: PACK_KEY_ID,
    currentPackSigningPublicKeySha256: pemSha256(packPublicKey),
    effectiveFrom: issuedAt,
    effectiveUntil: null,
    nextPackSigningKeyId: null,
    nextPackSigningPublicKeySha256: null,
    policyChecksum,
    policyDocument,
    policySchemaVersion: 2,
    policySigningKeyId: POLICY_KEY_ID,
    policySigningPublicKeySha256: pemSha256(policyPublicKey),
    policyVersion,
    revocationEpoch,
    revokedKeyIds: [],
    supersedesPolicyId: null,
  };
  const policyReceipt = {
    format: 'vhhealth_continuity_policy_receipt/v1',
    payload: policyPayload,
    policyId: POLICY_ID,
    signature: canonical.signCanonicalValue(
      policyPayload,
      signingKeys.policy.privateKey,
    ),
  };

  function signedEnvelope(content, rendered) {
    return canonical.createSignedPackEnvelope({
      audience,
      content,
      rendered,
      keyId: PACK_KEY_ID,
      manifestVersion,
      policyVersion,
      revocationEpoch,
      issuedAt,
      expiresAt,
      privateKey: signingKeys.pack.privateKey,
    });
  }

  const pack = {
    kind: 'ward-pack',
    tenantId: TENANT_ID,
    facilityId: String(FACILITY_ID),
  };
  const html = '<!doctype html><title>Verified ward pack</title>';
  const packEnvelope = signedEnvelope(pack, html);
  const packJson = `${canonical.canonicalizeJson(packEnvelope)}\n`;
  const edgeAccess = {
    accessRevision,
    audience,
    edgeAccess: edgeAccessDecisions,
    format: 'vhhealth_continuity_edge_access/v1',
    generatedAt: issuedAt,
    grants: edgeGrants,
    policy: { id: POLICY_ID, version: policyVersion, revocationEpoch },
    revocations: edgeRevocations,
  };
  const edgeRendered = canonical.canonicalizeJson(edgeAccess);
  const edgeEnvelope = signedEnvelope(edgeAccess, edgeRendered);
  const edgeJson = `${canonical.canonicalizeJson(edgeEnvelope)}\n`;
  const manifest = {
    edgeAccess: {
      accessRevision,
      path: 'edge-access.json',
      sha256: canonical.sha256Hex(edgeJson),
    },
    facility: {
      id: String(FACILITY_ID),
      name: 'VH Central',
      timezone: 'Asia/Kolkata',
    },
    format: 'vhhealth_clinical_continuity_manifest/v1',
    generatedAt: issuedAt,
    locations: [
      {
        contentHash: packEnvelope.contentHash,
        expiresAt,
        generatedAt: issuedAt,
        keyId: PACK_KEY_ID,
        locationId: 'ward-10',
        locationType: 'ward',
        packHtmlSha256: canonical.sha256Hex(html),
        packJsonSha256: canonical.sha256Hex(packJson),
        renderHash: packEnvelope.renderHash,
      },
    ],
    manifestVersion,
    publicationSetId: randomUUID(),
    policy: {
      checksum: policyChecksum,
      id: POLICY_ID,
      revocationEpoch,
      version: policyVersion,
    },
    sourceWatermark: { generatedAt: issuedAt },
    tenantId: TENANT_ID,
  };
  const manifestEnvelope = signedEnvelope(
    manifest,
    canonical.canonicalizeJson(manifest),
  );
  const receipt = await publication.publishContinuityPackSet({
    root: mirrorRoot,
    tenantId: TENANT_ID,
    facilityId: FACILITY_ID,
    manifestVersion,
    requiredCoverage: [{ locationType: 'ward', locationId: 'ward-10' }],
    assets: [
      {
        locationType: 'ward',
        locationId: 'ward-10',
        relativePath: 'pack.json',
        content: packJson,
      },
      {
        locationType: 'ward',
        locationId: 'ward-10',
        relativePath: 'pack.html',
        content: html,
      },
    ],
    rootAssets: [{ relativePath: 'edge-access.json', content: edgeJson }],
    manifestContent: `${canonical.canonicalizeJson(manifestEnvelope)}\n`,
  });
  const trustedKeys = {
    packKeys: {
      [PACK_KEY_ID]: {
        algorithm: 'Ed25519',
        keyId: PACK_KEY_ID,
        publicKey: packPublicKey,
        state: 'current',
      },
    },
    policyKeys: {
      [POLICY_KEY_ID]: {
        algorithm: 'Ed25519',
        keyId: POLICY_KEY_ID,
        publicKey: policyPublicKey,
        state: 'active',
      },
    },
  };
  const floors = {
    tenantId: TENANT_ID,
    facilityId: FACILITY_ID,
    manifestVersion,
    policyVersion,
    revocationEpoch,
    accessRevision,
    trustedNow: issuedAt,
  };
  return {
    root: mirrorRoot,
    runtime,
    receipt,
    signingKeys,
    trustedKeys,
    policyReceipt,
    policyDocument,
    manifest,
    manifestEnvelope,
    edgeAccess,
    edgeEnvelope,
    floors,
    trustedNow: TRUSTED_NOW,
  };
}

export function verifyOptions(fixture, overrides = {}) {
  return {
    root: fixture.root,
    tenantId: TENANT_ID,
    facilityId: FACILITY_ID,
    trustedKeys: fixture.trustedKeys.packKeys,
    trustedNow: fixture.trustedNow,
    clockTrusted: true,
    persistedFloors: fixture.floors,
    ...overrides,
  };
}

export function facilityDirectory(root) {
  return path.join(
    root,
    'continuity-v1',
    'tenants',
    TENANT_ID,
    'facilities',
    String(FACILITY_ID),
  );
}

export function localSource(root) {
  const facility = facilityDirectory(root);
  return {
    async readFile(relativePath) {
      return readFile(path.join(facility, relativePath));
    },
    async copySet(relativeSet, destination) {
      await mkdir(destination, { recursive: true });
      const source = path.join(facility, relativeSet);
      for (const entry of await readdir(source)) {
        await cp(path.join(source, entry), path.join(destination, entry), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
    },
  };
}
