import { createHmac } from 'node:crypto';

import {
  I03_MAX_MESSAGE_BYTES,
  I03_RECOVERY_SCHEMA,
  buildI03RecoverySignedPayload,
  i03DuplicateKey,
  i03SourceToken,
  isWellFormedUnicode,
  lengthPrefixedSha256,
  parseExplicitOffsetTimestamp,
  parseI03Hl7Occurrence,
  prepareHl7InboundRecoveryAuthentication,
  sha256Utf8,
  validateI03ClockEvidence,
} from '../../services/integrations/externalHl7InboundRecoveryService.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const OFFSET_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_OFFSET_ID = '44444444-4444-4444-8444-444444444444';
const CREDENTIAL_ID = '42';
const RECEIVING_FACILITY = 'I03-RECV';
const PREDECESSOR_TOKEN = 'a'.repeat(64);
const GENERATION = 3;
const SOURCE_POSITION = '19';

function hl7Message({
  family = 'adt',
  trigger = family === 'adt' ? 'A01' : 'O01',
  controlId = family === 'adt' ? 'MSG-I03-0001' : 'MSG-I03-ORM-0001',
  occurrence = family === 'adt' ? '20260806103045+0530' : '20260806103145+0530',
  patientUid = PATIENT_UID,
} = {}) {
  const messageType = family === 'adt' ? `ADT^${trigger}` : 'ORM^O01';
  const segments = [
    `MSH|^~\\&|EXT|SRC|VH|${RECEIVING_FACILITY}|${occurrence}||${messageType}|${controlId}|P|2.5|1042`,
  ];
  if (family === 'adt') segments.push(`EVN|${trigger}|${occurrence}`);
  segments.push(`PID|1||${patientUid}`);
  if (family === 'adt') {
    const pv1 = Array(46).fill('');
    pv1[0] = 'PV1';
    pv1[1] = '1';
    pv1[2] = 'I';
    pv1[3] = 'WARD-3';
    pv1[19] = `VISIT-${controlId}`;
    pv1[44] = occurrence;
    segments.push(pv1.join('|'));
  } else {
    const orc = Array(10).fill('');
    orc[0] = 'ORC';
    orc[1] = 'NW';
    orc[2] = `PLACER-${controlId}`;
    orc[9] = occurrence;
    segments.push(orc.join('|'));
    segments.push(`OBR|1|PLACER-${controlId}|FILLER-${controlId}|CBC^Complete Blood Count`);
  }
  return segments.join('\r');
}

function recoveryEnvelope(message, {
  family = 'adt',
  trigger = family === 'adt' ? 'A01' : 'O01',
  controlId = family === 'adt' ? 'MSG-I03-0001' : 'MSG-I03-ORM-0001',
  credentialId = CREDENTIAL_ID,
  tenantId = TENANT_ID,
  offsetId = OFFSET_ID,
  generation = GENERATION,
  sourcePosition = SOURCE_POSITION,
  predecessorToken = PREDECESSOR_TOKEN,
  sourceObservedAt = family === 'adt'
    ? '2026-08-06T10:30:45+05:30'
    : '2026-08-06T10:31:45+05:30',
  sourceReceivedAt = family === 'adt'
    ? '2026-08-06T10:30:45.500+05:30'
    : '2026-08-06T10:31:45.500+05:30',
} = {}) {
  const messageType = family === 'adt' ? 'ADT' : 'ORM';
  const sourcePartition = `i03/credential/${credentialId}/family/${family}`;
  const messageSha256 = sha256Utf8(message);
  const duplicateKey = i03DuplicateKey({
    tenantId,
    signingCredentialId: credentialId,
    messageFamily: family,
    messageType,
    triggerEvent: trigger,
    messageControlId: controlId,
  });
  return {
    schema: I03_RECOVERY_SCHEMA,
    interface_family: 'I03',
    arrival_class: 'recovery_backlog',
    tenant_id: tenantId,
    signing_credential_id: credentialId,
    offset_id: offsetId,
    source_partition: sourcePartition,
    generation,
    source_position: sourcePosition,
    source_token: i03SourceToken({
      tenantId,
      sourcePartition,
      generation,
      sourcePosition,
      predecessorToken,
      duplicateKey,
      messageSha256,
    }),
    predecessor_token: predecessorToken,
    duplicate_key: duplicateKey,
    message_family: family,
    message_type: messageType,
    trigger_event: trigger,
    message_control_id: controlId,
    message_sha256: messageSha256,
    source_observed_at: sourceObservedAt,
    source_received_at: sourceReceivedAt,
    clock_evidence: {
      source_clock_id: 'sender-ntp-1',
      synchronized_at: '2026-08-06T10:29:00+05:30',
      maximum_error_ms: 1000,
    },
  };
}

function preparedFixture(options = {}) {
  const message = hl7Message(options);
  const recovery = recoveryEnvelope(message, options);
  return prepareHl7InboundRecoveryAuthentication({ body: { message, recovery } });
}

function hmac(secret, timestamp, requestId, payload) {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${requestId}.${payload}`)
    .digest('hex');
}

describe('I03 inbound HL7 recovery contract', () => {
  test('pins approved length-prefixed duplicate, source-token, and canonical HMAC vectors', () => {
    const message = [
      'MSH|^~\\&|EXT|SRC|VH|I03-RECV|20260806103045+0530||ADT^A01|MSG-I03-0001|P|2.5|1042',
      'EVN|A01|20260806103045+0530',
      `PID|1||${PATIENT_UID}`,
      'PV1|1|I|WARD-3',
    ].join('\r');
    const recovery = recoveryEnvelope(message);

    expect(lengthPrefixedSha256(['ab', 'c']))
      .not.toBe(lengthPrefixedSha256(['a', 'bc']));
    expect(recovery.message_sha256)
      .toBe('ec0a143c8fa0b38a0bac90c5a241f40e4ca31b78fd12387ff521d26183229333');
    expect(recovery.duplicate_key)
      .toBe('08f84c722368f448f33eee5b00d2c010faefdff0caa2e880ebd68ef9e9b14387');
    expect(recovery.source_token)
      .toBe('e2c2cead1565331cdf740a5fd020dd86a32bce3240b26b9aa856f18316bae985');

    const signed = buildI03RecoverySignedPayload({ message, recovery });
    expect(signed.recoverySha256)
      .toBe('f791c740d5ec37fa5ec43cb78726f6dd1666e483a8adf116ba14f340d2eb4378');
    expect(hmac(
      'known-i03-shared-secret',
      '1770000000',
      'i03-known-vector-1',
      signed.signedPayload,
    )).toBe('2c0de92f42bc3d55dab0aef95242c086bcc56c0961cb6aefc776b3c07d42684f');
  });

  test('rederives the full closed ADT command and preserves clinical occurrence evidence', () => {
    const prepared = preparedFixture();
    expect(prepared).toMatchObject({
      tenantId: TENANT_ID,
      signingCredentialId: CREDENTIAL_ID,
      offsetId: OFFSET_ID,
      sourcePartition: `i03/credential/${CREDENTIAL_ID}/family/adt`,
      generation: GENERATION,
      sourcePosition: SOURCE_POSITION,
      messageFamily: 'adt',
      messageType: 'ADT',
      triggerEvent: 'A01',
      messageControlId: 'MSG-I03-0001',
      sourceObservedAt: '2026-08-06T05:00:45.000Z',
      sourceReceivedAt: '2026-08-06T05:00:45.500Z',
      patientUid: PATIENT_UID,
      visitIdentitySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      orderIdentitySha256: null,
    });
    expect(prepared.command).toEqual({
      message: prepared.message,
      recovery: prepared.recovery,
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.recovery.clock_evidence)).toBe(true);
  });

  test('shares one ADT partition across A01/A02/A03 and keeps ORM independently ordered', () => {
    const adtPartitions = ['A01', 'A02', 'A03'].map((trigger, index) => preparedFixture({
      trigger,
      controlId: `MSG-I03-${trigger}`,
      sourcePosition: String(19 + index),
    }).sourcePartition);
    const orm = preparedFixture({
      family: 'orm',
      trigger: 'O01',
      controlId: 'MSG-I03-ORM-0001',
    });

    expect(new Set(adtPartitions)).toEqual(new Set([
      `i03/credential/${CREDENTIAL_ID}/family/adt`,
    ]));
    expect(orm).toMatchObject({
      sourcePartition: `i03/credential/${CREDENTIAL_ID}/family/orm`,
      messageFamily: 'orm',
      messageType: 'ORM',
      triggerEvent: 'O01',
      visitIdentitySha256: null,
      orderIdentitySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceObservedAt: '2026-08-06T05:01:45.000Z',
    });
  });

  test('canonical HMAC input changes for every recovery field, nested clock field, and message byte', () => {
    const message = hl7Message();
    const recovery = recoveryEnvelope(message);
    const base = buildI03RecoverySignedPayload({ message, recovery });
    const timestamp = '1770000000';
    const requestId = 'i03-mutation-vector';
    const signingFixture = 'i03-mutation-secret';
    const signature = hmac(signingFixture, timestamp, requestId, base.signedPayload);
    const mutations = [
      value => ({ ...value, schema: 'vhhealth.i03.adt-orm-sequence/v2' }),
      value => ({ ...value, interface_family: 'I04' }),
      value => ({ ...value, arrival_class: 'live' }),
      value => ({ ...value, tenant_id: OTHER_TENANT_ID }),
      value => ({ ...value, signing_credential_id: '43' }),
      value => ({ ...value, offset_id: OTHER_OFFSET_ID }),
      value => ({ ...value, source_partition: 'i03/credential/43/family/adt' }),
      value => ({ ...value, generation: 4 }),
      value => ({ ...value, source_position: '20' }),
      value => ({ ...value, source_token: 'b'.repeat(64) }),
      value => ({ ...value, predecessor_token: 'c'.repeat(64) }),
      value => ({ ...value, duplicate_key: 'd'.repeat(64) }),
      value => ({ ...value, message_family: 'orm' }),
      value => ({ ...value, message_type: 'ORM' }),
      value => ({ ...value, trigger_event: 'O01' }),
      value => ({ ...value, message_control_id: 'MSG-I03-MUTATED' }),
      value => ({ ...value, message_sha256: 'e'.repeat(64) }),
      value => ({ ...value, source_observed_at: '2026-08-06T10:30:46+05:30' }),
      value => ({ ...value, source_received_at: '2026-08-06T10:30:46.500+05:30' }),
      value => ({
        ...value,
        clock_evidence: { ...value.clock_evidence, source_clock_id: 'sender-ntp-2' },
      }),
      value => ({
        ...value,
        clock_evidence: {
          ...value.clock_evidence,
          synchronized_at: '2026-08-06T10:28:00+05:30',
        },
      }),
      value => ({
        ...value,
        clock_evidence: { ...value.clock_evidence, maximum_error_ms: 1001 },
      }),
    ];

    for (const mutate of mutations) {
      const changed = buildI03RecoverySignedPayload({ message, recovery: mutate(recovery) });
      expect(hmac(signingFixture, timestamp, requestId, changed.signedPayload)).not.toBe(signature);
    }
    const changedMessage = buildI03RecoverySignedPayload({
      message: `${message}\rNTE|1||one-byte-change`,
      recovery,
    });
    expect(hmac(signingFixture, timestamp, requestId, changedMessage.signedPayload)).not.toBe(signature);
  });

  test('canonicalizes recovery property order without changing the HMAC input', () => {
    const message = hl7Message();
    const recovery = recoveryEnvelope(message);
    const reordered = Object.fromEntries(Object.entries(recovery).reverse());
    expect(buildI03RecoverySignedPayload({ message, recovery: reordered }))
      .toEqual(buildI03RecoverySignedPayload({ message, recovery }));
  });

  test('accepts the exact UTF-8 byte ceiling and rejects one byte above it', () => {
    const base = `${hl7Message()}\rNTE|1||`;
    const exactMessage = `${base}${'x'.repeat(I03_MAX_MESSAGE_BYTES - Buffer.byteLength(base, 'utf8'))}`;
    const exactRecovery = recoveryEnvelope(exactMessage);
    expect(prepareHl7InboundRecoveryAuthentication({
      body: { message: exactMessage, recovery: exactRecovery },
    }).payloadBytes).toBe(I03_MAX_MESSAGE_BYTES);

    const oversizedMessage = `${exactMessage}x`;
    expect(() => prepareHl7InboundRecoveryAuthentication({
      body: {
        message: oversizedMessage,
        recovery: recoveryEnvelope(oversizedMessage),
      },
    })).toThrow('message');
  });

  test('rejects isolated UTF-16 surrogates before their replacement bytes can alias', () => {
    const base = `${hl7Message()}\rNTE|1||`;
    const isolatedHigh = `${base}\uD800`;
    const isolatedLow = `${base}\uDC00`;
    expect(Buffer.from(isolatedHigh, 'utf8')).toEqual(Buffer.from(isolatedLow, 'utf8'));
    expect(sha256Utf8(isolatedHigh)).toBe(sha256Utf8(isolatedLow));
    expect(isWellFormedUnicode(isolatedHigh)).toBe(false);
    expect(isWellFormedUnicode(isolatedLow)).toBe(false);

    for (const message of [isolatedHigh, isolatedLow]) {
      const recovery = recoveryEnvelope(message);
      expect(() => buildI03RecoverySignedPayload({ message, recovery }))
        .toThrow(expect.objectContaining({ code: 'HL7_I03_RECOVERY_MESSAGE_ENCODING_INVALID' }));
      expect(() => prepareHl7InboundRecoveryAuthentication({ body: { message, recovery } }))
        .toThrow(expect.objectContaining({ code: 'HL7_I03_RECOVERY_MESSAGE_ENCODING_INVALID' }));
    }

    const validPair = `${base}\uD83D\uDE00`;
    const recovery = recoveryEnvelope(validPair);
    expect(isWellFormedUnicode(validPair)).toBe(true);
    expect(buildI03RecoverySignedPayload({ message: validPair, recovery }).messageSha256)
      .toBe(sha256Utf8(validPair));
    expect(prepareHl7InboundRecoveryAuthentication({ body: { message: validPair, recovery } }))
      .toMatchObject({ payloadBytes: Buffer.byteLength(validPair, 'utf8') });
  });

  test.each([
    ['top-level unknown field', (message, recovery) => ({ message, recovery, mode: 'recover' })],
    ['recovery unknown field', (message, recovery) => ({
      message,
      recovery: { ...recovery, inferred_head: true },
    })],
    ['clock unknown field', (message, recovery) => ({
      message,
      recovery: {
        ...recovery,
        clock_evidence: { ...recovery.clock_evidence, offset_ms: 2 },
      },
    })],
    ['sender-controlled lease field', (message, recovery) => ({
      message, recovery: { ...recovery, lease_owner: OTHER_OFFSET_ID },
    })],
    ['casing alias', (message, recovery) => ({
      message,
      recovery: Object.fromEntries(Object.entries(recovery).map(([key, value]) => (
        key === 'tenant_id' ? ['tenantId', value] : [key, value]
      ))),
    })],
    ['numeric credential coercion', (message, recovery) => ({
      message, recovery: { ...recovery, signing_credential_id: 42 },
    })],
    ['leading-zero credential', (message, recovery) => ({
      message, recovery: { ...recovery, signing_credential_id: '042' },
    })],
    ['string generation coercion', (message, recovery) => ({
      message, recovery: { ...recovery, generation: '3' },
    })],
    ['numeric position coercion', (message, recovery) => ({
      message, recovery: { ...recovery, source_position: 19 },
    })],
    ['leading-zero position', (message, recovery) => ({
      message, recovery: { ...recovery, source_position: '019' },
    })],
    ['string clock-error coercion', (message, recovery) => ({
      message,
      recovery: {
        ...recovery,
        clock_evidence: { ...recovery.clock_evidence, maximum_error_ms: '1000' },
      },
    })],
    ['uppercase UUID', (message, recovery) => ({
      message, recovery: { ...recovery, tenant_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    })],
    ['uppercase hash', (message, recovery) => ({
      message, recovery: { ...recovery, message_sha256: recovery.message_sha256.toUpperCase() },
    })],
    ['timestamp without offset', (message, recovery) => ({
      message, recovery: { ...recovery, source_received_at: '2026-08-06T10:30:45' },
    })],
  ])('rejects strict closed-envelope violation: %s', (_label, mutate) => {
    const message = hl7Message();
    const recovery = recoveryEnvelope(message);
    expect(() => prepareHl7InboundRecoveryAuthentication({
      body: mutate(message, recovery),
    })).toThrow(expect.objectContaining({ code: 'HL7_I03_RECOVERY_CONTRACT_INVALID' }));
  });

  test('rejects ambiguous identity segments and missing clinical occurrence evidence', () => {
    const message = hl7Message();
    const recovery = recoveryEnvelope(message);
    for (const changed of [
      `${message}\rEVN|A01|20260806103045+0530`,
      `${message}\rPID|1||${PATIENT_UID}`,
      message.replace('EVN|A01|20260806103045+0530\r', ''),
    ]) {
      const changedRecovery = recoveryEnvelope(changed);
      expect(() => prepareHl7InboundRecoveryAuthentication({
        body: { message: changed, recovery: changedRecovery },
      })).toThrow(expect.objectContaining({ code: 'HL7_I03_RECOVERY_CONTRACT_INVALID' }));
    }
  });

  test.each([
    ['duplicate MSH', () => `${hl7Message()}\r${hl7Message().split('\r')[0]}`],
    ['duplicate ORC', () => {
      const message = hl7Message({ family: 'orm' });
      const orc = message.split('\r').find(segment => segment.startsWith('ORC|'));
      return `${message}\r${orc}`;
    }],
    ['ORC in ADT', () => `${hl7Message()}\rORC|NW|FORBIDDEN`],
    ['EVN in ORM', () => `${hl7Message({ family: 'orm' })}\rEVN|O01|20260806103145+0530`],
    ['missing ORC', () => hl7Message({ family: 'orm' })
      .split('\r')
      .filter(segment => !segment.startsWith('ORC|'))
      .join('\r')],
  ])('rejects ambiguous family segment evidence: %s', (_label, buildMessage) => {
    const message = buildMessage();
    const family = message.includes('ORM^O01') ? 'orm' : 'adt';
    expect(() => prepareHl7InboundRecoveryAuthentication({
      body: {
        message,
        recovery: recoveryEnvelope(message, {
          family,
          trigger: family === 'orm' ? 'O01' : 'A01',
          controlId: family === 'orm' ? 'MSG-I03-ORM-0001' : 'MSG-I03-0001',
        }),
      },
    })).toThrow(expect.objectContaining({ code: 'HL7_I03_RECOVERY_CONTRACT_INVALID' }));
  });

  test('enforces exact message/family/control/hash/token/occurrence equality', () => {
    const message = hl7Message();
    const recovery = recoveryEnvelope(message);
    const invalid = [
      { ...recovery, message_family: 'orm' },
      { ...recovery, trigger_event: 'A02' },
      { ...recovery, message_control_id: 'MSG-I03-DIFFERENT' },
      { ...recovery, message_sha256: 'b'.repeat(64) },
      { ...recovery, duplicate_key: 'c'.repeat(64) },
      { ...recovery, source_token: 'd'.repeat(64) },
      { ...recovery, source_observed_at: '2026-08-06T10:30:46+05:30' },
    ];
    for (const changedRecovery of invalid) {
      expect(() => prepareHl7InboundRecoveryAuthentication({
        body: { message, recovery: changedRecovery },
      })).toThrow(expect.objectContaining({ code: 'HL7_I03_RECOVERY_CONTRACT_INVALID' }));
    }
  });

  test('parses explicit-offset timestamps and rejects ambiguous or impossible clocks', () => {
    expect(parseI03Hl7Occurrence('20260806103045.123456+0530'))
      .toBe('2026-08-06T05:00:45.123456Z');
    expect(parseExplicitOffsetTimestamp('2026-08-06T10:30:45.123456+05:30'))
      .toBe('2026-08-06T05:00:45.123456Z');
    expect(() => parseI03Hl7Occurrence('20260806103045')).toThrow();
    expect(() => parseI03Hl7Occurrence('00000806103045+0530')).toThrow();
    expect(() => parseI03Hl7Occurrence('20260806103045-0000')).toThrow();
    expect(() => parseI03Hl7Occurrence('20260230103045+0530')).toThrow();
    expect(() => parseI03Hl7Occurrence('20260806103045.1234567+0530')).toThrow();
    expect(() => parseExplicitOffsetTimestamp('2026-08-06T10:30:45')).toThrow();
    expect(() => parseExplicitOffsetTimestamp('0000-08-06T10:30:45+05:30')).toThrow();
    expect(() => parseExplicitOffsetTimestamp('2026-08-06T10:30:45-00:00')).toThrow();
    expect(() => parseExplicitOffsetTimestamp('2026-08-06T10:30:45.1234567+05:30')).toThrow();
  });

  test('compares clinical occurrence evidence at exact microsecond precision', () => {
    const message = hl7Message({ occurrence: '20260806103045.123456+0530' });
    const matching = recoveryEnvelope(message, {
      sourceObservedAt: '2026-08-06T10:30:45.123456+05:30',
      sourceReceivedAt: '2026-08-06T10:30:45.123999+05:30',
    });
    expect(prepareHl7InboundRecoveryAuthentication({
      body: { message, recovery: matching },
    }).sourceObservedAt).toBe('2026-08-06T05:00:45.123456Z');

    expect(() => prepareHl7InboundRecoveryAuthentication({
      body: {
        message,
        recovery: {
          ...matching,
          source_observed_at: '2026-08-06T10:30:45.123999+05:30',
        },
      },
    })).toThrow('does not match the HL7 source occurrence');
  });

  test('enforces clock synchronization ordering and declared maximum-error rails', () => {
    const base = {
      source_clock_id: 'sender-ntp-1',
      synchronized_at: '2026-08-06T10:29:00+05:30',
      maximum_error_ms: 1000,
    };
    expect(validateI03ClockEvidence(base, {
      sourceObservedAt: '2026-08-06T10:30:45+05:30',
      sourceReceivedAt: '2026-08-06T10:30:45.500+05:30',
    })).toMatchObject({ maximumErrorMs: 1000 });
    expect(() => validateI03ClockEvidence({
      ...base,
      synchronized_at: '2026-08-06T10:31:00+05:30',
    }, {
      sourceObservedAt: '2026-08-06T10:30:45+05:30',
      sourceReceivedAt: '2026-08-06T10:30:45.500+05:30',
    })).toThrow('cannot post-date sender receipt');
    expect(() => validateI03ClockEvidence({ ...base, maximum_error_ms: 499 }, {
      sourceObservedAt: '2026-08-06T10:30:45.500+05:30',
      sourceReceivedAt: '2026-08-06T10:30:45+05:30',
    })).toThrow('precedes the clinical occurrence');
    for (const maximumErrorMs of [-1, 300_001, 1.5, '1000']) {
      expect(() => validateI03ClockEvidence({
        ...base,
        maximum_error_ms: maximumErrorMs,
      }, {
        sourceObservedAt: '2026-08-06T10:30:45+05:30',
        sourceReceivedAt: '2026-08-06T10:30:45.500+05:30',
      })).toThrow('maximum_error_ms');
    }
  });

  test('rejects malformed Unicode in the clock identity before recovery can enqueue', () => {
    const message = hl7Message();
    const recovery = recoveryEnvelope(message);
    const malformedClock = {
      ...recovery,
      clock_evidence: {
        ...recovery.clock_evidence,
        source_clock_id: `sender-clock-\uD800`,
      },
    };

    expect(() => prepareHl7InboundRecoveryAuthentication({
      body: { message, recovery: malformedClock },
    })).toThrow(expect.objectContaining({ code: 'HL7_I03_RECOVERY_CLOCK_ENCODING_INVALID' }));
  });
});
