import {
  assertConnectorCanActivate,
  calculateRetryDelayMs,
  classifyHl7Acknowledgement,
  classifyHttpFailure,
  isSourceIpAllowed,
  normalizeAllowedSourceRanges,
  normalizeRetryPolicy,
  normalizeSourceIp,
  retryAtFor,
  stableOutboundIdempotencyKey,
} from '../../services/interfaceEngine/runtimePolicy.js';

describe('interface-engine runtime policy', () => {
  test('only activates implemented connector and protocol pairs', () => {
    expect(() => assertConnectorCanActivate({
      connectorKind: 'http_outbound',
      protocol: 'json',
    })).not.toThrow();
    expect(() => assertConnectorCanActivate({
      connectorKind: 'http_inbound',
      protocol: 'csv',
    })).toThrow(expect.objectContaining({ code: 'INTEROP_CONNECTOR_PROTOCOL_UNSUPPORTED' }));
    expect(() => assertConnectorCanActivate({
      connectorKind: 'mllp_listener',
      protocol: 'hl7v2',
    })).toThrow(expect.objectContaining({ code: 'INTEROP_CONNECTOR_RUNTIME_UNSUPPORTED' }));
  });

  test('does not treat draft-only connector kinds as HTTP ingress runtimes', () => {
    for (const connectorKind of [
      'mllp_listener', 'file_sftp_poll', 'manual_upload', 'internal_backend',
    ]) {
      expect(() => assertConnectorCanActivate({
        connectorKind,
        protocol: 'hl7v2',
      })).toThrow(expect.objectContaining({ code: 'INTEROP_CONNECTOR_RUNTIME_UNSUPPORTED' }));
    }
  });

  test('normalizes retry policy and calculates deterministic bounded jitter', () => {
    const policy = normalizeRetryPolicy({
      backoff: 'exponential',
      initialDelaySeconds: 10,
      maxDelaySeconds: 25,
      jitterRatio: 0.2,
    });
    const first = calculateRetryDelayMs({ retryPolicy: policy, attemptNumber: 3, jitterKey: 'message-1' });
    const second = calculateRetryDelayMs({ retryPolicy: policy, attemptNumber: 3, jitterKey: 'message-1' });
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(20000);
    expect(first).toBeLessThanOrEqual(30000);
    expect(retryAtFor({
      now: new Date('2026-08-13T00:00:00.000Z'),
      retryPolicy: { backoff: 'fixed', initialDelaySeconds: 5, maxDelaySeconds: 5, jitterRatio: 0 },
      attemptNumber: 9,
      jitterKey: 'same',
    }).toISOString()).toBe('2026-08-13T00:00:05.000Z');
    expect(() => normalizeRetryPolicy({ maxDelayMinutes: 'invalid' })).toThrow();
    expect(() => normalizeRetryPolicy({ initialDelaySeconds: 10, maxDelaySeconds: 5 })).toThrow();
  });

  test('enforces IPv4, IPv6 and CIDR source allowlists with empty-list denial', () => {
    expect(normalizeSourceIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(isSourceIpAllowed('10.20.30.4', ['10.20.0.0/16'])).toBe(true);
    expect(isSourceIpAllowed('10.21.30.4', ['10.20.0.0/16'])).toBe(false);
    expect(isSourceIpAllowed('2001:db8:abcd::5', ['2001:db8:abcd::/48'])).toBe(true);
    expect(isSourceIpAllowed('127.0.0.1', [])).toBe(false);
    expect(normalizeAllowedSourceRanges(['127.0.0.1', '127.0.0.1'])).toEqual(['127.0.0.1']);
    expect(() => normalizeAllowedSourceRanges(['not-an-ip'])).toThrow(expect.objectContaining({
      code: 'INTEROP_SOURCE_IP_ALLOWLIST_INVALID',
    }));
  });

  test('classifies only explicit retry signals as safely retryable', () => {
    expect(classifyHttpFailure(429)).toBe('definitive_retryable');
    expect(classifyHttpFailure(400)).toBe('definitive_permanent');
    expect(classifyHttpFailure(500)).toBe('ambiguous');
    expect(classifyHttpFailure(408)).toBe('ambiguous');
    expect(classifyHl7Acknowledgement('aa')).toBe('accepted');
    expect(classifyHl7Acknowledgement('ae')).toBe('definitive_retryable');
    expect(classifyHl7Acknowledgement('ar')).toBe('definitive_permanent');
    expect(classifyHl7Acknowledgement('control_id_mismatch')).toBe('ambiguous');
  });

  test('derives a stable downstream idempotency key from durable identity', () => {
    const args = { tenantId: 'tenant-a', messageId: 42, payloadHash: 'abc' };
    expect(stableOutboundIdempotencyKey(args)).toBe('vh-interop:tenant-a:42:abc');
    expect(stableOutboundIdempotencyKey(args)).toBe(stableOutboundIdempotencyKey(args));
  });
});
