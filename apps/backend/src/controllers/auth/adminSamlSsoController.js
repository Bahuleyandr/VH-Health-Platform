import { HTTP_STATUS } from '../../config/responseCodes.js';
import {
  buildCookie,
  clearCookie,
  consumeHandoffCookie,
  createHandoffCookiePayload,
  OIDC_HANDOFF_COOKIE,
} from '../../services/auth/adminOidcSsoService.js';
import {
  completeSamlAcs,
  discoverAdminSamlProvidersForRequest,
  startSamlLogin,
} from '../../services/auth/samlSsoService.js';
import { error, success } from '../../utils/responseHelper.js';

function wantsJson(req) {
  return req.query?.response_mode === 'json'
    || String(req.headers?.accept || '').includes('application/json');
}

function appErrorStatus(err) {
  return err?.statusCode || err?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

function adminCompleteUrl(result, req) {
  const host = String(result.adminHost || req.headers?.host || '').trim();
  const hostname = host.split(':')[0].toLowerCase();
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const proto = local
    ? String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http').split(',')[0]
    : 'https';
  return `${proto}://${host}/api/login/sso/saml/complete`;
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
    const result = await completeSamlAcs({
      req,
      realm: 'admin',
      providerKey: req.params.provider,
    });

    if (wantsJson(req)) {
      return success(res, result, 'Admin SAML SSO login successful');
    }

    const handoff = createHandoffCookiePayload(result);
    res.setHeader('Set-Cookie', buildCookie(OIDC_HANDOFF_COOKIE, handoff, req, {
      maxAgeSeconds: 90,
      path: '/',
      domainHost: result.adminHost,
    }));
    return res.redirect(302, adminCompleteUrl(result, req));
  } catch (err) {
    return error(res, err.message || 'Admin SAML SSO login failed', appErrorStatus(err), {
      code: err.code,
      safe: appErrorStatus(err) < 500,
    });
  }
};

export const completeHandoff = async (req, res) => {
  try {
    const result = consumeHandoffCookie(req.headers?.cookie || '');
    res.setHeader('Set-Cookie', clearCookie(OIDC_HANDOFF_COOKIE, req, { path: '/' }));
    return success(res, {
      token: result.token,
      admin: result.admin,
      returnTo: result.returnTo || '/dashboard',
    }, 'Admin SAML handoff accepted');
  } catch (err) {
    return error(res, err.message || 'Admin SAML handoff failed', appErrorStatus(err), {
      code: err.code,
      safe: appErrorStatus(err) < 500,
    });
  }
};
