import { createHash } from 'node:crypto';

import {
  assertOtherMessageParity,
  evaluateOtherExternalResponse,
  parseOtherEnvelope,
} from '../../services/interfaceEngine/protocolAdapters/otherAdapter.js';

const innerPayload = Buffer.from('opaque device payload\u0000v1', 'utf8');
const innerHash = createHash('sha256').update(innerPayload).digest('hex');
const payload = JSON.stringify({
  schema: 'vhhealth.i05.other/v1',
  message_id: 'opaque-message-1',
  media_type: 'application/octet-stream',
  content_encoding: 'base64',
  payload: innerPayload.toString('base64'),
  payload_sha256: innerHash,
});
const envelopeHash = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
const message = Object.freeze({ protocol: 'other', payload_hash: envelopeHash });

function acknowledgement(overrides = {}) {
  return JSON.stringify({
    schema: 'vhhealth.i05.other-ack/v1',
    status: 'accepted',
    message_id: 'opaque-message-1',
    envelope_sha256: envelopeHash,
    payload_sha256: innerHash,
    receipt_id: 'other-receipt-1',
    ...overrides,
  });
}

describe('I05 OTHER envelope adapter', () => {
  test('validates exact envelope bytes and independently hashed decoded payload bytes', () => {
    const parsed = parseOtherEnvelope(payload);
    expect(parsed.envelope).toMatchObject({
      schema: 'vhhealth.i05.other/v1',
      message_id: 'opaque-message-1',
      media_type: 'application/octet-stream',
      payload_sha256: innerHash,
    });
    expect(parsed.decodedPayload.equals(innerPayload)).toBe(true);
    expect(assertOtherMessageParity(message, payload).decodedPayload.equals(innerPayload)).toBe(true);
  });

  test.each([
    { schema: 'unregistered', message_id: 'm', media_type: 'application/octet-stream', content_encoding: 'base64', payload: '', payload_sha256: innerHash },
    { schema: 'vhhealth.i05.other/v1', message_id: 'bad id', media_type: 'application/octet-stream', content_encoding: 'base64', payload: '', payload_sha256: innerHash },
    { schema: 'vhhealth.i05.other/v1', message_id: 'm', media_type: 'invalid', content_encoding: 'base64', payload: '', payload_sha256: innerHash },
    { schema: 'vhhealth.i05.other/v1', message_id: 'm', media_type: 'application/octet-stream', content_encoding: 'base64', payload: '***', payload_sha256: innerHash },
    { schema: 'vhhealth.i05.other/v1', message_id: 'm', media_type: 'application/octet-stream', content_encoding: 'base64', payload: innerPayload.toString('base64'), payload_sha256: '0'.repeat(64) },
  ])('fails closed on malformed or uncorrelated envelope %#', (invalid) => {
    expect(() => parseOtherEnvelope(JSON.stringify(invalid))).toThrow(expect.objectContaining({ code: 'INTEROP_OTHER_INVALID' }));
  });

  test('requires an acknowledgement correlated to message id, envelope hash, and inner payload hash', () => {
    expect(evaluateOtherExternalResponse({
      message,
      rawPayload: payload,
      responseStatus: 200,
      responseBody: acknowledgement(),
    })).toMatchObject({
      accepted: true,
      acknowledgement: {
        status: 'accepted',
        messageId: 'opaque-message-1',
        envelopeSha256: envelopeHash,
        payloadSha256: innerHash,
      },
      envelope: { inner_payload_sha256: innerHash, inner_payload_bytes: innerPayload.length },
    });
    expect(() => assertOtherMessageParity(message, `${payload}\n`)).toThrow(expect.objectContaining({
      code: 'INTEROP_PAYLOAD_PARITY_FAILED',
    }));
    for (const responseBody of [
      acknowledgement({ status: 'rejected' }),
      acknowledgement({ message_id: 'different' }),
      acknowledgement({ envelope_sha256: '0'.repeat(64) }),
      acknowledgement({ payload_sha256: '0'.repeat(64) }),
      acknowledgement({ delivered: true }),
    ]) {
      expect(() => evaluateOtherExternalResponse({
        message,
        rawPayload: payload,
        responseStatus: 202,
        responseBody,
      })).toThrow(expect.objectContaining({ code: 'INTEROP_OTHER_ACK_NOT_ACCEPTED' }));
    }
  });
});
