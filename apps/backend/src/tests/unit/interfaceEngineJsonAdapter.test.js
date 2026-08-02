import { createHash } from 'node:crypto';

import {
  assertJsonMessageParity,
  evaluateJsonExternalResponse,
  parseJsonPayload,
} from '../../services/interfaceEngine/protocolAdapters/jsonAdapter.js';

const payload = '{\n  "patient_id": "p-1",\n  "values": [1, 2],\n  "active": true\n}';
const payloadHash = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
const message = Object.freeze({ protocol: 'json', payload_hash: payloadHash });

describe('I05 JSON protocol adapter', () => {
  test('parses a structured document while preserving the original byte identity', () => {
    expect(parseJsonPayload(payload)).toEqual({ patient_id: 'p-1', values: [1, 2], active: true });
    expect(assertJsonMessageParity(message, payload)).toEqual({ patient_id: 'p-1', values: [1, 2], active: true });
  });

  test.each(['', 'not-json', 'null', '42', '"text"'])('fails closed on unsupported JSON input %#', (invalid) => {
    expect(() => parseJsonPayload(invalid)).toThrow(expect.objectContaining({ code: 'INTEROP_JSON_INVALID' }));
  });

  test('requires exact request bytes and an explicit hash-correlated acknowledgement', () => {
    expect(() => assertJsonMessageParity(message, `${payload}\n`)).toThrow(expect.objectContaining({
      code: 'INTEROP_PAYLOAD_PARITY_FAILED',
    }));
    expect(evaluateJsonExternalResponse({
      message,
      rawPayload: payload,
      responseStatus: 202,
      responseBody: JSON.stringify({ status: 'accepted', payload_sha256: payloadHash, receipt_id: 'json-1' }),
    })).toMatchObject({
      accepted: true,
      acknowledgement: { status: 'accepted', payloadSha256: payloadHash, receiptId: 'json-1' },
      document: { root_type: 'object', key_count: 3 },
    });
    for (const responseBody of [
      JSON.stringify({ status: 'accepted', payload_sha256: '0'.repeat(64) }),
      JSON.stringify({ status: 'accepted', payload_sha256: payloadHash, delivered: true }),
      'not-json',
    ]) {
      expect(() => evaluateJsonExternalResponse({
        message,
        rawPayload: payload,
        responseStatus: 200,
        responseBody,
      })).toThrow(expect.objectContaining({ code: 'INTEROP_JSON_ACK_NOT_ACCEPTED' }));
    }
  });
});
