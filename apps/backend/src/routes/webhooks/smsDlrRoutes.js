// src/routes/webhooks/smsDlrRoutes.js
//
// PUBLIC SMS delivery-status (DLR) intake, mounted at /webhooks/sms — BEFORE
// validateApiKey / jwtAuth / tenant middleware (next to /webhooks/payments
// and the ABDM callbacks). Self-authenticated:
//
//   * /dlr/:token (MSG91): MSG91 does not sign callbacks, so the URL bearer
//     token IS the authentication — SHA-256(token) must match a tenant
//     config's callback_token_hash (699). Unknown/malformed → 401, nothing
//     written, never a default tenant (fail-closed on a pre-RLS mount).
//   * /twilio-status/:token (Twilio): DB sends use that config's random token;
//     env sends use a tenant-routing token authenticated by the exact env
//     account/auth pair. Both additionally require X-Twilio-Signature
//     verification with the same credential source used for the send.
//     Twilio signs params, not the body, so no raw-body capture is needed.
//
// Replay + outbox law live in smsDeliveryStatusService: terminal statuses
// only, one receipt per (attempt, source) via the 609 unique, receipts
// written inside setTenantTx, outbox status/cursors NEVER touched from a DLR.
// Unknown references and intermediate statuses are 200-acked without a write
// so providers stop re-delivering evidence we cannot (or must not) record.

import { Router } from 'express';

import { markRouterDomain } from '../../config/openapiDomain.js';
import logger from '../../logging/logger.js';
import {
  processMsg91Dlr,
  processTwilioStatusCallback,
} from '../../services/notification/smsDeliveryStatusService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = markRouterDomain(Router(), 'sms-gateway');

router.post('/dlr/:token', async (req, res) => {
  try {
    const result = await processMsg91Dlr({
      token: req.params.token,
      payload: req.body,
    });
    if (!result.authorized) return error(res, 'Unauthorized', 401);
    return success(res, {
      received: true,
      results: result.results.map(entry => entry.handled),
    });
  } catch (err) {
    logger.error('sms-dlr: msg91 callback processing failed', {
      code: err?.code,
    });
    if (err?.code === 'SMS_DLR_DATA_INVALID' || err?.code === 'SMS_DLR_BATCH_TOO_LARGE') {
      return error(
        res,
        err.code === 'SMS_DLR_BATCH_TOO_LARGE'
          ? 'Delivery status batch is too large'
          : 'Invalid delivery status payload',
        err.statusCode,
      );
    }
    // Honest 500: the delivery was authenticated but not recorded — the
    // provider will re-deliver and the receipt unique keeps that safe.
    return error(res, 'Delivery status processing failed', 500);
  }
});

router.post('/twilio-status/:token', async (req, res) => {
  try {
    const result = await processTwilioStatusCallback({
      token: req.params.token,
      params: req.body || {},
      signature: req.get('x-twilio-signature'),
      requestPath: req.originalUrl,
    });
    if (!result.authorized) return error(res, 'Unauthorized', 401);
    return success(res, {
      received: true,
      results: result.results.map(entry => entry.handled),
    });
  } catch (err) {
    logger.error('sms-dlr: twilio status callback processing failed', {
      code: err?.code,
    });
    return error(res, 'Delivery status processing failed', 500);
  }
});

export default router;
