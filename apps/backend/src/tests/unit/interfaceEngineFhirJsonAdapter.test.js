import { createHash } from 'node:crypto';

import {
  assertFhirJsonMessageParity,
  evaluateFhirJsonExternalResponse,
  parseFhirJsonPayload,
} from '../../services/interfaceEngine/protocolAdapters/fhirJsonAdapter.js';

const payload = '{\n  "resourceType": "Patient",\n  "id": "patient-1",\n  "active": true\n}';
const payloadHash = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
const message = Object.freeze({ protocol: 'fhir_json', payload_hash: payloadHash });

function acknowledgement({ hash = payloadHash, status = 'accepted', extra = [] } = {}) {
  return JSON.stringify({
    resourceType: 'Parameters',
    parameter: [
      { name: 'status', valueCode: status },
      { name: 'payload-sha256', valueString: hash },
      { name: 'receipt-id', valueString: 'fhir-receipt-1' },
      ...extra,
    ],
  });
}

describe('I05 FHIR JSON protocol adapter', () => {
  test('parses a FHIR resource and validates nested Bundle resources', () => {
    expect(parseFhirJsonPayload(payload)).toMatchObject({ resourceType: 'Patient', id: 'patient-1' });
    expect(assertFhirJsonMessageParity(message, payload)).toMatchObject({ resourceType: 'Patient' });
    expect(parseFhirJsonPayload(JSON.stringify({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{ resource: { resourceType: 'Observation', id: 'obs-1', status: 'final' } }],
    }))).toMatchObject({ resourceType: 'Bundle', type: 'collection' });
  });

  test.each([
    '{}',
    '{"resourceType":"patient"}',
    '{"resourceType":"Patient","id":"bad/id"}',
    '{"resourceType":"Bundle","type":"collection","entry":[{}]}',
  ])('fails closed on invalid FHIR JSON %#', (invalid) => {
    expect(() => parseFhirJsonPayload(invalid)).toThrow(expect.objectContaining({ code: 'INTEROP_FHIR_JSON_INVALID' }));
  });

  test('requires a parsed FHIR Parameters acknowledgement correlated to exact request bytes', () => {
    expect(evaluateFhirJsonExternalResponse({
      message,
      rawPayload: payload,
      responseStatus: 201,
      responseBody: acknowledgement(),
    })).toMatchObject({
      accepted: true,
      acknowledgement: { status: 'accepted', payloadSha256: payloadHash, receiptId: 'fhir-receipt-1' },
      request: { resource_type: 'Patient', resource_id: 'patient-1' },
    });
    expect(() => assertFhirJsonMessageParity(message, `${payload}\n`)).toThrow(expect.objectContaining({
      code: 'INTEROP_PAYLOAD_PARITY_FAILED',
    }));
    for (const responseBody of [
      acknowledgement({ hash: '0'.repeat(64) }),
      acknowledgement({ status: 'rejected' }),
      acknowledgement({ extra: [{ name: 'unknown', valueString: 'x' }] }),
      JSON.stringify({ resourceType: 'OperationOutcome', issue: [] }),
    ]) {
      expect(() => evaluateFhirJsonExternalResponse({
        message,
        rawPayload: payload,
        responseStatus: 200,
        responseBody,
      })).toThrow(expect.objectContaining({ code: 'INTEROP_FHIR_ACK_NOT_ACCEPTED' }));
    }
  });
});
