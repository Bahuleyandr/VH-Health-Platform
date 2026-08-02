import { createHash } from 'node:crypto';

import {
  assertCsvMessageParity,
  evaluateCsvExternalResponse,
  parseCsvPayload,
} from '../../services/interfaceEngine/protocolAdapters/csvAdapter.js';

const payload = '\uFEFFpatient_id,name,notes\r\np-1,"Asha, Rao","line one\nline two"\r\np-2,"Dev ""D""",ok';
const payloadHash = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
const message = Object.freeze({ protocol: 'csv', payload_hash: payloadHash });

describe('I05 CSV protocol adapter', () => {
  test('parses quoted commas, newlines, escaped quotes, and a BOM without changing bytes', () => {
    const parsed = parseCsvPayload(payload);
    expect(parsed).toEqual({
      header: ['patient_id', 'name', 'notes'],
      records: [
        ['p-1', 'Asha, Rao', 'line one\nline two'],
        ['p-2', 'Dev "D"', 'ok'],
      ],
      rowCount: 2,
    });
    expect(assertCsvMessageParity(message, payload)).toEqual(parsed);
  });

  test.each([
    ['patient_id,patient_id\r\np-1,p-2', /unique/i],
    ['patient_id,name\r\np-1', /header width/i],
    ['patient_id,name\r\n"p-1,name', /unterminated/i],
  ])('fails closed on malformed CSV %#', (invalid, expected) => {
    expect(() => parseCsvPayload(invalid)).toThrow(expected);
  });

  test('requires exact payload bytes and an explicit hash-correlated acknowledgement', () => {
    expect(() => assertCsvMessageParity(message, `${payload}\r\n`)).toThrow(expect.objectContaining({
      code: 'INTEROP_PAYLOAD_PARITY_FAILED',
    }));
    expect(evaluateCsvExternalResponse({
      message,
      rawPayload: payload,
      responseStatus: 200,
      responseBody: JSON.stringify({ status: 'accepted', payload_sha256: payloadHash, receipt_id: 'csv-1' }),
    })).toMatchObject({
      accepted: true,
      acknowledgement: { status: 'accepted', payloadSha256: payloadHash, receiptId: 'csv-1' },
      parsed: { rowCount: 2 },
    });
    for (const responseBody of [
      JSON.stringify({ status: 'accepted', payload_sha256: '0'.repeat(64) }),
      JSON.stringify({ status: 'accepted', payload_sha256: payloadHash, delivered: true }),
      'not-json',
    ]) {
      expect(() => evaluateCsvExternalResponse({
        message,
        rawPayload: payload,
        responseStatus: 200,
        responseBody,
      })).toThrow(expect.objectContaining({ code: 'INTEROP_CSV_ACK_NOT_ACCEPTED' }));
    }
  });
});
