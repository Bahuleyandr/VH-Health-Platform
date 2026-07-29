import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLINICAL_CONTINUITY_SEED_FIXTURE } from '../../../scripts/lib/clinicalContinuitySeedFixture.mjs';
import {
  CLINICAL_CONTINUITY_POLICY_CANONICALIZATION,
  DEFAULT_TENANT_ID,
  buildClinicalContinuityPolicySigningPayload,
  parseClinicalContinuityPolicyDocument,
} from '../../services/downtime/clinicalContinuityPolicyService.js';
import {
  hashCanonicalValue,
  sha256Hex,
  verifyCanonicalValue,
} from '../../services/downtime/continuityPackCanonical.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seederPath = path.resolve(__dirname, '../../../scripts/seed-comprehensive-test-data.mjs');

describe('clinical continuity comprehensive-seed fixture', () => {
  test('is a valid public-only signed draft for a suspended non-default tenant', () => {
    const fixture = CLINICAL_CONTINUITY_SEED_FIXTURE;
    expect(fixture.tenantId).not.toBe(DEFAULT_TENANT_ID);
    expect(fixture.policyDocument.audience).toEqual({
      tenantId: fixture.tenantId,
      facilityId: String(fixture.facilityId),
    });
    expect(parseClinicalContinuityPolicyDocument(fixture.policyDocument, {
      tenantId: fixture.tenantId,
      facilityId: fixture.facilityId,
      policySchemaVersion: 1,
    })).toEqual(fixture.policyDocument);
    expect(hashCanonicalValue(fixture.policyDocument)).toBe(fixture.policyChecksum);
    expect(sha256Hex(fixture.policySigningPublicKey))
      .toBe(fixture.policySigningPublicKeySha256);
    expect(sha256Hex(fixture.currentPackSigningPublicKey))
      .toBe(fixture.currentPackSigningPublicKeySha256);

    const payload = buildClinicalContinuityPolicySigningPayload({
      tenantId: fixture.tenantId,
      facilityId: fixture.facilityId,
      policyVersion: 1,
      policySchemaVersion: 1,
      policyDocument: fixture.policyDocument,
      policyChecksum: fixture.policyChecksum,
      canonicalization: CLINICAL_CONTINUITY_POLICY_CANONICALIZATION,
      signatureAlgorithm: 'ed25519',
      policySigningKeyId: fixture.policySigningKeyId,
      policySigningPublicKeySha256: fixture.policySigningPublicKeySha256,
      currentPackSigningKeyId: fixture.currentPackSigningKeyId,
      currentPackSigningPublicKeySha256: fixture.currentPackSigningPublicKeySha256,
      nextPackSigningKeyId: null,
      nextPackSigningPublicKeySha256: null,
      revocationEpoch: 0,
      revokedKeyIds: [],
      effectiveFrom: fixture.effectiveFrom,
      effectiveUntil: null,
      supersedesPolicyId: null,
    });
    expect(verifyCanonicalValue(
      payload,
      fixture.policySignature,
      createPublicKey(fixture.policySigningPublicKey),
    )).toBe(true);
    expect(JSON.stringify(fixture)).not.toMatch(/private[_-]?key/i);
  });

  test('manual seeding stays draft-only and creates no governed publication', () => {
    const source = readFileSync(seederPath, 'utf8');
    expect(source).toContain("'clinical_continuity_policy_versions'");
    expect(source).toContain("'downtime_snapshots'");
    expect(source).toContain("1, 1, 'draft'");
    expect(source).toContain("scope: 'patient_chart'");
    expect(source).toContain('governedContinuityPublication: false');
    expect(source).toContain("tenant_id = $1::uuid AND role = 'PATIENT'");
    expect(source).toContain('patient_uid: defaultTenantPatient.uid');
    expect(source).not.toMatch(/generateKeyPair|privateKey/);
  });
});
