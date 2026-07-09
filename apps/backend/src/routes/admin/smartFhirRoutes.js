/**
 * Admin routes for SMART-on-FHIR OAuth (Phase D3).
 * Mounted at /api/v1/admin/smart-fhir.
 *
 * Note: end-user OAuth endpoints (/.well-known/smart-configuration,
 * /authorize, /token, /revoke) live separately under the public FHIR
 * surface and are wired up in a follow-up PR. This admin surface is
 * the registry + lifecycle management.
 */

import express from 'express';

import { AppError } from '../../utils/AppError.js';
import { success } from '../../utils/responseHelper.js';
import {
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  issueLaunchContext,
  listAccessTokens,
  listSmartApps,
  refreshAccessToken,
  registerSmartApp,
  revokeAccessToken,
  verifyAccessToken,
} from '../../services/smartFhir/smartOAuthService.js';

const router = express.Router();

function assertAdminAuthorizeHelperEnabled() {
  const flag = String(process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED || '').trim().toLowerCase();
  const enabled = flag === 'true' || flag === '1';
  if (!enabled) {
    throw AppError.forbidden(
      'Admin SMART authorize helper is disabled',
      'SMART_ADMIN_AUTHORIZE_DISABLED',
    );
  }
}

function assertProductionApprovalAllowed(req, body = {}) {
  const environment = String(body.environment || 'sandbox').trim();
  const wantsProductionApproval = environment === 'production'
    && (body.registration_status === 'production_approved' || body.status === 'active');
  if (wantsProductionApproval && req.user?.role !== 'SUPER_ADMIN') {
    throw AppError.forbidden(
      'Production SMART apps require platform super-admin approval',
      'SMART_PRODUCTION_APPROVAL_ROLE_REQUIRED',
    );
  }
}

// Apps
router.post('/apps', async (req, res, next) => {
  try {
    const b = req.body || {};
    assertProductionApprovalAllowed(req, b);
    const result = await registerSmartApp({
      tenantId: req.tenantId,
      clientId: b.client_id, displayName: b.display_name,
      description: b.description, appKind: b.app_kind,
      redirectUris: b.redirect_uris, allowedScopes: b.allowed_scopes,
      launchUri: b.launch_uri, jwksUrl: b.jwks_url,
      fhirVersion: b.fhir_version, status: b.status,
      environment: b.environment,
      registrationStatus: b.registration_status,
      approvedBy: b.registration_status === 'production_approved' ? req.user?.uid : b.approved_by,
      productionContractRef: b.production_contract_ref,
      approvalNotes: b.approval_notes,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, result, 'SMART app registered. Store the plaintext client_secret if returned — it cannot be shown again.', 201);
  } catch (err) { return next(err); }
});

router.get('/apps', async (req, res, next) => {
  try {
    const result = await listSmartApps({
      tenantId: req.tenantId,
      environment: req.query.environment || null,
      status: req.query.status || null,
    });
    return success(res, result, 'SMART apps retrieved');
  } catch (err) { return next(err); }
});

// Authorization code grant — admin-side helper for testing only. Production
// authorize flow should run through the dedicated public FHIR surface.
router.post('/authorize', async (req, res, next) => {
  try {
    assertAdminAuthorizeHelperEnabled();
    const b = req.body || {};
    const result = await issueAuthorizationCode({
      tenantId: req.tenantId,
      clientId: b.client_id, redirectUri: b.redirect_uri,
      requestedScopes: b.scope ? String(b.scope).split(/\s+/) : b.requested_scopes,
      patientUid: b.patient_uid, encounterId: b.encounter_id,
      userUid: b.user_uid, userRole: b.user_role,
      pkceCodeChallenge: b.code_challenge, pkceMethod: b.code_challenge_method,
      state: b.state, environment: b.environment, metadata: b.metadata,
    });
    return success(res, result, 'Authorization code issued', 201);
  } catch (err) { return next(err); }
});

router.post('/launch-contexts', async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await issueLaunchContext({
      tenantId: req.tenantId,
      clientId: b.client_id,
      requestedScopes: b.scope ? String(b.scope).split(/\s+/) : b.requested_scopes,
      patientUid: b.patient_uid,
      encounterId: b.encounter_id,
      userUid: b.user_uid || req.user?.uid || null,
      userRole: b.user_role || req.user?.role || null,
      environment: b.environment,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
      ttlSeconds: b.ttl_seconds,
    });
    return success(res, result, 'SMART launch context issued', 201);
  } catch (err) { return next(err); }
});

// Token exchange (authorization_code grant)
router.post('/token', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.grant_type === 'refresh_token') {
      const result = await refreshAccessToken({
        tenantId: req.tenantId,
        clientId: b.client_id, clientSecret: b.client_secret,
        refreshToken: b.refresh_token, environment: b.environment,
      });
      return success(res, result, 'Access token refreshed');
    }
    const result = await exchangeAuthorizationCode({
      tenantId: req.tenantId,
      clientId: b.client_id, clientSecret: b.client_secret,
      code: b.code, redirectUri: b.redirect_uri,
      codeVerifier: b.code_verifier, environment: b.environment,
    });
    return success(res, result, 'Access token issued');
  } catch (err) { return next(err); }
});

// Verify (introspect) an access token
router.post('/introspect', async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await verifyAccessToken({
      tenantId: req.tenantId,
      accessToken: b.access_token, environment: b.environment,
      ipAddress: req.ip || null,
    });
    return success(res, { active: !!result, token: result }, result ? 'Token active' : 'Token inactive');
  } catch (err) { return next(err); }
});

// Token list + revoke
router.get('/tokens', async (req, res, next) => {
  try {
    const result = await listAccessTokens({
      tenantId: req.tenantId,
      smartAppId: req.query.smart_app_id || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Tokens retrieved');
  } catch (err) { return next(err); }
});

router.patch('/tokens/:id/revoke', async (req, res, next) => {
  try {
    const row = await revokeAccessToken({
      tenantId: req.tenantId, id: req.params.id,
      revokedReason: req.body?.revoked_reason,
    });
    return success(res, row, 'Token revoked');
  } catch (err) { return next(err); }
});

export default router;
