#!/usr/bin/env node
import http from 'node:http';

import { startMockNHCXExchange } from './nhcx-mock-exchange.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listenCallbackSink() {
  const callbacks = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    callbacks.push({
      path: req.url,
      headers: req.headers,
      body,
      received_at: new Date().toISOString(),
    });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const ready = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, callbacks, origin: `http://${address.address}:${address.port}` });
    });
  });
  return { server, callbacks, ready };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function post(baseUrl, endpoint, body = {}, { outcome = null, workflowId = '77', apiCallId = null } = {}) {
  const response = await fetch(`${baseUrl}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hcx-api_call_id': apiCallId || `smoke-${endpoint.replace(/\W+/g, '-')}`,
      'x-hcx-correlation_id': 'smoke-correlation-1',
      'x-hcx-workflow_id': workflowId,
      sender_code: 'VH-NHCX-PROVIDER',
      recipient_code: 'PAYER-NHCX-MOCK',
      ...(outcome ? { 'x-nhcx-mock-outcome': outcome } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert(response.status === 202, `${endpoint} expected 202, got ${response.status}`);
  assert(payload.status === 'accepted', `${endpoint} response was not accepted`);
  return payload;
}

async function main() {
  const callbackSink = listenCallbackSink();
  const callbackInfo = await callbackSink.ready;
  const { server, ready } = startMockNHCXExchange({
    callbackBaseUrl: `${callbackInfo.origin}/api/v1/integrations/nhcx/`,
    callbackSecret: 'test-callback-secret',
    jweSecret: 'test-jwe-secret-32-byte-minimum',
  });
  const info = await ready;
  try {
    await post(info.baseUrl, 'coverageeligibility/check', { payload: 'a.b.c.d.e' });
    await post(info.baseUrl, 'preauth/submit', { payload: 'f.g.h.i.j' });
    await post(info.baseUrl, 'claim/submit', { payload: 'k.l.m.n.o' }, { outcome: 'approve', workflowId: '101', apiCallId: 'smoke-claim-submit-approve' });
    await post(info.baseUrl, 'claim/submit', { payload: 'p.q.r.s.t' }, { outcome: 'query', workflowId: '102', apiCallId: 'smoke-claim-submit-query' });
    await post(info.baseUrl, 'claim/status', { payload: 'u.v.w.x.y' }, { workflowId: '101' });
    const communicationAck = await post(info.baseUrl, 'communication/request', { payload: 'z.y.x.w.v' }, { workflowId: '102', apiCallId: 'smoke-communication-response' });
    assert(communicationAck.endpoint === 'communication/request', 'communication response was not accepted by mock exchange');
    await waitFor(() => callbackInfo.callbacks.length === 5, 'mock callbacks');
    const logResponse = await fetch(info.adminUrl);
    const log = await logResponse.json();
    assert(log.requests.length === 6, `expected 6 recorded requests, got ${log.requests.length}`);
    for (const request of log.requests) {
      assert(request.payload_hash && request.payload_hash.length === 64, 'payload hash missing');
      assert(request.payload_segments === 5, 'compact JWE segment count not recorded');
      assert(request.correlation_id === 'smoke-correlation-1', 'correlation id not recorded');
    }
    const callbackPaths = callbackInfo.callbacks.map((item) => item.path);
    assert(callbackPaths.includes('/api/v1/integrations/nhcx/claim/on_submit'), 'claim submit callback missing');
    assert(callbackPaths.includes('/api/v1/integrations/nhcx/claim/on_status'), 'claim status callback missing');
    assert(callbackPaths.includes('/api/v1/integrations/nhcx/communication/request'), 'communication request callback missing');
    const communicationRequest = log.requests.find((item) => item.endpoint === 'communication/request');
    assert(communicationRequest?.correlation_id === 'smoke-correlation-1', 'communication response correlation continuity failed');
    for (const callback of callbackInfo.callbacks) {
      assert(callback.headers['x-hcx-correlation_id'] === 'smoke-correlation-1', 'callback correlation continuity failed');
      assert(callback.body?.protected_headers?.['x-hcx-correlation_id'] === 'smoke-correlation-1', 'body correlation continuity failed');
    }
    console.log(JSON.stringify({
      ok: true,
      baseUrl: info.baseUrl,
      recorded: log.requests.length,
      endpoints: log.requests.map((item) => item.endpoint),
      callbacks: callbackPaths,
    }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => callbackInfo.server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
