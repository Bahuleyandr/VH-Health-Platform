import crypto from 'crypto';

import {
  SIGNED_REQUEST_SIGNATURE_VERSIONS,
  signSignedRequest,
  verifySignedRequest,
  __testing__,
} from '../../utils/signedRequest.js';

function sign({ secret, timestamp, requestId, payload }) {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload || {}), 'utf8');
  return crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${requestId}.`)
    .update(body)
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

  it('can verify authenticity without consuming the local replay key', () => {
    const secret = 'signed-request-secret';
    const timestamp = Math.floor(Date.now() / 1000);
    const requestId = 'req-verify-only';
    const payload = 'MSH|^~\\&|VH';
    const signature = sign({ secret, timestamp, requestId, payload });

    expect(verifySignedRequest({
      secret,
      signature,
      timestamp,
      requestId,
      payload,
      claimLocalReplay: false,
    })).toBe(true);
    expect(__testing__.replayCache.size).toBe(0);
    expect(verifySignedRequest({ secret, signature, timestamp, requestId, payload })).toBe(true);
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

  it('binds signatures to the exact captured JSON bytes', () => {
    const secret = 'signed-request-secret';
    const timestamp = Math.floor(Date.now() / 1000);
    const requestId = 'req-raw-json';
    const raw = Buffer.from('{"a":1, "b":2}', 'utf8');
    const reserialized = Buffer.from('{"a":1,"b":2}', 'utf8');
    const signature = sign({ secret, timestamp, requestId, payload: raw });
    expect(verifySignedRequest({
      secret, signature, timestamp, requestId, payload: raw, claimLocalReplay: false,
    })).toBe(true);
    expect(() => verifySignedRequest({
      secret, signature, timestamp, requestId, payload: reserialized, claimLocalReplay: false,
    })).toThrow(/signature is invalid/);
  });

  it('binds endpoint-v1 signatures to the exact HTTP method and canonical path', () => {
    const secret = 'signed-request-secret';
    const timestamp = Math.floor(Date.now() / 1000);
    const requestId = 'req-bound-v1';
    const payload = Buffer.from('{"notification":{"consentRequestId":"c-1"}}');
    const canonicalPath = '/api/v1/abdm/consent/on-notify';
    const signature = signSignedRequest({
      secret,
      timestamp,
      requestId,
      payload,
      signatureVersion: SIGNED_REQUEST_SIGNATURE_VERSIONS.ENDPOINT_BOUND_V1,
      method: 'POST',
      canonicalPath,
    });

    expect(verifySignedRequest({
      secret,
      signature,
      timestamp,
      requestId,
      payload,
      signatureVersion: SIGNED_REQUEST_SIGNATURE_VERSIONS.ENDPOINT_BOUND_V1,
      method: 'POST',
      canonicalPath,
      claimLocalReplay: false,
    })).toBe(true);
    expect(() => verifySignedRequest({
      secret,
      signature,
      timestamp,
      requestId,
      payload,
      signatureVersion: SIGNED_REQUEST_SIGNATURE_VERSIONS.ENDPOINT_BOUND_V1,
      method: 'POST',
      canonicalPath: '/api/v1/abdm/health-info/on-request',
      claimLocalReplay: false,
    })).toThrow(/signature is invalid/);
    expect(() => verifySignedRequest({
      secret,
      signature,
      timestamp,
      requestId,
      payload,
      signatureVersion: SIGNED_REQUEST_SIGNATURE_VERSIONS.ENDPOINT_BOUND_V1,
      method: 'PUT',
      canonicalPath,
      claimLocalReplay: false,
    })).toThrow(/signature is invalid/);
    expect(() => verifySignedRequest({
      secret,
      signature,
      timestamp,
      requestId,
      payload: Buffer.from('{"notification": {"consentRequestId":"c-1"}}'),
      signatureVersion: SIGNED_REQUEST_SIGNATURE_VERSIONS.ENDPOINT_BOUND_V1,
      method: 'POST',
      canonicalPath,
      claimLocalReplay: false,
    })).toThrow(/signature is invalid/);
  });

  it('refuses a non-canonical endpoint-v1 path instead of normalizing signed intent', () => {
    expect(() => signSignedRequest({
      secret: 'signed-request-secret',
      timestamp: Date.now(),
      requestId: 'req-query-path',
      payload: Buffer.from('{}'),
      signatureVersion: SIGNED_REQUEST_SIGNATURE_VERSIONS.ENDPOINT_BOUND_V1,
      method: 'POST',
      canonicalPath: '/api/v1/abdm/consent/on-notify?source=proxy',
    })).toThrow(/canonical path is invalid/);
  });
});
