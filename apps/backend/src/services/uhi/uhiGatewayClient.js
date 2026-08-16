// src/services/uhi/uhiGatewayClient.js
//
// Thin outbound client for UHI on_* callbacks (modeled on abdmGateway's
// authenticatedRequest, adapted to beckn signing). Every callback POST is
// signed with our ed25519 key (Authorization: Signature ...) over the exact
// serialized body bytes; the destination URL is SSRF-guarded because the
// callback target (context.bap_uri) arrives from the network.
//
// Deliberately fire-and-report: callers record the outbound leg as its own
// uhi_transactions row and decide what a delivery failure means — this client
// never throws for a non-2xx, it returns { ok, status } evidence.

import { UHI_CONFIG } from '../../config/uhiConfig.js';
import logger from '../../logging/logger.js';
import { signBecknRequest } from '../../utils/uhiSignature.js';
import { assertSafeOutboundUrl, safeFetch } from '../../utils/ssrfGuard.js';

const CALLBACK_TIMEOUT_MS = 15_000;

/**
 * POSTs a signed beckn callback (`on_search`, `on_init`, ...) to the
 * counterparty callback URL.
 *
 * @param {object} args
 * @param {string} args.action    Callback action, e.g. 'on_search'.
 * @param {string} args.targetUrl Base callback URI (context.bap_uri or gateway).
 * @param {object} args.body      Full beckn envelope ({ context, message|error }).
 * @returns {Promise<{ok: boolean, status: number|null, error: string|null}>}
 */
export async function sendUhiCallback({ action, targetUrl, body }) {
  const base = String(targetUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    return { ok: false, status: null, error: 'callback URL missing' };
  }
  const url = `${base}/${action}`;
  const rawBody = JSON.stringify(body ?? {});
  let authorization;
  try {
    authorization = signBecknRequest({
      rawBody,
      privateKeyBase64: UHI_CONFIG.signingPrivateKey,
      keyId: UHI_CONFIG.signingKeyId,
    });
  } catch (err) {
    logger.warn('UHI callback signing failed', { action, code: err.code });
    return { ok: false, status: null, error: `signing failed: ${err.code || err.message}` };
  }
  try {
    await assertSafeOutboundUrl(url, {
      label: 'uhiCallbackUrl',
      allowlistEnv: 'UHI_CALLBACK_HOST_ALLOWLIST',
      allowPrivateEnv: 'UHI_CALLBACK_ALLOW_PRIVATE_TARGETS',
    });
    const response = await safeFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: rawBody,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    }, {
      label: 'uhiCallbackUrl',
      allowlistEnv: 'UHI_CALLBACK_HOST_ALLOWLIST',
      allowPrivateEnv: 'UHI_CALLBACK_ALLOW_PRIVATE_TARGETS',
    });
    return {
      ok: response.ok === true,
      status: response.status ?? null,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (err) {
    logger.warn('UHI callback delivery failed', { action, message: err?.message });
    return { ok: false, status: null, error: String(err?.message || 'delivery failed').slice(0, 300) };
  }
}

export default { sendUhiCallback };
