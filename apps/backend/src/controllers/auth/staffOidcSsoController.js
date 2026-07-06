import { HTTP_STATUS } from '../../config/responseCodes.js';
import {
  completeStaffOidcCallback,
  discoverStaffOidcProvidersForRequest,
  startStaffOidcLogin,
} from '../../services/auth/staffOidcSsoService.js';
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
    const result = await discoverStaffOidcProvidersForRequest(req);
    return success(res, result, 'Staff SSO providers retrieved');
  } catch (err) {
    return next(err);
  }
};

export const start = async (req, res, next) => {
  try {
    const result = await startStaffOidcLogin({
      req,
      providerKey: req.params.provider,
    });
    if (wantsJson(req)) {
      return success(res, result, 'Staff SSO authorization URL created');
    }
    return res.redirect(302, result.redirectUrl);
  } catch (err) {
    return next(err);
  }
};

export const callback = async (req, res) => {
  try {
    const result = await completeStaffOidcCallback({
      req,
      providerKey: req.params.provider,
      code: req.query.code || req.body?.code,
      state: req.query.state || req.body?.state,
      redirectUri: req.query.redirect_uri || req.query.redirectUri || req.body?.redirect_uri || req.body?.redirectUri,
    });
    return success(res, result, 'Staff SSO login successful');
  } catch (err) {
    return error(res, err.message || 'Staff SSO login failed', appErrorStatus(err), {
      code: err.code,
      safe: appErrorStatus(err) < 500,
    });
  }
};
