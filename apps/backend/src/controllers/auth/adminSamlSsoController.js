import { HTTP_STATUS } from '../../config/responseCodes.js';
import {
  discoverAdminSamlProvidersForRequest,
  startSamlLogin,
  validateSamlAcs,
} from '../../services/auth/samlSsoService.js';
import { error, success } from '../../utils/responseHelper.js';

function wantsJson(req) {
  return req.query?.response_mode === 'json'
    || String(req.headers?.accept || '').includes('application/json');
}

function appErrorStatus(err) {
  return err?.statusCode || err?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

export const listProviders = async (req, res, next) => {
  try {
    const result = await discoverAdminSamlProvidersForRequest(req);
    return success(res, result, 'Admin SAML SSO providers retrieved');
  } catch (err) {
    return next(err);
  }
};

export const start = async (req, res, next) => {
  try {
    const result = await startSamlLogin({
      req,
      realm: 'admin',
      providerKey: req.params.provider,
    });
    if (wantsJson(req)) return success(res, result, 'Admin SAML SSO authorization URL created');
    return res.redirect(302, result.redirectUrl);
  } catch (err) {
    return next(err);
  }
};

export const acs = async (req, res) => {
  try {
    const result = await validateSamlAcs({
      req,
      realm: 'admin',
      providerKey: req.params.provider,
    });
    return success(res, {
      provider: result.provider.provider_key,
      tenant: {
        id: result.tenant.tenantId,
        slug: result.tenant.tenantSlug,
        platform: result.tenant.isPlatform,
      },
      principal: {
        issuer: result.principal.issuer,
        subject: result.principal.subject,
        nameIdFormat: result.principal.nameIdFormat,
        email: result.principal.email,
        groupCount: result.principal.groups.length,
      },
    }, 'Admin SAML assertion accepted');
  } catch (err) {
    return error(res, err.message || 'Admin SAML SSO login failed', appErrorStatus(err), {
      code: err.code,
      safe: appErrorStatus(err) < 500,
    });
  }
};
