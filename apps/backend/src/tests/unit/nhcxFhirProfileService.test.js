import fs from 'node:fs';
import path from 'node:path';
import {
  assertNHCXOutboundBundle,
  payloadHash,
  validateNHCXInboundBundle,
  validateNHCXOutboundBundle,
} from '../../services/nhcx/nhcxFhirProfileService.js';

const samplesDir = path.join(process.cwd(), 'src/services/fhir/__samples__');

function loadSample(filename) {
  return JSON.parse(fs.readFileSync(path.join(samplesDir, filename), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mainResource(bundle, resourceType) {
  return bundle.entry.map((item) => item.resource).find((resource) => resource.resourceType === resourceType);
}

describe('nhcxFhirProfileService', () => {
  it('accepts the design-target CoverageEligibilityRequest fixture', () => {
    const bundle = loadSample('nhcx_coverageeligibility_request_bundle.json');

    const result = validateNHCXOutboundBundle(bundle, {
      expectedMainResourceType: 'CoverageEligibilityRequest',
    });

    expect(result).toMatchObject({
      valid: true,
      entryCount: 6,
      issues: [],
    });
  });

  it('accepts the design-target preauth Claim fixture', () => {
    const bundle = loadSample('nhcx_preauth_claim_request_bundle.json');

    const result = validateNHCXOutboundBundle(bundle, {
      expectedMainResourceType: 'Claim',
    });

    expect(result).toMatchObject({
      valid: true,
      entryCount: 6,
      issues: [],
    });
    expect(mainResource(bundle, 'Claim').use).toBe('preauthorization');
  });

  it('rejects preauth Claim bundles that are not preauthorization requests', () => {
    const bundle = loadSample('nhcx_preauth_claim_request_bundle.json');
    mainResource(bundle, 'Claim').use = 'claim';

    expect(() => assertNHCXOutboundBundle(bundle, {
      expectedMainResourceType: 'Claim',
    })).toThrow(expect.objectContaining({
      code: 'NHCX_FHIR_PROFILE_INVALID',
      statusCode: 400,
    }));
  });

  it('hashes payloads canonically across object key ordering', () => {
    const left = {
      z: ['last', { b: 2, a: 1 }],
      a: { d: true, c: null },
    };
    const right = {
      a: { c: null, d: true },
      z: ['last', { a: 1, b: 2 }],
    };

    expect(payloadHash(left)).toBe(payloadHash(right));
  });

  it('downgrades inbound profile issues to warnings for callback triage', () => {
    const bundle = clone(loadSample('nhcx_preauth_claim_request_bundle.json'));
    mainResource(bundle, 'Claim').use = 'claim';

    const result = validateNHCXInboundBundle(bundle, {
      expectedMainResourceType: 'Claim',
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'Claim.use',
        severity: 'warning',
      }),
    ]));
  });

  it('accepts inbound PaymentNotice bundles for finance review capture', () => {
    const bundle = {
      resourceType: 'Bundle',
      id: 'payment-notice-bundle',
      meta: {
        profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/PaymentNoticeBundle'],
      },
      type: 'collection',
      entry: [{
        resource: {
          resourceType: 'PaymentNotice',
          id: 'payment-notice-1',
          status: 'active',
          created: '2026-07-06T12:00:00.000Z',
          request: { reference: 'Claim/claim-88' },
          payment: { identifier: { value: 'UTR-1' } },
          amount: { value: 42000, currency: 'INR' },
        },
      }],
    };

    const result = validateNHCXInboundBundle(bundle, {
      expectedMainResourceType: 'PaymentNotice',
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
