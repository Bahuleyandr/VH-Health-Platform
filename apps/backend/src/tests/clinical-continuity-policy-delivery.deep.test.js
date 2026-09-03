import { createHash } from 'node:crypto';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

import { canonicalizeJson } from '../services/downtime/continuityPackCanonical.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FACILITY = 41;
const MEDIA_TYPE = 'application/vnd.vhhealth.clinical-continuity-policy+json';
const policyDocument = {
  packSchemaVersion: 2,
  padding: 'x'.repeat(4096),
  policySchemaVersion: 3
};
const policyChecksum = createHash('sha256')
  .update(canonicalizeJson(policyDocument))
  .digest('hex');
const body = Buffer.from(canonicalizeJson({
  format: 'vhhealth_clinical_continuity_policy_delivery/v1',
  payload: { policyChecksum, policyDocument },
  policyId: '55555555-5555-4555-8555-555555555555',
  signature: Buffer.alloc(64, 7).toString('base64')
}));
const digest = createHash('sha256').update(body).digest();
const digestHex = digest.toString('hex');
const etag = `"pc-${policyChecksum}.rep-${digestHex}"`;
const loadDelivery = jest.fn().mockResolvedValue({
  body,
  contentDigest: `sha-256=:${digest.toString('base64')}:`,
  envelopeSha256: digestHex,
  etag,
  mediaType: MEDIA_TYPE,
  policyChecksum,
  trustedNow: '2026-07-31T10:00:00.000Z'
});

jest.unstable_mockModule(
  '../services/downtime/clinicalContinuityPolicyDeliveryService.js',
  () => ({
    loadClinicalContinuityPolicyDelivery: loadDelivery,
    ifNoneMatchMatches: (value, current) =>
      String(value || '').replace(/^W\//, '') === current
  })
);

jest.unstable_mockModule(
  '../services/downtime/clinicalContinuityFacilityContextService.js',
  () => ({
    CLINICAL_CONTINUITY_FACILITY_CONTEXT_FORMAT: 'test',
    CLINICAL_CONTINUITY_FACILITY_PROOF_FORMAT: 'test',
    ClinicalContinuityFacilityContextError: class extends Error {},
    issueClinicalContinuityFacilityContext: jest.fn(),
    enrollClinicalContinuityFacilityGrant: jest.fn(),
    listClinicalContinuityFacilityGrants: jest.fn(),
    revokeClinicalContinuityFacilityGrant: jest.fn(),
    decodeClinicalContinuityFacilityContextHeader: value => {
      if (value !== 'signed-context') throw new Error('invalid context');
      return { value };
    },
    resolveClinicalContinuityFacilityContext: jest.fn(async ({ req }) => {
      req.continuityFacilityContext = Object.freeze({ facilityId: FACILITY });
      return req.continuityFacilityContext;
    }),
    encodeClinicalContinuityFacilityContextHeader: jest.fn(),
    __facilityContextContractForTests: Object.freeze({})
  })
);

jest.unstable_mockModule('../middleware/auditLog.js', () => ({
  auditLogMiddleware: (_req, _res, next) => next()
}));

const { default: app } = await import('../app.js');
const { ensureTestIdentity } = await import('./testClient.js');

function token() {
  return jwt.sign(
    {
      uid: '550e8400-e29b-41d4-a716-446655440022',
      id: 1,
      phone: '9876543210',
      role: 'ADMIN',
      tenant_id: TENANT,
      stableDeviceId: '550e8400-e29b-41d4-a716-446655440023',
      jti: 'policy-delivery-test',
      deviceType: 'desktop'
    },
    process.env.JWT_SECRET || 'test-jwt-secret',
    { expiresIn: '1h' }
  );
}

function rawRequest(server, extraHeaders = {}, facilityId = FACILITY) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: `/api/v1/clinical-continuity/facilities/${facilityId}/policy`,
      method: 'GET',
      headers: {
        Accept: MEDIA_TYPE,
        'Accept-Encoding': 'gzip',
        Authorization: `Bearer ${token()}`,
        'X-API-Key': process.env.API_KEY || 'test-api-key',
        'X-VH-Continuity-Facility-Context': 'signed-context',
        ...extraHeaders
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('clinical continuity policy delivery real middleware bytes', () => {
  // This suite hand-signs its bearer rather than using generateTestToken, but
  // the subject still has to resolve to a live identity row now that
  // authentication fails closed; otherwise every request 401s.
  beforeAll(async () => {
    await ensureTestIdentity('550e8400-e29b-41d4-a716-446655440022', {
      role: 'ADMIN',
      tenantId: TENANT,
    });
  });

  let server;

  beforeAll(async () => {
    server = await new Promise(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('hashes to the verified representation after real auth and gzip middleware', async () => {
    const response = await rawRequest(server);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(MEDIA_TYPE);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['transfer-encoding']).toBe('chunked');
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers['content-digest']).toBe(
      `sha-256=:${digest.toString('base64')}:`
    );
    const servedBytes = gunzipSync(response.body);
    expect(servedBytes.equals(body)).toBe(true);
    expect(createHash('sha256').update(servedBytes).digest('hex')).toBe(digestHex);
    const servedEnvelope = JSON.parse(servedBytes.toString('utf8'));
    expect(Buffer.from(canonicalizeJson(servedEnvelope)).equals(servedBytes)).toBe(true);
    expect(
      createHash('sha256')
        .update(canonicalizeJson(servedEnvelope.payload.policyDocument))
        .digest('hex')
    ).toBe(policyChecksum);
    expect(loadDelivery).toHaveBeenCalledWith({ tenantId: TENANT, facilityId: FACILITY });
  });

  it('revalidates lifecycle before returning 304', async () => {
    loadDelivery.mockClear();
    const response = await rawRequest(server, { 'If-None-Match': etag });
    expect(response.statusCode).toBe(304);
    expect(response.body).toHaveLength(0);
    expect(loadDelivery).toHaveBeenCalledTimes(1);
  });

  it('keeps API-key, JWT, and AF facility denials in the mounted stack', async () => {
    loadDelivery.mockClear();
    const missingApiKey = await rawRequest(server, { 'X-API-Key': '' });
    const missingJwt = await rawRequest(server, { Authorization: '' });
    const invalidContext = await rawRequest(server, {
      'X-VH-Continuity-Facility-Context': 'not-signed-context'
    });
    const wrongFacility = await rawRequest(server, {}, FACILITY + 1);

    expect(missingApiKey.statusCode).toBe(401);
    expect(missingJwt.statusCode).toBe(401);
    expect(invalidContext.statusCode).toBe(403);
    expect(wrongFacility.statusCode).toBe(403);
    expect(loadDelivery).not.toHaveBeenCalled();
  });
});
