import {
  evaluateHl7v2ExternalResponse,
} from '../../services/interfaceEngine/protocolAdapters/hl7v2Adapter.js';
import {
  IMPLEMENTED_I05_PROTOCOLS,
  requireI05ProtocolAdapter,
} from '../../services/interfaceEngine/protocolAdapters/index.js';

const payload = 'MSH|^~\\&|VH|HOSPITAL|REMOTE|HOSPITAL|20260802120000||ADT^A01|CTRL-I05|P|2.5\rPID|1||patient-i05';
const message = Object.freeze({
  protocol: 'hl7v2',
  external_control_id: 'CTRL-I05',
  payload_hash: '9e25bcf45ed0475914c30725a0033de415c129cf10e5151035b019ab832da810',
});

describe('I05 HL7v2 protocol adapter', () => {
  test('keeps registration limited to the landed protocol adapters', () => {
    expect(IMPLEMENTED_I05_PROTOCOLS).toEqual(['hl7v2', 'csv', 'json', 'fhir_json']);
    expect(requireI05ProtocolAdapter('hl7v2').protocol).toBe('hl7v2');
    expect(requireI05ProtocolAdapter('csv').protocol).toBe('csv');
    expect(requireI05ProtocolAdapter('json').protocol).toBe('json');
    expect(requireI05ProtocolAdapter('fhir_json').protocol).toBe('fhir_json');
    expect(() => requireI05ProtocolAdapter('other')).toThrow(expect.objectContaining({
      code: 'INTEROP_PROTOCOL_ADAPTER_UNREGISTERED',
    }));
  });

  test('treats HTTP response content as parsed acknowledgement evidence', () => {
    const rejected = evaluateHl7v2ExternalResponse({
      message,
      rawPayload: payload,
      responseBody: 'MSH|^~\\&|REMOTE|HOSPITAL|VH|HOSPITAL|20260802120100||ACK|ACK-I05|P|2.5\rMSA|AE|CTRL-I05|validation error',
    });
    expect(rejected).toMatchObject({
      accepted: false,
      parsed: { state: 'ae', msaCode: 'AE', correlationMatches: true },
    });

    const accepted = evaluateHl7v2ExternalResponse({
      message,
      rawPayload: payload,
      responseBody: 'MSH|^~\\&|REMOTE|HOSPITAL|VH|HOSPITAL|20260802120100||ACK|ACK-I05|P|2.5\rMSA|AA|CTRL-I05',
    });
    expect(accepted).toMatchObject({
      accepted: true,
      parsed: { state: 'aa', msaCode: 'AA', correlationMatches: true },
    });
  });

  test('refuses payload-byte or MSA-2 correlation drift', () => {
    expect(() => evaluateHl7v2ExternalResponse({
      message,
      rawPayload: `${payload}\rNTE|1|tampered`,
      responseBody: 'MSA|AA|CTRL-I05',
    })).toThrow(expect.objectContaining({ code: 'INTEROP_PAYLOAD_PARITY_FAILED' }));

    const mismatch = evaluateHl7v2ExternalResponse({
      message,
      rawPayload: payload,
      responseBody: 'MSH|^~\\&|REMOTE|HOSPITAL|VH|HOSPITAL|20260802120100||ACK|ACK-I05|P|2.5\rMSA|AA|OTHER-CONTROL',
    });
    expect(mismatch).toMatchObject({
      accepted: false,
      parsed: { state: 'control_id_mismatch', correlationMatches: false },
    });
  });
});
