import { HTTP_STATUS } from '../../config/responseCodes.js';
import {
  buildCookie,
  clearCookie,
  completeAdminOidcCallback,
  consumeHandoffCookie,
  createHandoffCookiePayload,
  discoverAdminOidcProvidersForRequest,
  OIDC_HANDOFF_COOKIE,
  OIDC_STATE_COOKIE,
  startAdminOidcLogin,
} from '../../services/auth/adminOidcSsoService.js';
import { error, success } from '../../utils/responseHelper.js';

function wantsJson(req) {
  return req.query?.response_mode === 'json'
    || String(req.headers?.accept || '').includes('application/json');
}

function adminCompleteUrl(result, req) {
  const host = String(result.adminHost || req.headers?.host || '').trim();
  const hostname = host.split(':')[0].toLowerCase();
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const proto = local
    ? String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http').split(',')[0]
    : 'https';
  return `${proto}://${host}/api/login/sso/oidc/complete`;
}

function appErrorStatus(err) {
  return err?.statusCode || err?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

export const listProviders = async (req, res, next) => {
  try {
    const result = await discoverAdminOidcProvidersForRequest(req);
    return success(res, result, 'Admin SSO providers retrieved');
  } catch (err) {
    return next(err);
  }
};

export const start = async (req, res, next) => {
  try {
    const result = await startAdminOidcLogin({
      req,
      providerKey: req.params.provider,
    });
    res.setHeader('Set-Cookie', result.stateCookie);
    return res.redirect(302, result.redirectUrl);
  } catch (err) {
    return next(err);
  }
};

export const callback = async (req, res, next) => {
  try {
    const result = await completeAdminOidcCallback({
      req,
      providerKey: req.params.provider,
      code: req.query.code,
      state: req.query.state,
    });

    if (wantsJson(req)) {
      res.setHeader('Set-Cookie', clearCookie(OIDC_STATE_COOKIE, req, {
        path: '/api/v1/auth/admin/sso/oidc',
      }));
      return success(res, result, 'Admin SSO login successful');
    }

    const handoff = createHandoffCookiePayload(result);
    res.setHeader('Set-Cookie', [
      clearCookie(OIDC_STATE_COOKIE, req, { path: '/api/v1/auth/admin/sso/oidc' }),
      buildCookie(OIDC_HANDOFF_COOKIE, handoff, req, {
        maxAgeSeconds: 90,
        path: '/',
        domainHost: result.adminHost,
      }),
    ]);
    return res.redirect(302, adminCompleteUrl(result, req));
  } catch (err) {
    if (wantsJson(req)) {
      return error(res, err.message || 'Admin SSO login failed', appErrorStatus(err), {
        code: err.code,
        safe: appErrorStatus(err) < 500,
      });
    }
    return next(err);
  }
};

export const completeHandoff = async (req, res) => {
  try {
    const result = consumeHandoffCookie(req.headers?.cookie || '');
    return success(res, {
      token: result.token,
      admin: result.admin,
      returnTo: result.returnTo || '/dashboard',
    }, 'Admin SSO handoff accepted');
  } catch (err) {
    return error(res, err.message || 'Admin SSO handoff failed', appErrorStatus(err), {
      code: err.code,
      safe: appErrorStatus(err) < 500,
    });
  }
};
