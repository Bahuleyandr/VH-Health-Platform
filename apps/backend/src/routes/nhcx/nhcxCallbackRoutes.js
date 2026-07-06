// src/routes/nhcx/nhcxCallbackRoutes.js
//
// Public NHCX callbacks. Mounted before API-key/JWT middleware; every handled
// path is rate-limited first and then authenticated with a tenant-scoped
// callback secret resolved by the provider participant code.

import { Router } from 'express';

import { NHCX_CONFIG } from '../../config/nhcxConfig.js';
import logger from '../../logging/logger.js';
import { genericLimiter } from '../../middleware/rateLimitMiddleware.js';
import { getInteropSecret } from '../../services/interop/tenantInteropSecretService.js';
import {
  NHCX_SECRET_KINDS,
  resolveTenantByNHCXParticipantCode,
} from '../../services/nhcx/nhcxTenantConfigService.js';
import { processNHCXCallback } from '../../services/nhcx/nhcxInboundCallbackService.js';
import { error, success } from '../../utils/responseHelper.js';
import { assertSharedReplayOnce, verifySignedRequest } from '../../utils/signedRequest.js';

const callbackRouter = Router();
callbackRouter.use(genericLimiter);

const NHCX_CALLBACK_PATHS = new Set([
  '/coverageeligibility/on_check',
  '/preauth/on_submit',
  '/claim/on_submit',
  '/claim/on_status',
  '/communication/request',
]);

function nhcxEnabled() {
  return String(process.env.NHCX_ENABLED || '').toLowerCase() === 'true' || NHCX_CONFIG.enabled === true;
}

function header(req, ...names) {
  for (const name of names) {
    const value = req.headers[name] ?? req.headers[name.toLowerCase()];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}

function bodyValue(req, ...names) {
  const body = req.body || {};
  const nested = body.protected_headers || body.protectedHeaders || body.headers || {};
  for (const name of names) {
    const value = body[name] ?? nested[name];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}

function participantSelf(req) {
  return header(req, 'x-hcx-recipient_code', 'x-hcx-recipient-code', 'x-nhcx-recipient-code')
    || bodyValue(req, 'recipient_code', 'recipientCode');
}

async function validateNHCXRequest(req, res, next) {
  if (!NHCX_CALLBACK_PATHS.has(req.path)) return next('router');
  if (!nhcxEnabled()) return error(res, 'NHCX integration is not enabled', 503);

  const participantCode = participantSelf(req);
  if (!participantCode) {
    logger.warn('NHCX callback rejected: missing recipient participant code');
    return error(res, 'Invalid NHCX participant code', 401);
  }

  const tenantId = await resolveTenantByNHCXParticipantCode(participantCode);
  const callbackSecret = tenantId
    ? await getInteropSecret(tenantId, NHCX_SECRET_KINDS.callbackSecret, { senderIdentifier: participantCode })
    : null;
  if (!tenantId || !callbackSecret) {
    logger.warn('NHCX callback rejected: unrecognized participant code', { participantCode });
    return error(res, 'Invalid NHCX participant code', 401);
  }

  // Design-target seam: live NHCX may use gateway JWT/API-token validation,
  // detached signatures, or a different Communication callback contract. Until
  // operators lock the sandbox contract, callbacks must present this
  // tenant-scoped HMAC signature and shared replay key.
  const signature = header(req, 'x-nhcx-signature', 'x-hcx-signature', 'x-vhhealth-nhcx-signature');
  const timestamp = header(req, 'x-hcx-timestamp', 'timestamp') || bodyValue(req, 'timestamp');
  const requestId = header(req, 'x-hcx-request-id', 'x-request-id', 'request-id')
    || bodyValue(req, 'requestId', 'request_id', 'x-hcx-api_call_id', 'api_call_id');

  try {
    verifySignedRequest({
      secret: callbackSecret,
      signature,
      timestamp,
      requestId,
      payload: req.body || {},
      context: 'NHCX callback',
      codePrefix: 'NHCX_CALLBACK',
      replayNamespace: 'nhcx-callback',
    });
    await assertSharedReplayOnce({
      replayNamespace: 'nhcx-callback',
      requestId,
      timestamp,
      signature,
      context: 'NHCX callback',
      codePrefix: 'NHCX_CALLBACK',
    });
  } catch (err) {
    logger.warn('NHCX callback rejected: authenticity check failed', {
      code: err.code,
      error: err.message,
    });
    return error(res, err.message, err.statusCode || 401);
  }

  req.tenantId = tenantId;
  req.nhcxParticipantCodeSelf = participantCode;
  req.nhcxSignatureVerified = true;
  return next();
}

callbackRouter.use(validateNHCXRequest);

async function handleCallback(req, res, next) {
  try {
    const endpoint = req.path.replace(/^\//, '');
    const result = await processNHCXCallback({
      tenantId: req.tenantId,
      endpoint,
      body: req.body || {},
      headers: req.headers || {},
      participantCodeSelf: req.nhcxParticipantCodeSelf,
      signatureVerified: req.nhcxSignatureVerified === true,
    });
    return success(res, {
      id: result.envelope?.id,
      duplicate: result.duplicate === true,
      status: result.envelope?.status,
      processed: result.processed === true,
    }, 'NHCX callback accepted', 202);
  } catch (err) {
    if (err.isOperational) return error(res, err.message, err.statusCode);
    logger.error('NHCX callback processing failed', { path: req.path, error: err.message });
    return next(err);
  }
}

callbackRouter.post('/coverageeligibility/on_check', handleCallback);
callbackRouter.post('/preauth/on_submit', handleCallback);
callbackRouter.post('/claim/on_submit', handleCallback);
callbackRouter.post('/claim/on_status', handleCallback);
callbackRouter.post('/communication/request', handleCallback);

export { callbackRouter };
export default callbackRouter;
