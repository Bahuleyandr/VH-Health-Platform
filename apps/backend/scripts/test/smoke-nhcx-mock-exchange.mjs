#!/usr/bin/env node
import { startMockNHCXExchange } from './nhcx-mock-exchange.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function post(baseUrl, endpoint, body) {
  const response = await fetch(`${baseUrl}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hcx-api_call_id': `smoke-${endpoint.replace(/\W+/g, '-')}`,
      'x-hcx-correlation_id': 'smoke-correlation-1',
      'x-hcx-workflow_id': '77',
      sender_code: 'VH-NHCX-PROVIDER',
      recipient_code: 'PAYER-NHCX-MOCK',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert(response.status === 202, `${endpoint} expected 202, got ${response.status}`);
  assert(payload.status === 'accepted', `${endpoint} response was not accepted`);
  return payload;
}

async function main() {
  const { server, ready } = startMockNHCXExchange();
  const info = await ready;
  try {
    await post(info.baseUrl, 'coverageeligibility/check', { payload: 'a.b.c.d.e' });
    await post(info.baseUrl, 'preauth/submit', { payload: 'f.g.h.i.j' });
    const logResponse = await fetch(info.adminUrl);
    const log = await logResponse.json();
    assert(log.requests.length === 2, `expected 2 recorded requests, got ${log.requests.length}`);
    for (const request of log.requests) {
      assert(request.payload_hash && request.payload_hash.length === 64, 'payload hash missing');
      assert(request.payload_segments === 5, 'compact JWE segment count not recorded');
      assert(request.correlation_id === 'smoke-correlation-1', 'correlation id not recorded');
    }
    console.log(JSON.stringify({
      ok: true,
      baseUrl: info.baseUrl,
      recorded: log.requests.length,
      endpoints: log.requests.map((item) => item.endpoint),
    }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
