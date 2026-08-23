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

import { requireRole } from '../../middleware/rbacMiddleware.js';
import { AppError } from '../../utils/AppError.js';
import { success } from '../../utils/responseHelper.js';
import { normalizeRole, SUPER_ADMIN } from '../../utils/roles.js';
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

/**
 * SUPER_ADMIN-only console (in-route gate, same intent as the databaseRoutes.js
 * gate; spelled with the shared `requireRole` so a denied attempt lands in the
 * security audit trail as `PERMISSION_DENIED`).
 *
 * The parent `/api/v1/admin` mount gates on ADMIN_ROUTE_ROLES, which resolves
 * to ['SUPER_ADMIN', 'ADMIN'], and `requireSuperAdminStepUp` passes non-supers
 * straight through (rbacMiddleware.js:117). The only internal check was
 * `assertProductionApprovalAllowed`, which gates production-app approval alone —
 * so a plain tenant ADMIN could still register a sandbox SMART app, mint
 * authorization codes and launch contexts, and revoke any tenant's live access
 * tokens. The admin portal has always declared this console SUPER_ADMIN-only
 * (apps/admin/src/lib/navConfig.ts — "SMART-on-FHIR Apps").
 *
 * Router-wide rather than per-mutation on purpose: `GET /apps` is the OAuth
 * client registry (redirect URIs, allowed PHI scopes, approval status) and
 * `GET /tokens` enumerates live PHI-scoped access tokens — both are the
 * security configuration of the FHIR surface. Nothing patient-facing is
 * narrowed by this: the real SMART OAuth endpoints for client apps are the
 * public ones at /api/v1/fhir (routes/smartFhir/publicSmartFhirRoutes.js);
 * everything here is the admin registry plus admin-side testing helpers. Step-up
 * from the parent mount still applies and is unchanged.
 */
router.use(requireRole('SUPER_ADMIN'));

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

/**
 * Production-approval rule, retained as defence in depth.
 *
 * It must recognise a super-admin exactly the way `requireRole` does.
 * `req.user` is not the token payload: jwtMiddleware canonicalises the role
 * claim before any RBAC layer sees it — `canonicalizeRequestRole` maps
 * SUPER_ADMIN → ADMIN (utils/roles.js) and stashes the original claim on
 * `rawRole` (jwtMiddleware.js) — so a genuine super-admin bearer arrives as
 * `{ role: 'ADMIN', rawRole: 'SUPER_ADMIN' }` and NEVER as `role:
 * 'SUPER_ADMIN'`. This function previously tested `req.user.role !==
 * 'SUPER_ADMIN'`, which no real bearer can satisfy, so production SMART apps
 * could not be approved by anyone. Testing role OR rawRole — the same pair
 * rbacMiddleware.js:47-55 tests, through the same `normalizeRole` — fixes that.
 *
 * Because the two tests are now identical, every identity the router-wide
 * `requireRole('SUPER_ADMIN')` above admits also satisfies this check: reached
 * through the admin mount it can no longer refuse anyone. It is kept so the
 * production-approval rule still holds if this router is ever re-mounted behind
 * a broader gate.
 */
function assertProductionApprovalAllowed(req, body = {}) {
  const environment = String(body.environment || 'sandbox').trim();
  const wantsProductionApproval = environment === 'production'
    && (body.registration_status === 'production_approved' || body.status === 'active');
  const isSuperAdmin = normalizeRole(req.user?.role) === SUPER_ADMIN
    || normalizeRole(req.user?.rawRole) === SUPER_ADMIN;
  if (wantsProductionApproval && !isSuperAdmin) {
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
