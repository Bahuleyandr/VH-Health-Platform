import crypto from 'crypto';

import { verifySignedRequest, __testing__ } from '../../utils/signedRequest.js';

function sign({ secret, timestamp, requestId, payload }) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  return crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${requestId}.${body}`)
    .digest('hex');
}

describe('verifySignedRequest', () => {
  beforeEach(() => {
    __testing__.replayCache.clear();
  });

  it('accepts a valid HMAC request with a seconds timestamp', () => {
    const secret = 'signed-request-secret';
    const timestamp = Math.floor(Date.now() / 1000);
    const requestId = 'req-1';
    const payload = { ok: true };
    const signature = sign({ secret, timestamp, requestId, payload });
    expect(verifySignedRequest({
      secret,
      signature: `sha256=${signature}`,
      timestamp,
      requestId,
      payload,
      context: 'ABDM callback',
      codePrefix: 'ABDM_CALLBACK',
    })).toBe(true);
  });

  it('rejects a missing configured secret', () => {
    expect(() => verifySignedRequest({
      secret: '',
      signature: '00'.repeat(32),
      timestamp: Date.now(),
      requestId: 'req-2',
      payload: {},
    })).toThrow(/secret is not configured/);
  });

  it('rejects stale timestamps', () => {
    const secret = 'signed-request-secret';
    const timestamp = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);
    const requestId = 'req-3';
    const payload = { ok: true };
    expect(() => verifySignedRequest({
      secret,
      signature: sign({ secret, timestamp, requestId, payload }),
      timestamp,
      requestId,
      payload,
    })).toThrow(/out of range/);
  });

  it('rejects replayed request ids with the same timestamp and signature', () => {
    const secret = 'signed-request-secret';
    const timestamp = Math.floor(Date.now() / 1000);
    const requestId = 'req-4';
    const payload = 'MSH|^~\\&|VH';
    const signature = sign({ secret, timestamp, requestId, payload });
    verifySignedRequest({ secret, signature, timestamp, requestId, payload });
    expect(() => verifySignedRequest({ secret, signature, timestamp, requestId, payload }))
      .toThrow(/replay/);
  });

  it('rejects tampered payload signatures', () => {
    const secret = 'signed-request-secret';
    const timestamp = Math.floor(Date.now() / 1000);
    const requestId = 'req-5';
    const signature = sign({ secret, timestamp, requestId, payload: { ok: true } });
    expect(() => verifySignedRequest({
      secret,
      signature,
      timestamp,
      requestId,
      payload: { ok: false },
    })).toThrow(/signature is invalid/);
  });
});
