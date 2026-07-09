import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';

const issueAuthorizationCodeFromLaunchMock = jest.fn(async () => ({
  plaintext_code: 'vh_authz_public',
  authz: { id: 1 },
}));
const exchangeAuthorizationCodeMock = jest.fn(async () => ({
  access_token: 'vh_access_public',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'patient/Observation.read',
}));
const refreshAccessTokenMock = jest.fn(async () => ({
  access_token: 'vh_access_refreshed',
  refresh_token: 'vh_refresh_rotated',
  token_type: 'Bearer',
  expires_in: 3600,
}));
const revokeTokenByValueMock = jest.fn(async () => ({ revoked: true }));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantForRequest: jest.fn(async () => TENANT),
}));

jest.unstable_mockModule('../../services/smartFhir/smartOAuthService.js', () => ({
  clientCredentialsFromRequest: (req) => {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const [clientId, clientSecret] = decoded.split(':');
      return { clientId, clientSecret };
    }
    return { clientId: req.body?.client_id, clientSecret: req.body?.client_secret || null };
  },
  exchangeAuthorizationCode: exchangeAuthorizationCodeMock,
  issueAuthorizationCodeFromLaunch: issueAuthorizationCodeFromLaunchMock,
  refreshAccessToken: refreshAccessTokenMock,
  revokeTokenByValue: revokeTokenByValueMock,
}));

const { default: publicSmartFhirRoutes } = await import('../../routes/smartFhir/publicSmartFhirRoutes.js');
const { RATE_LIMIT_PROFILES } = await import('../../config/rateLimitProfiles.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/v1/fhir', publicSmartFhirRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('public SMART-on-FHIR routes', () => {
  it('serves SMART discovery metadata without platform auth', async () => {
    const res = await request(buildApp())
      .get('/api/v1/fhir/.well-known/smart-configuration')
      .set('Host', 'api.vhhealth.test');
    expect(res.status).toBe(200);
    expect(res.body.authorization_endpoint).toBe('http://api.vhhealth.test/api/v1/fhir/authorize');
    expect(res.body.token_endpoint).toBe('http://api.vhhealth.test/api/v1/fhir/token');
    expect(res.body.capabilities).toContain('permission-patient');
  });

  it('consumes a launch context and redirects back with code and state', async () => {
    const res = await request(buildApp())
      .get('/api/v1/fhir/authorize')
      .set('Host', 'api.vhhealth.test')
      .query({
        response_type: 'code',
        client_id: 'app1',
        redirect_uri: 'https://app.example.com/cb',
        scope: 'launch/patient patient/Observation.read',
        launch: 'vh_launch_public',
        code_challenge: 'challenge',
        state: 'abc',
        aud: 'http://api.vhhealth.test/api/v1/fhir',
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.example.com/cb?code=vh_authz_public&state=abc');
    expect(issueAuthorizationCodeFromLaunchMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      clientId: 'app1',
      launchToken: 'vh_launch_public',
      requestedScopes: ['launch/patient', 'patient/Observation.read'],
    }));
  });

  it('rejects authorize requests whose aud does not match the FHIR base URL', async () => {
    const res = await request(buildApp())
      .get('/api/v1/fhir/authorize')
      .set('Host', 'api.vhhealth.test')
      .query({
        response_type: 'code',
        client_id: 'app1',
        redirect_uri: 'https://app.example.com/cb',
        launch: 'vh_launch_public',
        aud: 'https://other.example/fhir',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SMART_AUD_MISMATCH');
    expect(issueAuthorizationCodeFromLaunchMock).not.toHaveBeenCalled();
  });

  it('exchanges authorization codes with Basic client authentication', async () => {
    const basic = Buffer.from('app1:secret1').toString('base64');
    const res = await request(buildApp())
      .post('/api/v1/fhir/token')
      .set('Authorization', `Basic ${basic}`)
      .send({
        grant_type: 'authorization_code',
        code: 'vh_authz_public',
        redirect_uri: 'https://app.example.com/cb',
        code_verifier: 'verifier',
      });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe('vh_access_public');
    expect(exchangeAuthorizationCodeMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'app1',
      clientSecret: 'secret1',
      code: 'vh_authz_public',
    }));
  });

  it('revokes a token through the OAuth revocation endpoint', async () => {
    const res = await request(buildApp())
      .post('/api/v1/fhir/revoke')
      .send({ client_id: 'app1', token: 'vh_access_public' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true });
    expect(revokeTokenByValueMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'app1',
      token: 'vh_access_public',
    }));
  });
});

describe('SMART-on-FHIR abuse limiter profile', () => {
  it('keeps public SMART endpoints on a tighter one-minute bucket', () => {
    expect(RATE_LIMIT_PROFILES.smartFhirOAuth).toEqual(expect.objectContaining({
      windowMs: 60 * 1000,
      max: 30,
    }));
  });
});
