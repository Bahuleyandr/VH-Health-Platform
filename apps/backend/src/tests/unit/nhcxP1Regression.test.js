import http from 'node:http';

import { startMockNHCXExchange } from '../../../scripts/test/nhcx-mock-exchange.mjs';
import { verifySignedRequest } from '../../utils/signedRequest.js';
import { decryptNHCXCallbackPayload } from '../../services/nhcx/nhcxInboundCallbackService.js';
import { __testing__ as outboundTesting } from '../../services/nhcx/nhcxOutboundDispatcherService.js';

const JWE_SECRET = 'test-jwe-secret-32-byte-minimum';
const CALLBACK_SECRET = 'test-callback-secret-32-byte-minimum';

function runtime() {
  return {
    credentials: {
      jwePrivateKey: JWE_SECRET,
    },
  };
}

function claimResponseBundle() {
  return {
    resourceType: 'Bundle',
    id: 'roundtrip-claim-response',
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimResponseBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'ClaimResponse',
        id: 'claim-response-roundtrip',
        status: 'active',
        use: 'preauthorization',
        outcome: 'complete',
        disposition: 'Approved by regression test payer',
        request: { reference: 'Claim/preauth-77' },
        total: [{ amount: { value: 12345, currency: 'INR' } }],
      },
    }],
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('NHCX P1 regression seams', () => {
  it('round-trips callback bundles through compact JWE with the tenant mock key', async () => {
    const bundle = claimResponseBundle();
    const encrypted = await outboundTesting.encryptBundleAsJWE({
      bundle,
      protectedHeaders: outboundTesting.hcxHeaders({
        hcxApiCallId: 'api-roundtrip',
        hcxCorrelationId: 'corr-roundtrip',
        hcxWorkflowId: '77',
        participantCodeSelf: 'VH-NHCX-PROVIDER',
        participantCodeCounterparty: 'PAYER-NHCX-MOCK',
      }),
      runtime: runtime(),
    });

    const decrypted = await decryptNHCXCallbackPayload({
      ciphertext: encrypted.ciphertext,
      runtime: runtime(),
    });

    expect(decrypted.bundle).toEqual(bundle);
    expect(decrypted.protectedHeaders).toMatchObject({
      alg: 'dir',
      enc: 'A256GCM',
      'x-hcx-api_call_id': 'api-roundtrip',
    });
  });

  it('mock exchange posts a signed encrypted preauth callback', async () => {
    let captured = null;
    const callbackPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock callback was not posted')), 3000);
      const callbackServer = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        captured = { headers: req.headers, body, server: callbackServer };
        clearTimeout(timer);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        resolve(captured);
      });
      listen(callbackServer).then((origin) => {
        captured = { origin, server: callbackServer };
      }).catch(reject);
    });

    while (!captured?.origin) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const mock = startMockNHCXExchange({
      callbackBaseUrl: `${captured.origin}/api/v1/integrations/nhcx/`,
      callbackSecret: CALLBACK_SECRET,
      jweSecret: JWE_SECRET,
    });
    const info = await mock.ready;
    try {
      const response = await fetch(`${info.baseUrl}/preauth/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hcx-api_call_id': 'regression-api-call',
          'x-hcx-correlation_id': 'regression-correlation',
          'x-hcx-workflow_id': '77',
          sender_code: 'VH-NHCX-PROVIDER',
          recipient_code: 'PAYER-NHCX-MOCK',
        },
        body: JSON.stringify({ payload: 'a.b.c.d.e' }),
      });
      expect(response.status).toBe(202);

      const callback = await callbackPromise;
      verifySignedRequest({
        secret: CALLBACK_SECRET,
        signature: callback.headers['x-nhcx-signature'],
        timestamp: callback.headers['x-hcx-timestamp'],
        requestId: callback.headers['x-hcx-request-id'],
        payload: callback.body,
        context: 'NHCX mock callback regression',
        codePrefix: 'NHCX_MOCK_CALLBACK',
        replayNamespace: `nhcx-mock-regression-${Date.now()}`,
      });

      const decrypted = await decryptNHCXCallbackPayload({
        ciphertext: callback.body.payload,
        runtime: runtime(),
      });
      const claimResponse = decrypted.bundle.entry[0].resource;
      expect(claimResponse).toMatchObject({
        resourceType: 'ClaimResponse',
        use: 'preauthorization',
        outcome: 'complete',
      });
      expect(callback.headers['x-hcx-recipient_code']).toBe('VH-NHCX-PROVIDER');
      expect(callback.headers['x-hcx-sender_code']).toBe('PAYER-NHCX-MOCK');
    } finally {
      await close(mock.server);
      if (captured?.server?.listening) await close(captured.server);
    }
  });
});
