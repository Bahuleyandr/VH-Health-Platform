import { HTTP_STATUS } from '../../config/responseCodes.js';
import {
  completeSamlAcs,
  discoverStaffSamlProvidersForRequest,
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

export const listProviders = async (req, res, next) => {
  try {
    const result = await discoverStaffSamlProvidersForRequest(req);
    return success(res, result, 'Staff SAML SSO providers retrieved');
  } catch (err) {
    return next(err);
  }
};

export const start = async (req, res, next) => {
  try {
    const result = await startSamlLogin({
      req,
      realm: 'staff',
      providerKey: req.params.provider,
    });
    if (wantsJson(req)) return success(res, result, 'Staff SAML SSO authorization URL created');
    return res.redirect(302, result.redirectUrl);
  } catch (err) {
    return next(err);
  }
};

export const acs = async (req, res) => {
  try {
    const result = await completeSamlAcs({
      req,
      realm: 'staff',
      providerKey: req.params.provider,
    });
    return success(res, result, 'Staff SAML SSO login successful');
  } catch (err) {
    return error(res, err.message || 'Staff SAML SSO login failed', appErrorStatus(err), {
      code: err.code,
      safe: appErrorStatus(err) < 500,
    });
  }
};
