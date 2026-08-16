// src/routes/uhi/uhiRoutes.js
// UHI (Unified Health Interface / DHP-beckn) adapter routes.
//
// Two routers:
//   - callbackRouter: PUBLIC webhook legs (search/init/confirm/status/cancel)
//     called by the UHI gateway / EUAs. Mounted in app.js BEFORE tenant
//     middleware (the ABDM callbackRouter precedent) — every request is
//     self-authenticated: path allowlist, rate limit, env + tenant kill
//     switches, fail-closed tenant resolution from the provider id in the
//     message context, beckn ed25519 signature over the captured raw bytes,
//     and the uhi_transactions UNIQUE-leg dedupe as the durable replay guard.
//   - adminRouter: JWT/admin evidence list for ops debugging.
//
// PRE-RLS POSTURE: every DB touch below the tenant resolution carries the
// resolved tenant explicitly (uhiAdapterService writes tenant_id on every
// row; never a GUC-reading default).

import { Router } from 'express';
import { UHI_CONFIG } from '../../config/uhiConfig.js';
import { markRouterDomain } from '../../config/openapiDomain.js';
import logger from '../../logging/logger.js';
import { genericLimiter } from '../../middleware/rateLimitMiddleware.js';
import {
  resolveInteropCredentialSnapshot,
} from '../../services/interop/tenantInteropSecretService.js';
import { DEFAULT_TENANT_ID } from '../../services/tenant/tenantService.js';
import { getUhiSettings } from '../../services/tenant/tenantSettingsService.js';
import {
  handleUhiCancel,
  handleUhiConfirm,
  handleUhiInit,
  handleUhiSearch,
  handleUhiStatus,
  parseUhiContext,
  recordUhiLeg,
  markUhiLeg,
  listUhiTransactions,
  UHI_ACTIONS,
} from '../../services/uhi/uhiAdapterService.js';
import { verifyBecknSignature } from '../../utils/uhiSignature.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { ADMIN, SUPER_ADMIN } from '../../utils/roles.js';

// Every path here must ALSO be present in the app.js raw-body capture list
// (captureJsonRawBody → req.uhiRawBody) — the beckn signature is computed over
// the exact request bytes.
export const UHI_CALLBACK_PATHS = new Set([
  '/search', '/init', '/confirm', '/status', '/cancel',
]);

function ack() {
  return { message: { ack: { status: 'ACK' } } };
}

function nack(code, message) {
  return { message: { ack: { status: 'NACK' } }, error: { code, message } };
}

const callbackRouter = Router();
markRouterDomain(callbackRouter, 'uhi');
// Throttle the unauthenticated surface before any DB/crypto work (ABDM
// callback posture).
callbackRouter.use(genericLimiter);

/**
 * Middleware: allowlist + kill switches + fail-closed tenant resolution +
 * beckn signature verification. Failed signatures store an evidence row
 * (status 'rejected', signature_verified=false, reason) and NACK; unknown
 * provider ids are rejected with NOTHING stored (no tenant to attribute the
 * evidence to — storing under a guessed tenant would be worse than dropping).
 */
async function validateUhiRequest(req, res, next) {
  if (!UHI_CALLBACK_PATHS.has(req.path)) {
    return next('router');
  }

  // Deployment kill switch: default OFF, zero rows written while disabled.
  if (!UHI_CONFIG.enabled) {
    return error(res, 'UHI integration is not enabled', 404, {
      topLevel: { code: 'UHI_DISABLED' },
    });
  }

  let context;
  try {
    context = parseUhiContext(req.body);
  } catch (err) {
    return relayAppError(res, err, 'UHI callback context invalid');
  }
  const action = req.path.slice(1);
  if (!UHI_ACTIONS.includes(action)) {
    return error(res, 'Unsupported UHI action', 400, { topLevel: { code: 'UHI_ACTION_INVALID' } });
  }

  if (!context.providerId) {
    logger.warn('UHI callback rejected: missing provider id in context');
    return error(res, 'Invalid provider id', 401, { topLevel: { code: 'UHI_PROVIDER_INVALID' } });
  }

  // Fail-closed tenant resolution BEFORE any write (ABDM W3 model): a
  // per-tenant row in tenant_interop_secrets (kind 'uhi_callback', sender =
  // our per-tenant HSP subscriber id) wins; the env-configured subscriber id
  // maps to the DEFAULT tenant with the env gateway public key ONLY when no
  // tenant resolved at all — a resolved tenant whose key row is missing is a
  // misconfiguration that must fail for THAT tenant, never be silently
  // re-attributed to the default tenant. Unknown provider id → 401, nothing
  // stored.
  const credential = await resolveInteropCredentialSnapshot('uhi_callback', context.providerId);
  let tenantId = credential?.tenant_id ?? null;
  let verificationKey = credential?.secret ?? null;
  if (!tenantId && UHI_CONFIG.subscriberId && context.providerId === UHI_CONFIG.subscriberId) {
    tenantId = DEFAULT_TENANT_ID;
    verificationKey = UHI_CONFIG.gatewayPublicKey;
  }
  if (!tenantId || !verificationKey) {
    logger.warn('UHI callback rejected: unrecognized provider id', { received: context.providerId });
    return error(res, 'Invalid provider id', 401, { topLevel: { code: 'UHI_PROVIDER_INVALID' } });
  }

  // Per-tenant opt-in (env is the deployment switch; tenants.settings.uhi the
  // per-hospital one). Disabled tenants get the same disabled marker with
  // zero rows written.
  const settings = await getUhiSettings(tenantId);
  if (settings.enabled !== true) {
    return error(res, 'UHI integration is not enabled for this tenant', 404, {
      topLevel: { code: 'UHI_DISABLED' },
    });
  }

  const environment = settings.environment ?? UHI_CONFIG.environment;

  // The beckn signature is computed over the EXACT request bytes. A missing
  // capture means the app.js captureJsonRawBody path list drifted from
  // UHI_CALLBACK_PATHS — fail loudly (payments-webhook posture) instead of
  // degrading to verifying a re-serialization of req.body.
  if (!req.uhiRawBody || !req.uhiRawBody.length) {
    logger.error('UHI callback missing raw body capture — check the app.js captureJsonRawBody list');
    return error(res, 'Unable to verify message signature', 400, {
      topLevel: { code: 'UHI_RAW_BODY_MISSING' },
    });
  }

  try {
    verifyBecknSignature({
      authorizationHeader: req.headers.authorization,
      rawBody: req.uhiRawBody,
      publicKeyBase64: verificationKey,
      expectedSignerId: context.consumerId,
    });
  } catch (err) {
    // Store the failed-signature message as evidence (705: rejected requires
    // a reason — chk_uhi_txn_rejected_reason), then NACK.
    try {
      await recordUhiLeg({
        tenantId,
        environment,
        transactionId: context.transactionId,
        messageId: context.messageId,
        action,
        direction: 'inbound',
        counterpartySubscriberId: context.consumerId,
        payload: req.body ?? {},
        signatureVerified: false,
        verificationFailureReason: err.code || err.message,
        status: 'rejected',
        ack: 'NACK',
        errorCode: err.code || 'UHI_SIGNATURE_INVALID',
      });
    } catch (recordErr) {
      logger.error('UHI rejected-leg evidence write failed', { message: recordErr.message });
    }
    logger.warn('UHI callback rejected: signature verification failed', { code: err.code });
    return res.status(err.statusCode || 401).json(nack(err.code || 'UHI_SIGNATURE_INVALID', 'Signature verification failed'));
  }

  req.uhiContext = context;
  req.uhiTenantId = tenantId;
  req.uhiEnvironment = environment;
  req.uhiAction = action;
  next();
}

callbackRouter.use(validateUhiRequest);

const LEG_HANDLERS = {
  search: handleUhiSearch,
  init: handleUhiInit,
  confirm: handleUhiConfirm,
  status: handleUhiStatus,
  cancel: handleUhiCancel,
};

// confirm/cancel finalize their own leg (they stamp booking correlation /
// rejection outcomes inside the handler); search/init/status legs are marked
// by the route epilogue.
const SELF_FINALIZING = new Set(['confirm', 'cancel']);

async function handleUhiLeg(req, res) {
  const { uhiContext: context, uhiTenantId: tenantId, uhiEnvironment: environment, uhiAction: action } = req;
  let leg = null;
  try {
    const intake = await recordUhiLeg({
      tenantId,
      environment,
      transactionId: context.transactionId,
      messageId: context.messageId,
      action,
      direction: 'inbound',
      counterpartySubscriberId: context.consumerId,
      payload: req.body ?? {},
      signatureVerified: true,
      status: 'received',
    });
    if (intake.duplicate) {
      // Gateway redelivery of an already-recorded leg: replay-safe ACK, no
      // reprocessing (the uq_uhi_txn_leg unique is the durable replay guard).
      return success(res, ack(), 'UHI message already received', 200);
    }
    leg = intake.row;

    const result = await LEG_HANDLERS[action]({
      tenantId,
      environment,
      context,
      body: req.body ?? {},
      legId: leg.id,
    });
    if (!SELF_FINALIZING.has(action)) {
      await markUhiLeg(tenantId, leg.id, result?.error
        ? { status: 'processed', ack: 'ACK', errorCode: result.error.code, errorMessage: result.error.message }
        : { status: 'processed', ack: 'ACK' });
    }
    return success(res, ack(), 'UHI message accepted', 200);
  } catch (err) {
    if (leg?.id) {
      await markUhiLeg(tenantId, leg.id, {
        status: 'failed',
        ack: 'NACK',
        errorCode: err.code || 'UHI_PROCESSING_FAILED',
        errorMessage: err.message,
      }).catch((markErr) => logger.error('Failed to mark UHI leg failed', { message: markErr.message }));
    }
    if (err.isOperational) {
      logger.warn('UHI callback rejected by handler', { action, code: err.code });
      return res.status(err.statusCode || 400).json(nack(err.code || 'UHI_PROCESSING_FAILED', err.message));
    }
    logger.error('UHI callback processing failed', { action, error: err.message });
    return res.status(500).json(nack('UHI_PROCESSING_FAILED', 'Internal error'));
  }
}

callbackRouter.post('/search', handleUhiLeg);
callbackRouter.post('/init', handleUhiLeg);
callbackRouter.post('/confirm', handleUhiLeg);
callbackRouter.post('/status', handleUhiLeg);
callbackRouter.post('/cancel', handleUhiLeg);

// ====================================
// ADMIN ROUTER — JWT (mounted behind auth in app.js)
// ====================================

const adminRouter = Router();
markRouterDomain(adminRouter, 'uhi');

/**
 * GET /api/v1/admin/uhi/transactions — evidence/dedupe ledger list for ops
 * debugging. Read-only; returns a disabled marker instead of erroring when
 * the adapter is off (ambulance read idiom).
 */
adminRouter.get('/transactions', async (req, res, next) => {
  try {
    if (![ADMIN, SUPER_ADMIN].includes(req.user?.role)) {
      return error(res, 'Only admins can view UHI transactions', 403, {
        topLevel: { code: 'UHI_FORBIDDEN' },
      });
    }
    const tenantId = req.tenantId || req.user?.tenant_id;
    const settings = await getUhiSettings(tenantId);
    if (!UHI_CONFIG.enabled || settings.enabled !== true) {
      return success(res, {
        enabled: false, transactions: [], limit: 0, offset: 0,
      }, 'UHI integration is not enabled');
    }
    const result = await listUhiTransactions(tenantId, {
      status: req.query.status,
      action: req.query.action,
      transactionId: req.query.transaction_id,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return success(res, { enabled: true, ...result }, 'UHI transactions retrieved');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Failed to list UHI transactions');
    logger.error('Failed to list UHI transactions:', { error: err.message });
    return next(err);
  }
});

export { callbackRouter, adminRouter };
