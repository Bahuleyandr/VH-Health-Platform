import { jest } from '@jest/globals';

const resolveContext = jest.fn();
const evaluateAction = jest.fn();

jest.unstable_mockModule('../../config/downtimeConfig.js', () => ({
  clinicalContinuityActionRegistryEnabled: () => true,
  clinicalContinuityFacilityContextEnabled: () => true,
}));
jest.unstable_mockModule(
  '../../services/downtime/clinicalContinuityFacilityContextService.js',
  () => ({
    decodeClinicalContinuityFacilityContextHeader: value => ({
      encoded: value,
    }),
    resolveClinicalContinuityFacilityContext: resolveContext,
  }),
);
jest.unstable_mockModule(
  '../../services/downtime/clinicalContinuityActionRegistryService.js',
  () => ({
    evaluateClinicalContinuityActionRequest: evaluateAction,
  }),
);
jest.unstable_mockModule(
  '../../services/downtime/clinicalContinuityActionBindingRegistry.js',
  () => ({
    resolveClinicalContinuityActionBinding: () => ({ binding: 'exact' }),
    resolveClinicalContinuityRouteTemplate: () => '/api/v1/vitals',
  }),
);
const { clinicalContinuityActionPolicyMiddleware } = await import(
  '../../middleware/clinicalContinuityActionPolicyMiddleware.js'
);

test('C4.2 consumes only the exact server-owned C5.1 facility seam', async () => {
  const seam = Object.freeze({
    contextId: 'context',
    contextRevision: '9',
    tenantId: 'tenant',
    facilityId: 41,
    grantId: 'grant',
    grantPurpose: 'capture_staff_facility',
    captureRevision: '8',
    actorUid: 'actor',
    deviceId: 'device',
    sessionJtiSha256: 'hash',
    policyId: 'policy',
    policyVersion: '7',
    policyChecksum: 'checksum',
    policySigningKeyId: 'key',
    revocationEpoch: '6',
    issuedAt: '2026-07-30T00:00:00.000Z',
    effectiveFrom: '2026-07-30T00:00:00.000Z',
    expiresAt: '2026-07-30T01:00:00.000Z',
  });
  resolveContext.mockImplementation(async ({ req }) => {
    Object.defineProperty(req, 'continuityFacilityContext', {
      configurable: false,
      enumerable: true,
      value: seam,
      writable: false,
    });
    return req.continuityFacilityContext;
  });
  evaluateAction.mockResolvedValue({ proceed: true });
  const headers = {
    'x-vh-continuity-action-id': 'vitals.capture',
    'x-vh-continuity-facility-context': 'canonical-context',
    'x-vh-continuity-facility-id': '41',
    'x-vh-continuity-policy-version': '7',
    'x-vh-continuity-registry-version': '3',
    'x-vh-continuity-revocation-epoch': '6',
  };
  const req = {
    body: { facilityId: 99 },
    get: name => headers[name.toLowerCase()],
    id: 'request-1',
    method: 'POST',
    path: '/api/v1/vitals',
    tenantId: 'tenant',
    user: { deviceType: 'tablet', role: 'NURSE', uid: 'actor' },
  };
  const next = jest.fn();

  await clinicalContinuityActionPolicyMiddleware(req, {}, next);

  expect(resolveContext).toHaveBeenCalledWith({
    req,
    envelope: { encoded: 'canonical-context' },
    clientFacilityId: 41,
  });
  expect(evaluateAction).toHaveBeenCalledWith(
    expect.objectContaining({
      facilityId: 41,
      tenantId: 'tenant',
    }),
  );
  expect(evaluateAction).not.toHaveBeenCalledWith(
    expect.objectContaining({ facilityId: 99 }),
  );
  expect(req.continuityFacilityContext).toBe(seam);
  expect(next).toHaveBeenCalledWith();
});
