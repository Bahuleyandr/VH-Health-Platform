import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(),
}));

const {
  parseHl7MsaAcknowledgement,
  sha256Bytes,
} = await import('../../services/hl7/hl7OutboundDeliveryLedgerService.js');

const CONTROL_ID = 'VH-I04-CTRL-1';
const ack = (code, controlId = CONTROL_ID, text = '') => [
  'MSH|^~\\&|DOWNSTREAM|HOSPITAL|VHHEALTH|VH_HOSPITALS|20260802120000||ACK|ACK-1|P|2.5',
  `MSA|${code}|${controlId}|${text}`,
].join('\r');

describe('I04 parsed MSA acknowledgement evidence', () => {
  test.each([
    ['AA', 'aa'],
    ['AE', 'ae'],
    ['AR', 'ar'],
  ])('parses %s and correlates MSA-2 to the original MSH-10', (code, state) => {
    expect(parseHl7MsaAcknowledgement(ack(code), CONTROL_ID)).toMatchObject({
      state,
      msaCode: code,
      acknowledgedControlId: CONTROL_ID,
      correlationMatches: true,
    });
  });

  test('does not accept MSA|AA for a different message control ID', () => {
    expect(parseHl7MsaAcknowledgement(ack('AA', 'OTHER-CONTROL'), CONTROL_ID)).toMatchObject({
      state: 'control_id_mismatch',
      msaCode: 'AA',
      correlationMatches: false,
    });
  });

  test('HTTP-shaped text without one MSA segment is not acknowledgement evidence', () => {
    expect(parseHl7MsaAcknowledgement('OK', CONTROL_ID)).toMatchObject({
      state: 'invalid',
      msaCode: null,
      correlationMatches: false,
    });
    expect(parseHl7MsaAcknowledgement('', CONTROL_ID)).toMatchObject({
      state: 'missing',
      msaCode: null,
      correlationMatches: false,
    });
  });

  test('rejects ambiguous responses containing more than one MSA segment', () => {
    const ambiguous = `${ack('AA')}\rMSA|AR|${CONTROL_ID}|second`;
    expect(parseHl7MsaAcknowledgement(ambiguous, CONTROL_ID)).toMatchObject({
      state: 'invalid',
      msaCode: null,
    });
  });

  test('hashes the exact UTF-8 response bytes', () => {
    const raw = `${ack('AE')}\rERR|Unicode Ω`;
    const parsed = parseHl7MsaAcknowledgement(raw, CONTROL_ID);
    expect(parsed.payloadSha256).toBe(sha256Bytes(raw));
    expect(parsed.payloadSha256).not.toBe(sha256Bytes(`${raw}\r`));
  });

  test('late recovery adapter has no network-send import or invocation', () => {
    const path = fileURLToPath(new URL(
      '../../services/integrations/externalHl7OutboundRecoveryService.js',
      import.meta.url,
    ));
    const source = fs.readFileSync(path, 'utf8');
    expect(source).not.toMatch(/safeFetch|deliverPendingFeedMessages|deliverOne|endpoint_url/);
    expect(source).toMatch(/network_send_performed: false/);
  });

  test('claim selector requires the exact applied C5.1 held-release proof', () => {
    const path = fileURLToPath(new URL(
      '../../services/hl7/hl7OutboundDeliveryLedgerService.js',
      import.meta.url,
    ));
    const source = fs.readFileSync(path, 'utf8');
    expect(source).toMatch(/receipt\.source_kind = 'held_message_release'/);
    expect(source).toMatch(/receipt\.disposition = 'applied'/);
    expect(source).toMatch(/effect\.interface_family = 'I04'/);
    expect(source).toMatch(/effect\.hl7_outbound_message_id = message\.id/);
    expect(source).toMatch(/effect\.network_send_performed = false/);
    expect(source).not.toMatch(/authorizeOwnerRetry/);
  });
});
