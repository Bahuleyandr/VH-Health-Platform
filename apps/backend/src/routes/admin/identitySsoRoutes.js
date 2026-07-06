import express from 'express';

import {
  getAdminOidcProvider,
  listAdminOidcProviders,
  listAdminOidcRoleMappings,
  replaceAdminOidcRoleMappings,
  upsertAdminOidcProvider,
} from '../../services/auth/adminOidcSsoService.js';
import {
  getStaffOidcProviderConfig,
  listStaffOidcProviders,
  listStaffOidcRoleMappings,
  replaceStaffOidcRoleMappings,
  upsertStaffOidcProvider,
} from '../../services/auth/staffOidcSsoService.js';
import { configureProviderScimCredentials } from '../../services/auth/scimCredentialService.js';
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

function realmFromRequest(req) {
  const realm = String(req.query.realm || req.body?.realm || 'admin').trim().toLowerCase();
  if (!['admin', 'staff'].includes(realm)) {
    throw AppError.badRequest('Invalid SSO realm', 'SSO_REALM_INVALID');
  }
  return realm;
}

function scopeFromRequest(req, realm = 'admin') {
  const platform = platformRequested(req);
  if (realm === 'staff' && platform) {
    throw AppError.badRequest('Staff SSO providers are tenant-scoped', 'SSO_STAFF_PLATFORM_FORBIDDEN');
  }
  if (platform) {
    if (!isSuperAdmin(req)) throw AppError.forbidden('SUPER_ADMIN required for platform SSO providers', 'SSO_PLATFORM_FORBIDDEN');
    return { realm, platform: true, tenantId: null };
  }
  if (!req.tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  return { realm, platform: false, tenantId: String(req.tenantId) };
}

router.get('/sso/oidc/providers', async (req, res, next) => {
  try {
    const realm = realmFromRequest(req);
    const scope = scopeFromRequest(req, realm);
    const providers = realm === 'staff'
      ? await listStaffOidcProviders({
        tenantId: scope.tenantId,
        status: req.query.status || null,
      })
      : await listAdminOidcProviders({
        tenantId: scope.tenantId,
        platform: scope.platform,
        status: req.query.status || null,
      });
    return success(res, { providers, scope }, `${realm === 'staff' ? 'Staff' : 'Admin'} OIDC providers retrieved`);
  } catch (err) {
    return next(err);
  }
});

router.put('/sso/oidc/providers/:provider', async (req, res, next) => {
  try {
    const realm = realmFromRequest(req);
    const scope = scopeFromRequest(req, realm);
    const provider = realm === 'staff'
      ? await upsertStaffOidcProvider({
        tenantId: scope.tenantId,
        providerKey: req.params.provider,
        actorUid: req.user?.uid || null,
        input: req.body || {},
      })
      : await upsertAdminOidcProvider({
        ...scope,
        providerKey: req.params.provider,
        actorUid: req.user?.uid || null,
        input: req.body || {},
      });
    return success(res, { provider, scope }, `${realm === 'staff' ? 'Staff' : 'Admin'} OIDC provider saved`);
  } catch (err) {
    return next(err);
  }
});

router.get('/sso/oidc/providers/:provider', async (req, res, next) => {
  try {
    const realm = realmFromRequest(req);
    const scope = scopeFromRequest(req, realm);
    const provider = realm === 'staff'
      ? await getStaffOidcProviderConfig({
        tenantId: scope.tenantId,
        providerKey: req.params.provider,
      })
      : await getAdminOidcProvider({
        ...scope,
        providerKey: req.params.provider,
      });
    return success(res, { provider, scope }, `${realm === 'staff' ? 'Staff' : 'Admin'} OIDC provider retrieved`);
  } catch (err) {
    return next(err);
  }
});

router.put('/sso/oidc/providers/:provider/scim', async (req, res, next) => {
  try {
    const realm = realmFromRequest(req);
    const scope = scopeFromRequest(req, realm);
    if (scope.platform) {
      throw AppError.badRequest('SCIM providers are tenant-scoped', 'SCIM_PLATFORM_FORBIDDEN');
    }
    const result = await configureProviderScimCredentials({
      tenantId: scope.tenantId,
      providerKey: req.params.provider,
      realm,
      actorUid: req.user?.uid || null,
      input: req.body || {},
    });
    return success(res, { ...result, scope }, `${realm === 'staff' ? 'Staff' : 'Admin'} SCIM credentials saved`);
  } catch (err) {
    return next(err);
  }
});

router.get('/sso/oidc/providers/:provider/mappings', async (req, res, next) => {
  try {
    const realm = realmFromRequest(req);
    const scope = scopeFromRequest(req, realm);
    const mappings = realm === 'staff'
      ? await listStaffOidcRoleMappings({
        tenantId: scope.tenantId,
        providerKey: req.params.provider,
      })
      : await listAdminOidcRoleMappings({
        ...scope,
        providerKey: req.params.provider,
      });
    return success(res, { mappings, scope }, `${realm === 'staff' ? 'Staff' : 'Admin'} OIDC role mappings retrieved`);
  } catch (err) {
    return next(err);
  }
});

router.put('/sso/oidc/providers/:provider/mappings', async (req, res, next) => {
  try {
    const realm = realmFromRequest(req);
    const scope = scopeFromRequest(req, realm);
    const mappings = realm === 'staff'
      ? await replaceStaffOidcRoleMappings({
        tenantId: scope.tenantId,
        providerKey: req.params.provider,
        actorUid: req.user?.uid || null,
        mappings: req.body?.mappings || [],
      })
      : await replaceAdminOidcRoleMappings({
        ...scope,
        providerKey: req.params.provider,
        actorUid: req.user?.uid || null,
        mappings: req.body?.mappings || [],
      });
    return success(res, { mappings, scope }, `${realm === 'staff' ? 'Staff' : 'Admin'} OIDC role mappings saved`);
  } catch (err) {
    return next(err);
  }
});

export default router;
