import express from 'express';

import {
  getAdminOidcProvider,
  listAdminOidcProviders,
  listAdminOidcRoleMappings,
  replaceAdminOidcRoleMappings,
  upsertAdminOidcProvider,
} from '../../services/auth/adminOidcSsoService.js';
import { AppError } from '../../utils/AppError.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

function isSuperAdmin(req) {
  const role = String(req.user?.rawRole || req.user?.role || '').toUpperCase();
  return role === 'SUPER_ADMIN';
}

function platformRequested(req) {
  return req.query.platform === 'true'
    || req.query.scope === 'platform'
    || req.body?.platform === true
    || req.body?.scope === 'platform';
}

function scopeFromRequest(req) {
  const platform = platformRequested(req);
  if (platform) {
    if (!isSuperAdmin(req)) throw AppError.forbidden('SUPER_ADMIN required for platform SSO providers', 'SSO_PLATFORM_FORBIDDEN');
    return { platform: true, tenantId: null };
  }
  if (!req.tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  return { platform: false, tenantId: String(req.tenantId) };
}

router.get('/sso/oidc/providers', async (req, res, next) => {
  try {
    const scope = scopeFromRequest(req);
    const providers = await listAdminOidcProviders({
      tenantId: scope.tenantId,
      platform: scope.platform,
      status: req.query.status || null,
    });
    return success(res, { providers, scope }, 'Admin OIDC providers retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/sso/oidc/providers/:provider', async (req, res, next) => {
  try {
    const scope = scopeFromRequest(req);
    const provider = await upsertAdminOidcProvider({
      ...scope,
      providerKey: req.params.provider,
      actorUid: req.user?.uid || null,
      input: req.body || {},
    });
    return success(res, { provider, scope }, 'Admin OIDC provider saved');
  } catch (err) {
    return next(err);
  }
});

router.get('/sso/oidc/providers/:provider', async (req, res, next) => {
  try {
    const scope = scopeFromRequest(req);
    const provider = await getAdminOidcProvider({
      ...scope,
      providerKey: req.params.provider,
    });
    return success(res, { provider, scope }, 'Admin OIDC provider retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/sso/oidc/providers/:provider/mappings', async (req, res, next) => {
  try {
    const scope = scopeFromRequest(req);
    const mappings = await listAdminOidcRoleMappings({
      ...scope,
      providerKey: req.params.provider,
    });
    return success(res, { mappings, scope }, 'Admin OIDC role mappings retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/sso/oidc/providers/:provider/mappings', async (req, res, next) => {
  try {
    const scope = scopeFromRequest(req);
    const mappings = await replaceAdminOidcRoleMappings({
      ...scope,
      providerKey: req.params.provider,
      actorUid: req.user?.uid || null,
      mappings: req.body?.mappings || [],
    });
    return success(res, { mappings, scope }, 'Admin OIDC role mappings saved');
  } catch (err) {
    return next(err);
  }
});

export default router;
