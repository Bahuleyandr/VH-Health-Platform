import express from 'express';

import { AppError } from '../../utils/AppError.js';
import {
  clientCredentialsFromRequest,
  exchangeAuthorizationCode,
  issueAuthorizationCodeFromLaunch,
  refreshAccessToken,
  revokeTokenByValue,
} from '../../services/smartFhir/smartOAuthService.js';
import { resolveTenantForRequest } from '../../services/tenant/tenantService.js';
import tenantRlsMiddleware from '../../middleware/tenantRlsMiddleware.js';

const router = express.Router();

function fhirBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${req.baseUrl}`;
}

function environmentOf(req) {
  return String(req.query.environment || req.body?.environment || req.headers['x-smart-environment'] || 'sandbox').trim();
}

function scopesFrom(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}

async function publicSmartTenant(req, _res, next) {
  try {
    req.tenantId = await resolveTenantForRequest(req);
    return next();
  } catch (err) {
    return next(err);
  }
}

function appendAuthorizationCodeRedirect(redirectUri, { code, state }) {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

router.use(publicSmartTenant);
// Seed the AsyncLocalStorage tenant context (audit / cross-tenant fix,
// defense-in-depth): this router is mounted pre-auth, BEFORE the global
// tenantRlsMiddleware, so its prisma calls previously ran outside any tenant
// context and the prod auto-setTenant wrap never fired. publicSmartTenant has
// just set req.tenantId, which is all tenantRlsMiddleware needs.
router.use(tenantRlsMiddleware);

router.get('/.well-known/smart-configuration', (req, res) => {
  const base = fhirBaseUrl(req);
  res.json({
    issuer: base,
    jwks_uri: `${base}/.well-known/jwks.json`,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    token_revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    capabilities: [
      'launch-ehr',
      'launch-standalone',
      'client-public',
      'client-confidential-symmetric',
      'context-ehr-patient',
      'context-ehr-encounter',
      'permission-patient',
      'permission-user',
      'permission-offline',
    ],
    scopes_supported: [
      'launch',
      'launch/patient',
      'launch/encounter',
      'openid',
      'profile',
      'fhirUser',
      'offline_access',
      'patient/*.read',
      'patient/Observation.write',
      'patient/Condition.write',
      'patient/AllergyIntolerance.write',
      'user/*.read',
      'system/*.read',
    ],
  });
});

router.get('/authorize', async (req, res, next) => {
  try {
    if (req.query.response_type !== 'code') {
      throw AppError.badRequest('response_type must be code', 'SMART_RESPONSE_TYPE_UNSUPPORTED');
    }
    const base = fhirBaseUrl(req);
    if (req.query.aud && String(req.query.aud) !== base) {
      throw AppError.badRequest('aud must match this FHIR base URL', 'SMART_AUD_MISMATCH');
    }
    const result = await issueAuthorizationCodeFromLaunch({
      tenantId: req.tenantId,
      clientId: req.query.client_id,
      redirectUri: req.query.redirect_uri,
      requestedScopes: scopesFrom(req.query.scope),
      launchToken: req.query.launch,
      pkceCodeChallenge: req.query.code_challenge,
      pkceMethod: req.query.code_challenge_method,
      state: req.query.state,
      environment: environmentOf(req),
      metadata: { public_endpoint: true },
    });
    return res.redirect(302, appendAuthorizationCodeRedirect(req.query.redirect_uri, {
      code: result.plaintext_code,
      state: req.query.state,
    }));
  } catch (err) {
    return next(err);
  }
});

router.post('/token', async (req, res, next) => {
  try {
    const body = req.body || {};
    const credentials = clientCredentialsFromRequest(req);
    const env = environmentOf(req);
    const grantType = String(body.grant_type || '').trim();
    let result;
    if (grantType === 'authorization_code') {
      result = await exchangeAuthorizationCode({
        tenantId: req.tenantId,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        code: body.code,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        environment: env,
      });
    } else if (grantType === 'refresh_token') {
      result = await refreshAccessToken({
        tenantId: req.tenantId,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        refreshToken: body.refresh_token,
        environment: env,
      });
    } else {
      throw AppError.badRequest('unsupported grant_type', 'SMART_GRANT_UNSUPPORTED');
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post('/revoke', async (req, res, next) => {
  try {
    const credentials = clientCredentialsFromRequest(req);
    await revokeTokenByValue({
      tenantId: req.tenantId,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      token: req.body?.token,
      environment: environmentOf(req),
    });
    return res.status(200).json({ revoked: true });
  } catch (err) {
    return next(err);
  }
});

router.use((err, _req, res, _next) => {
  const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
  res.status(status).json({
    error: status === 401 ? 'invalid_client'
      : status === 403 ? 'access_denied'
        : 'invalid_request',
    error_description: status >= 500 ? 'Internal server error' : String(err?.message || 'Request failed'),
    code: err?.code,
  });
});

export default router;
