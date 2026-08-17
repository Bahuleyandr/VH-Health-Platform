// src/routes/billing/paymentGatewayWebhookRoutes.js
//
// PUBLIC provider webhook intake, mounted at /webhooks/payments — BEFORE
// validateApiKey / jwtAuth / tenant middleware (next to /pay and the ABDM
// callbacks). Self-authenticated by the provider signature:
//
//   1. The URL's opaque token routes to exactly ONE provider config row.
//      Disabled configs and rotated secrets remain inbound-only and are
//      accepted only for an exactly bound nonterminal order/refund.
//   2. HMAC-SHA256 over the RAW body (captured by app.js's express.json
//      verify hook) vs x-razorpay-signature, timing-safe. Bad signature →
//      401 (the provider keeps retrying — correct: the event was not
//      accepted).
//   3. Replay layering: assertSharedReplayOnce durable claim (fresh-window
//      dedupe across replicas) + the 695 UNIQUE (tenant_id, provider,
//      provider_event_id) as the permanent backstop. A redelivered event
//      whose row is already processed/ignored is 200-acked WITHOUT
//      reprocessing; a row a crash left 'pending' (or 'failed') is resumed —
//      that redelivery-resume is what makes the two-phase refund/capture
//      bookkeeping self-healing.
//   4. Only an explicit handler outcome is terminal. Any thrown error leaves
//      the event row pending and returns 5xx, including operational AppErrors:
//      the route cannot safely infer that a ledger/config/DB error is final.

import { Router } from 'express';
import * as gateway from '../../services/billing/paymentGatewayService.js';
import { resolveAdapter } from '../../services/billing/gatewayProviders/index.js';
import { assertSharedReplayOnce } from '../../utils/signedRequest.js';
import { markRouterDomain } from '../../config/openapiDomain.js';
import { success, error } from '../../utils/responseHelper.js';
import logger from '../../logging/logger.js';

const router = markRouterDomain(Router(), 'payment-gateway');

const SIGNATURE_HEADER = 'x-razorpay-signature';
const EVENT_ID_HEADER = 'x-razorpay-event-id';

// Event-row statuses that mean "fully handled — ack replays without work".
const TERMINAL_EVENT_STATUSES = new Set(['processed', 'ignored']);

router.post('/:webhookToken', async (req, res) => {
  let tenantId = null;
  let eventRow = null;
  try {
    // 1. Fail-closed tenant resolution. Token shape is validated inside the
    //    resolver; unknown and malformed answer identically (no oracle).
    const config = await gateway.resolveWebhookConfigByToken(req.params.webhookToken);
    if (!config) return error(res, 'Not found', 404);
    tenantId = String(config.tenant_id);

    // 2. Signature over the RAW bytes. Absence of the captured raw body means
    //    the app.js verify-hook list is out of sync — fail closed loudly.
    const rawBody = req.paymentGatewayRawBody;
    if (!rawBody || !rawBody.length) {
      logger.error('payment gateway webhook missing raw body capture — check app.js verify hook');
      return error(res, 'Unable to verify webhook signature', 400);
    }
    const secrets = gateway.decryptedWebhookSecrets(config);
    if (!secrets.length) {
      logger.warn('payment gateway webhook rejected: no webhook secret configured');
      return error(res, 'Webhook signature verification unavailable', 401);
    }
    const adapter = resolveAdapter(config.provider);
    const signature = req.get(SIGNATURE_HEADER);
    const matchedCredential = secrets.find(({ secret }) => (
      adapter.verifyWebhookSignature(rawBody, signature, secret)
    ));
    if (!matchedCredential) {
      logger.warn('payment gateway webhook rejected: invalid signature', {
        provider: config.provider,
      });
      return error(res, 'Invalid webhook signature', 401);
    }

    const lateCredential = config.enabled !== true || matchedCredential.current !== true;
    if (lateCredential && !(await gateway.hasBoundNonterminalWebhookIntent({
      config,
      payload: req.body || {},
      credential: matchedCredential,
    }))) {
      logger.warn('payment gateway late webhook rejected: no exact nonterminal intent binding', {
        provider: config.provider,
        disabled_config: config.enabled !== true,
        rotated_credential: matchedCredential.current !== true,
      });
      return error(res, 'Not found', 404);
    }

    const providerEventId = req.get(EVENT_ID_HEADER);
    if (!providerEventId) {
      return error(res, 'Missing provider event id header', 400);
    }
    const payload = req.body || {};
    const eventType = payload.event || 'unknown';

    // 3a. Durable cross-replica replay claim (fresh window). A claimed
    //     replay falls through to the event-table duplicate handling below
    //     rather than 401ing — provider redelivery is legitimate traffic.
    let freshReplay = false;
    try {
      await assertSharedReplayOnce({
        replayNamespace: 'payment-gateway-webhook',
        requestId: `${tenantId}:${config.provider}:${providerEventId}`,
        // The provider's event creation instant keeps the claim key stable
        // across redeliveries of the same event.
        timestamp: payload.created_at || Math.floor(Date.now() / 1000),
        signature,
        context: 'Payment gateway webhook',
        codePrefix: 'PAYMENT_GATEWAY_WEBHOOK',
      });
    } catch (err) {
      if (err?.code === 'PAYMENT_GATEWAY_WEBHOOK_REPLAY') {
        freshReplay = true;
      } else {
        // Replay store unavailable → fail closed (503): we cannot prove
        // non-replay and the provider will redeliver.
        throw err;
      }
    }

    // 3b. Durable intake: INSERT before processing; UNIQUE
    //     (tenant_id, provider, provider_event_id) collapses redeliveries.
    const intake = await gateway.recordWebhookEvent({
      tenantId,
      provider: config.provider,
      environment: config.environment,
      providerEventId,
      eventType,
      payload,
      rawBody,
    });
    eventRow = intake.event;
    if (!eventRow) {
      // Duplicate reported but row unreadable — never process blind.
      return error(res, 'Webhook intake unavailable', 503);
    }
    if ((intake.duplicate || freshReplay) && TERMINAL_EVENT_STATUSES.has(eventRow.status)) {
      return success(res, { received: true, replay: true }, 'Event already processed');
    }

    // 4. Process first delivery or resume a pending/failed row. Handlers turn
    // validated terminal business outcomes into explicit return values
    // (ignored, requires_reconciliation, failed_recorded, ...). A throw is
    // never terminally acknowledged here; provider redelivery is the recovery
    // mechanism for ledger/config/database failures and unexpected AppErrors.
    const outcome = await gateway.processWebhookEvent({
      tenantId,
      config,
      event: eventRow,
      payload,
    });

    const eventStatus = outcome.outcome === 'ignored' ? 'ignored' : 'processed';
    await gateway.markWebhookEvent({
      tenantId,
      eventId: eventRow.id,
      status: eventStatus,
      gatewayOrderId: outcome.orderId ?? null,
      note: outcome.outcome === 'requires_reconciliation'
        ? `requires_reconciliation: ${outcome.reason || ''}`.slice(0, 500)
        : (outcome.reason || null),
    });
    return success(res, { received: true, outcome: outcome.outcome });
  } catch (err) {
    if (err?.code === 'PAYMENT_GATEWAY_WEBHOOK_REPLAY_STORE_UNAVAILABLE') {
      return error(res, 'Replay store unavailable', 503);
    }
    const statusCode = Number.isInteger(err?.statusCode)
      && err.statusCode >= 500 && err.statusCode <= 599
      ? err.statusCode
      : 500;
    logger.error('payment gateway webhook rejected', { code: err?.code, error: err?.message });
    return error(res, 'Webhook processing failed', statusCode);
  }
});

export default router;
